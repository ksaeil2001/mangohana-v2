'use strict';
const {requiresSingleUtteranceLine}=require('./korean-utterance.cjs');
const {isGeneralKorean,inspectKoreanText}=require('./korean-typesetting-standard.cjs');
// Pure pixel/geometry checks. No filesystem, encoder, model or process access.
const POLICY='background-layout-v1',UNIFORM_DELTA=8,EDGE_DELTA=12,EDGE_MARGIN=2,MIN_CONTRAST=4.5;
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=code=>{throw Object.assign(Error(code),{code});};
const validBox=b=>b&&['x','y','width','height'].every(k=>Number.isFinite(b[k]))&&b.x>=0&&b.y>=0&&b.width>0&&b.height>0&&b.x+b.width<=1+1e-12&&b.y+b.height<=1+1e-12;
const inside=(a,b)=>a.x>=b.x-1e-12&&a.y>=b.y-1e-12&&a.x+a.width<=b.x+b.width+1e-12&&a.y+a.height<=b.y+b.height+1e-12;
const overlaps=(a,b)=>Math.min(a.x+a.width,b.x+b.width)>Math.max(a.x,b.x)&&Math.min(a.y+a.height,b.y+b.height)>Math.max(a.y,b.y);
const bounds=(b,w,h)=>{const left=Math.floor(b.x*w),top=Math.floor(b.y*h);return {left,top,width:Math.ceil((b.x+b.width)*w)-left,height:Math.ceil((b.y+b.height)*h)-top};};
const delta=(a,ai,b,bi)=>Math.max(...[0,1,2].map(k=>Math.abs(a[ai+k]-b[bi+k])));
const luminance=c=>{const v=c.map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return .2126*v[0]+.7152*v[1]+.0722*v[2];};
const contrast=(color,rgb)=>{const a=luminance(color),b=luminance(rgb);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
function stats(){return {count:0,min:[255,255,255],max:[0,0,0],sum:[0,0,0]};}
function add(s,b,at){s.count++;for(let k=0;k<3;k++){s.min[k]=Math.min(s.min[k],b[at+k]);s.max[k]=Math.max(s.max[k],b[at+k]);s.sum[k]+=b[at+k];}}
function summary(s){return {count:s.count,mean:s.sum.map(v=>s.count?Math.round(v/s.count):null),range:s.max.map((v,k)=>s.count?v-s.min[k]:null)};}
function footprintFits(interior,rectangles){
 if(!interior||!Array.isArray(rectangles)||!rectangles.length)return false;
 const {mask,left,top,width,height}=interior;
 if(!mask||mask.length!==width*height)return false;
 return rectangles.every(r=>{
  if(!r||!['left','right','top','bottom'].every(k=>Number.isFinite(r[k]))||r.right<=r.left||r.bottom<=r.top)return false;
  const x0=Math.floor(r.left)-left,y0=Math.floor(r.top)-top,x1=Math.ceil(r.right)-left,y1=Math.ceil(r.bottom)-top;
  if(x0<0||y0<0||x1>width||y1>height)return false;
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)if(!mask[y*width+x])return false;
  return true;
 });
}
function layoutTextMatches(source,text){
 if(typeof source!=='string'||typeof text!=='string'||!text.trim()||text.length>4000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))return false;
 const paragraphs=source.replace(/\r\n?/g,'\n').split('\n'),lines=text.replace(/\r\n?/g,'\n').split('\n');let p=0,offset=0;
 for(const line of lines){const expected=paragraphs[p];if(expected===undefined)return false;if(offset)while(/[ \t]/.test(expected[offset]??'\0'))offset++;if(!expected.startsWith(line,offset))return false;offset+=line.length;if(!expected.slice(offset).trim()){p++;offset=0;}}
 return p===paragraphs.length&&offset===0&&source.replace(/\s/gu,'')===text.replace(/\s/gu,'');
}
function normalizeManualEntries(entries,regions,width,height){
 if(!Array.isArray(entries)||!entries.length||entries.length>128||new Set(entries.map(e=>e?.id)).size!==entries.length)fail('LAYOUT_INPUT_INVALID');
 return entries.map(e=>{
  if(!e||Object.keys(e).length!==5||Object.keys(e).some(k=>!['id','bbox','fontSizePx','lineHeight','text'].includes(k)))fail('LAYOUT_INPUT_INVALID');
  const region=regions.find(r=>r.id===e.id);if(!region)fail('LAYOUT_REGION_MISMATCH');
  if(!validBox(e.bbox)||Object.keys(e.bbox).length!==4||!inside(e.bbox,region.allowedBbox??region.bbox)||regions.some(r=>r.id!==e.id&&overlaps(e.bbox,r.bbox))||entries.some(r=>r.id!==e.id&&validBox(r.bbox)&&overlaps(e.bbox,r.bbox)))fail('LAYOUT_GEOMETRY_UNSAFE');
  if(e.bbox.width*width<10||e.bbox.height*height<10)fail('LAYOUT_GEOMETRY_UNSAFE');
  if(!Number.isInteger(e.fontSizePx)||e.fontSizePx<=12||e.fontSizePx>256||!Number.isFinite(e.lineHeight)||e.lineHeight<1.25||e.lineHeight>3)fail('LAYOUT_FONT_SIZE_UNSAFE');
  if(!layoutTextMatches(region.text,e.text))fail('LAYOUT_TEXT_CHANGED');
  if(requiresSingleUtteranceLine(region.text)&&e.text!==region.text)fail('LAYOUT_SINGLE_LINE_REQUIRED');
  if(isGeneralKorean({text:region.text})){const check=inspectKoreanText(region.text,e.text.replace(/\r\n?/g,'\n').split('\n'));if(check.intraWordBreaks!==0||check.punctuationOnlyLines.length||check.leadingDetachedPunctuation.length)fail('LAYOUT_EOJEOL_SPLIT');}
  return {id:e.id,bbox:{...e.bbox},fontSizePx:e.fontSizePx,lineHeight:e.lineHeight,text:e.text.replace(/\r\n?/g,'\n')};
 });
}
function createBackgroundScene({sourcePixels:source,cleanedPixels:cleaned,maskPixels:mask,width,height,sourceSha256,cleanedSha256,maskSha256}){
 const length=width*height*4,array=b=>ArrayBuffer.isView(b)&&b.BYTES_PER_ELEMENT===1&&b.length===length;
 if(![width,height].every(v=>Number.isSafeInteger(v)&&v>0)||width*height>12_000_000||!array(source)||!array(mask)||cleaned!==undefined&&!array(cleaned)||!hex(sourceSha256)||!hex(maskSha256)||cleaned!==undefined&&!hex(cleanedSha256))fail('BACKGROUND_FRAME_INVALID');
 for(let at=0;at<length;at+=4){const alpha=mask[at+3];if(![0,255].includes(alpha)||alpha===255&&[0,1,2].some(k=>mask[at+k]!==255))fail('BACKGROUND_MASK_INVALID');
  if(cleaned){if(source[at+3]!==cleaned[at+3])fail('BACKGROUND_ALPHA_CHANGED');if(alpha===255&&[0,1,2].some(k=>source[at+k]!==cleaned[at+k]))fail('BACKGROUND_PROTECTED_PIXEL_CHANGED');}}
 function inspect(options,manual){
  const {id,bbox,allowedBbox=bbox,otherBoxes=[],approvalSha256}=options,hasCleaned=!!cleaned;
  const evidence={version:1,policy:POLICY,id,basis:null,sourceSha256,cleanedSha256:hasCleaned?cleanedSha256:null,maskSha256,bbox:{...bbox},cleanedVerified:hasCleaned,minimumContrast:null,protectedEdgePixels:0,approvalSha256:manual?(approvalSha256??null):null,humanImageQualityVerified:false};
  const reject=(...reasonCodes)=>({status:'MANUAL_LAYOUT_REQUIRED',sourceReviewable:false,reasonCodes,evidence});
  if(!validBox(bbox)||!validBox(allowedBbox)||!inside(bbox,allowedBbox)||otherBoxes.some(r=>r.id!==id&&(!validBox(r.bbox)||overlaps(bbox,r.bbox))))return reject('ROI_OR_OTHER_REGION_CONFLICT');
  const box=bounds(bbox,width,height),margin=Math.max(2,Math.ceil(Math.min(box.width,box.height)*.04));evidence.marginPx=margin;
  if(box.width<10||box.height<10||box.left<margin||box.top<margin||box.left+box.width+margin>width||box.top+box.height+margin>height)return reject('BACKGROUND_MARGIN_UNAVAILABLE');
  const known=stats(),restored=stats(),knownInside=stats(),knownMargin=stats(),cleanedInside=stats(),cleanedMargin=stats();let transparent=false;
  for(let y=box.top-margin;y<box.top+box.height+margin;y++)for(let x=box.left-margin;x<box.left+box.width+margin;x++){
   const at=(y*width+x)*4,inBox=x>=box.left&&x<box.left+box.width&&y>=box.top&&y<box.top+box.height;
   if(mask[at+3]===255){add(known,source,at);add(inBox?knownInside:knownMargin,source,at);if(source[at+3]<250)transparent=true;}if(cleaned){add(restored,cleaned,at);add(inBox?cleanedInside:cleanedMargin,cleaned,at);if(cleaned[at+3]<250)transparent=true;}}
  const originalStats=summary(known),cleanedStats=summary(restored);evidence.knownSourcePixels=known.count;evidence.sourceBackground=originalStats;evidence.cleanedBackground=hasCleaned?cleanedStats:null;
  evidence.sampling={bboxPixels:box,marginPx:margin,policy:'BBOX_AND_MARGIN_BOTH_REQUIRED',inside:summary(knownInside),margin:summary(knownMargin),cleanedInside:hasCleaned?summary(cleanedInside):null,cleanedMargin:hasCleaned?summary(cleanedMargin):null};
  if(transparent||known.count<Math.max(32,Math.ceil(box.width*box.height*.2)))return reject('BACKGROUND_SOURCE_EVIDENCE_INSUFFICIENT');
  const uniformOriginal=originalStats.range.every(v=>v<=UNIFORM_DELTA),uniformCleaned=!hasCleaned||cleanedStats.range.every(v=>v<=UNIFORM_DELTA)&&cleanedStats.mean.every((v,k)=>Math.abs(v-originalStats.mean[k])<=UNIFORM_DELTA);
  if(!manual&&(!uniformOriginal||!uniformCleaned))return reject('BACKGROUND_NOT_UNIFORM');
  if(manual&&hasCleaned&&!hex(approvalSha256))return reject('MANUAL_LAYOUT_APPROVAL_REQUIRED');
  const edges=new Uint8Array(box.width*box.height),protectedAt=(x,y)=>{
   const at=(y*width+x)*4;
   for(const [dx,dy]of [[1,0],[-1,0],[0,1],[0,-1]]){const next=((y+dy)*width+x+dx)*4;
    if(x+dx<0||y+dy<0||x+dx>=width||y+dy>=height)continue;
    if(mask[at+3]===255&&mask[next+3]===255&&delta(source,at,source,next)>EDGE_DELTA||cleaned&&delta(cleaned,at,cleaned,next)>EDGE_DELTA)return true;}
   return false;
  };
  if(manual)for(let y=box.top-EDGE_MARGIN;y<box.top+box.height+EDGE_MARGIN;y++)for(let x=box.left-EDGE_MARGIN;x<box.left+box.width+EDGE_MARGIN;x++)if(protectedAt(x,y)){
   for(let dy=-EDGE_MARGIN;dy<=EDGE_MARGIN;dy++)for(let dx=-EDGE_MARGIN;dx<=EDGE_MARGIN;dx++){const xx=x+dx-box.left,yy=y+dy-box.top;if(xx>=0&&yy>=0&&xx<box.width&&yy<box.height)edges[yy*box.width+xx]=1;}}
  const candidates=[[0,0,0],[255,255,255]].map(color=>{
   const safe=new Uint8Array(edges.length);let count=0,minContrast=Infinity,edgeCount=0;
   for(let y=0;y<box.height;y++)for(let x=0;x<box.width;x++){const i=y*box.width+x,at=((box.top+y)*width+box.left+x)*4;
    if(edges[i]){edgeCount++;continue;}const rgb=cleaned?[...cleaned.subarray(at,at+3)]:mask[at+3]===255?[...source.subarray(at,at+3)]:originalStats.mean;
    const c=contrast(color,rgb);if(c+1e-10<MIN_CONTRAST)continue;safe[i]=1;count++;minContrast=Math.min(minContrast,c);}
   return {color,safe,count,minContrast,edgeCount};
  }).sort((a,b)=>b.count-a.count||b.minContrast-a.minContrast);
  const best=candidates[0];evidence.protectedEdgePixels=best.edgeCount;evidence.safePixels=best.count;evidence.minimumContrast=Number.isFinite(best.minContrast)?Math.round(best.minContrast*10000)/10000:null;
  if(best.count<(manual?Math.max(64,Math.ceil(edges.length*.1)):edges.length))return reject('BACKGROUND_CONTRAST_OR_PROTECTION_BLOCKED');
  const color=best.color[0]===0?'#000000':'#ffffff',interior={mask:best.safe,left:box.left,top:box.top,width:box.width,height:box.height};evidence.color=color;
  if(!hasCleaned)return {status:'CLEANED_PENDING',sourceReviewable:true,reasonCodes:['CLEANED_PIXELS_NOT_AVAILABLE'],evidence,previewInterior:interior,paint:{color,strokeColor:color==='#000000'?'#ffffff':'#000000'}};
  evidence.basis=manual?'USER_REVIEWED_PROTECTED_ROI_RECTANGLE':'UNIFORM_BACKGROUND_INSET_RECTANGLE';
  return {status:'SAFE_PIXELS_VERIFIED',sourceReviewable:true,reasonCodes:[],evidence,interior,paint:{color,strokeColor:color==='#000000'?'#ffffff':'#000000'}};
 }
 // A permissive logical upper bound; no restored pixels are manufactured.
 let possible,labels,queue,nextLabel=0;const components=new Map();
 function whiteUpperBound({bbox}){
  if(!validBox(bbox))fail('BACKGROUND_GEOMETRY_INVALID');
  if(!possible){possible=new Uint8Array(width*height);labels=new Int32Array(possible.length);queue=new Int32Array(possible.length);for(let i=0;i<possible.length;i++)possible[i]=mask[i*4+3]===0||source[i*4+3]>=250&&Math.min(source[i*4],source[i*4+1],source[i*4+2])>=240?1:0;}
  const ax=Math.min(width-1,Math.floor((bbox.x+bbox.width/2)*width)),ay=Math.min(height-1,Math.floor((bbox.y+bbox.height/2)*height)),start=ay*width+ax;let id=labels[start],maximum=0;
  if(possible[start]){if(!id){id=++nextLabel;let head=0,tail=1,minX=width,minY=height,maxX=-1,maxY=-1;queue[0]=start;labels[start]=id;
    while(head<tail){const at=queue[head++],x=at%width,y=Math.floor(at/width);minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);for(const n of [x?at-1:-1,x+1<width?at+1:-1,y?at-width:-1,y+1<height?at+width:-1])if(n>=0&&!labels[n]&&possible[n]){labels[n]=id;queue[tail++]=n;}}
    const span=maxX-minX+1,heights=new Int32Array(span),stack=new Int32Array(span+1);
    for(let y=minY;y<=maxY;y++){for(let x=0;x<span;x++)heights[x]=labels[y*width+minX+x]===id?heights[x]+1:0;let end=0;for(let x=0;x<=span;x++){const h=x===span?0:heights[x];while(end&&heights[stack[end-1]]>h){const hh=heights[stack[--end]],left=end?stack[end-1]+1:0;maximum=Math.max(maximum,(x-left)*hh);}stack[end++]=x;}}
    components.set(id,maximum);
   }else maximum=components.get(id);}
  const requiredArea=bbox.width*width*bbox.height*height;return {possible:maximum+1e-6>=requiredArea,maximumRectangleArea:maximum,requiredArea,logicalUpperBoundOnly:true,cleanedVerified:false};
 }
 return {inspectUniform:o=>inspect(o,false),inspectManual:o=>inspect(o,true),whiteUpperBound};
}
module.exports={createBackgroundScene,footprintFits,layoutTextMatches,normalizeManualEntries,validBox,inside,overlaps,bounds,POLICY};
