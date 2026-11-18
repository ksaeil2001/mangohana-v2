// Existing private kernel Job controller, explicit single A/B experiment only.
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createWarmJob} from './warm-job.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),audit=process.argv[2],afterMemory=process.argv[3]==='after-memory';
if(process.argv[3]&&!afterMemory)throw Error('Only one explicit after-memory continuation is supported');
if(!/^MangoHana_14R3_\d{8}_\d{6}$/.test(path.basename(audit??'')))throw Error('Explicit Stage14-R3 audit required');
let prior=null;
if(afterMemory){
 const bytes=await fs.readFile(path.join(audit,'evidence/actual-model/model-receipt.json')),receipt=JSON.parse(bytes),control=JSON.parse(await fs.readFile(path.join(audit,'evidence/actual-model/controller-receipt.json'),'utf8'));
 if(receipt.failure!=='HOST_MEMORY_PRESSURE'||receipt.actualInferenceCalls!==0||receipt.cleanupConfirmed!==true||control.job.kernelCleanupConfirmed!==true)throw Error('MEMORY_CONTINUATION_NOT_ELIGIBLE');
 prior={receiptSha256:createHash('sha256').update(bytes).digest('hex'),actualInferenceCalls:0,reason:'USER_REQUESTED_RESUME_AFTER_MEMORY_RELEASE',observedAvailableRamMiB:os.freemem()/1048576};
}
const directory=path.join('E:/Dev/Outputs/MangohanaV2-20261111/tests',path.basename(audit),afterMemory?'actual-ab-after-memory':'actual-ab');await fs.mkdir(directory,{recursive:true});
if(prior)await fs.writeFile(path.join(directory,'memory-continuation.json'),JSON.stringify(prior,null,2),{flag:'wx'});
const savedDirectory='C:/dev/Projects/_audits/MangoHana_14R2_20261113_215800/evidence/saved',input=JSON.parse(await fs.readFile(path.join(savedDirectory,'translation-input.json'),'utf8'));
// IDs are experiment data selected by the saved R2 defects, never product rules.
const regionIds=[...input.regions.slice(0,4),input.regions[5]].map(r=>r.id);
const reference=JSON.parse(await fs.readFile('E:/Dev/Outputs/MangohanaV2-20261111/warm-pages-2026-11-11T00-48-06.075Z-ceb347b6/candidate-config.json','utf8'));
const config={...reference,audit:path.resolve(audit),savedDirectory,regionIds,runRoot:directory,profileRoot:path.join(directory,'profile'),dataRoot:path.join(directory,'jobs')};await fs.writeFile(path.join(directory,'config.json'),JSON.stringify(config,null,2),{flag:'wx'});
const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','ProgramW6432','ProgramFiles','ProgramData','ALLUSERSPROFILE'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));Object.assign(env,{TEMP:directory,TMP:directory,LOCALAPPDATA:reference.installedLocalAppData,TRIO_DISABLE_AUTO_UPDATE:'true',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'});
const stdout=await fs.open(path.join(directory,'worker-stdout.log'),'wx'),stderr=await fs.open(path.join(directory,'worker-stderr.log'),'wx');let writes=Promise.resolve(),child,receipt,stopReason=null,stopAt=null,forced=false;
const stop=async code=>{if(stopReason)return;stopReason=code;stopAt=Date.now();await fs.writeFile(path.join(directory,'STOP'),code,{flag:'wx'});};
const samples=path.join(directory,'controller-host.jsonl');syncFs.writeFileSync(samples,'',{flag:'wx'});
const timer=setInterval(()=>{const ram=os.freemem()/1048576;syncFs.appendFileSync(samples,JSON.stringify({at:new Date().toISOString(),hostAvailableMiB:ram})+'\n');if(ram<512)void stop('HOST_MEMORY_PRESSURE');if(stopAt&&Date.now()-stopAt>30000&&child&&!child.closed){forced=true;void child.stop();}},2000),started=performance.now();
try{
 child=await createWarmJob({directory,runId:'stage14r3-ab-'+randomUUID(),executable:process.execPath,args:[path.join(root,'scripts/v2/stage14r3-model-worker.mjs'),directory],cwd:root,env,cleanupMs:20000,maxLifetimeMs:12*60_000,onStdout:b=>{writes=writes.then(()=>stdout.write(b));},onStderr:b=>{writes=writes.then(()=>stderr.write(b));}});
 await fs.writeFile(path.join(directory,'execution-gate.json'),JSON.stringify(child.ready,null,2),{flag:'wx'});await child.resume();console.log(JSON.stringify({directory,rootPid:child.ready.rootPid,jobAssigned:true}));receipt=await child.completion;
}finally{clearInterval(timer);if(child&&!child.closed){forced=true;receipt=await child.stop();}await writes;await stdout.close();await stderr.close();}
const status=receipt?.kernelCleanupConfirmed&&receipt.rootExitCode===0&&!stopReason&&!forced?'PROCESS_EXECUTION_SUCCEEDED':'BLOCKED';
await fs.writeFile(path.join(directory,'controller-receipt.json'),JSON.stringify({status,directory,elapsedMs:Math.round(performance.now()-started),stopReason,forced,job:receipt},null,2),{flag:'wx'});
const dest=path.join(audit,afterMemory?'evidence/actual-model-after-memory':'evidence/actual-model');await fs.mkdir(dest);for(const e of await fs.readdir(directory,{withFileTypes:true}))if(e.isFile())await fs.copyFile(path.join(directory,e.name),path.join(dest,e.name),syncFs.constants.COPYFILE_EXCL);
console.log(JSON.stringify({status,directory,evidence:dest,cleanupConfirmed:receipt?.kernelCleanupConfirmed,rootExitCode:receipt?.rootExitCode}));if(status!=='PROCESS_EXECUTION_SUCCEEDED')process.exitCode=1;
