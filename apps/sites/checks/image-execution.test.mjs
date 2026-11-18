import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'image-web-')),source=await fs.readFile(new URL('../app/api/engine/[...path]/route.ts',import.meta.url),'utf8'),file=path.join(temp,'proxy.mjs');await fs.writeFile(file,transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText);const route=await import(pathToFileURL(file));
const page='a'.repeat(64),id='12345678-1234-4123-8123-123456789abc',scope='b'.repeat(64),expected={expectedEditRevision:1,expectedContextRevision:0,eventSha256:'c'.repeat(64),selectedSetSha256:'d'.repeat(64)};
test('dedicated image proxy forwards only exact guards, permit action and existing session',async()=>{
 const previous=process.env.MANGOHANA_ENGINE_URL,original=globalThis.fetch,calls=[];process.env.MANGOHANA_ENGINE_URL='http://127.0.0.1:45678';globalThis.fetch=async(url,init)=>{calls.push({url,init});return Response.json({ok:true});};
 const invoke=(suffix,method='POST',body={},extra={})=>{const parts=['translation-review-pages',page,...suffix.split('/')];return route[method](new Request('https://site.test/api/engine/'+parts.join('/'),{method,headers:{Origin:'https://site.test',Cookie:'mangohana_engine_session=existing','Content-Type':'application/json','X-Mangohana-Review-Scope':scope,...extra},...(method==='POST'?{body:JSON.stringify(body)}:{})}),{params:{path:parts}});};
 try{
  assert.equal((await invoke('image-preflight','POST',expected)).status,200);assert.equal((await invoke('image-permits','POST',{permitId:id,proposalSha256:'e'.repeat(64),executionAcknowledged:true})).status,200);
  for(const action of ['execute','cancel'])assert.equal((await invoke('image-permits/'+id+'/'+action)).status,200);assert.equal((await invoke('image-permits/'+id,'GET')).status,200);
  assert.equal(calls.length,5);assert.ok(calls.every(c=>c.init.headers.get('cookie')==='mangohana_engine_session=existing'&&c.init.headers.get('x-mangohana-review-scope')===scope));
  for(const value of [{...expected,owner:'forged'},{...expected,outputDirectory:'E:/other'},{...expected,executionAuthorized:true}])assert.equal((await invoke('image-preflight','POST',value)).status,400);
  assert.equal((await invoke('image-permits','POST',{permitId:id,proposalSha256:'e'.repeat(64),executionAcknowledged:false})).status,400);assert.equal((await invoke('image-permits/'+id+'/execute','POST',{generation:2})).status,400);
  assert.equal((await invoke('image-permits/'+id,'GET',undefined,{'X-Mangohana-Review-Scope':''})).status,400);assert.equal(calls.length,5);
 }finally{globalThis.fetch=original;if(previous===undefined)delete process.env.MANGOHANA_ENGINE_URL;else process.env.MANGOHANA_ENGINE_URL=previous;}
});
