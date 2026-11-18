import path from 'node:path';import {createHash} from 'node:crypto';import {createLayoutReviewStore} from './layout-review-store.mjs';import {createLayoutSourceLoader} from './layout-review-source.mjs';import {measureLayoutText} from './layout-text-measurement.mjs';
import {getAllSourcePreflight}from'./layout-source-preflight.mjs';
import {compareLayoutCandidates}from'./layout-candidate-comparison.mjs';
import {createRequire}from'node:module';const require=createRequire(import.meta.url),{normalizeManualEntries}=require('../../packages/ai-engine/quality/background-layout.cjs');
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex'),expected=d=>({expectedEditRevision:d.editRevision,expectedContextRevision:d.contextRevision,eventSha256:d.receipt.eventSha256,selectedSetSha256:d.receipt.selectedSetSha256});
const fail=code=>Object.assign(Error(code),{code,status:409});
export async function createLayoutReviewService({root,reviewStore,loadSource=createLayoutSourceLoader(),measureText=measureLayoutText,compareCandidates=compareLayoutCandidates,roiExpansionFactory}){
 let roiExpansion;const store=await createLayoutReviewStore({root,loadSource,measureText,resolveRoiExpansion:args=>{if(!roiExpansion)throw fail('ROI_APPROVAL_REQUIRED');return roiExpansion.resolveForLayout(args);}}),active=new Set();let closing=false;
 async function run(owner,id,guards,signal,work){if(closing)throw fail('LAYOUT_REVIEW_CLOSED');const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();const task=(async()=>{
  const d=(await reviewStore.get(owner,id)).document;
  const e=guards??expected(d);
  return reviewStore.withEngineInputs(owner,id,e,async(binding,revalidate)=>{controller.signal.throwIfAborted();const context=await loadSource(binding);await revalidate();const value=await work(binding,context,controller.signal,revalidate);await revalidate();controller.signal.throwIfAborted();return value;});
 })();const tracked={controller,promise:task};active.add(tracked);try{return await task;}finally{active.delete(tracked);signal?.removeEventListener('abort',abort);}}
 function split(body,extra){const keys=['expectedEditRevision','expectedContextRevision','eventSha256','selectedSetSha256',...extra];if(!body||Object.keys(body).length!==keys.length||Object.keys(body).some(k=>!keys.includes(k)))throw fail('LAYOUT_INPUT_INVALID');return {guards:Object.fromEntries(keys.slice(0,4).map(k=>[k,body[k]])),command:Object.fromEntries(extra.map(k=>[k,body[k]]))};}
 roiExpansion=roiExpansionFactory?await roiExpansionFactory({run,store,loadSource,measureText}):undefined;
 return {roiExpansion,
  get(owner,id,{signal}={}){return run(owner,id,null,signal,async(binding,context,s)=>{
   const layout=await store.get(binding,{context});let sourcePreflight;if(layout.roiExpansion){const resolved=await roiExpansion.resolveForLayout({binding,context,before:layout,entries:layout.entries,reference:layout.roiExpansion.receiptId,phase:layout.state==='DRAFT'?'approve':'execution'});context=resolved.context;sourcePreflight={status:resolved.validation.status,regions:resolved.validation.proposal.checks,blockers:[],layoutRevision:layout.layoutRevision,finalRaster:'PENDING'};}else sourcePreflight=await getAllSourcePreflight(context,layout,{measureText,signal:s});
   return{documentId:id,expected:expected((await reviewStore.get(owner,id)).document),width:context.width,height:context.height,regions:context.regions,automaticSourceChecks:context.automaticSourceChecks,sourcePreflight,preview:context.preview,layout,sourceReviewFingerprint:context.sourceReviewFingerprint,actualImageExecution:false};
  });},
  compare(owner,id,body,{signal}={}){
   const{guards,command}=split(body,['expectedLayoutRevision','requestKey','regionId',...(Object.hasOwn(body??{},'referenceEntry')?['referenceEntry']:[])]);
   if(!Number.isSafeInteger(command.expectedLayoutRevision)||command.expectedLayoutRevision<0||typeof command.regionId!=='string'||command.regionId.length>256||typeof command.requestKey!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(command.requestKey))throw fail('LAYOUT_INPUT_INVALID');
   return run(owner,id,guards,signal,async(binding,context,s)=>{
    const layout=await store.get(binding,{context});if(layout.layoutRevision!==command.expectedLayoutRevision)throw fail('LAYOUT_REVISION_CONFLICT');
    let referenceEntry;if(command.referenceEntry){if(command.referenceEntry.id!==command.regionId)throw fail('LAYOUT_REGION_MISMATCH');referenceEntry=normalizeManualEntries([command.referenceEntry,...layout.entries.filter(e=>e.id!==command.regionId)],context.regions,context.width,context.height)[0];}
    const result=await compareCandidates({context,layout,regionId:command.regionId,signal:s,referenceEntry},{measureText});
    if(sha(await store.get(binding,{context}))!==sha(layout))throw fail('LAYOUT_REVISION_CONFLICT');
    return{...result,layoutRevision:layout.layoutRevision,saved:false,approved:false,actualImageExecution:false};
   });
  },
  validate(owner,id,body,{signal}={}){const {guards,command}=split(body,['expectedLayoutRevision','requestKey','entries']);return run(owner,id,guards,signal,async(b,context,s)=>({...await store.validate(b,command,{context,signal:s}),protection:command.entries.map(e=>({id:e.id,...context.protectionRuns(e)}))}));},
  save(owner,id,body,{signal}={}){const {guards,command}=split(body,['expectedLayoutRevision','requestKey','entries']);return run(owner,id,guards,signal,(b,context,s)=>store.save(b,command,{context,signal:s}));},
  approve(owner,id,body,{signal}={}){const {guards,command}=split(body,['expectedLayoutRevision','requestKey','planSha256','reviewAcknowledged',...(Object.hasOwn(body??{},'expectedStandardReviewSha256')?['expectedStandardReviewSha256']:[])]);return run(owner,id,guards,signal,(b,context,s)=>store.approve(b,command,{context,signal:s}));},
  executionStore(){return {...reviewStore,withEngineInputs:(owner,id,e,inspect)=>reviewStore.withEngineInputs(owner,id,e,async(base,revalidateBase)=>{
   const layoutReview=await store.executionSnapshot(base),binding={...base,layoutReview};
   const revalidate=async()=>{await revalidateBase();if(sha(await store.executionSnapshot(base))!==sha(layoutReview))throw fail('LAYOUT_REVISION_CONFLICT');};
   const result=await inspect(binding,revalidate);await revalidate();return result;
  })};},
  async close(){closing=true;for(const task of active)task.controller.abort();await Promise.allSettled([...active].map(t=>t.promise));await roiExpansion?.close();await store.close();}
 };
}
