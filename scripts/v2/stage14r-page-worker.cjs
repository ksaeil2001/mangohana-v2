'use strict';
// Same product createEngine/createJobStore, isolated administrator inputs and output only.
const {app,protocol}=require('electron');
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {createHash}=require('node:crypto'),{pathToFileURL}=require('node:url');
const directory=process.argv[2],config=JSON.parse(fs.readFileSync(path.join(directory,'config.json'),'utf8'));
for(const key of ['userData','sessionData','temp','documents','home']){const p=path.join(config.profileRoot,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}
protocol.registerSchemesAsPrivileged([{scheme:'trio-resource',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.on('window-all-closed',()=>{});
const {createSpawnObserver}=require('../../apps/engine/verify-warm.cjs');
const sha=b=>createHash('sha256').update(b).digest('hex'),json=(n,v)=>fsp.writeFile(path.join(directory,n),JSON.stringify(v,null,2),{flag:'wx'});
let store,engine,observer,monitor,currentJob=null,phase='bootstrap',failure=null,rows=[],modelHttpRequests=0,actualHttpCalls=0;
const priorFetch=globalThis.fetch;globalThis.fetch=async(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.pathname==='/v1/chat/completions'&&init?.method==='POST')actualHttpCalls++;return priorFetch(input,init);};const started=performance.now();
async function main(){
 await app.whenReady();
 observer=createSpawnObserver({config,currentJob:()=>currentJob,onEvent:event=>fsp.appendFile(path.join(directory,'child-lifecycle.jsonl'),JSON.stringify(event)+'\n')});
 const {observe}=await import(pathToFileURL(path.join(__dirname,'stage14-observe.mjs')).href);
 let stopReason=null;
 monitor=await observe({directory,phase:()=>phase,onStop:code=>{stopReason??=code;void fsp.writeFile(path.join(directory,'STOP'),code,{flag:'wx'}).catch(()=>{});}});
 const {createEngine}=require(path.join(config.repository,'scripts/sites-local/engine.cjs'));
 const {createJobStore}=await import(pathToFileURL(path.resolve(__dirname,'../../apps/engine/store.mjs')).href);
 const actual=await createEngine(config);engine=actual;
 if(!actual.health().ready)throw Object.assign(Error('ENGINE_NOT_READY'),{code:'ENGINE_NOT_READY'});
 const wrapper={...actual,async run(args){currentJob=args.jobId;return actual.run({...args,onProgress:async update=>{
 phase=update.stage??phase;
 if(update.stage==='inpaint'){
  const translations=JSON.parse(await fsp.readFile(path.join(args.outputDirectory,'translations.json'),'utf8'));
  const flagged=translations.records.filter(r=>r.uncertain||r.semantic?.signals?.length).map(r=>({id:r.id,uncertain:r.uncertain,riskCodes:r.semantic?.signals?.map(s=>s.code)??[]}));
  await fsp.writeFile(path.join(args.outputDirectory,'stage14r-translation-gate.json'),JSON.stringify({version:1,status:flagged.length?'needs_review':'candidate_only',stage11StructuralValidation:true,regionIds:translations.lines.map(l=>l.id),flagged,automaticApproval:false,lamaStarted:false,humanSemanticVerified:null}),{flag:'wx'});
  if(flagged.length)throw Object.assign(Error('Explicit Stage14-R pre-LaMa review gate'),{code:'PAGE_TRANSLATION_INVALID'});
 }
 await args.onProgress?.(update);
 }});}};
 let previous=null;
 if(config.resumeStage14){
  previous=JSON.parse(await fsp.readFile(path.join(config.checkpointDirectory,'state.json'),'utf8'));
  const bytes=await fsp.readFile(path.join(config.checkpointDirectory,'checkpoint-ocr.json'));
  if(sha(bytes)!==previous.checkpoints?.ocr?.sha256)throw Object.assign(Error('CHECKPOINT_RECEIPT_MISMATCH'),{code:'CHECKPOINT_INVALID'});
  await fsp.mkdir(config.dataRoot,{recursive:true});const copy=path.join(config.dataRoot,previous.id);await fsp.cp(config.checkpointDirectory,copy,{recursive:true,errorOnExist:true,force:false});
  const saved=JSON.parse(bytes),{createCheckpointSession}=require('../../packages/ai-engine/quality/recovery-checkpoint.cjs');
  const loader=createCheckpointSession({directory:config.dataRoot,jobId:'stage14r-no-inference-preflight',scope:saved.scope,resumeFrom:{directory:copy,jobId:previous.id,checkpoints:previous.checkpoints}});
  const restored=await loader.load('ocr',saved.identity);if(!restored)throw Object.assign(Error('CHECKPOINT_PREFLIGHT_FAILED'),{code:'CHECKPOINT_INVALID'});
  await json('checkpoint-preflight.json',{sourceDirectory:config.checkpointDirectory,isolatedCopy:copy,sourceCheckpointSha256:sha(bytes),copiedCheckpointSha256:sha(await fsp.readFile(path.join(copy,'checkpoint-ocr.json'))),restoredRegions:restored.payload.extraction.speechBubbles.length,scope:saved.scope,identity:saved.identity,additionalOcrCalls:0,note:'Current engine must independently validate configuration; no identity re-signing or weakening.'});
 }
 store=await createJobStore({root:config.dataRoot,engine:wrapper});
 const owner=previous?.owner??sha(Buffer.from(directory)),inputs=JSON.parse(await fsp.readFile(path.join(directory,'inputs.json'),'utf8'));
 await json('runtime-before.json',{health:actual.health(),owner,model:config.gemmaModel,refineConnectedOcr:config.refineConnectedOcr,reuseOcrRuntime:config.reuseOcrRuntime,reuseTranslationServer:config.reuseTranslationServer,node:process.memoryUsage()});
 for(const input of inputs){
  const bytes=await fsp.readFile(input.copyPath);if(sha(bytes)!==input.sha256)throw Object.assign(Error('SOURCE_HASH_MISMATCH'),{code:'SOURCE_HASH_MISMATCH'});
  const pageStarted=performance.now(),beforeProcesses=observer.snapshot(),httpBefore=actualHttpCalls;
  const created=previous?await store.retry(owner,previous.id,{idempotencyKey:'stage14r-explicit-fixed-template'}):await store.submit({owner,idempotencyKey:'stage14r-'+input.pageId,bytes,name:input.name,sourceLanguage:'ja',projectId:'stage14r-runtime-pages',pageId:input.pageId,pageNumber:input.ordinal});
  currentJob=created.id;let job,last='',cancelRequested=false;
  const deadline=Date.now()+18*60_000;
  while(Date.now()<deadline){
   job=await store.get(owner,created.id);phase=job.stage;const marker=job.status+':'+job.stage+':'+job.progress;
   if(marker!==last){last=marker;console.log(JSON.stringify({status:job.status,stage:job.stage,jobId:created.id,ordinal:input.ordinal,elapsedMs:Math.round(performance.now()-pageStarted)}));}
   if(['completed','failed','cancelled'].includes(job.status))break;
   if(!cancelRequested&&(stopReason||fs.existsSync(path.join(directory,'STOP')))){await store.cancel(owner,created.id);cancelRequested=true;}
   await new Promise(r=>setTimeout(r,200));
  }
  if(!['completed','failed','cancelled'].includes(job?.status)){await store.cancel(owner,created.id);throw Object.assign(Error('PAGE_TIMEOUT'),{code:'PAGE_TIMEOUT'});}
  const jobDir=path.join(config.dataRoot,created.id),state=JSON.parse(await fsp.readFile(path.join(jobDir,'state.json'),'utf8'));
  const row={ordinal:input.ordinal,jobId:created.id,sourceSha256:input.sha256,pageId:input.pageId,status:job.status,errorCode:job.errorCode??null,elapsedMs:Math.round(performance.now()-pageStarted),jobDirectory:jobDir,beforeProcesses,afterProcesses:observer.snapshot(),sourceUnchanged:sha(await fsp.readFile(input.copyPath))===input.sha256,state};
  const files=await fsp.readdir(jobDir);row.artifacts=[];for(const name of files){const p=path.join(jobDir,name);if((await fsp.stat(p)).isFile())row.artifacts.push({name,bytes:(await fsp.stat(p)).size,sha256:sha(await fsp.readFile(p))});}
  let events=[];try{events=(await fsp.readFile(path.join(jobDir,'runtime-events.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{}
  row.runtimeEvents=events;row.observedTranslationHttpCalls=actualHttpCalls-httpBefore;
  try{const source=JSON.parse(await fsp.readFile(path.join(jobDir,'translation-input.json'),'utf8')),raw=JSON.parse(await fsp.readFile(path.join(jobDir,'translation-response-page.json'),'utf8')).response;
   const {parsePageTranslationResponse}=require('../../packages/ai-engine/quality/page-translation.cjs'),{validateTranslationBatch}=require('../../packages/ai-engine/quality/translation-contract.cjs');
   const parsed=parsePageTranslationResponse(raw,source.regions),validated=validateTranslationBatch({input:source,results:parsed}),choice=raw.choices[0];
   row.translationValidation={finalJsonValid:true,stage11Passed:true,expectedIds:source.regions.map(r=>r.id),returnedIds:validated.map(r=>r.id),contentBytes:Buffer.byteLength(choice.message.content),reasoningBytes:Buffer.byteLength(choice.message.reasoning_content??''),finishReason:choice.finish_reason,usage:raw.usage??null,flagged:validated.filter(r=>r.semantic.signals.length).map(r=>({id:r.id,codes:r.semantic.signals.map(s=>s.code)})),automaticApproval:false};
  }catch(e){row.translationValidation={finalJsonValid:false,code:e.code??e.name};}
  try{const saved=JSON.parse(await fsp.readFile(path.join(jobDir,'checkpoint-ocr.json'),'utf8')),old=JSON.parse(await fsp.readFile(path.join(config.checkpointDirectory,'checkpoint-ocr.json'),'utf8'));row.ocrCheckpoint={currentIdentity:saved.identity,previousIdentity:old.identity,configurationMatched:saved.identity.configuration===old.identity.configuration,scopeUnchanged:JSON.stringify(saved.scope)===JSON.stringify(old.scope),additionalOcrEvents:events.filter(e=>e.phase==='ocr_recognition_complete'||e.phase==='ocr_refinement_crop_complete')};}catch{}
 
  let report=null;try{report=JSON.parse(await fsp.readFile(path.join(jobDir,'engine-report.json'),'utf8'));}catch{}
  row.actualTranslationHttpCalls=report?.translations?.reduce((sum,r)=>sum+(r.requestScope==='page'?0:r.modelHttpRequests??0),0)??null;
  if(Array.isArray(report?.translationRequests))row.actualTranslationHttpCalls=(row.actualTranslationHttpCalls??0)+report.translationRequests.reduce((sum,r)=>sum+(r.httpRequests??0),0);
  if(job.status==='completed'){
   const result=await store.getResult(owner,created.id);await json('page-'+input.ordinal+'-studio-result.json',result);
   row.resultReceipt=state.resultReceipt;row.recovery=report?.recovery??null;
  }
  rows.push(row);await json('page-'+input.ordinal+'-receipt.json',row);
  if(job.status!=='completed'){failure=job.errorCode??stopReason??'PAGE_FAILED';break;}
 }
 // Read after an actual store close/reopen. Never resubmit or auto-retry a completed job.
 await store.close();store=null;
 const readOnlyEngine={health:()=>({ready:true}),inspectImage:()=>{throw Error('UNEXPECTED_IMAGE_INSPECTION');},run:()=>{modelHttpRequests++;throw Error('UNEXPECTED_MODEL_CALL_ON_REOPEN');},close:async()=>{}};
 const reopened=await createJobStore({root:config.dataRoot,engine:readOnlyEngine});
 const restored=[];for(const row of rows){const state=await reopened.get(owner,row.jobId);let result=null;if(row.status==='completed')result=await reopened.getResult(owner,row.jobId);restored.push({jobId:row.jobId,status:state.status,completedResultReturned:!!result,resultReceiptUnchanged:row.resultReceipt?JSON.stringify(row.resultReceipt)===JSON.stringify(JSON.parse(await fsp.readFile(path.join(row.jobDirectory,'state.json'),'utf8')).resultReceipt):null});}
 await reopened.close();await json('store-reopen.json',{actualStoreReopen:true,actualModelEngineRestart:false,additionalModelCalls:modelHttpRequests,rows:restored,scope:'SERVER_DISK_REOPEN_NOT_BROWSER_INDEXEDDB'});
}
main().catch(e=>{failure=e.code??'STAGE14_PAGE_HARNESS_FAILED';}).finally(async()=>{
 let cleanup=true;try{if(store)await store.close();else await engine?.close();}catch{cleanup=false;failure='CLEANUP_FAILED';}
 try{await observer?.flush();}catch{cleanup=false;}const children=observer?.serializable()??[];if(children.some(r=>!r.closed))cleanup=false;
 observer?.restore();globalThis.fetch=priorFetch;let resources=null;try{resources=await monitor?.stop();}catch{cleanup=false;}
 const value={status:failure?'BLOCKED':'REAL_PAGES_COMPLETED',failure,scope:'ACTUAL_PRODUCT_ENGINE_AND_STORE_NOT_BROWSER_OR_HUMAN_QUALITY',rows,actualTranslationHttpCalls:actualHttpCalls,elapsedMs:Math.round(performance.now()-started),cleanupConfirmed:cleanup,children,resources,automaticRetries:0,modelFallbacks:0,paidApiCalls:0,externalInferenceCalls:0,cost:null,humanGroundTruthPages:0,qualityApproval:false};
 try{await json('page-run-receipt.json',value);}catch{cleanup=false;}
 console.log(JSON.stringify({status:value.status,failure,pagesCompleted:rows.filter(r=>r.status==='completed').length,cleanupConfirmed:cleanup,elapsedMs:value.elapsedMs}));app.exit(failure||!cleanup?1:0);
});
