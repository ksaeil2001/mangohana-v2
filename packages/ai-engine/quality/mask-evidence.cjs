'use strict';
const {createHash}=require('node:crypto');
const {retainedSourceLines}=require('./restoration-source-lines.cjs');
const invalid=()=>Object.assign(new Error('제거 마스크와 원본·보호 영역의 대응을 확인하지 못했습니다.'),{code:'TEXT_MASK_INVALID'});
const requireValue=condition=>{if(!condition)throw invalid();};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const modelSha='b10356a2a12f4dec4650e563724932e542764dbd3201a7e4cae6573597c5bea1';
const v1Algorithm='dual-context-consensus-v1';
const v3Algorithm='source-ink-radial-halo-v3-experimental';
function verifyAlgorithm(reply,expectedAlgorithm){
 // Selection comes only from the server caller. Response metadata never
 // upgrades the default, and an unknown configured value fails closed.
 requireValue(expectedAlgorithm===v1Algorithm||expectedAlgorithm===v3Algorithm);
 requireValue(reply?.algorithm===expectedAlgorithm&&(reply.maskAlgorithm===undefined||reply.maskAlgorithm===expectedAlgorithm));
 if(expectedAlgorithm===v1Algorithm){requireValue(reply.haloRadius===2);return;}
 requireValue(!Object.hasOwn(reply,'haloRadius')&&reply.clipPaddingPx===2&&reply.adaptiveHalo===true&&
  reply.baselineAlgorithm===v1Algorithm&&reply.baselineHaloRadius===2&&
  reply.baselineSourceSha256==='9e3a662322e0d5dcf72e26d00c8a493161d390bbabf47843e94165f4d1777b9b'&&
  reply.postprocessSourceSha256==='d45e3a504852c1054139ed485576c588778ea729857c7b6d30b15c3657181da7');
}
function protectedOcrRegions(extraction,selection){
 requireValue(Array.isArray(extraction?.speechBubbles)&&Array.isArray(extraction?.nonSpeechText)&&Array.isArray(selection?.decisions));
 const translated=new Set(selection.decisions.filter(item=>item?.action==='translate').map(item=>item.id));
 return [...extraction.speechBubbles.filter(item=>!translated.has(item.id)),...extraction.nonSpeechText];
}
function checkPng(bytes,width,height,expected){
 requireValue(Buffer.isBuffer(bytes)&&bytes.length>=24&&bytes.length<=32*1024*1024&&
  bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&bytes.readUInt32BE(16)===width&&bytes.readUInt32BE(20)===height&&sha(bytes)===expected);
}
function bounds(box,width,height,padding){
 requireValue(box&&['x','y','width','height'].every(key=>Number.isFinite(box[key]))&&box.x>=0&&box.y>=0&&box.width>0&&box.height>0&&box.x+box.width<=1.000000001&&box.y+box.height<=1.000000001);
 const left=Math.max(0,Math.floor(box.x*width)-padding),top=Math.max(0,Math.floor(box.y*height)-padding);
 const right=Math.min(width,Math.ceil((box.x+box.width)*width)+padding),bottom=Math.min(height,Math.ceil((box.y+box.height)*height)+padding);
 return {left,top,right,bottom};
}
function fillBox(map,box,width,height,padding){
 const {left,top,right,bottom}=bounds(box,width,height,padding);
 for(let y=top;y<bottom;y++)map.fill(1,y*width+left,y*width+right);
}
/** Server-owned candidate identity. No crop-local or stale renderer mask is admitted.
 * Native decode must precede this call; RGB order may be BGRA or RGBA because
 * preserved channels must all be white and removal is owned solely by alpha.
 * OCR envelopes/optional explicit protection are evidence, not an artwork detector.
 */
function verifySourceTextMask({bytes,bitmap,identity,expectedIdentity,expectedPixels,allowedRegions,protectedRegions=[],protectionPixels}){
 const fields=['version','jobId','pageNumber','sourceImageSha256','ocrSha256','coordinateSpace','width','height'];
 requireValue(expectedIdentity&&identity&&fields.every(k=>Object.hasOwn(expectedIdentity,k)&&identity[k]===expectedIdentity[k])&&
  Object.keys(identity).length===fields.length&&Object.keys(expectedIdentity).length===fields.length);
 const {width,height}=expectedIdentity,size=width*height;
 requireValue(expectedIdentity.version===1&&typeof expectedIdentity.jobId==='string'&&expectedIdentity.jobId.length>0&&expectedIdentity.jobId.length<=200&&
  Number.isSafeInteger(expectedIdentity.pageNumber)&&expectedIdentity.pageNumber>0&&
  /^[a-f0-9]{64}$/.test(expectedIdentity.sourceImageSha256)&&/^[a-f0-9]{64}$/.test(expectedIdentity.ocrSha256)&&
  expectedIdentity.coordinateSpace==='normalized-page-pixels'&&Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0&&size<=16_000_000&&
  Number.isSafeInteger(expectedPixels)&&expectedPixels>0&&expectedPixels<size);
 checkPng(bytes,width,height,sha(bytes));
 requireValue(bitmap instanceof Uint8Array&&bitmap.length===size*4&&Array.isArray(allowedRegions)&&allowedRegions.length>0&&allowedRegions.length<=1000&&
  new Set(allowedRegions.map(r=>r?.id)).size===allowedRegions.length&&Array.isArray(protectedRegions)&&protectedRegions.length<=1000);
 if(protectionPixels!==undefined)requireValue(protectionPixels instanceof Uint8Array&&protectionPixels.length===size&&protectionPixels.every(v=>v===0||v===255));
 const allowed=new Uint8Array(size),protectedPixels=new Uint8Array(size);
 for(const r of allowedRegions){
  requireValue(typeof r?.id==='string'&&r.id.length>0&&Number.isSafeInteger(r.paddingPx)&&r.paddingPx>=0&&r.paddingPx<=Math.max(width,height));
  fillBox(allowed,r.bbox,width,height,r.paddingPx);
 }
 for(const r of protectedRegions)fillBox(protectedPixels,r?.bbox,width,height,0);
 let maskedPixels=0,protectedRegionPixels=0,outsideSelectedRegions=0,knownProtectedPixels=0;
 for(let i=0;i<size;i++){
  const at=i*4,alpha=bitmap[at+3];requireValue(alpha===0||alpha===255);
  const protectedHere=protectedPixels[i]||protectionPixels?.[i];if(protectedHere)knownProtectedPixels++;
  if(alpha===255){requireValue(bitmap[at]===255&&bitmap[at+1]===255&&bitmap[at+2]===255);continue;}
  maskedPixels++;if(!allowed[i])outsideSelectedRegions++;if(protectedHere)protectedRegionPixels++;
 }
 requireValue(maskedPixels===expectedPixels&&maskedPixels>0&&maskedPixels<size&&outsideSelectedRegions===0&&protectedRegionPixels===0);
 return {identity:{...identity},maskSha256:sha(bytes),maskedPixels,protectedRegionPixels,outsideSelectedRegions,knownProtectedPixels,
  protectionScope:protectionPixels?'OCR_ENVELOPES_AND_EXPLICIT_PIXELS':'OCR_ENVELOPES_ONLY',qualityStatus:'REQUIRES_REVIEW'};
}
/** Native PNG decode is required before passing its BGRA/RGBA bitmap here. */
function verifyLearnedMask({reply,request,bytes,grayBytes,bitmap,grayBitmap,protectedRegions=[],expectedAlgorithm=v1Algorithm}){
 const {width,height,regions}=request??{};
 requireValue(Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0&&width<=8000&&height<=8000&&width*height<=12_000_000&&
  /^[a-f0-9]{64}$/.test(request.imageSha256)&&Array.isArray(regions)&&regions.length>0&&regions.length<=64&&
  new Set(regions.map(region=>region.id)).size===regions.length&&regions.every(region=>typeof region.id==='string'&&region.id.length>0));
 verifyAlgorithm(reply,expectedAlgorithm);
 requireValue(reply?.version===1&&reply.ok===true&&reply.width===width&&reply.height===height&&reply.imageSha256===request.imageSha256&&
  reply.model?.sha256===modelSha&&reply.executionProvider==='CPUExecutionProvider'&&reply.maskKind==='LEARNED_PIXEL_MASK'&&
  reply.qualityStatus==='REQUIRES_REVIEW'&&
  Array.isArray(reply.regions)&&reply.regions.length===regions.length&&reply.regions.every((region,index)=>region.id===regions[index].id&&Number.isInteger(region.maskPixels)&&region.maskPixels>0));
 checkPng(bytes,width,height,reply.maskRgbaSha256);checkPng(grayBytes,width,height,reply.maskSha256);
 requireValue(bitmap instanceof Uint8Array&&bitmap.length===width*height*4&&grayBitmap instanceof Uint8Array&&grayBitmap.length===bitmap.length&&Array.isArray(protectedRegions)&&protectedRegions.length<=1000);
 const allowed=new Uint8Array(width*height),protectedPixels=new Uint8Array(width*height);
 for(const region of regions)fillBox(allowed,region.bbox,width,height,2);
 for(const region of protectedRegions)fillBox(protectedPixels,region.bbox,width,height,0);
 let maskedPixels=0,outsideSelectedRegions=0,protectedRegionPixels=0;
 for(let pixel=0;pixel<allowed.length;pixel++){
  const alpha=bitmap[pixel*4+3];requireValue(alpha===0||alpha===255);
  const value=255-alpha;
  requireValue(grayBitmap[pixel*4]===value&&grayBitmap[pixel*4+1]===value&&grayBitmap[pixel*4+2]===value&&grayBitmap[pixel*4+3]===255);
  if(alpha===255)continue;
  maskedPixels++;if(!allowed[pixel])outsideSelectedRegions++;if(protectedPixels[pixel])protectedRegionPixels++;
 }
 requireValue(maskedPixels>0&&outsideSelectedRegions===0&&protectedRegionPixels===0);
 const members=regions.map(region=>{
  const {left,top,right,bottom}=bounds(region.bbox,width,height,2);let maskedPixelsInsideEnvelope=0;
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)if(bitmap[(y*width+x)*4+3]===0)maskedPixelsInsideEnvelope++;
  requireValue(maskedPixelsInsideEnvelope>0);
  return {id:region.id,maskedPixelsInsideEnvelope};
 });
 return {maskedPixels,outsideSelectedRegions,protectedRegionPixels,grayAlphaCorrespondence:true,members,qualityStatus:'REQUIRES_REVIEW'};
}
function inspectRestorationInk(input){
 const {source,result,mask,width,height,regions}=input;
 requireValue(Number.isSafeInteger(width)&&width>0&&Number.isSafeInteger(height)&&height>0&&
  [source,result,mask].every(bytes=>bytes instanceof Uint8Array&&bytes.length===width*height*4));
 const boxes=regions.map(region=>({id:region.id,...bounds(region.bbox,width,height,0),hadDark:false,changed:false}));
 const darkPrefix=new Uint32Array(width+1),changedPrefix=new Uint32Array(width+1);
 for(let y=0;y<height;y++){
  const active=boxes.filter(box=>!box.changed&&box.top<=y&&y<box.bottom);
  if(!active.length)continue;
  for(let x=0;x<width;x++){
   const p=(y*width+x)*4;
   const dark=mask[p+3]===0&&source[p+3]===255&&Math.max(source[p],source[p+1],source[p+2])<96;
   const changed=dark&&(source[p]!==result[p]||source[p+1]!==result[p+1]||source[p+2]!==result[p+2]||source[p+3]!==result[p+3]);
   darkPrefix[x+1]=darkPrefix[x]+Number(dark);
   changedPrefix[x+1]=changedPrefix[x]+Number(changed);
  }
  for(const box of active){
   box.hadDark ||= darkPrefix[box.right]>darkPrefix[box.left];
   box.changed ||= changedPrefix[box.right]>changedPrefix[box.left];
  }
 }
 const unchangedSourceLines=retainedSourceLines(input);
 const retainedLineRegions=new Set(unchangedSourceLines.map(row=>row.regionId));
 const unchangedRegionIds=boxes.filter(box=>(box.hadDark&&!box.changed)||retainedLineRegions.has(box.id)).map(box=>box.id);
 return {unchangedRegionIds,unchangedSourceLines};
}

function unchangedRestorationRegions(input){
 return inspectRestorationInk(input).unchangedRegionIds;
}

module.exports={verifyLearnedMask,verifySourceTextMask,protectedOcrRegions,inspectRestorationInk,unchangedRestorationRegions};
