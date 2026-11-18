import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {ensureResource} from '../resources.mjs';
const require=createRequire(import.meta.url);
const {ProcessOwner,secretlessEnvironment,boundedResponse}=require('../../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const errorCode=error=>/^[A-Z_0-9]{1,80}$/.test(error?.message??'')?error.message:'SEMANTIC_RUNTIME_FAILED';

/** Administrator evaluation only. Owns one authenticated model process. */
export async function runModel({output,resource,directory,alias,extraArguments=[],evaluate}){
 const config=JSON.parse(await fs.readFile('E:/Dev/Outputs/MangohanaV2-20261111/engine-config.json','utf8'));
 const temporary=path.join(output,'temp');await fs.mkdir(temporary,{recursive:false});
 const owner=new ProcessOwner(),controller=new AbortController(),secret=randomBytes(32).toString('base64url');
 const started=performance.now(),requests=[];
 const onInterrupt=()=>controller.abort(new Error('CANCELLED'));process.once('SIGINT',onInterrupt);
 let model,modelIntegrityMs=null,loadMs=null,record,diagnostic='',failure,result;
 try{
  const verificationStarted=performance.now();
  model=await ensureResource(resource,{directory,verifyOnly:true});modelIntegrityMs=Math.round(performance.now()-verificationStarted);
  const port=await new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(error=>error?reject(error):resolve(value));});});
  const origin='http://127.0.0.1:'+port;
  const env={...secretlessEnvironment(config.llamaServer,temporary),LLAMA_API_KEY:secret};
  const args=['--model',model.path,'--host','127.0.0.1','--port',String(port),'--alias',alias,'--ctx-size','8192','--parallel','1','--n-gpu-layers','99','--threads','4','--reasoning','auto','--no-webui',...extraArguments];
  const loadStarted=performance.now();
  record=owner.spawn(config.llamaServer,args,{cwd:path.dirname(config.llamaServer),windowsHide:true,shell:false,env,stdio:['ignore','ignore','pipe']});delete env.LLAMA_API_KEY;
  record.child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString('utf8')).slice(-64*1024);});
  const deadline=Date.now()+300_000;let ready=false;
  while(Date.now()<deadline&&!record.closed){
   controller.signal.throwIfAborted();
   try{
    const response=await fetch(origin+'/v1/models',{headers:{Authorization:'Bearer '+secret},redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(1000)])});
    if(response.ok){const info=await response.json();if(!info.data?.some(item=>item.id===alias))throw new Error('MODEL_ALIAS_MISMATCH');ready=true;break;}
   }catch(error){if(error.message==='MODEL_ALIAS_MISMATCH')throw error;}
   await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!ready)throw new Error(record.closed?'MODEL_RUNTIME_EXITED':'MODEL_START_TIMEOUT');
  loadMs=Math.round(performance.now()-loadStarted);
  const unauthorized=await fetch(origin+'/v1/models',{redirect:'error',signal:AbortSignal.timeout(2000)});
  if(![401,403].includes(unauthorized.status))throw new Error('MODEL_AUTHENTICATION_FAILED');
  console.log(JSON.stringify({stage:'ready',modelIntegrityMs,loadMs}));
  async function request(label,payload){
   controller.signal.throwIfAborted();if(record.closed)throw new Error('MODEL_RUNTIME_EXITED');
   const body=JSON.stringify({model:alias,stream:false,...payload}),requestId=randomUUID(),requestStarted=performance.now();
   const info={requestId,label,bodySha256:sha(Buffer.from(body)),httpRequests:1};requests.push(info);
   const response=await boundedResponse(await fetch(origin+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120_000)])}),1024*1024);
   const value=await response.json();info.durationMs=Math.round(performance.now()-requestStarted);info.httpStatus=response.status;
   await fs.writeFile(path.join(output,String(requests.length).padStart(2,'0')+'-response.json'),JSON.stringify(value,null,2),{flag:'wx'});
   if(!response.ok)throw new Error('MODEL_RESPONSE_'+response.status);
   if(value.model!==alias||typeof value.choices?.[0]?.message?.content!=='string'||!value.choices[0].message.content.trim()||value.choices[0].finish_reason!=='stop')throw new Error('MODEL_RESPONSE_INVALID');
   Object.assign(info,{responseId:value.id,usage:value.usage??null,responseValid:true});
   return {content:value.choices[0].message.content,requestId};
  }
  result=await evaluate(request);
 }catch(error){failure=errorCode(error);}
 finally{
  try{await owner.cleanup();}catch{failure='CLEANUP_FAILED';}
  process.removeListener('SIGINT',onInterrupt);
  await fs.writeFile(path.join(output,'runtime-diagnostic.log'),diagnostic.replaceAll(secret,'[redacted]'),{flag:'wx'});
 }
 return {status:failure?'failed':'evaluated',failure,model,modelIntegrityMs,loadMs,elapsedMs:Math.round(performance.now()-started),
  modelHttpRequests:requests.length,successfulHttpRequests:requests.filter(info=>info.responseValid).length,requests,result,
  cleanupConfirmed:[...owner.children.values()].every(child=>child.closed),externalInferenceCalls:0,paidApiCalls:0};
}
