import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';
const dir=new URL('../.sites-runtime/canvas-browser-checks/',import.meta.url);await mkdir(dir,{recursive:true});
for(const file of ['studio-browser','studio-shortcuts']){
 const source=await readFile(new URL(`../lib/${file}.ts`,import.meta.url),'utf8');
 await writeFile(new URL(`${file}.mjs`,dir),transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText);
}
const {browseProjects,browsePages}=await import(new URL('studio-browser.mjs',dir));
const {resolveStudioShortcut}=await import(new URL('studio-shortcuts.mjs',dir));
const items=Object.freeze([
 Object.freeze({id:'a',name:'Trio 10',updatedAt:'2026-11-01T00:00:00Z',pages:Object.freeze([{id:'a1'},{id:'a2'}])}),
 Object.freeze({id:'b',name:'Trio 2',updatedAt:'2026-11-02T00:00:00Z',pages:Object.freeze([{id:'b1'}])}),
]);
test('project sorting never changes the saved project order or copies editable project records',()=>{
 assert.deepEqual(browseProjects(items,'','recent').map(item=>item.id),['b','a']);
 assert.deepEqual(browseProjects(items,'','name').map(item=>item.id),['b','a']);
 assert.deepEqual(browseProjects(items,'','pages').map(item=>item.id),['a','b']);
 assert.deepEqual(items.map(item=>item.id),['a','b']);
 assert.equal(browseProjects(items,'','pages')[0],items[0]);
});
test('project search trims whitespace, ignores case and keeps empty projects reachable',()=>{
 const empty={id:'empty',name:'Empty',updatedAt:'2026-11-03T00:00:00Z',pages:[]};
 assert.deepEqual(browseProjects([...items,empty],' TRIO 2 ','name').map(item=>item.id),['b']);
 assert.equal(browseProjects([...items,empty],'empty','recent')[0],empty);
});
test('page search keeps original page numbers and original records when earlier pages are filtered out',()=>{
 const pages=Object.freeze([Object.freeze({id:'p1',name:'001.PNG'}),Object.freeze({id:'p2',name:'002.PNG'})]);
 assert.deepEqual(browsePages(pages,'002.png'),[{page:pages[1],index:1}]);
 assert.deepEqual(browsePages(pages,' 2 '),[{page:pages[1],index:1}]);
 assert.equal(browsePages(pages,'').length,2);
});
const context={ready:true,busy:false,hasPage:true,modal:false,drawer:false,scopeMenu:false,editable:false,browsing:true};
test('browsing projects or pages cannot edit, undo, or navigate a hidden canvas with global keys',()=>{
 for(const key of ['t','v','o','ArrowLeft','ArrowRight','Escape'])assert.equal(resolveStudioShortcut({key},context),null);
 assert.equal(resolveStudioShortcut({key:'z',ctrlKey:true},context),null);
 assert.equal(resolveStudioShortcut({key:'s',ctrlKey:true},context),'consume');
 assert.equal(resolveStudioShortcut({key:'s',metaKey:true},context),'consume');
});
test('browsing preserves drawer and engine close priority and returning to the editor restores shortcuts',()=>{
 assert.equal(resolveStudioShortcut({key:'Escape'},{...context,drawer:true}),'close-drawer');
 assert.equal(resolveStudioShortcut({key:'Escape'},{...context,drawer:true}),'close-drawer');
 assert.equal(resolveStudioShortcut({key:'t'},{...context,browsing:false}),'add-text');
 assert.equal(resolveStudioShortcut({key:'s',ctrlKey:true},{...context,browsing:false}),'download');
});
