import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,open,rmdir,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {atomicState} from './store.mjs';

const sha=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const counter=x=>Number.isSafeInteger(x)&&x>=0;
const identifier=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const text=x=>typeof x==='string'&&x.trim().length>0&&x.length<=4000&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(x);
const fail=(code,status=422,message='번역 적용 자료와 현재 페이지 상태를 확인해 주세요.')=>Object.assign(new Error(message),{code,status});
const must=(value,code='REVIEW_INPUT_INVALID',status=422)=>{if(!value)throw fail(code,status);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fields=['documentId','approvalToken','requestKey','expectedEditRevision','expectedContextRevision','sourceSha256','normalizedSha256','candidateSetSha256','selectedSetSha256','importAcknowledged','riskAcknowledged','regions'];
export const REVIEW_COMMAND_FIELDS=Object.freeze(fields);
const selectedHash=c=>sha(c.regions.map(r=>[r.regionId,r.selectedUserTranslation,r.selectionOrigin,r.editRevision]));
const sourceBindings=c=>({packetSha256:c.packetSha256,sourceSha256:c.sourceSha256,normalizedSha256:c.normalizedSha256,candidateSetSha256:c.candidateSetSha256,translationInputSha256:c.translationInputSha256,sourceScope:c.sourceScope,processingGeneration:c.processingGeneration,sourceContextRevision:c.sourceContextRevision,sourceBaselineEditRevision:c.sourceBaselineEditRevision,regions:c.regions.map(r=>({regionId:r.regionId,rawOcr:r.rawOcr,sourceReading:r.sourceReading,originalAiTranslation:r.originalAiTranslation,sourceLineIds:r.sourceLineIds,bbox:r.bbox,riskSignals:r.riskSignals}))});
function catalogValid(c,id){
 must(c?.id===id&&identifier(id)&&['packetSha256','submissionSha256','sourceSha256','normalizedSha256','candidateSetSha256','translationInputSha256','selectedSetSha256'].every(k=>hex(c[k])),'REVIEW_SOURCE_CONFLICT',409);
 must(counter(c.processingGeneration)&&counter(c.sourceBaselineEditRevision)&&(c.sourceContextRevision===null||counter(c.sourceContextRevision))&&c.sourceScope&&hex(c.sourceScope.owner)&&identifier(c.sourceScope.projectId)&&identifier(c.sourceScope.pageId),'REVIEW_SOURCE_CONFLICT',409);
 must(Array.isArray(c.regions)&&c.regions.length>0&&c.regions.length<=128&&new Set(c.regions.map(r=>r.regionId)).size===c.regions.length,'REVIEW_SELECTION_INVALID');
 must(c.regions.every(r=>text(r.regionId)&&text(r.rawOcr)&&text(r.sourceReading)&&text(r.originalAiTranslation)&&text(r.selectedUserTranslation)&&['USER_EDIT','AI_SUGGESTION_ADOPTED','MODEL_CANDIDATE'].includes(r.selectionOrigin)&&counter(r.editRevision)&&Array.isArray(r.riskSignals)&&Array.isArray(r.sourceLineIds)),'REVIEW_SELECTION_INVALID');
 must(c.selectedSetSha256===selectedHash(c),'REVIEW_SOURCE_CONFLICT',409);
 must([c.sourceImage,c.normalizedImage].every(v=>typeof v==='string'&&v.startsWith('data:image/png;base64,')&&v.length<=12*1024*1024),'REVIEW_SOURCE_CONFLICT',409);
 return c;
}
async function regular(directory){const s=await lstat(directory);must(s.isDirectory()&&!s.isSymbolicLink()&&path.resolve(await realpath(directory)).toLowerCase()===directory.toLowerCase(),'REVIEW_STORE_CORRUPT',503);}
export async function readBounded(file,max=24*1024*1024){
 const s=await lstat(file);must(s.isFile()&&!s.isSymbolicLink()&&s.size>0&&s.size<=max,'REVIEW_STORE_CORRUPT',503);
 const handle=await open(file,'r');try{const a=await handle.stat();must(a.dev===s.dev&&a.ino===s.ino&&a.size===s.size,'REVIEW_STORE_CORRUPT',503);const bytes=await handle.readFile(),b=await handle.stat(),named=await lstat(file);must(bytes.length===s.size&&a.mtimeMs===b.mtimeMs&&a.ino===named.ino&&a.dev===named.dev&&!named.isSymbolicLink(),'REVIEW_STORE_CORRUPT',503);return bytes;}finally{await handle.close();}
}

/** Anonymous bearer sessions are explicit. Nothing in this module authenticates an account. */
export async function createReviewStore({root,loadCatalog,contextRevision,previewContextRevision=contextRevision,withContextRevision}){
 must(path.isAbsolute(root??'')&&typeof loadCatalog==='function'&&typeof contextRevision==='function'&&typeof previewContextRevision==='function'&&typeof withContextRevision==='function','REVIEW_STORE_CONFIG_INVALID',503);
 const directory=path.resolve(root);must(directory!==path.parse(directory).root,'REVIEW_STORE_CONFIG_INVALID',503);
 await mkdir(directory,{recursive:true});await regular(directory);
 const lease=path.join(directory,'.store-lock');try{await mkdir(lease);}catch(e){if(e.code==='EEXIST')throw fail('REVIEW_STORE_IN_USE',503,'다른 앱이 이 번역 저장소를 사용하고 있습니다. 기존 앱을 종료한 뒤 열어 주세요.');throw e;}
 try{
 const events=path.join(directory,'events');await mkdir(events,{recursive:true});await regular(events);
 const keyPath=path.join(directory,'approval-key.bin');
 try{const h=await open(keyPath,'wx',0o600);try{await h.writeFile(randomBytes(32));await h.sync();}finally{await h.close();}}catch(e){if(e.code!=='EEXIST')throw e;}
 const key=await readBounded(keyPath,32);must(key.length===32,'REVIEW_STORE_CORRUPT',503);
 const mac=x=>createHmac('sha256',key).update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
 const signatureValid=(x,signature)=>hex(signature)&&timingSafeEqual(Buffer.from(mac(x),'hex'),Buffer.from(signature,'hex'));
 const seal=x=>({...x,signature:mac(x)});
 const verify=x=>{must(x&&typeof x==='object','REVIEW_STORE_CORRUPT',503);const {signature,...unsigned}=x;must(signatureValid(unsigned,signature),'REVIEW_STORE_CORRUPT',503);return x;};
 const scope=owner=>{must(hex(owner),'REVIEW_SESSION_MISMATCH',403);return sha('mangohana-review-session-v1\0'+owner);};
 const target=(owner,id)=>{scope(owner);const documentId=sha('mangohana-review-page-v1\0'+owner+'\0'+id);return {documentId,projectId:'review-'+documentId.slice(0,24),pageId:'page-'+documentId.slice(0,24)};};
 let closed=false,chain=Promise.resolve(),closePromise;
 const available=()=>must(!closed,'REVIEW_STORE_CLOSED',503);
 const serial=work=>{const p=chain.then(work);chain=p.catch(()=>{});return p;};
 async function load(id){must(identifier(id),'REVIEW_SOURCE_CONFLICT',409);return catalogValid(await loadCatalog(id),id);}
 async function stored(owner,id){
  must(hex(id),'REVIEW_PAGE_NOT_FOUND',404);await regular(directory);
  let d;try{d=verify(JSON.parse(await readBounded(path.join(directory,id+'.json'))));}catch(e){if(e.code==='ENOENT')return null;if(e.code==='REVIEW_STORE_CORRUPT')throw e;throw fail('REVIEW_STORE_CORRUPT',503);}
  must(d.owner===owner&&d.documentId===id,'REVIEW_PAGE_NOT_FOUND',404);
  must(d.version===1&&counter(d.editRevision)&&d.editRevision>0&&Array.isArray(d.regions)&&hex(d.receipt?.eventSha256),'REVIEW_STORE_CORRUPT',503);
  const {eventSha256,...event}=d.receipt;verify(event);must(sha(event)===eventSha256,'REVIEW_STORE_CORRUPT',503);
  await regular(events);let persisted;try{persisted=JSON.parse(await readBounded(path.join(events,eventSha256+'.json')));}catch{throw fail('REVIEW_STORE_CORRUPT',503);}
  must(same(persisted,event),'REVIEW_STORE_CORRUPT',503);return d;
 }
 const view=d=>{const {owner:_owner,signature:_signature,normalizedImage:_normalizedImage,...out}=d;return structuredClone(out);};
 function tokenFor(claims){const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');return payload+'.'+mac(payload);}
 function claimsFor(token){
  must(typeof token==='string'&&token.length<8000,'REVIEW_APPROVAL_REQUIRED',403);const parts=token.split('.');must(parts.length===2&&signatureValid(parts[0],parts[1]),'REVIEW_APPROVAL_REQUIRED',403);
  try{return JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));}catch{throw fail('REVIEW_APPROVAL_REQUIRED',403);}
 }
 async function locked(action){available();return serial(async()=>{
  available();await regular(directory);const lock=path.join(directory,'.writer-lock');try{await mkdir(lock);}catch(e){if(e.code==='EEXIST')throw fail('REVIEW_WRITE_BUSY',409,'다른 창에서 번역을 저장하고 있어요. 같은 요청으로 상태를 확인해 주세요.');throw e;}
  try{return await action();}finally{await rmdir(lock);}
 });}
 async function currentContext(owner,project,read=contextRevision){const rev=await read(owner,project);must(counter(rev),'REVIEW_CONTEXT_UNAVAILABLE',503);return rev;}
 return {
  scope,
  async preview(owner,id){
   available();const c=await load(id),t=target(owner,id),d=await stored(owner,t.documentId);
   if(d)must(same(d.sourceBindings,sourceBindings(c)),'REVIEW_SOURCE_CONFLICT',409);
   const revision=d?.editRevision??0,context=await currentContext(owner,t.projectId,previewContextRevision),requestKey=randomUUID();
   const claims={version:1,owner,catalogId:id,...t,editRevision:revision,contextRevision:context,sourceBindingsSha256:sha(sourceBindings(c)),selectedSetSha256:c.selectedSetSha256,submissionSha256:c.submissionSha256,requestKey,expiresAt:Date.now()+30*60*1000};
   return {catalogId:id,sessionScope:scope(owner),authenticationLevel:'ANONYMOUS_SESSION',accountAuth:'NOT_AVAILABLE',target:{...t,editRevision:revision,contextRevision:context},sourceSha256:c.sourceSha256,normalizedSha256:c.normalizedSha256,candidateSetSha256:c.candidateSetSha256,selectedSetSha256:c.selectedSetSha256,sourceProvenance:{scope:c.sourceScope,processingGeneration:c.processingGeneration,contextRevision:c.sourceContextRevision,baselineEditRevision:c.sourceBaselineEditRevision},sourceImage:c.sourceImage,regions:structuredClone(c.regions),approvalToken:tokenFor(claims),requestKey,importRequired:!d,document:d?view(d):null,executionAuthorized:false,independentSemanticVerification:null};
  },
  async get(owner,id){available();scope(owner);const d=await stored(owner,id);must(d,'REVIEW_PAGE_NOT_FOUND',404);return {document:view(d)};},
  // Server-only seam. The HTTP principal owns the target; imported OCR keeps its original owner.
  // No application, checkpoint or execution permit is written by an input inspection.
  async withEngineInputs(owner,id,expected,inspect){
   available();scope(owner);
   must(expected&&typeof expected==='object'&&Object.keys(expected).length===4&&
    ['expectedEditRevision','expectedContextRevision','eventSha256','selectedSetSha256'].every(k=>Object.hasOwn(expected,k))&&
    counter(expected.expectedEditRevision)&&counter(expected.expectedContextRevision)&&hex(expected.eventSha256)&&hex(expected.selectedSetSha256)&&typeof inspect==='function');
   return locked(async()=>{
    const d=await stored(owner,id);must(d,'REVIEW_PAGE_NOT_FOUND',404);
    const c=await load(d.catalogId),t=target(owner,d.catalogId),r=d.receipt;
    must(same(t,{documentId:d.documentId,projectId:d.projectId,pageId:d.pageId}),'REVIEW_SOURCE_CONFLICT',409);
    must(d.editRevision===expected.expectedEditRevision&&d.contextRevision===expected.expectedContextRevision&&
     r.eventSha256===expected.eventSha256&&r.selectedSetSha256===expected.selectedSetSha256,'REVIEW_REVISION_CONFLICT',409);
    must(r.kind==='USER_TRANSLATION_IMPORT_AND_APPLICATION'&&r.issuer==='SERVER_ANONYMOUS_SESSION'&&r.authenticationLevel==='ANONYMOUS_SESSION'&&r.accountAuth==='NOT_AVAILABLE'&&r.sessionScope===scope(owner),'REVIEW_SESSION_MISMATCH',403);
    must(['documentId','projectId','pageId','editRevision','contextRevision'].every(k=>r[k]===d[k])&&r.baseEditRevision===0&&
     r.packetSha256===c.packetSha256&&r.submissionSha256===c.submissionSha256&&r.selectedSetSha256===c.selectedSetSha256&&
     r.sourceBindingsSha256===sha(sourceBindings(c))&&same(d.sourceBindings,sourceBindings(c)),'REVIEW_SOURCE_CONFLICT',409);
    must(same(r.userAcknowledgement,{explicitImport:true,allSelectedTranslations:true,risksAcceptedForApplication:true,independentMeaningClaimed:false})&&
     r.independentGroundTruthVerified===false&&r.executionAuthorized===false&&d.executionAuthorized===false&&d.independentSemanticVerification===null,'REVIEW_APPROVAL_REQUIRED',403);
    must(same(d.sourceProvenance,{scope:c.sourceScope,packetSha256:c.packetSha256,submissionSha256:c.submissionSha256,originalCheckpointSha256:c.originalCheckpointSha256??null,sourceBaselineEditRevision:c.sourceBaselineEditRevision,sourceContextRevision:c.sourceContextRevision})&&
     d.processingGeneration===c.processingGeneration&&d.sourceImage===c.sourceImage&&d.normalizedImage===c.normalizedImage,'REVIEW_SOURCE_CONFLICT',409);
    must(same(d.regions,c.regions.map(row=>({...structuredClone(row),userAcknowledgement:{source:'APP_SESSION_BUTTON',selectionReviewed:true,risksAcceptedForApplication:true,meaningIndependentlyVerified:false},independentSemanticVerification:null})))&&selectedHash(d)===c.selectedSetSha256,'REVIEW_SELECTION_INVALID');
    must(await currentContext(owner,d.projectId)===d.contextRevision,'REVIEW_REVISION_CONFLICT',409);
    const documentSha256=sha(await readBounded(path.join(directory,id+'.json')));
    return withContextRevision(owner,d.projectId,d.contextRevision,async(revalidateContext)=>{
     const binding={version:'saved-imported-page-input-v1',current:{ownerScope:owner,projectId:d.projectId,pageId:d.pageId,pageNumber:c.sourceScope.pageNumber,
      sourceSha256:c.sourceSha256,normalizedSha256:c.normalizedSha256,candidateSetSha256:c.candidateSetSha256,editRevision:d.editRevision,contextRevision:d.contextRevision,processingGeneration:null},
      sourceProvenance:structuredClone(d.sourceProvenance),sourceProcessingGeneration:d.processingGeneration,documentId:id,documentSha256,
      receipt:structuredClone(r),regions:structuredClone(d.regions),sourceImage:d.sourceImage,normalizedImage:d.normalizedImage,
      authenticationLevel:'ANONYMOUS_SESSION',accountAuth:'NOT_AVAILABLE',executionAuthorized:false,independentSemanticVerification:null};
     const revalidate=async()=>{
      if(typeof revalidateContext==='function')await revalidateContext();else must(await currentContext(owner,d.projectId)===d.contextRevision,'REVIEW_REVISION_CONFLICT',409);
      const latest=await stored(owner,id);must(same(d,latest)&&documentSha256===sha(await readBounded(path.join(directory,id+'.json'))),'REVIEW_REVISION_CONFLICT',409);
      must(same(c,await load(d.catalogId)),'REVIEW_SOURCE_CONFLICT',409);
     };
     const result=await inspect(binding,revalidate);await revalidate();
     return result;
    });
   });
  },
  async apply(owner,id,command){
   available();scope(owner);
   must(command&&typeof command==='object'&&!Array.isArray(command)&&Object.keys(command).length===fields.length&&Object.keys(command).every(k=>fields.includes(k)));
   const claims=claimsFor(command.approvalToken);
   must(claims.owner===owner,'REVIEW_SESSION_MISMATCH',403);must(claims.catalogId===id,'REVIEW_SOURCE_CONFLICT',409);
   const t=target(owner,id);must(command.documentId===t.documentId&&claims.documentId===t.documentId,'REVIEW_PAGE_NOT_FOUND',404);
   must(command.importAcknowledged===true&&command.riskAcknowledged===true,'REVIEW_APPROVAL_REQUIRED',403);
   const commandSha256=sha(command);
   return locked(async()=>{
    let before=await stored(owner,t.documentId);
    if(before?.receipt.requestKey===command.requestKey){must(before.receipt.commandSha256===commandSha256,'REVIEW_IDEMPOTENCY_CONFLICT',409);return {document:view(before),duplicate:true};}
    must(claims.version===1&&claims.requestKey===command.requestKey&&typeof command.requestKey==='string'&&claims.expiresAt>Date.now(),'REVIEW_APPROVAL_REQUIRED',403);
    const c=await load(id);
    must(claims.sourceBindingsSha256===sha(sourceBindings(c))&&claims.selectedSetSha256===c.selectedSetSha256&&claims.submissionSha256===c.submissionSha256,'REVIEW_SOURCE_CONFLICT',409);
    for(const k of ['sourceSha256','normalizedSha256','candidateSetSha256','selectedSetSha256'])must(command[k]===c[k],'REVIEW_SOURCE_CONFLICT',409);
    must(Array.isArray(command.regions)&&command.regions.length===c.regions.length&&new Set(command.regions.map(r=>r?.regionId)).size===c.regions.length,'REVIEW_SELECTION_INVALID');
    for(const r of c.regions){const row=command.regions.find(v=>v?.regionId===r.regionId);must(row&&Object.keys(row).length===2&&Object.keys(row).every(k=>['regionId','selectedTranslation'].includes(k))&&row.selectedTranslation===r.selectedUserTranslation,'REVIEW_SELECTION_INVALID');}
    must(counter(command.expectedEditRevision)&&command.expectedEditRevision===claims.editRevision&&claims.editRevision===(before?.editRevision??0),'REVIEW_REVISION_CONFLICT',409);
    must(counter(command.expectedContextRevision)&&command.expectedContextRevision===claims.contextRevision&&claims.contextRevision===await currentContext(owner,t.projectId),'REVIEW_REVISION_CONFLICT',409);
    if(before){
     must(same(before.sourceBindings,sourceBindings(c)),'REVIEW_SOURCE_CONFLICT',409);
     must(before.regions.every(r=>r.selectedUserTranslation===c.regions.find(v=>v.regionId===r.regionId)?.selectedUserTranslation),'REVIEW_USER_TRANSLATION_CONFLICT',409);
     return {document:view(before),duplicate:true};
    }
    // Context writes share this critical section; a browser revision can never substitute for it.
    const latestContext=await currentContext(owner,t.projectId);must(latestContext===claims.contextRevision,'REVIEW_REVISION_CONFLICT',409);
    return withContextRevision(owner,t.projectId,claims.contextRevision,async()=>{
     const latest=await stored(owner,t.documentId);must(!latest,'REVIEW_REVISION_CONFLICT',409);
     const fresh=await load(id);must(same(c,fresh),'REVIEW_SOURCE_CONFLICT',409);
     const approvedAt=new Date().toISOString();
     const event=seal({version:1,kind:'USER_TRANSLATION_IMPORT_AND_APPLICATION',issuer:'SERVER_ANONYMOUS_SESSION',authenticationLevel:'ANONYMOUS_SESSION',accountAuth:'NOT_AVAILABLE',sessionScope:scope(owner),requestKey:command.requestKey,commandSha256,documentId:t.documentId,projectId:t.projectId,pageId:t.pageId,baseEditRevision:0,editRevision:1,contextRevision:claims.contextRevision,packetSha256:c.packetSha256,submissionSha256:c.submissionSha256,selectedSetSha256:c.selectedSetSha256,sourceBindingsSha256:sha(sourceBindings(c)),approvedAt,userAcknowledgement:{explicitImport:true,allSelectedTranslations:true,risksAcceptedForApplication:true,independentMeaningClaimed:false},independentGroundTruthVerified:false,executionAuthorized:false});
     const eventSha256=sha(event),receipt={...event,eventSha256};
     const document=seal({version:1,...t,owner,catalogId:id,editRevision:1,contextRevision:claims.contextRevision,processingGeneration:c.processingGeneration,sourceBindings:sourceBindings(c),sourceProvenance:{scope:c.sourceScope,packetSha256:c.packetSha256,submissionSha256:c.submissionSha256,originalCheckpointSha256:c.originalCheckpointSha256??null,sourceBaselineEditRevision:c.sourceBaselineEditRevision,sourceContextRevision:c.sourceContextRevision},sourceImage:c.sourceImage,normalizedImage:c.normalizedImage,regions:c.regions.map(r=>({...structuredClone(r),userAcknowledgement:{source:'APP_SESSION_BUTTON',selectionReviewed:true,risksAcceptedForApplication:true,meaningIndependentlyVerified:false},independentSemanticVerification:null})),receipt,executionAuthorized:false,independentSemanticVerification:null,createdAt:approvedAt});
     await regular(events);const h=await open(path.join(events,eventSha256+'.json'),'wx',0o600);try{await h.writeFile(JSON.stringify(event));await h.sync();}finally{await h.close();}
     // A prepared event alone is never a committed application. One rename commits all rows and receipt.
     try{await atomicState(directory,document,t.documentId+'.json');}catch(e){throw fail('REVIEW_COMMIT_UNKNOWN',503,'번역 저장 여부를 확인하지 못했어요. 같은 요청을 보존하고 저장 상태를 조회해 주세요.');}
     return {document:view(document),duplicate:false};
    });
   });
  },
  close(){return closePromise??=(async()=>{await chain;closed=true;await rmdir(lease);})();}
 };
 }catch(e){await rmdir(lease);throw e;}
}
