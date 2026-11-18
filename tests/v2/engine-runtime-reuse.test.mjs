// Synthetic Electron/OCR/model providers. No model or user image is loaded by this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire,Module,syncBuiltinESMExports} from 'node:module';
import childProcess,{spawn} from 'node:child_process';
import {once} from 'node:events';
import {createJobStore} from '../../apps/engine/store.mjs';
const require=createRequire(import.meta.url),enginePath=require.resolve('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs');
const boundaries=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+A5XkAAAAASUVORK5CYII=','base64');
const mask=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const fixtureKey='__mangohanaOwnedRuntimeFixture';

async function fixture(t,reuse,configOverrides={}){
 const root=path.resolve(process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR,'engine-'+(reuse?'reuse':'default')+'-'+Date.now());await fs.mkdir(root,{recursive:true});
 await fs.writeFile(path.join(root,'SYNTHETIC_PROVIDERS_ONLY.json'),JSON.stringify({scope:'SOURCE_OWNERSHIP_INTEGRATION_WITH_SYNTHETIC_ELECTRON_OCR_IMAGE_AND_HTTP_PROVIDERS',actualAiCalls:0,actualModelsLoaded:0,userImagesUsed:0}));
 const compiled=path.join(root,'compiled'),resources=path.join(root,'resources'),profile=path.join(root,'profile');for(const directory of [compiled,resources,profile])await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(compiled,'package.json'),' {"type":"module"}');
 const beforeFetch=globalThis.fetch,state={statusCalls:0,services:0,ocrPids:[],ocrChildren:[],owners:[],modelRecords:[],allRecords:[],forceSpawn:false,failCleanup:false};globalThis[fixtureKey]=state;
 const write=async(relative,source)=>{const file=path.join(compiled,'src',relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,source);};
 await write('main/productionOcrService.js',`import {spawn} from 'node:child_process';const state=globalThis.${fixtureKey};export function createProductionOcrService(){state.services++;let child;return {getStatus:async()=>{state.statusCalls++;if(state.observeEnvironment&&!child){const env={SYSTEMROOT:process.env.SYSTEMROOT,TEMP:process.env.TEMP,PATH:process.env.PATH,hoMe:'SYNTHETIC_CALLER_HOME',uSeRpRoFiLe:'SYNTHETIC_CALLER_PROFILE'};state.suppliedOcrEnvs.push(env);child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','OCR_ENV_POLICY_FIXTURE'],{windowsHide:true,stdio:'ignore',env});state.ocrPids.push(child.pid);state.ocrChildren.push(child);}return {ready:true};},execute:async({pageNumber})=>{if(state.recognitionError)throw state.recognitionError;if(!child||child.exitCode!==null||state.forceSpawn){state.forceSpawn=false;child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});state.ocrPids.push(child.pid);state.ocrChildren.push(child);}return state.ocrResultOverride??{pageNumber,nonSpeechText:[],warnings:[],speechBubbles:[{id:'line-'+pageNumber,text:'テスト',bbox:{x:0,y:0,width:1,height:1}}]};},close:()=>{if(child&&child.exitCode===null)child.kill('SIGKILL');child=undefined;}};}`);
 await write('main/productionTypesetFontResource.js','export async function initializeProductionTypesetFontResource(){return {enabled:true,handleProtocolRequest(){}};}');
 await write('main/translation/translationEngineRegistry.js','export function createTranslationEngineRegistry(){return {executeTranslation(){throw new Error("only synthetic page provider expected");}};}');
 await write('main/translation/adapters/localAiAdapter.js','export function createLocalAiTranslationAdapter(){return {};}');
 await write('shared/translation/translationPayload.js','export const unused=true;');
 await write('shared/translation/translationQa.js','export function inspectTranslationQuality(){return {issues:[]};}');
 if(configOverrides.pageContextTranslation===false){
  const actual=await fs.mkdtemp(path.join(os.tmpdir(),'stage11-actual-modules-'));
  childProcess.execFileSync(process.execPath,['packages/ai-engine/node_modules/typescript/bin/tsc','-p','packages/ai-engine/tsconfig.json','--outDir',actual],{windowsHide:true,stdio:'pipe'});
  for(const p of ['shared','main/translation','main/localAiClient.js'])await fs.cp(path.join(actual,'src',p),path.join(compiled,'src',p),{recursive:true});
 }
 const bundle=path.join(compiled,'renderer.js');await fs.writeFile(bundle,'/* synthetic renderer; no browser */');
 const model=path.join(root,'synthetic-model.bin');await fs.writeFile(model,'NOT AN AI MODEL');
 const server=path.join(root,'synthetic-server.cjs'),diary=path.join(root,'synthetic-http.jsonl');
 await fs.writeFile(server,`const http=require('node:http'),fs=require('node:fs'),path=require('node:path');const port=+process.argv[2],alias=process.argv[3],key=process.env.LLAMA_API_KEY,root=path.dirname(process.env.SYNTHETIC_DIARY);http.createServer(async(req,res)=>{const authorized=req.headers.authorization==='Bearer '+key;let body='';for await(const chunk of req)body+=chunk;fs.appendFileSync(process.env.SYNTHETIC_DIARY,JSON.stringify({path:req.url,authorized,body:body?JSON.parse(body):null,pid:process.pid})+'\\n');if(!authorized){res.writeHead(401);res.end('{}');return;}res.setHeader('Content-Type','application/json');if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:fs.existsSync(path.join(root,'wrong-model'))?'foreign-model':alias}]}));return;}if(fs.existsSync(path.join(root,'hold-posts')))return;const request=JSON.parse(body),ids=request.response_format.json_schema.schema.properties.regions.items.properties.id.enum;res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:(fs.existsSync(path.join(root,'response-'+ids[0]+'.txt'))?fs.readFileSync(path.join(root,'response-'+ids[0]+'.txt'),'utf8'):JSON.stringify({regions:ids.map(id=>({id,source_reading:'テスト',translation:'합성 검사 응답',uncertain:false}))}))}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));}).listen(port,'127.0.0.1');`);
 const lama=path.join(root,'synthetic-restoration.cjs');await fs.writeFile(lama,`let text='';process.stdin.on('data',x=>{text+=x;if(!text.includes('\\n'))return;const input=JSON.parse(text),sha=x=>require('node:crypto').createHash('sha256').update(Buffer.from(x,'base64')).digest('hex');process.stdout.write(JSON.stringify({version:1,ok:true,width:1,height:1,imagePngBase64:input.image,verification:{cleanupConfirmed:true,normalizedImageSha256:sha(input.image),maskSha256:sha(input.mask),cleanedSha256:sha(input.image)}}));process.exit(0);});`);
 class TestOwner extends boundaries.ProcessOwner{
  constructor(){super();state.owners.push(this);}
  async cleanup(){await super.cleanup();if(state.failCleanup&&[...this.children.values()].some(record=>state.modelRecords.includes(record)))throw new Error('synthetic release acknowledgement unavailable');}
  spawn(executable,args,options){
   let record;
   if(args[0]==='--help')record=super.spawn(process.execPath,['-e','process.stdout.write("--api-key LLAMA_API_KEY")'],options);
   else if(args[0]==='--model'){record=super.spawn(process.execPath,[server,args[args.indexOf('--port')+1],args[args.indexOf('--alias')+1]],{...options,env:{...options.env,SYNTHETIC_DIARY:diary}});state.modelRecords.push(record);}
   else if(args.includes('--log-dir'))record=super.spawn(process.execPath,[lama],options);
   else throw new Error('Unexpected synthetic provider spawn');state.allRecords.push(record);return record;
  }
 }
 class Window{
  constructor(){this.dead=false;this.listeners={};this.webContents={setWindowOpenHandler(){},on(){},executeJavaScript:async source=>{
   if(source.startsWith('typeof window.SitesCandidate'))return true;
   const match=/window\.SitesCandidate\.(prepare|render)\(([\s\S]*)\)$/.exec(source);if(!match)return;
   const value=JSON.parse(match[2]);if(match[1]==='prepare')return {jobId:value.jobId,lines:value.ocr.speechBubbles.map((bubble,index)=>({id:bubble.id,order:index+1,sourceText:bubble.text,sourceLanguage:'ja',ocrEditStatus:'ai_proposed'})),mask:{identity:value.maskIdentity,maskPngBase64:mask.toString('base64'),maskedPixels:1,regions:[]}};
   return {jobId:value.jobId,width:1,height:1,pngBase64:png.toString('base64'),...(state.omitTypesettingIdentity?{}:{typesettingIdentity:{...value.typesettingIdentity,...(state.staleTypesettingIdentity?{ocrSha256:'0'.repeat(64)}:{})}}),layoutReport:value.lines.map(line=>({id:line.id,bbox:{x:0,y:0,width:1,height:1},fontSizePx:14,fontFamily:'Synthetic',qaStatus:'pending',productionFontLoaded:true,glyphFontLoaded:true,reviewReasons:[]}))};
  }};}
  once(name,callback){this.listeners[name]=callback;}async loadURL(){}isDestroyed(){return this.dead;}destroy(){this.dead=true;this.listeners.closed?.();}
 }
 const electron={app:{isReady:()=>true},BrowserWindow:Window,session:{fromPartition:()=>({setPermissionRequestHandler(){},protocol:{handle(){},unhandle(){}},webRequest:{onBeforeRequest(){}}})},nativeImage:{createFromBuffer:bytes=>({getSize:()=>({width:1,height:1}),isEmpty:()=>false,toPNG:()=>png,toBitmap:()=>Buffer.from(bytes.equals(mask)?[0,0,0,0]:[255,255,255,255])})}};
 // The 1px native-image fixture tests process ownership, not mask quality.
 // Real default-mask admission is covered by stage10-engine-mask.test.mjs.
 const originalLoad=Module._load;Module._load=function(request,parent,isMain){if(request==='electron')return electron;if(parent?.filename===enginePath){if(request==='./engine-boundaries.cjs')return {...boundaries,ProcessOwner:TestOwner};if(request==='../../../../quality/mask-evidence.cjs')return {...originalLoad.call(this,request,parent,isMain),verifySourceTextMask:()=>({maskedPixels:1,qualityStatus:'SYNTHETIC_PIXEL_PORT_NOT_MEASURED'})};}return originalLoad.call(this,request,parent,isMain);};
 let api;try{delete require.cache[enginePath];api=require(enginePath);}finally{Module._load=originalLoad;}
 const engine=await api.createEngine({repository:root,buildRoot:compiled,resourcesPath:resources,profileRoot:profile,config:{rendererBundle:bundle,installedLocalAppData:root,llamaServer:process.execPath,python:process.execPath,gemmaModel:model,mmproj:model,lamaWorker:model,lamaModel:model,lamaTileWrapper:model,llamaStartupMs:5000,pageContextTranslation:true,...(reuse?{reuseOcrRuntime:true,reuseTranslationServer:true}:{}),...configOverrides}});
 t.after(async()=>{try{await engine.close();}catch(error){if(!state.failCleanup)throw error;}finally{await Promise.allSettled(state.owners.map(owner=>boundaries.ProcessOwner.prototype.cleanup.call(owner)));for(const child of state.ocrChildren)if(child.exitCode===null&&child.signalCode===null){const done=once(child,'close');child.kill('SIGKILL');await done;}await fs.writeFile(path.join(root,'owned-child-exit.json'),JSON.stringify({scope:'SYNTHETIC_PROVIDERS_NO_AI',forcedOwnerRecovery:state.failCleanup,hooksReleased:globalThis.fetch===beforeFetch,children:state.owners.flatMap(owner=>[...owner.children.values()].map(record=>({pid:record.child.pid,closed:record.closed,error:record.error,code:record.code,signal:record.signal}))),ocrChildren:state.ocrChildren.map(child=>({pid:child.pid,code:child.exitCode,signal:child.signalCode}))}));delete globalThis[fixtureKey];syncBuiltinESMExports();}});
 assert.equal(engine.health().ready,true);
 const run=async(number,extra={})=>{const directory=path.join(root,'page-'+number);await fs.mkdir(directory);const input=path.join(directory,'synthetic.png');await fs.writeFile(input,png);return engine.run({jobId:'synthetic-'+number,inputPath:input,outputDirectory:directory,pageNumber:number,sourceLanguage:'ja',ownerScope:'a'.repeat(64),projectId:'book',translationContext:{previousContext:[{source:'前',translation:'검사 '+number}]},...extra});};
 return {engine,state,run,root,diary,beforeFetch};
}

test('default false keeps per-job cold lifecycle, authenticated model identity and original quality guards', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false);await f.run(1);await f.run(2);assert.equal(f.state.statusCalls,2);assert.equal(f.state.modelRecords.length,2);assert.ok(f.state.modelRecords.every(record=>record.closed));assert.equal(f.state.ocrPids.length,2);const calls=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse),posts=calls.filter(call=>call.path==='/v1/chat/completions');assert.equal(posts.length,2);assert.ok(posts.every(call=>call.authorized&&!Object.hasOwn(call.body,'cache_prompt')));assert.ok(calls.some(call=>call.path==='/v1/models'&&!call.authorized));await f.engine.close();assert.equal(f.engine.health().ready,false);
});

test('Stage13 render-only retry reuses verified OCR translation and cleaned checkpoints without another model request',{timeout:30_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false),checkpoints={};f.state.omitTypesettingIdentity=true;
 const extra={pageId:'same-page',pageNumber:1,translationContext:undefined,onCheckpoint:receipt=>{checkpoints[receipt.stage]=receipt;}};
 await assert.rejects(f.run(1,extra),{code:'STALE_RESULT'});
 assert.ok(checkpoints.cleaned,'the validated cleaned result must be recoverable before rendering');
 f.state.omitTypesettingIdentity=false;
 const result=await f.run(2,{...extra,resumeFrom:{directory:path.join(f.root,'page-1'),jobId:'synthetic-1',checkpoints}});
 assert.equal(f.state.statusCalls,1);assert.equal(f.state.modelRecords.length,1);
 assert.deepEqual(result.report.recovery.reusedStages,['ocr','translation','cleaned']);
 assert.equal(result.report.jobId,'synthetic-2');assert.equal(result.report.typesetting.inputIdentity.jobId,'synthetic-2');
 const posts=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse).filter(x=>x.path==='/v1/chat/completions');assert.equal(posts.length,1);
});

test('Stage13 owned store persists checkpoint receipts and commits a render retry once after reopening',{timeout:30_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false),root=path.join(f.root,'owned-jobs'),owner='a'.repeat(64);let store=await createJobStore({root,engine:f.engine});t.after(()=>store.close());
 const until=async id=>{const deadline=Date.now()+15000;while(Date.now()<deadline){const v=await store.get(owner,id);if(['failed','completed'].includes(v.status))return v;await new Promise(r=>setTimeout(r,10));}assert.fail('owned checkpoint job did not settle');};
 f.state.omitTypesettingIdentity=true;const first=await store.submit({owner,idempotencyKey:'render-first',bytes:png,name:'synthetic.png',projectId:'book',pageId:'same-page',sourceLanguage:'ja'});assert.equal((await until(first.id)).status,'failed');
 const state=JSON.parse(await fs.readFile(path.join(root,first.id,'state.json'),'utf8'));assert.ok(state.checkpoints.cleaned.sha256);
 f.state.omitTypesettingIdentity=false;const [retry,duplicate]=await Promise.all([store.retry(owner,first.id,{idempotencyKey:'render-retry'}),store.retry(owner,first.id,{idempotencyKey:'render-retry'})]);assert.equal(retry.id,duplicate.id);
 assert.equal((await until(retry.id)).status,'completed');assert.equal(f.state.modelRecords.length,1);assert.equal(f.state.statusCalls,1);
 const report=JSON.parse(await fs.readFile(path.join(root,retry.id,'report.json'),'utf8'));assert.deepEqual(report.recovery.reusedStages,['ocr','translation','cleaned']);
 const committed=JSON.parse(await fs.readFile(path.join(root,retry.id,'state.json'),'utf8'));assert.equal(committed.usage.localModelRequests,0);assert.equal(committed.usage.monetaryCost,null);
 await store.close();store=await createJobStore({root,engine:f.engine});assert.equal((await store.get(owner,retry.id)).status,'completed');assert.equal((await store.retry(owner,first.id,{idempotencyKey:'render-retry'})).id,retry.id);assert.equal(f.state.modelRecords.length,1);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,retry.id,'state.json'),'utf8')).resultReceipt,committed.resultReceipt);
});

for(const fault of ['omitTypesettingIdentity','staleTypesettingIdentity'])test('Stage12 refuses '+fault+' before any partial candidate PNG is saved',{timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false);f.state[fault]=true;
 await assert.rejects(f.run(1),e=>e.code==='STALE_RESULT');
 assert.equal((await fs.readdir(path.join(f.root,'page-1'))).some(n=>/candidate|result\.png/.test(n)),false);
});

test('health advertises saved terminology consumption for both page and Stage11 text paths', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const supported=await fixture(t,false);assert.equal(supported.engine.health().savedContextSupported,true);await supported.engine.close();
 const legacy=await fixture(t,false,{pageContextTranslation:false});assert.equal(legacy.engine.health().savedContextSupported,true);await legacy.engine.close();
});

test('Stage11 default text path consumes bound context with real TS modules and keeps uncertain semantics as a draft', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false,{pageContextTranslation:false});
 const sourceSha256=createHash('sha256').update(png).digest('hex');
 const snapshot={version:1,owner:'a'.repeat(64),projectId:'book',pageId:'one',pageNumber:1,sourceSha256,glossaryRevision:3,glossary:[{id:'name',source:'テスト',target:'검사'}],profiles:[],previousContext:[{source:'前',translation:'UNREVIEWED_POISON',status:'AI_PROPOSED'}]};
 const context={...snapshot,snapshotSha256:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')};
 const result=await f.run(1,{pageId:'one',translationContext:context});
 assert.equal(result.report.translationInput.version,'stage11-input-v1');assert.equal(result.report.translationContext.consumed,true);
 assert.equal(result.report.translations[0].semantic.automaticQualityApproval,false);assert.equal(result.report.translations[0].semantic.semanticAccuracy,null);
 const calls=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse),posts=calls.filter(x=>x.path==='/v1/chat/completions');
 assert.equal(posts.length,1);assert.equal(posts[0].body.temperature,0.3);assert.equal(JSON.stringify(posts).includes('UNREVIEWED_POISON'),false);
 assert.ok(posts[0].body.messages[1].content.includes('USER_CONFIRMED'));assert.ok(posts[0].body.response_format);
 assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'page-1','translation-input.json'),'utf8')).context.revision,3);
});

for(const page of [false,true])test('Stage11 '+(page?'page':'text')+' partial response cannot publish, erase source, or replace a last normal PNG', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false,{pageContextTranslation:page});
 f.state.ocrResultOverride={pageNumber:1,nonSpeechText:[],warnings:[],speechBubbles:['a','b'].map((suffix,i)=>({id:'line-1-'+suffix,text:'テスト',readingOrder:i+1,bbox:{x:0,y:0,width:1,height:1}}))};
 await fs.writeFile(path.join(f.root,'last-normal.png'),png,{flag:'wx'});
 await fs.writeFile(path.join(f.root,'response-line-1-'+(page?'a':'b')+'.txt'),JSON.stringify({regions:page?[{id:'line-1-a',source_reading:'テスト',translation:'검사',uncertain:false}]:[]}));
 await assert.rejects(f.run(1),{code:'PAGE_TRANSLATION_INVALID'});
 const directory=path.join(f.root,'page-1'),review=JSON.parse(await fs.readFile(path.join(directory,'translation-review.json'),'utf8'));
 assert.equal(review.partialApplied,false);assert.equal(review.automaticRetry,false);assert.deepEqual(review.receivedCandidateIds,page?[]:['line-1-a']);
 for(const name of ['translations.json','cleaned.png','candidate.png','engine-report.json'])await assert.rejects(fs.access(path.join(directory,name)),{code:'ENOENT'});
 assert.deepEqual(await fs.readFile(path.join(f.root,'last-normal.png')),png);
 const posts=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse).filter(x=>x.path==='/v1/chat/completions');assert.equal(posts.length,page?1:2);
});

test('Japanese translation in valid page JSON is rejected before any candidate, restoration or completed report', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false);
 await fs.writeFile(path.join(f.root,'response-line-1.txt'),JSON.stringify({regions:[{id:'line-1',source_reading:'テスト',translation:'テスト',uncertain:false}]}));
 await assert.rejects(f.run(1),{code:'PAGE_TRANSLATION_INVALID'});
 const directory=path.join(f.root,'page-1'),review=JSON.parse(await fs.readFile(path.join(directory,'translation-review.json'),'utf8'));
 assert.equal(review.partialApplied,false);assert.equal(review.automaticRetry,false);
 for(const name of ['translations.json','cleaned.png','candidate.png','engine-report.json'])await assert.rejects(fs.access(path.join(directory,name)),{code:'ENOENT'});
 const posts=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse).filter(x=>x.path==='/v1/chat/completions');assert.equal(posts.length,1);
});

test('a page request binds the server snapshot and records actual glossary/context consumption', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false),snapshot={version:1,owner:'a'.repeat(64),projectId:'book',pageId:'one',pageNumber:1,sourceSha256:createHash('sha256').update(png).digest('hex'),glossaryRevision:9,glossary:[{id:'name',source:'テスト',target:'이름 표기'}],previousContext:[{source:'前',translation:'앞 페이지 후보',status:'AI_PROPOSED'}]};
 const snapshotSha256=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
 const result=await f.run(1,{pageId:'one',translationContext:{...snapshot,snapshotSha256}});
 assert.deepEqual(result.report.translationContext,{snapshotSha256,glossaryRevision:9,consumed:true});
 assert.equal(result.report.translationRequests[0].contextSnapshotSha256,snapshotSha256);
 const calls=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse),post=calls.find(call=>call.path==='/v1/chat/completions');
 const text=post.body.messages[1].content.find(value=>value.type==='text').text;
 assert.ok(text.includes('이름 표기'));assert.equal(text.includes('앞 페이지 후보'),false);
 assert.ok(result.report.translationInput.excluded.some(e=>e.reason==='UNREVIEWED_AI_CONTEXT'));
 assert.equal(result.report.translationRequests[0].httpRequests,1);
});

test('selected reuse keeps independent OCR/server owners, isolates project switches, and uses fresh page bodies with exact IDs', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,true);const first=await f.run(1),second=await f.run(2);assert.equal(f.state.statusCalls,1);assert.equal(f.state.ocrPids.length,1);assert.equal(f.state.modelRecords.length,1);assert.equal(f.state.modelRecords[0].closed,false);assert.notEqual(first.report.translations[0].requestId,second.report.translations[0].requestId);assert.equal(first.report.translations[0].modelHttpRequests,1);assert.equal(second.report.translations[0].modelHttpRequests,1);
 const calls=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse),posts=calls.filter(call=>call.path==='/v1/chat/completions');assert.equal(posts.length,2);assert.ok(posts.every(call=>call.authorized&&call.body.cache_prompt===false));assert.notDeepEqual(posts[0].body,posts[1].body);assert.deepEqual(posts[0].body.response_format.json_schema.schema.properties.regions.items.properties.id.enum,['line-1']);assert.deepEqual(posts[1].body.response_format.json_schema.schema.properties.regions.items.properties.id.enum,['line-2']);
 const old=f.state.modelRecords[0];await f.run(3,{projectId:'other'});assert.equal(old.closed,true);assert.equal(f.state.statusCalls,2);assert.equal(f.state.modelRecords.length,2);await f.engine.close();assert.ok(f.state.modelRecords.every(record=>record.closed));assert.ok(f.state.allRecords.every(record=>record.closed));assert.ok(f.state.ocrChildren.every(child=>child.exitCode!==null||child.signalCode!==null));assert.equal(globalThis.fetch,f.beforeFetch);
});

test('a warm OCR lazy restart is rejected before spawning and only the next explicit job performs cold preparation', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,true);await f.run(1);f.state.forceSpawn=true;await assert.rejects(f.run(2),error=>error.code==='PROCESS_RESTART_REQUIRED');assert.equal(f.state.ocrPids.length,1);assert.equal(f.state.statusCalls,1);await f.run(3);assert.equal(f.state.statusCalls,2);assert.equal(f.state.ocrPids.length,2);const events=(await fs.readFile(path.join(f.root,'page-2','runtime-events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(events.some(event=>event.phase==='ocr_runtime_cache_failed'&&event.code==='PROCESS_RESTART_REQUIRED'));await f.engine.close();assert.ok(f.state.ocrChildren.every(child=>child.exitCode!==null||child.signalCode!==null));
});

test('engine close cancels active synthetic translation, drains job and caches, then releases hooks', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,true);await fs.writeFile(path.join(f.root,'hold-posts'),'synthetic hold');const running=f.run(1).then(()=>({ok:true}),error=>({ok:false,error}));let posted=false;const until=Date.now()+7000;
 while(Date.now()<until){try{posted=(await fs.readFile(f.diary,'utf8')).includes('/v1/chat/completions');}catch{}if(posted)break;await new Promise(resolve=>setTimeout(resolve,15));}
 assert.equal(posted,true);await f.engine.close();const result=await running;assert.equal(result.ok,false);assert.equal(result.error.code,'CANCELLED');assert.ok(f.state.modelRecords.every(record=>record.closed));assert.ok(f.state.ocrChildren.every(child=>child.exitCode!==null||child.signalCode!==null));assert.equal(globalThis.fetch,f.beforeFetch);assert.equal(f.engine.health().ready,false);
});

test('a cached server reporting a foreign model cannot serve a new page and is disposed before another cold validation', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,true);await f.run(1);const first=f.state.modelRecords[0];await fs.writeFile(path.join(f.root,'wrong-model'),'synthetic identity mismatch');await assert.rejects(f.run(2));assert.equal(first.closed,true);const calls=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.filter(call=>call.path==='/v1/chat/completions').length,1);await fs.unlink(path.join(f.root,'wrong-model'));await f.run(3);await f.engine.close();assert.ok(f.state.modelRecords.every(record=>record.closed));
});

test('recognition failure records bounded private diagnostics before generic public error without model work', {timeout:10_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,true),secret='SYNTHETIC_PRIVATE_DIALOGUE_AND_KEY',message='Production OCR sidecar failed: '+secret;f.state.recognitionError=new Error(message);await assert.rejects(f.run(1),error=>error.code==='ENGINE_FAILED'&&!error.message.includes(secret));const text=await fs.readFile(path.join(f.root,'page-1','runtime-events.jsonl'),'utf8'),events=text.trim().split('\n').map(JSON.parse),event=events.find(value=>value.phase==='ocr_failure_diagnostic');assert.ok(event,'original OCR fault needs a diagnostic before its generic error');assert.equal(event.category,'SIDECAR_OPERATION_ERROR');assert.equal(event.errorName,'Error');assert.equal(event.errorCode,null);assert.match(event.messageSha256,/^[a-f0-9]{64}$/);assert.equal(text.includes(secret),false);assert.equal(f.state.modelRecords.length,0);assert.equal(f.state.ocrChildren.length,0);await f.engine.close();
});

test('cold and cached OCR scopes inject private homes while same-executable model and restoration providers keep their environments', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const original=childProcess.spawn,seen=[];childProcess.spawn=function(executable,args,options){if(executable===process.execPath)seen.push({ocr:args.at(-1)==='OCR_ENV_POLICY_FIXTURE',role:path.basename(args[0]),home:options?.env?.HOME,userprofile:options?.env?.USERPROFILE});return original.call(this,executable,args,options);};
 try{for(const reuse of [false,true]){const f=await fixture(t,reuse);f.state.observeEnvironment=true;f.state.suppliedOcrEnvs=[];await f.run(1);if(reuse)await f.run(2);const expected=path.join(f.root,'profile','ocr-home'),ocr=seen.filter(value=>value.ocr&&value.home===expected);assert.equal(ocr.length,1);assert.equal(ocr[0].userprofile,expected);assert.equal(f.state.suppliedOcrEnvs[0].hoMe,'SYNTHETIC_CALLER_HOME');assert.equal(f.state.suppliedOcrEnvs[0].uSeRpRoFiLe,'SYNTHETIC_CALLER_PROFILE');if(reuse){assert.equal(f.state.statusCalls,1);assert.equal(f.state.ocrChildren[0].exitCode,null);}await f.engine.close();}const foreign=seen.filter(value=>['synthetic-server.cjs','synthetic-restoration.cjs'].includes(value.role));assert.ok(foreign.length>0);assert.ok(foreign.every(value=>value.home===undefined&&value.userprofile===undefined));}finally{childProcess.spawn=original;syncBuiltinESMExports();}
});

// This deliberately leaves an uncertain hook resident, so keep it after scope-observation tests.
test('unconfirmed cached owner cleanup blocks the engine and keeps hooks until owner recovery instead of accepting another job', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,true);await f.run(1);f.state.failCleanup=true;await assert.rejects(f.engine.close(),error=>error.code==='CLEANUP_FAILED');assert.equal(f.engine.health().ready,false);assert.notEqual(globalThis.fetch,f.beforeFetch);await assert.rejects(f.run(2),error=>error.code==='ENGINE_UNAVAILABLE');assert.ok(f.state.modelRecords.every(record=>record.closed));
});
