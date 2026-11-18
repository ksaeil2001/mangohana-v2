import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {randomUUID,createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {createWarmJob} from '../../scripts/v2/warm-job.mjs';import {readBounded} from './translation-review-store.mjs';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),sha=b=>createHash('sha256').update(b).digest('hex');
export async function measureLayoutText(entries,context,{signal}={}){
 signal?.throwIfAborted();const requestId='layout-text-'+randomUUID(),directory=await fs.mkdtemp(path.join(os.tmpdir(),requestId+'-')),control=path.resolve('E:/Dev/Outputs/MangohanaV2-20261111/tests',requestId);await fs.mkdir(control);
 const config={buildRoot:context.config.buildRoot,resourcesPath:context.config.resourcesPath,measurementBundle:path.join(repository,'packages/ai-engine/.build/layout-measurement.js')},bundleSha256=sha(await readBounded(config.measurementBundle));
 const bytes=Buffer.from(JSON.stringify({version:1,kind:'LAYOUT_TEXT_MEASUREMENT',requestId,config,measurement:{width:context.width,height:context.height,entries}}));await fs.writeFile(path.join(directory,'input.json'),bytes,{flag:'wx',mode:0o600});
 const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','ProgramW6432','ProgramFiles','ProgramData','ALLUSERSPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));Object.assign(env,{TEMP:directory,TMP:directory,LOCALAPPDATA:process.env.LOCALAPPDATA??directory,TRIO_DISABLE_AUTO_UPDATE:'true',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'});
 let job,log='';const append=b=>{log=(log+b.toString()).slice(-262144);};
 try{
  job=await createWarmJob({directory:control,runId:requestId,executable:path.join(repository,'packages/ai-engine/node_modules/electron/dist/electron.exe'),args:[path.join(repository,'packages/ai-engine/quality/layout-measurement-worker.cjs'),directory,'--disable-gpu'],cwd:repository,env,maxLifetimeMs:90000,onStdout:append,onStderr:append});
  const abort=()=>void job.stop();signal?.addEventListener('abort',abort,{once:true});let completion;
  try{if(signal?.aborted)await job.stop();else await job.resume();completion=await job.completion;}finally{signal?.removeEventListener('abort',abort);}
  await fs.writeFile(path.join(directory,'controller.json'),JSON.stringify({requestId,completion,control,actualImageExecution:false,actualModelCalls:0},null,2),{flag:'wx'});await fs.writeFile(path.join(directory,'runtime.log'),log,{flag:'wx'});signal?.throwIfAborted();
  if(completion.kernelCleanupConfirmed!==true||completion.activeProcessesAfter!==0||completion.supervisorExitCode!==0||completion.rootExitCode!==0)throw Object.assign(Error('글자 측정과 프로세스 정리를 확인하지 못했습니다.'),{code:'LAYOUT_MEASUREMENT_UNKNOWN',status:503});
  let result;try{result=JSON.parse(await readBounded(path.join(directory,'result.json'),1024*1024));}catch{throw Object.assign(Error('글자 측정 결과 파일을 확인하지 못했습니다.'),{code:'LAYOUT_MEASUREMENT_UNKNOWN',status:503});}
  if(result.requestId!==requestId||result.inputSha256!==sha(bytes)||result.bundleSha256!==bundleSha256||result.kind!=='LAYOUT_TEXT_MEASUREMENT'||result.paintCalls!==0||result.encodeCalls!==0||result.actualPageSupplied!==false||result.actualImageExecution!==false||result.forbiddenCalls?.network!==0||result.forbiddenCalls?.child!==0)throw Object.assign(Error('글자 측정 증거가 일치하지 않습니다.'),{code:'LAYOUT_MEASUREMENT_UNKNOWN',status:503});
  return {...result,cleanupConfirmed:true,evidenceDirectory:directory};
 }finally{if(job&&!job.closed)await job.stop();}
}
