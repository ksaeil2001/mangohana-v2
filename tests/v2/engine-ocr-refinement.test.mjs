// Orchestration contracts with synthetic providers/images and owned small Node
// children only. No Electron browser, OCR/model runtime or user page is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createRequire,Module,syncBuiltinESMExports} from 'node:module';
const require=createRequire(import.meta.url),enginePath=require.resolve('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs');
const boundaries=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const key='__mangohanaRefinementFixture',sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const enabled=!!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR;
const opts={timeout:15_000,skip:!enabled};
const quad=(x,y,w,h)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
function boxOf(quads){const points=quads.flat(),x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y));return {x,y,width:Math.max(...points.map(p=>p.x))-x,height:Math.max(...points.map(p=>p.y))-y};}
function group(id,quads,width,height,text,readingOrder){const b=boxOf(quads),bbox={x:b.x/width,y:b.y/height,width:b.width/width,height:b.height/height};return {id,type:'speech_bubble',text,language:'ja',readingOrder,bbox,polygon:quad(bbox.x,bbox.y,bbox.width,bbox.height),confidence:.9,orientation:'vertical',notes:'',speakerCandidates:[],productionOcrProvenance:{contractVersion:1,detectorModelId:'synthetic-detector',detectorRevision:'synthetic-detector-revision',recognizerModelId:'synthetic-recognizer',recognizerRevision:'synthetic-recognizer-revision',groupId:id,sourceDetectionIds:quads.map((_,i)=>id+':'+i),sourceQuadsPx:quads,sourceDetectionScores:quads.map(()=>.9),orientation:'vertical',cropTransform:{sourceBboxPx:b,cropBboxPx:b,paddingRatio:.08,rotationDegrees:0,imageWidth:width,imageHeight:height},confidenceSource:'detector_min',recognition:{rawOcrText:text,normalizedOcrText:text,normalization:'synthetic-normalization'}}};}
function crc(bytes){let c=0xffffffff;for(const byte of bytes){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function png(width,height){const chunk=(kind,data)=>{const body=Buffer.concat([Buffer.from(kind),data]),out=Buffer.alloc(body.length+8);out.writeUInt32BE(data.length);body.copy(out,4);out.writeUInt32BE(crc(body),out.length-4);return out;},header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=0;const raw=Buffer.alloc((width+1)*height,255);for(let y=0;y<height;y++)raw[y*(width+1)]=0;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}

async function fixture(t,{refine=true,reuse=false,configOverrides={},defect}={}){
 const root=path.resolve(process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR,'ocr-refinement-'+randomUUID());await fs.mkdir(root,{recursive:true});
 await fs.writeFile(path.join(root,'synthetic-scope.json'),JSON.stringify({scope:'SOURCE_ONLY_SYNTHETIC_OCR_REFINEMENT_ORCHESTRATION',actualAiCalls:0,actualModelsLoaded:0,userImagesUsed:0,browserFlow:false}));
 const compiled=path.join(root,'compiled'),resources=path.join(root,'resources'),profile=path.join(root,'profile');for(const folder of [compiled,resources,profile])await fs.mkdir(folder);await fs.writeFile(path.join(compiled,'package.json'),'{"type":"module"}');
 const image=png(1000,1000),imageSha256=sha(image),beforeFetch=globalThis.fetch;
 const original={pageNumber:1,speechBubbles:[group('parent',[quad(110,110,40,70),quad(310,130,50,80),quad(510,120,50,80)],1000,1000,'SYNTHETIC_PARENT_DO_NOT_SPLIT_STRING',1),group('other',[quad(750,750,50,50)],1000,1000,'SYNTHETIC_OTHER',2)],nonSpeechText:[],warnings:[]};
 if(['margin','margin-text-change'].includes(defect)){
  original.speechBubbles[0].text='SYNTHETIC_CROP_1SYNTHETIC_CROP_2SYNTHETIC_CROP_3';
  Object.assign(original.speechBubbles[0].productionOcrProvenance.recognition,{rawOcrText:original.speechBubbles[0].text,normalizedOcrText:original.speechBubbles[0].text});
 }
 const detection={version:1,ok:true,width:1000,height:1000,imageSha256,executionProvider:'CPUExecutionProvider',model:{sha256:'5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79'},regions:[{id:'left',kind:'text_bubble',confidence:.9,bbox:{x:.1,y:.1,width:.07,height:.1}},{id:'middle',kind:'text_bubble',confidence:.9,bbox:{x:.3,y:.12,width:.08,height:.1}},{id:'right',kind:'text_bubble',confidence:.9,bbox:{x:.5,y:.11,width:.08,height:.1}},{id:'other-roi',kind:'text_bubble',confidence:.9,bbox:{x:.74,y:.74,width:.08,height:.08}}]};
 const state={trace:[],owners:[],children:[],original,fullCalls:0,cropCalls:0,statusCalls:0,crops:[],prepared:[],protected:[],defect,services:0};globalThis[key]=state;
 const write=async(relative,body)=>{const target=path.join(compiled,'src',relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,body);};
 // The first full execution legitimately creates a lazy child. Crop execution
 // uses the same child; a requested restart exercises the real ALS spawn guard.
 await write('main/productionOcrService.js',`import {spawn} from 'node:child_process';const s=globalThis.${key};export function createProductionOcrService(){const service=++s.services;let child;return {getStatus:async()=>{s.statusCalls++;s.trace.push('status');return {ready:true};},execute:async({imageBytes,pageNumber,signal})=>{const full=imageBytes.readUInt32BE(16)===1000;if(full){s.trace.push('full');s.fullCalls++;s.activeService=service;if(!child||child.exitCode!==null){child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});s.children.push(child);}return {...structuredClone(s.original),pageNumber};}s.trace.push('crop');s.cropCalls++;if(s.defect==='spawn')spawn(process.execPath,['-e','process.exit(0)'],{windowsHide:true,stdio:'ignore'});if(s.defect==='dead'){child.kill('SIGKILL');await new Promise(r=>child.once('close',r));}if(s.defect==='abort')s.abortController.abort();return s.cropResponse(imageBytes,pageNumber);},close:()=>{s.trace.push('close:'+service);if(child&&child.exitCode===null)child.kill('SIGKILL');child=undefined;}};}`);
 await write('main/productionTypesetFontResource.js','export async function initializeProductionTypesetFontResource(){return {enabled:true,handleProtocolRequest(){}};}');
 await write('main/translation/translationEngineRegistry.js','export function createTranslationEngineRegistry(){return {};}');
 await write('main/translation/adapters/localAiAdapter.js','export function createLocalAiTranslationAdapter(){return {};}');
 await write('shared/translation/translationPayload.js','export const unused=true;');
 await write('shared/translation/translationQa.js','export const unused=true;');
 const bundle=path.join(compiled,'renderer.js');await fs.writeFile(bundle,'/* synthetic renderer, no browser */');
 const resource=path.join(root,'not-a-model.bin');await fs.writeFile(resource,'SYNTHETIC FIXTURE, NOT AN AI MODEL');
 const detectorWorker=path.join(root,'detector-fixture.cjs'),maskWorker=path.join(root,'mask-fixture.cjs'),detectionPath=path.join(root,'synthetic-detection.json');await fs.writeFile(detectionPath,JSON.stringify(detection));
 const replyWorker=path.join(root,'json-worker.cjs');await fs.writeFile(replyWorker,`let data='';process.stdin.on('data',part=>{data+=part;if(data.includes('\\n')){process.stdout.write(require('node:fs').readFileSync(process.argv[2]));process.exit(0);}});`);await fs.writeFile(detectorWorker,'SYNTHETIC DETECTOR');await fs.writeFile(maskWorker,'SYNTHETIC MASK');
 const maskReplyPath=path.join(root,'synthetic-mask.json');await fs.writeFile(maskReplyPath,JSON.stringify({maskRgbaPngBase64:image.toString('base64'),maskPngBase64:image.toString('base64'),maskKind:'SYNTHETIC_SOURCE_TEST_MASK',regions:detection.regions.map(r=>({id:r.id}))}));
 state.cropResponse=(bytes,pageNumber)=>{const crop=state.crops[state.cropCalls-1],quads=original.speechBubbles[0].productionOcrProvenance.sourceQuadsPx.filter(q=>q.every(p=>p.x>=crop.x&&p.y>=crop.y&&p.x<=crop.x+crop.width&&p.y<=crop.y+crop.height)).map(q=>q.map(p=>({x:p.x-crop.x,y:p.y-crop.y})));const result={pageNumber,speechBubbles:[group('local-ocr',quads,bytes.readUInt32BE(16),bytes.readUInt32BE(20),'SYNTHETIC_CROP_'+state.cropCalls,1)],nonSpeechText:[],warnings:[]};if(defect==='empty')result.speechBubbles=[];if(defect==='foreign-model')result.speechBubbles[0].productionOcrProvenance.recognizerModelId='foreign';return result;};
 const baseCropResponse=state.cropResponse;
 state.cropResponse=(bytes,pageNumber)=>{
  const result=baseCropResponse(bytes,pageNumber);
  if(['margin','margin-text-change'].includes(defect)){
   const g=result.speechBubbles[0],p=g.productionOcrProvenance;
   const quads=p.sourceQuadsPx.map(q=>{const b=boxOf([q]);return quad(b.x+b.width*.2,b.y,b.width*.6,b.height);});
   result.speechBubbles=[group(g.id,quads,bytes.readUInt32BE(16),bytes.readUInt32BE(20),g.text+(defect==='margin-text-change'?'_CHANGED':''),1)];
  }
  return result;
 };
 class Owner extends boundaries.ProcessOwner{
  constructor(){super();state.owners.push(this);}
  spawn(executable,args,options){if(args.includes(detectorWorker)){state.trace.push('detector');return super.spawn(process.execPath,[replyWorker,detectionPath],options);}if(args.includes(maskWorker)){state.trace.push('mask');return super.spawn(process.execPath,[replyWorker,maskReplyPath],options);}if(args[0]==='--help'){state.trace.push('translation-start');throw Object.assign(new Error('Synthetic stop before any translation/model execution'),{code:'LLM_START_FAILED'});}throw new Error('Unexpected fixture process request');}
 }
 class Window{
  constructor(){this.dead=false;this.events={};this.webContents={setWindowOpenHandler(){},on(){},executeJavaScript:async source=>{if(source.startsWith('typeof window.SitesCandidate'))return true;const match=/window\.SitesCandidate\.(prepare|render)\(([\s\S]*)\)$/.exec(source);if(!match)return;const args=JSON.parse(match[2]);assert.equal(match[1],'prepare');state.trace.push('prepare');state.prepared.push(structuredClone(args.ocr));return {jobId:args.jobId,lines:args.ocr.speechBubbles.map(g=>({id:g.id,order:g.readingOrder,sourceText:g.text,sourceLanguage:'ja',ocrEditStatus:'ai_proposed'})),mask:{maskPngBase64:image.toString('base64'),maskedPixels:1,regions:[]}};}};}
  once(name,callback){this.events[name]=callback;}async loadURL(){}isDestroyed(){return this.dead;}destroy(){this.dead=true;this.events.closed?.();}
 }
 const makeImage=bytes=>{const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);return {getSize:()=>({width,height}),isEmpty:()=>false,toPNG:()=>bytes,toBitmap:()=>Buffer.alloc(width*height*4),crop:rect=>{state.crops.push(structuredClone(rect));return {getSize:()=>({width:rect.width,height:rect.height}),isEmpty:()=>false,toPNG:()=>png(defect==='png-shape'?1:rect.width,rect.height)};}};};
 const electron={app:{isReady:()=>true},BrowserWindow:Window,session:{fromPartition:()=>({setPermissionRequestHandler(){},protocol:{handle(){},unhandle(){}},webRequest:{onBeforeRequest(){}}})},nativeImage:{createFromBuffer:makeImage}};
 // These OCR/lifetime fixtures have a synthetic native decoder and no real
 // mask pixels. Stage10's separate engine-mask tests exercise the real verifier.
 const originalLoad=Module._load;Module._load=function(request,parent,isMain){if(request==='electron')return electron;if(parent?.filename===enginePath){if(request==='./engine-boundaries.cjs')return {...boundaries,ProcessOwner:Owner};if(request==='../../../../quality/mask-evidence.cjs')return {...originalLoad.call(this,request,parent,isMain),verifySourceTextMask:()=>({maskedPixels:1,qualityStatus:'SYNTHETIC_PIXEL_PORT_NOT_MEASURED'}),verifyLearnedMask:({protectedRegions})=>{state.protected.push(structuredClone(protectedRegions));return {maskedPixels:1,outsideSelectedRegions:0,protectedRegionPixels:0};}};}return originalLoad.call(this,request,parent,isMain);};
 let api;try{delete require.cache[enginePath];api=require(enginePath);}finally{Module._load=originalLoad;}
 const config={rendererBundle:bundle,installedLocalAppData:root,python:process.execPath,llamaServer:process.execPath,gemmaModel:resource,lamaWorker:resource,lamaModel:resource,lamaTileWrapper:resource,regionDetectorWorker:detectorWorker,regionDetectorModel:resource,textMaskWorker:maskWorker,textMaskModel:resource,...(refine===undefined?{}:{refineConnectedOcr:refine}),reuseOcrRuntime:reuse,...configOverrides};
 const engine=await api.createEngine({repository:root,buildRoot:compiled,resourcesPath:resources,profileRoot:profile,config});
 t.after(async()=>{try{await engine.close();}finally{await Promise.allSettled(state.owners.map(o=>boundaries.ProcessOwner.prototype.cleanup.call(o)));await fs.writeFile(path.join(root,'owned-child-exit.json'),JSON.stringify({scope:'SYNTHETIC_ONLY_NO_AI',children:state.children.map(c=>({pid:c.pid,exitCode:c.exitCode,signalCode:c.signalCode})),hooksReleased:globalThis.fetch===beforeFetch}));delete globalThis[key];syncBuiltinESMExports();}});
 const run=async(number=1,setup)=>{const output=path.join(root,'job-'+number);await fs.mkdir(output);const input=path.join(output,'source.png');await fs.writeFile(input,image);await setup?.(output);const abortController=new AbortController();state.abortController=abortController;const result=await engine.run({jobId:'synthetic-'+number,ownerScope:'a'.repeat(64),projectId:'synthetic-book',inputPath:input,outputDirectory:output,pageNumber:1,sourceLanguage:'ja',signal:abortController.signal}).then(value=>({ok:true,value}),error=>({ok:false,error}));return {...result,output,input};};
 return {engine,run,state,root,image,config};
}
const read=async(file)=>JSON.parse(await fs.readFile(file,'utf8'));
async function absent(file){await assert.rejects(fs.access(file),{code:'ENOENT'});}

test('refinement executes three service.execute crop requests inside one cold lifetime, preserving raw evidence and refined mask protection',opts,async t=>{
 const f=await fixture(t),r=await f.run();assert.equal(r.error?.code,'LLM_START_FAILED');assert.equal(f.state.fullCalls,1);assert.equal(f.state.cropCalls,3);assert.equal(f.state.statusCalls,1);assert.equal(f.state.children.length,1);
 assert.deepEqual(f.state.trace.filter(v=>['detector','status','full','crop','prepare','mask','translation-start'].includes(v)),['detector','status','full','crop','crop','crop','prepare','mask','translation-start']);assert.ok(f.state.trace.indexOf('close:'+f.state.activeService)<f.state.trace.indexOf('prepare'));
 const raw=await read(path.join(r.output,'raw-ocr.json')),refined=await read(path.join(r.output,'refined-ocr.json')),selected=await read(path.join(r.output,'ocr.json'));assert.deepEqual(raw,f.state.original);assert.equal(refined.speechBubbles.length,4);assert.equal(selected.speechBubbles.length,4);assert.deepEqual(refined.speechBubbles.map(g=>g.readingOrder),[1,2,3,4]);assert.equal(raw.speechBubbles[1].readingOrder,2);assert.equal(refined.speechBubbles[3].text,'SYNTHETIC_OTHER');assert.equal(f.state.protected[0].some(g=>g.id==='parent'),false);assert.equal(f.state.protected[0].length,0);
 const evidence=await read(path.join(r.output,'ocr-refinement','evidence.json'));assert.equal(evidence.additionalOcrCalls,3);assert.equal(evidence.sourceSha256,sha(f.image));assert.equal(evidence.sourceImageSha256,sha(f.image));assert.equal(evidence.crops.length,3);for(const crop of evidence.crops){assert.equal(sha(await fs.readFile(path.join(r.output,...crop.pngFile.split('/')))),crop.cropSha256);assert.equal(sha(await fs.readFile(path.join(r.output,...crop.rawOcrFile.split('/')))),crop.rawOcrSha256);assert.match(crop.cropId,/^ocr-crop-/);}
 await absent(path.join(r.output,'engine-report.json'));await absent(path.join(r.output,'candidate.png'));assert.equal(sha(await fs.readFile(r.input)),sha(f.image));
});
test('default and explicit false retain full OCR lifetime with no crop inference and explicitly hold unresolved connected dialogue',opts,async t=>{
 for(const refineConnectedOcr of [undefined,false]){const f=await fixture(t,{configOverrides:{refineConnectedOcr}}),r=await f.run();assert.equal(r.error?.code,'OCR_REVIEW_REQUIRED');assert.equal(f.state.cropCalls,0);assert.ok(f.state.trace.indexOf('full')<f.state.trace.indexOf('detector'));assert.ok(f.state.trace.indexOf('close:'+f.state.activeService)<f.state.trace.indexOf('detector'));await absent(path.join(r.output,'ocr-refinement'));await absent(path.join(r.output,'refined-ocr.json'));assert.deepEqual(await read(path.join(r.output,'raw-ocr.json')),f.state.original);await f.engine.close();}
});
test('cached full and crop OCR keep a separate owner across jobs without status or lazy-child restarts',opts,async t=>{
 const f=await fixture(t,{reuse:true});for(let page=1;page<=2;page++){f.state.cropCalls=0;f.state.crops=[];const r=await f.run(page);assert.equal(r.error?.code,'LLM_START_FAILED');assert.equal(f.state.cropCalls,3);assert.equal(f.state.children[0].exitCode,null);}assert.equal(f.state.statusCalls,1);assert.equal(f.state.fullCalls,2);assert.equal(f.state.children.length,1);await f.engine.close();assert.ok(f.state.children.every(c=>c.exitCode!==null||c.signalCode!==null));
});
test('a crop lazy respawn is denied before creating a child and never replays full OCR',opts,async t=>{
 for(const reuse of [false,true]){const f=await fixture(t,{reuse,defect:'spawn'}),r=await f.run();assert.equal(r.error?.code,'PROCESS_RESTART_REQUIRED');assert.equal(f.state.fullCalls,1);assert.equal(f.state.cropCalls,1);assert.equal(f.state.children.length,1);assert.equal(f.state.trace.includes('prepare'),false);assert.deepEqual(await read(path.join(r.output,'raw-ocr.json')),f.state.original);await absent(path.join(r.output,'ocr.json'));await f.engine.close();assert.ok(f.state.children.every(c=>c.exitCode!==null||c.signalCode!==null));}
});
test('empty crop OCR or a dead retained child preserves raw/source evidence and cannot reach translation',opts,async t=>{
 for(const defect of ['empty','dead','foreign-model']){const f=await fixture(t,{defect}),r=await f.run();assert.equal(r.ok,false);assert.ok(['OCR_REFINEMENT_RESPONSE_INVALID','PROCESS_RESTART_REQUIRED'].includes(r.error?.code));assert.equal(f.state.fullCalls,1);assert.equal(f.state.trace.includes('translation-start'),false);assert.equal(sha(await fs.readFile(r.input)),sha(f.image));assert.deepEqual(await read(path.join(r.output,'raw-ocr.json')),f.state.original);await absent(path.join(r.output,'refined-ocr.json'));await absent(path.join(r.output,'ocr.json'));await f.engine.close();}
});
test('cancellation during crop OCR drains the same owner and never publishes a refined page',opts,async t=>{
 const f=await fixture(t,{defect:'abort'}),r=await f.run();assert.equal(r.error?.code,'CANCELLED');assert.equal(f.state.fullCalls,1);assert.equal(f.state.cropCalls,1);assert.equal(f.state.trace.includes('prepare'),false);await absent(path.join(r.output,'ocr.json'));await f.engine.close();assert.ok(f.state.children.every(c=>c.exitCode!==null||c.signalCode!==null));
});
test('foreign crop shape and existing refinement artifacts fail before extra inference without overwriting anything',opts,async t=>{
 const bad=await fixture(t,{defect:'png-shape'}),r=await bad.run();assert.equal(r.error?.code,'OCR_REFINEMENT_INVALID');assert.equal(bad.state.cropCalls,0);await absent(path.join(r.output,'ocr.json'));await bad.engine.close();
 const conflict=await fixture(t),c=await conflict.run(1,async output=>{await fs.mkdir(path.join(output,'ocr-refinement'));await fs.writeFile(path.join(output,'ocr-refinement','keep.txt'),'PRESERVE');});assert.equal(c.error?.code,'OUTPUT_EXISTS');assert.equal(conflict.state.cropCalls,0);assert.equal(await fs.readFile(path.join(c.output,'ocr-refinement','keep.txt'),'utf8'),'PRESERVE');
});
test('refinement is an explicit boolean requiring a learned region detector; invalid options create no work',opts,async t=>{
 for(const configOverrides of [{refineConnectedOcr:'true'},{regionDetectorWorker:undefined,regionDetectorModel:undefined,textMaskWorker:undefined,textMaskModel:undefined}]){const f=await fixture(t,{configOverrides});assert.equal(f.engine.health().ready,false);assert.equal(f.state.fullCalls,0);assert.equal(f.state.children.length,0);await f.engine.close();}
});

test('margin correspondence reaches renderer drafts and learned mask IDs while leaving glyph quality pending',opts,async t=>{
 const f=await fixture(t,{defect:'margin'}),r=await f.run();assert.equal(r.error?.code,'LLM_START_FAILED');
 assert.equal(f.state.cropCalls,3);assert.equal(f.state.prepared[0].speechBubbles.length,4);
 const children=f.state.prepared[0].speechBubbles.filter(g=>g.ocrRefinement);assert.equal(children.length,3);
 assert.ok(children.every(g=>g.ocrRefinement.validation.requiresHumanReview));
 const selection=await read(path.join(r.output,'region-selection.json'));assert.ok(children.every(g=>selection.selection.decisions.some(d=>d.id===g.id&&d.action==='translate')));
 const mask=await read(path.join(r.output,'learned-mask-evidence.json'));assert.ok(children.every(g=>mask.regions.some(x=>x.sourceDialogueIds.includes(g.id))));
 assert.deepEqual(await read(path.join(r.output,'raw-ocr.json')),f.state.original);
});
test('uncertain connected dialogue stops before masks and translation with a durable review packet',opts,async t=>{
 for(const options of [{refine:false},{defect:'margin-text-change'}]){
  const f=await fixture(t,options),r=await f.run();assert.equal(r.error?.code,'OCR_REVIEW_REQUIRED');
  assert.equal(f.state.trace.includes('prepare'),false);assert.equal(f.state.trace.includes('mask'),false);assert.equal(f.state.trace.includes('translation-start'),false);
  const review=await read(path.join(r.output,'ocr-review.json'));assert.equal(review.status,'needs_review');assert.ok(review.selection.decisions.some(d=>d.id==='parent'&&d.action==='needs_review'));
  assert.deepEqual(await read(path.join(r.output,'raw-ocr.json')),f.state.original);await absent(path.join(r.output,'candidate.png'));await f.engine.close();
 }
});
