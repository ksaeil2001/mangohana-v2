// Real loopback HTTP, multipart, archive and durable store; inference is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {ZipFile} from 'yazl';
import {createEngineServer} from '../../apps/engine/server.mjs';
import {fixture,png,alice,hash,until} from './batch-fixture.mjs';
const origin='http://127.0.0.1:5173';
async function httpFixture(t){
 const f=await fixture(t),server=createEngineServer({store:f.store,allowedOrigin:origin});server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>server.close(resolve)));const base='http://127.0.0.1:'+server.address().port;
 const health=await fetch(base+'/health'),cookie=health.headers.get('set-cookie').split(';')[0];await health.arrayBuffer();
 return {...f,base,cookie,owner:hash(cookie.split('=')[1])};
}
function form(){const body=new FormData();for(const number of [10,2,1])body.append('files',new Blob([png]),number+'.png');
 body.set('project_id','comic-one');body.set('source_language','ja');body.set('target_language','ko');body.set('idempotency_key','http-batch');
 body.set('manifest',JSON.stringify([{key:'file:0',page_id:'page-ten',page_number:10},{key:'file:1',page_id:'page-two',page_number:2},{key:'file:2',page_id:'page-one',page_number:1}]));return body;}
test('batch multipart returns restorable per-page jobs and correct client page identities',async t=>{
 const f=await httpFixture(t),response=await fetch(f.base+'/batches',{method:'POST',headers:{origin,cookie:f.cookie},body:form()});
 assert.equal(response.status,202,'the real batch route must accept a complete multi-image request');const batch=await response.json();
 assert.deepEqual(batch.pages.map(page=>page.pageId),['page-one','page-two','page-ten']);assert.deepEqual(batch.pages.map(page=>page.pageNumber),[1,2,10]);
 const again=await fetch(f.base+'/batches',{method:'POST',headers:{origin,cookie:f.cookie},body:form()});assert.equal(again.status,202);assert.equal((await again.json()).id,batch.id);
 const done=await until(async()=>{const reply=await fetch(f.base+'/batches/'+batch.id,{headers:{cookie:f.cookie}});assert.equal(reply.status,200);return reply.json();},value=>value.status==='completed');assert.equal(done.completedPages,3);
 const foreign=await fetch(f.base+'/batches/'+batch.id);assert.equal(foreign.status,404);await foreign.arrayBuffer();assert.equal(f.runs.length,3);
});
test('batch fields, unknown manifest entries and mixed archives are rejected without creating jobs',async t=>{
 const f=await httpFixture(t);
 for(const make of [()=>{const value=form();value.append('project_id','other');return value;},()=>{const value=form();value.set('manifest',JSON.stringify([{key:'file:99',page_id:'wrong',page_number:1}]));return value;},()=>{const value=form();value.set('owner','attacker');value.set('current_page_id','not-in-batch');return value;}]){
  const response=await fetch(f.base+'/batches',{method:'POST',headers:{origin,cookie:f.cookie},body:make()});assert.equal(response.status,422);await response.arrayBuffer();
 }
 assert.equal(f.runs.length,0);
});
test('a genuine image ZIP uses the same durable batch endpoint',async t=>{
 const f=await httpFixture(t),archive=new ZipFile(),chunks=[];const bytes=new Promise(resolve=>{archive.outputStream.on('data',chunk=>chunks.push(chunk));archive.outputStream.once('end',()=>resolve(Buffer.concat(chunks)));});
 for(const number of [10,2,1])archive.addBuffer(png,'chapter/'+number+'.png');archive.end();
 const body=new FormData();body.append('files',new Blob([await bytes]),'chapter.zip');body.set('project_id','zip-comic');body.set('idempotency_key','zip-request');
 const response=await fetch(f.base+'/batches',{method:'POST',headers:{origin,cookie:f.cookie},body});assert.equal(response.status,202);const batch=await response.json();
 assert.deepEqual(batch.pages.map(page=>page.name),['1.png','2.png','10.png']);await until(()=>f.store.getBatch(f.owner,batch.id),value=>value.status==='completed');
});
test('priority and retry endpoints require owner scope and reject extra JSON authority fields',async t=>{
 const f=await httpFixture(t),response=await fetch(f.base+'/batches',{method:'POST',headers:{origin,cookie:f.cookie},body:form()});assert.equal(response.status,202);const batch=await response.json();
 const headers={origin,cookie:f.cookie,'content-type':'application/json'};
 const priority=await fetch(f.base+'/projects/comic-one/priority',{method:'POST',headers,body:JSON.stringify({page_id:'page-two'})});assert.equal(priority.status,200);await priority.arrayBuffer();
 const denied=await fetch(f.base+'/projects/comic-one/priority',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({page_id:'page-two'})});assert.equal(denied.status,404);await denied.arrayBuffer();
 const wrong=await fetch(f.base+'/projects/comic-one/priority',{method:'POST',headers,body:JSON.stringify({page_id:'page-two',owner:f.owner})});assert.equal(wrong.status,422);await wrong.arrayBuffer();
 await until(()=>f.store.getBatch(f.owner,batch.id),value=>value.status==='completed');
 const retry=await fetch(f.base+'/jobs/'+batch.pages[0].jobId+'/retry',{method:'POST',headers,body:JSON.stringify({idempotency_key:'already-done'})});assert.equal(retry.status,202);assert.equal((await retry.json()).id,batch.pages[0].jobId);assert.equal(f.runs.length,3);
});
test('resolve finds an accepted batch by private project and request key without uploading or creating a job',async t=>{
 const f=await httpFixture(t),accepted=await fetch(f.base+'/batches',{method:'POST',headers:{origin,cookie:f.cookie},body:form()});assert.equal(accepted.status,202);const batch=await accepted.json();
 const headers={origin,cookie:f.cookie,'content-type':'application/json'},body=JSON.stringify({project_id:'comic-one',idempotency_key:'http-batch'});
 const resolved=await fetch(f.base+'/batches/resolve',{method:'POST',headers,body});assert.equal(resolved.status,200);const value=await resolved.json();assert.equal(value.id,batch.id);assert.deepEqual(value.pages.map(page=>page.jobId),batch.pages.map(page=>page.jobId));
 const foreign=await fetch(f.base+'/batches/resolve',{method:'POST',headers:{origin,'content-type':'application/json'},body});assert.equal(foreign.status,404);assert.equal((await foreign.json()).code,'BATCH_UNKNOWN');
 const unknown=await fetch(f.base+'/batches/resolve',{method:'POST',headers,body:JSON.stringify({project_id:'comic-one',idempotency_key:'not-admitted'})});assert.equal(unknown.status,404);assert.equal((await unknown.json()).code,'BATCH_UNKNOWN');
 await until(()=>f.store.getBatch(f.owner,batch.id),value=>value.status==='completed');assert.equal(f.runs.length,3);
});
