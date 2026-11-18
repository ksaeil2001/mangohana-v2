import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';

const dir=new URL('../.sites-runtime/editor-checks/',import.meta.url);await mkdir(dir,{recursive:true});
for(const name of ['studio-local-translation','studio-reading','studio-model','studio-state','studio-engine']){
 const source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');
 await writeFile(new URL(name+'.mjs',dir),transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText.replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"'));
}
const m=await import(new URL('studio-model.mjs',dir)),s=await import(new URL('studio-state.mjs',dir)),engine=await import(new URL('studio-engine.mjs',dir));
const edit=(projectId,updater,extra={})=>({type:'project.update',projectId,updater,history:'record',at:'2026-11-10T05:00:00Z',id:'edit-1',...extra});
const changeText=p=>({...p,pages:p.pages.map((page,i)=>i===0?{...page,blocks:page.blocks.map((block,j)=>j===0?{...block,text:'바꾼 대사'}:block)}:page)});
const exported={id:'export-1',at:'2026-11-10T05:01:00Z',text:'PNG 결과 다운로드 요청',type:'export'};

test('undo changes the document without erasing an export that already happened',()=>{
 const project=m.sampleProject();let state=s.createWorkspaceState([project],project.id);
 state=s.workspaceReducer(state,edit(project.id,changeText,{label:'번역문 수정'}));
 state=s.workspaceReducer(state,edit(project.id,p=>({...p,history:[...p.history,exported]}),{history:'preserve'}));
 state=s.workspaceReducer(state,{type:'history.undo',projectId:project.id,at:'2026-11-10T05:02:00Z',id:'undo-1'});
 const current=state.projects[0];assert.equal(current.pages[0].blocks[0].text,project.pages[0].blocks[0].text);
 assert.ok(current.history.some(h=>h.id==='export-1'));assert.ok(current.history.some(h=>h.id==='edit-1'));
 assert.equal(current.history.at(-1).text,'되돌리기');assert.equal(current.updatedAt,'2026-11-10T05:02:00Z');
});
test('redo preserves events created after undo instead of replaying an obsolete timeline',()=>{
 const project=m.sampleProject();let state=s.createWorkspaceState([project],project.id);
 state=s.workspaceReducer(state,edit(project.id,changeText));
 state=s.workspaceReducer(state,{type:'history.undo',projectId:project.id,at:'2026-11-10T05:02:00Z',id:'undo-1'});
 state=s.workspaceReducer(state,edit(project.id,p=>({...p,history:[...p.history,exported]}),{history:'preserve'}));
 state=s.workspaceReducer(state,{type:'history.redo',projectId:project.id,at:'2026-11-10T05:03:00Z',id:'redo-1'});
 assert.equal(state.projects[0].pages[0].blocks[0].text,'바꾼 대사');
 assert.ok(state.projects[0].history.some(h=>h.id==='export-1'));assert.equal(state.projects[0].history.at(-1).text,'다시 실행');
});
test('an unavailable undo does not invent an event or modify a project',()=>{
 const project=m.sampleProject(),before=s.createWorkspaceState([project],project.id);
 assert.equal(s.workspaceReducer(before,{type:'history.undo',projectId:project.id,at:'2026-11-10T05:02:00Z',id:'undo-1'}),before);
});
test('a reverted text session does not consume redo or create an empty undo step',()=>{
 const project=m.sampleProject();let state=s.createWorkspaceState([project],project.id);
 state=s.workspaceReducer(state,edit(project.id,changeText));
 state=s.workspaceReducer(state,{type:'history.undo',projectId:project.id});const before=state;
 state=s.workspaceReducer(state,{type:'history.block',projectId:project.id,fields:'text',target:{pageId:project.pages[0].id,block:project.pages[0].blocks[0],reviewed:false,status:'review',beforePage:project.pages[0]}});
 assert.equal(state,before);assert.equal(state.histories[project.id].future.length,1);
});
test('a late checkpoint for a removed block cannot create history or clear redo',()=>{
 const original=m.sampleProject(),page=original.pages[0];const project={...original,pages:original.pages.map((p,i)=>i===0?{...p,blocks:[]}:p)};
 const before=s.createWorkspaceState([project],project.id);
 const next=s.workspaceReducer(before,{type:'history.block',projectId:project.id,fields:'geometry',target:{pageId:page.id,block:page.blocks[0],reviewed:false,status:'review',beforePage:page}});
 assert.equal(next,before);
});
test('a drag returned to its origin restores failure metadata without consuming redo',()=>{
 const sample=m.sampleProject(),baseline={...sample.pages[0],status:'failed',error:'engine offline'};
 const project={...sample,pages:[baseline,...sample.pages.slice(1)]};let state=s.createWorkspaceState([project],project.id);
 state=s.workspaceReducer(state,edit(project.id,p=>({...p,name:'temporary'})));
 state=s.workspaceReducer(state,{type:'history.undo',projectId:project.id});
 state=s.workspaceReducer(state,edit(project.id,p=>({...p,pages:p.pages.map((page,i)=>i===0?{...page,status:'review',error:undefined,blocks:page.blocks.map((block,j)=>j===0?{...block}:block)}:page)}),{history:'preserve'}));
 const history=state.histories[project.id];
 state=s.workspaceReducer(state,{type:'history.block',projectId:project.id,fields:'geometry',target:{pageId:baseline.id,block:baseline.blocks[0],reviewed:baseline.reviewed,status:baseline.status,beforePage:baseline}});
 assert.equal(state.projects[0].pages[0].status,'failed');assert.equal(state.projects[0].pages[0].error,'engine offline');
 assert.equal(state.histories[project.id],history);assert.equal(history.past.length,0);assert.equal(history.future.length,1);
});
test('entering text edit during a drag captures the settled page rather than its preview',()=>{
 assert.equal(typeof s.createTextEditTarget,'function','text sessions must capture the settled document');
 for(const kind of ['failed','completed']){
  const project=m.sampleProject(),index=kind==='failed'?0:3;
  const baseline={...project.pages[index],status:kind,error:kind==='failed'?'engine offline':undefined};project.pages[index]=baseline;
  const geometry={pageId:baseline.id,block:baseline.blocks[0],reviewed:baseline.reviewed,status:baseline.status,beforePage:baseline};
  const preview={...project,pages:project.pages.map((page,i)=>i===index?{...page,status:'review',reviewed:false,error:undefined,blocks:page.blocks.map((block,j)=>j===0?{...block,x:block.x+10}:block)}:page)};
  const target=s.createTextEditTarget(preview,baseline.id,baseline.blocks[0].id,geometry);
  assert.equal(target.block.x,baseline.blocks[0].x);assert.equal(target.status,kind);assert.equal(target.beforePage.error,baseline.error);
  const settled=s.restoreGeometry(preview,geometry);assert.equal(s.restoreText(settled,target),settled);
 }
});

for(const [name,id] of [['blank','   '],['overlong','x'.repeat(201)]])test(`an engine ${name} job ID never reaches persistence or polling`,async()=>{
 const old=globalThis.fetch,ids=[],polls=[];
 globalThis.fetch=async(url,options)=>{
  if(options?.method==='POST')return Response.json({id});
  if(String(url).includes('/jobs/')){polls.push(String(url));return Response.json({status:'completed',result:{blocks:[]}});}
  return new Response('image');
 };
 try{
  await assert.rejects(engine.processPage(m.sampleProject().pages[0],'https://engine.test','ja','ko',new AbortController().signal,id=>ids.push(id),()=>{}),/작업 ID/);
  assert.deepEqual(ids,[]);assert.deepEqual(polls,[]);
 }finally{globalThis.fetch=old;}
});
test('an accepted maximum-length job ID remains restorable after polling is stopped',async()=>{
 const old=globalThis.fetch,controller=new AbortController(),project=m.sampleProject(),id='a'.repeat(200);
 globalThis.fetch=async(url,options)=>options?.method==='POST'?Response.json({id}):new Response('image');
 try{
  await assert.rejects(engine.processPage(project.pages[0],'https://engine.test','ja','ko',controller.signal,jobId=>{project.pages[0]={...project.pages[0],jobId,jobEndpoint:'https://engine.test',status:'processing'};controller.abort();},()=>{}));
  assert.equal(m.restoreProject(project).pages[0].jobId,id);
 }finally{globalThis.fetch=old;}
});
test('a failed source image request cannot be uploaded as an engine image',async()=>{
 const old=globalThis.fetch,uploads=[];
 globalThis.fetch=async(url,options)=>{
  if(options?.method==='POST'){uploads.push(String(url));return Response.json({id:'unwanted'});}
  if(String(url).includes('/jobs/'))return Response.json({status:'completed',result:{blocks:[]}});
  return new Response('missing',{status:404});
 };
 try{await assert.rejects(engine.processPage(m.sampleProject().pages[0],'https://engine.test','ja','ko',new AbortController().signal,()=>{},()=>{}),/원본 이미지/);assert.deepEqual(uploads,[]);}finally{globalThis.fetch=old;}
});
test('blank OCR identities receive usable unique IDs without losing their dialogue',()=>{
 const blocks=m.validateBlocks([m.makeBlock({id:'',text:'첫 대사'}),m.makeBlock({id:'\t',text:'둘째 대사'})]);
 assert.ok(blocks.every(block=>block.id.trim().length>0));assert.notEqual(blocks[0].id,blocks[1].id);
 assert.deepEqual(blocks.map(b=>b.text),['첫 대사','둘째 대사']);
 assert.deepEqual(m.validateProject({...m.sampleProject(),pages:[{...m.sampleProject().pages[0],blocks}]}).pages[0].blocks.map(b=>b.id),blocks.map(b=>b.id));
});
