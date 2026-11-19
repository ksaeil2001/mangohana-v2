import { blockVisualSignature, DEFAULT_ENGINE_ENDPOINT, isStudioId, readEngineReview, readEngineOutcome, validateBlocks, type StudioPage, type EngineOutcome } from "./studio-model";
export { DEFAULT_ENGINE_ENDPOINT } from "./studio-model";
export class TerminalJobError extends Error { terminal=true;retryableJob=false;outcome?:EngineOutcome; }
function unconfirmedJob(cause?:unknown) {
  const detail=cause instanceof Error ? ' '+cause.message.slice(0,240) : '';
  const error=new TerminalJobError('실행 결과를 확인하지 못했어요. 같은 작품·페이지의 기존 요청을 조회해 주세요.'+detail);
  error.terminal=false;error.outcome='RESULT_UNKNOWN';return error;
}
export function endpointURL(value:string) {
  if(!value.trim()||value===DEFAULT_ENGINE_ENDPOINT)return DEFAULT_ENGINE_ENDPOINT;
  const url=new URL(value);
  if(url.username||url.password||url.search||url.hash)throw new Error("인증 정보와 쿼리 없이 엔진의 기본 주소를 입력해 주세요.");
  if(url.protocol!=="https:")throw new Error("엔진 주소는 HTTPS로 입력해 주세요.");
  return url.href.replace(/\/$/,"");
}
export const RETIRED_JOB_NOTICE="이전 연결은 더 이상 사용할 수 없어요. ‘이전 결과로 편집’ 후 온라인 엔진으로 다시 처리해 주세요.";
export function localStudioEndpoint(page:Pick<StudioPage,'jobId'|'jobEndpoint'>):string|undefined {
  return !page.jobId||page.jobEndpoint===DEFAULT_ENGINE_ENDPOINT?DEFAULT_ENGINE_ENDPOINT:undefined;
}
export function canResumeJob(page:StudioPage|undefined):boolean {
  if(!page?.jobId||!page.jobEndpoint)return false;
  try{endpointURL(page.jobEndpoint);return true;}catch{return false;}
}
export function engineObject(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("엔진 응답이 올바른 JSON 객체가 아니에요.");
  return value as Record<string,unknown>;
}
async function jsonResponse(response:Response):Promise<Record<string,unknown>> {
  if(!response.ok)throw new Error(`엔진 응답 오류 (${response.status}). 연결 설정과 엔진 기록을 확인해 주세요.`);
  return engineObject(await response.json());
}
export async function checkEngine(endpoint:string,signal?:AbortSignal,request:typeof fetch=fetch) {
  const data=await jsonResponse(await request(endpointURL(endpoint)+"/health",{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)}));
  if(data.status!=="ok"&&data.status!=="healthy")throw new Error("엔진이 준비 상태를 응답하지 않았어요. 연결 규격을 확인해 주세요.");
  return data;
}
export type ProcessPageOptions={projectId?:string};
/** The same persisted page generation identifies retries even if the POST response was lost. */
async function requestKey(page:StudioPage,projectId:string):Promise<string>{
  const generation=page.engineGeneration??0;
  if(!isStudioId(page.id)||!isStudioId(projectId)||!Number.isSafeInteger(generation)||generation<0)throw new Error("페이지의 처리 요청 정보를 확인해 주세요.");
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([projectId,page.id,generation])));
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
}
function resultImage(value:unknown):string|undefined{
  if(value===undefined||value===null)return undefined;
  if(typeof value!=="string"||!/^data:image\/(png|jpeg|webp);base64,/.test(value))throw new Error("엔진 이미지는 PNG, JPG, WebP 데이터 형식이어야 해요.");
  return value;
}
export type PageEngineResult=Pick<StudioPage,'blocks'|'cleanImage'|'finalImage'|'finalImageSignature'|'engineReview'>;
export function validatePageEngineResult(value:unknown):PageEngineResult {
 const result=engineObject(value),blocks=validateBlocks(result.blocks),cleanImage=resultImage(result.clean_image),finalImage=resultImage(result.final_image);
 const soundEffects=result.evidence&&typeof result.evidence==='object'&&'sound_effects' in result.evidence?result.evidence.sound_effects:undefined;
 const engineReview=result.warnings===undefined&&soundEffects===undefined?undefined:readEngineReview({warnings:result.warnings??[],soundEffects});
 return {blocks,cleanImage,finalImage,finalImageSignature:finalImage?blockVisualSignature(blocks):undefined,...(engineReview?{engineReview}:{})};
}
export async function processPage(page:StudioPage,endpoint:string,source:string,target:string,signal:AbortSignal,onJob:(id:string)=>void|Promise<void>,onStage:(stage:string)=>void,options:ProcessPageOptions={}):Promise<PageEngineResult> {
  signal.throwIfAborted();
  const base=endpointURL(endpoint);
  let jobId=page.jobId;
  if(jobId&&!isStudioId(jobId))throw new Error("저장된 작업 ID가 올바르지 않아요. 엔진 기록을 확인해 주세요.");
  if(!jobId){
    // Establish the HttpOnly owner cookie before a POST whose response might be lost.
    if(base===DEFAULT_ENGINE_ENDPOINT)await checkEngine(base,signal);
    const image=await fetch(page.image,{signal});if(!image.ok)throw new Error(`원본 이미지를 읽지 못했어요 (${image.status}). 원본을 확인한 뒤 다시 시도해 주세요.`);
    const blob=await image.blob();const form=new FormData();form.append("file",blob,page.name);form.append("source_language",source);form.append("target_language",target);
    const projectId=options.projectId||page.id;
    form.append("project_id",projectId);form.append("page_id",page.id);form.append("idempotency_key",await requestKey(page,projectId));
    signal.throwIfAborted();
    onStage("작업 생성");
    let response:Response|undefined;
    try {
      response=await fetch(base+"/jobs",{method:"POST",body:form,signal:AbortSignal.timeout(30000)});
      const created=await jsonResponse(response);
      if(!isStudioId(created.id))throw new Error("엔진 작업 ID가 올바르지 않아요. 엔진 기록을 확인해 주세요.");
      jobId=created.id;await onJob(jobId!);
    } catch(error) {
      if(base===DEFAULT_ENGINE_ENDPOINT&&(!response||response.ok||response.status>=500))throw unconfirmedJob(error);
      throw error;
    }
  }
  const deadline=Date.now()+10*60*1000;
  while(Date.now()<deadline){
    signal.throwIfAborted();
    const data=await jsonResponse(await fetch(base+"/jobs/"+encodeURIComponent(jobId!),{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])}));
    signal.throwIfAborted();
    if(base===DEFAULT_ENGINE_ENDPOINT&&(data.id!==jobId||data.projectId!==(options.projectId||page.id)||data.pageId!==page.id))throw new Error('엔진 응답의 작품·페이지·작업 연결이 달라 이전 내용을 보존했어요.');
    onStage(typeof data.stage==="string"?data.stage:"처리 중");
    if(data.status==="result_unknown"||data.reviewState==='RESULT_UNKNOWN')throw unconfirmedJob();
    if(data.status==="failed"){const error=new TerminalJobError(typeof data.error==="string"?data.error:"엔진에서 처리가 실패했어요.");error.outcome=readEngineOutcome(data.reviewState);error.retryableJob=base===DEFAULT_ENGINE_ENDPOINT&&(data.recovery as {manuallyRetryable?:boolean}|null)?.manuallyRetryable!==false;throw error;}
    if(data.status==="cancelled")throw new TerminalJobError("엔진에서 취소된 작업이에요.");
    if(data.status==="completed"){
      return validatePageEngineResult(data.result||data);
    }
    if(typeof data.status!=="string"||!["queued","processing","running"].includes(data.status))throw new Error("알 수 없는 작업 상태예요. 엔진의 응답 규격을 확인해 주세요.");
    await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},850);signal.addEventListener("abort",abort,{once:true});});
  }
  throw new Error("상태 조회 시간이 지났어요. 저장된 작업 ID로 다시 조회할 수 있어요.");
}
