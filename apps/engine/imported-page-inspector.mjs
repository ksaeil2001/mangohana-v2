// Lazy read-only Electron input inspector. Does not open a queue or call engine.run.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {fileURLToPath} from 'node:url';import {randomUUID} from 'node:crypto';import {createRequire} from 'node:module';
import {readBounded} from './translation-review-store.mjs';
import {createWarmJob} from '../../scripts/v2/warm-job.mjs';
const require=createRequire(import.meta.url),{inspectEmptyHomeTree}=require('../../packages/ai-engine/quality/ocr-checkpoint-compatibility.cjs');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function createImportedPageInspector(){
 let active=false;
 return async(binding,{signal}={})=>{
  if(active)throw Object.assign(Error('입력 점검이 진행 중입니다.'),{code:'IMPORTED_PAGE_INSPECTION_BUSY',status:409});
  active=true;let child,completion,timer,log,writing=Promise.resolve();
  try{
   signal?.throwIfAborted();
   const spec=JSON.parse(await readBounded(new URL('./stage14r3-ocr-source.json',import.meta.url),64*1024));
   if(spec.expectedCheckpointSha256!==binding.sourceProvenance.originalCheckpointSha256||spec.expectedGeneration!==binding.sourceProcessingGeneration)throw Object.assign(Error('보관된 OCR 출처가 다릅니다.'),{code:'IMPORTED_PAGE_INPUT_REJECTED',status:409});
   const originalConfig=JSON.parse(await readBounded(spec.creationConfigPath,1024*1024));
   const runId='imported-input-'+randomUUID(),directory=path.resolve('E:/Dev/Outputs/MangohanaV2-20261111/tests',runId);
   if(os.freemem()<512*1048576)throw Object.assign(Error('입력 점검을 위한 메모리가 부족합니다.'),{code:'HOST_MEMORY_PRESSURE',status:503});
   await fs.mkdir(directory);const profileRoot=path.join(directory,'profile'),home=path.join(profileRoot,'ocr-home');await fs.mkdir(home,{recursive:true});
   for(const name of await inspectEmptyHomeTree(path.join(originalConfig.profileRoot,'ocr-home')))await fs.mkdir(path.join(home,name),{recursive:true});
   const config={...originalConfig,profileRoot,runRoot:directory,dataRoot:path.join(directory,'unused-jobs')};
   const source={directory:spec.directory,jobId:spec.jobId,expectedGeneration:spec.expectedGeneration,expectedCheckpointSha256:spec.expectedCheckpointSha256,
    compatibilityEvidence:{snapshotRoot:spec.snapshotRoot,snapshotManifestPath:path.resolve(root,spec.snapshotManifestPath),creationConfigPath:spec.creationConfigPath,expectedGeneration:spec.expectedGeneration}};
   await fs.writeFile(path.join(directory,'input.json'),JSON.stringify({config,binding,source}),{flag:'wx',mode:0o600});
   const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','ProgramW6432','ProgramFiles','ProgramData','ALLUSERSPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
   Object.assign(env,{TEMP:directory,TMP:directory,LOCALAPPDATA:originalConfig.installedLocalAppData,TRIO_DISABLE_AUTO_UPDATE:'true',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'});
   log=await fs.open(path.join(directory,'inspection.log'),'wx');const append=b=>{writing=writing.then(()=>log.write(b));};
   child=await createWarmJob({directory,runId,executable:path.join(root,'packages/ai-engine/node_modules/electron/dist/electron.exe'),args:[path.join(root,'scripts/v2/imported-page-input-worker.cjs'),directory,'--disable-gpu'],cwd:root,env,maxLifetimeMs:20*60*1000,onStdout:append,onStderr:append});
   let resourceStop=false;const abort=()=>void child.stop();signal?.addEventListener('abort',abort,{once:true});
   timer=setInterval(()=>{if(os.freemem()<512*1048576){resourceStop=true;void child.stop();}},2000);
   try{if(signal?.aborted)await child.stop();else await child.resume();completion=await child.completion;}finally{signal?.removeEventListener('abort',abort);}
   await writing;signal?.throwIfAborted();
   const result=JSON.parse(await readBounded(path.join(directory,'result.json')));
   const files=[];async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('INSPECTION_LINK');if(e.isDirectory())await walk(p);else files.push(path.relative(directory,p));}}await walk(directory);
   const prohibited=files.filter(p=>/\.(png|trio|ctp)$/i.test(p)||/^checkpoint-/i.test(path.basename(p)));
   const valid=completion?.kernelCleanupConfirmed&&completion.rootExitCode===0&&!resourceStop&&!prohibited.length&&Object.values(result.calls).every(v=>v===0)&&!result.forbidden.length&&result.engineRunInvoked===false&&result.executionAuthorized===false;
   const controller={status:valid?'PASS':'FAILED',completion,resourceStop,newImageOrCheckpointFiles:prohibited,allNewFiles:files,engineRunInvoked:false};
   await fs.writeFile(path.join(directory,'controller.json'),JSON.stringify(controller,null,2),{flag:'wx'});
   if(!valid)throw Error('IMPORTED_PAGE_INSPECTION_BOUNDARY_FAILED');
   return {...result,inspectionEvidence:{directory,controllerStatus:controller.status,kernelCleanupConfirmed:true}};
  }finally{clearInterval(timer);if(child&&!child.closed)await child.stop();await writing;await log?.close();active=false;}
 };
}
