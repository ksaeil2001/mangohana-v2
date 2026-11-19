import { unzipSync, zipSync, strToU8 } from "fflate";
import { canUseFinalImage, FONTS, type StudioPage } from "./studio-model";
const LIMIT=8*1024*1024;
export const MAX_PAGES=100;
export async function extractImages(files:File[]):Promise<File[]> {
  const images:File[]=[];
  let count=0, total=0;
  function reserve(size:number) {
    if(++count>MAX_PAGES) throw new Error("한 번에 최대 100페이지를 추가할 수 있어요.");
    total+=size;
    if(total>160*1024*1024) throw new Error("이미지의 총용량은 160MB까지 지원해요.");
  }
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      if(file.size>80*1024*1024) throw new Error("ZIP 파일은 80MB 이하로 올려 주세요.");
      const archive=new Uint8Array(await file.arrayBuffer()), names=new Set<string>();
      // Read the directory without inflating any entry until every requested page fits.
      unzipSync(archive,{filter:entry=>{
        if (!/\.(png|jpe?g|webp)$/i.test(entry.name)) return false;
        const parts=entry.name.split('/');
        if (parts.some(p=>!p||p==='..'||p==='.')||/[\\:\x00-\x1f]/.test(entry.name)) throw new Error("ZIP 안의 이미지 경로를 확인해 주세요.");
        if (parts.some(p=>p==='__MACOSX'||p.startsWith('.'))) return false;
        if(entry.originalSize>LIMIT) throw new Error("압축 안의 이미지 한 장이 8MiB를 넘어요.");
        if(entry.compression===0 && entry.size!==entry.originalSize) throw new Error("ZIP 안의 이미지 용량을 확인해 주세요.");
        if(names.has(entry.name)) throw new Error("ZIP 안에 같은 경로의 이미지가 두 개 있어요.");
        names.add(entry.name);
        reserve(entry.originalSize);
        return false;
      }});
      const data=unzipSync(archive,{filter:entry=>names.has(entry.name)});
      for (const [name,bytes] of Object.entries(data).sort(([a],[b])=>a.localeCompare(b,"ko",{numeric:true}))) {
        const ext=name.split(".").pop()!.toLowerCase();
        images.push(new File([new Uint8Array(bytes).buffer],name.split("/").pop()!,{type:ext==="jpg"||ext==="jpeg"?"image/jpeg":`image/${ext}`}));
      }
    } else if (/\.(png|jpe?g|webp)$/i.test(file.name)) {
      if(file.size>LIMIT) throw new Error("이미지는 한 장당 8MiB까지 지원해요.");
      reserve(file.size);images.push(file);
    }
  }
  if(!images.length) throw new Error("JPG, PNG, WebP 이미지 또는 이미지가 담긴 ZIP을 올려 주세요.");
  return images;
}
export function fileDataURL(file:Blob):Promise<string> {return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result as string);r.onerror=()=>reject(new Error("파일을 읽지 못했어요."));r.readAsDataURL(file);});}
export function loadImage(src:string):Promise<HTMLImageElement> {return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error("이미지를 열지 못했어요. 원본 파일을 확인해 주세요."));img.src=src;});}
export async function fileToPage(file:File):Promise<StudioPage> {
  const image=await fileDataURL(file);const img=await loadImage(image);
  if(img.naturalWidth*img.naturalHeight>40_000_000) throw new Error("이미지 한 장은 4천만 화소 이하로 올려 주세요.");
  return {id:crypto.randomUUID(),name:file.name,image,width:img.naturalWidth,height:img.naturalHeight,blocks:[],status:"ready",reviewed:false};
}
function wrap(ctx:CanvasRenderingContext2D,text:string,max:number) {const lines:string[]=[];for(const paragraph of text.replace(/\r\n?/g,"\n").split("\n")){let line="";for(const {segment:char} of new Intl.Segmenter("ko",{granularity:"grapheme"}).segment(paragraph)){if(line && ctx.measureText(line+char).width>max){lines.push(line);line="";}line+=char;}lines.push(line);}return lines;}
export async function renderPage(page:StudioPage):Promise<Blob> {
  if(![page.width,page.height].every(v=>Number.isSafeInteger(v)&&v>0)||page.width*page.height>40_000_000)throw new Error("이미지가 내보내기 크기 한도를 초과해요.");
  if(canUseFinalImage(page)){
    const response=await fetch(page.finalImage);
    if(!response.ok)throw new Error("최종 이미지를 읽지 못했어요.");
    return response.blob();
  }
  await document.fonts.ready;
  const canvas=document.createElement("canvas");canvas.width=page.width;canvas.height=page.height;
  const ctx=canvas.getContext("2d");if(!ctx)throw new Error("식자 Canvas를 사용할 수 없어요.");
  const img=await loadImage(page.cleanImage||page.image);
  if(typeof img.naturalWidth==="number"&&(img.naturalWidth!==page.width||img.naturalHeight!==page.height))throw new Error("배경 이미지 해상도와 식자 좌표계의 크기가 달라요.");
  // Validate every block before painting/serializing. User size, position and
  // hard breaks are inputs, never silently shrunk or hidden behind a clip.
  const plans=[];
  for(const b of page.blocks){
    if(![b.x,b.y,b.w,b.h,b.size,b.weight,b.lineHeight].every(Number.isFinite)||b.x<0||b.y<0||b.w<=0||b.h<=0||b.x+b.w>100||b.y+b.h>100||b.size<10||b.lineHeight<=0)throw new Error("식자 위치·글자 크기를 검토해 주세요.");
    const x=b.x/100*page.width,y=b.y/100*page.height,w=b.w/100*page.width,h=b.h/100*page.height,font=`${b.weight} ${b.size}px ${FONTS[b.font]||FONTS.sans}`;
    await document.fonts.load?.(font,b.text);if(document.fonts.check&&!document.fonts.check(font,b.text))throw new Error("식자 글꼴을 불러오지 못했어요.");
    ctx.font=font;ctx.textAlign=b.align;ctx.textBaseline="middle";
    const lines=wrap(ctx,b.text,Math.max(1,w-12)),step=b.size*b.lineHeight,xx=b.align==="center"?x+w/2:b.align==="right"?x+w-6:x+6,start=y+(h-(lines.length-1)*step)/2;
    let lastBottom=-Infinity;
    const draws=lines.map((text,i)=>{
      const yy=start+i*step,m=ctx.measureText(text);
      if(![m.actualBoundingBoxLeft,m.actualBoundingBoxRight,m.actualBoundingBoxAscent,m.actualBoundingBoxDescent].every(Number.isFinite))throw new Error("실제 식자 글꼴 측정값을 확인하지 못했어요.");
      const bounds={left:xx-m.actualBoundingBoxLeft,right:xx+m.actualBoundingBoxRight,top:yy-m.actualBoundingBoxAscent,bottom:yy+m.actualBoundingBoxDescent};
      if(text.trim()&&(bounds.left<x-1e-6||bounds.right>x+w+1e-6||bounds.top<y-1e-6||bounds.bottom>y+h+1e-6||bounds.top<lastBottom))throw new Error("식자 글자가 영역을 넘거나 글줄과 겹쳐요. 위치·크기·줄바꿈을 조정해 주세요.");
      if(text.trim())lastBottom=bounds.bottom;
      return {text,xx,yy,bounds};
    });
    plans.push({b,x,y,w,h,font,draws});
  }
  ctx.drawImage(img,0,0,canvas.width,canvas.height);
  for(const {b,x,y,w,h,font,draws} of plans){ctx.save();if(b.fill){ctx.fillStyle="#ffffff";ctx.fillRect(x,y,w,h);}ctx.font=font;ctx.fillStyle=b.color;ctx.textAlign=b.align;ctx.textBaseline="middle";for(const {text,xx,yy}of draws)ctx.fillText(text,xx,yy);ctx.restore();}
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error("이미지 생성에 실패했어요.")),"image/png"));
}
export function download(blob:Blob,name:string) {const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
export async function downloadPages(pages:StudioPage[],name:string) {
  const files:Record<string,Uint8Array>={};
  for(const [index,page] of pages.entries()){
    const leaf=page.name.split(/[\\/]/).pop() ?? "";
    const stem=leaf.replace(/\.[^.]+$/,"").replace(/[<>:"|?*\x00-\x1f\x7f]/g,"_").replace(/[. ]+$/g,"") || "page";
    const number=String(index+1).padStart(3,"0");
    const blob=await renderPage(page);
    files[number+"-"+stem+".png"]=new Uint8Array(await blob.arrayBuffer());
  }
  files["페이지목록.txt"]=strToU8("Trio 식자 결과\n"+pages.map(p=>`${p.name}: ${p.width} × ${p.height} · 텍스트 ${p.blocks.length}개`).join("\n"));
  download(new Blob([new Uint8Array(zipSync(files,{level:0})).buffer],{type:"application/zip"}),name+"-결과.zip");
}
