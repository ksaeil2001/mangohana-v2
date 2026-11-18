import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createJobStore} from '../../apps/engine/store.mjs';
import sharp from 'sharp';
import {fixture,png,hash,alice,bob,deferred,until} from './batch-fixture.mjs';

test('accepts every page durably before starting the first inference',async t=>{
 const gate=deferred();let verifiedAtStart=false;
 const f=await fixture(t,{gate,onRun:async (input,index)=>{
  if(index!==1)return;
  const state=JSON.parse(await readFile(path.join(input.outputDirectory,'state.json'),'utf8'));
  const batch=JSON.parse(await readFile(path.join(f.root,'batches',state.batchId,'state.json'),'utf8'));
  assert.equal(batch.status,'accepted');assert.equal(batch.pages.length,10);
  for(const page of batch.pages){assert.deepEqual(await readFile(path.join(f.root,page.jobId,'source.png')),png);}
  verifiedAtStart=true;
 }});
 assert.equal(typeof f.store.submitBatch,'function','the server must durably admit a whole batch');
 const batch=await f.submitBatch({pages:Array.from({length:10},(_,index)=>({key:'file:'+index,name:(index+1)+'.png',bytes:png,pageId:'page-'+(index+1),pageNumber:index+1}))});
 await f.started.promise;await until(()=>Promise.resolve(verifiedAtStart),value=>value);assert.equal(batch.pages.length,10);
 gate.resolve();const completed=await until(()=>f.store.getBatch(alice,batch.id),value=>value.status==='completed');
 assert.equal(completed.completedPages,10);assert.equal(f.maximum(),1);assert.equal(f.runs.length,10);
});
test('a repeated batch key restores the same jobs and conflicting bytes cannot create work',async t=>{
 const gate=deferred(),f=await fixture(t,{gate});
 assert.equal(typeof f.store.submitBatch,'function');
 const first=await f.submitBatch(),again=await f.submitBatch();assert.equal(first.id,again.id);assert.deepEqual(first.pages.map(page=>page.jobId),again.pages.map(page=>page.jobId));
 await assert.rejects(f.store.getBatch(bob,first.id),{code:'BATCH_NOT_FOUND'});
 await assert.rejects(f.submitBatch({pages:[{key:'file:1',name:'different.png',bytes:png,pageId:'page-1',pageNumber:1}]}),{code:'IDEMPOTENCY_CONFLICT'});
 gate.resolve();await until(()=>f.store.getBatch(alice,first.id),value=>value.status==='completed');assert.equal(f.runs.length,3);
 const other=await f.submitBatch({idempotencyKey:'batch-two'});assert.deepEqual(other.pages.map(page=>page.jobId),first.pages.map(page=>page.jobId));
 assert.equal(f.runs.length,3,'an already translated page is reused across batches');
});
test('a bad final image rejects the complete batch before writing source files or invoking the engine',async t=>{
 const f=await fixture(t);assert.equal(typeof f.store.submitBatch,'function');
 await assert.rejects(f.submitBatch({pages:[{key:'file:0',name:'1.png',bytes:png},{key:'file:1',name:'2.png',bytes:Buffer.from('not a PNG')}]}));
 assert.equal(f.runs.length,0);assert.deepEqual((await readdir(f.root)).filter(name=>/^[0-9a-f-]{36}$/.test(name)),[]);
});
test('reading priority promotes the current page and next two without interrupting an active page',async t=>{
 const gate=deferred(),f=await fixture(t,{gate});assert.equal(typeof f.store.submitBatch,'function');
 const batch=await f.submitBatch({pages:[1,2,3,4,5,6].map(number=>({key:'file:'+number,name:number+'.png',bytes:png,pageId:'page-'+number,pageNumber:number}))});
 await f.started.promise;await f.store.prioritize(alice,{projectId:'project-one',pageId:'page-4'});
 await assert.rejects(f.store.prioritize(bob,{projectId:'project-one',pageId:'page-4'}),{code:'PAGE_NOT_FOUND'});
 assert.equal(f.runs.length,1);gate.resolve();await until(()=>f.store.getBatch(alice,batch.id),value=>value.status==='completed');
 assert.deepEqual(f.runs.map(input=>input.pageNumber),[1,4,5,6,2,3]);
});
test('only a failed page gets a new retry job while the original and completed pages remain unchanged',async t=>{
 let failed=false;const f=await fixture(t,{fail:input=>input.pageNumber===2&&!failed&&(failed=true)});assert.equal(typeof f.store.submitBatch,'function');
 const batch=await f.submitBatch();const partial=await until(()=>f.store.getBatch(alice,batch.id),value=>value.status==='partial');
 assert.equal(partial.failedPages,1);assert.equal(partial.completedPages,2);
 const old=partial.pages.find(page=>page.pageNumber===2),good=partial.pages.find(page=>page.pageNumber===1);
 const source=await readFile(path.join(f.root,old.jobId,'source.png'));const result=await readFile(path.join(f.root,good.jobId,'candidate.png'));
 const retry=await f.store.retry(alice,old.jobId,{idempotencyKey:'retry-two'});const duplicate=await f.store.retry(alice,old.jobId,{idempotencyKey:'retry-two'});
 assert.equal(retry.id,duplicate.id);assert.notEqual(retry.id,old.jobId);assert.equal(retry.pageNumber,2);
 await until(()=>f.store.getBatch(alice,batch.id),value=>value.status==='completed');assert.equal(f.runs.length,4);
 assert.deepEqual(await readFile(path.join(f.root,old.jobId,'source.png')),source);assert.deepEqual(await readFile(path.join(f.root,good.jobId,'candidate.png')),result);
 assert.equal((await f.store.get(alice,old.jobId)).status,'failed');
 assert.equal((await f.store.retry(alice,good.jobId,{idempotencyKey:'unnecessary'})).id,good.jobId);assert.equal(f.runs.length,4);
});
test('restart keeps queued pages and marks an interrupted running page failed without replay',async t=>{
 const gate=deferred(),f=await fixture(t,{gate});assert.equal(typeof f.store.submitBatch,'function');
 const batch=await f.submitBatch();await f.started.promise;await f.store.close();
 f.store=await createJobStore({root:f.root,engine:{...f.engine,run:async input=>{assert.notEqual(input.jobId,batch.pages[0].jobId);return f.engine.run(input);}}});
 gate.resolve();const result=await until(()=>f.store.getBatch(alice,batch.id),value=>value.status==='partial');
 assert.equal(result.failedPages,1);assert.equal(result.completedPages,2);assert.equal(f.runs.filter(input=>input.jobId===batch.pages[0].jobId).length,1);
});
test('an uncommitted crash batch never queues its preserved pages on restart',async t=>{
 const gate=deferred(),f=await fixture(t,{gate});assert.equal(typeof f.store.submitBatch,'function');
 const batch=await f.submitBatch();await f.started.promise;await f.store.close();
 const file=path.join(f.root,'batches',batch.id,'state.json'),state=JSON.parse(await readFile(file,'utf8'));state.status='preparing';await writeFile(file,JSON.stringify(state));
 const before=f.runs.length;f.store=await createJobStore({root:f.root,engine:f.engine});gate.resolve();
 const recovered=await f.store.getBatch(alice,batch.id);assert.equal(recovered.status,'failed');
 await new Promise(resolve=>setTimeout(resolve,40));assert.equal(f.runs.length,before);
 for(const page of batch.pages)assert.deepEqual(await readFile(path.join(f.root,page.jobId,'source.png')),png);
});
test('usage exposes measured local counts but unreported cost remains unknown',async t=>{
 const f=await fixture(t);assert.equal(typeof f.store.submitBatch,'function');const batch=await f.submitBatch();
 const done=await until(()=>f.store.getBatch(alice,batch.id),value=>value.status==='completed');
 const job=await f.store.get(alice,done.pages[0].jobId);assert.equal(job.usage.localModelRequests,1);assert.equal(job.usage.modelRequestMs,18);assert.equal(job.usage.engineMeasuredMs,25);
 assert.equal(job.usage.monetaryCost,null);assert.ok(job.usage.processingMs>=0);
});
test('explicit absolute page order is respected even when uploads arrive out of order',async t=>{
 const f=await fixture(t);const batch=await f.submitBatch({pages:[10,2,1].map(number=>({key:'file:'+number,name:number+'.png',bytes:png,pageId:'page-'+number,pageNumber:number}))});
 assert.deepEqual(batch.pages.map(page=>page.pageNumber),[1,2,10]);await until(()=>f.store.getBatch(alice,batch.id),value=>value.status==='completed');assert.deepEqual(f.runs.map(input=>input.pageNumber),[1,2,10]);
});
test('a changed reading priority does not change a batch content idempotency key',async t=>{
 const gate=deferred(),f=await fixture(t,{gate});const first=await f.submitBatch({currentPageId:'page-1'});
 const repeated=await f.submitBatch({currentPageId:'page-3'});assert.equal(first.id,repeated.id);gate.resolve();await until(()=>f.store.getBatch(alice,first.id),value=>value.status==='completed');assert.equal(f.runs.length,3);
});
test('restart rejects a batch manifest pointing at another owner job',async t=>{
 const f=await fixture(t),batch=await f.submitBatch();await until(()=>f.store.getBatch(alice,batch.id),value=>value.status==='completed');
 const other=await f.store.submit({owner:bob,idempotencyKey:'other',bytes:png,name:'other.png',projectId:'secret-project',pageId:'secret-page'});await until(()=>f.store.get(bob,other.id));await f.store.close();
 const file=path.join(f.root,'batches',batch.id,'state.json'),state=JSON.parse(await readFile(file,'utf8'));state.pages[0].jobId=other.id;await writeFile(file,JSON.stringify(state));
 await assert.rejects(createJobStore({root:f.root,engine:f.engine}),{code:'STORE_CORRUPT'});
});
test('an explicit retry of a preserved precommit page stays admitted after restart',async t=>{
 const gate=deferred(),f=await fixture(t,{gate});const batch=await f.submitBatch();await f.started.promise;await f.store.close();
 const file=path.join(f.root,'batches',batch.id,'state.json'),state=JSON.parse(await readFile(file,'utf8'));state.status='preparing';await writeFile(file,JSON.stringify(state));
 f.store=await createJobStore({root:f.root,engine:f.engine});gate.resolve();const retry=await f.store.retry(alice,batch.pages[1].jobId,{idempotencyKey:'recover-one'});
 await until(()=>f.store.get(alice,retry.id));assert.equal((await f.store.get(alice,retry.id)).status,'completed');await f.store.close();
 f.store=await createJobStore({root:f.root,engine:f.engine});assert.equal((await f.store.get(alice,retry.id)).status,'completed');
 assert.equal((await f.store.get(alice,batch.pages[2].jobId)).status,'failed');
});
test('JPG PNG and WebP originals are preserved with their actual MIME and full decoding',async t=>{
 const f=await fixture(t),jpg=await sharp(png).jpeg().toBuffer(),webp=await sharp(png).webp().toBuffer();
 const batch=await f.submitBatch({pages:[{key:'file:0',name:'1.jpg',bytes:jpg},{key:'file:1',name:'2.png',bytes:png},{key:'file:2',name:'3.webp',bytes:webp}]});
 await until(()=>f.store.getBatch(alice,batch.id),value=>value.status==='completed');
 for(const [index,extension,bytes]of [[0,'.jpg',jpg],[1,'.png',png],[2,'.webp',webp]])assert.deepEqual(await readFile(path.join(f.root,batch.pages[index].jobId,'source'+extension)),bytes);
});
test('failed-page retry rejects an altered stored original and another owner without an inference',async t=>{
 const f=await fixture(t,{fail:()=>true}),batch=await f.submitBatch({pages:[{key:'file:0',name:'1.png',bytes:png,pageId:'page-1',pageNumber:1}]});
 await until(()=>f.store.getBatch(alice,batch.id),value=>value.status==='failed');const id=batch.pages[0].jobId;
 await assert.rejects(f.store.retry(bob,id,{idempotencyKey:'foreign'}),{code:'JOB_NOT_FOUND'});
 await writeFile(path.join(f.root,id,'source.png'),Buffer.concat([png,Buffer.from('tampered')]));
 await assert.rejects(f.store.retry(alice,id,{idempotencyKey:'altered'}),{code:'SOURCE_INTEGRITY_FAILED'});assert.equal(f.runs.length,1);
});
test('a legacy page reused by a batch receives an absolute number that its retry preserves',async t=>{
 const f=await fixture(t,{fail:(_input,index)=>index===1}),old=await f.store.submit({owner:alice,idempotencyKey:'legacy',bytes:png,name:'legacy.png',projectId:'project-one',pageId:'legacy-page'});
 await until(()=>f.store.get(alice,old.id));const batch=await f.submitBatch({pages:[{key:'file:0',name:'legacy.png',bytes:png,pageId:'legacy-page',pageNumber:7}]});assert.equal(batch.pages[0].jobId,old.id);
 const retry=await f.store.retry(alice,old.id,{idempotencyKey:'legacy-retry'});await until(()=>f.store.get(alice,retry.id));assert.equal(retry.pageNumber,7);assert.deepEqual(f.runs.map(input=>input.pageNumber),[null,7]);
});
test('priority survives restart and never replays the interrupted current page',async t=>{
 const gate=deferred(),f=await fixture(t,{gate});const batch=await f.submitBatch({pages:[1,2,3,4,5].map(number=>({key:'file:'+number,name:number+'.png',bytes:png,pageId:'page-'+number,pageNumber:number}))});
 await f.started.promise;await f.store.prioritize(alice,{projectId:'project-one',pageId:'page-4'});await f.store.close();f.store=await createJobStore({root:f.root,engine:f.engine});gate.resolve();
 await until(()=>f.store.getBatch(alice,batch.id),value=>value.status==='partial');assert.deepEqual(f.runs.map(input=>input.pageNumber),[1,4,5,2,3]);
});
test('next two reading pages follow project order across absolute-number gaps',async t=>{
 const gate=deferred(),f=await fixture(t,{gate}),batch=await f.submitBatch({pages:[1,2,3,10,11].map(number=>({key:'file:'+number,name:number+'.png',bytes:png,pageId:'page-'+number,pageNumber:number}))});
 await f.started.promise;await f.store.prioritize(alice,{projectId:'project-one',pageId:'page-3'});gate.resolve();await until(()=>f.store.getBatch(alice,batch.id),value=>value.status==='completed');assert.deepEqual(f.runs.map(input=>input.pageNumber),[1,3,10,11,2]);
});
