import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';
const dir=new URL('../.sites-runtime/project-deletion-checks/',import.meta.url);await mkdir(dir,{recursive:true});
for(const name of ['studio-local-translation','studio-reading','studio-model','studio-state','studio-storage']){
 const source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');
 const code=transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText.replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"');
 await writeFile(new URL(`${name}.mjs`,dir),code);
}
const m=await import(new URL('studio-model.mjs',dir));
const {createWorkspaceState,workspaceReducer}=await import(new URL('studio-state.mjs',dir));
const {normalizeWorkspace}=await import(new URL('studio-storage.mjs',dir));
const remove=(state,id)=>workspaceReducer(state,{type:'project.delete',projectId:id});
const restore=state=>workspaceReducer(state,{type:'project.restore-deleted'});

test('deleting another project keeps the active document and its edit history untouched',()=>{
 const first=m.sampleProject(),second=m.emptyProject('삭제할 프로젝트');
 let before=createWorkspaceState([first,second],first.id);
 before=workspaceReducer(before,{type:'project.update',projectId:first.id,updater:p=>({...p,name:'편집 유지'}),history:'record',at:'2026-11-10T10:00:00Z',id:'edit'});
 const snapshot=JSON.stringify(before),next=remove(before,second.id);
 assert.deepEqual(next.projects.map(p=>p.id),[first.id]);assert.equal(next.activeId,first.id);
 assert.equal(next.projects[0],before.projects[0]);assert.equal(next.histories[first.id],before.histories[first.id]);assert.equal(JSON.stringify(before),snapshot);
});
test('deleting the active project selects a neighboring surviving project',()=>{
 const a=m.emptyProject('A'),b=m.emptyProject('B'),c=m.emptyProject('C');
 const next=remove(createWorkspaceState([a,b,c],b.id),b.id);
 assert.deepEqual(next.projects,[a,c]);assert.equal(next.activeId,c.id);
 assert.equal(remove(next,c.id).activeId,a.id);
});
test('deleting the last project persists an empty workspace without resurrecting a sample',()=>{
 const project=m.sampleProject(),next=remove(createWorkspaceState([project],project.id),project.id);
 assert.deepEqual(next.projects,[]);assert.equal(next.activeId,'');
 const saved=normalizeWorkspace(JSON.parse(JSON.stringify({version:1,projects:next.projects,activeId:next.activeId,endpoints:{local:'http://127.0.0.1:8000',online:''}})));
 assert.deepEqual(saved.projects,[]);assert.equal(saved.activeId,'');
 assert.deepEqual(createWorkspaceState(saved.projects,saved.activeId).projects,[]);
 const created=m.emptyProject('새 시작');const fresh=workspaceReducer(next,{type:'projects.replace',updater:list=>[...list,created]});
 assert.equal(fresh.activeId,created.id);
});
test('undoing deletion restores the complete document and both editing history stacks',()=>{
 const project=m.sampleProject();let before=createWorkspaceState([project],project.id);
 before=workspaceReducer(before,{type:'project.update',projectId:project.id,updater:p=>({...p,name:'이름'}),history:'record',at:'2026-11-10T10:00:00Z',id:'edit'});
 before=workspaceReducer(before,{type:'history.undo',projectId:project.id});
 const removed=remove(before,project.id);assert.equal(removed.projects.length,0);const next=restore(removed);
 assert.equal(next.projects[0],before.projects[0]);assert.equal(next.histories[project.id],before.histories[project.id]);assert.equal(next.activeId,project.id);
 assert.equal(workspaceReducer(next,{type:'history.redo',projectId:project.id}).projects[0].name,'이름');
});
test('multiple deletions restore in reverse order at their previous positions',()=>{
 const a=m.emptyProject('A'),b=m.emptyProject('B'),c=m.emptyProject('C');
 const before=createWorkspaceState([a,b,c],a.id),removed=remove(remove(before,b.id),a.id);assert.deepEqual(removed.projects,[c]);const next=restore(restore(removed));
 assert.deepEqual(next.projects,[a,b,c]);assert.equal(next.activeId,a.id);
});
test('missing delete targets, empty undo, and restoration collisions cannot overwrite projects',()=>{
 const project=m.sampleProject(),before=createWorkspaceState([project],project.id);
 assert.equal(remove(before,'missing'),before);assert.equal(restore(before),before);
 const deleted=remove(before,project.id),replacement={...project,name:'다른 내용'};
 const collision=workspaceReducer(deleted,{type:'projects.replace',updater:()=>[replacement]});
 assert.equal(restore(collision),collision);assert.equal(collision.projects[0],replacement);
});
