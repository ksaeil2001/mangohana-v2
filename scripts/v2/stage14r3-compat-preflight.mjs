// Explicit no-inference administrator probe using the existing owned Windows Job controller.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createWarmJob} from './warm-job.mjs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),[output,attempt='attempt1']=process.argv.slice(2);if(!output||!/^attempt[1-9][0-9]*$/.test(attempt))throw Error('Explicit new supplemental directory and attempt label required');
const root=process.cwd(),dest=path.resolve(output),runDest=attempt==='attempt1'?dest:path.join(dest,attempt),read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
if(runDest!==dest){await fs.mkdir(runDest);await fs.mkdir(path.join(runDest,'evidence'));}
const r3='C:/dev/Projects/_audits/MangoHana_14R3_20261113_222657',r2=path.join(path.dirname(r3),'MangoHana_14R2_20261113_215800'),saved=await read(path.join(r2,'evidence/saved-manifest.json')),sourceDirectory=saved.sourceDirectory;
const configPath=path.join(path.dirname(path.dirname(sourceDirectory)),'config.json'),originalConfig=await read(configPath),runId='r3-compat-'+randomUUID();
const originalManifestPath=path.join(r3,'evidence/baseline.json'),manifestBytes=await fs.readFile(originalManifestPath),snapshotIndexPath=path.join(runDest,'Legacy_Snapshot_Index.json');
await fs.writeFile(snapshotIndexPath,JSON.stringify({sourceManifest:originalManifestPath,sourceManifestSha256:createHash('sha256').update(manifestBytes).digest('hex'),files:JSON.parse(manifestBytes.toString('utf8')).files},null,2),{flag:'wx'});
if(os.freemem()<512*1048576)throw Error('HOST_MEMORY_PRESSURE');
const directory=path.resolve('E:/Dev/Outputs/MangohanaV2-20261111/tests',runId);await fs.mkdir(directory);const profileRoot=path.join(directory,'profile'),home=path.join(profileRoot,'ocr-home');await fs.mkdir(home,{recursive:true});
const {inspectEmptyHomeTree}=require('../../packages/ai-engine/quality/ocr-checkpoint-compatibility.cjs');
const oldHome=path.join(originalConfig.profileRoot,'ocr-home'),emptyTree=await inspectEmptyHomeTree(oldHome);for(const name of emptyTree)await fs.mkdir(path.join(home,name),{recursive:true});
const config={...originalConfig,profileRoot,runRoot:directory,dataRoot:path.join(directory,'unused-jobs')};
const run={config,sourceDirectory,packetPath:path.resolve('docs/validation/stage14r3-closeout-20261114/Stage14R3_Human_Review_Packet.json'),submissionPath:path.join(dest,'Submitted_Selection_Draft.json'),outputFile:path.join(runDest,'Engine_Input_Readiness.json'),failureFile:path.join(runDest,'evidence/engine-input-failure.json'),sourceEvidence:{snapshotRoot:path.join(r3,'evidence/before'),snapshotManifestPath:snapshotIndexPath,creationConfigPath:configPath}};
await fs.writeFile(path.join(directory,'preflight-config.json'),JSON.stringify(run,null,2),{flag:'wx'});
const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','ProgramW6432','ProgramFiles','ProgramData','ALLUSERSPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));Object.assign(env,{TEMP:directory,TMP:directory,LOCALAPPDATA:originalConfig.installedLocalAppData,TRIO_DISABLE_AUTO_UPDATE:'true',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'});
const beforeCheckpoint=await fs.readFile(path.join(sourceDirectory,'checkpoint-ocr.json')),beforeConfig=await fs.readFile(configPath),hash=b=>createHash('sha256').update(b).digest('hex');
const log=await fs.open(path.join(runDest,'evidence/engine-input-worker.log'),'wx');let writing=Promise.resolve(),child,completion,resourceStop=false;
const resources=[],timer=setInterval(()=>{const availableRamMiB=os.freemem()/1048576;resources.push({at:new Date().toISOString(),availableRamMiB});if(availableRamMiB<512&&child&&!child.closed){resourceStop=true;void child.stop();}},2000);
try{
 child=await createWarmJob({directory,runId,executable:path.join(root,'packages/ai-engine/node_modules/electron/dist/electron.exe'),args:[path.join(root,'scripts/v2/stage14r3-compat-worker.cjs'),directory,'--disable-gpu'],cwd:root,env,cleanupMs:20000,maxLifetimeMs:20*60_000,
  onStdout:b=>{writing=writing.then(()=>log.write(b));},onStderr:b=>{writing=writing.then(()=>log.write(b));}});
 console.log(JSON.stringify({directory,pid:child.ready.rootPid,scope:'NO_INFERENCE_CURRENT_ENGINE_INPUT_INSPECTION'}));await child.resume();completion=await child.completion;
}finally{clearInterval(timer);if(child&&!child.closed)completion=await child.stop();await writing;await log.close();}
const unchanged=hash(beforeCheckpoint)===hash(await fs.readFile(path.join(sourceDirectory,'checkpoint-ocr.json')))&&hash(beforeConfig)===hash(await fs.readFile(configPath));
const newFiles=[];async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('UNEXPECTED_PROBE_LINK');if(e.isDirectory())await walk(p);else newFiles.push(path.relative(directory,p));}}await walk(directory);
const prohibited=newFiles.filter(p=>/\.(?:png|trio|ctp)$/i.test(p)||/^checkpoint-/i.test(path.basename(p)));
const receipt={status:completion?.kernelCleanupConfirmed&&completion.rootExitCode===0&&!resourceStop&&unchanged&&!prohibited.length?'PASS':'FAILED',directory,completion,resourceStop,resources,originalCheckpointAndConfigUnchanged:unchanged,newImageOrCheckpointFiles:prohibited,allNewFiles:newFiles,profileHomeTree:emptyTree,actualModelCalls:0,rendererCalls:0};
await fs.writeFile(path.join(runDest,'evidence/engine-input-controller.json'),JSON.stringify(receipt,null,2),{flag:'wx'});console.log(JSON.stringify({...receipt,resources:undefined,allNewFiles:undefined,profileHomeTree:undefined}));if(receipt.status!=='PASS')process.exitCode=1;
