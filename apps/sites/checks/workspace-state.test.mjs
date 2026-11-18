import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';
const dir=new URL('../.sites-runtime/workspace-checks/',import.meta.url);await mkdir(dir,{recursive:true});
for(const name of ['studio-local-translation','studio-reading','studio-model','studio-state','studio-persistence','studio-storage','studio-presentation']){
 try{const source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');const output=transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText.replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"');await writeFile(new URL(name+'.mjs',dir),output);}catch(e){if(e.code!=='ENOENT')throw e;}
}
const m=await import(new URL('studio-model.mjs',dir));
const load=async name=>{try{return await import(new URL(name+'.mjs',dir));}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;}};
const s=await load('studio-state'),p=await load('studio-persistence'),storage=await load('studio-storage'),ui=await load('studio-presentation');
const required=(object,key)=>assert.equal(typeof object[key],'function',`${key} is required to enforce the transition`);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function workspace(){required(s,'createWorkspaceState');return s.createWorkspaceState([m.sampleProject()], 'trio-sample-journey');}
const update=(updater,mode='record')=>({type:'project.update',projectId:'trio-sample-journey',updater,history:mode,at:'2026-11-09T11:00:00Z',id:'event-1'});

test('invalid active project falls back to an existing ID so edits cannot silently disappear',()=>{
 required(s,'createWorkspaceState');const state=s.createWorkspaceState([m.sampleProject()],'missing');assert.equal(state.activeId,'trio-sample-journey');
});
test('workspace reducer is replay-safe and does not mutate history outside the state value',()=>{
 const before=workspace(),snapshot=JSON.stringify(before);const event=update(p=>({...p,name:'수정된 제목'}));
 const one=s.workspaceReducer(before,event),two=s.workspaceReducer(before,event);assert.deepEqual(one,two);assert.equal(JSON.stringify(before),snapshot);assert.equal(one.projects[0].name,'수정된 제목');
 const undone=s.workspaceReducer(one,{type:'history.undo',projectId:before.activeId});assert.equal(undone.projects[0].name,'별을 잇는 여행');
});
test('late project updates stay on their original target after the user selects another project',()=>{
 const first=m.sampleProject(),second=m.emptyProject('두 번째');required(s,'createWorkspaceState');let state=s.createWorkspaceState([first,second],first.id);
 state=s.workspaceReducer(state,{type:'project.select',projectId:second.id});state=s.workspaceReducer(state,update(p=>({...p,name:'원래 대상 결과'}),'barrier'));
 assert.equal(state.activeId,second.id);assert.equal(state.projects[1].name,'두 번째');assert.equal(state.projects[0].name,'원래 대상 결과');
});
test('undo cannot restore a pre-engine snapshot over a newly received successful result',()=>{
 let state=workspace();state=s.workspaceReducer(state,update(p=>({...p,name:'편집'})));
 state=s.workspaceReducer(state,update(p=>({...p,pages:p.pages.map((pg,i)=>i===0?{...pg,blocks:[m.makeBlock({id:'new-result',text:'엔진 결과'})]}:pg)}),'barrier'));
 state=s.workspaceReducer(state,{type:'history.undo',projectId:state.activeId});assert.equal(state.projects[0].pages[0].blocks[0].text,'엔진 결과');
});
test('synchronous activity transition rejects a second import/export/process start',()=>{
 required(s,'activityTransition');const active=s.activityTransition({kind:'idle'},{type:'start',operation:{kind:'importing',id:'one',projectId:'p',format:'images'}});
 assert.equal(s.activityTransition(active,{type:'start',operation:{kind:'exporting',id:'two',projectId:'p',format:'png'}}).id,'one');
 assert.equal(s.activityTransition(active,{type:'finish',id:'wrong'}).id,'one');assert.equal(s.activityTransition(active,{type:'finish',id:'one'}).kind,'idle');
});
test('late connection success cannot mark a newly entered endpoint as connected',()=>{
 required(s,'connectionTransition');let connection=s.connectionTransition({phase:'idle'},{type:'start',id:'one',endpoint:'https://one.test'});
 connection=s.connectionTransition(connection,{type:'start',id:'two',endpoint:'https://two.test'});
 connection=s.connectionTransition(connection,{type:'success',id:'one',endpoint:'https://one.test'});assert.equal(connection.phase,'testing');
 connection=s.connectionTransition(connection,{type:'success',id:'two',endpoint:'https://two.test'});assert.equal(connection.phase,'ok');assert.equal(s.connectionIsReady(connection,'https://one.test'),false);
});
test('pause before job creation restores the prior document instead of leaving processing stuck',()=>{
 required(s,'transitionPage');const original=m.sampleProject().pages[3];const started=s.transitionPage(original,{type:'start',requestId:'r'});
 const paused=s.transitionPage(started,{type:'pause',requestId:'r'});assert.equal(m.pageStatus(paused),'completed');assert.equal(paused.blocks,original.blocks);
});
test('pause with a saved job ID is resumable and cannot be edited or reviewed accidentally',()=>{
 required(s,'transitionPage');let page=s.transitionPage(m.sampleProject().pages[3],{type:'start',requestId:'r'});
 page=s.transitionPage(page,{type:'job',requestId:'r',jobId:'job',endpoint:'https://engine.test'});page=s.transitionPage(page,{type:'pause',requestId:'r'});
 assert.equal(m.pageStatus(page),'paused');assert.equal(page.jobId,'job');assert.equal(s.canEditPage(page),false);assert.equal(s.canReviewPage(page),false);
 const kept=s.transitionPage(page,{type:'continue-editing'});assert.equal(kept.blocks,page.blocks);assert.equal(kept.jobId,undefined);assert.equal(s.canEditPage(kept),true);
});
test('an obsolete job callback cannot replace the current operation result',()=>{
 required(s,'transitionPage');const current=s.transitionPage(m.sampleProject().pages[0],{type:'start',requestId:'new'});
 const obsolete=s.transitionPage(current,{type:'result',requestId:'old',result:{blocks:[m.makeBlock({text:'stale'})]}});assert.equal(obsolete,current);
});
test('zero OCR regions can be explicitly reviewed only after an actual result',()=>{
 required(s,'transitionPage');const page={...m.sampleProject().pages[0],blocks:[],reviewed:false,status:'ready'};assert.equal(s.canReviewPage(page),false);
 const result=s.transitionPage(s.transitionPage(page,{type:'start',requestId:'r'}),{type:'result',requestId:'r',result:{blocks:[]}});assert.equal(s.canReviewPage(result),true);
});
test('transport failure preserves an existing output and job ID while terminal failure clears only the job ID',()=>{
 required(s,'transitionPage');const original=m.sampleProject().pages[3];let page=s.transitionPage(original,{type:'start',requestId:'r'});page=s.transitionPage(page,{type:'job',requestId:'r',jobId:'saved',endpoint:'https://engine.test'});
 const transient=s.transitionPage(page,{type:'failure',requestId:'r',error:'offline',terminal:false});assert.equal(transient.jobId,'saved');assert.equal(transient.blocks,original.blocks);
 const terminal=s.transitionPage(page,{type:'failure',requestId:'r',error:'failed',terminal:true});assert.equal(terminal.jobId,undefined);assert.equal(terminal.blocks,original.blocks);
});
test('unrecognized saved data versions cannot be treated as an empty workspace and overwritten',()=>{
 required(storage,'normalizeWorkspace');assert.throws(()=>storage.normalizeWorkspace({version:2,projects:[]}),/버전/);assert.equal(storage.normalizeWorkspace(undefined),undefined);
});
test('saved processing jobs restore as paused with their identities and prior output intact',()=>{
 required(storage,'normalizeWorkspace');const project=m.sampleProject();project.pages[0]={...project.pages[0],status:'processing',jobId:'saved-job',jobEndpoint:'https://engine.test'};
 const restored=storage.normalizeWorkspace({version:1,projects:[project],activeId:'stale',endpoints:{local:'http://127.0.0.1:8000',online:''}});
 assert.equal(restored.activeId,project.id);assert.equal(restored.projects[0].id,project.id);assert.equal(restored.projects[0].pages[0].status,'paused');assert.equal(restored.projects[0].pages[0].jobId,'saved-job');
});
test('autosave serializes writes and never reports an older revision as fully saved',async()=>{
 required(p,'AutosaveQueue');const first=deferred(),entered=deferred(),writes=[],states=[];
 const queue=new p.AutosaveQueue(async value=>{writes.push(value);if(value===1){entered.resolve();await first.promise;}},state=>states.push(state),10000);
 queue.schedule(1);const pending=queue.flush();await entered.promise;queue.schedule(2);queue.schedule(3);assert.deepEqual(writes,[1]);first.resolve();await pending;
 assert.deepEqual(writes,[1,3]);assert.equal(states.at(-1).phase,'saved');assert.equal(states.at(-1).revision,3);assert.ok(!states.slice(1,-1).some(st=>st.phase==='saved'));queue.close();
});
test('failed saves keep the latest snapshot available for retry',async()=>{
 required(p,'AutosaveQueue');const values=[];let fail=true;const queue=new p.AutosaveQueue(async value=>{if(fail)throw new Error('quota');values.push(value);},()=>{},10000);
 queue.schedule('my-edits');await assert.rejects(queue.flush(),/quota/);fail=false;await queue.flush();assert.deepEqual(values,['my-edits']);queue.close();
});

test('local v1 restoration preserves long editable content and the complete existing history',()=>{
 const project=m.sampleProject();project.pages[0].blocks[0].text='가'.repeat(20123);project.history=Array.from({length:103},(_,i)=>({id:`h-${i}`,at:'2026-11-09T10:00:00Z',text:`기록 ${i}`,type:'edit'}));
 const restored=storage.normalizeWorkspace({version:1,projects:[project],activeId:project.id,endpoints:{local:'http://127.0.0.1:8000',online:''}});assert.equal(restored.projects[0].pages[0].blocks[0].text.length,20123);assert.equal(restored.projects[0].history.length,103);
});
test('local v1 restoration accepts all valid manually added regions without applying external import limits',()=>{
 const project=m.sampleProject();project.pages[0].blocks=Array.from({length:1001},(_,i)=>m.makeBlock({id:`block-${i}`}));
 const restored=m.restoreProject(project);assert.equal(restored.pages[0].blocks.length,1001);
});
test('legacy zero-region output with a restored image remains an explicitly reviewable result',()=>{
 const project=m.sampleProject();project.pages[0]={...project.pages[0],status:'review',blocks:[],reviewed:false,cleanImage:'data:image/png;base64,aGVsbG8='};delete project.pages[0].processed;
 const restored=m.restoreProject(project);assert.equal(m.pageStatus(restored.pages[0]),'review');assert.equal(s.canReviewPage(restored.pages[0]),true);
});
test('geometry rollback and its undo checkpoint preserve a concurrently committed dialogue change',()=>{
 required(s,'restoreGeometry');const before=m.sampleProject(),current={...before,pages:before.pages.map((pg,i)=>i===0?{...pg,blocks:pg.blocks.map((b,j)=>j===0?{...b,text:'방금 확정한 대사'}:{...b,x:b.x+5})}:pg)};
 const rolled=s.restoreGeometry(current,{pageId:before.pages[0].id,block:before.pages[0].blocks[1],reviewed:before.pages[0].reviewed,status:before.pages[0].status});
 assert.equal(rolled.pages[0].blocks[0].text,'방금 확정한 대사');assert.equal(rolled.pages[0].blocks[1].x,5);
});
test('atomic save guard rejects a stale tab and an unsupported record even after hydration',()=>{
 required(storage,'nextStorageRevision');assert.equal(storage.nextStorageRevision({version:1,storageRevision:4},4),5);
 assert.throws(()=>storage.nextStorageRevision({version:1,storageRevision:5},4),/다른 탭/);assert.throws(()=>storage.nextStorageRevision({version:2,storageRevision:4},4),/버전/);
});

test('adding a new event and importing a backup both preserve all existing processing history',()=>{
 required(s,'createWorkspaceState');const project=m.sampleProject();project.history=Array.from({length:103},(_,i)=>({id:`h-${i}`,at:'2026-11-09T10:00:00Z',text:`기록 ${i}`,type:'edit'}));
 const initial=s.createWorkspaceState([project],project.id),edited=s.workspaceReducer(initial,{...update(p=>({...p,name:'새 제목'})),label:'이름 변경'});
 assert.equal(edited.projects[0].history.length,104);assert.equal(edited.projects[0].history[0].id,'h-0');assert.equal(m.validateProject(project).history.length,103);
});

test('TRIO project round trip preserves a long translation instead of silently shortening it',()=>{
 const project=m.sampleProject();project.pages[0].blocks[0].text='번역문'.repeat(7000);
 const imported=m.validateProject(project);assert.equal(imported.pages[0].blocks[0].text.length,21000);
});

test('opening a narrow-screen panel replaces the other drawer without changing desktop preferences',()=>{
 required(s,'panelTransition');const initial={leftOpen:false,rightOpen:true,drawer:null};
 const pages=s.panelTransition(initial,{type:'drawer.toggle',drawer:'pages'});
 const inspector=s.panelTransition(pages,{type:'drawer.toggle',drawer:'inspector'});
 assert.deepEqual(inspector,{leftOpen:false,rightOpen:true,drawer:'inspector'});
 assert.deepEqual(initial,{leftOpen:false,rightOpen:true,drawer:null});
});
test('drawer dismissal and repeated toggle restore an unobstructed canvas',()=>{
 required(s,'panelTransition');const initial={leftOpen:true,rightOpen:false,drawer:null};
 const open=s.panelTransition(initial,{type:'drawer.toggle',drawer:'pages'});
 assert.deepEqual(s.panelTransition(open,{type:'drawer.toggle',drawer:'pages'}),initial);
 assert.deepEqual(s.panelTransition(open,{type:'drawer.close'}),initial);
});
test('explicit upload-panel opening stays open on repeated requests and preserves desktop layout',()=>{
 const initial={leftOpen:false,rightOpen:true,drawer:'inspector'};
 const pages=s.panelTransition(initial,{type:'drawer.open',drawer:'pages'});
 assert.deepEqual(pages,{leftOpen:false,rightOpen:true,drawer:'pages'});
 assert.equal(s.panelTransition(pages,{type:'drawer.open',drawer:'pages'}),pages);
 assert.deepEqual(s.panelTransition(pages,{type:'drawer.close'}),{leftOpen:false,rightOpen:true,drawer:null});
 assert.deepEqual(initial,{leftOpen:false,rightOpen:true,drawer:'inspector'});
});
test('desktop panel controls close transient drawers while preserving the opposite panel',()=>{
 required(s,'panelTransition');const initial={leftOpen:false,rightOpen:true,drawer:'inspector'};
 const collapsed=s.panelTransition(initial,{type:'panel.set',panel:'right',open:false});
 assert.deepEqual(collapsed,{leftOpen:false,rightOpen:false,drawer:null});
 assert.deepEqual(s.panelTransition(collapsed,{type:'panel.set',panel:'left',open:true}),{leftOpen:true,rightOpen:false,drawer:null});
});


test('page presentation exposes editable content without judging missing dialogue, overlap, or line breaks',()=>{
 required(ui,'pageActivity');const project=m.sampleProject(),snapshot=JSON.stringify(project);
 assert.deepEqual(project.pages.map(ui.pageActivity),['editable','editable','editable','editable']);
 assert.equal(JSON.stringify(project),snapshot);
});
test('operational failure and a resumable remote job remain visible independently of old review flags',()=>{
 required(ui,'pageActivity');required(ui,'canExportPage');const page=m.sampleProject().pages[3];
 assert.equal(ui.pageActivity({...page,status:'failed',error:'offline'}),'failed');
 assert.equal(ui.pageActivity({...page,jobId:'still-running'}),'paused');
 assert.equal(ui.canExportPage({...page,jobId:'still-running'}),false);
 assert.equal(ui.canExportPage({...page,status:'processing'}),false);
 assert.equal(ui.canExportPage({...page,status:'failed'}),false);
 assert.equal(ui.canExportPage({...page,reviewed:false}),true);
});
test('empty successful OCR output is editable without being mistaken for a quality assessment',()=>{
 required(ui,'pageActivity');const page={...m.sampleProject().pages[0],blocks:[],reviewed:false,status:'ready'};
 assert.equal(ui.pageActivity(page),'ready');assert.equal(ui.pageActivity({...page,processed:true}),'editable');
});
test('explicit whole-project processing includes pages carrying a legacy reviewed flag',()=>{
 const project=m.sampleProject();assert.deepEqual(s.getRunTargets(project,'all').map(p=>p.id),['sample-p1','sample-p2','sample-p3','sample-p4']);
 assert.deepEqual(s.getRunTargets(project,'current','sample-p4').map(p=>p.id),['sample-p4']);
});

test('the same left handle toggles both ways without changing the right panel preference',()=>{
 const initial={leftOpen:true,rightOpen:false,drawer:null};
 const closed=s.panelTransition(initial,{type:'panel.toggle',panel:'left'});
 assert.deepEqual(closed,{leftOpen:false,rightOpen:false,drawer:null});
 assert.deepEqual(s.panelTransition(closed,{type:'panel.toggle',panel:'left'}),initial);
 assert.deepEqual(initial,{leftOpen:true,rightOpen:false,drawer:null});
});
test('the mirrored right handle toggles from current state and dismisses transient drawers',()=>{
 const initial={leftOpen:false,rightOpen:false,drawer:'pages'};
 const opened=s.panelTransition(initial,{type:'panel.toggle',panel:'right'});
 assert.deepEqual(opened,{leftOpen:false,rightOpen:true,drawer:null});
 assert.deepEqual(s.panelTransition(opened,{type:'panel.toggle',panel:'right'}),{leftOpen:false,rightOpen:false,drawer:null});
});

test('page style copy preserves dialogue, OCR, geometry, fill and every other page',()=>{
 required(s,'applyTextStyle');const project=m.sampleProject();
 const source=project.pages[0].blocks[0];Object.assign(source,{font:'serif',size:21,weight:800,align:'right',color:'#123456',lineHeight:1.75});
 const before=structuredClone(project),snapshot=JSON.stringify(project),keys=['font','size','weight','align','color','lineHeight'];
 const result=s.applyTextStyle(project,project.pages[0].id,source.id,'page');
 for(let index=0;index<result.pages[0].blocks.length;index++){
  const block=result.pages[0].blocks[index],original=before.pages[0].blocks[index];
  for(const key of keys)assert.equal(block[key],source[key]);
  for(const key of Object.keys(original).filter(key=>!keys.includes(key)))assert.deepEqual(block[key],original[key],key);
 }
 assert.deepEqual(result.pages.slice(1),before.pages.slice(1));assert.equal(JSON.stringify(project),snapshot);
 assert.equal(s.applyTextStyle(project,'missing',source.id,'all'),project);
});

test('all-page style copy protects pending jobs and is one reversible project edit',()=>{
 required(s,'applyTextStyle');const project=m.sampleProject(),source=project.pages[0].blocks[0];
 Object.assign(source,{font:'rounded',size:19,weight:500,align:'left',color:'#654321',lineHeight:1.1});
 project.pages[1]={...project.pages[1],status:'paused',jobId:'resume-this-job',jobEndpoint:'https://engine.test'};
 project.pages[2]={...project.pages[2],status:'failed',error:'old failure'};
 const snapshot=JSON.stringify(project),before=s.createWorkspaceState([project],project.id);
 const applied=s.workspaceReducer(before,update(p=>s.applyTextStyle(p,p.pages[0].id,source.id,'all')));
 assert.equal(applied.projects[0].pages[1],project.pages[1]);
 assert.equal(applied.projects[0].pages[2].blocks[0].font,'rounded');
 assert.equal(applied.projects[0].pages[2].status,'review');assert.equal(applied.projects[0].pages[2].error,undefined);
 assert.equal(applied.projects[0].pages[3].blocks[0].size,19);
 assert.equal(s.applyTextStyle(applied.projects[0],project.pages[0].id,source.id,'all'),applied.projects[0]);
 assert.equal(applied.histories[project.id].past.length,1);assert.equal(JSON.stringify(project),snapshot);
 const undone=s.workspaceReducer(applied,{type:'history.undo',projectId:project.id});assert.deepEqual(undone.projects[0],project);
 const redone=s.workspaceReducer(undone,{type:'history.redo',projectId:project.id});assert.deepEqual(redone.projects[0],applied.projects[0]);
 assert.equal(s.applyTextStyle(project,project.pages[1].id,project.pages[1].blocks[0].id,'all'),project);
});
