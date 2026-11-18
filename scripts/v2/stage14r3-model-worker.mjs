// Explicit Stage14-R3 experiment: A5 then B5, at most two completion requests.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash,randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {observe} from './stage14-observe.mjs';
const require=createRequire(import.meta.url),directory=process.argv[2],config=JSON.parse(await fs.readFile(path.join(directory,'config.json'),'utf8'));
const {LIMITS,ProcessOwner,secretlessEnvironment,collectProcess,authEnvironmentName,waitBounded}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const {llamaArguments,pageTemplateFile}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/translation-launch.cjs');
const page=require('../../packages/ai-engine/quality/page-translation.cjs'),contract=require('../../packages/ai-engine/quality/translation-contract.cjs');
const {planSelectiveTranslation}=require('../../packages/ai-engine/quality/translation-revision.cjs');
const priorPage=require(path.join(config.audit,'evidence/before/packages/ai-engine/quality/page-translation.cjs'));
const sha=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const json=(n,v)=>fs.writeFile(path.join(directory,n),JSON.stringify(v,null,2),{flag:'wx'});
const controller=new AbortController(),owner=new ProcessOwner(),started=performance.now(),rows=[];let phase='preflight',calls=0,failure=null,record,secret,diagnostics='';
const monitor=await observe({directory,phase:()=>phase,onStop:code=>controller.abort(Object.assign(Error(code),{code}))});
const stopTimer=setInterval(()=>void fs.access(path.join(directory,'STOP')).then(()=>controller.abort(Object.assign(Error('CANCELLED'),{code:'CANCELLED'}))).catch(()=>{}),200);
try{
 const saved=config.savedDirectory,input=JSON.parse(await fs.readFile(path.join(saved,'translation-input.json'),'utf8')),raw=JSON.parse(await fs.readFile(path.join(saved,'translation-response-page.json'),'utf8')).response;
 const previousResults=page.parsePageTranslationResponse(raw,input.regions),regionIds=config.regionIds;
 const plan=planSelectiveTranslation({input,previousResults,regionIds,attempt:1}),image=await fs.readFile(path.join(saved,'normalized.png'));
 const checkpointBytes=await fs.readFile(path.join(saved,'checkpoint-ocr.json')),checkpoint=JSON.parse(checkpointBytes),state=JSON.parse(await fs.readFile(path.join(saved,'state.json'),'utf8'));
 if(sha(checkpointBytes)!==state.checkpoints.ocr.sha256||sha(image)!==checkpoint.scope.normalizedSha256||checkpoint.scope.sourceSha256!==input.scope.sourceSha256)throw Error('SAVED_OCR_BINDING_INVALID');
 await json('saved-input-binding.json',{checkpointSha256:sha(checkpointBytes),checkpointIdentity:checkpoint.identity,sourceSha256:input.scope.sourceSha256,imageSha256:sha(image),inputFingerprint:input.fingerprint,regionIds,ocrMode:'PINNED_SAVED_OCR_EXPERIMENT_NOT_CURRENT_ENGINE_RESUME',currentEngineConfigurationResigned:false});
 await json('selection-plan.json',plan);
 const a=priorPage.buildPageTranslationRequest({lines:plan.input.regions,translationInput:plan.input,imageDataUrl:'data:image/png;base64,'+image.toString('base64')});
 // Same full-page observation context on both arms. Historical A13 is separate;
 // target selection and this shared context projection are NOT A13 replication.
 const aData=JSON.parse(a.messages[1].content[0].text.split('\n').slice(1).join('\n'));aData.currentPage=plan.input.pageContext;
 a.messages[1].content[0].text='다음 자료의 대사를 모두 번역하세요.\n'+JSON.stringify(aData);
 const b=page.buildPageTranslationRequest({lines:plan.input.regions,translationInput:plan.input,imageDataUrl:'data:image/png;base64,'+image.toString('base64')});
 for(const q of [a,b]){q.model=config.modelAlias;q.cache_prompt=false;}
 const bData=JSON.parse(b.messages[1].content[0].text.split('\n').slice(1).join('\n'));
 for(const key of ['targets','currentPage','terms','profiles','previousVerified','revision','excludedCounts'])if(JSON.stringify(aData[key])!==JSON.stringify(bData[key]))throw Error('AB_CONTEXT_DRIFT');
 for(const key of ['temperature','max_tokens','reasoning_budget_tokens','chat_template_kwargs','stream','model','cache_prompt'])if(JSON.stringify(a[key])!==JSON.stringify(b[key]))throw Error('AB_SAMPLING_DRIFT');
 await json('ab-controls.json',{sameContext:true,sameImageSha256:sha(image),sameTargets:regionIds,sampling:{temperature:a.temperature,max_tokens:a.max_tokens,reasoning_budget_tokens:a.reasoning_budget_tokens,chat_template_kwargs:a.chat_template_kwargs,model:a.model,cache_prompt:false},templateSha256:sha(await fs.readFile(pageTemplateFile(config))),changedOnly:'REQUEST_CONTRACT_SYSTEM_USER_INSTRUCTION_PROMPT_VERSION_SCHEMA_DESCRIPTIONS_NAME',historicalA13IsControlledPair:false});
 const temp=path.join(directory,'profile/engine-temp');await fs.mkdir(temp,{recursive:true});
 phase='model_help';const help=owner.spawn(config.llamaServer,['--help'],{cwd:path.dirname(config.llamaServer),env:secretlessEnvironment(config.llamaServer,temp),windowsHide:true,stdio:['ignore','pipe','pipe']});
 const helpText=(await waitBounded(collectProcess(help,{stdoutLimit:1048576,stderrLimit:1048576,includeStderr:true})(),LIMITS.llamaHelpMs,'LLM_HELP_TIMEOUT')).toString('utf8');
 if(!helpText.includes('--reasoning-budget'))throw Error('BUDGET_OPTION_UNSUPPORTED');
 secret=randomBytes(32).toString('base64url');const env=secretlessEnvironment(config.llamaServer,temp),authKey=authEnvironmentName(helpText);env[authKey]=secret;
 const port=await new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});
 const args=llamaArguments(config,port),origin='http://127.0.0.1:'+port,loadStarted=performance.now();phase='model_loading';
 record=owner.spawn(config.llamaServer,args,{cwd:path.dirname(config.llamaServer),env,windowsHide:true,stdio:['ignore','pipe','pipe']});delete env[authKey];
 const capture=bytes=>{diagnostics=(diagnostics+bytes.toString('utf8')).slice(-262144);};record.child.stdout.on('data',capture);record.child.stderr.on('data',capture);
 const request=(route,body)=>fetch(origin+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+secret,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]),redirect:'error'});
 const deadline=Date.now()+300000;let ready=false;
 while(Date.now()<deadline){controller.signal.throwIfAborted();if(record.closed)throw Error('LLM_START_FAILED');try{const r=await request('/v1/models');ready=r.ok&&(await r.json()).data?.some(m=>m.id===config.modelAlias);if(ready)break;}catch{controller.signal.throwIfAborted();}await new Promise(r=>setTimeout(r,200));}
 if(!ready)throw Error('LLM_START_TIMEOUT');
 const unauthorized=await fetch(origin+'/v1/models',{signal:AbortSignal.timeout(3000)});if(![401,403].includes(unauthorized.status))throw Error('LLM_AUTH_UNSUPPORTED');
 await json('launch.json',{executable:config.llamaServer,args,pid:record.child.pid,loadMs:Math.round(performance.now()-loadStarted),authenticationVerified:true});
 const propsResponse=await request('/props');if(!propsResponse.ok)throw Error('PROPS_REQUIRED');const props=await propsResponse.json();await json('props.json',{chat_template:props.chat_template,templateSha256:sha(props.chat_template??''),default_generation_settings:props.default_generation_settings,modalities:props.modalities,build_info:props.build_info});
 for(const [label,body]of [['A',a],['B',b]]){
  controller.signal.throwIfAborted();phase=label+'_preflight';
  const safe=structuredClone(body);safe.messages[1].content[1].image_url={sha256:sha(image),redactedLocalData:true};await json(label+'-request.json',{requestFingerprint:sha(JSON.stringify(body)),request:safe});
  const rendered=await request('/apply-template',body);if(!rendered.ok)throw Error('APPLY_TEMPLATE_REQUIRED');const applied=await rendered.json();
  const tail=(applied.prompt??'').slice(-140);await json(label+'-applied-template.json',{promptSha256:sha(applied.prompt??''),tail,emptyThoughtClosed:tail.endsWith('<|channel>thought\n<channel|>')});
  if(!tail.endsWith('<|channel>thought\n<channel|>'))throw Error('STAGE14R_TEMPLATE_NOT_APPLIED');
  phase=label+'_inference';if(calls>=2)throw Error('MODEL_CALL_BUDGET');calls++;const start=performance.now();
  const response=await request('/v1/chat/completions',body),elapsedMs=Math.round(performance.now()-start),envelope=await response.json();await json(label+'-response.json',{elapsedMs,response:envelope});
  if(!response.ok)throw Error('HTTP_'+response.status);
  const parsed=page.parsePageTranslationResponse(envelope,plan.input.regions),validated=contract.validateTranslationBatch({input:plan.input,results:parsed}),choice=envelope.choices[0];
  await json(label+'-validated.json',{parsed,validated});
  rows.push({label,elapsedMs,usage:envelope.usage??null,timings:envelope.timings??null,finishReason:choice.finish_reason,contentBytes:Buffer.byteLength(choice.message.content),reasoningBytes:Buffer.byteLength(choice.message.reasoning_content??''),structurePassed:true,languageReviewIds:validated.filter(r=>r.semantic.outputCompliance.status!=='PASS').map(r=>r.id),semanticRiskIds:validated.filter(r=>r.semantic.signals.some(s=>!r.semantic.outputCompliance.codes.includes(s.code))).map(r=>r.id),humanSemanticVerified:null});
 }
}catch(error){failure=error.code??controller.signal.reason?.code??error.message;await json('failure.json',{phase,code:failure,name:error.name,calls,frames:error.stack?.split('\n').slice(1,5)});}
finally{
 phase='cleanup';clearInterval(stopTimer);try{await owner.cleanup();}catch{failure='CLEANUP_FAILED';}
 await fs.writeFile(path.join(directory,'model-diagnostic.log'),secret?diagnostics.replaceAll(secret,'[redacted]'):diagnostics,{flag:'wx'});
 const resources=await monitor.stop(),children=[...owner.children.values()].map(r=>({pid:r.child.pid,closed:r.closed,code:r.code??null,error:r.error})),cleanupConfirmed=children.every(c=>c.closed);
 const receipt={status:failure?'BLOCKED':'TWO_REQUESTS_COMPLETED',failure,actualInferenceCalls:calls,maximumCalls:2,rows,additionalOcrCalls:0,lamaCalls:0,automaticRetries:0,modelFallbacks:0,externalInferenceCalls:0,paidApiCalls:0,cost:null,resources,children,cleanupConfirmed,elapsedMs:Math.round(performance.now()-started)};
 await json('model-receipt.json',receipt);console.log(JSON.stringify(receipt));if(failure||!cleanupConfirmed)process.exitCode=1;
}
