// Real engine + real mask verifier, synthetic image/Electron/OCR ports. No AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire,Module,syncBuiltinESMExports} from 'node:module';
import sharp from 'sharp';
const require=createRequire(import.meta.url),enginePath=require.resolve('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs');
const boundaries=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
async function fixture(t,defect,{existingCandidate=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'stage10-engine-mask-')),compiled=path.join(root,'compiled'),resources=path.join(root,'resources'),profile=path.join(root,'profile'),output=path.join(root,'job');
 for(const p of [compiled,resources,profile,output])await fs.mkdir(p);await fs.writeFile(path.join(compiled,'package.json'),'{"type":"module"}');
 const width=40,height=40,sourcePixels=Buffer.alloc(width*height*4,255),maskPixels=Buffer.alloc(width*height*4,255);
 maskPixels[((defect==='protected'?17:15)*width+(defect==='protected'?17:15))*4+3]=0;
 if(defect==='inverted')for(let i=3;i<maskPixels.length;i+=4)maskPixels[i]=255-maskPixels[i];
 const image=await sharp(sourcePixels,{raw:{width,height,channels:4}}).png().toBuffer(),mask=await sharp(maskPixels,{raw:{width,height,channels:4}}).png().toBuffer();
 const input=path.join(root,'synthetic.png');await fs.writeFile(input,image);
 if(existingCandidate)await fs.writeFile(path.join(output,'candidate.png'),image,{flag:'wx'});
 const ocr={pageNumber:1,speechBubbles:[{id:'dialogue',type:'speech_bubble',text:'SYNTHETIC',language:'ja',readingOrder:1,bbox:{x:.2,y:.2,width:.5,height:.5},polygon:[{x:.2,y:.2},{x:.7,y:.2},{x:.7,y:.7},{x:.2,y:.7}],confidence:.9,orientation:'vertical',notes:'',speakerCandidates:[]}],nonSpeechText:[{type:'sound_effect',text:'SYNTHETIC_PRESERVE',bbox:{x:.4,y:.4,width:.1,height:.1}}],warnings:['SYNTHETIC_NOT_AI']};
 const write=async(p,s)=>{const file=path.join(compiled,'src',p);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,s);};
 await write('main/productionOcrService.js',`export function createProductionOcrService(){return {getStatus:async()=>({ready:true}),execute:async()=>(${JSON.stringify(ocr)}),close(){}};}`);
 await write('main/productionTypesetFontResource.js','export async function initializeProductionTypesetFontResource(){return {enabled:true,handleProtocolRequest(){}};}');
 await write('main/translation/translationEngineRegistry.js','export function createTranslationEngineRegistry(){return {};}');
 await write('main/translation/adapters/localAiAdapter.js','export function createLocalAiTranslationAdapter(){return {};}');
 await write('shared/translation/translationPayload.js','export const unused=true;');await write('shared/translation/translationQa.js','export const unused=true;');
 const bundle=path.join(compiled,'renderer.js'),resource=path.join(root,'synthetic-not-model.bin');await fs.writeFile(bundle,'/* synthetic renderer */');await fs.writeFile(resource,'NOT A MODEL');
 const state={translationStarts:0,prepared:0},fetchBefore=globalThis.fetch;
 class Owner extends boundaries.ProcessOwner{spawn(){state.translationStarts++;throw Object.assign(Error('SYNTHETIC_STOP_BEFORE_MODEL'),{code:'LLM_START_FAILED'});}}
 class Window{
  constructor(){this.dead=false;this.events={};this.webContents={setWindowOpenHandler(){},on(){},executeJavaScript:async source=>{
   if(source.startsWith('typeof window.SitesCandidate'))return true;
   const m=/window\.SitesCandidate\.(prepare|render)\(([\s\S]*)\)$/.exec(source);if(!m)return;assert.equal(m[1],'prepare');const args=JSON.parse(m[2]);state.prepared++;
   const identity=structuredClone(args.maskIdentity);if(identity){if(defect==='stale')identity.ocrSha256='c'.repeat(64);if(defect==='foreign')identity.sourceImageSha256='d'.repeat(64);}
   return {jobId:args.jobId,lines:[{id:'dialogue',order:1,sourceText:'SYNTHETIC',sourceLanguage:'ja',ocrEditStatus:'ai_proposed'}],mask:{identity,maskPngBase64:mask.toString('base64'),maskedPixels:1,regions:[]}};
  }};}
  once(n,f){this.events[n]=f;}async loadURL(){}isDestroyed(){return this.dead;}destroy(){this.dead=true;this.events.closed?.();}
 }
 const electron={app:{isReady:()=>true},BrowserWindow:Window,session:{fromPartition:()=>({setPermissionRequestHandler(){},protocol:{handle(){},unhandle(){}},webRequest:{onBeforeRequest(){}}})},nativeImage:{createFromBuffer:bytes=>({getSize:()=>({width,height}),isEmpty:()=>false,toPNG:()=>bytes,toBitmap:()=>Buffer.from(bytes.equals(mask)?maskPixels:sourcePixels)})}};
 // This fixture never starts OCR. Keep its files in OS tmpdir; the real E-only
 // OCR environment policy is covered separately by the existing policy tests.
 const load=Module._load;Module._load=function(request,parent,isMain){if(request==='electron')return electron;if(parent?.filename===enginePath){if(request==='./engine-boundaries.cjs')return {...boundaries,ProcessOwner:Owner};if(request==='../../../../quality/ocr-environment.cjs')return {prepareOcrEnvironmentPolicy:async()=>({identity:{scope:'SYNTHETIC_NO_OCR_RUNTIME'}})};}return load.call(this,request,parent,isMain);};
 let api;try{delete require.cache[enginePath];api=require(enginePath);}finally{Module._load=load;}
 const engine=await api.createEngine({repository:root,buildRoot:compiled,resourcesPath:resources,profileRoot:profile,config:{rendererBundle:bundle,installedLocalAppData:root,python:process.execPath,llamaServer:process.execPath,gemmaModel:resource,lamaWorker:resource,lamaModel:resource,lamaTileWrapper:resource}});
 t.after(async()=>{await engine.close();assert.equal(globalThis.fetch,fetchBefore);syncBuiltinESMExports();});assert.equal(engine.health().ready,true);
 const result=await engine.run({jobId:'stage10-'+randomUUID(),ownerScope:'a'.repeat(64),projectId:'synthetic',inputPath:input,outputDirectory:output,pageNumber:1,sourceLanguage:'ja'}).then(value=>({value}),error=>({error}));
 return {result,state,output,engine,originalImage:image};
}
for(const defect of ['protected','inverted','stale','foreign'])test('default engine rejects '+defect+' mask before translation, cleaned output or final PNG',async t=>{
 const f=await fixture(t,defect);assert.equal(f.result.error?.code,'TEXT_MASK_INVALID');assert.equal(f.state.prepared,1);assert.equal(f.state.translationStarts,0);
 for(const file of ['cleaned.png','candidate.png','engine-report.json'])await assert.rejects(fs.access(path.join(f.output,file)),{code:'ENOENT'});
});
test('legal default mask reaches the translation boundary with durable pixel/identity evidence',async t=>{
 const f=await fixture(t);assert.equal(f.result.error?.code,'LLM_START_FAILED');assert.equal(f.state.translationStarts,1);
 const evidence=JSON.parse(await fs.readFile(path.join(f.output,'source-mask-evidence.json'),'utf8'));
 assert.equal(evidence.maskedPixels,1);assert.equal(evidence.protectedRegionPixels,0);assert.equal(evidence.qualityStatus,'REQUIRES_REVIEW');assert.equal(evidence.protectionScope,'OCR_ENVELOPES_ONLY');
});
test('mask validation failure leaves a previously saved normal PNG byte identical and publishes no partial cleaned result',async t=>{
 const f=await fixture(t,'protected',{existingCandidate:true});assert.equal(f.result.error?.code,'TEXT_MASK_INVALID');assert.equal(f.state.translationStarts,0);
 assert.deepEqual(await fs.readFile(path.join(f.output,'candidate.png')),f.originalImage);
 for(const file of ['cleaned.png','engine-report.json'])await assert.rejects(fs.access(path.join(f.output,file)),{code:'ENOENT'});
});
