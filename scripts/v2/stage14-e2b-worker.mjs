// Real Stage11 adapter + installed E2B. Run only inside the private warm-job supervisor.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash,randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {observe} from './stage14-observe.mjs';
const require=createRequire(import.meta.url),directory=process.argv[2];
const config=JSON.parse(await fs.readFile(path.join(directory,'config.json'),'utf8'));
const {LIMITS,ProcessOwner,secretlessEnvironment,acquireHooks,collectProcess,authEnvironmentName,waitBounded}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const {llamaArguments}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/translation-launch.cjs');
const {createOwnedRuntimeCache}=require('../../packages/ai-engine/quality/owned-runtime.cjs');
const {buildTranslationInput,linePromptData,regionResponseFormat,validateTranslationBatch}=require('../../packages/ai-engine/quality/translation-contract.cjs');
const {parsePageTranslation}=require('../../packages/ai-engine/quality/page-translation.cjs');
const sha=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const json=(n,v)=>fs.writeFile(path.join(directory,n),JSON.stringify(v,null,2),{flag:'wx'});
const started=performance.now(),controller=new AbortController(),owners=[],events=[];let phase='setup',calls=0,loadMs=null,result=null,failure=null;
const event=async(name,data={})=>{const row={at:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started),phase:name,...data};events.push(row);await fs.appendFile(path.join(directory,'runtime-events.jsonl'),JSON.stringify(row)+'\n');console.log(JSON.stringify({phase:name,...data}));};
const stop=code=>{if(!controller.signal.aborted)controller.abort(Object.assign(new Error(code),{code}));};
const monitor=await observe({directory,onStop:stop,phase:()=>phase});
const stopTimer=setInterval(async()=>{try{await fs.access(path.join(directory,'STOP'));stop('CANCELLED');}catch{}},200);
const releaseHooks=acquireHooks();let cache;
try{
 const source='待ってください。',scope={owner:sha(directory),projectId:'stage14-e2b',pageId:'stage14-short-line',pageNumber:1,sourceSha256:sha(source)};
 const line={id:'stage14-line-1',sourceText:source,sourceLanguage:'ja',dialogueType:'speech',order:1,pageNumber:1,sourceLineIds:['stage14-source-1'],ocrEditStatus:'ai_proposed'};
 const context={version:1,...scope,glossaryRevision:0,glossary:[],conditionalGlossary:[],profiles:[],previousPages:[],previousContext:[]};context.snapshotSha256=sha(context);
 const input=buildTranslationInput({lines:[line],extraction:{pageNumber:1,speechBubbles:[{id:line.id,text:source,readingOrder:1,productionOcrProvenance:{sourceDetectionIds:line.sourceLineIds}}],nonSpeechText:[]},context,scope});
 await json('translation-input.json',input);
 cache=createOwnedRuntimeCache({kind:'translation',createOwner:()=>{const owner=new ProcessOwner();owners.push(owner);return owner;},cleanupMs:20000,
  create:async({owner,signal})=>{
   phase='help';const help=owner.spawn(config.llamaServer,['--help'],{cwd:path.dirname(config.llamaServer),windowsHide:true,shell:false,env:secretlessEnvironment(config.llamaServer,directory),stdio:['ignore','pipe','pipe']});
   const helpBytes=await waitBounded(collectProcess(help,{stdoutLimit:1048576,stderrLimit:1048576,includeStderr:true})(),LIMITS.llamaHelpMs,'LLM_HELP_TIMEOUT');
   const authName=authEnvironmentName(helpBytes.toString('utf8')),secret=randomBytes(32).toString('base64url');
   const port=await new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});
   const origin='http://127.0.0.1:'+port,env=secretlessEnvironment(config.llamaServer,directory);env[authName]=secret;
   const args=llamaArguments(config,port);await json('launch.json',{executable:config.llamaServer,args,apiSecret:'SESSION_ENV_ONLY_NOT_RECORDED',contextSize:config.mmproj?8192:4096,sampling:'PRODUCT_ADAPTER_DEFAULT_TEMPERATURE_0.3_NO_OTHER_OVERRIDE'});
   phase='load';const loadStarted=performance.now();const record=owner.spawn(config.llamaServer,args,{cwd:path.dirname(config.llamaServer),windowsHide:true,shell:false,env,stdio:['ignore','ignore','pipe']});delete env[authName];
   let diagnostics='';record.child.stderr.on('data',b=>{diagnostics=(diagnostics+b.toString('utf8')).slice(-65536);});
   const checkReady=async checkSignal=>{if(record.closed||record.child.killed)return false;const r=await fetch(origin+'/v1/models',{headers:{Authorization:'Bearer '+secret},redirect:'error',signal:AbortSignal.any([checkSignal,AbortSignal.timeout(1500)])});return r.ok&&(await r.json()).data?.some(m=>m.id===config.modelAlias)===true;};
   try{let ready=false;const deadline=Date.now()+90000;while(Date.now()<deadline){signal.throwIfAborted();if(record.closed)throw Object.assign(new Error('LLM_START_FAILED'),{code:'LLM_START_FAILED'});try{if(await checkReady(signal)){ready=true;break;}}catch{signal.throwIfAborted();}await new Promise(r=>setTimeout(r,200));}if(!ready)throw Object.assign(new Error('LLM_START_TIMEOUT'),{code:'LLM_START_TIMEOUT'});
    const unauthorized=await fetch(origin+'/v1/models',{signal:AbortSignal.timeout(2000)});if(![401,403].includes(unauthorized.status))throw Object.assign(new Error('LLM_AUTH_UNSUPPORTED'),{code:'LLM_AUTH_UNSUPPORTED'});
    loadMs=Math.round(performance.now()-loadStarted);await event('model_ready',{pid:record.child.pid,loadMs,authenticationVerified:true});
    return {record,origin,secret,checkReady,async close(){await owner.terminate(record);await fs.writeFile(path.join(directory,'model-diagnostic.log'),diagnostics.replaceAll(secret,'[redacted]'),{flag:'wx'});}};
   }catch(e){await fs.writeFile(path.join(directory,'model-diagnostic.log'),diagnostics.replaceAll(secret,'[redacted]'),{flag:'wx'});throw e;}
  },validate:(runtime,{context})=>runtime.checkReady(context.signal),destroy:r=>r.close()});
 const c={ownerScope:scope.owner,projectId:scope.projectId,configuration:{model:config.gemmaModel,args:llamaArguments(config,0)},signal:controller.signal,runtimeEvent:event};
 const importCompiled=relative=>import(pathToFileURL(path.join(config.buildRoot,'src',relative)).href);
 const [adapterApi,payloadApi]=await Promise.all([importCompiled('main/translation/adapters/localAiAdapter.js'),importCompiled('shared/translation/translationPayload.js')]);
 const sourceLines=input.regions.map(r=>({...r,speaker:r.speaker.confirmed?r.speaker.name:undefined}));
 const payload=payloadApi.buildTranslationContextPayload({dialogueLines:sourceLines,targetLineId:line.id,v2SafeContext:true});
 const {excluded,...data}=linePromptData(input,line.id);payload.stage11={promptVersion:input.promptVersions.text,data,responseFormat:regionResponseFormat([line])};await json('adapter-request.json',{payload,excluded,temperature:0.3});
 const requestStarted=performance.now();phase='structured_request';
 result=await cache.use(c,async(runtime,{owner})=>{
  const raw=await owner.run(()=>adapterApi.createLocalAiTranslationAdapter().translate(payload,{localAiRuntime:'custom',localAiEndpoint:runtime.origin,localAiModel:config.modelAlias,signal:controller.signal}),{origin:runtime.origin,secret:runtime.secret,onRequest:()=>{calls++;}},controller.signal);
  await json('raw-adapter-response.json',raw);const parsed=parsePageTranslation(raw.translatedText,[line]),validated=validateTranslationBatch({input,results:parsed});
  return {raw,validated,pid:runtime.record.child.pid,requestAndColdLoadMs:Math.round(performance.now()-requestStarted)};
 });
 phase='lease_reuse_health_only';const reuse=await cache.use(c,async runtime=>({pid:runtime.record.child.pid,ready:await runtime.checkReady(controller.signal),additionalInferenceCalls:0}));
 result.reuse=reuse;result.samePid=result.pid===reuse.pid;result.postBorrowLease=cache.status();
 if(calls!==1||!result.samePid||!reuse.ready)throw Object.assign(new Error('REQUEST_OR_REUSE_INVALID'),{code:'REQUEST_OR_REUSE_INVALID'});
}catch(e){failure=e.code??(controller.signal.aborted?controller.signal.reason?.code:null)??'E2B_COMPATIBILITY_FAILED';await json('failure-diagnostic.json',{phase,name:e.name,code:e.code??null,messageSha256:sha(e.message??''),stackFrames:e.stack?.split('\n').slice(1,7)??[],actualInferenceCalls:calls});}
finally{
 phase='cleanup';clearInterval(stopTimer);try{await cache?.close();}catch{failure='CLEANUP_FAILED';}
 releaseHooks();const resources=await monitor.stop();
 const children=owners.flatMap(o=>[...o.children.values()].map(r=>({pid:r.child.pid,closed:r.closed,code:r.code??null,signal:r.signal??null,error:r.error})));
 const receipt={status:failure?'BLOCKED':'E2B_STRUCTURED_RESPONSE_VERIFIED',failure,scope:'REAL_INSTALLED_E2B_STAGE11_TEXT_ADAPTER_ONE_INFERENCE',model:config.gemmaModel,loadMs,elapsedMs:Math.round(performance.now()-started),actualInferenceCalls:calls,automaticRetries:0,fallbackCalls:0,externalInferenceCalls:0,paidApiCalls:0,tokens:null,cost:null,result,lease:cache?.status()??null,children,cleanupConfirmed:children.every(c=>c.closed)&&cache?.status().state==='closed',resources,events,humanSemanticVerified:null,semanticAccuracy:null};
 await json('e2b-receipt.json',receipt);console.log(JSON.stringify({status:receipt.status,failure,calls,loadMs,elapsedMs:receipt.elapsedMs,cleanupConfirmed:receipt.cleanupConfirmed}));if(failure||!receipt.cleanupConfirmed)process.exitCode=1;
}
