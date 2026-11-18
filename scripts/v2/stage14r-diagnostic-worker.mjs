// Three explicitly budgeted requests. Existing local E2B only, private Job owner.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {observe} from './stage14-observe.mjs';
const require=createRequire(import.meta.url),directory=process.argv[2];
const config=JSON.parse(await fs.readFile(path.join(directory,'config.json'),'utf8'));
const {LIMITS,ProcessOwner,secretlessEnvironment,acquireHooks,collectProcess,authEnvironmentName,waitBounded}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const {llamaArguments}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/translation-launch.cjs');
const {buildPageTranslationRequest,parsePageTranslation,parsePageTranslationResponse}=require('../../packages/ai-engine/quality/page-translation.cjs');
const {buildTranslationInput,linePromptData,regionResponseFormat,validateTranslationBatch}=require('../../packages/ai-engine/quality/translation-contract.cjs');
const sha=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const json=(n,v)=>fs.writeFile(path.join(directory,n),JSON.stringify(v,null,2),{flag:'wx'});
const controller=new AbortController(),owners=[],rows=[],events=[],started=performance.now();
const priorCalls=config.continueDiagnostic?2:0,maxCalls=config.continueDiagnostic?4:3;
let phase='preflight',calls=priorCalls,failure=null,runtime,activeLabel='A',captureWrites=Promise.resolve();
const event=async(name,data={})=>{phase=name;const r={at:new Date().toISOString(),phase,...data};events.push(r);await fs.appendFile(path.join(directory,'runtime-events.jsonl'),JSON.stringify(r)+'\n');console.log(JSON.stringify(r));};
const stop=code=>{if(!controller.signal.aborted)controller.abort(Object.assign(Error(code),{code}));};
const monitor=await observe({directory,phase:()=>phase,onStop:stop});
const stopTimer=setInterval(()=>{void fs.access(path.join(directory,'STOP')).then(()=>stop('CANCELLED')).catch(()=>{});},200);
// Capture the native envelope, not just the adapter's string. Never persist headers.
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(...args)=>{
 const result=await nativeFetch(...args),url=new URL(typeof args[0]==='string'?args[0]:args[0].url);
 if(url.pathname==='/v1/chat/completions'&&args[1]?.method==='POST'){
  const envelope=await result.clone().json(),body=JSON.parse(args[1].body),label=activeLabel;
  const safe=structuredClone(body);for(const m of safe.messages??[])if(Array.isArray(m.content))for(const part of m.content)if(part.type==='image_url')part.image_url={sha256:sha(part.image_url.url),bytes:part.image_url.url.length,redactedLocalData:true};
  captureWrites=captureWrites.then(()=>Promise.all([json(label+'-request.json',safe),json(label+'-response.json',envelope)]));
 }
 return result;
};
const releaseHooks=acquireHooks();
async function start(vision){
 const owner=new ProcessOwner();owners.push(owner);const cfg={...config,...(!vision?{mmproj:undefined}:{}),profileRoot:path.join(directory,vision?'vision-profile':'text-profile')};
 const temp=path.join(cfg.profileRoot,'engine-temp');await fs.mkdir(temp,{recursive:true});
 const help=owner.spawn(cfg.llamaServer,['--help'],{cwd:path.dirname(cfg.llamaServer),env:secretlessEnvironment(cfg.llamaServer,temp),windowsHide:true,stdio:['ignore','pipe','pipe']});
 const helpBytes=await waitBounded(collectProcess(help,{stdoutLimit:1048576,stderrLimit:1048576,includeStderr:true})(),LIMITS.llamaHelpMs,'LLM_HELP_TIMEOUT');
 const helpText=helpBytes.toString('utf8');if(!helpText.includes('--reasoning-budget'))throw Object.assign(Error('BUDGET_OPTION_UNSUPPORTED'),{code:'BUDGET_OPTION_UNSUPPORTED'});
 const secret=randomBytes(32).toString('base64url'),env=secretlessEnvironment(cfg.llamaServer,temp);env[authEnvironmentName(helpText)]=secret;
 const port=await new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});
 const args=llamaArguments(cfg,port),origin='http://127.0.0.1:'+port,loadStarted=performance.now();
 const record=owner.spawn(cfg.llamaServer,args,{cwd:path.dirname(cfg.llamaServer),env,windowsHide:true,stdio:['ignore','pipe','pipe']});delete env[authEnvironmentName(helpText)];
 let diagnostics='';const recordLog=b=>{diagnostics=(diagnostics+b.toString('utf8')).slice(-262144);};record.child.stderr.on('data',recordLog);record.child.stdout.on('data',recordLog);
 const auth={Authorization:'Bearer '+secret},request=async(route,body)=>fetch(origin+route,{method:body?'POST':'GET',headers:{...auth,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]),redirect:'error'});
 const deadline=Date.now()+300000;let ready=false;
 while(Date.now()<deadline){controller.signal.throwIfAborted();if(record.closed)throw Object.assign(Error('LLM_START_FAILED'),{code:'LLM_START_FAILED'});try{const r=await request('/v1/models');ready=r.ok&&(await r.json()).data?.some(m=>m.id===cfg.modelAlias);if(ready)break;}catch{controller.signal.throwIfAborted();}await new Promise(r=>setTimeout(r,200));}
 if(!ready)throw Object.assign(Error('LLM_START_TIMEOUT'),{code:'LLM_START_TIMEOUT'});
 const unauthorized=await fetch(origin+'/v1/models',{signal:AbortSignal.timeout(3000)});if(![401,403].includes(unauthorized.status))throw Object.assign(Error('LLM_AUTH_UNSUPPORTED'),{code:'LLM_AUTH_UNSUPPORTED'});
 const label=vision?'vision':'text';await json(label+'-launch.json',{executable:cfg.llamaServer,args,pid:record.child.pid,loadMs:Math.round(performance.now()-loadStarted),authenticationVerified:true});
 const propsResponse=await request('/props');if(!propsResponse.ok)throw Error('PROPS_REQUIRED');const props=await propsResponse.json();
 await json(label+'-props.json',{chat_template:props.chat_template,default_generation_settings:props.default_generation_settings,modalities:props.modalities,build_info:props.build_info,templateSha256:typeof props.chat_template==='string'?sha(props.chat_template):null});
 await event('model_ready',{vision,pid:record.child.pid,loadMs:Math.round(performance.now()-loadStarted)});
 return {owner,record,origin,secret,request,async close(){await owner.cleanup();await fs.writeFile(path.join(directory,label+'-model-diagnostic.log'),diagnostics.replaceAll(secret,'[redacted]'),{flag:'wx'});}};
}
function summary(label,r,results,elapsedMs){const c=r.choices?.[0];return {label,pid:runtime.record.child.pid,finishReason:c?.finish_reason,contentBytes:Buffer.byteLength(c?.message?.content??''),reasoningBytes:Buffer.byteLength(c?.message?.reasoning_content??''),usage:r.usage??null,regionIds:results.map(x=>x.id),stage11Validated:true,automaticQualityApproval:false,elapsedMs};}
try{
 if(!config.continueDiagnostic){
 const source='待ってください。',scope={owner:sha(directory),projectId:'stage14r-text',pageId:'short',pageNumber:1,sourceSha256:sha(source)};
 const line={id:'stage14-line-1',sourceText:source,sourceLanguage:'ja',dialogueType:'speech',order:1,pageNumber:1,sourceLineIds:['stage14-source-1'],ocrEditStatus:'ai_proposed'};
 const context={version:1,...scope,glossaryRevision:0,glossary:[],conditionalGlossary:[],profiles:[],previousPages:[],previousContext:[]};context.snapshotSha256=sha(context);
 const input=buildTranslationInput({lines:[line],extraction:{pageNumber:1,speechBubbles:[{id:line.id,text:source,readingOrder:1,productionOcrProvenance:{sourceDetectionIds:line.sourceLineIds}}],nonSpeechText:[]},context,scope});
 const load=p=>import(pathToFileURL(path.join(config.buildRoot,'src',p)).href),[adapter,payloadApi]=await Promise.all([load('main/translation/adapters/localAiAdapter.js'),load('shared/translation/translationPayload.js')]);
 const payload=payloadApi.buildTranslationContextPayload({dialogueLines:input.regions.map(r=>({...r,speaker:undefined})),targetLineId:line.id,v2SafeContext:true});const {excluded,...data}=linePromptData(input,line.id);payload.stage11={promptVersion:input.promptVersions.text,data,responseFormat:regionResponseFormat([line])};
 runtime=await start(false);phase='A_text_adapter';activeLabel='A';const aStart=performance.now();
 const a=await runtime.owner.run(()=>adapter.createLocalAiTranslationAdapter().translate(payload,{localAiRuntime:'custom',localAiEndpoint:runtime.origin,localAiModel:config.modelAlias,signal:controller.signal}),{origin:runtime.origin,secret:runtime.secret,onRequest:()=>{if(++calls>maxCalls)throw Error('DIAGNOSTIC_BUDGET');}},controller.signal);
 await captureWrites;const aRaw=JSON.parse(await fs.readFile(path.join(directory,'A-response.json'),'utf8')),aParsed=parsePageTranslation(a.translatedText,[line]);validateTranslationBatch({input,results:aParsed});rows.push(summary('A',aRaw,aParsed,Math.round(performance.now()-aStart)));
 if(aRaw.choices?.[0]?.finish_reason!=='stop')throw Error('A_FINAL_RESPONSE_REQUIRED');
 await runtime.close();runtime=null;
 }
 const oldInput=JSON.parse(await fs.readFile(path.join(config.checkpointDirectory,'translation-input.json'),'utf8')),subset=structuredClone(oldInput);subset.regions=subset.regions.slice(0,3);delete subset.fingerprint;subset.fingerprint=sha(subset);
 const image=await fs.readFile(path.join(config.checkpointDirectory,'normalized.png'));
 const request=buildPageTranslationRequest({lines:subset.regions,imageDataUrl:'data:image/png;base64,'+image.toString('base64'),translationInput:subset});request.model=config.modelAlias;request.cache_prompt=false;
 await json('subset-input.json',{originalFingerprint:oldInput.fingerprint,sourceInputSha256:sha(await fs.readFile(path.join(config.checkpointDirectory,'translation-input.json'))),subset,sourceImageSha256:sha(image),additionalOcrCalls:0});
 runtime=await start(true);
 for(const label of (config.continueDiagnostic?['Bprime','C']:['B','C'])){
  controller.signal.throwIfAborted();phase=label==='B'?'B_small_regions_text':'C_same_regions_image';activeLabel=label;
  const body=structuredClone(request);if(label!=='C')body.messages[1].content=body.messages[1].content.filter(p=>p.type!=='image_url');
  const rendered=await runtime.request('/apply-template',body);if(!rendered.ok)throw Error('APPLY_TEMPLATE_REQUIRED');const applied=await rendered.json();
  await json(label+'-applied-template.json',{...applied,promptSha256:sha(applied.prompt??''),hasThinkingDirective:(applied.prompt??'').includes('<|think|>'),hasThoughtPrefill:(applied.prompt??'').endsWith('<|channel>thought\n')});
  const startTime=performance.now();if(calls>=maxCalls)throw Error('DIAGNOSTIC_BUDGET');calls++;
  const response=await runtime.request('/v1/chat/completions',body);if(!response.ok)throw Object.assign(Error('HTTP_'+response.status),{code:'TRANSLATION_RESULT'});
  await captureWrites;const raw=JSON.parse(await fs.readFile(path.join(directory,label+'-response.json'),'utf8'));
  const parsed=parsePageTranslationResponse(raw,subset.regions);validateTranslationBatch({input:subset,results:parsed});rows.push(summary(label,raw,parsed,Math.round(performance.now()-startTime)));await event(label+'_verified',rows.at(-1));
 }
}catch(e){failure=e.code??(controller.signal.aborted?controller.signal.reason?.code:null)??'DIAGNOSTIC_FAILED';await json('failure.json',{phase,code:failure,name:e.name,messageSha256:sha(e.message??''),frames:e.stack?.split('\n').slice(1,6),calls});}
finally{
 phase='cleanup';clearInterval(stopTimer);try{await runtime?.close();for(const o of owners)await o.cleanup();}catch{failure='CLEANUP_FAILED';}
 await captureWrites;releaseHooks();globalThis.fetch=nativeFetch;const resources=await monitor.stop();
 const children=owners.flatMap(o=>[...o.children.values()].map(r=>({pid:r.child.pid,closed:r.closed,code:r.code??null,error:r.error}))),cleanupConfirmed=children.every(c=>c.closed);
 const receipt={status:failure?'BLOCKED':'DIAGNOSTIC_REQUESTS_VERIFIED',failure,rows,actualInferenceCalls:calls-priorCalls,priorInferenceCalls:priorCalls,cumulativeDiagnosticCalls:calls,maxDiagnosticCalls:maxCalls,automaticRetries:0,modelFallbacks:0,additionalOcrCalls:0,externalInferenceCalls:0,paidApiCalls:0,cost:null,resources,children,cleanupConfirmed,elapsedMs:Math.round(performance.now()-started),events};
 await json('diagnostic-receipt.json',receipt);console.log(JSON.stringify({status:receipt.status,failure,calls,rows:rows.length,cleanupConfirmed}));if(failure||!cleanupConfirmed)process.exitCode=1;
}
