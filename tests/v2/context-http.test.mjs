// Ephemeral loopback HTTP + real context persistence; no browser or AI calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {createContextStore} from '../../apps/engine/context.mjs';
import {createEngineServer} from '../../apps/engine/server.mjs';

const origin='http://127.0.0.1:5173',root=path.resolve('E:/Dev/Outputs/MangohanaV2-20261111/tests/context-http-'+Date.now());
await mkdir(root,{recursive:true});
async function fixture(t){
 const contextStore=await createContextStore({root:await mkdtemp(path.join(root,'store-'))});
 const store={health:async()=>({ready:true}),submit:async()=>assert.fail('No image or inference is authorized in this test'),get:async()=>{},getResult:async()=>{}};
 const server=createEngineServer({store,contextStore,allowedOrigin:origin});server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await contextStore.close();});
 const base='http://127.0.0.1:'+server.address().port;
 const health=await fetch(base+'/health'),cookie=health.headers.get('set-cookie').split(';')[0];await health.arrayBuffer();
 const initial=await fetch(base+'/projects/work/context',{headers:{cookie}}),context=await initial.json();
 return {base,cookie,scopeId:context.scopeId,request:async(body,custom={})=>fetch(base+'/projects/work/context',{method:'POST',headers:{origin,cookie,'content-type':'application/json',...(context.scopeId?{'X-Mangohana-Context-Scope':context.scopeId}:{}),...custom},body:JSON.stringify(body)})};
}
const edit={expected_revision:0,idempotency_key:'edit:one',changes:[{type:'upsert_term',term:{id:'character',source:'名前',target:'이름'}}]};
test('same-origin owner can store, confirm and replay terminology without promoting an edit automatically',async t=>{
 const f=await fixture(t),response=await f.request(edit);assert.equal(response.status,200);const first=await response.json();
 assert.equal(first.terms[0].status,'USER_MODIFIED');assert.equal(first.revision,1);
 const repeated=await f.request(edit);assert.equal(repeated.status,200);assert.equal((await repeated.json()).replayed,true);
 const confirmed=await f.request({expected_revision:1,idempotency_key:'confirm:one',changes:[{type:'confirm_term',id:'character',expectedEntryRevision:1}]});
 assert.equal(confirmed.status,200);assert.equal((await confirmed.json()).terms[0].status,'USER_CONFIRMED');
 const own=await fetch(f.base+'/projects/work/context',{headers:{cookie:f.cookie}});assert.equal((await own.json()).revision,2);
 const other=await fetch(f.base+'/projects/work/context');assert.deepEqual((await other.json()).terms,[]);
 const project=await fetch(f.base+'/projects/another/context',{headers:{cookie:f.cookie}});assert.equal((await project.json()).revision,0);
});
test('context writes reject owner/status/reference injection and stale confirmation while preserving the saved edit',async t=>{
 const f=await fixture(t);
 for(const input of [{...edit,owner:'chosen'}, {...edit,changes:[{...edit.changes[0],reference:{sourceJobId:'forged'}}]},
  {...edit,changes:[{...edit.changes[0],status:'USER_CONFIRMED'}]}, {...edit,changes:[{type:'propose_term',term:edit.changes[0].term}]}]){
  const response=await f.request(input);assert.equal(response.status,422);await response.arrayBuffer();
 }
 assert.equal((await f.request(edit)).status,200);
 const stale=await f.request({expected_revision:0,idempotency_key:'stale',changes:[{type:'confirm_term',id:'character',expectedEntryRevision:1}]});assert.equal(stale.status,409);await stale.arrayBuffer();
 const missingOrigin=await f.request({...edit,idempotency_key:'different'},{origin:'https://foreign.invalid'});assert.equal(missingOrigin.status,403);await missingOrigin.arrayBuffer();
 const read=await fetch(f.base+'/projects/work/context',{headers:{cookie:f.cookie}});assert.equal((await read.json()).terms[0].status,'USER_MODIFIED');
});

test('recovering an acknowledged-lost request after cookie rotation cannot create a write for a new owner',async t=>{
 const f=await fixture(t),first=await f.request(edit);assert.equal(first.status,200);await first.arrayBuffer();
 const health=await fetch(f.base+'/health'),newCookie=health.headers.get('set-cookie').split(';')[0];await health.arrayBuffer();
 const replay=await f.request(edit,{cookie:newCookie});assert.equal(replay.status,409);
 const rejected=await replay.json();assert.equal(rejected.code,'CONTEXT_SCOPE_CHANGED');assert.match(rejected.scopeId,/^[a-f0-9]{64}$/);assert.notEqual(rejected.scopeId,f.scopeId);
 const current=await fetch(f.base+'/projects/work/context',{headers:{cookie:newCookie}});assert.equal((await current.json()).revision,0);
 const original=await fetch(f.base+'/projects/work/context',{headers:{cookie:f.cookie}});assert.equal((await original.json()).revision,1);
});

test('scope identity is opaque, project scoped and required even when a request revision would match',async t=>{
 const f=await fixture(t);assert.match(f.scopeId,/^[a-f0-9]{64}$/);
 const other=await fetch(f.base+'/projects/other/context',{headers:{cookie:f.cookie}}),otherContext=await other.json();assert.notEqual(otherContext.scopeId,f.scopeId);
 const missing=await f.request(edit,{'X-Mangohana-Context-Scope':''});assert.equal(missing.status,409);assert.equal((await missing.json()).code,'CONTEXT_SCOPE_CHANGED');
 const rejected=await f.request({...edit,expected_revision:99});assert.equal(rejected.status,409);assert.equal((await rejected.json()).scopeId,f.scopeId);
 const context=await fetch(f.base+'/projects/work/context',{headers:{cookie:f.cookie}});assert.equal((await context.json()).revision,0);
});
