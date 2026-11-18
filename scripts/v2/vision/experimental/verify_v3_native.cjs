// Native PNG/geometry audit of a real v3 stdio run. No models or product jobs.
const {app,nativeImage}=require('electron');
const fs=require('node:fs/promises');
const fsSync=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const [verificationFile,expectedFirstFile,firstOcrJob,output]=process.argv.slice(2);
if(![verificationFile,expectedFirstFile,firstOcrJob,output].every(value=>value&&path.isAbsolute(value)))throw new Error('absolute arguments required');
fsSync.mkdirSync(output,{recursive:false});
const profile=path.join(output,'native-profile');fsSync.mkdirSync(profile);
for(const key of ['userData','sessionData','temp'])app.setPath(key,profile);
app.disableHardwareAcceleration();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const requireValue=(condition,message)=>{if(!condition)throw new Error(message);};
function boxPixels(box,width,height,padding){
 requireValue(box&&['x','y','width','height'].every(key=>Number.isFinite(box[key]))&&box.x>=0&&box.y>=0&&box.width>0&&box.height>0&&box.x+box.width<=1.000000001&&box.y+box.height<=1.000000001,'BBOX');
 return {left:Math.max(0,Math.floor(box.x*width)-padding),top:Math.max(0,Math.floor(box.y*height)-padding),right:Math.min(width,Math.ceil((box.x+box.width)*width)+padding),bottom:Math.min(height,Math.ceil((box.y+box.height)*height)+padding)};
}
function fill(map,box,width){for(let y=box.top;y<box.bottom;y++)map.fill(1,y*width+box.left,y*width+box.right);}
function decode(bytes,width,height){
 const image=nativeImage.createFromBuffer(bytes),size=image.getSize();
 requireValue(!image.isEmpty()&&size.width===width&&size.height===height,'NATIVE_DECODE_SIZE');
 const bitmap=image.toBitmap();requireValue(bitmap.length===width*height*4,'NATIVE_BITMAP_SIZE');return bitmap;
}
function frameAudit(source,mask,width,height,region){
 const box=boxPixels(region.bbox,width,height,0),envelope=boxPixels(region.bbox,width,height,2);
 const margin=Math.max(12,Math.round(Math.min(box.right-box.left,box.bottom-box.top)*.3));
 const context={left:Math.max(0,box.left-margin),top:Math.max(0,box.top-margin),right:Math.min(width,box.right+margin),bottom:Math.min(height,box.bottom+margin)};
 const cw=context.right-context.left,ch=context.bottom-context.top,n=cw*ch;
 const dark=new Uint8Array(n),seen=new Uint8Array(n),queue=new Int32Array(n);
 for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){
  const offset=((context.top+y)*width+context.left+x)*4;
  requireValue(source[offset+3]===255,'SOURCE_ALPHA_FRAME_SCOPE');
  const gray=(77*source[offset+2]+150*source[offset+1]+29*source[offset]+128)>>8;
  if(gray<80)dark[y*cw+x]=1;
 }
 let frameComponents=0,testedDarkFramePixelsInsideEnvelope=0,maskedDarkFramePixels=0;
 for(let origin=0;origin<n;origin++){
  if(!dark[origin]||seen[origin])continue;
  let head=0,tail=1,minX=cw,minY=ch,maxX=0,maxY=0;queue[0]=origin;seen[origin]=1;
  while(head<tail){
   const index=queue[head++],y=Math.floor(index/cw),x=index-y*cw;
   minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    if(!dx&&!dy)continue;const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=cw||ny>=ch)continue;
    const next=ny*cw+nx;if(dark[next]&&!seen[next]){seen[next]=1;queue[tail++]=next;}
   }
  }
  const isFrame=minX===0||minY===0||maxX===cw-1||maxY===ch-1||((maxX-minX+1)>.6*cw&&(maxY-minY+1)>.6*ch)||tail>.2*n;
  if(!isFrame)continue;frameComponents++;
  for(let i=0;i<tail;i++){
   const index=queue[i],y=Math.floor(index/cw)+context.top,x=index%cw+context.left;
   if(x<envelope.left||x>=envelope.right||y<envelope.top||y>=envelope.bottom)continue;
   testedDarkFramePixelsInsideEnvelope++;if(mask[(y*width+x)*4+3]===0)maskedDarkFramePixels++;
  }
 }
 return {definition:'independent_native_BGR_gray_under80_8connected_frame_cores_within_member_envelope',frameComponents,testedDarkFramePixelsInsideEnvelope,maskedDarkFramePixels};
}
async function main(){
 await app.whenReady();
 const timeout=setTimeout(()=>app.exit(2),30_000);
 const verificationBytes=await fs.readFile(verificationFile),verification=JSON.parse(verificationBytes);
 const detectorBytes=await fs.readFile(verification.sourceEvidence),detectors=JSON.parse(detectorBytes).results;
 const expectedFirst=await fs.readFile(expectedFirstFile);
 requireValue(sha(expectedFirst)==='1ac8ea3576c39ee1f2c97ba16bb0611787938772323932ea177a14f64ebddc7b','EXPECTED_FIRST_FIXTURE');
 const pages=[],pins={[verificationFile]:sha(verificationBytes),[verification.sourceEvidence]:sha(detectorBytes),[expectedFirstFile]:sha(expectedFirst)};
 for(let index=0;index<verification.results.length;index++){
  const reply=verification.results[index],{width,height}=reply,prefix=String(index+1).padStart(3,'0');
  requireValue(Number.isInteger(width)&&Number.isInteger(height)&&width*height<=12_000_000&&reply.algorithm==='source-ink-radial-halo-v3-experimental'&&reply.qualityStatus==='REQUIRES_REVIEW'&&reply.clipPaddingPx===2&&reply.executionProvider==='CPUExecutionProvider'&&reply.maskKind==='LEARNED_PIXEL_MASK','REPLY_CONTRACT');
  requireValue(reply.model?.sha256==='b10356a2a12f4dec4650e563724932e542764dbd3201a7e4cae6573597c5bea1'&&reply.postprocessSourceSha256==='d45e3a504852c1054139ed485576c588778ea729857c7b6d30b15c3657181da7'&&reply.baselineSourceSha256==='9e3a662322e0d5dcf72e26d00c8a493161d390bbabf47843e94165f4d1777b9b','REPLY_PINS');
  const regions=reply.sourceRegions;
  requireValue(regions.length===reply.regions.length&&new Set(regions.map(r=>r.id)).size===regions.length&&reply.regions.every((r,i)=>r.id===regions[i].id&&r.maskPixels>0&&r.pixelsOutsideEnvelope===0),'MEMBERS');
  const sourceBytes=await fs.readFile(reply.input),rgbaFile=path.join(path.dirname(verificationFile),prefix+'-mask-rgba.png'),grayFile=path.join(path.dirname(verificationFile),prefix+'-mask-l.png');
  const rgbaBytes=await fs.readFile(rgbaFile),grayBytes=await fs.readFile(grayFile);
  requireValue(sha(sourceBytes)===reply.imageSha256&&sha(rgbaBytes)===reply.maskRgbaSha256&&sha(grayBytes)===reply.maskSha256,'CURRENT_IMAGE_OR_MASK_SHA');
  Object.assign(pins,{[reply.input]:sha(sourceBytes),[rgbaFile]:sha(rgbaBytes),[grayFile]:sha(grayBytes)});
  const source=decode(sourceBytes,width,height),rgba=decode(rgbaBytes,width,height),gray=decode(grayBytes,width,height);
  const allowed=new Uint8Array(width*height),protectedPixels=new Uint8Array(width*height);
  for(const region of regions)fill(allowed,boxPixels(region.bbox,width,height,2),width);
  const detector=detectors.find(p=>p.imageSha256===reply.imageSha256);requireValue(detector,'DETECTOR_IDENTITY');
  let protectedRegions=[],protectionScope,ocrPixelIdentity=null;
  if(index===0){
   const paths=['normalized.png','raw-ocr.json','region-selection.json'];
   const files=await Promise.all(paths.map(name=>fs.readFile(path.join(firstOcrJob,name))));
   for(let i=0;i<paths.length;i++)pins[path.join(firstOcrJob,paths[i])]=sha(files[i]);
   const normalized=decode(files[0],width,height);requireValue(source.equals(normalized),'OCR_PIXEL_IDENTITY');
   ocrPixelIdentity={sourcePngSha256:reply.imageSha256,ocrNormalizedPngSha256:sha(files[0]),nativePixelsSha256:sha(source),identicalDecodedPixels:true};
   const raw=JSON.parse(files[1]),selection=JSON.parse(files[2]).selection;
   const translated=new Set(selection.decisions.filter(d=>d.action==='translate').map(d=>d.id));
   protectedRegions=[...raw.speechBubbles.filter(r=>!translated.has(r.id)),...raw.nonSpeechText];
   protectionScope={kind:'STORED_RAW_OCR_UNTRANSLATED_AND_NON_SPEECH',rawSpeechCount:raw.speechBubbles.length,nonSpeechCount:raw.nonSpeechText.length,protectedCount:protectedRegions.length,newOcrExecutions:0};
  }else{
   protectedRegions=detector.regions.filter(r=>r.kind==='text_free');
   protectionScope={kind:'CACHED_DETECTOR_TEXT_FREE_ONLY_NO_OCR_RECHECK',protectedCount:protectedRegions.length,newOcrExecutions:0,allNonSpeechOrBubbleStylesTested:false};
  }
  for(const region of protectedRegions)fill(protectedPixels,boxPixels(region.bbox,width,height,0),width);
  let maskedPixels=0,outsideEnvelope=0,protectedMaskedPixels=0;
  for(let pixel=0;pixel<allowed.length;pixel++){
   const offset=pixel*4,alpha=rgba[offset+3];requireValue(alpha===0||alpha===255,'BINARY_ALPHA');
   const expected=255-alpha;requireValue(gray[offset]===expected&&gray[offset+1]===expected&&gray[offset+2]===expected&&gray[offset+3]===255,'GRAY_ALPHA_INVERSE');
   if(alpha===0){maskedPixels++;if(!allowed[pixel])outsideEnvelope++;if(protectedPixels[pixel])protectedMaskedPixels++;}
  }
  requireValue(maskedPixels>0&&outsideEnvelope===0&&protectedMaskedPixels===0,'MASK_PROTECTION');
  const members=regions.map((region,i)=>{
   const box=boxPixels(region.bbox,width,height,2);let actualPixels=0;
   for(let y=box.top;y<box.bottom;y++)for(let x=box.left;x<box.right;x++)if(rgba[(y*width+x)*4+3]===0)actualPixels++;
   requireValue(actualPixels>0,'EMPTY_NATIVE_MEMBER');
   const frame=frameAudit(source,rgba,width,height,region);requireValue(frame.maskedDarkFramePixels===0,'SOURCE_FRAME_ERASURE');
   return {id:region.id,nativePixelsInsideEnvelope:actualPixels,reportedOwnMaskPixels:reply.regions[i].maskPixels,frame};
  });
  const firstExpectedMatches=index===0?rgbaBytes.equals(expectedFirst):null;
  if(index===0)requireValue(firstExpectedMatches,'FIRST_REAL_MASK_FIXTURE_DIFFERENCE');
  pages.push({page:prefix,input:reply.input,imageSha256:reply.imageSha256,maskRgbaSha256:reply.maskRgbaSha256,maskedPixels,outsideEnvelope,protectedMaskedPixels,
   grayAlphaInverse:true,binaryAlpha:true,protectionScope,ocrPixelIdentity,firstExpectedMatches,members});
 }
 for(const [file,pin]of Object.entries(pins))requireValue(sha(await fs.readFile(file))===pin,'INPUT_EVIDENCE_CHANGED');
 const report={scope:'REAL_V3_STDIO_NATIVE_MASK_VALIDATION_ONLY_NOT_FULL_PIPELINE',decoder:'Electron nativeImage',newAiExecutions:0,qualityStatus:'REQUIRES_REVIEW',
  sourceVerification:verificationFile,pins,pages,bubbleStyleCoverage:'ONLY_THE_THREE_PROVIDED_PAGES_NOT_GENERAL_P0',rawAndDerivedInputsPreserved:true};
 await fs.writeFile(path.join(output,'native-validation.json'),JSON.stringify(report,null,2),{flag:'wx'});
 console.log(JSON.stringify({scope:report.scope,output,pages:pages.map(p=>({page:p.page,maskedPixels:p.maskedPixels,outsideEnvelope:p.outsideEnvelope,protectedMaskedPixels:p.protectedMaskedPixels,firstExpectedMatches:p.firstExpectedMatches}))}));
 clearTimeout(timeout);app.exit(0);
}
main().catch(error=>{console.error(JSON.stringify({scope:'V3_NATIVE_AUDIT_FAILED',code:error.message}));app.exit(1);});
