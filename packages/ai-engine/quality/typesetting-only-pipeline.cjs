'use strict';
// No inference module or port. This consumes ONLY a newly approved typesetting
// capability; an old FAILED Permit and a diagnostic flag grant no authority.
const {createHash}=require('node:crypto'),{checkLayoutBinding}=require('./imported-layout-background.cjs');
const sha=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const must=(ok,code='TYPESETTING_ONLY_PERMIT_REQUIRED')=>{if(!ok)throw Object.assign(Error(code),{code});};
async function executeTypesettingOnlyPipeline(args,ports){
 const {inputs:i,permit:p,signal}=args,b=p?.binding,s=i?.typesettingSource,c=i?.current,calls={ocr:0,gemma:0,lama:0,maskModel:0,rendererPrepare:0,renderer:0,cleanedRead:0};let cleanup=false,background=null,candidate=null,layout=null;
 const gate=async phase=>{signal.throwIfAborted();await args.revalidate(phase);signal.throwIfAborted();};
 try{
  must(!['inpaint','ocr','gemma','maskModel'].some(k=>k in ports),'TYPESETTING_ONLY_AI_PORT_FORBIDDEN');
  must(p?.executionMode==='TYPESETTING_ONLY'&&b?.executionMode==='TYPESETTING_ONLY'&&p.maximumExecutions===1&&p.approvedPages?.length===1&&p.approvedPages[0]===c?.pageId&&s&&sha(s)===b.typesettingSourceSha256&&sha(s)===sha(p.sourceCleaned)&&p.executionGeneration!==s.sourceExecutionGeneration&&p.permitId!==s.sourcePermitId);
  must(['ownerScope','projectId','pageId','pageNumber','editRevision','contextRevision'].every(k=>b[k]===c[k])&&b.selectedSetSha256===i.application.selectedSetSha256);
  must(i.status==='IMPORTED_PAGE_INPUTS_READY'&&i.lines?.length===13&&i.ocrRegions===13&&i.userTranslationsUsable===13);
  must(['verifyInputs','prepare','loadCleaned','inspectBackgrounds','persistLayouts','render','persistCandidate','validate','cleanup'].every(k=>typeof ports[k]==='function'),'DIAGNOSTIC_PORTS_REQUIRED');checkLayoutBinding(i,p);
  await gate('before-inputs');const verified=await ports.verifyInputs(args);await gate('before-mask-prepare');const prepared=await ports.prepare(args,verified);calls.rendererPrepare++;
  must(prepared?.length===13&&new Set(prepared.map(l=>l.id)).size===13,'IMPORTED_IMAGE_REGION_MISMATCH');
  const renderLines=prepared.map(l=>{const row=i.lines.find(r=>r.id===l.id);must(row&&row.order===l.order&&row.sourceText===l.sourceText&&row.pageNumber===l.pageNumber,'IMPORTED_IMAGE_REGION_MISMATCH');const {userTranslation:ignored,...original}=l;return {...original,aiTranslation:row.userTranslation};});
  await gate('before-cleaned-read');const cleaned=await ports.loadCleaned({args,verified});calls.cleanedRead++;must(cleaned.sha256===s.cleanedSha256,'TYPESETTING_SOURCE_CHANGED');
  await gate('before-background-inspection');const diagnostics=await ports.inspectBackgrounds({args,verified,cleaned,renderLines});
  must(diagnostics?.version===4&&diagnostics.regions?.length===13&&new Set(diagnostics.regions.map(r=>r.id)).size===13&&diagnostics.regions.every(r=>i.lines.some(l=>l.id===r.id))&&diagnostics.blocked===diagnostics.regions.filter(r=>r.backgroundStatus!=='SAFE_PIXELS_VERIFIED').length,'BACKGROUND_DIAGNOSTICS_INVALID');
  await gate('before-background-diagnostics');background=await ports.persistLayouts({args,diagnostics});if(diagnostics.blocked)throw Object.assign(Error('MANUAL_LAYOUT_REQUIRED'),{code:'MANUAL_LAYOUT_REQUIRED',layoutDiagnostics:diagnostics});
  await gate('before-typeset');calls.renderer++;const rendered=await ports.render({args,verified,cleaned,renderLines});await gate('after-typeset');
  // Persist a non-final image BEFORE the independent contract can reject it.
  candidate=await ports.persistCandidate({args,verified,cleaned,rendered});layout=await ports.persistLayouts({args,diagnostics:{stage:'after-render',regions:rendered.layouts}});
  const validation=await ports.validate({args,verified,cleaned,rendered});await gate('before-worker-result');
  await ports.cleanup();cleanup=true;return{pngBytes:rendered.pngBytes,cleanupConfirmed:true,report:{version:1,kind:'TYPESETTING_ONLY_SINGLE_PAGE_CANDIDATE',executionMode:'TYPESETTING_ONLY',permitId:p.permitId,executionGeneration:p.executionGeneration,sourceCleaned:structuredClone(s),current:i.current,source:i.source,application:i.application,lines:structuredClone(i.lines),actualCalls:calls,typesetting:{layouts:rendered.layouts,identity:rendered.identity,independentValidation:validation},diagnostics:{sourceCleaned:s,background,candidate,layout},hashes:{cleaned:s.cleanedSha256,candidate:sha(rendered.pngBytes)},humanImageQuality:'NOT_REVIEWED',residualJapanese:'NOT_MEASURED',originalOcrPreserved:true,originalAiTranslationsPreserved:true}};
 }catch(error){
  error.actualCalls={...calls};error.diagnosticArtifacts={sourceCleaned:s??null,background,candidate,layout};
  if(error.layoutDiagnostics&&!layout)try{await gate('before-layout-diagnostics');layout=await ports.persistLayouts({args,diagnostics:error.layoutDiagnostics});error.diagnosticArtifacts.layout=layout;}catch(e){error.additionalDiagnosticPersistenceError={code:e.code??'DIAGNOSTIC_SAVE_FAILED',message:e.message};}
  try{if(!cleanup){await ports.cleanup();cleanup=true;}}catch{throw Object.assign(Error('CLEANUP_FAILED'),{code:'CLEANUP_FAILED',cleanupConfirmed:false,actualCalls:calls,diagnosticArtifacts:error.diagnosticArtifacts});}error.cleanupConfirmed=cleanup;throw error;
 }
}
module.exports={executeTypesettingOnlyPipeline};
