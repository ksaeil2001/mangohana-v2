import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import os from 'node:os';
import {ensureResource} from '../resources.mjs';
import {snapshotAsset,reuseAssetReceipt} from './asset-receipt.mjs';
import {modelArguments} from './profile-policy.mjs';
const require=createRequire(import.meta.url);
const {ProcessOwner,secretlessEnvironment,boundedResponse,collectProcess,waitBounded}=require('../../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const errorCode=error=>/^[A-Z_0-9]{1,80}$/.test(error?.message??'')?error.message:(/^[A-Z_0-9]{1,80}$/.test(error?.code??'')?error.code:'SEMANTIC_RUNTIME_FAILED');

/** Administrator evaluation only. Owns one authenticated model process. */
export async function runProfiledModel({output,resource,directory,alias,projector,profile,priorAssetReceipt,evaluate}){
 modelArguments({profile,modelPath:'validated-later',projectorPath:'validated-later',alias,port:1});
 const config=JSON.parse(await fs.readFile('E:/Dev/Outputs/MangohanaV2-20261111/engine-config.json','utf8'));
 const temporary=path.join(output,'temp');await fs.mkdir(temporary,{recursive:false});
 const owner=new ProcessOwner(),controller=new AbortController(),secret=randomBytes(32).toString('base64url');
 const started=performance.now(),requests=[];
 const onInterrupt=()=>controller.abort(new Error('CANCELLED'));process.once('SIGINT',onInterrupt);
 let model,projectorModel,assetIntegrityReceipt,assetIntegrityMode,modelIntegrityMs=null,loadMs=null,loadStarted=null,loadAttemptMs=null,record,diagnostic='',failure,primaryFailure,result;
 const memorySamples=[],monitorErrors=[],gpuLoadLines=[];
 let gpuMonitorTimer,hostMonitorTimer,lastSample=Promise.resolve(),sampleBusy=false;
 const abortOwned=()=>{if(record&&!record.closed)void owner.terminate(record).catch(()=>{});};
 controller.signal.addEventListener('abort',abortOwned,{once:true});
 function sampleHost(phase,enforce=true){
  const sample={sampleType:'HOST_RAM',sampleStatus:'succeeded',phase,elapsedMs:Math.round(performance.now()-started),osTotalMiB:Math.round(os.totalmem()/1048576),osAvailableMiB:Math.round(os.freemem()/1048576)};
  memorySamples.push(sample);
  if(enforce&&sample.osAvailableMiB<512)controller.abort(new Error('HOST_MEMORY_PRESSURE'));
 }
 async function sampleGpu(phase,enforce=true){
  const probeStarted=performance.now(),sample={sampleType:'GPU_NVML',phase,elapsedMs:Math.round(probeStarted-started)};
  let probe;
  try{
   const executable=path.join(process.env.SystemRoot??'C:/Windows','System32','nvidia-smi.exe');
   const monitorEnv=secretlessEnvironment(executable,temporary);
   if(!process.env.ProgramW6432)throw new Error('GPU_MONITOR_ENV_MISSING');
   monitorEnv.ProgramW6432=process.env.ProgramW6432;
   probe=owner.spawn(executable,['--query-gpu=memory.total,memory.used,memory.free','--format=csv,noheader,nounits'],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:monitorEnv});
   sample.processId=probe.child.pid;
   const raw=(await waitBounded(collectProcess(probe,{stdoutLimit:4096,stderrLimit:4096})(),20_000,'GPU_MONITOR_TIMEOUT')).toString('utf8').trim().split(/\r?\n/)[0];
   const values=raw.split(',').map(value=>Number(value.trim()));
   if(values.length!==3||values.some(value=>!Number.isFinite(value)||value<0))throw new Error('GPU_MONITOR_FORMAT');
   Object.assign(sample,{sampleStatus:'succeeded',gpuTotalMiB:values[0],gpuUsedMiB:values[1],gpuFreeMiB:values[2]});
  }catch(error){const code=errorCode(error);Object.assign(sample,{sampleStatus:'failed',error:code});monitorErrors.push({phase,error:code,elapsedMs:sample.elapsedMs});}
  finally{if(probe&&!probe.closed)try{await owner.terminate(probe);}catch(error){controller.abort(new Error('CLEANUP_FAILED'));throw error;}}
  sample.durationMs=Math.round(performance.now()-probeStarted);
  memorySamples.push(sample);
  if(enforce&&sample.sampleStatus==='succeeded'&&sample.gpuUsedMiB>=7900)controller.abort(new Error('GPU_MEMORY_PRESSURE'));
 }
 try{
  sampleHost('before_integrity');await sampleGpu('before_integrity');controller.signal.throwIfAborted();
  const verificationStarted=performance.now();
  const references=[{resource,directory},projector];
  let receipt;
  if(priorAssetReceipt){
   receipt=await reuseAssetReceipt(references,priorAssetReceipt);[model,projectorModel]=receipt.assets;assetIntegrityMode=receipt.kind;
  }else{
   const before=await Promise.all(references.map(snapshotAsset));
   model=await ensureResource(resource,{directory,verifyOnly:true});
   projectorModel=await ensureResource(projector.resource,{directory:projector.directory,verifyOnly:true});
   const after=await Promise.all(references.map(snapshotAsset));if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('ASSET_FILE_CHANGED');
   receipt={version:1,kind:'FULL_SHA256_ASSET_RECEIPT',verifiedAt:new Date().toISOString(),method:'ensureResource_verifyOnly_full_sha256',durationMs:Math.round(performance.now()-verificationStarted),entries:references.map((reference,index)=>({id:reference.resource.id,sha256:reference.resource.sha256,bytes:reference.resource.bytes,fileIdentity:after[index]}))};assetIntegrityMode=receipt.kind;
  }
  modelIntegrityMs=Math.round(performance.now()-verificationStarted);
  const receiptBytes=Buffer.from(JSON.stringify(receipt,null,2)),receiptPath=path.join(output,'asset-integrity-receipt.json');await fs.writeFile(receiptPath,receiptBytes,{flag:'wx'});
  assetIntegrityReceipt={path:receiptPath,sha256:sha(receiptBytes),kind:receipt.kind};
  sampleHost('before_model');await sampleGpu('before_model');controller.signal.throwIfAborted();
  const port=await new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(error=>error?reject(error):resolve(value));});});
  const origin='http://127.0.0.1:'+port;
  const cudaCache=path.join(temporary,'cuda-cache');await fs.mkdir(cudaCache,{recursive:false});
  const env={...secretlessEnvironment(config.llamaServer,temporary),LLAMA_API_KEY:secret,CUDA_CACHE_PATH:cudaCache};
  const args=modelArguments({profile,modelPath:model.path,projectorPath:projectorModel.path,alias,port});
  await fs.writeFile(path.join(output,'launch-config.json'),JSON.stringify({executable:config.llamaServer,args,authentication:'EPHEMERAL_ENV_KEY_NOT_RECORDED',projectorLoaded:profile.imageMaxTokens!==0,loadLimitMs:300000,requestLimitMs:120000},null,2),{flag:'wx'});
  loadStarted=performance.now();
  record=owner.spawn(config.llamaServer,args,{cwd:path.dirname(config.llamaServer),windowsHide:true,shell:false,env,stdio:['ignore','ignore','pipe']});delete env.LLAMA_API_KEY;
  record.child.stderr.on('data',chunk=>{const text=chunk.toString('utf8');diagnostic=(diagnostic+text).slice(-64*1024);for(const line of text.split(/\r?\n/))if(/CUDA|GPU|offload|buffer.*size/i.test(line)&&gpuLoadLines.length<100)gpuLoadLines.push(line.slice(0,2000));});
  hostMonitorTimer=setInterval(()=>sampleHost('model_active'),2000);
  gpuMonitorTimer=setInterval(()=>{if(sampleBusy)return;sampleBusy=true;lastSample=sampleGpu('model_active').catch(error=>{monitorErrors.push({phase:'model_active',error:errorCode(error)});}).finally(()=>{sampleBusy=false;});},15_000);
  const deadline=Date.now()+300_000;let ready=false;
  while(Date.now()<deadline&&!record.closed){
   controller.signal.throwIfAborted();
   try{
    const response=await fetch(origin+'/v1/models',{headers:{Authorization:'Bearer '+secret},redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(1000)])});
    if(response.ok){const info=await response.json();if(!info.data?.some(item=>item.id===alias))throw new Error('MODEL_ALIAS_MISMATCH');ready=true;break;}
   }catch(error){if(error.message==='MODEL_ALIAS_MISMATCH')throw error;}
   await new Promise(resolve=>setTimeout(resolve,250));
  }
  controller.signal.throwIfAborted();
  if(!ready)throw new Error(record.closed?'MODEL_RUNTIME_EXITED':'MODEL_START_TIMEOUT');
  loadMs=Math.round(performance.now()-loadStarted);
  const unauthorized=await fetch(origin+'/v1/models',{redirect:'error',signal:AbortSignal.timeout(2000)});
  if(![401,403].includes(unauthorized.status))throw new Error('MODEL_AUTHENTICATION_FAILED');
  console.log(JSON.stringify({stage:'ready',modelIntegrityMs,loadMs}));
  async function request(label,payload){
   controller.signal.throwIfAborted();if(record.closed)throw new Error('MODEL_RUNTIME_EXITED');
   const body=JSON.stringify({model:alias,stream:false,...payload}),requestId=randomUUID(),requestStarted=performance.now();
   const info={requestId,label,bodySha256:sha(Buffer.from(body)),httpRequests:1};requests.push(info);
   try{
   const response=await boundedResponse(await fetch(origin+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120_000)])}),1024*1024);
   const value=await response.json();info.durationMs=Math.round(performance.now()-requestStarted);info.httpStatus=response.status;
   await fs.writeFile(path.join(output,String(requests.length).padStart(2,'0')+'-response.json'),JSON.stringify(value,null,2),{flag:'wx'});
   if(!response.ok)throw new Error('MODEL_RESPONSE_'+response.status);
   if(value.model!==alias||typeof value.choices?.[0]?.message?.content!=='string'||!value.choices[0].message.content.trim()||value.choices[0].finish_reason!=='stop')throw new Error('MODEL_RESPONSE_INVALID');
   Object.assign(info,{responseId:value.id,usage:value.usage??null,responseValid:true});
   return {content:value.choices[0].message.content,requestId};
   }catch(error){info.failure=error?.name==='TimeoutError'?'MODEL_REQUEST_TIMEOUT':errorCode(error);throw error;}
   finally{info.durationMs=Math.round(performance.now()-requestStarted);}
  }
  result=await evaluate(request);
 }catch(error){failure=errorCode(error);primaryFailure=failure;}
 finally{
  if(loadStarted!==null)loadAttemptMs=loadMs??Math.round(performance.now()-loadStarted);
  clearInterval(gpuMonitorTimer);clearInterval(hostMonitorTimer);await lastSample;
  try{await owner.cleanup();}catch{failure='CLEANUP_FAILED';}
  sampleHost('after_cleanup',false);try{await sampleGpu('after_cleanup',false);}catch{failure='CLEANUP_FAILED';}
  process.removeListener('SIGINT',onInterrupt);
  controller.signal.removeEventListener('abort',abortOwned);
  await fs.writeFile(path.join(output,'runtime-diagnostic.log'),diagnostic.replaceAll(secret,'[redacted]'),{flag:'wx'});
 }
 const validGpu=memorySamples.filter(sample=>sample.sampleType==='GPU_NVML'&&sample.sampleStatus==='succeeded');
 return {status:failure?'failed':'evaluated',failure,primaryFailure,model,projectorModel,assetIntegrityReceipt,assetIntegrityMode,resourceProfile:profile,
  memoryObservations:{scope:'SYSTEM_WIDE_SAMPLED_NOT_PROCESS_EXCLUSIVE_OR_GUARANTEED_PEAK',policy:{hostIntervalMs:2000,gpuIntervalMs:15000,gpuProbeTimeoutMs:20000,gpuProbeFailureAction:'RECORD_FAILED_SAMPLE_WITHOUT_ABORT',hostPressureAbortMiB:512,gpuPressureAbortMiB:7900},validGpuSamples:validGpu.length,failedGpuSamples:memorySamples.filter(sample=>sample.sampleType==='GPU_NVML'&&sample.sampleStatus==='failed').length,...(validGpu.length?{maxObservedGpuUsedMiB:Math.max(...validGpu.map(sample=>sample.gpuUsedMiB))}:{}),continuousOrPeakVerified:false,samples:memorySamples,monitorErrors,gpuLoadLines:gpuLoadLines.map(line=>line.replaceAll(secret,'[redacted]'))},
  modelIntegrityMs,loadMs,loadAttemptMs,elapsedMs:Math.round(performance.now()-started),
  modelHttpRequests:requests.length,successfulHttpRequests:requests.filter(info=>info.responseValid).length,requests,result,
  processOwnership:{parentNodeProcessId:process.pid,modelProcessId:record?.child.pid,modelClosed:record?.closed,children:[...owner.children.values()].map(child=>({pid:child.child.pid,closed:child.closed}))},
  cleanupConfirmed:[...owner.children.values()].every(child=>child.closed),externalInferenceCalls:0,paidApiCalls:0};
}
