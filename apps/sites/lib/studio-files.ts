import { unzipSync, Zip, ZipPassThrough, strToU8 } from "fflate";
import { canUseFinalImage, unchangedFinalCrops, wrapStudioText, wrapVerticalColumns, FONTS, type StudioPage, type TextBlock } from "./studio-model";
const verticalGraphemes = new Intl.Segmenter("ko", { granularity: "grapheme" });
const verticalRotateGlyph = /^[…⋯—―ー〜~()[\]{}「」『』【】（）\-–]+$/u;
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
function studioFont(b:TextBlock) {
  return `${b.weight} ${b.size}px ${FONTS[b.font]||FONTS.sans}`;
}
async function loadStudioFont(b:TextBlock) {
  const font=studioFont(b);
  const faces=await document.fonts.load?.(font,b.text);
  if((b.font==="pretendard" && b.text.trim() && !faces?.some(face=>face.status==="loaded" && face.family.replace(/["']/g,"")==="Trio Pretendard")) ||
      (document.fonts.check&&!document.fonts.check(font,b.text)))throw new Error("식자 글꼴을 불러오지 못했어요.");
}
function studioLines(ctx:CanvasRenderingContext2D,b:TextBlock,pageWidth:number,pageHeight?:number) {
  const font=studioFont(b);
  ctx.font=font;
  if(b.writingMode==="vertical-rl"){
    const innerHeight=Math.max(1,b.h/100*(pageHeight??pageWidth)-12-2*(b.strokeWidth??0));
    return {font,lines:wrapVerticalColumns(b.text,innerHeight,b.size*1.06).map(text=>({text,softSpace:""}))};
  }
  const innerWidth=Math.max(1,b.w/100*pageWidth-12-2*(b.strokeWidth??0));
  return {font,lines:wrapStudioText(b.text,innerWidth,s=>ctx.measureText(s).width)};
}

export async function measureStudioLines(ctx:CanvasRenderingContext2D,b:TextBlock,pageWidth:number,pageHeight?:number) {
  await loadStudioFont(b);
  return studioLines(ctx,b,pageWidth,pageHeight);
}

function manualLetteringPlan(ctx:CanvasRenderingContext2D,b:TextBlock,page:Pick<StudioPage,"width"|"height">,wrapped=studioLines(ctx,b,page.width,page.height)) {
  if(![b.x,b.y,b.w,b.h,b.size,b.weight,b.lineHeight].every(Number.isFinite)||b.x<0||b.y<0||b.w<=0||b.h<=0||b.x+b.w>100||b.y+b.h>100||b.size<10||b.lineHeight<=0)throw new Error("식자 위치·글자 크기를 검토해 주세요.");
  const x=b.x/100*page.width,y=b.y/100*page.height,w=b.w/100*page.width,h=b.h/100*page.height;
  const {font,lines}=wrapped;
  const stroke=b.strokeWidth??0;
  if(b.writingMode==="vertical-rl"){
    ctx.textAlign="center";ctx.textBaseline="middle";
    const colStep=b.size*b.lineHeight, charStep=b.size*1.06;
    const totalW=(lines.length-1)*colStep+b.size+2*stroke;
    if(b.text.trim()&&totalW>w+1e-6)return null;
    const firstColX=x+w/2+((lines.length-1)*colStep)/2;
    const draws:Array<{text:string;xx:number;yy:number;rotate?:boolean}>=[];
    for(const [ci,{text:colText}] of lines.entries()){
      const colX=firstColX-ci*colStep;
      const chars=[...verticalGraphemes.segment(colText)].map(s=>s.segment);
      const colH=chars.length?(chars.length-1)*charStep+b.size+2*stroke:0;
      if(chars.length&&colH>h+1e-6)return null;
      const startY=b.align==="left"
        ? y+6+stroke+b.size/2
        : b.align==="right"
          ? y+h-6-stroke-(chars.length-1)*charStep-b.size/2
          : y+(h-(chars.length-1)*charStep)/2;
      for(const [gi,ch] of chars.entries()){
        if(!ch.trim())continue;
        draws.push({text:ch,xx:colX,yy:startY+gi*charStep,rotate:verticalRotateGlyph.test(ch)});
      }
    }
    return {b,x,y,w,h,font,draws,vertical:true as const};
  }
  ctx.textAlign=b.align;ctx.textBaseline="middle";
  const step=b.size*b.lineHeight,xx=b.align==="center"?x+w/2:b.align==="right"?x+w-6-stroke:x+6+stroke,start=y+(h-(lines.length-1)*step)/2;
  let lastBottom=-Infinity;
  const draws:Array<{text:string;xx:number;yy:number;rotate?:boolean}>=[];
  for (const [i,{text:visible,softSpace}] of lines.entries()) {
    const text=visible+softSpace,yy=start+i*step,m=ctx.measureText(text);
    // Hang a soft separator beyond the visible ink. It belongs to the
    // source text but must not move a centered or right-aligned phrase.
    const gap=softSpace ? m.width-ctx.measureText(visible).width : 0;
    const drawX=xx+(b.align==="center"?gap/2:b.align==="right"?gap:0);
    if(![m.actualBoundingBoxLeft,m.actualBoundingBoxRight,m.actualBoundingBoxAscent,m.actualBoundingBoxDescent].every(Number.isFinite))throw new Error("실제 식자 글꼴 측정값을 확인하지 못했어요.");
    const bounds={left:drawX-m.actualBoundingBoxLeft-stroke,right:drawX+m.actualBoundingBoxRight+stroke,top:yy-m.actualBoundingBoxAscent-stroke,bottom:yy+m.actualBoundingBoxDescent+stroke};
    if(text.trim()&&(bounds.left<x-1e-6||bounds.right>x+w+1e-6||bounds.top<y-1e-6||bounds.bottom>y+h+1e-6||bounds.top<lastBottom))return null;
    if(text.trim())lastBottom=bounds.bottom;
    draws.push({text,xx:drawX,yy});
  }
  return {b,x,y,w,h,font,draws,vertical:false as const};
}

export async function measureManualPreview(ctx:CanvasRenderingContext2D,block:TextBlock,page:Pick<StudioPage,"width"|"height">) {
  const wrapped=await measureStudioLines(ctx,block,page.width,page.height);
  return {lines:wrapped.lines,fits:manualLetteringPlan(ctx,block,page,wrapped)!==null};
}

export async function fitStudioBlock(block:TextBlock,page:Pick<StudioPage,"width"|"height">):Promise<number> {
  const ctx=document.createElement("canvas").getContext("2d");
  if(!ctx)throw new Error("식자 Canvas를 사용할 수 없어요.");
  await loadStudioFont(block);
  let size=block.size;
  while (true) {
    if (manualLetteringPlan(ctx,{...block,size},page)) return size;
    if (size<=10) throw new Error("최소 글자 크기에서도 대사가 들어가지 않아요. 영역을 넓히거나 줄바꿈을 조정해 주세요.");
    size=Math.max(10,Math.ceil(size)-1);
  }
}

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
  const crops=unchangedFinalCrops(page);
  const final=crops.size ? await loadImage(page.finalImage!) : undefined;
  if(final && (final.naturalWidth!==page.width || final.naturalHeight!==page.height))throw new Error("보존할 최종 이미지와 식자 좌표계의 크기가 달라요.");
  // User size, position and hard breaks are inputs. Only measure the blocks
  // that actually need a new paint operation.
  const plans=[];
  for(const b of page.blocks){
    if(crops.has(b.id))continue;
    await loadStudioFont(b);
    const plan=manualLetteringPlan(ctx,b,page);
    if(!plan)throw new Error("식자 글자가 영역을 넘거나 글줄과 겹쳐요. 위치·크기·줄바꿈을 조정해 주세요.");
    plans.push(plan);
  }
  ctx.drawImage(img,0,0,canvas.width,canvas.height);
  if(final) for(const {left,top,width,height} of crops.values()){
    ctx.clearRect(left,top,width,height);
    ctx.drawImage(final,left,top,width,height,left,top,width,height);
  }
  for(const stroke of page.coverStrokes??[]){
    if(!stroke.points.length)continue;
    ctx.save();
    ctx.strokeStyle=stroke.color;ctx.fillStyle=stroke.color;
    ctx.lineWidth=stroke.size;ctx.lineCap="round";ctx.lineJoin="round";
    if(stroke.points.length===1){
      const p0=stroke.points[0]!;
      ctx.beginPath();ctx.arc(p0.x/100*canvas.width,p0.y/100*canvas.height,stroke.size/2,0,Math.PI*2);ctx.fill();
    }else{
      ctx.beginPath();
      const p0=stroke.points[0]!;
      ctx.moveTo(p0.x/100*canvas.width,p0.y/100*canvas.height);
      for(let i=1;i<stroke.points.length;i++){const pt=stroke.points[i]!;ctx.lineTo(pt.x/100*canvas.width,pt.y/100*canvas.height);}
      ctx.stroke();
    }
    ctx.restore();
  }
  for(const {b,x,y,w,h,font,draws,vertical} of plans){
    ctx.save();
    if(b.fill){ctx.fillStyle="#ffffff";ctx.fillRect(x,y,w,h);}
    ctx.font=font;ctx.fillStyle=b.color;ctx.textAlign=vertical?"center":b.align;ctx.textBaseline="middle";
    if(b.strokeWidth && b.strokeColor){ctx.lineWidth=2*b.strokeWidth;ctx.lineJoin="round";ctx.strokeStyle=b.strokeColor;}
    for(const {text,xx,yy,rotate} of draws){
      if(rotate){
        ctx.save();ctx.translate(xx,yy);ctx.rotate(Math.PI/2);
        if(b.strokeWidth && b.strokeColor)ctx.strokeText(text,0,0);
        ctx.fillText(text,0,0);
        ctx.restore();
      }else{
        if(b.strokeWidth && b.strokeColor)ctx.strokeText(text,xx,yy);
        ctx.fillText(text,xx,yy);
      }
    }
    ctx.restore();
  }
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error("이미지 생성에 실패했어요.")),"image/png"));
}
export function download(blob:Blob,name:string) {const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function pushZipBlob(entry:ZipPassThrough,blob:Blob) {
  if(typeof blob.stream==="function"){
    const reader=blob.stream().getReader();
    try{
      for(;;){
        const {done,value}=await reader.read();
        if(done)break;
        if(value?.byteLength)entry.push(value,false);
      }
    }finally{reader.releaseLock();}
    entry.push(new Uint8Array(0),true);
    return;
  }
  entry.push(new Uint8Array(await blob.arrayBuffer()),true);
}
export async function downloadPages(pages:StudioPage[],name:string) {
  const chunks:ArrayBuffer[]=[];
  let zipError:unknown;
  let ended=false;
  const archive=new Zip((error,data,final)=>{
    if(error){zipError=error;return;}
    if(data.byteLength){
      const part:ArrayBuffer=data.buffer instanceof ArrayBuffer&&data.byteOffset===0&&data.byteLength===data.buffer.byteLength?data.buffer:data.slice().buffer;
      chunks.push(part);
    }
    if(final)ended=true;
  });
  for(const [index,page] of pages.entries()){
    const leaf=page.name.split(/[\\/]/).pop() ?? "";
    const stem=leaf.replace(/\.[^.]+$/,"").replace(/[<>:"|?*\x00-\x1f\x7f]/g,"_").replace(/[. ]+$/g,"") || "page";
    const number=String(index+1).padStart(3,"0");
    const blob=await renderPage(page);
    const entry=new ZipPassThrough(number+"-"+stem+".png");
    archive.add(entry);
    await pushZipBlob(entry,blob);
    if(zipError)throw zipError;
  }
  const indexEntry=new ZipPassThrough("페이지목록.txt");
  archive.add(indexEntry);
  indexEntry.push(strToU8("Trio 식자 결과\n"+pages.map(p=>`${p.name}: ${p.width} × ${p.height} · 텍스트 ${p.blocks.length}개`).join("\n")),true);
  archive.end();
  if(zipError)throw zipError;
  if(!ended)throw new Error("ZIP 파일을 완성하지 못했어요.");
  download(new Blob(chunks,{type:"application/zip"}),name+"-결과.zip");
}
