// Bounded private Windows Job controller. Owns only the process tree it creates.
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createWarmJob} from './warm-job.mjs';
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {secretlessEnvironment}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const {LIMITS}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const [mode,audit]=process.argv.slice(2),b=JSON.parse(await fs.readFile(path.join(audit,'evidence/baseline.json'),'utf8'));
const base=JSON.parse(await fs.readFile('E:/Dev/Outputs/MangohanaV2-20261111/engine-config.json','utf8'));
const directory=path.join(b.runRoot,mode+'-'+randomUUID().slice(0,8));await fs.mkdir(directory);
const json=(n,v)=>fs.writeFile(path.join(directory,n),JSON.stringify(v,null,2),{flag:'wx'});
const pageMode=['single-page','two-page'].includes(mode);
const reference=JSON.parse(await fs.readFile('E:/Dev/Outputs/MangohanaV2-20261111/warm-pages-2026-11-11T00-48-06.075Z-ceb347b6/candidate-config.json','utf8'));
const config={...reference,runRoot:directory,profileRoot:path.join(directory,'profile'),dataRoot:path.join(directory,'jobs'),continueDiagnostic:mode==='template-probe',resumeStage14:mode==='single-page',checkpointDirectory:'E:/Dev/Outputs/MangohanaV2-20261111/tests/MangoHana_14_20261113_172552/single-page-b4de0581/jobs/8ce988bc-398d-4dab-b52d-7fc7be1ae7ce'};
if(pageMode){
 const preflight=JSON.parse(await fs.readFile('C:/dev/Projects/_audits/MangoHana_14_20261113_172552/evidence/runtime-preflight.json','utf8'));
 const chosen=[...preflight.inputs].sort((a,b)=>a.sha256.localeCompare(b.sha256)).slice(0,mode==='single-page'?1:2);
 await fs.mkdir(path.join(directory,'inputs'));
 const inputs=[];for(const [i,input]of chosen.entries()){
  const name=String(i+1).padStart(2,'0')+'-'+input.sha256+'.png',copyPath=path.join(directory,'inputs',name);await fs.copyFile(input.path,copyPath,syncFs.constants.COPYFILE_EXCL);
  inputs.push({...input,name,copyPath,pageId:'stage14-page-'+(i+1),ordinal:i+1,scope:'EXISTING_DEVELOPMENT_PNG_BYTES_NO_MANUAL_CORRECTION'});
 }
 await json('inputs.json',inputs);
}
await json('config.json',config);
const nativeHelp=mode==='native-help',nativeVersion=mode==='native-version';
if(!['diagnostic','template-probe','single-page','two-page'].includes(mode))throw Error('EXPLICIT_STAGE14_MODE_REQUIRED');
let executable,args,maxLifetimeMs;
if(nativeHelp||nativeVersion){executable=config.llamaServer;args=[nativeHelp?'--help':'--version'];maxLifetimeMs=LIMITS.llamaHelpMs;}
else if(['diagnostic','template-probe'].includes(mode)){executable=process.execPath;args=[path.join(root,'scripts/v2/stage14r-diagnostic-worker.mjs'),directory];maxLifetimeMs=12*60_000;}
else{executable=path.join(root,'packages/ai-engine/node_modules/electron/dist/electron.exe');args=[path.join(root,'scripts/v2/stage14r-page-worker.cjs'),directory];maxLifetimeMs=mode==='single-page'?20*60_000:35*60_000;}
const runId='stage14r-'+mode+'-'+randomUUID(),started=performance.now();let child,stopReason=null,stopAt=null,forced=false,receipt=null;
const sampleFile=path.join(directory,'controller-host.jsonl');syncFs.writeFileSync(sampleFile,'',{flag:'wx'});
const writeStop=async code=>{if(stopReason)return;stopReason=code;stopAt=Date.now();try{await fs.writeFile(path.join(directory,'STOP'),code,{flag:'wx'});}catch{}};
const timer=setInterval(()=>{const row={at:new Date().toISOString(),hostAvailableMiB:os.freemem()/1048576,hostTotalMiB:os.totalmem()/1048576,node:process.memoryUsage()};syncFs.appendFileSync(sampleFile,JSON.stringify(row)+'\n');if(row.hostAvailableMiB<512)void writeStop('HOST_MEMORY_PRESSURE');if(stopAt&&Date.now()-stopAt>30000&&child&&!child.closed){forced=true;void child.stop();}},2000);
const stdout=await fs.open(path.join(directory,'worker-stdout.log'),'wx'),stderr=await fs.open(path.join(directory,'worker-stderr.log'),'wx');let writes=Promise.resolve();
try{
 const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','ProgramW6432','ProgramFiles','ProgramData','ALLUSERSPROFILE'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
 Object.assign(env,{TEMP:directory,TMP:directory,LOCALAPPDATA:base.installedLocalAppData,TRIO_DISABLE_AUTO_UPDATE:'true',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'});
 child=await createWarmJob({directory,runId,executable,args,cwd:nativeHelp||nativeVersion?path.dirname(executable):root,env,cleanupMs:20000,maxLifetimeMs,onStdout:bytes=>{writes=writes.then(()=>stdout.write(bytes));},onStderr:bytes=>{writes=writes.then(()=>stderr.write(bytes));}});
 await json('execution-gate.json',child.ready);await child.resume();console.log(JSON.stringify({mode,directory,rootPid:child.ready.rootPid,jobAssigned:true}));
 receipt=await child.completion;
}finally{clearInterval(timer);if(child&&!child.closed){forced=true;receipt=await child.stop();}await writes;await stdout.close();await stderr.close();}
const status=receipt?.kernelCleanupConfirmed&&receipt.rootExitCode===0&&!stopReason&&!forced?'PROCESS_EXECUTION_SUCCEEDED':'BLOCKED';
await json('controller-receipt.json',{status,mode,runId,directory,executable,args,elapsedMs:Math.round(performance.now()-started),stopReason,forced,job:receipt,scope:nativeHelp||nativeVersion?'NO_INFERENCE_NATIVE_CLI_PROBE':'REAL_MODEL_EXECUTION_REQUIRES_INNER_RECEIPT',inferenceCalls:nativeHelp||nativeVersion?0:null});
console.log(JSON.stringify({status,mode,directory,elapsedMs:Math.round(performance.now()-started),rootExitCode:receipt?.rootExitCode,cleanupConfirmed:receipt?.kernelCleanupConfirmed,stopReason,forced}));if(status==='BLOCKED')process.exitCode=1;
