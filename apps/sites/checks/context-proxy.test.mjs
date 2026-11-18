// Source-level proxy with an intercepted upstream; no browser or AI execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {once} from 'node:events';
import {createContextStore} from '../../engine/context.mjs';
import {createEngineServer} from '../../engine/server.mjs';
const directory=path.resolve('E:/Dev/Outputs/MangohanaV2-20261111/tests/context-proxy-'+Date.now());await mkdir(directory,{recursive:true});
const source=await readFile(new URL('../app/api/engine/[...path]/route.ts',import.meta.url),'utf8');
const moduleFile=path.join(directory,'route.mjs');await writeFile(moduleFile,stripTypeScriptTypes(source));const route=await import(pathToFileURL(moduleFile));
const originalFetch=globalThis.fetch;
const payload={expected_revision:0,idempotency_key:'term:edit',changes:[{type:'upsert_term',term:{id:'name',source:'名前',target:'이름'}}]};
const scope='a'.repeat(64);
const invoke=(method,body,headers={})=>route[method](new Request('https://site.test/api/engine/projects/book/context',{method,headers:{Origin:'https://site.test',Cookie:'mangohana_engine_session=synthetic','Content-Type':'application/json','X-Mangohana-Context-Scope':scope,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),{params:{path:['projects','book','context']}});
test('project context reads and exact user commands preserve their owner cookie and revision body',async()=>{
 const before=process.env.MANGOHANA_ENGINE_URL;process.env.MANGOHANA_ENGINE_URL='http://127.0.0.1:45678';const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json({revision:1});};
 try{
  assert.equal((await invoke('GET')).status,200);assert.equal((await invoke('POST',payload)).status,200);
  assert.equal(calls.length,2);assert.equal(calls[1].url,'http://127.0.0.1:45678/projects/book/context');
  assert.equal(calls[1].init.headers.get('Cookie'),'mangohana_engine_session=synthetic');
  assert.equal(calls[1].init.headers.get('X-Mangohana-Context-Scope'),scope);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(calls[1].init.body)),payload);
 }finally{globalThis.fetch=originalFetch;if(before===undefined)delete process.env.MANGOHANA_ENGINE_URL;else process.env.MANGOHANA_ENGINE_URL=before;}
});
test('context proxy refuses forged provenance, ownership and unsupported methods before upstream access',async()=>{
 const before=process.env.MANGOHANA_ENGINE_URL;process.env.MANGOHANA_ENGINE_URL='http://127.0.0.1:45678';let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};
 try{
  for(const body of [{...payload,owner:'foreign'},{...payload,changes:[{...payload.changes[0],reference:{sourceJobId:'fake'}}]},
   {...payload,expected_revision:-1},{...payload,changes:[{type:'propose_term',term:payload.changes[0].term}]}])assert.equal((await invoke('POST',body)).status,400);
  assert.equal((await invoke('PUT',payload)).status,405);assert.equal(calls,0);
  assert.equal((await invoke('POST',payload,{'X-Mangohana-Context-Scope':''})).status,400);assert.equal(calls,0);
 }finally{globalThis.fetch=originalFetch;if(before===undefined)delete process.env.MANGOHANA_ENGINE_URL;else process.env.MANGOHANA_ENGINE_URL=before;}
});

test('the proxy and real isolated context server keep a lost request bound to its original cookie scope',async t=>{
 const contextStore=await createContextStore({root:path.join(directory,'http-contexts')});
 const store={health:async()=>({ready:true}),submit:async()=>assert.fail('No AI job is part of this test'),get:async()=>{},getResult:async()=>{}};
 const server=createEngineServer({store,contextStore,allowedOrigin:'https://site.test'});server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await contextStore.close();});
 const before=process.env.MANGOHANA_ENGINE_URL;process.env.MANGOHANA_ENGINE_URL='http://127.0.0.1:'+server.address().port;globalThis.fetch=originalFetch;
 try{
  const initial=await invoke('GET',undefined,{Cookie:''}),cookie=initial.headers.getSetCookie()[0].split(';')[0],context=await initial.json();
  const saved=await invoke('POST',payload,{Cookie:cookie,'X-Mangohana-Context-Scope':context.scopeId});assert.equal(saved.status,200);await saved.arrayBuffer();
  const rotated=await invoke('GET',undefined,{Cookie:''}),otherCookie=rotated.headers.getSetCookie()[0].split(';')[0],other=await rotated.json();
  const replay=await invoke('POST',payload,{Cookie:otherCookie,'X-Mangohana-Context-Scope':context.scopeId});assert.equal(replay.status,409);
  const rejected=await replay.json();assert.equal(rejected.code,'CONTEXT_SCOPE_CHANGED');assert.equal(rejected.scopeId,other.scopeId);
  const original=await invoke('GET',undefined,{Cookie:cookie});assert.equal((await original.json()).revision,1);
  const untouched=await invoke('GET',undefined,{Cookie:otherCookie});assert.equal((await untouched.json()).revision,0);
 }finally{globalThis.fetch=originalFetch;if(before===undefined)delete process.env.MANGOHANA_ENGINE_URL;else process.env.MANGOHANA_ENGINE_URL=before;}
});
