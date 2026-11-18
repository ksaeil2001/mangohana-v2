'use strict';
// Hidden administrator harness. Importing this module never loads Electron or a model.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const childProcess=require('node:child_process');
const {createHash,randomUUID}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {syncBuiltinESMExports}=require('node:module');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
const codeOf=error=>/^[A-Z0-9_]{1,80}$/.test(error?.code??'')?error.code:'WARM_VERIFICATION_FAILED';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const equalSet=(a,b)=>a.length===b.length&&new Set(a).size===a.length&&[...a].sort().every((value,index)=>value===[...b].sort()[index]);
const bootstrapStages=new Set(['entry','plan_read','plan_validation','config_read','config_validation','gate_read','gate_validation','asset_stat','electron_profile','protocol_registration','app_ready','bootstrap_report','engine_creation','unknown']);
function startupFailureEvent(error){return {phase:'startup_failed',code:'WARM_STARTUP_FAILED',primaryFailureCode:codeOf(error),bootstrapStage:bootstrapStages.has(error?.bootstrapStage)?error.bootstrapStage:'unknown',cleanupConfirmed:false};}
function sanitizeStartupEvent(value){
 if(value?.phase!=='startup_failed'||value.code!=='WARM_STARTUP_FAILED'||!/^[A-Z0-9_]{1,80}$/.test(value.primaryFailureCode??'')||!bootstrapStages.has(value.bootstrapStage)||value.cleanupConfirmed!==false)return null;
 return {phase:'startup_failed',code:'WARM_STARTUP_FAILED',primaryFailureCode:value.primaryFailureCode,bootstrapStage:value.bootstrapStage,cleanupConfirmed:false};
}

const BOTH_WARM='OCR_WARM_TRANSLATION_WARM',OCR_COLD='OCR_COLD_TRANSLATION_WARM';
function runtimeReuseMode(plan={}){
 const mode=plan.runtimeReuseMode??BOTH_WARM;
 if(![BOTH_WARM,OCR_COLD].includes(mode))throw fail('WARM_RUNTIME_REUSE_MODE_INVALID');
 if(plan.refineConnectedOcr!==undefined&&typeof plan.refineConnectedOcr!=='boolean'||plan.runtimeReuseMode!==undefined&&typeof plan.refineConnectedOcr!=='boolean'||plan.runtimeReuseMode===undefined&&plan.refineConnectedOcr===true)throw fail('WARM_REFINEMENT_PLAN_INVALID');
 return mode;
}
function validateRuntimeConfiguration(plan,config){
 const mode=runtimeReuseMode(plan),explicit=plan.runtimeReuseMode!==undefined,refine=plan.refineConnectedOcr===true;
 if(explicit||config.reuseOcrRuntime!==undefined||config.reuseTranslationServer!==undefined){
  if(config.reuseOcrRuntime!==(mode===BOTH_WARM)||config.reuseTranslationServer!==true)throw fail('WARM_RUNTIME_CONFIG_MISMATCH');
 }
 if(explicit?config.refineConnectedOcr!==refine:config.refineConnectedOcr!==undefined&&config.refineConnectedOcr!==refine)throw fail('WARM_REFINEMENT_CONFIG_MISMATCH');
 if(refine&&![config.regionDetectorWorker,config.regionDetectorModel].every(value=>typeof value==='string'&&value.length>0))throw fail('WARM_REFINEMENT_DETECTOR_REQUIRED');
 return mode;
}

function validatePlan(plan){
 if(plan?.version!==1||plan.scope!=='TWO_DISTINCT_JAPANESE_TECHNICAL_SAMPLES'||!Array.isArray(plan.inputs)||plan.inputs.length!==2||new Set(plan.inputs.map(input=>input.sourceSha256)).size!==2||new Set(plan.inputs.map(input=>input.pageId)).size!==2||!plan.inputs.every(input=>/^[0-9a-f]{64}$/.test(input.sourceSha256)))throw fail('WARM_DISTINCT_INPUTS_REQUIRED');
 if(!/^[0-9a-f]{64}$/.test(plan.ownerScope??'')||typeof plan.projectId!=='string'||!plan.projectId||!/^E:[\\/]/i.test(plan.runRoot??'')||plan.browserFlowVerified!==false||plan.storyChronologyVerified!==false||plan.manualCorrections!==0)throw fail('WARM_PLAN_INVALID');
 const policy=plan.policy;
 if(policy?.hostIntervalMs!==2000||policy?.gpuIntervalMs!==2000||!Number.isFinite(policy?.hostAbortBelowMiB)||policy.hostAbortBelowMiB<512||!['pageTimeoutMs','totalTimeoutMs','gpuProbeTimeoutMs','cleanupTimeoutMs','forceGraceMs'].every(key=>Number.isSafeInteger(policy[key])&&policy[key]>0&&policy[key]<=60*60_000)||policy.pageTimeoutMs>policy.totalTimeoutMs||policy.gpuProbeTimeoutMs>20000||policy.cleanupTimeoutMs>30000||policy.forceGraceMs>60000||!Number.isFinite(policy.gpuAbortBelowFreeMiB)||policy.gpuAbortBelowFreeMiB<0)throw fail('WARM_POLICY_INVALID');
 runtimeReuseMode(plan);
 return plan;
}
function classify(executable,argv,config){
 const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
 if(same(executable,config.llamaServer))return Array.isArray(argv)&&argv[0]==='--help'?'LLM_PROBE':'LLM_SERVER';
 // Read only fixed, non-secret role prefixes. Never inspect/log options, env, full argv or auth arguments.
 if(Array.isArray(argv)&&argv[0]==='-I'&&argv[1]==='-X'&&argv[2]==='utf8'&&argv[3]==='-B')return 'OCR_RUNTIME';
 if(Array.isArray(argv)&&argv[0]==='-I'&&argv[1]==='-B'){
  if(same(argv[2],config.regionDetectorWorker))return 'REGION_DETECTOR';
  if(same(argv[2],config.textMaskWorker))return 'TEXT_MASK';
  if(same(argv[2],path.join(config.repository,'scripts/sites-local/lama-stdio.py')))return 'INPAINT';
 }
 return 'OTHER_NATIVE_CHILD';
}
function createSpawnObserver({config,currentJob=()=>null,onEvent=()=>{},spawnModule=childProcess}){
 const original=spawnModule.spawn,records=[];let queue=Promise.resolve(),writeFailure,restored=false;
 const plain=record=>({recordId:record.recordId,executable:record.executable,role:record.role,pid:record.pid,birthJobId:record.birthJobId,bornAt:record.bornAt,closed:record.closed,closedAt:record.closedAt??null,code:record.code??null,signal:record.signal??null,errorCode:record.errorCode??null});
 const emit=value=>{queue=queue.then(()=>onEvent(value)).catch(error=>{writeFailure??=error;});};
 const wrapped=function(...opaque){
  const child=Reflect.apply(original,spawnModule,opaque);
  const record={child,recordId:randomUUID(),executable:typeof opaque[0]==='string'?opaque[0]:'UNKNOWN',role:classify(opaque[0],opaque[1],config),pid:child.pid??null,birthJobId:currentJob(),bornAt:new Date().toISOString(),closed:false};records.push(record);emit({event:'spawn',...plain(record)});
  child.once('error',error=>{record.errorCode=codeOf(error);emit({event:'error',...plain(record)});});
  child.once('close',(code,signal)=>{record.closed=true;record.closedAt=new Date().toISOString();record.code=code;record.signal=signal;emit({event:'close',...plain(record)});});return child;
 };
 spawnModule.spawn=wrapped;if(spawnModule===childProcess)syncBuiltinESMExports();
 return {records,snapshot:()=>records.filter(record=>!record.closed&&record.child.exitCode===null&&record.child.signalCode===null&&!record.child.killed).map(plain),serializable:()=>records.map(plain),flush:async()=>{await queue;if(writeFailure)throw writeFailure;},restore:()=>{if(restored)return true;if(spawnModule.spawn!==wrapped)return false;spawnModule.spawn=original;if(spawnModule===childProcess)syncBuiltinESMExports();restored=true;return true;}};
}
async function runTwoPages({store,plan,readInput,collect,onAdmitted=async()=>{},onFailure=async()=>{},shouldStop=()=>null,pause:wait=()=>pause(200)}){
 const rows=[];
 for(const sample of plan.inputs){
  let created,job;
  try{
   const stopped=await shouldStop();if(stopped)throw stopped;
   const bytes=await readInput(sample);if(sha(bytes)!==sample.sourceSha256)throw fail('WARM_SOURCE_CHANGED');
   created=await store.submit({owner:plan.ownerScope,idempotencyKey:'warm:'+plan.runId+':'+sample.pageId,bytes,name:sample.name,sourceLanguage:'ja',projectId:plan.projectId,pageId:sample.pageId,pageNumber:sample.ordinal});
   await onAdmitted({ordinal:sample.ordinal,jobId:created.id,pageId:sample.pageId,sourceSha256:sample.sourceSha256});
   const deadline=Date.now()+plan.policy.pageTimeoutMs;
   for(;;){const stop=await shouldStop();if(stop)throw stop;job=await store.get(plan.ownerScope,created.id);if(['completed','failed'].includes(job.status))break;if(Date.now()>deadline)throw fail('WARM_PAGE_TIMEOUT');await wait();}
   if(job.status!=='completed')throw fail(job.errorCode??'WARM_PAGE_FAILED');
   rows.push(await collect(job,sample));
  }catch(error){const row={ordinal:sample.ordinal,jobId:created?.id??null,pageId:sample.pageId,sourceSha256:sample.sourceSha256,status:job?.status==='completed'?'completed':'failed',durableStatus:job?.status??'admission_unknown',evidenceVerified:false,code:codeOf(error)};rows.push(row);await onFailure(row);break;}
 }
 return rows;
}
function coldOcrProof(pages){
 const failed=reason=>({verified:false,reason}),jobs=[],seen=new Set(),instant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
 for(const page of pages){
  if(page.evidenceVerified!==true||!Array.isArray(page.jobProcesses))return failed('OCR_COLD_JOB_EVIDENCE_REQUIRED');
  const events=page.runtimeEvents??[],cache=events.filter(event=>event.phase==='ocr_runtime_cache'),status=events.filter(event=>event.phase==='ocr_status_complete'),recognized=events.filter(event=>event.phase==='ocr_recognition_complete'),translation=events.find(event=>event.phase==='translation_runtime_cache');
  if(cache.length!==1||cache[0].mode!=='disabled'||status.length!==1||status[0].ready!==true||recognized.length!==1||!Number.isSafeInteger(recognized[0].speechRegions)||recognized[0].speechRegions<1||![status[0],recognized[0]].every(event=>Number.isFinite(event.durationMs)&&event.durationMs>=0))return failed('OCR_COLD_RECOGNITION_NOT_PROVEN');
  const started=instant(page.startedAt),finished=instant(page.finishedAt),ready=instant(status[0].at),complete=instant(recognized[0].at),translationAt=instant(translation?.at);
  if(![started,finished,ready,complete,translationAt].every(Number.isFinite)||!(started<=ready&&ready<=complete&&complete<=translationAt&&translationAt<=finished)||events.indexOf(status[0])>=events.indexOf(recognized[0]))return failed('OCR_COLD_EVENT_ORDER_INVALID');
  if([...(page.beforeProcesses??[]),...(page.afterProcesses??[])].some(record=>record.role==='OCR_RUNTIME'))return failed('OCR_COLD_CHILD_STILL_RETAINED');
  const records=page.jobProcesses.filter(record=>record.role==='OCR_RUNTIME');if(!records.length)return failed('OCR_COLD_CHILD_EVIDENCE_MISSING');
  for(const record of records){const born=instant(record.bornAt),closed=instant(record.closedAt);
   if(typeof record.recordId!=='string'||!record.recordId||seen.has(record.recordId)||!Number.isSafeInteger(record.pid)||record.pid<1||record.birthJobId!==page.jobId||record.closed!==true||record.errorCode||![born,closed].every(Number.isFinite)||!(started<=born&&born<=complete&&complete<=closed&&closed<=translationAt))return failed('OCR_COLD_CHILD_NOT_INDEPENDENT_AND_CLOSED');
   seen.add(record.recordId);
  }
  jobs.push({jobId:page.jobId,recordIds:records.map(record=>record.recordId),pids:records.map(record=>record.pid),statusReady:true,recognitionComplete:true,childrenClosedBeforeTranslation:true});
 }
 return {verified:true,mode:'COLD_PER_PAGE',reused:false,jobs};
}
function cacheProof(pages,{runtimeReuseMode:mode=BOTH_WARM}={}){
 const failed=reason=>({verified:false,reason});if(![BOTH_WARM,OCR_COLD].includes(mode))return failed('RUNTIME_REUSE_MODE_INVALID');
 if(!Array.isArray(pages)||pages.length!==2||pages.some(page=>page.status!=='completed'||page.evidenceVerified===false))return failed('TWO_COMPLETED_EVIDENCE_PAGES_REQUIRED');
 const [first,second]=pages;if(first.jobId===second.jobId||first.sourceSha256===second.sourceSha256)return failed('DISTINCT_JOBS_AND_SOURCES_REQUIRED');
 if(!first.requestIds?.length||!second.requestIds?.length||second.requestIds.some(id=>first.requestIds.includes(id)))return failed('DISTINCT_MODEL_REQUESTS_REQUIRED');
 const proof={};
 for(const [kind,role]of (mode===OCR_COLD?[['translation','LLM_SERVER']]:[['ocr','OCR_RUNTIME'],['translation','LLM_SERVER']])){
  const a=first.runtimeEvents?.find(event=>event.phase===kind+'_runtime_cache'),b=second.runtimeEvents?.find(event=>event.phase===kind+'_runtime_cache');
  if(!a||!b||a.mode!=='cold'||b.mode!=='warm'||a.generation!==b.generation||a.identity!==b.identity||!/^[0-9a-f]{64}$/.test(a.identity??''))return failed(kind.toUpperCase()+'_GENERATION_NOT_WARM');
  const key=record=>record.recordId??record.role+':'+record.pid+':'+record.birthJobId;
  const initial=(first.afterProcesses??[]).filter(record=>record.role===role&&record.birthJobId===first.jobId&&Number.isInteger(record.pid)),before=(second.beforeProcesses??[]).filter(record=>record.role===role),after=(second.afterProcesses??[]).filter(record=>record.role===role);
  if(!initial.length||!equalSet(initial.map(key),before.map(key))||!equalSet(initial.map(key),after.map(key)))return failed(kind.toUpperCase()+'_LIVE_PID_NOT_PRESERVED');
  if(mode===OCR_COLD){
   const strict=record=>JSON.stringify([record.recordId,record.pid,record.birthJobId,record.bornAt]),owned=(first.jobProcesses??[]).filter(record=>record.role===role);
   if(!Number.isSafeInteger(a.generation)||a.generation<1||(first.beforeProcesses??[]).some(record=>record.role===role)||[...initial,...before,...after,...owned].some(record=>typeof record.recordId!=='string'||!record.recordId||!Number.isSafeInteger(record.pid)||record.pid<1||record.closed!==false||!Number.isFinite(Date.parse(record.bornAt))||!(Date.parse(first.startedAt)<=Date.parse(record.bornAt)&&Date.parse(record.bornAt)<=Date.parse(first.finishedAt)))||!equalSet(initial.map(strict),before.map(strict))||!equalSet(initial.map(strict),after.map(strict))||!equalSet(initial.map(strict),owned.map(strict))||(second.jobProcesses??[]).some(record=>record.role===role))return failed('TRANSLATION_OWNED_RECORD_NOT_PRESERVED');
  }
  proof[kind]={generation:a.generation,identity:a.identity,pids:initial.map(record=>record.pid),recordIds:initial.map(key),bornInJob:first.jobId,reusedByJob:second.jobId};
 }
 if(mode===OCR_COLD){const ocr=coldOcrProof(pages);if(!ocr.verified)return ocr;return {verified:true,runtimeReuseMode:mode,ocr,...proof};}
 return {verified:true,...proof};
}
const cleanupConfirmed=({engineConfirmed,ownedChildrenClosed,forced})=>engineConfirmed===true&&ownedChildrenClosed===true&&forced===false;
function validateExecutionGate(plan,planSha256,start,integrity,parentPid,rootPid){
 if(start?.runId!==plan.runId||start.planSha256!==planSha256||!Number.isInteger(start.supervisorPid)||start.supervisorPid<1||start.supervisorPid!==parentPid)throw fail('WARM_MONITORED_SUPERVISOR_REQUIRED');
 if(start.jobAssigned!==true||start.launchMechanism!=='ATOMIC_JOB_LIST_SUSPENDED'||start.inheritedHandles!=='STDOUT_STDERR_ONLY'||!Number.isInteger(rootPid)||rootPid<1||start.rootPid!==rootPid||!/^\d{15,}$/.test(start.rootCreationTime100ns??''))throw fail('WARM_KERNEL_JOB_REQUIRED');
 if(integrity?.kind!=='FULL_SHA256_BEFORE_NATIVE_ENGINE'||!Array.isArray(plan.modelPins)||plan.modelPins.length!==2||integrity.assets?.length!==2||!plan.modelPins.every(pin=>integrity.assets.some(asset=>asset.path===pin.path&&asset.bytes===pin.bytes&&asset.sha256===pin.sha256&&asset.observedSha256===pin.sha256)))throw fail('WARM_VERIFIED_ASSETS_REQUIRED');
}

function prepareElectronBootstrap(planPath){
 let bootstrapStage='entry';try{
  if(!process.versions.electron)throw fail('WARM_ELECTRON_MAIN_REQUIRED');
  // The small manifest/config/gate reads and asset stats must finish before the first await.
  // Electron can become ready while async fs yields, after which scheme registration is forbidden.
  bootstrapStage='plan_read';const planBytes=fs.readFileSync(planPath);bootstrapStage='plan_validation';const plan=validatePlan(JSON.parse(planBytes));
  bootstrapStage='config_read';const configBytes=fs.readFileSync(plan.configPath);bootstrapStage='config_validation';const config=JSON.parse(configBytes);if(sha(configBytes)!==plan.configSha256||config.runRoot!==plan.runRoot)throw fail('WARM_CONFIG_CHANGED');validateRuntimeConfiguration(plan,config);
  bootstrapStage='gate_read';const start=JSON.parse(fs.readFileSync(path.join(plan.runRoot,'execution-gate.json'))),integrity=JSON.parse(fs.readFileSync(path.join(plan.runRoot,'asset-integrity.json')));bootstrapStage='gate_validation';validateExecutionGate(plan,sha(planBytes),start,integrity,process.ppid,process.pid);
  bootstrapStage='asset_stat';for(const asset of integrity.assets){const stat=fs.lstatSync(asset.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==asset.bytes||stat.mtimeMs!==asset.mtimeMs)throw fail('WARM_ASSET_CHANGED_AFTER_VERIFICATION');}
  const {app,protocol}=require('electron');bootstrapStage='electron_profile';for(const key of ['userData','sessionData','temp','documents','home']){const directory=path.join(config.profileRoot,key);fs.mkdirSync(directory,{recursive:true});app.setPath(key,directory);}
  bootstrapStage='protocol_registration';if(app.isReady())throw fail('WARM_PROTOCOL_REGISTRATION_TOO_LATE');protocol.registerSchemesAsPrivileged([{scheme:'trio-resource',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);app.on('window-all-closed',()=>{});
  return {app,plan,config,planBytes};
 }catch(error){throw Object.assign(fail(codeOf(error)),{bootstrapStage});}
}
async function runElectron(planPath,{bootstrapOnly=false}={}){
 const {app,plan,config,planBytes}=prepareElectronBootstrap(planPath);
 if(bootstrapOnly){let bootstrapStage='app_ready';try{await app.whenReady();bootstrapStage='bootstrap_report';const value={version:1,status:'BOOTSTRAP_ONLY_NO_AI',scope:'BOOTSTRAP_ONLY_NO_AI',runId:plan.runId,planSha256:sha(planBytes),runtimeReuseMode:runtimeReuseMode(plan),refineConnectedOcr:plan.refineConnectedOcr===true,engineCreated:false,actualAiCalls:0,pages:[],bootstrapReady:app.isReady(),gateValidated:true,assetStatValidated:true,browserFlowVerified:false,storyChronologyVerified:false,manualCorrections:0};await fsp.writeFile(path.join(plan.runRoot,'verification-bootstrap-inner.json'),JSON.stringify(value,null,2),{flag:'wx'});console.log(JSON.stringify({phase:'bootstrap_ready',status:value.status,actualAiCalls:0,engineCreated:false}));app.exit(0);return;}catch(error){throw Object.assign(fail(codeOf(error)),{bootstrapStage});}}
 const output=plan.runRoot,write=(name,value)=>fsp.writeFile(path.join(output,name),JSON.stringify(value,null,2),{flag:'wx'}),emit=value=>console.log(JSON.stringify(value));
 let activeJob=null,engine,store,contextStore,rows=[],failure=null,engineConfirmed=false,cleanupFailure=false,observer,summary;
 const slots=new Map(),started=performance.now();
 const stop=async()=>{try{const value=JSON.parse(await fsp.readFile(path.join(output,'STOP-'+plan.runId),'utf8'));return fail(/^[A-Z0-9_]{1,80}$/.test(value.code??'')?value.code:'INTERRUPTED');}catch(error){return error.code==='ENOENT'?null:fail('INTERRUPTED');}};
 try{
  await app.whenReady();observer=createSpawnObserver({config,currentJob:()=>activeJob,onEvent:value=>fsp.appendFile(path.join(output,'child-lifecycle.jsonl'),JSON.stringify(value)+'\n')});
  const {createEngine}=require(path.join(config.repository,'scripts/sites-local/engine.cjs'));
  engine=await createEngine(config);if(!engine.health().ready)throw fail('ENGINE_NOT_READY');
  const wrapped={...engine,run:async args=>{const slot={before:observer.snapshot(),startedAt:new Date().toISOString()};slots.set(args.jobId,slot);activeJob=args.jobId;try{return await engine.run(args);}finally{slot.after=observer.snapshot();slot.jobProcesses=observer.serializable().filter(record=>record.birthJobId===args.jobId);slot.finishedAt=new Date().toISOString();activeJob=null;}}};
  const {createJobStore}=await import(pathToFileURL(path.join(__dirname,'store.mjs')).href);
  if(plan.withContext){const {createContextStore}=await import(pathToFileURL(path.join(__dirname,'context.mjs')).href);contextStore=await createContextStore({root:path.join(config.dataRoot,'contexts')});}
  store=await createJobStore({root:config.dataRoot,engine:wrapped,...(contextStore?{contextStore}:{})});
  async function collect(job,sample){
   const directory=path.join(config.dataRoot,job.id),result=await store.getResult(plan.ownerScope,job.id),reportBytes=await fsp.readFile(path.join(directory,'report.json')),report=JSON.parse(reportBytes),state=JSON.parse(await fsp.readFile(path.join(directory,'state.json')));
   const source=await fsp.readFile(path.join(directory,'source.png')),original=await fsp.readFile(sample.originalPath),copy=await fsp.readFile(sample.copyPath);
   if(state.sourceSha256!==sample.sourceSha256||[source,original,copy].some(bytes=>sha(bytes)!==sample.sourceSha256)||report.jobId!==job.id||report.hashes?.original!==sample.sourceSha256)throw fail('WARM_SOURCE_ASSOCIATION_FAILED');
   const lines=report.lines??[],ocr=report.ocr?.speechBubbles??[],translations=report.translations??[],layout=report.typesetting?.layoutReport??[],ids=lines.map(line=>line.id);
   if(!ids.length||![ocr,translations,layout].every(records=>equalSet(ids,records.map(record=>record.id)))||lines.some(line=>line.sourceText!==ocr.find(record=>record.id===line.id)?.text||!line.aiTranslation?.trim()))throw fail('WARM_REGION_ASSOCIATION_FAILED');
   const requests=report.translationRequests??[];if(!requests.length||requests.some(request=>request.scope!=='page'||request.httpRequests!==1)||new Set(requests.map(request=>request.requestId)).size!==requests.length)throw fail('WARM_MODEL_REQUEST_PROOF_MISSING');
   const runtimeEvents=(await fsp.readFile(path.join(directory,'runtime-events.jsonl'),'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse),candidate=await fsp.readFile(path.join(directory,'candidate.png'));
   if(sha(candidate)!==report.hashes.candidate||state.reportSha256!==sha(reportBytes))throw fail('WARM_OUTPUT_HASH_FAILED');
   const pageDirectory=path.join(output,'page-'+String(sample.ordinal).padStart(2,'0'));await fsp.mkdir(pageDirectory);
   await fsp.writeFile(path.join(pageDirectory,'candidate.png'),candidate,{flag:'wx'});await fsp.writeFile(path.join(pageDirectory,'studio-result.json'),JSON.stringify(result),{flag:'wx'});
   const slot=slots.get(job.id),row={ordinal:sample.ordinal,jobId:job.id,pageId:sample.pageId,sourceSha256:sample.sourceSha256,status:'completed',evidenceVerified:true,manualCorrections:0,qualityStatus:'pending',jobDirectory:directory,pageDirectory,reportSha256:state.reportSha256,candidateSha256:sha(candidate),regions:ids.length,regionIds:ids,requestIds:requests.map(request=>request.requestId),modelHttpRequests:requests.reduce((sum,request)=>sum+request.httpRequests,0),measurements:report.measurements??null,translationContext:report.translationContext??null,runtimeEvents,beforeProcesses:slot?.before??[],afterProcesses:slot?.after??[],startedAt:slot?.startedAt??null,finishedAt:slot?.finishedAt??null};
   row.jobProcesses=slot?.jobProcesses??[];
   await fsp.writeFile(path.join(pageDirectory,'evidence.json'),JSON.stringify(row,null,2),{flag:'wx'});emit({phase:'page_completed',ordinal:sample.ordinal,jobId:job.id,regions:ids.length});return row;
  }
  rows=await runTwoPages({store,plan,readInput:sample=>fsp.readFile(sample.copyPath),collect,shouldStop:stop,onAdmitted:async row=>{await fsp.appendFile(path.join(output,'jobs-admitted.jsonl'),JSON.stringify(row)+'\n');emit({phase:'job_admitted',...row});},onFailure:async row=>{await fsp.appendFile(path.join(output,'page-failures.jsonl'),JSON.stringify(row)+'\n');emit({phase:'page_failed',ordinal:row.ordinal,jobId:row.jobId,code:row.code});}});
  if(rows.length!==2||rows.some(row=>!row.evidenceVerified))failure=rows.find(row=>row.code)?.code??'WARM_INCOMPLETE';
 }catch(error){failure=codeOf(error);}
 finally{
  let timer;const closing=(async()=>{for(const close of [()=>store?.close(),()=>engine?.close(),()=>contextStore?.close()])try{await close();}catch{cleanupFailure=true;}return !cleanupFailure;})();
  try{engineConfirmed=await Promise.race([closing,new Promise(resolve=>{timer=setTimeout(()=>{cleanupFailure=true;resolve(false);},plan.policy.cleanupTimeoutMs);})]);}finally{clearTimeout(timer);}
  if(observer)try{await observer.flush();}catch{cleanupFailure=true;}
  const ownedClosed=observer?observer.records.every(record=>record.closed):true;
  engineConfirmed=engineConfirmed===true&&!cleanupFailure&&ownedClosed;
  const restored=engineConfirmed?(observer?.restore()??true):false;
  if(!restored)engineConfirmed=false;
  summary={version:1,status:failure?(rows.some(row=>row.evidenceVerified)?'partial':'failed'):engineConfirmed?'completed':'failed',failure:failure??(!engineConfirmed?'CLEANUP_UNCONFIRMED':null),scope:plan.scope,browserFlowVerified:false,storyChronologyVerified:false,manualCorrections:0,qualityStatus:'pending',contextMode:plan.withContext?'TECHNICAL_ORDER_CONTEXT_NOT_STORY_CHRONOLOGY':'OFF',runtimeReuseMode:runtimeReuseMode(plan),refineConnectedOcr:plan.refineConnectedOcr===true,runId:plan.runId,pages:rows,cacheReuse:cacheProof(rows,{runtimeReuseMode:runtimeReuseMode(plan)}),cleanupConfirmed:engineConfirmed,spawnObserverRestored:restored,childProcesses:observer?.serializable()??[],elapsedMs:Math.round(performance.now()-started)};
  await write('verification-inner.json',summary);emit({phase:engineConfirmed?'engine_stopped':'cleanup_unconfirmed',status:summary.status,cleanupConfirmed:engineConfirmed});
 }
 if(!engineConfirmed){setInterval(()=>{},1000);return;} // Parent still owns this PID and must terminate its tree; never orphan unconfirmed children.
 app.exit(summary.status==='completed'?0:1);
}

function isDirectEntry(argv,filename){
 if(!Array.isArray(argv)||typeof argv[1]!=='string'||typeof filename!=='string')return false;
 const entry=path.resolve(argv[1]),self=path.resolve(filename);return process.platform==='win32'?entry.toLowerCase()===self.toLowerCase():entry===self;
}
function exitEntryFailure(event){console.error(JSON.stringify(event));if(process.versions.electron)require('electron').app.exit(1);else process.exitCode=1;}
module.exports={validatePlan,runtimeReuseMode,validateRuntimeConfiguration,createSpawnObserver,runTwoPages,cacheProof,cleanupConfirmed,validateExecutionGate,runElectron,isDirectEntry,startupFailureEvent,sanitizeStartupEvent};
// Electron's main loader owns require.main (id='electron'); match the actual entry argv instead.
if(isDirectEntry(process.argv,__filename)){const args=process.argv.slice(2),bootstrapOnly=args.length===2&&args[0]==='--bootstrap-only';if(args.length!==1&&!bootstrapOnly)exitEntryFailure({code:'WARM_PLAN_ARGUMENT_REQUIRED'});else runElectron(path.resolve(args[bootstrapOnly?1:0]),{bootstrapOnly}).catch(error=>exitEntryFailure(startupFailureEvent(error)));}
