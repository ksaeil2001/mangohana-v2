import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';
const dir=new URL('../.sites-runtime/legacy-local-checks/',import.meta.url);await mkdir(dir,{recursive:true});
for(const name of ['studio-local-translation','studio-reading','studio-model','studio-engine','studio-state','studio-storage']){
 const source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');
 await writeFile(new URL(name+'.mjs',dir),transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText.replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"'));
}
const legacy=await import(new URL('studio-local-translation.mjs',dir)),model=await import(new URL('studio-model.mjs',dir)),engine=await import(new URL('studio-engine.mjs',dir)),state=await import(new URL('studio-state.mjs',dir)),storage=await import(new URL('studio-storage.mjs',dir));
function oldProject(){
 const project=model.sampleProject();project.mode='local';project.sample=false;
 project.localTranslation={...legacy.DEFAULT_LOCAL_TRANSLATION,modelSource:'local',modelPath:'E:\\models\\gemma.gguf',temperature:.25};
 project.localOcr={version:1,engine:'hunyuan15',device:'cpu'};return project;
}
test('new projects and the sample only expose online processing',()=>{
 assert.equal(model.emptyProject('new').mode,'online');assert.equal(model.sampleProject().mode,'online');
});
test('legacy local workspaces migrate to online without losing images, text, styling or metadata',()=>{
 const project=oldProject(),other=model.emptyProject('other'),input={version:1,storageRevision:8,projects:[project,other],activeId:project.id,endpoints:{local:'http://127.0.0.1:8000',online:'https://engine.test'}};
 const before=structuredClone(input),saved=storage.normalizeWorkspace(input),restored=saved.projects[0];
 assert.equal(restored.mode,'online');assert.equal(restored.id,project.id);assert.equal(saved.activeId,project.id);assert.equal(saved.storageRevision,8);
 assert.deepEqual(restored.pages.map(page=>({image:page.image,blocks:page.blocks})),project.pages.map(page=>({image:page.image,blocks:page.blocks})));
 assert.deepEqual(restored.history,project.history);assert.deepEqual(restored.localTranslation,project.localTranslation);assert.deepEqual(restored.localOcr,project.localOcr);
 assert.deepEqual(saved.endpoints,input.endpoints);assert.equal(saved.projects[1].localTranslation,undefined);assert.equal(saved.projects[1].localOcr,undefined);assert.deepEqual(input,before);
 assert.equal(storage.normalizeWorkspace(JSON.parse(JSON.stringify(saved))).projects[0].mode,'online');
});
test('legacy backups import online with text and settings intact and clear remote job references as before',()=>{
 const project=oldProject();project.pages[0].jobId='old-job';project.pages[0].jobEndpoint='http://127.0.0.1:8000';
 const before=structuredClone(project),imported=model.validateProject(project);
 assert.equal(imported.mode,'online');assert.notEqual(imported.id,project.id);assert.deepEqual(imported.pages[0].blocks,project.pages[0].blocks);
 assert.equal(imported.pages[0].image,project.pages[0].image);assert.equal(imported.pages[0].jobId,undefined);assert.equal(imported.pages[0].jobEndpoint,undefined);
 assert.deepEqual(imported.localTranslation,project.localTranslation);assert.deepEqual(imported.localOcr,project.localOcr);assert.deepEqual(project,before);
});
test('legacy HTTP job metadata survives restore and can return to editing without losing the last result',()=>{
 const project=oldProject();Object.assign(project.pages[0],{jobId:'old-job',jobEndpoint:'http://127.0.0.1:8000',status:'processing'});
 const restored=model.restoreProject(project),page=restored.pages[0];
 assert.equal(page.jobId,'old-job');assert.equal(page.jobEndpoint,'http://127.0.0.1:8000');assert.equal(page.status,'paused');
 assert.equal(engine.canResumeJob(page),false);
 const editable=state.transitionPage(page,{type:'continue-editing'});assert.equal(editable.jobId,undefined);assert.equal(editable.jobEndpoint,undefined);
 assert.deepEqual(editable.blocks,page.blocks);assert.equal(editable.image,page.image);assert.equal(state.canEditPage(editable),true);
});
test('only saved jobs at valid HTTPS endpoints are offered a resume action',()=>{
 const page=model.sampleProject().pages[0];assert.equal(engine.canResumeJob(page),false);
 assert.equal(engine.canResumeJob({...page,jobId:'saved',jobEndpoint:'https://engine.test'}),true);
 for(const jobEndpoint of ['http://localhost:8000','http://127.0.0.1:8000','http://[::1]:8000','invalid','https://secret:token@engine.test','https://engine.test?key=value'])assert.equal(engine.canResumeJob({...page,jobId:'saved',jobEndpoint}),false,jobEndpoint);
});
test('all engine entry points reject HTTP before reading an image or making a request',async()=>{
 const previous=globalThis.fetch,calls=[];globalThis.fetch=async url=>{calls.push(url);throw Error('unexpected fetch');};
 try{for(const address of ['http://localhost:8000','http://127.0.0.1:8000','http://[::1]:8000','http://engine.test']){
  await assert.rejects(engine.checkEngine(address),/HTTPS/);
  for(const page of [model.sampleProject().pages[0],{...model.sampleProject().pages[0],jobId:'old-job'}])await assert.rejects(engine.processPage(page,address,'ja','ko',new AbortController().signal,()=>{},()=>{}),/HTTPS/);
 }assert.deepEqual(calls,[]);}finally{globalThis.fetch=previous;}
});
async function transport(resume=false){
 const previous=globalThis.fetch,calls=[];let form;
 globalThis.fetch=async(url,options={})=>{calls.push(String(url));if(options.method==='POST'){form=options.body;return Response.json({id:'job-1'});}if(String(url).includes('/jobs/'))return Response.json({status:'completed',result:{blocks:[]}});return new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/png'}});};
 try{
  const project=oldProject(),page={...project.pages[0],...(resume?{jobId:'saved-job'}:{})};
  // JavaScript integrations passing retired optional arguments cannot reactivate them.
  await engine.processPage(page,'https://engine.test/','ja','ko',new AbortController().signal,()=>{},()=>{},project.localTranslation,project.localOcr);
  return {calls,form};
 }finally{globalThis.fetch=previous;}
}
test('online jobs send stable request identities without sending saved local model or OCR settings',async()=>{
 const {form,calls}=await transport();assert.deepEqual([...form.keys()],['file','source_language','target_language','project_id','page_id','idempotency_key']);
 assert.equal(form.get('source_language'),'ja');assert.equal(form.get('target_language'),'ko');assert.ok(calls.includes('https://engine.test/jobs'));
 assert.equal(form.get('project_id'),'sample-p1');assert.equal(form.get('page_id'),'sample-p1');assert.match(form.get('idempotency_key'),/^[a-f0-9]{64}$/);
});
test('saved HTTPS jobs resume by polling once without uploading or applying retired settings',async()=>{
 const {form,calls}=await transport(true);assert.equal(form,undefined);assert.deepEqual(calls,['https://engine.test/jobs/saved-job']);
});
test('legacy optional settings still normalize invalid imports for safe backup round trips',()=>{
 const project=oldProject();project.localTranslation={...project.localTranslation,temperature:NaN,topP:9,contextLength:1024,maxOutputTokens:90000};project.localOcr={engine:'unknown',device:'unknown'};
 const restored=model.restoreProject(project);assert.equal(restored.localTranslation.temperature,.1);assert.equal(restored.localTranslation.topP,1);assert.equal(restored.localTranslation.maxOutputTokens,1024);assert.deepEqual(restored.localOcr,legacy.DEFAULT_LOCAL_OCR);
});
