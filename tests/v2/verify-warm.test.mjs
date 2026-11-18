import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
const require=createRequire(import.meta.url);
let inner={},outer={};
try{inner=require('../../apps/engine/verify-warm.cjs');}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
try{outer=await import('../../scripts/v2/verify-warm-pages.mjs');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const need=(object,name)=>assert.equal(typeof object[name],'function',name+' must exist');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('import is source-only and execution is a distinct explicit mode',()=>{
 need(outer,'parseArguments');assert.equal(outer.parseArguments([]).mode,'prepare');assert.equal(outer.parseArguments(['--prepare']).mode,'prepare');assert.throws(()=>outer.parseArguments(['--execute']),/USAGE/);assert.equal(outer.parseArguments(['--execute','E:/new-run']).mode,'execute');assert.equal(outer.parseArguments(['--bootstrap-only','E:/new-run']).mode,'bootstrap-only');assert.throws(()=>outer.parseArguments(['--prepare','--execute','E:/new-run']),/USAGE/);
});
test('technical selection sorts actual hashes and cannot choose duplicate bytes under different names',()=>{
 need(outer,'selectTechnicalSamples');const files=[{path:'a.png',sha256:'b'.repeat(64)},{path:'clone.png',sha256:'b'.repeat(64)},{path:'z.png',sha256:'a'.repeat(64)},{path:'c.png',sha256:'c'.repeat(64)}];assert.deepEqual(outer.selectTechnicalSamples(files).map(value=>value.sha256),['a'.repeat(64),'b'.repeat(64)]);assert.throws(()=>outer.selectTechnicalSamples(files.slice(0,2)),/DISTINCT/);
});
test('candidate changes only its isolated paths and small pinned profile plus explicit vision whitelist',()=>{
 need(outer,'candidateConfiguration');const base={repository:'C:/source',buildRoot:'C:/compiled',resourcesPath:'C:/resources',profileRoot:'E:/live/profile',dataRoot:'E:/live/jobs',runRoot:'E:/live',llamaServer:'E:/model/llama.exe',python:'E:/model/python.exe',gemmaModel:'E:/large.gguf',mmproj:'E:/large-projector.gguf',modelAlias:'large',secretKey:'must not copy'};
 const snapshot=structuredClone(base),config=outer.candidateConfiguration(base,{runRoot:'E:/new',modelPath:'E:/small.gguf',projectorPath:'E:/small-projector.gguf',vision:{gemmaModel:'E:/large2.gguf',regionDetectorWorker:'C:/detector.py',regionDetectorModel:'E:/detector.onnx',textMaskWorker:'C:/v3.py',textMaskModel:'E:/v3.onnx',textMaskAlgorithm:'learned_pixel_v3'}});
 assert.deepEqual(base,snapshot);assert.equal(config.gemmaModel,'E:/small.gguf');assert.equal(config.modelAlias,'gemma4-e2b-local');assert.equal(config.llamaLoadMode,'none');assert.equal(config.textMaskAlgorithm,'learned_pixel_v3');assert.equal(config.reuseOcrRuntime,true);assert.equal(config.reuseTranslationServer,true);assert.equal(config.secretKey,undefined);assert.notEqual(config.profileRoot,base.profileRoot);assert.notEqual(config.dataRoot,base.dataRoot);assert.equal(config.buildRoot,base.buildRoot);assert.equal(config.resourcesPath,base.resourcesPath);assert.throws(()=>outer.candidateConfiguration(base,{runRoot:'C:/bad',modelPath:'E:/small',projectorPath:'E:/small'}),/ISOLATION/);
});
test('fresh source receipts reject changed code or stale timestamps before any native start',()=>{
 need(outer,'assertFreshSourceReceipt');const entries=[{path:'engine.cjs',sha256:'a'.repeat(64),bytes:1}],receipt={createdAt:new Date(10000).toISOString(),entries};assert.doesNotThrow(()=>outer.assertFreshSourceReceipt(receipt,entries,11000));assert.throws(()=>outer.assertFreshSourceReceipt(receipt,[{...entries[0],sha256:'b'.repeat(64)}],11000),/SOURCE_CHANGED/);assert.throws(()=>outer.assertFreshSourceReceipt(receipt,entries,10000+11*60_000),/STALE/);
});
test('a completed first job remains preserved if the distinct second job fails, without retry',async()=>{
 need(inner,'runTwoPages');const bytes=[Buffer.from('first'),Buffer.from('second')],inputs=bytes.map((value,index)=>({pageId:'page-'+index,sourceSha256:sha(value),name:index+'.png',ordinal:index+1})),submitted=[],completed=[];const store={submit:async value=>{submitted.push(value);return {id:'job-'+submitted.length};},get:async(_owner,id)=>({id,status:id==='job-1'?'completed':'failed',errorCode:'SECOND_FAILED'})};
 const result=await inner.runTwoPages({store,plan:{inputs,ownerScope:'a'.repeat(64),projectId:'technical',runId:'run',policy:{pageTimeoutMs:1000}},readInput:sample=>bytes[sample.ordinal-1],collect:async(job,sample)=>{const row={jobId:job.id,status:'completed',sourceSha256:sample.sourceSha256};completed.push(row);return row;},shouldStop:()=>null,pause:async()=>{}});assert.equal(submitted.length,2);assert.equal(result[0],completed[0]);assert.equal(result[1].status,'failed');assert.equal(result[1].code,'SECOND_FAILED');assert.notEqual(submitted[0].pageId,submitted[1].pageId);assert.notEqual(sha(submitted[0].bytes),sha(submitted[1].bytes));
});
test('PID cache proof requires actual same live process snapshots and distinct job/request/source identities',()=>{
 need(inner,'cacheProof');const event=(kind,mode)=>({phase:kind+'_runtime_cache',mode,generation:1,identity:'d'.repeat(64)}),pids=[{pid:42,role:'OCR_RUNTIME',birthJobId:'first'},{pid:43,role:'LLM_SERVER',birthJobId:'first'}];const first={jobId:'first',status:'completed',sourceSha256:'a'.repeat(64),requestIds:['req-1'],runtimeEvents:[event('ocr','cold'),event('translation','cold')],afterProcesses:pids},second={jobId:'second',status:'completed',sourceSha256:'b'.repeat(64),requestIds:['req-2'],runtimeEvents:[event('ocr','warm'),event('translation','warm')],beforeProcesses:pids,afterProcesses:pids};assert.equal(inner.cacheProof([first,second]).verified,true);assert.equal(inner.cacheProof([first,{...second,beforeProcesses:[]}]).verified,false);assert.equal(inner.cacheProof([first,{...second,sourceSha256:first.sourceSha256}]).verified,false);assert.equal(inner.cacheProof([first,{...second,requestIds:['req-1']}]).verified,false);
});
test('a false cleanup report cannot be promoted by exit zero or a successful outer child close',()=>{
 need(inner,'cleanupConfirmed');assert.equal(inner.cleanupConfirmed({engineConfirmed:false,ownedChildrenClosed:true,forced:false}),false);assert.equal(inner.cleanupConfirmed({engineConfirmed:true,ownedChildrenClosed:true,forced:true}),false);assert.equal(inner.cleanupConfirmed({engineConfirmed:true,ownedChildrenClosed:true,forced:false}),true);
});
test('NVML failures remain failed observations instead of invented zero use',()=>{
 need(outer,'parseGpuObservation');assert.deepEqual(outer.parseGpuObservation('8192, 1024, 7168'),{gpuTotalMiB:8192,gpuUsedMiB:1024,gpuFreeMiB:7168});for(const text of ['','N/A, N/A, N/A','0, 0, 0','8192, -1, 0','8192, ,8192'])assert.throws(()=>outer.parseGpuObservation(text),/GPU_MONITOR_FORMAT/);
});
test('spawn observation forwards opaque options and never records argv or authentication material',async()=>{
 need(inner,'createSpawnObserver');const child=new EventEmitter();child.pid=42;child.exitCode=null;child.signalCode=null;child.killed=false;const options=new Proxy({},{get(){throw new Error('options must stay opaque');}}),argv=['--model','SECRET_ARG'];let calls=0;
 const module={spawn:function(executable,args,opts){calls++;assert.equal(this,module);assert.equal(args,argv);assert.equal(opts,options);return child;}},original=module.spawn,events=[];const observer=inner.createSpawnObserver({spawnModule:module,config:{llamaServer:'E:/llama.exe'},currentJob:()=> 'job-one',onEvent:value=>events.push(value)});module.spawn('E:/llama.exe',argv,options);child.emit('close',0,null);await observer.flush();assert.equal(calls,1);assert.equal(events[0].role,'LLM_SERVER');assert.equal(events[0].birthJobId,'job-one');assert.equal(JSON.stringify(events).includes('SECRET'),false);assert.equal(observer.restore(),true);assert.equal(observer.restore(),true);assert.equal(module.spawn,original);
});
test('direct hidden-engine invocation requires the monitored parent and full matching asset receipt',()=>{
 need(inner,'validateExecutionGate');const plan={runId:'run',modelPins:[{path:'E:/model',sha256:'a'.repeat(64),bytes:10},{path:'E:/projector',sha256:'b'.repeat(64),bytes:20}]},start={runId:'run',planSha256:'c'.repeat(64),supervisorPid:42,rootPid:91,rootCreationTime100ns:'134388252149414246',jobAssigned:true,launchMechanism:'ATOMIC_JOB_LIST_SUSPENDED',inheritedHandles:'STDOUT_STDERR_ONLY'},assets={kind:'FULL_SHA256_BEFORE_NATIVE_ENGINE',assets:plan.modelPins.map(pin=>({...pin,observedSha256:pin.sha256}))};assert.doesNotThrow(()=>inner.validateExecutionGate(plan,'c'.repeat(64),start,assets,42,91));assert.throws(()=>inner.validateExecutionGate(plan,'c'.repeat(64),start,assets,43,91),/SUPERVISOR/);assert.throws(()=>inner.validateExecutionGate(plan,'c'.repeat(64),start,{...assets,assets:[assets.assets[0]]},42,91),/ASSET/);assert.throws(()=>inner.validateExecutionGate(plan,'c'.repeat(64),{...start,jobAssigned:false},assets,42,91),/KERNEL_JOB/);assert.throws(()=>inner.validateExecutionGate(plan,'c'.repeat(64),start,assets,42,92),/KERNEL_JOB/);assert.throws(()=>inner.validateExecutionGate(plan,'c'.repeat(64),{...start,rootCreationTime100ns:undefined},assets,42,91),/KERNEL_JOB/);
});
test('a plan cannot disable host memory protection by omitting its numeric threshold',()=>{
 need(inner,'validatePlan');const plan={version:1,scope:'TWO_DISTINCT_JAPANESE_TECHNICAL_SAMPLES',inputs:[{pageId:'one',sourceSha256:'a'.repeat(64)},{pageId:'two',sourceSha256:'b'.repeat(64)}],ownerScope:'c'.repeat(64),projectId:'technical',runRoot:'E:/isolated',browserFlowVerified:false,storyChronologyVerified:false,manualCorrections:0,policy:{hostIntervalMs:2000,gpuIntervalMs:2000,pageTimeoutMs:1000,totalTimeoutMs:1000,gpuProbeTimeoutMs:20000,cleanupTimeoutMs:20000,forceGraceMs:30000,gpuAbortBelowFreeMiB:128}};assert.throws(()=>inner.validatePlan(plan),/POLICY/);assert.doesNotThrow(()=>inner.validatePlan({...plan,policy:{...plan.policy,hostAbortBelowMiB:512}}));
});

test('stderr startup parsing stores only bounded sanitized bootstrap facts, across chunks',()=>{
 need(outer,'createStartupEventReader');const events=[],read=outer.createStartupEventReader(event=>events.push(event));read(Buffer.from('native log with PRIVATE_KEY\nnot json\n{"phase":"startup_failed","code":"WARM_STARTUP_FAILED","primaryFailureCode":"ENOENT",'));read(Buffer.from('"bootstrapStage":"plan_read","cleanupConfirmed":false,"message":"SECRET_AUTH","env":{"API_KEY":"SECRET"}}\n'));assert.deepEqual(events,[{phase:'startup_failed',code:'WARM_STARTUP_FAILED',primaryFailureCode:'ENOENT',bootstrapStage:'plan_read',cleanupConfirmed:false}]);assert.equal(JSON.stringify(events).includes('SECRET'),false);read(Buffer.from('{"phase":"page_completed","message":"PRIVATE"}\n'));read(Buffer.from('{"phase":"startup_failed","primaryFailureCode":"secret/key","bootstrapStage":"C:/PRIVATE"}\n'));assert.equal(events.length,1);
});

const coldMode='OCR_COLD_TRANSLATION_WARM',bothMode='OCR_WARM_TRANSLATION_WARM';
function coldPages(){
 const llm={recordId:'synthetic-llm',pid:51,role:'LLM_SERVER',birthJobId:'first',closed:false,bornAt:'2026-11-11T00:00:05.000Z'},identity='d'.repeat(64);
 return ['first','second'].map((jobId,index)=>{const seconds=index?20:0,at=offset=>new Date(Date.UTC(2026,10,11,0,0,seconds+offset)).toISOString();return {jobId,status:'completed',evidenceVerified:true,sourceSha256:(index?'b':'a').repeat(64),requestIds:['request-'+index],startedAt:at(0),finishedAt:at(9),beforeProcesses:index?[llm]:[],afterProcesses:[llm],jobProcesses:[{recordId:'synthetic-ocr-'+index,pid:60+index,role:'OCR_RUNTIME',birthJobId:jobId,bornAt:at(1),closed:true,closedAt:at(4),code:0,errorCode:null},...(index?[]:[llm])],runtimeEvents:[{phase:'ocr_runtime_cache',mode:'disabled',at:at(0)},{phase:'ocr_status_start',at:at(1)},{phase:'ocr_status_complete',ready:true,durationMs:100,at:at(2)},{phase:'ocr_recognition_start',at:at(2)},{phase:'ocr_recognition_complete',speechRegions:1,durationMs:100,at:at(3)},{phase:'translation_runtime_cache',mode:index?'warm':'cold',generation:1,identity,at:at(5)}]};});
}
test('OCR-cold preparation has explicit mode and refinement flags without silently changing execute plans',()=>{
 assert.equal(outer.parseArguments(['--ocr-cold']).ocrCold,true);assert.equal(outer.parseArguments(['--refine-connected-ocr']).refineConnectedOcr,true);assert.throws(()=>outer.parseArguments(['--execute','E:/existing','--ocr-cold']),/USAGE/);
 const base={buildRoot:'C:/compiled',rendererBundle:'C:/renderer.js'},args={runRoot:'E:/new',modelPath:'E:/small.gguf',projectorPath:'E:/small-projector.gguf',runtimeReuseMode:coldMode};
 const config=outer.candidateConfiguration(base,args);assert.equal(config.reuseOcrRuntime,false);assert.equal(config.reuseTranslationServer,true);assert.equal(config.refineConnectedOcr,false);
 assert.throws(()=>outer.candidateConfiguration(base,{...args,refineConnectedOcr:true}),/REFINEMENT/);
 const refined=outer.candidateConfiguration(base,{...args,refineConnectedOcr:true,vision:{regionDetectorWorker:'C:/detect.py',regionDetectorModel:'E:/detect.onnx'}});assert.equal(refined.refineConnectedOcr,true);
});
test('explicit plan runtime/refinement settings bind exact boolean config before bootstrap or execution',()=>{
 need(inner,'validateRuntimeConfiguration');const plan={runtimeReuseMode:coldMode,refineConnectedOcr:false},config={reuseOcrRuntime:false,reuseTranslationServer:true,refineConnectedOcr:false};assert.doesNotThrow(()=>inner.validateRuntimeConfiguration(plan,config));
 for(const value of [{...config,reuseOcrRuntime:true},{...config,reuseTranslationServer:false},{...config,reuseOcrRuntime:'false'},{...config,refineConnectedOcr:true}])assert.throws(()=>inner.validateRuntimeConfiguration(plan,value),/RUNTIME_CONFIG|REFINEMENT/);
 assert.throws(()=>inner.validateRuntimeConfiguration({runtimeReuseMode:'unknown',refineConnectedOcr:false},config),/REUSE_MODE/);assert.throws(()=>inner.validateRuntimeConfiguration({...plan,refineConnectedOcr:true},{...config,refineConnectedOcr:true}),/REFINEMENT/);
 assert.doesNotThrow(()=>inner.validateRuntimeConfiguration({},{}),'historic bootstrap plans remain compatible');
 assert.doesNotThrow(()=>inner.validateRuntimeConfiguration({runtimeReuseMode:bothMode,refineConnectedOcr:false},{...config,reuseOcrRuntime:true}));
});
test('translation-only reuse proves separate closed OCR jobs and preserves both-warm proof requirements',()=>{
 const pages=coldPages(),proof=inner.cacheProof(pages,{runtimeReuseMode:coldMode});assert.equal(proof.verified,true);assert.equal(proof.runtimeReuseMode,coldMode);assert.equal(proof.ocr.reused,false);assert.equal(proof.ocr.jobs.length,2);assert.deepEqual(proof.translation.pids,[51]);assert.equal(inner.cacheProof(pages).verified,false,'OCR-cold may never pass the legacy both-warm proof');
});
test('OCR-cold proof fails closed for readiness, recognition, independent lifecycle, source and LLM drift',()=>{
 for(const defect of ['not ready','no recognition','open OCR','foreign OCR','same OCR record','OCR still live','missing lifecycle','OCR closes after translation','LLM PID changed','LLM record changed','LLM invalid PID','LLM missing lifecycle','missing completed proof','reused request']){const pages=coldPages();
  if(defect==='not ready')pages[1].runtimeEvents[2].ready=false;
  if(defect==='no recognition')pages[1].runtimeEvents=pages[1].runtimeEvents.filter(event=>event.phase!=='ocr_recognition_complete');
  if(defect==='open OCR')pages[1].jobProcesses[0].closed=false;
  if(defect==='foreign OCR')pages[1].jobProcesses[0].birthJobId=pages[0].jobId;
  if(defect==='same OCR record')pages[1].jobProcesses[0].recordId=pages[0].jobProcesses[0].recordId;
  if(defect==='OCR still live')pages[1].afterProcesses.push({...pages[1].jobProcesses[0],closed:false});
  if(defect==='missing lifecycle')delete pages[1].jobProcesses;
  if(defect==='OCR closes after translation')pages[1].jobProcesses[0].closedAt='2026-11-11T00:00:26.000Z';
  if(defect==='LLM PID changed')pages[1].afterProcesses=[{...pages[1].afterProcesses[0],pid:999}];
  if(defect==='LLM record changed')pages[1].beforeProcesses=[{...pages[1].beforeProcesses[0],recordId:'foreign'}];
  if(defect==='LLM invalid PID')pages[1].afterProcesses[0].pid=-1;
  if(defect==='LLM missing lifecycle')pages[0].jobProcesses=pages[0].jobProcesses.filter(record=>record.role!=='LLM_SERVER');
  if(defect==='missing completed proof')pages[1].evidenceVerified=undefined;
  if(defect==='reused request')pages[1].requestIds=pages[0].requestIds;
  assert.equal(inner.cacheProof(pages,{runtimeReuseMode:coldMode}).verified,false,defect);
 }
});

test('final completion verdict preserves completed pages when the root or supervisor fails after inner completion',()=>{
 need(outer,'warmCompletionVerdict');
 for(const configuredMode of [undefined,bothMode,coldMode]){
  const mode=configuredMode??bothMode,pages=coldPages();
  if(mode===bothMode){const llm=pages[0].afterProcesses[0],ocr={recordId:'synthetic-retained-ocr',pid:52,role:'OCR_RUNTIME',birthJobId:'first',closed:false,bornAt:'2026-11-11T00:00:01.000Z'};for(const [index,page]of pages.entries()){page.beforeProcesses=index?[ocr,llm]:[];page.afterProcesses=[ocr,llm];page.jobProcesses=index?[]:[ocr,llm];page.runtimeEvents=[{phase:'ocr_runtime_cache',mode:index?'warm':'cold',generation:1,identity:'e'.repeat(64)},page.runtimeEvents.at(-1)];}}
  const plan=configuredMode?{runtimeReuseMode:mode,refineConnectedOcr:false}:{},inner={status:'completed',cleanupConfirmed:true,failure:null,runtimeReuseMode:mode,refineConnectedOcr:false,pages,cacheReuse:innerCache(pages,mode)},receipt={phase:'complete',rootExitCode:0,supervisorExitCode:0,supervisorClosed:true,supervisorSignal:null,kernelCleanupConfirmed:true,activeProcessesAfter:0,failure:null};
  const args={plan,inner,jobReceipt:receipt,cleanup:true,sourceUnchanged:true,failure:null,stopCode:null},good=outer.warmCompletionVerdict(args);assert.equal(good.verified,true);assert.equal(good.status,mode===coldMode?'verified_translation_reuse':'verified_runtime_reuse');
  for(const defect of ['root exit','supervisor exit','receipt failure','supervisor signal','supervisor open','active kernel child','inner failure','outer failure']){
   const current=structuredClone(args);if(defect==='root exit')current.jobReceipt.rootExitCode=1;if(defect==='supervisor exit')current.jobReceipt.supervisorExitCode=1;if(defect==='receipt failure')current.jobReceipt.failure='WARM_JOB_RECEIPT_FAILURE';if(defect==='supervisor signal')current.jobReceipt.supervisorSignal='SIGTERM';if(defect==='supervisor open')current.jobReceipt.supervisorClosed=false;if(defect==='active kernel child')current.jobReceipt.activeProcessesAfter=1;if(defect==='inner failure')current.inner.failure='INNER_LATE_FAILURE';if(defect==='outer failure')current.failure='OUTER_LATE_FAILURE';
   const before=structuredClone(current),result=outer.warmCompletionVerdict(current);assert.equal(result.verified,false,mode+' '+defect);assert.equal(result.status,'partial',mode+' '+defect);assert.ok(result.failure);assert.deepEqual(current,before,'pure verdict must preserve both completed page records');assert.equal(current.inner.pages.every(page=>page.status==='completed'&&page.evidenceVerified===true),true);
  }
 }
});
function innerCache(pages,mode){return inner.cacheProof(pages,{runtimeReuseMode:mode});}
