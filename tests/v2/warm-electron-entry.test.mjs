// Real tiny Electron startup checks only: no valid plan, image, engine, model or AI call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {createWarmJob} from '../../scripts/v2/warm-job.mjs';
const require=createRequire(import.meta.url),inner=require('../../apps/engine/verify-warm.cjs');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),entry=path.join(root,'apps/engine/verify-warm.cjs');
const outputRoot=path.resolve(process.env.MANGOHANA_ENTRY_TEST_DIR??'E:/Dev/Outputs/MangohanaV2-20261111/tests/electron-entry-'+Date.now()+'-'+randomUUID().slice(0,6));
test('entry detection uses the normalized entry argv path and remains false for source-only imports',()=>{
 assert.equal(typeof inner.isDirectEntry,'function');assert.equal(inner.isDirectEntry([process.execPath,entry],entry),true);assert.equal(inner.isDirectEntry([process.execPath,path.join(root,'tests/v2/warm-electron-entry.test.mjs')],entry),false);assert.equal(inner.isDirectEntry([process.execPath],entry),false);assert.equal(Object.keys(require.cache).some(file=>file.endsWith(path.join('sites-local','engine.cjs'))),false);
});
test('startup diagnostics preserve only a safe error code and a known bootstrap stage',()=>{
 assert.equal(typeof inner.startupFailureEvent,'function');const event=inner.startupFailureEvent(Object.assign(new Error('PRIVATE_ENV_AND_AUTH_MUST_NOT_APPEAR'),{code:'ENOENT',bootstrapStage:'plan_read'}));assert.deepEqual(event,{phase:'startup_failed',code:'WARM_STARTUP_FAILED',primaryFailureCode:'ENOENT',bootstrapStage:'plan_read',cleanupConfirmed:false});assert.equal(JSON.stringify(event).includes('PRIVATE'),false);const unknown=inner.startupFailureEvent({message:'SECRET',code:'unsafe-path/key',bootstrapStage:'C:/private/SECRET'});assert.equal(unknown.primaryFailureCode,'WARM_VERIFICATION_FAILED');assert.equal(unknown.bootstrapStage,'unknown');assert.equal(JSON.stringify(unknown).includes('SECRET'),false);
});
async function launch(mode){
 const directory=path.join(outputRoot,mode+'-'+randomUUID().slice(0,6));await fs.mkdir(directory,{recursive:true});
 const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));Object.assign(env,{TEMP:directory,TMP:directory,LOCALAPPDATA:path.join(directory,'private-app-data'),TRIO_DISABLE_AUTO_UPDATE:'true'});await fs.mkdir(env.LOCALAPPDATA);
 const events=[];let text='',stderrBytes=0;const args=[entry,...(mode==='missing-plan'?[path.join(directory,'plan-does-not-exist.json')]:[])];
 const job=await createWarmJob({directory,runId:randomUUID(),executable:path.join(root,'packages/ai-engine/node_modules/electron/dist/electron.exe'),args,cwd:root,env,cleanupMs:4000,maxLifetimeMs:3000,onStdout:bytes=>{text+=bytes.toString('utf8');let end;while((end=text.indexOf('\n'))>=0){const line=text.slice(0,end);text=text.slice(end+1);try{events.push(JSON.parse(line));}catch{}}},onStderr:bytes=>{stderrBytes+=bytes.length;try{for(const line of bytes.toString('utf8').trim().split(/\r?\n/))events.push(JSON.parse(line));}catch{}}});
 await job.resume();const result=await job.completion;await fs.writeFile(path.join(directory,'entry-proof.json'),JSON.stringify({scope:'ACTUAL_ELECTRON_STARTUP_NO_VALID_PLAN_NO_AI',mode,events,result,stderrBytes,actualAiCalls:0},null,2),{flag:'wx'});return {directory,events,result};
}
test('real Electron CLI with a deliberately missing plan emits startup_failed and exits 1 promptly',{skip:process.platform!=='win32',timeout:15000},async()=>{
 const value=await launch('missing-plan');assert.equal(value.result.rootExitCode,1,'missing plan must exit before the lifetime watchdog');assert.equal(value.events.some(event=>event.phase==='startup_failed'&&event.code==='WARM_STARTUP_FAILED'&&event.primaryFailureCode==='ENOENT'&&event.bootstrapStage==='plan_read'),true);assert.equal(value.result.kernelCleanupConfirmed,true);assert.equal(value.result.activeProcessesAfter,0);
});
test('real Electron CLI with invalid argument count exits 1 instead of leaving its loop idle',{skip:process.platform!=='win32',timeout:15000},async()=>{
 const value=await launch('invalid-args');assert.equal(value.result.rootExitCode,1,'invalid args must explicitly exit Electron');assert.equal(value.events.some(event=>event.code==='WARM_PLAN_ARGUMENT_REQUIRED'),true);assert.equal(value.result.kernelCleanupConfirmed,true);assert.equal(value.result.activeProcessesAfter,0);
});

async function bootstrapOnly(mode){
 const directory=path.join(outputRoot,'bootstrap-positive-'+randomUUID().slice(0,6)),sha=bytes=>createHash('sha256').update(bytes).digest('hex');await fs.mkdir(directory,{recursive:true});await fs.mkdir(path.join(directory,'profile'));await fs.mkdir(path.join(directory,'jobs'));
 const pins=[];for(const [index,content]of ['SYNTHETIC_TEST_PIN_NOT_MODEL_A','SYNTHETIC_TEST_PIN_NOT_MODEL_B'].entries()){const file=path.join(directory,'not-a-model-'+index+'.bin'),bytes=Buffer.from(content);await fs.writeFile(file,bytes);const stat=await fs.lstat(file);pins.push({id:'SYNTHETIC_BOOTSTRAP_PIN_'+index,path:file,bytes:bytes.length,sha256:sha(bytes),observedSha256:sha(bytes),mtimeMs:stat.mtimeMs});}
 const configPath=path.join(directory,'candidate-config.json'),configBytes=Buffer.from(JSON.stringify({runRoot:directory,profileRoot:path.join(directory,'profile'),dataRoot:path.join(directory,'jobs'),...(mode?{reuseOcrRuntime:false,reuseTranslationServer:true,refineConnectedOcr:false}:{})}));await fs.writeFile(configPath,configBytes);
 const runId=randomUUID(),plan={version:1,scope:'TWO_DISTINCT_JAPANESE_TECHNICAL_SAMPLES',runId,runRoot:directory,configPath,configSha256:sha(configBytes),ownerScope:sha(runId),projectId:'synthetic-bootstrap',modelPins:pins,inputs:[{pageId:randomUUID(),sourceSha256:'a'.repeat(64)},{pageId:randomUUID(),sourceSha256:'b'.repeat(64)}],browserFlowVerified:false,storyChronologyVerified:false,manualCorrections:0,policy:{hostIntervalMs:2000,gpuIntervalMs:2000,hostAbortBelowMiB:512,gpuAbortBelowFreeMiB:128,pageTimeoutMs:3000,totalTimeoutMs:5000,gpuProbeTimeoutMs:1000,cleanupTimeoutMs:1000,forceGraceMs:1000}};
 if(mode){plan.runtimeReuseMode=mode;plan.refineConnectedOcr=false;}
 const planBytes=Buffer.from(JSON.stringify(plan)),planPath=path.join(directory,'warm-plan.json');await fs.writeFile(planPath,planBytes);await fs.writeFile(path.join(directory,'asset-integrity.json'),JSON.stringify({kind:'FULL_SHA256_BEFORE_NATIVE_ENGINE',assets:pins,fixtureWarning:'SYNTHETIC_BOOTSTRAP_FILES_NOT_MODELS'}));
 const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));Object.assign(env,{TEMP:directory,TMP:directory,LOCALAPPDATA:path.join(directory,'private-app-data'),TRIO_DISABLE_AUTO_UPDATE:'true'});await fs.mkdir(env.LOCALAPPDATA);
 const job=await createWarmJob({directory,runId,executable:path.join(root,'packages/ai-engine/node_modules/electron/dist/electron.exe'),args:[entry,'--bootstrap-only',planPath],cwd:root,env,cleanupMs:4000,maxLifetimeMs:4000});await fs.writeFile(path.join(directory,'execution-gate.json'),JSON.stringify({...job.ready,planSha256:sha(planBytes)}));await job.resume();const result=await job.completion;await fs.writeFile(path.join(directory,'bootstrap-job-proof.json'),JSON.stringify(result,null,2));assert.equal(result.rootExitCode,0,'model-free positive bootstrap must reach ready');assert.equal(result.kernelCleanupConfirmed,true);const report=JSON.parse(await fs.readFile(path.join(directory,'verification-bootstrap-inner.json'),'utf8'));assert.equal(report.status,'BOOTSTRAP_ONLY_NO_AI');assert.equal(report.scope,'BOOTSTRAP_ONLY_NO_AI');assert.equal(report.engineCreated,false);assert.equal(report.actualAiCalls,0);assert.deepEqual(report.pages,[]);assert.deepEqual(await fs.readdir(path.join(directory,'jobs')),[]);await assert.rejects(fs.access(path.join(directory,'verification-inner.json')));await assert.rejects(fs.access(path.join(directory,'verification-warm.json')));const {exportWarmPages}=await import('../../scripts/v2/export-warm-pages.mjs');await assert.rejects(exportWarmPages(directory),{code:'EXPORT_EVIDENCE_INVALID'});
 if(mode){assert.equal(report.runtimeReuseMode,mode);assert.equal(report.refineConnectedOcr,false);}
}
test('real Electron bootstrap-only validates its genuine gate before ready and exits without creating an engine or AI result',{skip:process.platform!=='win32',timeout:15000},()=>bootstrapOnly());
test('real Electron OCR-cold bootstrap binds its plan/config without creating a model or AI result',{skip:process.platform!=='win32',timeout:15000},()=>bootstrapOnly('OCR_COLD_TRANSLATION_WARM'));
