import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';

const directory=new URL('../.sites-runtime/vertical-brush-checks/',import.meta.url);
await mkdir(directory,{recursive:true});
for(const name of ['studio-local-translation','studio-reading','studio-model','studio-state','studio-shortcuts']){
 const source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');
 await writeFile(new URL(`${name}.mjs`,directory),stripTypeScriptTypes(source).replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"'));
}
const model=await import(new URL('studio-model.mjs',directory));
const state=await import(new URL('studio-state.mjs',directory));
const shortcuts=await import(new URL('studio-shortcuts.mjs',directory));

const candidateImage='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBaYAAAAASUVORK5CYII=';
const background='data:image/png;base64,iVBORw0KGgo=';

test('vertical-rl wraps columns, invalidates horizontal finalImageSignature, fits width, and survives project restore',()=>{
 const cols=model.wrapVerticalColumns('안녕하세요 반갑습니다',100,20);
 assert.ok(cols.length>=2);
 const horizontal=model.makeBlock({id:'b1',text:'안녕하세요 반갑습니다',x:10,y:10,w:18,h:40,size:24});
 const vertical={...horizontal,writingMode:'vertical-rl'};
 assert.notEqual(model.blockVisualSignature([horizontal]),model.blockVisualSignature([vertical]));
 const fitted=model.fitBlock(vertical,{width:400,height:600});
 assert.ok(fitted.size<=vertical.size && fitted.size>=10);
 const project=model.emptyProject('세로 테스트');
 project.pages=[{id:'p1',name:'01.png',image:candidateImage,width:500,height:700,blocks:[vertical],status:'review',reviewed:false}];
 const restored=model.restoreProject(structuredClone(project));
 assert.equal(restored.pages[0].blocks[0].writingMode,'vertical-rl');
 const imported=model.validateProject(structuredClone(project));
 assert.equal(imported.pages[0].blocks[0].writingMode,'vertical-rl');
 assert.throws(()=>model.validateBlocks([{...horizontal,writingMode:'sideways'}]));
});

test('applyTextStyle copies writingMode across editable pages',()=>{
 const p1Block=model.makeBlock({id:'b1',text:'세로',x:10,y:10,w:20,h:40,writingMode:'vertical-rl'});
 const p2Block=model.makeBlock({id:'b2',text:'가로',x:10,y:10,w:20,h:40});
 const project=model.emptyProject('스타일');
 project.pages=[
  {id:'p1',name:'01.png',image:candidateImage,width:500,height:700,blocks:[p1Block],status:'review',reviewed:false},
  {id:'p2',name:'02.png',image:candidateImage,width:500,height:700,blocks:[p2Block],status:'review',reviewed:false},
 ];
 const applied=state.applyTextStyle(project,'p1','b1','all');
 assert.equal(applied.pages[1].blocks[0].writingMode,'vertical-rl');
});

test('coverStrokes bypass cached finalImage, invalidate only touched final crops, and persist through restore/import',()=>{
 const a=model.makeBlock({id:'a',text:'왼쪽',x:5,y:5,w:25,h:25,size:16});
 const b=model.makeBlock({id:'b',text:'오른쪽',x:65,y:65,w:25,h:25,size:16});
 const stroke={id:'s1',color:'#dec2f3',size:24,points:[{x:10,y:10},{x:20,y:20}]};
 const page={
  id:'p1',name:'01.png',image:candidateImage,cleanImage:background,finalImage:candidateImage,
  finalImageSignature:model.blockVisualSignature([a,b]),width:500,height:500,blocks:[a,b],
  coverStrokes:[stroke],status:'review',reviewed:false,processed:true
 };
 assert.equal(model.canUseFinalImage(page),false);
 assert.deepEqual([...model.unchangedFinalCrops(page).keys()],['b']);
 const project=model.emptyProject('브러시');
 project.pages=[page];
 const restored=model.restoreProject(structuredClone(project));
 assert.equal(restored.pages[0].coverStrokes?.length,1);
 assert.equal(restored.pages[0].coverStrokes?.[0].color,'#dec2f3');
 assert.throws(()=>model.validateCoverStrokes([{id:'bad',color:'red',size:10,points:[{x:1,y:1}]}]));
 assert.throws(()=>model.validateCoverStrokes([{id:'bad',color:'#ffffff',size:10,points:[]}]));
});

test('shortcut B activates brush tool when editor is idle',()=>{
 const ctx={ready:true,busy:false,hasPage:true,modal:false,drawer:false,scopeMenu:false,editable:false,browsing:false};
 assert.equal(shortcuts.resolveStudioShortcut({key:'b'},ctx),'brush');
 assert.equal(shortcuts.resolveStudioShortcut({key:'B'},ctx),'brush');
 assert.equal(shortcuts.resolveStudioShortcut({key:'b'},{...ctx,editable:true}),null);
});
