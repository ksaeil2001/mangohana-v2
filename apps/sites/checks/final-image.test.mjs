import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {unzipSync} from 'fflate';

const directory=new URL('../.sites-runtime/final-image-checks/',import.meta.url);
await mkdir(directory,{recursive:true});
for(const name of ['studio-local-translation','studio-reading','studio-model','studio-files','studio-state']){
 const source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');
 await writeFile(new URL(`${name}.mjs`,directory),stripTypeScriptTypes(source).replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"'));
}
const model=await import(new URL('studio-model.mjs',directory));
const files=await import(new URL('studio-files.mjs',directory));
const state=await import(new URL('studio-state.mjs',directory));
const candidateBase64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBaYAAAAASUVORK5CYII=';
const candidateBytes=Buffer.from(candidateBase64,'base64');
const candidateImage='data:image/png;base64,'+candidateBase64;
const background='data:image/png;base64,iVBORw0KGgo=';

function candidatePage(){
 const blocks=[model.makeBlock({id:'region-one',text:'엔진 번역',x:10,y:10,w:40,h:20,size:14})];
 return {id:'page-one',name:'page.png',image:'data:image/png;base64,b3JpZ2luYWw=',cleanImage:background,finalImage:candidateImage,
  finalImageSignature:model.blockVisualSignature(blocks),width:1,height:1,blocks,status:'review',reviewed:false,processed:true};
}

test('an unchanged PNG export preserves the engine candidate bytes without using a browser canvas',async()=>{
 const page=candidatePage(),snapshot=structuredClone(page);
 const blob=await files.renderPage(page);
 assert.equal(blob.type,'image/png');assert.deepEqual(Buffer.from(await blob.arrayBuffer()),candidateBytes);
 assert.deepEqual(page,snapshot);
});

test('ZIP export contains the unchanged candidate PNG bytes',async()=>{
 const oldDocument=globalThis.document,oldCreate=URL.createObjectURL,oldSetTimeout=globalThis.setTimeout;
 let downloaded,clicks=0;
 globalThis.document={body:{appendChild(){}},createElement(name){assert.equal(name,'a');return {click(){clicks++;},remove(){}};}};
 URL.createObjectURL=blob=>{downloaded=blob;return 'blob:unit-test';};
 globalThis.setTimeout=(callback,delay,...args)=>{const timer=oldSetTimeout(callback,delay,...args);if(delay===30000)timer.unref();return timer;};
 try{
  await files.downloadPages([candidatePage()],'candidate');
  assert.equal(clicks,1);assert.equal(downloaded.type,'application/zip');
  const archive=unzipSync(new Uint8Array(await downloaded.arrayBuffer()));
  assert.deepEqual(Buffer.from(archive['001-page.png']),candidateBytes);
 }finally{
  if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
  URL.createObjectURL=oldCreate;globalThis.setTimeout=oldSetTimeout;
 }
});

test('visual signatures are stable across object property order and ignore OCR and selection metadata',()=>{
 const page=candidatePage(),block=page.blocks[0];
 const reordered=Object.fromEntries(Object.entries(block).reverse());
 assert.equal(model.blockVisualSignature([reordered]),page.finalImageSignature);
 assert.equal(model.canUseFinalImage({...page,blocks:[{...block,id:'renamed-region',source:'別のOCR',confidence:.25}]}),true);
 const other={...block,id:'region-two',text:'두 번째 영역'};
 assert.notEqual(model.blockVisualSignature([block,other]),model.blockVisualSignature([other,block]));
});

test('every manual visual change invalidates the old candidate and exports the edited canvas instead',async()=>{
 const oldDocument=globalThis.document,oldImage=globalThis.Image;
 const sources=[],texts=[];let canvases=0;
 const editedBytes=Buffer.from('synthetic edited canvas PNG');
 const context={save(){},restore(){},beginPath(){},rect(){},clip(){throw new Error('manual text must never be clipped');},fillRect(){},drawImage(){},measureText(text){const w=text.length;return {width:w,actualBoundingBoxLeft:this.textAlign==='center'?w/2:0,actualBoundingBoxRight:this.textAlign==='center'?w/2:w,actualBoundingBoxAscent:6,actualBoundingBoxDescent:3};},fillText(text){texts.push(text);}};
 globalThis.document={fonts:{ready:Promise.resolve()},createElement(name){
  assert.equal(name,'canvas');canvases++;
  return {getContext(){return context;},toBlob(callback,type){callback(new Blob([editedBytes],{type}));}};
 }};
 globalThis.Image=class{set src(value){sources.push(value);queueMicrotask(()=>this.onload());}};
 try{
  const page={...candidatePage(),width:640,height:480}; // edited raster needs a physically usable box; unchanged-byte tests keep 1px
  const changes=[{text:'사용자 수정'},{x:11},{y:11},{w:41},{h:21},{font:'rounded'},{size:15},{weight:700},{align:'left'},{color:'#005566'},{lineHeight:1.7},{fill:true}];
  for(const patch of changes){
   const changed={...page,blocks:[{...page.blocks[0],...patch}]};
   const firstLine=texts.length;
   assert.equal(model.canUseFinalImage(changed),false,JSON.stringify(patch));
   assert.deepEqual(Buffer.from(await(await files.renderPage(changed)).arrayBuffer()),editedBytes);
   assert.equal(sources.at(-1),background);assert.equal(texts.slice(firstLine).join(''),changed.blocks[0].text);
   assert.equal(changed.finalImage,candidateImage);assert.equal(changed.finalImageSignature,page.finalImageSignature);
  }
  assert.equal(canvases,changes.length);
  assert.equal(model.canUseFinalImage({...page,blocks:[]}),false);
  assert.equal(model.canUseFinalImage({...page,blocks:[...page.blocks,model.makeBlock()]}),false);
 }finally{
  if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
  if(oldImage===undefined)delete globalThis.Image;else globalThis.Image=oldImage;
 }
});

test('undoing a text edit can reuse the original candidate without deleting the edited document history',()=>{
 const project=model.emptyProject('engine result');project.pages=[candidatePage()];
 let workspace=state.createWorkspaceState([project],project.id);
 workspace=state.workspaceReducer(workspace,{type:'project.update',projectId:project.id,history:'record',at:'2026-11-11T00:00:00Z',id:'manual-edit',
  updater:current=>({...current,pages:current.pages.map(page=>({...page,blocks:page.blocks.map(block=>({...block,text:'수동 수정'}))}))})});
 assert.equal(model.canUseFinalImage(workspace.projects[0].pages[0]),false);
 workspace=state.workspaceReducer(workspace,{type:'history.undo',projectId:project.id,at:'2026-11-11T00:00:01Z',id:'undo'});
 assert.equal(model.canUseFinalImage(workspace.projects[0].pages[0]),true);
 assert.equal(workspace.projects[0].pages[0].finalImage,candidateImage);
 assert.equal(workspace.histories[project.id].future.length,1);
});

test('save and backup restoration preserve candidate associations and never bless an edited or unsigned image',()=>{
 const project=model.emptyProject('round trip');project.pages=[candidatePage()];
 const saved=model.restoreProject(JSON.parse(JSON.stringify(project))),imported=model.validateProject(JSON.parse(JSON.stringify(project)));
 for(const restored of [saved,imported]){
  assert.equal(restored.pages[0].finalImageSignature,project.pages[0].finalImageSignature);
  assert.equal(model.canUseFinalImage(restored.pages[0]),true);
  assert.equal(restored.pages[0].image,project.pages[0].image);assert.equal(restored.pages[0].cleanImage,background);
 }
 const edited=structuredClone(project);edited.pages[0].blocks[0].text='저장된 수동 편집';
 const restored=model.restoreProject(edited).pages[0];
 assert.equal(restored.blocks[0].text,'저장된 수동 편집');assert.equal(restored.finalImage,candidateImage);assert.equal(model.canUseFinalImage(restored),false);
 assert.equal(model.canUseFinalImage({...project.pages[0],finalImageSignature:undefined}),false);
 assert.equal(model.canUseFinalImage({...project.pages[0],finalImage:undefined}),false);
});
