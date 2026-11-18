// Prepare by default. Native execution requires an explicit --execute plus a fresh source receipt.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';
import {isDeepStrictEqual} from 'node:util';
import {createWarmJob} from './warm-job.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),require=createRequire(import.meta.url);
const {ProcessOwner,secretlessEnvironment,collectProcess,waitBounded,imageHeader}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const {validatePlan,runtimeReuseMode,validateRuntimeConfiguration,cacheProof,cleanupConfirmed,sanitizeStartupEvent}=require('../../apps/engine/verify-warm.cjs');
const baseOutput='E:/Dev/Outputs/MangohanaV2-20261111',sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>Object.assign(new Error(code),{code}),codeOf=error=>/^[A-Z0-9_]{1,80}$/.test(error?.code??'')?error.code:'WARM_HARNESS_FAILED';
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const within=(directory,file)=>path.resolve(file).toLowerCase().startsWith(path.resolve(directory).toLowerCase()+path.sep);
const json=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2),{flag:'wx'});
async function hashFile(file,signal){const digest=createHash('sha256');for await(const chunk of createReadStream(file,signal?{signal}:undefined))digest.update(chunk);return digest.digest('hex');}
const regular=async file=>{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw fail('WARM_REGULAR_FILE_REQUIRED');return stat;};

export function parseArguments(args){
 const result={mode:'prepare',config:path.join(baseOutput,'engine-config.json'),inputs:path.join(baseOutput,'inputs-japanese'),outputRoot:baseOutput,withContext:false,ocrCold:false,refineConnectedOcr:false,timeoutMs:30*60_000};let explicit=false;
 for(let index=0;index<args.length;index++){
  const key=args[index];
  if(['--prepare','--execute','--refresh','--bootstrap-only'].includes(key)){if(explicit)throw fail('WARM_USAGE');explicit=true;result.mode=key.slice(2);if(key!=='--prepare'){if(!args[index+1]||args[index+1].startsWith('--'))throw fail('WARM_USAGE');result.directory=path.resolve(args[++index]);}continue;}
  if(key==='--with-context'){result.withContext=true;continue;}
  if(key==='--ocr-cold'){result.ocrCold=true;continue;}
  if(key==='--refine-connected-ocr'){result.refineConnectedOcr=true;continue;}
  const fields={'--config':'config','--inputs':'inputs','--output-root':'outputRoot','--vision-config':'visionConfig','--receipt':'receipt','--timeout-ms':'timeoutMs'};
  if(!fields[key]||!args[index+1]||args[index+1].startsWith('--'))throw fail('WARM_USAGE');result[fields[key]]=args[++index];
 }
 result.timeoutMs=Number(result.timeoutMs);if(!Number.isSafeInteger(result.timeoutMs)||result.timeoutMs<1000||result.timeoutMs>60*60_000)throw fail('WARM_USAGE');
 if(result.mode!=='prepare'&&(result.ocrCold||result.refineConnectedOcr))throw fail('WARM_USAGE');
 return result;
}
export function selectTechnicalSamples(files){
 const unique=new Map();for(const file of [...files].sort((a,b)=>a.sha256.localeCompare(b.sha256)||a.path.localeCompare(b.path)))if(!unique.has(file.sha256))unique.set(file.sha256,file);
 if(unique.size<2)throw fail('WARM_DISTINCT_SOURCES_REQUIRED');return [...unique.values()].slice(0,2);
}
export function candidateConfiguration(base,{runRoot,modelPath,projectorPath,vision={},runtimeReuseMode:mode='OCR_WARM_TRANSLATION_WARM',refineConnectedOcr=false}){
 if(![runRoot,modelPath,projectorPath].every(value=>typeof value==='string'&&/^E:[\\/]/i.test(value)))throw fail('WARM_ISOLATION_REQUIRED');
 const fields=['repository','buildRoot','resourcesPath','rendererBundle','installedLocalAppData','llamaServer','python','lamaWorker','lamaModel','lamaTileWrapper','mangaOcr'];
 const selected=Object.fromEntries(fields.filter(key=>base[key]!==undefined).map(key=>[key,structuredClone(base[key])]));
 for(const key of ['regionDetectorWorker','regionDetectorModel','textMaskWorker','textMaskModel','textMaskAlgorithm'])if(vision[key]!==undefined)selected[key]=vision[key];
 if(Boolean(selected.regionDetectorWorker)!==Boolean(selected.regionDetectorModel)||Boolean(selected.textMaskWorker)!==Boolean(selected.textMaskModel)||selected.textMaskWorker&&!selected.regionDetectorWorker)throw fail('WARM_VISION_PAIR_REQUIRED');
 if(selected.textMaskAlgorithm!==undefined&&(typeof selected.textMaskAlgorithm!=='string'||!/^[-A-Za-z0-9._:]{1,128}$/.test(selected.textMaskAlgorithm)))throw fail('WARM_MASK_ALGORITHM_INVALID');
 runtimeReuseMode({runtimeReuseMode:mode,refineConnectedOcr});
 const candidate={...selected,runRoot,profileRoot:path.join(runRoot,'profile'),dataRoot:path.join(runRoot,'jobs'),rendererBundle:base.rendererBundle??path.join(path.dirname(base.buildRoot),'renderer.js'),gemmaModel:modelPath,mmproj:projectorPath,modelAlias:'gemma4-e2b-local',llamaStartupMs:300_000,llamaLoadMode:'none',pageContextTranslation:true,reuseOcrRuntime:mode==='OCR_WARM_TRANSLATION_WARM',reuseTranslationServer:true,refineConnectedOcr};
 validateRuntimeConfiguration({runtimeReuseMode:mode,refineConnectedOcr},candidate);return candidate;
}
export function assertFreshSourceReceipt(receipt,entries,now=Date.now()){
 const age=now-Date.parse(receipt.createdAt);if(!Number.isFinite(age)||age<0||age>10*60_000)throw fail('WARM_SOURCE_RECEIPT_STALE');
 if(JSON.stringify(receipt.entries)!==JSON.stringify(entries))throw fail('WARM_SOURCE_CHANGED');
}
export function parseGpuObservation(text){
 const fields=text.trim().split(/\r?\n/)[0].split(',');if(fields.some(value=>!value.trim()))throw fail('GPU_MONITOR_FORMAT');const values=fields.map(value=>Number(value.trim()));
 if(values.length!==3||values.some(value=>!Number.isFinite(value)||value<0)||values[0]<=0||values[1]+values[2]>values[0]+64)throw fail('GPU_MONITOR_FORMAT');
 return {gpuTotalMiB:values[0],gpuUsedMiB:values[1],gpuFreeMiB:values[2]};
}
export function createStartupEventReader(onEvent){
 const decoder=new StringDecoder('utf8');let buffer='';return bytes=>{buffer=(buffer+decoder.write(bytes)).slice(-65536);let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const event=sanitizeStartupEvent(JSON.parse(line));if(event)onEvent(event);}catch{}}};
}
const nativeExitClean=receipt=>receipt?.phase==='complete'&&receipt.rootExitCode===0&&receipt.supervisorExitCode===0&&receipt.supervisorClosed===true&&receipt.supervisorSignal==null&&receipt.failure==null&&receipt.kernelCleanupConfirmed===true&&receipt.activeProcessesAfter===0;
/** Pure final decision; completed page evidence survives a late native crash. */
export function warmCompletionVerdict({plan,inner,jobReceipt,cleanup,sourceUnchanged,failure=null,stopCode=null}){
 const mode=runtimeReuseMode(plan),proof=cacheProof(inner?.pages??[],{runtimeReuseMode:mode}),modeMatches=(inner?.runtimeReuseMode??'OCR_WARM_TRANSLATION_WARM')===mode&&(inner?.refineConnectedOcr??false)===(plan.refineConnectedOcr===true),nativeExitConfirmed=nativeExitClean(jobReceipt);
 const verified=inner?.status==='completed'&&inner.failure==null&&inner.cacheReuse?.verified===true&&proof.verified===true&&isDeepStrictEqual(proof,inner.cacheReuse)&&modeMatches&&cleanup===true&&sourceUnchanged===true&&nativeExitConfirmed&&failure==null&&stopCode==null;
 return {mode,verified,nativeExitConfirmed,status:verified?(mode==='OCR_COLD_TRANSLATION_WARM'?'verified_translation_reuse':'verified_runtime_reuse'):inner?.pages?.some(page=>page.evidenceVerified===true)?'partial':'failed',failure:failure??stopCode??inner?.failure??(!nativeExitConfirmed?'WARM_NATIVE_EXIT_NOT_CLEAN':!verified?'WARM_REUSE_NOT_VERIFIED':null)};
}
async function tree(directory,extension){
 const result=[];for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name),stat=await fs.lstat(file);if(stat.isSymbolicLink())throw fail('WARM_SOURCE_LINK_REJECTED');if(stat.isDirectory())result.push(...await tree(file,extension));else if(stat.isFile()&&(!extension||file.endsWith(extension)))result.push(file);}
 return result.sort();
}
async function entriesFor(files){return Promise.all([...new Set(files.map(file=>path.resolve(file)))].sort().map(async file=>{const stat=await regular(file);return {path:file,bytes:stat.size,sha256:await hashFile(file)};}));}
async function applicationCodeEntries(config){return entriesFor([...await tree(config.buildRoot),...await tree(config.resourcesPath),config.rendererBundle]);}
async function sourcePaths(plan,config){
 const fixed=['apps/engine/host.cjs','apps/engine/store.mjs','apps/engine/context.mjs','apps/engine/result.mjs','apps/engine/verify-warm.cjs','scripts/v2/verify-warm-pages.mjs','scripts/v2/warm-job.mjs','scripts/v2/warm-job.ps1','packages/ai-engine/package.json','packages/ai-engine/package-lock.json','apps/sites/lib/studio-files.ts','apps/sites/lib/studio-model.ts','apps/sites/lib/studio-local-translation.ts'].map(file=>path.join(root,file));
 const vendor=path.join(config.repository,'scripts/sites-local');for(const name of ['engine.cjs','engine-boundaries.cjs','run-metrics.cjs','translation-launch.cjs'])fixed.push(path.join(vendor,name));
 fixed.push(...await tree(path.join(root,'packages/ai-engine/quality'),'.cjs'));
 for(const directory of [path.join(root,'scripts/v2/vision'),path.join(config.repository,'scripts/sites-local'),path.join(config.resourcesPath,'managed-ocr'),path.join(config.resourcesPath,'managed-inpainting')])try{fixed.push(...await tree(directory,'.py'));}catch(error){if(error.code!=='ENOENT')throw error;}
 for(const key of ['lamaWorker','lamaTileWrapper','regionDetectorWorker','textMaskWorker'])if(config[key])fixed.push(config[key]);
 fixed.push(plan.configPath,...plan.applicationCode.entries.map(file=>file.path),path.join(root,'packages/ai-engine/node_modules/electron/package.json'));return fixed;
}
async function readPlan(directory){
 const file=path.join(directory,'warm-plan.json'),bytes=await fs.readFile(file),plan=validatePlan(JSON.parse(bytes));if(!same(plan.runRoot,directory))throw fail('WARM_PLAN_ROOT_MISMATCH');
 if(!same(await fs.realpath(directory),directory))throw fail('WARM_RUN_LINK_REJECTED');const configBytes=await fs.readFile(plan.configPath);if(sha(configBytes)!==plan.configSha256)throw fail('WARM_CONFIG_CHANGED');
 const config=JSON.parse(configBytes);if(!same(config.runRoot,directory))throw fail('WARM_CONFIG_ISOLATION');for(const key of ['profileRoot','dataRoot'])if(!within(directory,config[key]))throw fail('WARM_CONFIG_ISOLATION');
 validateRuntimeConfiguration(plan,config);
 for(const target of [config.profileRoot,config.dataRoot,path.join(directory,'inputs')]){const stat=await fs.lstat(target);if(!stat.isDirectory()||stat.isSymbolicLink()||!same(await fs.realpath(target),target))throw fail('WARM_DIRECTORY_LINK_REJECTED');}
 return {plan,planSha256:sha(bytes),config};
}
async function verifyApplicationCode(plan,config){
 if(JSON.stringify(plan.applicationCode.entries)!==JSON.stringify(await applicationCodeEntries(config)))throw fail('WARM_IMMUTABLE_APPLICATION_CODE_CHANGED');
}
export async function refreshSourceReceipt(directory){
 const {plan,planSha256,config}=await readPlan(directory);await verifyApplicationCode(plan,config);
 const receipt={version:1,runId:plan.runId,planSha256,createdAt:new Date().toISOString(),state:'FRESH_SOURCE_ONLY_NOT_NATIVE_EXECUTION',entries:await entriesFor(await sourcePaths(plan,config))};
 const file=path.join(directory,'source-receipt-'+Date.now()+'-'+randomUUID().slice(0,8)+'.json');await json(file,receipt);return {receiptPath:file,receiptSha256:await hashFile(file),sourceFiles:receipt.entries.length};
}
export async function prepareWarmRun(options){
 if(!/^E:[\\/]/i.test(options.outputRoot))throw fail('WARM_ISOLATION_REQUIRED');
 const baseBytes=await fs.readFile(path.resolve(options.config)),base=JSON.parse(baseBytes),resources=JSON.parse(await fs.readFile(path.join(root,'scripts/v2/resources.json'),'utf8')),multimodal=JSON.parse(await fs.readFile(path.join(root,'scripts/v2/multimodal-resources.json'),'utf8'));
 const small=resources.resources.find(resource=>resource.id==='gemma-e2b'),projector=multimodal.resources.find(resource=>resource.id==='gemma-e2b-mmproj-f16');
 const modelPins=[small,projector].map(resource=>({id:resource.id,path:path.join(resources.roots.models,resource.fileName),bytes:resource.bytes,sha256:resource.sha256}));
 for(const pin of modelPins)if((await regular(pin.path)).size!==pin.bytes)throw fail('WARM_MODEL_SIZE_MISMATCH');
 const candidates=[];for(const entry of await fs.readdir(path.resolve(options.inputs),{withFileTypes:true})){if(!entry.isFile()||!entry.name.toLowerCase().endsWith('.png'))continue;const file=path.resolve(options.inputs,entry.name),stat=await regular(file);if(stat.size>8*1024*1024)throw fail('WARM_INPUT_LIMIT');const bytes=await fs.readFile(file),header=imageHeader(bytes,'image/png');candidates.push({path:file,sha256:sha(bytes),bytes:bytes.length,width:header.width,height:header.height});}
 const selected=selectTechnicalSamples(candidates),runId=randomUUID(),runRoot=path.resolve(options.outputRoot,'warm-pages-'+new Date().toISOString().replaceAll(':','-')+'-'+runId.slice(0,8));await fs.mkdir(runRoot);
 const visionBytes=options.visionConfig?await fs.readFile(path.resolve(options.visionConfig)):null,vision=visionBytes?JSON.parse(visionBytes):{};
 const config=candidateConfiguration(base,{runRoot,modelPath:modelPins[0].path,projectorPath:modelPins[1].path,vision,runtimeReuseMode:options.ocrCold?'OCR_COLD_TRANSLATION_WARM':'OCR_WARM_TRANSLATION_WARM',refineConnectedOcr:options.refineConnectedOcr===true});
 await fs.mkdir(config.profileRoot);await fs.mkdir(config.dataRoot);
 const applicationEntries=await applicationCodeEntries(config);
 await fs.mkdir(path.join(runRoot,'inputs'));const inputs=[];
 for(const [index,file]of selected.entries()){const bytes=await fs.readFile(file.path);if(sha(bytes)!==file.sha256)throw fail('WARM_SOURCE_CHANGED');const name=String(index+1).padStart(2,'0')+'-'+file.sha256+'.png',copyPath=path.join(runRoot,'inputs',name);await fs.writeFile(copyPath,bytes,{flag:'wx'});inputs.push({ordinal:index+1,pageId:randomUUID(),name,originalPath:file.path,copyPath,sourceSha256:file.sha256,bytes:file.bytes,width:file.width,height:file.height});}
 const configPath=path.join(runRoot,'candidate-config.json');await json(configPath,config);
 const plan={version:1,status:'prepared',scope:'TWO_DISTINCT_JAPANESE_TECHNICAL_SAMPLES',runId,runRoot,configPath,configSha256:await hashFile(configPath),baseConfig:{path:path.resolve(options.config),sha256:sha(baseBytes)},visionConfig:visionBytes?{path:path.resolve(options.visionConfig),sha256:sha(visionBytes)}:null,inputs,selectedFromCandidates:candidates.length,technicalOrder:'SHA256_ASCENDING_DISTINCT_CONTENT_NOT_STORY_ORDER',storyChronologyVerified:false,browserFlowVerified:false,manualCorrections:0,realAiRun:false,withContext:options.withContext===true,ownerScope:sha(Buffer.from(runId)),projectId:'warm-'+runId,modelPins,applicationCode:{scope:'ORIGINAL_C_APPLICATION_CODE_READ_ONLY_FULL_HASH_BEFORE_AND_AFTER',entries:applicationEntries},copyAccounting:{inputCopies:inputs.length,inputBytes:inputs.reduce((sum,input)=>sum+input.bytes,0),applicationCodeCopiedBytes:0,applicationCodeFilesHashed:applicationEntries.length,applicationCodeBytesHashed:applicationEntries.reduce((sum,file)=>sum+file.bytes,0)},policy:{hostIntervalMs:2000,gpuIntervalMs:2000,gpuProbeTimeoutMs:20_000,hostAbortBelowMiB:512,gpuAbortBelowFreeMiB:128,totalTimeoutMs:options.timeoutMs,pageTimeoutMs:Math.min(options.timeoutMs,20*60_000),cleanupTimeoutMs:20_000,forceGraceMs:30_000}};
 plan.runtimeReuseMode=config.reuseOcrRuntime?'OCR_WARM_TRANSLATION_WARM':'OCR_COLD_TRANSLATION_WARM';plan.refineConnectedOcr=config.refineConnectedOcr;
 validatePlan(plan);await json(path.join(runRoot,'warm-plan.json'),plan);const receipt=await refreshSourceReceipt(runRoot);return {status:'prepared',runRoot,plan:path.join(runRoot,'warm-plan.json'),...receipt,realAiCalls:0,nativeModelsStarted:0,storyChronologyVerified:false,withContext:plan.withContext,runtimeReuseMode:plan.runtimeReuseMode,refineConnectedOcr:plan.refineConnectedOcr};
}

export async function executeWarmRun(directory,receiptPath,{bootstrapOnly=false}={}){
 if(!receiptPath)throw fail('WARM_SOURCE_RECEIPT_REQUIRED');
 const {plan,planSha256,config}=await readPlan(directory);await verifyApplicationCode(plan,config);if(!within(directory,receiptPath))throw fail('WARM_RECEIPT_ISOLATION');
 const receipt=JSON.parse(await fs.readFile(receiptPath));if(receipt.runId!==plan.runId||receipt.planSha256!==planSha256)throw fail('WARM_RECEIPT_MISMATCH');assertFreshSourceReceipt(receipt,await entriesFor(await sourcePaths(plan,config)));
 try{await fs.access(path.join(directory,'execution-start.json'));throw fail('WARM_ALREADY_STARTED_NO_AUTOMATIC_RETRY');}catch(error){if(error.code!=='ENOENT')throw error;}
 await json(path.join(directory,'execution-start.json'),{runId:plan.runId,at:new Date().toISOString(),planSha256,controllerPid:process.pid,receiptPath,receiptSha256:await hashFile(receiptPath),scope:bootstrapOnly?'BOOTSTRAP_ONLY_NO_AI':plan.scope});
 const owner=new ProcessOwner(),controller=new AbortController(),started=performance.now(),samples=[],monitorErrors=[],startupEvents=[];let child,jobReceipt=null,forced=false,outerCleanupFailed=false,stopCode=null,stopAt=null,gpuBusy=false,lastGpu=Promise.resolve(),hostTimer,gpuTimer,deadlineTimer,inner=null;
 const temp=path.join(directory,'monitor-temp');await fs.mkdir(temp);const monitors=new Set();
 async function stop(code){if(stopCode)return;stopCode=code;stopAt=Date.now();controller.abort(fail(code));try{await json(path.join(directory,'STOP-'+plan.runId),{code,at:new Date().toISOString()});}catch{}for(const record of monitors)if(!record.closed)void owner.terminate(record).catch(()=>{outerCleanupFailed=true;});}
 const sampleHost=phase=>{const total=os.totalmem(),available=os.freemem(),sample={sampleType:'HOST_RAM',phase,elapsedMs:Math.round(performance.now()-started),sampleStatus:Number.isFinite(total)&&total>0&&Number.isFinite(available)&&available>=0?'succeeded':'failed',osTotalMiB:Number.isFinite(total)?total/1048576:null,osAvailableMiB:Number.isFinite(available)?available/1048576:null};samples.push(sample);if(sample.sampleStatus==='failed')void stop('HOST_MONITOR_FAILED');else if(available<plan.policy.hostAbortBelowMiB*1048576)void stop('HOST_MEMORY_PRESSURE');};
 async function sampleGpu(phase){
  const sample={sampleType:'GPU_NVML',phase,elapsedMs:Math.round(performance.now()-started)};let record;
  try{const executable=path.join(process.env.SystemRoot??'C:/Windows','System32/nvidia-smi.exe'),env=secretlessEnvironment(executable,temp);for(const key of ['ProgramW6432','ProgramFiles','ProgramData','ALLUSERSPROFILE'])if(process.env[key])env[key]=process.env[key];record=owner.spawn(executable,['--query-gpu=memory.total,memory.used,memory.free','--format=csv,noheader,nounits'],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env});monitors.add(record);const bytes=await waitBounded(collectProcess(record,{stdoutLimit:4096,stderrLimit:4096})(),plan.policy.gpuProbeTimeoutMs,'GPU_MONITOR_TIMEOUT');Object.assign(sample,{sampleStatus:'succeeded',...parseGpuObservation(bytes.toString('utf8'))});if(sample.gpuFreeMiB<plan.policy.gpuAbortBelowFreeMiB)void stop('GPU_MEMORY_PRESSURE');}
  catch(error){sample.sampleStatus='failed';sample.error=codeOf(error);monitorErrors.push({phase,error:sample.error});if(!stopCode)void stop('GPU_MONITOR_FAILED');}
  finally{if(record&&!record.closed)try{await owner.terminate(record);}catch{outerCleanupFailed=true;void stop('CLEANUP_UNCONFIRMED');}if(record)monitors.delete(record);samples.push(sample);}
 }
 const onInterrupt=()=>void stop('INTERRUPTED');process.once('SIGINT',onInterrupt);process.once('SIGTERM',onInterrupt);
 let failure=null,assetIntegrity=[];
 deadlineTimer=setTimeout(()=>void stop('WARM_TOTAL_TIMEOUT'),bootstrapOnly?Math.min(plan.policy.totalTimeoutMs,60_000):plan.policy.totalTimeoutMs);
 try{
  sampleHost('before_assets');hostTimer=setInterval(()=>sampleHost(child?(bootstrapOnly?'bootstrap_active':'engine_active'):'before_engine'),2000);if(!bootstrapOnly)await sampleGpu('before_assets');if(stopCode)throw fail(stopCode);
  for(const pin of plan.modelPins){const before=await regular(pin.path),digest=await hashFile(pin.path,controller.signal),stat=await regular(pin.path);if(stat.size!==pin.bytes||before.size!==stat.size||before.mtimeMs!==stat.mtimeMs||digest!==pin.sha256)throw fail('WARM_MODEL_HASH_MISMATCH');assetIntegrity.push({...pin,verifiedAt:new Date().toISOString(),observedSha256:digest,mtimeMs:stat.mtimeMs});if(stopCode)throw fail(stopCode);}
  await json(path.join(directory,'asset-integrity.json'),{kind:'FULL_SHA256_BEFORE_NATIVE_ENGINE',assets:assetIntegrity});
  assertFreshSourceReceipt(receipt,await entriesFor(await sourcePaths(plan,config)));for(const sample of plan.inputs)if(await hashFile(sample.originalPath)!==sample.sourceSha256||await hashFile(sample.copyPath)!==sample.sourceSha256)throw fail('WARM_SOURCE_CHANGED');
  await json(path.join(directory,'run-source-receipt.json'),receipt);
  const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));Object.assign(env,{TEMP:path.join(config.profileRoot,'temp'),TMP:path.join(config.profileRoot,'temp'),LOCALAPPDATA:config.installedLocalAppData,TRIO_DISABLE_AUTO_UPDATE:'true',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'});await fs.mkdir(env.TEMP,{recursive:true});
  const onStartup=event=>{if(startupEvents.length<16&&!startupEvents.some(previous=>JSON.stringify(previous)===JSON.stringify(event)))startupEvents.push(event);console.log(JSON.stringify(event));void stop('WARM_STARTUP_FAILED');},readStdoutStartup=createStartupEventReader(onStartup),readStderrStartup=createStartupEventReader(onStartup);
  let stdout='',stdoutBytes=0,stderrBytes=0;const onStdout=bytes=>{stdoutBytes+=bytes.length;readStdoutStartup(bytes);stdout=(stdout+bytes.toString('utf8')).slice(-65536);let split;while((split=stdout.indexOf('\n'))>=0){const line=stdout.slice(0,split);stdout=stdout.slice(split+1);try{const value=JSON.parse(line);if(value.phase==='startup_failed')continue;const safe=Object.fromEntries(['phase','status','ordinal','jobId','pageId','sourceSha256','regions','code','cleanupConfirmed'].filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));console.log(JSON.stringify(safe));if(value.phase==='cleanup_unconfirmed')void stop('CLEANUP_UNCONFIRMED');}catch{}}};
  child=await createWarmJob({directory,runId:plan.runId,executable:path.join(root,'packages/ai-engine/node_modules/electron/dist/electron.exe'),args:[path.join(root,'apps/engine/verify-warm.cjs'),...(bootstrapOnly?['--bootstrap-only']:[]),path.join(directory,'warm-plan.json')],cwd:root,env,cleanupMs:plan.policy.cleanupTimeoutMs,maxLifetimeMs:bootstrapOnly?Math.min(plan.policy.totalTimeoutMs,10_000):plan.policy.totalTimeoutMs,onStdout,onStderr:bytes=>{stderrBytes+=bytes.length;readStderrStartup(bytes);}});
  // The only native root is still suspended here; record the verified kernel gate first.
  await json(path.join(directory,'execution-gate.json'),{runId:plan.runId,at:new Date().toISOString(),planSha256,controllerPid:process.pid,...child.ready,scope:plan.scope});if(stopCode)throw fail(stopCode);await child.resume();
  if(!bootstrapOnly)gpuTimer=setInterval(()=>{if(gpuBusy||stopCode){samples.push({sampleType:'GPU_NVML',sampleStatus:'not_observed',reason:gpuBusy?'PROBE_IN_FLIGHT':'STOPPING',elapsedMs:Math.round(performance.now()-started)});return;}gpuBusy=true;lastGpu=sampleGpu('engine_active').finally(()=>{gpuBusy=false;});},2000);
  while(!child.closed){if(stopCode&&Date.now()-stopAt>plan.policy.forceGraceMs){forced=true;await child.stop();break;}if(['CLEANUP_UNCONFIRMED','WARM_STARTUP_FAILED'].includes(stopCode)){forced=true;await child.stop();break;}await new Promise(resolve=>setTimeout(resolve,200));}
  jobReceipt=await child.completion;
  await json(path.join(directory,'native-output-summary.json'),{stdoutBytes,stderrBytes,rawOutputStored:false,startupEvents,exitCode:jobReceipt.rootExitCode??null,supervisorExitCode:jobReceipt.supervisorExitCode??null,forced});
  try{inner=JSON.parse(await fs.readFile(path.join(directory,bootstrapOnly?'verification-bootstrap-inner.json':'verification-inner.json')));}catch{failure=bootstrapOnly?'WARM_BOOTSTRAP_EVIDENCE_MISSING':'WARM_INNER_EVIDENCE_MISSING';}
 }catch(error){failure=stopCode??codeOf(error);if(child&&!child.closed){await stop(failure);forced=true;try{jobReceipt=await child.stop();}catch{outerCleanupFailed=true;}}}
 finally{
  try{await json(path.join(directory,'startup-events.json'),startupEvents);}catch{outerCleanupFailed=true;}
  if(child){jobReceipt??=await child.completion;if(jobReceipt.kernelCleanupConfirmed!==true)outerCleanupFailed=true;try{await json(path.join(directory,'kernel-job-summary.json'),jobReceipt);}catch{outerCleanupFailed=true;}}
  clearInterval(hostTimer);clearInterval(gpuTimer);clearTimeout(deadlineTimer);await lastGpu;try{await owner.cleanup();}catch{outerCleanupFailed=true;}sampleHost('after_cleanup');process.removeListener('SIGINT',onInterrupt);process.removeListener('SIGTERM',onInterrupt);
 }
 let sourceUnchanged=false;try{await verifyApplicationCode(plan,config);sourceUnchanged=JSON.stringify(await entriesFor(await sourcePaths(plan,config)))===JSON.stringify(receipt.entries);}catch{}if(!sourceUnchanged)failure??='WARM_SOURCE_CHANGED_DURING_RUN';
 if(bootstrapOnly){const verified=inner?.status==='BOOTSTRAP_ONLY_NO_AI'&&inner.scope==='BOOTSTRAP_ONLY_NO_AI'&&inner.runId===plan.runId&&inner.planSha256===planSha256&&inner.engineCreated===false&&inner.actualAiCalls===0&&Array.isArray(inner.pages)&&inner.pages.length===0&&inner.bootstrapReady===true&&inner.gateValidated===true&&inner.assetStatValidated===true&&nativeExitClean(jobReceipt)&&!outerCleanupFailed&&!forced&&[...owner.children.values()].every(record=>record.closed)&&sourceUnchanged&&!failure&&!stopCode;const result={version:1,status:verified?'BOOTSTRAP_ONLY_NO_AI':'failed',scope:'BOOTSTRAP_ONLY_NO_AI',runId:plan.runId,bootstrapVerified:verified,engineCreated:false,actualAiCalls:0,pages:[],browserFlowVerified:false,storyChronologyVerified:false,manualCorrections:0,failure:failure??stopCode??(!verified?'WARM_BOOTSTRAP_NOT_VERIFIED':null),primaryFailureCode:startupEvents[0]?.primaryFailureCode??null,bootstrapFailureStage:startupEvents[0]?.bootstrapStage??null,startupEvents,osJobCleanupConfirmed:jobReceipt?.kernelCleanupConfirmed??false,cleanupConfirmed:verified,sourceUnchanged,sourceReceipt:receiptPath,assetIntegrity,elapsedMs:Math.round(performance.now()-started),memoryObservations:{scope:'HOST_RAM_SAMPLED_BOOTSTRAP_NO_GPU_OR_MODELS',gpuObservation:'NOT_REQUIRED_BOOTSTRAP_ONLY_NO_AI',samples,monitorErrors}};await json(path.join(directory,'verification-bootstrap.json'),result);return result;}
 const cleanup=cleanupConfirmed({engineConfirmed:inner?.cleanupConfirmed===true,ownedChildrenClosed:jobReceipt?.kernelCleanupConfirmed===true&&!outerCleanupFailed&&[...owner.children.values()].every(record=>record.closed),forced});
 const verdict=warmCompletionVerdict({plan,inner,jobReceipt,cleanup,sourceUnchanged,failure,stopCode});
 const result={version:1,status:verdict.status,failure:verdict.failure,scope:plan.scope,runId:plan.runId,manualCorrections:0,browserFlowVerified:false,storyChronologyVerified:false,qualityStatus:'pending',contextMode:plan.withContext?'TECHNICAL_ORDER_CONTEXT_NOT_STORY_CHRONOLOGY':'OFF',runtimeReuseMode:verdict.mode,refineConnectedOcr:plan.refineConnectedOcr===true,pages:inner?.pages??[],cacheReuse:inner?.cacheReuse??{verified:false,reason:'INNER_EVIDENCE_MISSING'},cleanupConfirmed:cleanup,nativeExitConfirmed:verdict.nativeExitConfirmed,innerCleanupConfirmed:inner?.cleanupConfirmed??null,osJobCleanupConfirmed:jobReceipt?.kernelCleanupConfirmed??false,forcedTermination:forced,sourceUnchanged,preparedSourceNotAssumedFrozen:true,sourceReceipt:receiptPath,assetIntegrity,elapsedMs:Math.round(performance.now()-started),memoryObservations:{scope:'SYSTEM_WIDE_SAMPLED_NOT_PROCESS_EXCLUSIVE_OR_GUARANTEED_PEAK',hostIntervalMs:2000,gpuIntervalMs:2000,gpuProbeTimeoutMs:plan.policy.gpuProbeTimeoutMs,continuousOrPeakVerified:false,maxObservedGpuUsedMiB:samples.filter(sample=>sample.sampleType==='GPU_NVML'&&sample.sampleStatus==='succeeded').reduce((max,sample)=>Math.max(max??sample.gpuUsedMiB,sample.gpuUsedMiB),null),samples,monitorErrors},outerChildren:[...owner.children.values()].map(record=>({pid:record.child.pid??null,closed:record.closed,code:record.code??null,signal:record.signal??null})),paidApiCalls:0,externalInferenceCalls:0};
 result.primaryFailureCode=startupEvents[0]?.primaryFailureCode??null;result.bootstrapFailureStage=startupEvents[0]?.bootstrapStage??null;result.startupEvents=startupEvents;await json(path.join(directory,'verification-warm.json'),result);return result;
}

if(process.argv[1]&&same(process.argv[1],fileURLToPath(import.meta.url))){
 try{const options=parseArguments(process.argv.slice(2));const result=options.mode==='prepare'?await prepareWarmRun(options):options.mode==='refresh'?await refreshSourceReceipt(options.directory):await executeWarmRun(options.directory,options.receipt?path.resolve(options.receipt):undefined,{bootstrapOnly:options.mode==='bootstrap-only'});console.log(JSON.stringify(result));if(options.mode==='execute'&&!['verified_runtime_reuse','verified_translation_reuse'].includes(result.status)||options.mode==='bootstrap-only'&&result.status!=='BOOTSTRAP_ONLY_NO_AI')process.exitCode=1;}
 catch(error){console.error(JSON.stringify({status:'failed',code:codeOf(error),realAiExecutionNotAssumed:true}));process.exitCode=1;}
}
