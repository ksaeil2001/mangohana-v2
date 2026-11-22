import {DEFAULT_ENGINE_ENDPOINT,isStudioId,validatePendingBatch,type PendingBatch,type Project,type StudioPage} from './studio-model';
import {checkEngine,endpointURL,engineObject,validatePageEngineResult,type PageEngineResult} from './studio-engine';

export type BatchJobBinding={pageId:string;jobId:string;pageNumber?:number;batchId?:string;sourceSha256?:string;batchKey?:string;generation?:number};
export type BatchCallbacks={onIntent:(intent:PendingBatch)=>void|Promise<void>;onJobs:(bindings:BatchJobBinding[])=>void|Promise<void>;onResult:(pageId:string,result:PageEngineResult)=>void|Promise<void>;onError:(pageId:string,error:Error,terminal:boolean,retryableJob:boolean)=>void;onStage:(pageId:string,stage:string)=>void;onObservation?:(pageId:string,job:Record<string,unknown>)=>void|Promise<void>};
export type BatchOptions={currentPageId?:()=>string|undefined;concurrency?:number;pollIntervalMs?:number;request?:typeof fetch;retrySaved?:boolean};
/** Explicit fresh/current processing keeps its single-job generation; saved local jobs only resume. */
export function getBatchRunTargets(pages:StudioPage[],scope:'all'|'current',endpoint:string):StudioPage[]{
 return pages.filter(page=>(scope==='all'||page.jobId||page.pendingBatch)&&endpointURL(page.pendingBatch?DEFAULT_ENGINE_ENDPOINT:page.jobId&&page.jobEndpoint?page.jobEndpoint:endpoint)===DEFAULT_ENGINE_ENDPOINT);
}
export class BatchPendingError extends Error {unknown=true;}
export class BatchProtocolError extends Error {}
class BatchPersistenceError extends Error {}
const idPattern=/^[A-Za-z0-9_-]{1,128}$/;
const statusSet=new Set(['queued','running','processing','completed','failed','cancelled','result_unknown']);
const retryAllowed=(job:Record<string,unknown>)=>!(job.recovery && typeof job.recovery==='object' && 'manuallyRetryable' in job.recovery && job.recovery.manuallyRetryable===false);
function protocol(condition:unknown,message='배치 페이지와 작업 연결 정보가 올바르지 않아요.'):asserts condition {if(!condition)throw new BatchProtocolError(message);}
const digest=async(bytes:BufferSource)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
const stableHash=(value:unknown)=>digest(new TextEncoder().encode(JSON.stringify(value)));
const pending=(error:unknown)=>error instanceof BatchPendingError?error:new BatchPendingError(error instanceof Error?error.message:'배치 접수 상태를 확인하지 못했어요. 이전 접수 정보는 보존했어요.');
async function responseData(response:Response){
 let body:Record<string,unknown>;try{body=engineObject(await response.json());}catch{throw new BatchProtocolError('배치 응답의 JSON 형식을 확인해 주세요.');}
 if(!response.ok)throw new BatchPendingError(typeof body.error==='string'?body.error:'배치 접수 여부를 확인하지 못했어요. 새 작업을 만들지 않고 접수 정보를 보존했어요.');
 return body;
}
async function durable(operation:()=>void|Promise<void>){try{await operation();}catch{throw new BatchPersistenceError('접수 정보를 저장하지 못해 추가 요청을 중지했어요. 원본과 이전 내용을 보존해 주세요.');}}
function validateBindings(value:Record<string,unknown>,intent:PendingBatch):BatchJobBinding[]{
 protocol(isStudioId(value.id)&&value.projectId===intent.projectId&&value.sourceLanguage===intent.source&&value.totalPages===intent.members.length&&Array.isArray(value.pages)&&value.pages.length===intent.members.length);
 protocol(['queued','running','completed','partial','failed','result_unknown'].includes(String(value.status)));
 const seenPages=new Set<string>(),seenJobs=new Set<string>(),seenKeys=new Set<string>(),seenNumbers=new Set<number>();
 const result=(value.pages as unknown[]).map(raw=>{
  const page=engineObject(raw),index=intent.members.findIndex((_,index)=>page.key==='file:'+index),member=intent.members[index],job=engineObject(page.job);
  protocol(member&&page.pageId===member.pageId&&page.name===member.name&&page.sourceSha256===member.sourceSha256&&isStudioId(page.jobId)&&!seenJobs.has(page.jobId)&&!seenPages.has(member.pageId)&&!seenKeys.has(String(page.key)));
  protocol(Number.isSafeInteger(page.pageNumber)&&(page.pageNumber as number)>0&&(page.pageNumber as number)<=100000&&!seenNumbers.has(page.pageNumber as number)&&(member.pageNumber===undefined||page.pageNumber===member.pageNumber));
  protocol(job.id===page.jobId&&job.pageId===member.pageId&&job.projectId===intent.projectId&&job.pageNumber===page.pageNumber&&statusSet.has(String(job.status))&&page.status===job.status);
  seenPages.add(member.pageId);seenJobs.add(page.jobId as string);seenKeys.add(String(page.key));seenNumbers.add(page.pageNumber as number);
  return {pageId:member.pageId,jobId:page.jobId as string,pageNumber:page.pageNumber as number,batchId:value.id as string,sourceSha256:member.sourceSha256,batchKey:intent.key,generation:member.generation};
 });
 protocol(intent.members.every(member=>seenPages.has(member.pageId)));return result;
}
function validateJob(value:Record<string,unknown>,projectId:string,pageId:string,jobId?:string):BatchJobBinding {
 protocol(isStudioId(value.id)&&(!jobId||value.id===jobId)&&value.projectId===projectId&&value.pageId===pageId&&statusSet.has(String(value.status)));
 protocol(value.pageNumber==null||Number.isSafeInteger(value.pageNumber)&&(value.pageNumber as number)>0&&(value.pageNumber as number)<=100000,'서버 페이지 순서와 작업 연결을 확인해 주세요.');
 return {pageId,jobId:value.id as string,...(value.pageNumber==null?{}:{pageNumber:value.pageNumber as number})};
}
export async function requestPagePriority(projectId:string,pageId:string,signal?:AbortSignal):Promise<void>{
 if(!idPattern.test(projectId)||!idPattern.test(pageId))throw new Error('읽기 페이지 식별자를 확인해 주세요.');
 const response=await fetch(DEFAULT_ENGINE_ENDPOINT+'/projects/'+encodeURIComponent(projectId)+'/priority',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({page_id:pageId}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
 const data=await responseData(response);protocol(data.projectId===projectId&&data.pageId===pageId);
}
export async function retrySavedPage(page:StudioPage,projectId:string,signal:AbortSignal,onJobs:(bindings:BatchJobBinding[])=>void|Promise<void>,canSubmit:()=>boolean=()=>true,request:typeof fetch=fetch):Promise<string>{
 signal.throwIfAborted();protocol(page.jobId&&isStudioId(page.jobId)&&idPattern.test(projectId));
 if(!canSubmit())throw new BatchPersistenceError('다른 접수 정보의 저장 실패로 새 재시도 요청을 중지했어요.');
 const key=await stableHash(['retry',projectId,page.id,page.jobId,page.engineGeneration??0]);signal.throwIfAborted();
 if(!canSubmit())throw new BatchPersistenceError('다른 접수 정보의 저장 실패로 새 재시도 요청을 중지했어요.');
 const response=await request(DEFAULT_ENGINE_ENDPOINT+'/jobs/'+encodeURIComponent(page.jobId!)+'/retry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idempotency_key:key}),signal:AbortSignal.timeout(30000)});
 const binding=validateJob(await responseData(response),projectId,page.id);await durable(()=>onJobs([binding]));signal.throwIfAborted();return binding.jobId;
}
function priorityOrder(project:Project,pages:StudioPage[],current?:string){
 const start=project.pages.findIndex(page=>page.id===current),priority=new Set(project.pages.slice(Math.max(0,start),Math.max(0,start)+3).map(page=>page.id));
 return [...pages.filter(page=>priority.has(page.id)),...pages.filter(page=>!priority.has(page.id))];
}
async function wait(milliseconds:number,signal:AbortSignal){
 signal.throwIfAborted();if(milliseconds<=0)return;
 await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},milliseconds);signal.addEventListener('abort',abort,{once:true});});
}
/** All source files are admitted once; observing jobs never owns the server queue lifetime. */
export async function processProjectBatch(project:Project,targets:StudioPage[],endpoint:string,source:string,target:string,signal:AbortSignal,callbacks:BatchCallbacks,options:BatchOptions={}){
 const request=options.request??fetch;
 signal.throwIfAborted();const base=endpointURL(endpoint);protocol(base===DEFAULT_ENGINE_ENDPOINT&&idPattern.test(project.id)&&['ja','auto'].includes(source)&&target==='ko');
 protocol(targets.length>0&&targets.length<=100&&new Set(targets.map(page=>page.id)).size===targets.length&&targets.every(page=>idPattern.test(page.id)&&project.pages.some(item=>item.id===page.id)));
 type BatchTask={page:StudioPage;jobId:string;batchId?:string;retryRequested:boolean;retried:boolean};
 const tasks=new Map<string,BatchTask>(targets.filter(page=>page.jobId).map(page=>[page.id,{page,jobId:page.jobId!,batchId:page.batchId,retryRequested:options.retrySaved!==false,retried:false}]));
 const outcomes=new Map<string,'completed'|'failed'|'paused'>(),groups=new Map<string,PendingBatch>(),fallbackBatches=new Set<string>();
 for(const page of targets)if(page.pendingBatch){const intent=validatePendingBatch(page.pendingBatch,project.id,page.id),previous=groups.get(intent.key);protocol(!previous||JSON.stringify(previous)===JSON.stringify(intent),'보관된 배치 멤버 연결 정보가 서로 달라요.');groups.set(intent.key,intent);}
 const fresh=targets.filter(page=>!page.jobId&&!page.pendingBatch),freshIntentKeys=new Set<string>();
 const accept=async(intent:PendingBatch,data:Record<string,unknown>)=>{
  // Validate every server mapping before excluding members deliberately detached from an older generation.
  const validated=validateBindings(data,intent),bindings=validated.filter(binding=>{
   const page=project.pages.find(page=>page.id===binding.pageId);if(!page||(page.engineGeneration??0)!==binding.generation)return false;
   const saved=page.pendingBatch?.members.find(member=>member.pageId===page.id);
   return page.pendingBatch?.key===intent.key&&saved?.generation===binding.generation&&saved?.sourceSha256===binding.sourceSha256||freshIntentKeys.has(intent.key)&&fresh.some(member=>member.id===page.id);
  });
  if(bindings.length)await durable(()=>callbacks.onJobs(bindings));
  for(const binding of bindings){const page=targets.find(page=>page.id===binding.pageId);if(page)tasks.set(page.id,{page,jobId:binding.jobId,batchId:binding.batchId,retryRequested:!!page.jobId&&options.retrySaved!==false,retried:false});}
  signal.throwIfAborted();
 };
 const reportPending=(intent:PendingBatch,error:unknown)=>{
  for(const member of intent.members){if(targets.some(page=>page.id===member.pageId)&&!tasks.has(member.pageId)){outcomes.set(member.pageId,'paused');callbacks.onError(member.pageId,pending(error),false,false);}}
 };
 const preparedBlobs=new Map<string,{blob:Blob;image:string;sha256:string}>();
 if(fresh.length){
  const health=await checkEngine(base,signal,request);if(health.batchSupported!==true)throw new BatchPendingError('서버의 여러 페이지 접수 기능이 아직 준비되지 않았어요. 이전 내용은 보존했어요.');
  const members:PendingBatch['members']=[];
  for(const page of fresh){
   signal.throwIfAborted();
   const image=await request(page.image,{signal});if(!image.ok)throw new BatchPendingError('원본 이미지를 읽지 못했어요.');
   const blob=await image.blob();if(!['image/png','image/jpeg','image/webp'].includes(blob.type)||!blob.size||blob.size>8*1024*1024)throw new BatchPendingError('PNG, JPG, WebP 이미지 한 장은 8MiB 이하여야 해요.');
   const sourceSha256=await digest(await blob.arrayBuffer());
   preparedBlobs.set(page.id,{blob,image:page.image,sha256:sourceSha256});
   members.push({pageId:page.id,...(page.enginePageNumber?{pageNumber:page.enginePageNumber}:{}),generation:page.engineGeneration??0,sourceSha256,name:page.name});
  }
  const key=await stableHash([project.id,source,target,members]);freshIntentKeys.add(key);groups.set(key,{key,projectId:project.id,source:source as 'ja'|'auto',target:'ko',phase:'prepared',members});
 }
 for(const original of groups.values()){
  signal.throwIfAborted();let intent=original;
  try{
   if(intent.phase==='sending'){
    const response=await request(base+'/batches/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:project.id,idempotency_key:intent.key}),signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
    await accept(intent,await responseData(response));continue;
   }
   const form=new FormData();let total=0;
   for(const member of intent.members){
    const page=project.pages.find(page=>page.id===member.pageId);if(!page||page.name!==member.name||(page.engineGeneration??0)!==member.generation)throw new BatchPendingError('이전 배치의 원본 또는 페이지 연결이 바뀌어 자동으로 다시 접수하지 않았어요.');
    const cached=preparedBlobs.get(member.pageId);
    let blob:Blob;
    if(cached&&cached.image===page.image&&cached.sha256===member.sourceSha256){
     blob=cached.blob;preparedBlobs.delete(member.pageId);
    }else{
     const image=await request(page.image,{signal});if(!image.ok)throw new BatchPendingError('이전 배치의 원본 이미지를 읽지 못했어요.');
     blob=await image.blob();
     if(!blob.size||blob.size>8*1024*1024||await digest(await blob.arrayBuffer())!==member.sourceSha256)throw new BatchPendingError('이전 배치와 원본 이미지가 달라 새 작업을 만들지 않았어요.');
    }
    total+=blob.size;
    if(!blob.size||blob.size>8*1024*1024||total>160*1024*1024)throw new BatchPendingError('이전 배치와 원본 이미지의 용량 한도를 확인해 주세요.');
    form.append('files',blob,member.name);
   }
   await durable(()=>callbacks.onIntent(intent));signal.throwIfAborted();
   intent={...intent,phase:'sending'};await durable(()=>callbacks.onIntent(intent));
   if(signal.aborted){await durable(()=>callbacks.onIntent({...intent,phase:'prepared'}));signal.throwIfAborted();}
   form.append('project_id',project.id);form.append('source_language',intent.source);form.append('target_language',intent.target);form.append('idempotency_key',intent.key);
   form.append('manifest',JSON.stringify(intent.members.map((member,index)=>({key:'file:'+index,page_id:member.pageId,...(member.pageNumber===undefined?{}:{page_number:member.pageNumber})}))));
   const current=options.currentPageId?.();if(current&&intent.members.some(member=>member.pageId===current))form.append('current_page_id',current);
   const response=await request(base+'/batches',{method:'POST',body:form,signal:AbortSignal.timeout(120000)});
   let body:Record<string,unknown>;
   try{body=engineObject(await response.json());}catch{
    if(!response.ok)throw new BatchPendingError('배치 접수 여부를 확인하지 못했어요. 새 작업을 만들지 않고 접수 정보를 보존했어요.');
    throw new BatchProtocolError('배치 응답의 JSON 형식을 확인해 주세요.');
   }
   if(!response.ok){
    // Server rejected pre-admission due to concurrent batch upload; revert to prepared with same key.
    if(response.status===429&&body.code==='BATCH_UPLOAD_BUSY'){
     const retryableIntent:PendingBatch={...intent,phase:'prepared'};
     await durable(()=>callbacks.onIntent(retryableIntent));
     intent=retryableIntent;
    }
    throw new BatchPendingError(typeof body.error==='string'&&body.error.trim()?body.error:'배치 접수 여부를 확인하지 못했어요. 새 작업을 만들지 않고 접수 정보를 보존했어요.');
   }
   await accept(intent,body);
  }catch(error){if(signal.aborted||error instanceof BatchProtocolError||error instanceof BatchPersistenceError)throw error;reportPending(intent,error);}
 }
 const concurrency=Math.max(1,Math.min(4,Math.trunc(options.concurrency??3))),deadline=Date.now()+60*60*1000;
 const fetchJobResult=async(jobId:string)=>{
  const response=await request(base+'/jobs/'+encodeURIComponent(jobId)+'/result',{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
  if(!response.ok&&[404,405,501].includes(response.status)){
   const fallback=await responseData(await request(base+'/jobs/'+encodeURIComponent(jobId),{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])}));
   return fallback.result;
  }
  return responseData(response);
 };
 const applyTerminalOrRetry=async(task:BatchTask,data:Record<string,unknown>,canSubmit:()=>boolean):Promise<'completed'|'handled'|'pending'>=>{
  const page=task.page;
  callbacks.onStage(page.id,typeof data.stage==='string'?data.stage:'처리 중');
  if(callbacks.onObservation)await durable(()=>callbacks.onObservation!(page.id,data));
  if(data.errorCode==='RETRY_COMMIT_UNKNOWN'||data.stage==='retry_acceptance_unknown'){
   callbacks.onError(page.id,new BatchPendingError('이전 재시도의 접수 저장을 확인하지 못했어요. 작업 ID를 보존했으며 새 작업을 자동으로 만들지 않아요.'),false,false);
   outcomes.set(page.id,'paused');tasks.delete(page.id);return 'handled';
  }
  let current=data;
  if(current.status==='failed'&&retryAllowed(current)&&task.retryRequested&&!task.retried){
   task.retried=true;
   task.jobId=await retrySavedPage({...page,jobId:task.jobId},project.id,signal,callbacks.onJobs,canSubmit,request);
   current=await responseData(await request(base+'/jobs/'+encodeURIComponent(task.jobId),{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])}));
   validateJob(current,project.id,page.id,task.jobId);signal.throwIfAborted();
   if(callbacks.onObservation)await durable(()=>callbacks.onObservation!(page.id,current));
  }
  if(current.status==='completed'){
   const rawResult=current.result!==undefined?current.result:await fetchJobResult(task.jobId);
   const result=validatePageEngineResult(rawResult);signal.throwIfAborted();
   await durable(()=>callbacks.onResult(page.id,result));outcomes.set(page.id,'completed');tasks.delete(page.id);return 'completed';
  }
  if(current.status==='cancelled'){callbacks.onError(page.id,new Error('서버에서 취소한 작업이에요. 기존 결과를 보존했어요.'),true,false);outcomes.set(page.id,'failed');tasks.delete(page.id);return 'handled';}
  if(current.status==='result_unknown'){callbacks.onError(page.id,new BatchPendingError('이 페이지의 실행 결과 또는 정산이 미확정이에요. 기존 작업 ID로 상태를 확인할 수 있어요.'),false,false);outcomes.set(page.id,'paused');tasks.delete(page.id);return 'handled';}
  if(current.status==='failed'){callbacks.onError(page.id,new Error(typeof current.error==='string'?current.error:'서버에서 이 페이지의 처리가 실패했어요.'),true,retryAllowed(current));outcomes.set(page.id,'failed');tasks.delete(page.id);return 'handled';}
  return 'pending';
 };
 while(tasks.size&&Date.now()<deadline){
  signal.throwIfAborted();
  let failedWorker=false;
  const batchGroups=new Map<string,BatchTask[]>(),individualTasks:BatchTask[]=[],completedTasks:BatchTask[]=[];
  for(const task of tasks.values()){
   if(task.batchId&&!fallbackBatches.has(task.batchId)){
    const group=batchGroups.get(task.batchId);
    if(group)group.push(task);else batchGroups.set(task.batchId,[task]);
   }else{
    individualTasks.push(task);
   }
  }
  for(const [batchId,groupTasks] of batchGroups){
   signal.throwIfAborted();
   try{
    const response=await request(base+'/batches/'+encodeURIComponent(batchId),{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
    if(!response.ok&&[404,405,501].includes(response.status)){fallbackBatches.add(batchId);individualTasks.push(...groupTasks);continue;}
    const batchData=await responseData(response);
    if(batchData.id!==batchId||batchData.projectId!==project.id||!Array.isArray(batchData.pages)){fallbackBatches.add(batchId);individualTasks.push(...groupTasks);continue;}
    const byPage=new Map<string,Record<string,unknown>>();
    let validEntries=true;
    for(const rawEntry of batchData.pages){
     if(!rawEntry||typeof rawEntry!=='object'||Array.isArray(rawEntry)){validEntries=false;break;}
     const entry=rawEntry as Record<string,unknown>;
     if(typeof entry.pageId!=='string'||!entry.job||typeof entry.job!=='object'||Array.isArray(entry.job)){validEntries=false;break;}
     byPage.set(entry.pageId,entry);
    }
    if(!validEntries||groupTasks.some(task=>!byPage.has(task.page.id))){fallbackBatches.add(batchId);individualTasks.push(...groupTasks);continue;}
    const orderedIds=new Set(priorityOrder(project,groupTasks.map(task=>task.page),options.currentPageId?.()).map(page=>page.id));
    const orderedTasks=[...orderedIds].map(id=>groupTasks.find(task=>task.page.id===id)!).filter(Boolean);
    for(const task of orderedTasks){
     const entry=byPage.get(task.page.id)!;
     const job=engineObject(entry.job);
     try{
      validateJob(job,project.id,task.page.id,job.id===task.jobId?task.jobId:undefined);
      if(typeof job.id==='string'&&job.id!==task.jobId){
       task.jobId=job.id;
       await durable(()=>callbacks.onJobs([{pageId:task.page.id,jobId:task.jobId,batchId,...(job.pageNumber==null?{}:{pageNumber:job.pageNumber as number})}]));
      }
      if(job.status==='completed'){
       callbacks.onStage(task.page.id,typeof job.stage==='string'?job.stage:'처리 중');
       if(callbacks.onObservation)await durable(()=>callbacks.onObservation!(task.page.id,job));
       completedTasks.push(task);
      }else{
       await applyTerminalOrRetry(task,job,()=>!failedWorker);
      }
     }catch(error){
      if(signal.aborted||error instanceof BatchPersistenceError){failedWorker=true;throw error;}
      callbacks.onError(task.page.id,pending(error),false,false);outcomes.set(task.page.id,'paused');tasks.delete(task.page.id);
     }
    }
   }catch(error){
    if(signal.aborted||error instanceof BatchPersistenceError)throw error;
    for(const task of groupTasks){
     if(!tasks.has(task.page.id))continue;
     callbacks.onError(task.page.id,pending(error),false,false);outcomes.set(task.page.id,'paused');tasks.delete(task.page.id);
    }
   }
  }
  if(completedTasks.length){
   const visitedCompleted=new Set<string>();
   const completedWorker=async()=>{
    while(true){
     signal.throwIfAborted();if(failedWorker)return;
     const nextPage=priorityOrder(project,completedTasks.map(task=>task.page).filter(page=>!visitedCompleted.has(page.id)),options.currentPageId?.())[0];
     if(!nextPage)return;visitedCompleted.add(nextPage.id);
     const task=completedTasks.find(item=>item.page.id===nextPage.id);if(!task||!tasks.has(task.page.id))continue;
     try{
      const rawResult=await fetchJobResult(task.jobId);
      const result=validatePageEngineResult(rawResult);signal.throwIfAborted();
      await durable(()=>callbacks.onResult(task.page.id,result));outcomes.set(task.page.id,'completed');tasks.delete(task.page.id);
     }catch(error){
      if(signal.aborted||error instanceof BatchPersistenceError){failedWorker=true;throw error;}
      callbacks.onError(task.page.id,pending(error),false,false);outcomes.set(task.page.id,'paused');tasks.delete(task.page.id);
     }
    }
   };
   const doneWorkers=await Promise.allSettled(Array.from({length:Math.min(concurrency,completedTasks.length)},completedWorker));
   const rejectedDone=doneWorkers.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(rejectedDone)throw rejectedDone.reason;
  }
  if(individualTasks.length){
   const visited=new Set<string>();
   const worker=async()=>{
    while(true){
     signal.throwIfAborted();if(failedWorker)return;const page=priorityOrder(project,individualTasks.map(task=>task.page).filter(page=>!visited.has(page.id)&&tasks.has(page.id)),options.currentPageId?.())[0];if(!page)return;visited.add(page.id);const task=tasks.get(page.id);if(!task)continue;
     try{
      const data=await responseData(await request(base+'/jobs/'+encodeURIComponent(task.jobId),{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])}));validateJob(data,project.id,page.id,task.jobId);signal.throwIfAborted();
      await applyTerminalOrRetry(task,data,()=>!failedWorker);
     }catch(error){if(signal.aborted||error instanceof BatchPersistenceError){failedWorker=true;throw error;}callbacks.onError(page.id,pending(error),false,false);outcomes.set(page.id,'paused');tasks.delete(page.id);}
    }
   };
   // Retry POSTs deliberately outlive observer abort. Drain their durable ID callbacks before the caller pauses pages.
   const workers=await Promise.allSettled(Array.from({length:Math.min(concurrency,individualTasks.length)},worker));
   const rejected=workers.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(rejected)throw rejected.reason;
  }
  if(tasks.size)await wait(options.pollIntervalMs??850,signal);
 }
 for(const [pageId]of tasks){callbacks.onError(pageId,new BatchPendingError('상태 조회 시간이 지나 작업 ID를 보존했어요. 조회를 재개할 수 있어요.'),false,false);outcomes.set(pageId,'paused');}
 return {completed:[...outcomes.values()].filter(value=>value==='completed').length,failed:[...outcomes.values()].filter(value=>value==='failed').length,paused:[...outcomes.values()].filter(value=>value==='paused').length};
}
