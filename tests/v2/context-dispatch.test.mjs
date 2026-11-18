// Server-owned terminology/previous result composition; synthetic inference only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createContextStore} from '../../apps/engine/context.mjs';
import {createJobStore} from '../../apps/engine/store.mjs';
import {fixture,alice,bob,png,until,hash,deferred} from './batch-fixture.mjs';

const evidence=path.resolve('E:/Dev/Outputs/MangohanaV2-20261111/tests/context-dispatch-'+Date.now());
await mkdir(evidence,{recursive:true});
async function setup(t,options={}){
 const contextRoot=await mkdtemp(path.join(evidence,'contexts-')),contextStore=await createContextStore({root:contextRoot});
 t.after(()=>contextStore.close());
 return {contextStore,contextRoot,...await fixture(t,{contextStore,echoContext:true,...options})};
}
async function confirmed(store,owner=alice,project='project-one'){
 await store.apply(owner,project,{expectedRevision:0,idempotencyKey:'terms:edit',changes:[
  {type:'upsert_term',term:{id:'name',source:'合成',target:'합성 이름'}},
  {type:'upsert_term',term:{id:'conditional',source:'合成',target:'다른 이름',condition:{speaker:'somebody'}}},
 ]});
 await store.apply(owner,project,{expectedRevision:1,idempotencyKey:'terms:confirm',changes:[
  {type:'confirm_term',id:'name',expectedEntryRevision:1},{type:'confirm_term',id:'conditional',expectedEntryRevision:1},
 ]});
}
const submit=(store,overrides={})=>store.submit({owner:alice,idempotencyKey:'one',bytes:png,name:'one.png',projectId:'project-one',pageId:'one',pageNumber:1,...overrides});

test('dispatch captures confirmed unconditional terms once and preserves the immutable snapshot on duplicate submission',async t=>{
 const f=await setup(t);await confirmed(f.contextStore);
 const job=await submit(f.store);assert.equal((await until(()=>f.store.get(alice,job.id))).status,'completed');
 const context=f.runs[0].translationContext;assert.equal(context.glossaryRevision,2);
 assert.deepEqual(context.glossary.map(({source,target})=>({source,target})),[{source:'合成',target:'합성 이름'}]);
 assert.deepEqual(context.deferredConditionalTermIds,['conditional']);assert.deepEqual(context.previousContext,[]);
 const file=path.join(f.root,job.id,'translation-context.json'),before=await readFile(file);
 assert.equal(hash(before),context.snapshotSha256);
 const repeated=await submit(f.store);assert.equal(repeated.id,job.id);assert.equal(f.runs.length,1);
 assert.deepEqual(await readFile(file),before);
});

test('Stage11 dispatch carries page identity, confirmed profiles and deferred conditional terms without AI promotion',async t=>{
 const f=await setup(t);await confirmed(f.contextStore);
 await f.contextStore.apply(alice,'project-one',{expectedRevision:2,idempotencyKey:'profile:edit',changes:[{type:'upsert_profile',profile:{id:'hero',name:'합성',aliases:['合成'],speechStyle:'상대가 확인되면 존댓말'}}]});
 await f.contextStore.apply(alice,'project-one',{expectedRevision:3,idempotencyKey:'profile:confirm',changes:[{type:'confirm_profile',id:'hero',expectedEntryRevision:3}]});
 const job=await submit(f.store);await until(()=>f.store.get(alice,job.id));const c=f.runs[0].translationContext;
 assert.equal(c.pageId,'one');assert.equal(c.profiles[0].name,'합성');assert.equal(c.conditionalGlossary[0].id,'conditional');
 assert.equal(c.contextPolicyVersion,'stage11-context-v1');
});

test('only verified completed prior absolute pages in the same owner and project become AI proposed context',async t=>{
 const f=await setup(t);await confirmed(f.contextStore);
 for(const [key,owner,projectId,pageNumber]of [['own',alice,'project-one',1],['foreign',bob,'project-one',2],['other-project',alice,'project-two',2],['future',alice,'project-one',9]]){
  const job=await submit(f.store,{owner,projectId,pageId:key,pageNumber,idempotencyKey:key});await until(()=>f.store.get(owner,job.id));
 }
 const current=await submit(f.store,{pageId:'three',pageNumber:3,idempotencyKey:'three'});await until(()=>f.store.get(alice,current.id));
 const context=f.runs.at(-1).translationContext;
 assert.deepEqual(context.previousPages.map(page=>page.pageNumber),[1]);
 assert.equal(context.previousContext[0].source,'合成');assert.equal(context.previousContext[0].translation,'합성');
 assert.equal(context.previousContext[0].status,'AI_PROPOSED');assert.equal(context.previousPages[0].reportSha256.length,64);
 assert.equal(context.glossaryRevision,2);
});

test('a changed prior original is excluded before inference and the previous job is marked with integrity failure',async t=>{
 const f=await setup(t),first=await submit(f.store);await until(()=>f.store.get(alice,first.id));
 await writeFile(path.join(f.root,first.id,'source.png'),Buffer.from('changed original'));
 const current=await submit(f.store,{pageId:'two',pageNumber:2,idempotencyKey:'two'});await until(()=>f.store.get(alice,current.id));
 assert.deepEqual(f.runs.at(-1).translationContext.previousContext,[]);
 assert.equal((await f.store.get(alice,first.id)).errorCode,'INTEGRITY_FAILED');
});

test('a changed stored context or a mismatched consumption receipt prevents publishing a completed result',async t=>{
 const f=await setup(t);const job=await submit(f.store);await until(()=>f.store.get(alice,job.id));
 const file=path.join(f.root,job.id,'translation-context.json');await writeFile(file,'{}');
 assert.equal((await f.store.get(alice,job.id)).status,'failed');assert.equal((await f.store.get(alice,job.id)).errorCode,'INTEGRITY_FAILED');
 const other=await setup(t,{echoContext:false});const invalid=await submit(other.store);await until(()=>other.store.get(alice,invalid.id));
 assert.equal((await other.store.get(alice,invalid.id)).status,'failed');
});

test('unknown or corrupt saved terminology fails before an inference without silently substituting an empty glossary',async t=>{
 const f=await setup(t);await confirmed(f.contextStore);
 const stateFile=path.join(f.contextRoot,hash(alice+'\0project-one'),'state.json');await writeFile(stateFile,'{broken');
 const job=await submit(f.store),ended=await until(()=>f.store.get(alice,job.id));
 assert.equal(ended.status,'failed');assert.equal(f.runs.length,0);assert.deepEqual(await readFile(stateFile),Buffer.from('{broken'));
 assert.deepEqual(await readFile(path.join(f.root,job.id,'source.png')),png);
});

test('a terminology edit while a page runs cannot mutate that page snapshot or trigger a duplicate inference',async t=>{
 const gate=deferred(),f=await setup(t,{gate});await confirmed(f.contextStore);
 const job=await submit(f.store);await f.started.promise;
 await f.contextStore.apply(alice,'project-one',{expectedRevision:2,idempotencyKey:'later:edit',changes:[{type:'upsert_term',term:{id:'name',source:'合成',target:'새 표기'}}]});
 await f.contextStore.apply(alice,'project-one',{expectedRevision:3,idempotencyKey:'later:confirm',changes:[{type:'confirm_term',id:'name',expectedEntryRevision:3}]});
 gate.resolve();assert.equal((await until(()=>f.store.get(alice,job.id))).status,'completed');
 assert.equal(f.runs[0].translationContext.glossaryRevision,2);assert.equal(f.runs[0].translationContext.glossary[0].target,'합성 이름');
 const report=JSON.parse(await readFile(path.join(f.root,job.id,'report.json'),'utf8'));
 assert.deepEqual(report.translationContextRevalidation,{status:'CONTEXT_REEVALUATION_REQUIRED',consumedRevision:2,latestRevisionAtCompletion:4,automaticRetry:false});
 assert.equal((await submit(f.store)).id,job.id);assert.equal(f.runs.length,1);
});

test('independent histories and duplicate absolute page numbers cannot be mistaken for an ordered previous page',async t=>{
 const f=await setup(t);
 for(const [key,pageId,pageNumber]of [['old-a','ambiguous',1],['new-a','ambiguous',1],['one-b','other-number',2],['two-b','duplicate-number',2],['good','good',3]]){
  const job=await submit(f.store,{idempotencyKey:key,pageId,pageNumber});await until(()=>f.store.get(alice,job.id));
 }
 const current=await submit(f.store,{idempotencyKey:'four',pageId:'four',pageNumber:4});await until(()=>f.store.get(alice,current.id));
 assert.deepEqual(f.runs.at(-1).translationContext.previousPages.map(page=>page.pageId),['good']);
});

test('assigning a batch number to a completed legacy page preserves its dispatch context and never requests inference again',async t=>{
 const f=await setup(t),job=await submit(f.store,{pageNumber:undefined});await until(()=>f.store.get(alice,job.id));
 const snapshotFile=path.join(f.root,job.id,'translation-context.json'),before=await readFile(snapshotFile),candidate=await readFile(path.join(f.root,job.id,'candidate.png'));
 assert.equal(JSON.parse(before).pageNumber,null);
 const batch=await f.store.submitBatch({owner:alice,projectId:'project-one',idempotencyKey:'number:upgrade',pages:[{key:'file:0',name:'one.png',bytes:png,pageId:'one',pageNumber:7}]});
 assert.equal(batch.pages[0].jobId,job.id);assert.equal((await f.store.get(alice,job.id)).status,'completed');
 assert.equal((await f.store.get(alice,job.id)).pageNumber,7);assert.equal(f.runs.length,1);
 await f.store.close();const reopened=await createJobStore({root:f.root,engine:f.engine,contextStore:f.contextStore});t.after(()=>reopened.close());
 assert.equal((await reopened.get(alice,job.id)).status,'completed');assert.equal((await reopened.retry(alice,job.id,{idempotencyKey:'completed:skip'})).id,job.id);
 assert.equal(f.runs.length,1);assert.deepEqual(await readFile(snapshotFile),before);assert.deepEqual(await readFile(path.join(f.root,job.id,'candidate.png')),candidate);
});

test('numbering a legacy page during inference preserves its original context and completion',async t=>{
 const gate=deferred(),f=await setup(t,{gate}),job=await submit(f.store,{pageNumber:undefined});await f.started.promise;
 try{
  const batch=await f.store.submitBatch({owner:alice,projectId:'project-one',idempotencyKey:'running:number',pages:[{key:'file:0',name:'one.png',bytes:png,pageId:'one',pageNumber:7}]});
  assert.equal(batch.pages[0].jobId,job.id);assert.equal(batch.pages[0].status,'running');
 }finally{gate.resolve();}
 const completed=await until(()=>f.store.get(alice,job.id));assert.equal(completed.status,'completed');assert.equal(completed.pageNumber,7);
 assert.equal(f.runs.length,1);assert.equal(f.runs[0].pageNumber,null);assert.equal(f.runs[0].translationContext.pageNumber,null);
});
