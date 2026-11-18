import path from 'node:path';
import {createContextStore} from './context.mjs';
import {createTranslationReviewStore,loadStage14ReviewCatalog} from './store.mjs';
import {createEngineServer} from './server.mjs';
import {createLayoutReviewService} from './layout-review-service.mjs';

/** Product entry for review storage. It imports no Electron, model or job runtime. */
export async function createReviewApplication({dataRoot,allowedOrigin,inspectImportedPage,imageControllerFactory,typesettingControllerFactory,readabilityReviewFactory,roiExpansionFactory}){
 const contextStore=await createContextStore({root:path.join(dataRoot,'contexts')});let reviewStore,server,imageController,typesettingController,layoutReview;
 try{
  reviewStore=await createTranslationReviewStore({root:path.join(dataRoot,'translation-reviews'),loadCatalog:loadStage14ReviewCatalog,
   contextRevision:async(owner,project)=>(await contextStore.snapshot(owner,project)).revision,
   previewContextRevision:(owner,project)=>contextStore.readRevision(owner,project),
   withContextRevision:(owner,project,revision,commit)=>contextStore.withRevision(owner,project,revision,commit)});
  const denied=()=>{throw Object.assign(Error('이미지 실행이 승인되지 않았습니다.'),{code:'IMAGE_EXECUTION_NOT_AUTHORIZED',status:423});};
  const readOnlyJobs={imageExecutionAuthorized:false,health:async()=>({ready:true,running:false,mode:'translation-review-only',imageExecutionAuthorized:false,accountAuth:'NOT_AVAILABLE'}),submit:denied,get:async()=>{throw Object.assign(Error('번역 저장 전용 세션입니다.'),{code:'JOB_NOT_FOUND',status:404});},getResult:denied};
  layoutReview=await createLayoutReviewService({root:path.join(dataRoot,'layout-reviews'),reviewStore,roiExpansionFactory});
  if(imageControllerFactory)imageController=await imageControllerFactory(layoutReview.executionStore());
  if(typesettingControllerFactory)typesettingController=await typesettingControllerFactory(layoutReview.executionStore(),layoutReview.roiExpansion);
  const readabilityReview=readabilityReviewFactory?await readabilityReviewFactory(layoutReview.executionStore()):undefined;
  server=createEngineServer({store:readOnlyJobs,reviewStore,contextStore,inspectImportedPage,imageController,typesettingController,layoutReview,readabilityReview,allowedOrigin});
  return {server,async close(){await Promise.all([imageController?.close(),typesettingController?.close(),layoutReview?.close()]);if(server.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await reviewStore.close();await contextStore.close();}};
 }catch(e){await imageController?.close();await typesettingController?.close();await layoutReview?.close();await reviewStore?.close();await contextStore.close();throw e;}
}
