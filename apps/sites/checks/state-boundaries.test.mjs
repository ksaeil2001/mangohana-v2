import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';

const dir=new URL('../.sites-runtime/boundary-checks/',import.meta.url);
await mkdir(dir,{recursive:true});
for(const name of ['studio-local-translation','studio-reading','studio-model','studio-state','studio-persistence','studio-presentation','studio-shortcuts']){
 try{
  const source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');
  await writeFile(new URL(name+'.mjs',dir),transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText.replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"'));
 }catch(error){if(error.code!=='ENOENT')throw error;}
}
const m=await import(new URL('studio-model.mjs',dir));
const p=await import(new URL('studio-persistence.mjs',dir));
const ui=await import(new URL('studio-presentation.mjs',dir));
let keys={};try{keys=await import(new URL('studio-shortcuts.mjs',dir));}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}

test('a storage conflict stays visible while later edits remain available for backup',async()=>{
 const conflict=Object.assign(new Error('another tab saved'),{name:'WorkspaceConflictError'});
 const writes=[],states=[];
 const queue=new p.AutosaveQueue(async value=>{writes.push(value);throw conflict;},state=>states.push(state),10000);
 try{
  queue.schedule('first edit');await assert.rejects(queue.flush(),/another tab/);
  queue.schedule('latest edit');
  assert.equal(states.at(-1).phase,'error');assert.equal(states.at(-1).conflict,true);
  await assert.rejects(queue.flush(),/another tab/);assert.deepEqual(writes,['first edit']);
 }finally{queue.close();}
});
test('a normal storage error can retry the newest snapshot without a conflict lock',async()=>{
 let fail=true;const writes=[];
 const queue=new p.AutosaveQueue(async value=>{if(fail)throw new Error('quota');writes.push(value);},()=>{},10000);
 try{queue.schedule('old');await assert.rejects(queue.flush(),/quota/);queue.schedule('latest');fail=false;await queue.flush();assert.deepEqual(writes,['latest']);}finally{queue.close();}
});
test('a project backup restores every manually created region beyond the OCR response limit',()=>{
 const project=m.sampleProject();project.pages[0].blocks=Array.from({length:1001},(_,i)=>m.makeBlock({id:`manual-${i}`,text:`대사 ${i}`}));
 const imported=m.validateProject(JSON.parse(JSON.stringify(project)));
 assert.equal(imported.pages[0].blocks.length,1001);assert.equal(imported.pages[0].blocks[1000].text,'대사 1000');
});
test('large project backups do not remove the separate OCR response limit',()=>{
 assert.throws(()=>m.validateBlocks(Array.from({length:1001},(_,i)=>m.makeBlock({id:`ocr-${i}`}))),/데이터/);
});

const shortcut=(key,context={},modifiers={})=>{
 assert.equal(typeof keys.resolveStudioShortcut,'function','keyboard ownership must have one explicit resolver');
 return keys.resolveStudioShortcut({key,...modifiers},{ready:true,busy:false,hasPage:true,modal:false,drawer:false,scopeMenu:false,editable:false,...context});
};
test('save shortcuts cannot replace settings, rename, or an existing download dialog',()=>{
 assert.equal(shortcut('s',{modal:true},{ctrlKey:true}),'consume');
 assert.equal(shortcut('s',{modal:true},{metaKey:true}),'consume');
 assert.equal(shortcut('s',{}, {ctrlKey:true}),'download');
 assert.equal(shortcut('s',{busy:true},{ctrlKey:true}),'consume');
});
test('native modified keys do not add text, toggle OCR, or navigate the canvas',()=>{
 for(const key of ['t','o','ArrowLeft','ArrowRight','v','?']){
  assert.equal(shortcut(key,{}, {ctrlKey:true}),null,key);
  assert.equal(shortcut(key,{}, {altKey:true}),null,key);
 }
});
test('text input and IME own their editing keys while workspace undo remains available',()=>{
 assert.equal(shortcut('z',{editable:true},{ctrlKey:true}),null);
 assert.equal(shortcut('ArrowRight',{editable:true}),null);
 assert.equal(shortcut('Enter',{}, {isComposing:true}),null);
 assert.equal(shortcut('s',{}, {isComposing:true,ctrlKey:true}),null);
 assert.equal(shortcut('z',{}, {ctrlKey:true}),'undo');
 assert.equal(shortcut('Z',{}, {metaKey:true,shiftKey:true}),'redo');
});
test('Escape dismisses the nearest scope before the drawer and selection',()=>{
 assert.equal(shortcut('Escape',{scopeMenu:true,drawer:true}),'close-scope');
 assert.equal(shortcut('Escape',{drawer:true}),'close-drawer');
 assert.equal(shortcut('Tab',{drawer:true}),'cycle-drawer');
 assert.equal(shortcut('Escape',{}),'clear-selection');
 assert.equal(shortcut('Escape',{modal:true}),null);
});
test('canvas single-key commands require hydration and do not escape focused inputs',()=>{
 assert.equal(shortcut('t',{ready:false}),null);
 assert.equal(shortcut('t',{editable:true}),null);
 assert.equal(shortcut('t',{}),'add-text');assert.equal(shortcut('o',{}),'toggle-ocr');
 assert.equal(shortcut('ArrowLeft',{}),'previous-page');assert.equal(shortcut('ArrowRight',{}),'next-page');
});

const availability=(format,project,page)=>{
 assert.equal(typeof ui.exportAvailability,'function','all export entry points must share page eligibility');
 return ui.exportAvailability(format,project,page);
};
test('PNG and ZIP exclude pending and failed outputs while TRIO still preserves them',()=>{
 const project=m.sampleProject();
 for(const state of [{status:'processing'},{status:'paused',jobId:'pending'},{status:'failed',error:'offline'},{status:'review',jobId:'pending'}]){
  const page={...project.pages[0],...state};const pending={...project,pages:[page]};
  assert.equal(availability('png',pending,page).allowed,false);
  assert.equal(availability('zip',pending,page).allowed,false);
  assert.equal(availability('project',pending,page).allowed,true);
  assert.ok(availability('png',pending,page).reason);
 }
});
test('an empty project has a backup path and no image export path',()=>{
 const empty=m.emptyProject('empty');assert.equal(availability('project',empty,undefined).allowed,true);
 assert.equal(availability('png',empty,undefined).allowed,false);assert.equal(availability('zip',empty,undefined).allowed,false);
});
test('ZIP still includes other eligible pages when the selected page is pending',()=>{
 const project=m.sampleProject(),pending={...project.pages[0],jobId:'pending'};
 project.pages[0]=pending;
 assert.equal(availability('png',project,pending).allowed,false);assert.equal(availability('zip',project,pending).allowed,true);
 assert.equal(availability('png',project,project.pages[1]).allowed,true);
});
