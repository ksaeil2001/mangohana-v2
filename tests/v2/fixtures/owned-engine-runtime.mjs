// Synthetic Electron/OCR/model providers. No model or user image is loaded by this file.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire,Module,syncBuiltinESMExports} from 'node:module';
import childProcess from 'node:child_process';
import {once} from 'node:events';
const require=createRequire(import.meta.url),enginePath=require.resolve('../../../packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs');
const boundaries=require('../../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
export const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+A5XkAAAAASUVORK5CYII=','base64');
const mask=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const fixtureKey='__mangohanaOwnedRuntimeFixture';

export async function fixture(t,reuse,configOverrides={}, {base=process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR, compose=(config,createEngine)=>createEngine(config)}={}){
 await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'engine-'+(reuse?'reuse':'default')+'-'));
 await fs.writeFile(path.join(root,'SYNTHETIC_PROVIDERS_ONLY.json'),JSON.stringify({scope:'SOURCE_OWNERSHIP_INTEGRATION_WITH_SYNTHETIC_ELECTRON_OCR_IMAGE_AND_HTTP_PROVIDERS',actualAiCalls:0,actualModelsLoaded:0,userImagesUsed:0}));
 const compiled=path.join(root,'compiled'),resources=path.join(root,'resources'),profile=path.join(root,'profile');for(const directory of [compiled,resources,profile])await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(compiled,'package.json'),' {"type":"module"}');
 const beforeFetch=globalThis.fetch,state={statusCalls:0,services:0,ocrPids:[],ocrChildren:[],owners:[],modelRecords:[],allRecords:[],forceSpawn:false,failCleanup:false};globalThis[fixtureKey]=state;
 const write=async(relative,source)=>{const file=path.join(compiled,'src',relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,source);};
 await write('main/productionOcrService.js',`import {spawn} from 'node:child_process';const state=globalThis.${fixtureKey};export function createProductionOcrService(){state.services++;let child;return {getStatus:async()=>{state.statusCalls++;if(state.observeEnvironment&&!child){const env={SYSTEMROOT:process.env.SYSTEMROOT,TEMP:process.env.TEMP,PATH:process.env.PATH,hoMe:'SYNTHETIC_CALLER_HOME',uSeRpRoFiLe:'SYNTHETIC_CALLER_PROFILE'};state.suppliedOcrEnvs.push(env);child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','OCR_ENV_POLICY_FIXTURE'],{windowsHide:true,stdio:'ignore',env});state.ocrPids.push(child.pid);state.ocrChildren.push(child);}return {ready:true};},execute:async({pageNumber})=>{if(state.recognitionError)throw state.recognitionError;if(!child||child.exitCode!==null||state.forceSpawn){state.forceSpawn=false;child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});state.ocrPids.push(child.pid);state.ocrChildren.push(child);}return state.ocrResultForPage?.(pageNumber)??state.ocrResultOverride??{pageNumber,nonSpeechText:[],warnings:[],speechBubbles:[{id:'line-'+pageNumber,text:'テスト',bbox:{x:0,y:0,width:1,height:1}}]};},close:()=>{if(child&&child.exitCode===null)child.kill('SIGKILL');child=undefined;}};}`);
 await write('main/productionTypesetFontResource.js','export async function initializeProductionTypesetFontResource(){return {enabled:true,handleProtocolRequest(){}};}');
 await write('main/translation/translationEngineRegistry.js','export function createTranslationEngineRegistry(){return {executeTranslation(){throw new Error("only synthetic page provider expected");}};}');
 await write('main/translation/adapters/localAiAdapter.js','export function createLocalAiTranslationAdapter(){return {};}');
 await write('shared/translation/translationPayload.js','export const unused=true;');
 await write('shared/translation/translationQa.js',`export function inspectTranslationQuality(){return {issues:globalThis.${fixtureKey}.qaIssues??[]};}`);
 if(configOverrides.pageContextTranslation===false){
  const actual=await fs.mkdtemp(path.join(os.tmpdir(),'stage11-actual-modules-'));
  childProcess.execFileSync(process.execPath,['packages/ai-engine/node_modules/typescript/bin/tsc','-p','packages/ai-engine/tsconfig.json','--outDir',actual],{windowsHide:true,stdio:'pipe'});
  for(const p of ['shared','main/translation','main/localAiClient.js'])await fs.cp(path.join(actual,'src',p),path.join(compiled,'src',p),{recursive:true});
 }
 const bundle=path.join(compiled,'renderer.js');await fs.writeFile(bundle,'/* synthetic renderer; no browser */');
 const model=path.join(root,'synthetic-model.bin');await fs.writeFile(model,'NOT AN AI MODEL');
 const server=path.join(root,'synthetic-server.cjs'),diary=path.join(root,'synthetic-http.jsonl');
 // Keep test-only file opens out of the server's authenticated readiness request.
 const journal=await fs.open(diary,'ax');
 t.after(()=>journal.close());
 await fs.writeFile(server,`const http=require('node:http'),fs=require('node:fs'),path=require('node:path');const port=+process.argv[2],alias=process.argv[3],key=process.env.LLAMA_API_KEY,root=path.dirname(process.env.SYNTHETIC_DIARY);http.createServer(async(req,res)=>{const authorized=req.headers.authorization==='Bearer '+key;let body='';for await(const chunk of req)body+=chunk;fs.appendFileSync(1,JSON.stringify({path:req.url,authorized,body:body?JSON.parse(body):null,pid:process.pid})+'\\n');if(!authorized){res.writeHead(401);res.end('{}');return;}res.setHeader('Content-Type','application/json');if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:fs.existsSync(path.join(root,'wrong-model'))?'foreign-model':alias}]}));return;}if(fs.existsSync(path.join(root,'hold-posts')))return;const request=JSON.parse(body),ids=request.response_format.json_schema.schema.properties.regions.items.properties.id.enum;res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:(fs.existsSync(path.join(root,'response-'+ids[0]+'.txt'))?fs.readFileSync(path.join(root,'response-'+ids[0]+'.txt'),'utf8'):JSON.stringify({regions:ids.map(id=>({id,source_reading:'テスト',translation:'합성 검사 응답',uncertain:false}))}))}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));}).listen(port,'127.0.0.1');`);
 const lama=path.join(root,'synthetic-restoration.cjs');await fs.writeFile(lama,`let text='';process.stdin.on('data',x=>{text+=x;if(!text.includes('\\n'))return;const input=JSON.parse(text),sha=x=>require('node:crypto').createHash('sha256').update(Buffer.from(x,'base64')).digest('hex');process.stdout.write(JSON.stringify({version:1,ok:true,width:1,height:1,imagePngBase64:input.image,verification:{cleanupConfirmed:true,normalizedImageSha256:sha(input.image),maskSha256:sha(input.mask),cleanedSha256:sha(input.image)}}));process.exit(0);});`);
 class TestOwner extends boundaries.ProcessOwner{
  constructor(){super();state.owners.push(this);}
  async cleanup(){await super.cleanup();if(state.failCleanup&&[...this.children.values()].some(record=>state.modelRecords.includes(record)))throw new Error('synthetic release acknowledgement unavailable');}
  spawn(executable,args,options){
   let record;
   if(args[0]==='--help')record=super.spawn(process.execPath,['-e','process.stdout.write("--api-key LLAMA_API_KEY")'],options);
   else if(args[0]==='--model'){record=super.spawn(process.execPath,[server,args[args.indexOf('--port')+1],args[args.indexOf('--alias')+1]],{...options,stdio:['ignore',journal.fd,'ignore'],env:{...options.env,SYNTHETIC_DIARY:diary}});state.modelRecords.push(record);}
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
 const engine=await compose({repository:root,buildRoot:compiled,resourcesPath:resources,profileRoot:profile,config:{rendererBundle:bundle,installedLocalAppData:root,llamaServer:process.execPath,python:process.execPath,gemmaModel:model,mmproj:model,lamaWorker:model,lamaModel:model,lamaTileWrapper:model,llamaStartupMs:5000,pageContextTranslation:true,...(reuse?{reuseOcrRuntime:true,reuseTranslationServer:true}:{}),...configOverrides}},api.createEngine);
 t.after(async()=>{try{await engine.close();}catch(error){if(!state.failCleanup)throw error;}finally{await Promise.allSettled(state.owners.map(owner=>boundaries.ProcessOwner.prototype.cleanup.call(owner)));for(const child of state.ocrChildren)if(child.exitCode===null&&child.signalCode===null){const done=once(child,'close');child.kill('SIGKILL');await done;}await fs.writeFile(path.join(root,'owned-child-exit.json'),JSON.stringify({scope:'SYNTHETIC_PROVIDERS_NO_AI',forcedOwnerRecovery:state.failCleanup,hooksReleased:globalThis.fetch===beforeFetch,children:state.owners.flatMap(owner=>[...owner.children.values()].map(record=>({pid:record.child.pid,closed:record.closed,error:record.error,code:record.code,signal:record.signal}))),ocrChildren:state.ocrChildren.map(child=>({pid:child.pid,code:child.exitCode,signal:child.signalCode}))}));delete globalThis[fixtureKey];syncBuiltinESMExports();}});
 assert.equal(engine.health().ready,true,engine.health().message);
 const run=async(number,extra={})=>{const directory=path.join(root,'page-'+number);await fs.mkdir(directory);const input=path.join(directory,'synthetic.png');await fs.writeFile(input,png);return engine.run({jobId:'synthetic-'+number,inputPath:input,outputDirectory:directory,pageNumber:number,sourceLanguage:'ja',ownerScope:'a'.repeat(64),projectId:'book',translationContext:{previousContext:[{source:'前',translation:'검사 '+number}]},...extra});};
 return {engine,state,run,root,diary,beforeFetch};
}
