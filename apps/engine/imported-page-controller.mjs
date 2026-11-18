import fs from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {createImagePermitStore,digest,demand,exact,regularDirectory,writeExclusive} from './image-permit-store.mjs';
import {readBounded} from './translation-review-store.mjs';
export const imageExecutionBinding=b=>({ownerScope:b.current.ownerScope,documentId:b.documentId,documentSha256:b.documentSha256,projectId:b.current.projectId,pageId:b.current.pageId,pageNumber:b.current.pageNumber,
 eventSha256:b.receipt.eventSha256,selectedSetSha256:b.receipt.selectedSetSha256,editRevision:b.current.editRevision,contextRevision:b.current.contextRevision,
 sourceSha256:b.current.sourceSha256,normalizedSha256:b.current.normalizedSha256,sourceProcessingGeneration:b.sourceProcessingGeneration,regionsSha256:digest(b.regions),...(b.layoutReview?{layoutReviewSha256:digest(b.layoutReview),layoutRevision:b.layoutReview.layoutRevision}:{}),...(b.typesettingSource?{executionMode:'TYPESETTING_ONLY',typesettingSourceSha256:digest(b.typesettingSource)}:{})});
const bound=imageExecutionBinding;
export async function createImportedPageController({root,outputRoot,reviewStore,inspectInputs,preflight,runPipeline,verifyOutput,clock=()=>Date.now(),executionMode='FULL_IMAGE',enrichBinding=async b=>b}){
 demand([inspectInputs,preflight,runPipeline,verifyOutput].every(v=>typeof v==='function')&&path.isAbsolute(outputRoot),'IMAGE_CONTROLLER_CONFIG',503);
 demand(['FULL_IMAGE','TYPESETTING_ONLY'].includes(executionMode)&&typeof enrichBinding==='function','IMAGE_CONTROLLER_CONFIG',503);
 const typed=executionMode==='TYPESETTING_ONLY',approvalKind=typed?'EXPLICIT_TYPESETTING_ONLY_FROM_VERIFIED_CLEANED':'EXPLICIT_SINGLE_PAGE_IMAGE_EXECUTION';
 const checkMode=p=>demand((p.executionMode??'FULL_IMAGE')===executionMode,'IMAGE_EXECUTION_MODE_MISMATCH');
 const withInputs=(owner,id,expected,work)=>reviewStore.withEngineInputs(owner,id,expected,async(raw,revalidateBase)=>{
  const binding=await enrichBinding(raw);if(typed)demand(binding.typesettingSource?.sourcePermitId&&binding.typesettingSource.cleanedSha256,'TYPESETTING_SOURCE_REQUIRED');
  const revalidate=async()=>{await revalidateBase();if(typed)demand(digest((await enrichBinding(raw)).typesettingSource)===digest(binding.typesettingSource),'IMAGE_PERMIT_REVISION_CONFLICT');};
  const result=await work(binding,revalidate);await revalidate();return result;
 });
 const journal=await createImagePermitStore(root),active=new Map();let closing=false;
 const state=r=>r.outcome?.state??(r.consumed?(active.has(r.proposal.permitId)?r.cancel?'CANCELLING':'CONSUMED':'RESULT_UNKNOWN'):r.cancel?'CANCELLED':r.approval?'APPROVED':'AWAITING_APPROVAL');
 const view=r=>{const {ownerScope:_owner,signature:_signature,expected:_expected,...p}=r.proposal;return {...p,proposalSha256:digest(r.proposal),state:state(r),executionAuthorized:!!r.approval&&!r.consumed&&!r.cancel&&clock()<p.expiresAt,result:r.outcome?.result??null,errorCode:r.outcome?.errorCode??null};};
 const checkBinding=(p,b)=>demand(digest(p.binding)===digest(bound(b)),'IMAGE_PERMIT_REVISION_CONFLICT');
 const validateInputs=i=>demand(i?.status==='IMPORTED_PAGE_INPUTS_READY'&&i.ocrRegions===13&&i.userTranslationsUsable===13&&i.lines.length===13&&i.executionAuthorized===false,'IMAGE_INPUTS_REQUIRED');
 async function inspect(binding,outputDirectory,mode='full',signal){
  const inspected=await inspectInputs(binding,{signal});validateInputs(inspected);
  demand(inspected.layoutReview===undefined||binding.layoutReview&&digest(inspected.layoutReview)===digest(binding.layoutReview),'LAYOUT_EXECUTION_BINDING_INVALID');
  // OCR reuse retains its audited, image-independent contract. The server's
  // execution binding owns the separately approved image layout capability.
  const inputs=binding.layoutReview?{...inspected,layoutReview:structuredClone(binding.layoutReview)}:inspected;
  const readiness=await preflight({binding,inputs,outputDirectory,mode});
  demand(readiness?.status==='READY'&&readiness.blockers?.length===0&&/^[a-f0-9]{64}$/.test(readiness.fingerprint),'IMAGE_PREFLIGHT_BLOCKED',423);return {inputs,readiness};
 }
 const entry=(p,extra={})=>({version:1,permitId:p.permitId,proposalSha256:digest(p),at:new Date(clock()).toISOString(),...extra});
 async function get(owner,documentId,id){const r=await journal.load(owner,documentId,id);checkMode(r.proposal);
  if(r.outcome?.state==='SUCCEEDED')try{const receipt=await journal.read(id,'result-receipt');demand(digest(receipt.result)===digest(r.outcome.result),'IMAGE_RECEIPT_INVALID');
   const dir=r.proposal.outputDirectory;await regularDirectory(dir);demand(digest(await readBounded(path.join(dir,'final.png'),32*1024*1024))===receipt.result.sha256&&digest(await readBounded(path.join(dir,'report.json')))===receipt.result.reportSha256&&digest(await readBounded(path.join(dir,'receipt.json')))===digest(JSON.stringify(receipt)),'IMAGE_RECEIPT_INVALID');
  }catch{return view({...r,outcome:{state:'RESULT_UNKNOWN',errorCode:'IMAGE_RESULT_RECEIPT_UNVERIFIED',result:null}});}
  return view(r);
 }
 async function prepare(owner,documentId,expected){
  demand(!closing,'IMAGE_CONTROLLER_CLOSED',503);
  return withInputs(owner,documentId,expected,async(binding,revalidate)=>{
   demand(typed||!binding.layoutReview?.roiExpansion,'TYPESETTING_ONLY_REQUIRED',403);
   const id=randomUUID(),outputDirectory=path.join(outputRoot,(typed?'stage14r3-typesetting-':'stage14r3-')+id),{readiness}=await inspect(binding,outputDirectory);await revalidate();
   const p=await journal.create({version:1,kind:typed?'SINGLE_PAGE_TYPESETTING_ONLY_PROPOSAL':'SINGLE_PAGE_IMAGE_EXECUTION_PROPOSAL',permitId:id,...bound(binding),binding:bound(binding),sessionScope:reviewStore.scope(owner),
    ...(typed?{executionMode,sourceCleaned:structuredClone(binding.typesettingSource)}:{}),
    expected:structuredClone(expected),executionGeneration:randomUUID(),maximumExecutions:1,approvedPages:[binding.current.pageId],outputDirectory,
    readinessFingerprint:readiness.fingerprint,readiness,issuedAt:new Date(clock()).toISOString(),expiresAt:clock()+30*60*1000,translationApprovalGrantsImageExecution:false});
   return view({proposal:p});
  });
 }
 async function approve(owner,documentId,command){
  exact(command,['permitId','proposalSha256','executionAcknowledged',...(typed?['cleanedReuseAcknowledged']:[])]);demand(command.executionAcknowledged===true&&(!typed||command.cleanedReuseAcknowledged===true),'IMAGE_EXECUTION_APPROVAL_REQUIRED',403);
  const r=await journal.load(owner,documentId,command.permitId),p=r.proposal;checkMode(p);demand(command.proposalSha256===digest(p),'IMAGE_PERMIT_INVALID');
  if(r.approval)return view(r);demand(!r.cancel&&!r.consumed&&clock()<p.expiresAt,'IMAGE_PERMIT_UNAVAILABLE');
  return withInputs(owner,documentId,p.expected,async(b,revalidate)=>{
   checkBinding(p,b);const {readiness}=await inspect(b,p.outputDirectory);demand(readiness.fingerprint===p.readinessFingerprint,'IMAGE_PREFLIGHT_CHANGED');await revalidate();
   try{await journal.append(p.permitId,'approval',entry(p,{kind:approvalKind,sessionScope:reviewStore.scope(owner),executionAcknowledged:true,maximumExecutions:1,...(typed?{executionMode,cleanedReuseAcknowledged:true,sourcePermitId:p.sourceCleaned.sourcePermitId,cleanedSha256:p.sourceCleaned.cleanedSha256}:{} )}));}catch(e){if(e.code!=='EEXIST')throw e;}
   return get(owner,documentId,p.permitId);
  });
 }
 async function start(owner,documentId,command){
  exact(command,['permitId']);demand(!closing,'IMAGE_CONTROLLER_CLOSED',503);const r=await journal.load(owner,documentId,command.permitId),p=r.proposal;checkMode(p);
  if(r.consumed||r.cancel||r.outcome||active.has(p.permitId))return get(owner,documentId,p.permitId);
  demand(r.approval?.kind===approvalKind&&r.approval.executionAcknowledged===true&&(!typed||r.approval.cleanedReuseAcknowledged===true),'IMAGE_EXECUTION_APPROVAL_REQUIRED',403);demand(clock()<p.expiresAt,'IMAGE_PERMIT_EXPIRED');
  // Validate before acknowledging dispatch. Start still consumes exclusively before any image code.
  let announce,rejectStart;const started=new Promise((resolve,reject)=>{announce=resolve;rejectStart=reject;});
  const abort=new AbortController(),task={abort,promise:null};active.set(p.permitId,task);
  task.promise=(async()=>{
   let consumed=false,publishing=false,lockOwned=false,cleanupConfirmed=true,completedReceipt;
   try{
    await withInputs(owner,documentId,p.expected,async(b,revalidateRevision)=>{
     checkBinding(p,b);const {inputs,readiness}=await inspect(b,p.outputDirectory,'full',abort.signal);demand(readiness.fingerprint===p.readinessFingerprint,'IMAGE_PREFLIGHT_CHANGED');
     const revalidate=async(phase,{ownedRootPid}={})=>{
      abort.signal.throwIfAborted();await revalidateRevision();const latest=await journal.load(owner,documentId,p.permitId);checkBinding(latest.proposal,b);
      demand(!latest.cancel&&latest.approval&&digest(latest.approval)===digest(r.approval)&&!latest.outcome,'IMAGE_PERMIT_REVOKED');
      if(consumed)demand(!!latest.consumed,'IMAGE_PERMIT_CORRUPT',503);
      const monitor=await preflight({binding:b,inputs,outputDirectory:p.outputDirectory,mode:'monitor',phase,readiness,permitId:p.permitId,ownedRootPid});
      demand(monitor?.status==='READY'&&monitor.fingerprint===p.readinessFingerprint,'IMAGE_PREFLIGHT_CHANGED');abort.signal.throwIfAborted();
     };
     await revalidate('before-consume');
     await journal.append(p.permitId,'consumed',entry(p,{executionGeneration:p.executionGeneration,executionCount:1}));consumed=true;announce(await get(owner,documentId,p.permitId));
     // No recursive mkdir: a result collision stops before any model or renderer.
     await regularDirectory(outputRoot);await fs.mkdir(path.join(outputRoot,'.image-execution-lock'));lockOwned=true;
     await writeExclusive(path.join(outputRoot,'.image-execution-lock','owner.json'),JSON.stringify({permitId:p.permitId,executionGeneration:p.executionGeneration,pid:process.pid}));
     await fs.mkdir(p.outputDirectory);await regularDirectory(p.outputDirectory);
     await revalidate('before-pipeline');cleanupConfirmed=false;let result;try{result=await runPipeline({binding:b,inputs,permit:p,outputDirectory:p.outputDirectory,signal:abort.signal,revalidate});cleanupConfirmed=result?.cleanupConfirmed===true;}catch(e){cleanupConfirmed=e.cleanupConfirmed===true;throw e;}
     demand(cleanupConfirmed,'IMAGE_CLEANUP_UNKNOWN',503);await revalidate('before-result');
     if(typed)demand(result.report?.executionMode==='TYPESETTING_ONLY'&&['ocr','gemma','lama','maskModel'].every(k=>result.report.actualCalls?.[k]===0),'TYPESETTING_ONLY_AI_CALL_FORBIDDEN',503);
     publishing=true;demand(Buffer.isBuffer(result.pngBytes)&&result.pngBytes.length>0&&result.pngBytes.length<=32*1024*1024,'IMAGE_RESULT_INVALID');
     await writeExclusive(path.join(p.outputDirectory,'final.png'),result.pngBytes);const reopened=await readBounded(path.join(p.outputDirectory,'final.png'),32*1024*1024);
     demand(digest(reopened)===digest(result.pngBytes),'IMAGE_RESULT_HASH');const dimensions=await verifyOutput(reopened,inputs);
     await writeExclusive(path.join(p.outputDirectory,'report.json'),JSON.stringify(result.report));await revalidate('before-receipt');
     const receipt={version:1,permitId:p.permitId,executionGeneration:p.executionGeneration,sourceProcessingGeneration:b.sourceProcessingGeneration,
      binding:bound(b),outputDirectory:p.outputDirectory,file:'final.png',sha256:digest(reopened),bytes:reopened.length,dimensions,
      reportSha256:digest(await readBounded(path.join(p.outputDirectory,'report.json'))),userTranslations:13,ocrReused:13,
      semanticWarnings:inputs.lines.flatMap(l=>l.riskSignals).length,ocrCalls:0,gemmaCalls:0,cleanupConfirmed:true,independentSemanticVerification:null,humanImageQuality:'NOT_REVIEWED',...(typed?{executionMode,sourceCleaned:structuredClone(p.sourceCleaned),lamaCalls:0,maskModelCalls:0}:{})};
     await journal.append(p.permitId,'result-receipt',entry(p,{result:receipt}));const receiptBytes=await readBounded(path.join(journal.directory(p.permitId),'result-receipt.json'));
     await writeExclusive(path.join(p.outputDirectory,'receipt.json'),receiptBytes);demand(digest(await readBounded(path.join(p.outputDirectory,'receipt.json')))===digest(receiptBytes),'IMAGE_RESULT_HASH');
     await revalidate('before-outcome');completedReceipt=receipt;
    });
    // This is the completion linearization point. Later cancellation waits for its durable outcome.
    task.finalizing=true;demand(!task.cancelRequested&&!abort.signal.aborted,'IMAGE_PERMIT_REVOKED');
    demand(!(await journal.load(owner,documentId,p.permitId)).cancel,'IMAGE_PERMIT_REVOKED');
    await journal.append(p.permitId,'outcome',entry(p,{state:'SUCCEEDED',result:completedReceipt}));
   }catch(error){
    if(!consumed)rejectStart(error);
    else {const cancelled=abort.signal.aborted||error.code==='CANCELLED';const uncertain=publishing||!cleanupConfirmed||['IMAGE_CLEANUP_UNKNOWN','CLEANUP_FAILED','IMAGE_RUNTIME_UNKNOWN'].includes(error.code);
     try{await journal.append(p.permitId,'outcome',entry(p,{state:uncertain?'RESULT_UNKNOWN':cancelled?'CANCELLED':'FAILED',errorCode:/^[A-Z_]{1,80}$/.test(error.code??'')?error.code:'IMAGE_EXECUTION_FAILED',result:null}));}catch{/* Consumption remains authoritative; missing outcome means unknown. */}}
   }finally{if(lockOwned&&cleanupConfirmed){try{const lock=JSON.parse(await readBounded(path.join(outputRoot,'.image-execution-lock','owner.json')));if(lock.permitId===p.permitId&&lock.pid===process.pid){await fs.unlink(path.join(outputRoot,'.image-execution-lock','owner.json'));await fs.rmdir(path.join(outputRoot,'.image-execution-lock'));}}catch{/* An unresolved lock remains a fail-closed restart blocker. */}}active.delete(p.permitId);}
  })();
  return started;
 }
 async function cancel(owner,documentId,id){const r=await journal.load(owner,documentId,id);checkMode(r.proposal);if(r.outcome)return get(owner,documentId,id);const running=active.get(id);if(running?.finalizing){await running.promise;return get(owner,documentId,id);}if(running)running.cancelRequested=true;
  if(!r.cancel)try{await journal.append(id,'cancel',entry(r.proposal,{kind:'USER_CANCELLED'}));}catch(e){if(e.code!=='EEXIST')throw e;}running?.abort.abort();return get(owner,documentId,id);}
 return {prepare,approve,start,get,cancel,async settle(id){await active.get(id)?.promise;},async close(){closing=true;for(const t of active.values())t.abort.abort();await Promise.allSettled([...active.values()].map(t=>t.promise));}};
}
