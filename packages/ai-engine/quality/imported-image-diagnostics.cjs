'use strict';
// Only the already consumed native worker calls this. No execution/reuse API.
const fs=require('node:fs/promises'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const {imageHeader,LIMITS}=require('../vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const sha=b=>createHash('sha256').update(b).digest('hex'),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const must=(v,code='DIAGNOSTIC_PROVENANCE_INVALID')=>{if(!v)throw Object.assign(Error(code),{code});};
async function regular(dir){const s=await fs.lstat(dir);must(s.isDirectory()&&!s.isSymbolicLink(),'DIAGNOSTIC_PATH_UNSAFE');must(path.resolve(await fs.realpath(dir)).toLowerCase()===path.resolve(dir).toLowerCase(),'DIAGNOSTIC_PATH_UNSAFE');}
async function live(args,phase){must(args.signal&&typeof args.revalidate==='function','DIAGNOSTIC_LIVE_GATE_REQUIRED');args.signal.throwIfAborted();await args.revalidate(phase);args.signal.throwIfAborted();}
async function authority(args){
 await live(args,'before-diagnostic-write');
 const p=args.permit,c=args.inputs?.current,b=p?.binding;
 must(p?.maximumExecutions===1&&p.approvedPages?.length===1&&p.approvedPages[0]===c?.pageId&&p.executionGeneration!==args.inputs.source.processingGeneration);
 must(['ownerScope','projectId','pageId','pageNumber','editRevision','contextRevision'].every(k=>b?.[k]===c?.[k])&&b.selectedSetSha256===args.inputs.application.selectedSetSha256);
 must(b.sourceSha256===c.sourceSha256&&b.normalizedSha256===c.normalizedSha256,'DIAGNOSTIC_SOURCE_BINDING_INVALID');
 require('./imported-layout-background.cjs').checkLayoutBinding(args.inputs,p);
 if(p.executionMode==='TYPESETTING_ONLY')must(p.sourceCleaned&&args.inputs.typesettingSource&&b.executionMode==='TYPESETTING_ONLY'&&sha(JSON.stringify(p.sourceCleaned))===b.typesettingSourceSha256&&sha(JSON.stringify(args.inputs.typesettingSource))===b.typesettingSourceSha256&&b.documentId&&b.documentId===args.inputs.application.documentId&&b.documentSha256===args.inputs.application.documentSha256,'TYPESETTING_SOURCE_BINDING_INVALID');
 const work=path.resolve(args.outputDirectory),out=path.resolve(p.outputDirectory);must(work===path.join(out,'work'),'DIAGNOSTIC_PATH_UNSAFE');await regular(out);await regular(work);
 return{work,provenance:{permitId:p.permitId,executionGeneration:p.executionGeneration,sourceProcessingGeneration:args.inputs.source.processingGeneration,
  binding:structuredClone(b),sourceSha256:c.sourceSha256,normalizedSha256:c.normalizedSha256,checkpointSha256:args.inputs.source.checkpointSha256,
  layoutRevision:args.inputs.layoutReview?.layoutRevision??null,layoutPlanSha256:args.inputs.layoutReview?.planSha256??null,...(p.executionMode==='TYPESETTING_ONLY'?{executionMode:'TYPESETTING_ONLY',sourceCleaned:structuredClone(p.sourceCleaned)}:{})}};
}
async function exclusive(file,bytes){const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
// exFAT has no hard links. Publish authority by a new empty completion marker
// only after exclusive JSON creation, fsync and close. Readers require it.
async function publishGateJson(file,value,{afterStage}={}){
 must(path.isAbsolute(file)&&/^gate-(?:request|response)-[1-9]\d*\.json$/.test(path.basename(file)),'LIVE_GATE_PATH_INVALID');const parent=path.dirname(file);await regular(parent);
 const bytes=Buffer.from(JSON.stringify(value));must(bytes.length>0&&bytes.length<=8192,'LIVE_GATE_RECORD_INVALID');await exclusive(file,bytes);await afterStage?.();await exclusive(file+'.ready',Buffer.alloc(0));
}
async function readGateJson(file){
 must(path.isAbsolute(file)&&/^gate-(?:request|response)-[1-9]\d*\.json$/.test(path.basename(file)),'LIVE_GATE_PATH_INVALID');
 let marker;try{marker=await fs.lstat(file+'.ready');}catch(e){if(e.code==='ENOENT')return null;throw e;}
 must(marker.isFile()&&!marker.isSymbolicLink()&&marker.size===0,'LIVE_GATE_RECORD_INVALID');await regular(path.dirname(file));
 const before=await fs.lstat(file);must(before.isFile()&&!before.isSymbolicLink()&&before.size>0&&before.size<=8192,'LIVE_GATE_RECORD_INVALID');
 const bytes=await fs.readFile(file),after=await fs.lstat(file);must(bytes.length===before.size&&before.ino===after.ino&&before.dev===after.dev&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'LIVE_GATE_RECORD_INVALID');
 let record;try{record=JSON.parse(bytes);}catch{must(false,'LIVE_GATE_RECORD_INVALID');}must(record&&typeof record==='object'&&!Array.isArray(record),'LIVE_GATE_RECORD_INVALID');return record;
}
async function commit(args,work,kind,record,image,imageName='cleaned.diagnostic.png'){
 const parent=path.join(work,'diagnostics'),name=kind+'-'+randomUUID(),staging=path.join(parent,name+'.partial'),directory=path.join(parent,name);let stage='create-directory';
 // Any IO failure leaves only an explicitly incomplete .partial directory.
 // No existing file is removed, truncated, replaced or promoted to success.
 try{
  try{await fs.mkdir(parent,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}await regular(parent);await fs.mkdir(staging,{mode:0o700});
  stage='write-image';if(image)await exclusive(path.join(staging,imageName),image);
  stage='write-manifest';const bytes=Buffer.from(JSON.stringify(record,null,2));await exclusive(path.join(staging,'manifest.json'),bytes);
  stage='readback';must(sha(await fs.readFile(path.join(staging,'manifest.json')))===sha(bytes),'DIAGNOSTIC_READBACK_MISMATCH');if(image)must(sha(await fs.readFile(path.join(staging,imageName)))===sha(image),'DIAGNOSTIC_READBACK_MISMATCH');
  stage='live-commit-gate';await live(args,'before-diagnostic-commit');
  stage='atomic-promotion';await fs.rename(staging,directory);
  return{directory,manifestSha256:sha(bytes),kind:record.kind,finalResult:false,reuseAuthorized:false};
 }catch(error){
  const detail={code:'DIAGNOSTIC_SAVE_FAILED',causeCode:error.code??error.name??null,stage,incompleteDirectory:staging,message:String(error.message).slice(0,1500)};
  error.diagnosticPersistenceError=detail;
  if(stage==='live-commit-gate'||args.signal?.aborted)throw error;
  throw Object.assign(Error('진단 증거를 안전하게 저장하지 못했습니다.'),{code:'DIAGNOSTIC_SAVE_FAILED',diagnosticPersistenceError:detail,cause:error});
 }
}
async function persistVerifiedCleaned({args,verified,cleaned}){
 const {work,provenance}=await authority(args),p=args.permit,v=cleaned?.verification;
 must(Buffer.isBuffer(cleaned?.bytes)&&cleaned.bytes.length<=LIMITS.outputBytes);
 const digest=sha(cleaned.bytes),maskSha256=p.readiness?.mask?.maskSha256;
 must(hex(maskSha256)&&v?.cleanupConfirmed===true&&v.normalizedImageSha256===args.inputs.current.normalizedSha256&&v.maskSha256===maskSha256&&v.cleanedSha256===digest);
 const h=imageHeader(cleaned.bytes,undefined,LIMITS.outputBytes);must(h.width===verified.width&&h.height===verified.height,'DIAGNOSTIC_FRAME_INVALID');
 const pv=cleaned.nativePixelVerification;
 must(pv?.version===1&&pv.status==='VERIFIED'&&pv.width===h.width&&pv.height===h.height&&pv.normalizedSha256===args.inputs.current.normalizedSha256&&pv.maskSha256===maskSha256&&pv.cleanedSha256===digest&&pv.alphaPixelsChecked===h.width*h.height&&pv.alphaPixelsChanged===0&&pv.protectedPixelsChanged===0&&Number.isSafeInteger(pv.protectedPixelsChecked)&&pv.protectedPixelsChecked>=0&&pv.protectedPixelsChecked<=h.width*h.height,'DIAGNOSTIC_NATIVE_PIXEL_PROOF_REQUIRED');
 const pins=p.readiness.pins;must(Array.isArray(pins)&&pins.length>0&&pins.every(x=>typeof x.path==='string'&&hex(x.sha256)&&Number.isSafeInteger(x.bytes)));
 const model=pins.find(x=>path.resolve(x.path)===path.resolve(args.config.lamaModel));must(model,'DIAGNOSTIC_MODEL_PROVENANCE_MISSING');
 const record={version:1,kind:'VERIFIED_CLEANED_DIAGNOSTIC_NOT_FINAL_OUTPUT',capturedAt:new Date().toISOString(),...provenance,maskSha256,cleanedSha256:digest,
  width:h.width,height:h.height,bytes:cleaned.bytes.length,inpaintingVerification:v,nativePixelVerification:pv,modelPin:model,runtimePins:pins,
  finalResult:false,reuseAuthorized:false,actualFinalImageQualityVerified:false,authorityAtCapture:'LIVE_GATE_AND_NATIVE_MASK_PIXEL_CHECKS_VERIFIED'};
 return commit(args,work,'cleaned',record,cleaned.bytes);
}
async function persistLayoutDiagnostics({args,diagnostics}){
 const {work,provenance}=await authority(args),serialized=JSON.stringify(diagnostics);must(serialized&&Buffer.byteLength(serialized)<=2*1024*1024,'DIAGNOSTIC_SIZE_INVALID');
 return commit(args,work,'layout',{version:1,kind:'LAYOUT_DIAGNOSTIC_NOT_FINAL_OUTPUT',capturedAt:new Date().toISOString(),...provenance,diagnostics:JSON.parse(serialized),finalResult:false,reuseAuthorized:false});
}
async function persistTypesetCandidate({args,verified,cleaned,rendered}){
 must(args.permit?.executionMode==='TYPESETTING_ONLY','TYPESETTING_ONLY_PERMIT_REQUIRED');const {work,provenance}=await authority(args);
 must(Buffer.isBuffer(rendered?.pngBytes)&&rendered.pngBytes.length<=LIMITS.outputBytes&&sha(cleaned.bytes)===args.permit.sourceCleaned.cleanedSha256,'TYPESETTING_CANDIDATE_INVALID');
 const frame=imageHeader(rendered.pngBytes,undefined,LIMITS.outputBytes);must(frame.width===verified.width&&frame.height===verified.height,'DIAGNOSTIC_FRAME_INVALID');
 return commit(args,work,'typeset-candidate',{version:1,kind:'TYPESET_CANDIDATE_DIAGNOSTIC_NOT_FINAL_OUTPUT',capturedAt:new Date().toISOString(),...provenance,candidateSha256:sha(rendered.pngBytes),cleanedSha256:sha(cleaned.bytes),width:frame.width,height:frame.height,bytes:rendered.pngBytes.length,qualityStatus:'PENDING_FINAL_VALIDATION',finalResult:false,reuseAuthorized:false},rendered.pngBytes,'candidate.diagnostic.png');
}
async function writeWorkerFailure({directory,record,stderr=process.stderr}){
 try{await exclusive(path.join(directory,'failure.json'),Buffer.from(JSON.stringify(record)));return {recorded:true};}
 catch(error){const fallback={kind:'WORKER_FAILURE_RECORD_WRITE_FAILED',permitId:record.permitId,executionGeneration:record.executionGeneration,originalCode:record.code,causeCode:error.code??null,message:String(error.message).slice(0,1000),finalResult:false};try{stderr.write(JSON.stringify(fallback)+'\n');}catch{}return {recorded:false,failure:fallback};}
}
module.exports={persistVerifiedCleaned,persistLayoutDiagnostics,persistTypesetCandidate,writeWorkerFailure,publishGateJson,readGateJson};
