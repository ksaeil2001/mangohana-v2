'use strict';
// The sole entry takes a live server capability; it has no OCR/Gemma inference path.
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const {verifyImportedMask,verifyImportedLayout}=require('./imported-image-contract.cjs');
const {checkLayoutBinding,nativeEntries,inspectCleanedBackgrounds,verifyRenderedBackgrounds}=require('./imported-layout-background.cjs');
const sha=b=>createHash('sha256').update(b).digest('hex');
const must=(ok,code='IMPORTED_IMAGE_PERMIT_REQUIRED')=>{if(!ok)throw Object.assign(Error('현재 페이지의 별도 이미지 실행 승인이 필요합니다.'),{code});};
async function executeImportedImagePipeline(args,ports){
 const {inputs,permit,signal,revalidate}=args,c=inputs?.current,b=permit?.binding;let cleanupConfirmed=false,cleanedDiagnostic=null,layoutDiagnostic=null,backgroundDiagnostic=null,backgrounds=null,cleanedCompleted=false;
 must(permit&&typeof revalidate==='function'&&permit.maximumExecutions===1&&permit.approvedPages?.length===1&&permit.approvedPages[0]===c?.pageId&&
  ['ownerScope','projectId','pageId','pageNumber','editRevision','contextRevision'].every(k=>b[k]===c[k])&&b.selectedSetSha256===inputs.application.selectedSetSha256&&permit.executionGeneration!==inputs.source.processingGeneration);
 must(inputs.status==='IMPORTED_PAGE_INPUTS_READY'&&inputs.ocrRegions===13&&inputs.userTranslationsUsable===13&&inputs.lines.length===13);
 checkLayoutBinding(inputs,permit);
 const actualCalls={ocr:0,gemma:0,maskModel:0,lama:0,rendererPrepare:0,renderer:0};
 const gate=async phase=>{signal.throwIfAborted();await revalidate(phase);signal.throwIfAborted();};
 try{
  must(['persistCleaned','persistLayouts','inspectBackgrounds'].every(k=>typeof ports[k]==='function'),'DIAGNOSTIC_PORTS_REQUIRED');
  await gate('before-inputs');const verified=await ports.verifyInputs(args);await gate('before-mask-prepare');
  const prepared=await ports.prepare(args,verified);actualCalls.rendererPrepare++;
  must(Array.isArray(prepared)&&prepared.length===13&&new Set(prepared.map(l=>l.id)).size===13,'IMPORTED_IMAGE_REGION_MISMATCH');
  const renderLines=prepared.map(l=>{const row=inputs.lines.find(r=>r.id===l.id);must(row&&l.sourceText===row.sourceText&&l.order===row.order&&l.pageNumber===row.pageNumber,'IMPORTED_IMAGE_REGION_MISMATCH');
   const {userTranslation:_user,...original}=l;return {...original,aiTranslation:row.userTranslation};});
  await gate('before-lama');actualCalls.lama++;const cleaned=await ports.inpaint(args,verified);await gate('after-lama');cleanedCompleted=true;
  await gate('before-cleaned-diagnostics');cleanedDiagnostic=await ports.persistCleaned({args,verified,cleaned});
  await gate('before-background-inspection');backgrounds=await ports.inspectBackgrounds({args,verified,cleaned,renderLines});
  must(backgrounds?.version===4&&backgrounds.regions?.length===13&&new Set(backgrounds.regions.map(r=>r.id)).size===13&&backgrounds.regions.every(r=>inputs.lines.some(l=>l.id===r.id))&&backgrounds.blocked===backgrounds.regions.filter(r=>r.backgroundStatus!=='SAFE_PIXELS_VERIFIED').length,'BACKGROUND_DIAGNOSTICS_INVALID');
  await gate('before-background-diagnostics');backgroundDiagnostic=await ports.persistLayouts({args,diagnostics:backgrounds});
  if(backgrounds.blocked)throw Object.assign(Error('복원 후 배경 사전 검사에서 안전 근거가 부족한 영역이 있습니다.'),{code:'MANUAL_LAYOUT_REQUIRED',layoutDiagnostics:backgrounds});
  await gate('before-typeset');actualCalls.renderer++;const rendered=await ports.render({args,verified,cleaned,renderLines});await gate('after-typeset');
  await gate('before-layout-diagnostics');layoutDiagnostic=await ports.persistLayouts({args,diagnostics:{stage:'after-render',regions:rendered.layouts}});
  const validation=await ports.validate({args,verified,cleaned,rendered});await gate('before-worker-result');
  const report={version:1,kind:'APPROVED_TRANSLATION_SINGLE_PAGE_CANDIDATE',permitId:permit.permitId,executionGeneration:permit.executionGeneration,sourceProcessingGeneration:inputs.source.processingGeneration,
   application:inputs.application,current:inputs.current,source:inputs.source,lines:structuredClone(inputs.lines),actualCalls,mask:verified.maskEvidence??verified,
   inpainting:cleaned.verification,typesetting:{layouts:rendered.layouts,identity:rendered.identity,...(validation?{independentValidation:validation}:{})},hashes:{mask:verified.maskEvidence?.maskSha256,cleaned:sha(cleaned.bytes),candidate:sha(rendered.pngBytes)},
   diagnostics:{cleaned:cleanedDiagnostic,background:backgroundDiagnostic,layout:layoutDiagnostic},independentSemanticVerification:null,humanImageQuality:'NOT_REVIEWED',residualJapanese:'NOT_MEASURED',semanticWarnings:inputs.lines.flatMap(l=>l.riskSignals),originalAiTranslationsPreserved:true,originalOcrPreserved:true};
  await ports.cleanup();cleanupConfirmed=true;return {pngBytes:rendered.pngBytes,report,cleanupConfirmed:true};
 }catch(error){
  error.actualCalls={...actualCalls};error.diagnosticArtifacts={cleaned:cleanedDiagnostic,background:backgroundDiagnostic,layout:layoutDiagnostic};
  if(cleanedCompleted&&ports.persistLayouts&&!layoutDiagnostic&&!(backgroundDiagnostic&&error.layoutDiagnostics===backgrounds))try{
   await gate('before-layout-diagnostics');
   layoutDiagnostic=await ports.persistLayouts({args,diagnostics:error.layoutDiagnostics??{stage:'UNAVAILABLE',regions:inputs.lines.map(l=>({id:l.id,fontSizePx:null,fitStatus:null,measurementAvailable:false})),causeCode:error.code??null}});
   error.diagnosticArtifacts.layout=layoutDiagnostic;
  }catch(e){error.additionalDiagnosticPersistenceError=e.diagnosticPersistenceError??{code:e.code??'DIAGNOSTIC_SAVE_FAILED',message:e.message};}
  try{if(!cleanupConfirmed){await ports.cleanup();cleanupConfirmed=true;}}catch{throw Object.assign(Error('소유 프로세스 정리 결과를 확인하지 못했습니다.'),{code:'CLEANUP_FAILED',cleanupConfirmed:false,diagnosticArtifacts:error.diagnosticArtifacts,diagnosticPersistenceError:error.diagnosticPersistenceError??null,layoutDiagnostics:error.layoutDiagnostics??null,actualCalls:{...actualCalls},originalCode:error.code??null});}error.cleanupConfirmed=cleanupConfirmed;throw error;
 }
}
async function createNativeImagePorts({config,source,outputDirectory,signal}){
 const {nativeImage}=require('electron'),{createRenderer,rendererCall,validateRendered}=require('../vendor/trio/scripts/sites-local/engine.cjs');
 const {LIMITS,ProcessOwner,deadline,collectProcess,parseLamaResponse,secretlessEnvironment,waitBounded,imageHeader}=require('../vendor/trio/scripts/sites-local/engine-boundaries.cjs');
 const {pathToFileURL}=require('node:url'),owner=new ProcessOwner();let window,normalized,mask,record,maskIdentity,font,bundle,manualEntries=[];
 const decode=(bytes,dimensions)=>{const header=imageHeader(bytes,undefined,LIMITS.outputBytes),im=nativeImage.createFromBuffer(bytes),size=im.getSize();must(!im.isEmpty()&&header.width===dimensions.width&&header.height===dimensions.height&&size.width===dimensions.width&&size.height===dimensions.height,'IMPORTED_IMAGE_FRAME');return im;};
 const rgba=(bytes,dimensions)=>{const b=Buffer.from(decode(bytes,dimensions).toBitmap());for(let i=0;i<b.length;i+=4){const r=b[i];b[i]=b[i+2];b[i+2]=r;}return b;};
 const compare=(before,after,bytes,dimensions,onlyAlpha=false)=>{const a=decode(before,dimensions).toBitmap(),z=decode(after,dimensions).toBitmap(),m=decode(bytes,dimensions).toBitmap();let protectedPixelsChecked=0;for(let i=0;i<a.length;i+=4){must(a[i+3]===z[i+3],'TYPESET_ALPHA');if(!onlyAlpha&&m[i+3]===255){must(a[i]===z[i]&&a[i+1]===z[i+1]&&a[i+2]===z[i+2],'INPAINT_PIXELS');protectedPixelsChecked++;}}return {version:1,status:'VERIFIED',width:dimensions.width,height:dimensions.height,normalizedSha256:sha(before),maskSha256:sha(bytes),cleanedSha256:sha(after),alphaPixelsChecked:a.length/4,alphaPixelsChanged:0,protectedPixelsChecked,protectedPixelsChanged:0};};
 return {
  persistCleaned:record=>require('./imported-image-diagnostics.cjs').persistVerifiedCleaned(record),
  persistLayouts:record=>require('./imported-image-diagnostics.cjs').persistLayoutDiagnostics(record),
  async inspectBackgrounds({args,verified,cleaned,renderLines}){return inspectCleanedBackgrounds({inputs:args.inputs,maskEvidence:verified.maskEvidence,manualEntries,sourcePixels:rgba(normalized,verified),cleanedPixels:rgba(cleaned.bytes,verified),maskPixels:rgba(mask,verified),cleanedSha256:sha(cleaned.bytes),renderLines,inferCandidateBox:require('../.build/layout-source-geometry.cjs').inferCandidateBox});},
  async verifyInputs({inputs,permit}){
   checkLayoutBinding(inputs,permit);
   const evidence=await verifyImportedMask({sourceDirectory:source.directory,inputs,expectedAlgorithm:config.textMaskAlgorithm});normalized=await fs.readFile(path.join(source.directory,'normalized.png'));mask=await fs.readFile(path.join(source.directory,'removal-mask.png'));
   must(sha(normalized)===inputs.current.normalizedSha256&&sha(mask)===evidence.maskSha256,'SOURCE_CHANGED');decode(normalized,evidence);decode(mask,evidence);
   const fontModule=await import(pathToFileURL(path.join(config.buildRoot,'src/main/productionTypesetFontResource.js')).href);font=await fontModule.initializeProductionTypesetFontResource(config.resourcesPath,{warn:()=>{}});must(font.enabled,'FONT_UNAVAILABLE');bundle=await fs.readFile(config.rendererBundle,'utf8');
   manualEntries=nativeEntries(inputs,evidence,sha(await fs.readFile(path.join(config.resourcesPath,'pipeline-resources/pretendard-ko-fallback/1.3.9/PretendardVariable.ttf'))));
   return {width:evidence.width,height:evidence.height,maskEvidence:evidence};
  },
  async prepare({inputs,permit},verified){
   window=await createRenderer(font,bundle,signal);const e=verified.maskEvidence.extraction;
   maskIdentity={version:1,jobId:permit.executionGeneration,pageNumber:e.pageNumber,sourceImageSha256:inputs.current.normalizedSha256,ocrSha256:sha(JSON.stringify(e)),coordinateSpace:'normalized-page-pixels',width:verified.width,height:verified.height};
   const prepared=await deadline(signal,LIMITS.renderMs,'MASK_TIMEOUT',s=>rendererCall(window,'prepare',{jobId:permit.executionGeneration,ocr:e,width:verified.width,height:verified.height,sourcePngBase64:normalized.toString('base64'),sourceLanguage:'ja',maskIdentity},s));
   must(prepared.jobId===permit.executionGeneration,'STALE_RESULT');return prepared.lines;
  },
  async inpaint(_args,verified){
   return deadline(signal,LIMITS.lamaMs,'INPAINT_TIMEOUT',async s=>{
    const bridge=path.join(config.repository,'scripts/sites-local/lama-stdio.py');record=owner.spawn(config.python,['-I','-B',bridge,'--python',config.python,'--worker',config.lamaWorker,'--model',config.lamaModel,'--tile-wrapper',config.lamaTileWrapper,'--log-dir',outputDirectory],
     {cwd:path.dirname(config.python),windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:secretlessEnvironment(config.python,path.join(config.profileRoot,'engine-temp'))});
    let stopping;const cancel=()=>{if(!stopping){record.child.stdin.end('{"cancel":true}\n');stopping=waitBounded(record.done,LIMITS.cleanupMs).catch(()=>owner.terminate(record,true));stopping.catch(()=>{});}};
    const collect=collectProcess(record,{stdoutLimit:4*Math.ceil(LIMITS.outputBytes/3)+8192,onOverflow:cancel});s.addEventListener('abort',cancel,{once:true});
    try{
     s.throwIfAborted();record.child.stdin.write(JSON.stringify({image:normalized.toString('base64'),mask:mask.toString('base64')})+'\n');const reply=parseLamaResponse(await collect(),s);
     must(reply?.version===1&&reply.ok===true&&reply.width===verified.width&&reply.height===verified.height&&reply.verification?.cleanupConfirmed===true&&reply.verification.normalizedImageSha256===sha(normalized)&&reply.verification.maskSha256===sha(mask),'INPAINT_RESPONSE');
     const bytes=Buffer.from(reply.imagePngBase64,'base64');must(bytes.length<=LIMITS.outputBytes&&reply.verification.cleanedSha256===sha(bytes),'INPAINT_RESPONSE');const nativePixelVerification=compare(normalized,bytes,mask,verified);return {bytes,verification:reply.verification,nativePixelVerification};
    }finally{s.removeEventListener('abort',cancel);if(stopping)await stopping;if(!record.closed)await owner.terminate(record,true);}
   });
  },
  async render({args,verified,cleaned,renderLines}){
   const identity={...maskIdentity,contract:'stage12-input-v1',sourceSha256:args.inputs.current.sourceSha256,cleanedImageSha256:sha(cleaned.bytes),maskSha256:sha(mask),translationInputFingerprint:args.inputs.application.selectedSetSha256,
    workId:args.inputs.current.projectId,pageId:args.inputs.current.pageId,ownerScope:args.inputs.current.ownerScope,translationContextRevision:args.inputs.current.contextRevision,fontResourceIdentity:'Pretendard Std Variable@1.3.9',mode:'unreviewed_candidate',maskReview:'candidate_validated_not_human_approved'};
   const backgroundContext={sourcePngBase64:normalized.toString('base64'),maskPngBase64:mask.toString('base64'),sourceSha256:args.inputs.current.normalizedSha256,cleanedSha256:sha(cleaned.bytes),maskSha256:sha(mask),allowedBoxes:verified.maskEvidence.layoutRegions.map(r=>({id:r.id,bbox:r.allowedBbox})),manualEntries,...(manualEntries.length?{manualApprovalSha256:args.inputs.layoutReview.planSha256}:{})};
   const rendered=await deadline(signal,LIMITS.renderMs,'TYPESET_TIMEOUT',s=>rendererCall(window,'render',{jobId:args.permit.executionGeneration,cleanedPngBase64:cleaned.bytes.toString('base64'),lines:renderLines,typesettingIdentity:identity,backgroundContext,returnStructuredFailure:true},s));
   if(rendered?.failure){must(rendered.jobId===args.permit.executionGeneration&&typeof rendered.failure.code==='string','STALE_RESULT');const error=Object.assign(Error(rendered.failure.message),{code:rendered.failure.code,layoutDiagnostics:rendered.failure.layoutDiagnostics??null});if(typeof rendered.failure.stack==='string')error.stack=rendered.failure.stack.slice(0,16384);throw error;}
   validateRendered(rendered,args.permit.executionGeneration,renderLines,verified,identity);return {pngBytes:Buffer.from(rendered.pngBase64,'base64'),layouts:rendered.layoutReport,identity};
  },
  async validate({args,verified,cleaned,rendered}){
   const validation=verifyRenderedBackgrounds({layouts:rendered.layouts,inputs:args.inputs,maskEvidence:verified.maskEvidence,manualEntries,sourcePixels:rgba(normalized,verified),cleanedPixels:rgba(cleaned.bytes,verified),maskPixels:rgba(mask,verified),finalPixels:rgba(rendered.pngBytes,verified),cleanedSha256:sha(cleaned.bytes)});
   validation.approvedLayoutReview=args.inputs.layoutReview;
   verifyImportedLayout(rendered.layouts,args.inputs.lines,validation);compare(normalized,rendered.pngBytes,mask,verified,true);must(sha(await fs.readFile(path.join(source.directory,'source.png')))===args.inputs.current.sourceSha256&&sha(await fs.readFile(path.join(source.directory,'normalized.png')))===sha(normalized),'SOURCE_CHANGED');return validation.independentPixels;
  },
  async cleanup(){if(window&&!window.isDestroyed())window.destroy();await owner.cleanup();},
 };
}
module.exports={executeImportedImagePipeline,createNativeImagePorts};
