import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';
const dir=new URL('../.sites-runtime/reading-checks/',import.meta.url);await mkdir(dir,{recursive:true});
for(const name of ['studio-local-translation','studio-model','studio-reading','studio-state','studio-storage','studio-persistence']){
 try{const source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');const output=transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText.replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"');await writeFile(new URL(name+'.mjs',dir),output);}catch(error){if(error.code!=='ENOENT')throw error;}
}
const m=await import(new URL('studio-model.mjs',dir)),s=await import(new URL('studio-state.mjs',dir)),storage=await import(new URL('studio-storage.mjs',dir));
let reading={};try{reading=await import(new URL('studio-reading.mjs',dir));}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const persistence=await import(new URL('studio-persistence.mjs',dir));
const position=pageId=>({pageId,zoom:2,view:'original',anchor:{x:.6,y:.72}});
const saved=(projects,readings)=>({version:1,projects,activeId:projects[0].id,endpoints:{local:'',online:'/api/engine'},reading:readings});
const requireFunction=name=>assert.equal(typeof reading[name],'function',`${name} is required`);

test('hydration retains the actual saved page, zoom, view and scroll anchor',()=>{
 const project=m.sampleProject(),where=position(project.pages[2].id);
 const loaded=storage.normalizeWorkspace(saved([project],{[project.id]:where}));
 const state=s.workspaceReducer(s.createWorkspaceState([],''),{type:'workspace.restore',projects:loaded.projects,activeId:loaded.activeId,reading:loaded.reading});
 assert.deepEqual(state.reading?.[project.id],where);
});
test('invalid or deleted page positions cannot survive storage normalization or select a stale project',()=>{
 const project=m.sampleProject();const loaded=storage.normalizeWorkspace(saved([project],{
  [project.id]:{...position('deleted-page'),zoom:Infinity},deletedProject:position('old'),
 }));
 assert.equal(loaded.reading?.deletedProject,undefined);
 assert.deepEqual(loaded.reading?.[project.id],{pageId:project.pages[0].id,zoom:1,view:'preview',anchor:{x:.5,y:0}});
});
test('view updates leave document history, manual dialogue and engine results untouched',()=>{
 const project=m.sampleProject(),where=position(project.pages[0].id);let state=s.createWorkspaceState([project],project.id,{[project.id]:where});
 const beforeProjects=state.projects,beforeHistory=state.histories;
 state=s.workspaceReducer(state,{type:'reading.update',projectId:project.id,pageId:where.pageId,patch:{anchor:{x:.4,y:.9},zoom:value=>value+.15}});
 assert.equal(state.projects,beforeProjects);assert.equal(state.histories,beforeHistory);
 assert.equal(state.reading?.[project.id].zoom,2.15);assert.equal(state.reading?.[project.id].anchor.y,.9);
 const received=s.workspaceReducer(state,{type:'project.update',projectId:project.id,history:'barrier',at:'2026-11-11T01:00:00Z',id:'result',updater:p=>({...p,pages:p.pages.map((pg,i)=>i?pg:{...pg,finalImage:'data:image/png;base64,YQ==',blocks:[{...pg.blocks[0],text:'새 결과'}]})})});
 assert.equal(received.reading,state.reading);assert.equal(received.projects[0].pages[0].blocks[0].text,'새 결과');
});
test('page navigation rejects late old-page scrolling and project switching restores each project',()=>{
 const a=m.sampleProject(),b={...m.sampleProject(),id:'second'};const one=position(a.pages[1].id),two={...position(b.pages[3].id),zoom:1.3};
 let state=s.createWorkspaceState([a,b],a.id,{[a.id]:one,[b.id]:two});
 state=s.workspaceReducer(state,{type:'reading.select',projectId:a.id,pageId:a.pages[2].id});
 const selected=state;
 state=s.workspaceReducer(state,{type:'reading.update',projectId:a.id,pageId:one.pageId,patch:{anchor:{x:.9,y:.9}}});
 assert.equal(state,selected);assert.equal(state.reading?.[a.id].pageId,a.pages[2].id);
 state=s.workspaceReducer(state,{type:'project.select',projectId:b.id});assert.deepEqual(state.reading?.[b.id],two);
 state=s.workspaceReducer(state,{type:'project.select',projectId:a.id});assert.equal(state.reading?.[a.id].pageId,a.pages[2].id);
});
test('deleting a page falls back safely while project delete undo restores its own reading position',()=>{
 const project=m.sampleProject(),where=position(project.pages[2].id);let state=s.createWorkspaceState([project],project.id,{[project.id]:where});
 const removed=s.workspaceReducer(state,{type:'project.delete',projectId:project.id});assert.equal(removed.reading?.[project.id],undefined);
 const restored=s.workspaceReducer(removed,{type:'project.restore-deleted'});assert.deepEqual(restored.reading?.[project.id],where);
 state=s.workspaceReducer(state,{type:'projects.replace',updater:projects=>projects.map(p=>({...p,pages:p.pages.filter(pg=>pg.id!==where.pageId)}))});
 assert.equal(state.reading?.[project.id].pageId,project.pages[0].id);
});
test('a normalized viewport anchor survives content and mobile viewport size changes',()=>{
 requireFunction('captureReadingAnchor');requireFunction('readingScrollTarget');
 const anchor=reading.captureReadingAnchor({scrollLeft:400,scrollTop:1600,scrollWidth:2000,scrollHeight:4000,clientWidth:800,clientHeight:800});
 assert.deepEqual(anchor,{x:.4,y:.5});
 assert.deepEqual(reading.readingScrollTarget(anchor,{scrollWidth:3000,scrollHeight:6000,clientWidth:600,clientHeight:600}),{left:900,top:2700});
 assert.deepEqual(reading.readingScrollTarget(anchor,{scrollWidth:200,scrollHeight:300,clientWidth:800,clientHeight:800}),{left:0,top:0});
});
test('a delayed viewport restore cannot overwrite a later user scroll or a different page',()=>{
 assert.equal(typeof reading.ReadingViewportSession,'function');const session=new reading.ReadingViewportSession(),writes=[];
 const viewport={scrollWidth:1000,scrollHeight:2000,clientWidth:500,clientHeight:500,scrollTo:value=>writes.push(value)};
 const old=session.activate('first');session.interact('first');assert.equal(session.restore(old,viewport,{x:.5,y:.75}),false);
 const fresh=session.activate('first');assert.equal(session.restore(fresh,viewport,{x:.5,y:.75}),true);
 const changed=session.activate('second');assert.equal(session.restore(fresh,viewport,{x:.5,y:.75}),false);assert.equal(session.restore(changed,viewport,{x:.5,y:0}),true);
 assert.deepEqual(writes,[{left:250,top:1250},{left:250,top:0}]);
});
test('reading-only autosave is dirty and a delayed write cannot replace newer manual edits',async()=>{
 const project=m.sampleProject(),initial=saved([project],{[project.id]:position(project.pages[0].id)});
 assert.equal(typeof storage.sameWorkspaceSnapshot,'function');
 const scrolled={...initial,reading:{...initial.reading,[project.id]:{...initial.reading[project.id],anchor:{x:.5,y:.9}}}};
 assert.equal(storage.sameWorkspaceSnapshot(initial,scrolled),false);
 const current={...scrolled,projects:[{...project,pages:project.pages.map((pg,i)=>i?pg:{...pg,blocks:[{...pg.blocks[0],text:'수동 수정 보호'}]})}]};
 let release,entered;const gate=new Promise(resolve=>{release=resolve}),started=new Promise(resolve=>{entered=resolve});const writes=[];
 const queue=new persistence.AutosaveQueue(async snapshot=>{writes.push(snapshot);if(writes.length===1){entered();await gate;}},()=>{},10000);
 queue.schedule(initial);const pending=queue.flush();await started;queue.schedule(scrolled);queue.schedule(current);release();await pending;queue.close();
 assert.deepEqual(writes,[initial,current]);assert.equal(writes.at(-1).projects[0].pages[0].blocks[0].text,'수동 수정 보호');assert.equal(writes.at(-1).reading[project.id].anchor.y,.9);
});
test('a hidden-screen reading snapshot flushes even when a preceding empty flush is settling',async()=>{
 const project=m.sampleProject(),snapshot=saved([project],{[project.id]:position(project.pages[1].id)}),writes=[];
 const queue=new persistence.AutosaveQueue(async value=>{writes.push(value);},()=>{},10000);
 const previous=queue.flush();await storage.flushWorkspaceSnapshot(queue,snapshot);await previous;
 assert.deepEqual(writes,[snapshot]);queue.close();
});
