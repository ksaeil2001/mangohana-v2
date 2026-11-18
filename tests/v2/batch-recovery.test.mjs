// Regression faults use only isolated synthetic files. No runtime/model or user artifact is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readdir,readFile,rename,rmdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createJobStore} from '../../apps/engine/store.mjs';
import {fixture,png,alice,hash,until} from './batch-fixture.mjs';
const jobIds=async root=>(await readdir(root)).filter(name=>/^[0-9a-f-]{36}$/.test(name)).sort();

for(const order of ['public-first','batch-first'])test(`public and private batch request keys survive ${order} mixed routes and legacy restore`,async t=>{
 const f=await fixture(t),batchKey='namespace-batch',fileKey='file:0';
 let publicKey='batch:'+hash(batchKey+'\0'+fileKey),batch;
 const publicInput=()=>({owner:alice,idempotencyKey:publicKey,bytes:png,name:'public.png',projectId:'public-project',pageId:'public-page'});
 const batchInput={idempotencyKey:batchKey,pages:[{key:fileKey,name:'batch.png',bytes:png,pageId:'batch-page',pageNumber:1}]};
 let publicJob;
 if(order==='public-first'){publicJob=await f.store.submit(publicInput());await until(()=>f.store.get(alice,publicJob.id));}
 batch=await f.submitBatch(batchInput);await until(()=>f.store.getBatch(alice,batch.id),value=>value.status==='completed');
 const internalState=JSON.parse(await readFile(path.join(f.root,batch.pages[0].jobId,'state.json'),'utf8'));
 publicKey=internalState.idempotencyKey;
 if(!publicJob){publicJob=await f.store.submit(publicInput());await until(()=>f.store.get(alice,publicJob.id));}
 await assert.doesNotReject(async()=>assert.equal((await f.store.submit(publicInput())).id,publicJob.id),'a private child request must not overwrite the public namespace');
 assert.equal((await f.submitBatch(batchInput)).pages[0].jobId,batch.pages[0].jobId);assert.equal(f.runs.length,2);assert.notEqual(publicJob.id,batch.pages[0].jobId);
 // Existing version-1 records did not carry an explicit request namespace.
 await f.store.close();
 for(const id of [publicJob.id,batch.pages[0].jobId]){const file=path.join(f.root,id,'state.json'),state=JSON.parse(await readFile(file,'utf8'));delete state.requestNamespace;await writeFile(file,JSON.stringify(state));}
 await assert.doesNotReject(async()=>{f.store=await createJobStore({root:f.root,engine:f.engine});});
 assert.equal((await f.store.submit(publicInput())).id,publicJob.id);assert.equal((await f.store.getBatch(alice,batch.id)).pages[0].jobId,batch.pages[0].jobId);assert.equal(f.runs.length,2);
});

test('a retry parent-link write fault reserves one unknown child across repetition and restart',async t=>{
 const f=await fixture(t,{fail:(_input,index)=>index===1}),batch=await f.submitBatch({pages:[{key:'file:0',name:'1.png',bytes:png,pageId:'page-1',pageNumber:1}]});
 await until(()=>f.store.getBatch(alice,batch.id),value=>value.status==='failed');const previousId=batch.pages[0].jobId;
 const parentFile=path.join(f.root,previousId,'state.json'),savedFile=path.join(f.root,previousId,'state.before-fault.json');
 assert.equal(path.dirname(path.dirname(parentFile)),f.root);await rename(parentFile,savedFile);await mkdir(parentFile);
 let childId;
 try{
  await assert.rejects(f.store.retry(alice,previousId,{idempotencyKey:'retry-fault'}));
  const once=await jobIds(f.root);assert.equal(once.length,2);childId=once.find(id=>id!==previousId);
  await assert.rejects(f.store.retry(alice,previousId,{idempotencyKey:'retry-fault'}));
  assert.deepEqual(await jobIds(f.root),once,'a lost link commit cannot create a second state for the same retry key');
  await assert.rejects(f.store.retry(alice,previousId,{idempotencyKey:'retry-other-key'}),{code:'RETRY_COMMIT_UNKNOWN'});
  assert.deepEqual(await jobIds(f.root),once,'a different retry key must not bypass an uncertain admission');
  assert.equal(f.runs.length,1,'no child inference is admitted while the link is unknown');
  const child=await f.store.get(alice,childId);assert.equal(child.status,'queued');assert.equal(child.stage,'retry_acceptance_unknown');assert.equal(child.errorCode,'RETRY_COMMIT_UNKNOWN');
 }finally{await rmdir(parentFile);await rename(savedFile,parentFile);}
 await f.store.close();f.store=await createJobStore({root:f.root,engine:f.engine});
 await new Promise(resolve=>setTimeout(resolve,50));assert.equal(f.runs.length,1);assert.equal((await f.store.get(alice,childId)).stage,'retry_acceptance_unknown');
 const recovered=await f.store.retry(alice,previousId,{idempotencyKey:'retry-fault'});assert.equal(recovered.id,childId);
 await until(()=>f.store.get(alice,childId));assert.equal((await f.store.get(alice,childId)).status,'completed');assert.equal(f.runs.length,2);
 await f.store.close();f.store=await createJobStore({root:f.root,engine:f.engine});assert.equal((await f.store.get(alice,childId)).status,'completed');assert.equal(f.runs.length,2);
});

test('an unlinked retry with execution evidence is preserved without inference on either retry key',async t=>{
 const f=await fixture(t,{fail:(_input,index)=>index===1}),batch=await f.submitBatch({pages:[{key:'file:0',name:'1.png',bytes:png,pageId:'page-1',pageNumber:1}]});
 await until(()=>f.store.getBatch(alice,batch.id),value=>value.status==='failed');const previousId=batch.pages[0].jobId;
 const parentFile=path.join(f.root,previousId,'state.json'),savedFile=path.join(f.root,previousId,'state.before-fault.json');
 assert.equal(path.dirname(path.dirname(parentFile)),f.root);await rename(parentFile,savedFile);await mkdir(parentFile);
 try{await assert.rejects(f.store.retry(alice,previousId,{idempotencyKey:'retry-observed'}),{code:'RETRY_COMMIT_UNKNOWN'});}
 finally{await rmdir(parentFile);await rename(savedFile,parentFile);}
 const childId=(await jobIds(f.root)).find(id=>id!==previousId);await f.store.close();
 const evidenceFile=path.join(f.root,childId,'progress.jsonl'),evidence=Buffer.from('{"stage":"synthetic_execution_evidence"}\n');
 await writeFile(evidenceFile,evidence,{flag:'wx'});f.store=await createJobStore({root:f.root,engine:f.engine});
 const before=await jobIds(f.root);await new Promise(resolve=>setTimeout(resolve,50));assert.equal(f.runs.length,1);
 for(const idempotencyKey of ['retry-observed','retry-another'])await assert.rejects(f.store.retry(alice,previousId,{idempotencyKey}),{code:'RETRY_COMMIT_UNKNOWN'});
 assert.deepEqual(await jobIds(f.root),before);assert.deepEqual(await readFile(evidenceFile),evidence);assert.equal(f.runs.length,1);
 const child=await f.store.get(alice,childId);assert.equal(child.stage,'retry_acceptance_unknown');assert.equal(child.errorCode,'RETRY_COMMIT_UNKNOWN');
 await f.store.close();f.store=await createJobStore({root:f.root,engine:f.engine});
 await assert.rejects(f.store.retry(alice,previousId,{idempotencyKey:'retry-observed'}),{code:'RETRY_COMMIT_UNKNOWN'});assert.equal(f.runs.length,1);
});

test('automatic page numbers cannot persist past the supported absolute limit',async t=>{
 for(const last of [99999,100000])await t.test('last '+last,async sub=>{
  const f=await fixture(sub),seed=await f.store.submit({owner:alice,idempotencyKey:'seed:'+last,bytes:png,name:'seed.png',projectId:'project-one',pageId:'seed-'+last,pageNumber:last});await until(()=>f.store.get(alice,seed.id));
  const before=(await readdir(f.root)).sort();
  await assert.rejects(f.submitBatch({pages:[{key:'file:0',name:'next.png',bytes:png},{key:'file:1',name:'after.png',bytes:png}]}),{code:'PAGE_NUMBER_LIMIT'});
  assert.deepEqual((await readdir(f.root)).sort(),before,'number exhaustion must be rejected before source/manifest creation');assert.equal(f.runs.length,1);
  await f.store.close();await assert.doesNotReject(async()=>{f.store=await createJobStore({root:f.root,engine:f.engine});});assert.equal((await f.store.get(alice,seed.id)).pageNumber,last);
 });
});
