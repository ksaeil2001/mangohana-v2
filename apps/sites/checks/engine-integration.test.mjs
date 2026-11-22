import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {createServer} from 'node:http';
import {once} from 'node:events';

const directory=new URL('../.sites-runtime/engine-integration-checks/',import.meta.url);
await mkdir(directory,{recursive:true});
for(const name of ['studio-local-translation','studio-reading','studio-model','studio-engine','studio-state']){
 const source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');
 await writeFile(new URL(`${name}.mjs`,directory),stripTypeScriptTypes(source).replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"'));
}
const model=await import(new URL('studio-model.mjs',directory));
const engine=await import(new URL('studio-engine.mjs',directory));
const state=await import(new URL('studio-state.mjs',directory));
const png='data:image/png;base64,iVBORw0KGgo=';

test('blank engine addresses use the same origin bridge while arbitrary relative addresses stay rejected',async()=>{
 const originalFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async url=>{calls.push(String(url));return Response.json({status:'ok',engineReady:false});};
 try{
  await engine.checkEngine('');assert.deepEqual(calls,['/api/engine/health']);
  assert.equal(engine.endpointURL('/api/engine'),'/api/engine');
  assert.equal(engine.endpointURL('https://engine.test/'),'https://engine.test');
  for(const address of ['/api/engine/','/api/engine?upstream=http://evil.test','//evil.test','/other'])assert.throws(()=>engine.endpointURL(address));
 }finally{globalThis.fetch=originalFetch;}
});

test('relative bridge jobs and their request generation survive project restore without changing manual values',()=>{
 const project=model.sampleProject();project.sample=false;
 Object.assign(project.pages[0],{jobId:'job-1',jobEndpoint:'/api/engine',engineGeneration:3,status:'processing'});
 const restored=model.restoreProject(project),page=restored.pages[0];
 assert.equal(page.status,'paused');assert.equal(page.jobEndpoint,'/api/engine');assert.equal(page.engineGeneration,3);
 assert.equal(engine.canResumeJob(page),true);assert.deepEqual(page.blocks,project.pages[0].blocks);
 const legacy=model.restoreProject({...project,pages:[{...project.pages[0],jobEndpoint:'http://127.0.0.1:8000'}]}).pages[0];
 assert.equal(legacy.jobEndpoint,'http://127.0.0.1:8000');assert.equal(engine.canResumeJob(legacy),false);
});

test('a lost POST response reuses one stable key while a new request generation uses a different key',async()=>{
 const originalFetch=globalThis.fetch,requests=[];let loseResponse=true;
 globalThis.fetch=async(url,options={})=>{
  if(String(url).endsWith('/health'))return Response.json({status:'ok'});
  if(options.method==='POST'){
   requests.push(Object.fromEntries([...options.body.entries()].filter(([key])=>key!=='file')));
   if(loseResponse){loseResponse=false;throw new TypeError('connection closed after acceptance');}
   return Response.json({id:'job-one'});
  }
  if(String(url).includes('/jobs/'))return Response.json({id:'job-one',projectId:'project-one',pageId:requests.at(-1).page_id,status:'completed',result:{blocks:[]}});
  return new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/png'}});
 };
 const page={...model.sampleProject().pages[0],engineGeneration:0};
 const run=target=>engine.processPage(target,'','ja','ko',new AbortController().signal,()=>{},()=>{},{projectId:'project-one'});
 try{
  await assert.rejects(run(page),/connection closed/);await run(page);await run({...page,engineGeneration:1});
  assert.match(requests[0].idempotency_key,/^[A-Za-z0-9._:-]{1,200}$/);
  assert.equal(requests[0].idempotency_key,requests[1].idempotency_key);assert.notEqual(requests[1].idempotency_key,requests[2].idempotency_key);
  assert.equal(requests[0].project_id,'project-one');assert.equal(requests[0].page_id,page.id);
  assert.equal(requests[0].source_language,'ja');assert.equal(requests[0].target_language,'ko');
  assert.equal(page.engineGeneration,0);
 }finally{globalThis.fetch=originalFetch;}
});

test('a same-origin upload waits for an established owner session before creating a job',async()=>{
 const originalFetch=globalThis.fetch;let posted=0;
 globalThis.fetch=async(url,options={})=>{
  if(String(url).endsWith('/health'))throw new TypeError('session bootstrap disconnected');
  if(options.method==='POST'){posted++;return Response.json({id:'would-duplicate'});}
  if(String(url).includes('/jobs/'))return Response.json({status:'completed',result:{blocks:[]}});
  return new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/png'}});
 };
 try{
  await assert.rejects(engine.processPage(model.sampleProject().pages[0],'/api/engine','ja','ko',new AbortController().signal,()=>{},()=>{},{projectId:'project-one'}),/session bootstrap/);
  assert.equal(posted,0);
 }finally{globalThis.fetch=originalFetch;}
});

test('completed results keep editable blocks, clean background and final render separate',async()=>{
 const originalFetch=globalThis.fetch,block=model.makeBlock({text:'수동 편집 가능한 번역',confidence:.98});
 globalThis.fetch=async()=>Response.json({id:'saved',projectId:model.sampleProject().pages[0].id,pageId:model.sampleProject().pages[0].id,status:'completed',result:{blocks:[block],clean_image:png,final_image:png}});
 try{
  const result=await engine.processPage({...model.sampleProject().pages[0],jobId:'saved'},'/api/engine','ja','ko',new AbortController().signal,()=>{},()=>{});
  assert.equal(result.finalImage,png);assert.equal(result.cleanImage,png);assert.deepEqual(result.blocks,[block]);
  assert.equal(typeof result.finalImageSignature,'string');assert.equal(result.finalImageSignature,model.blockVisualSignature(result.blocks));
  const project=model.emptyProject('saved');project.pages=[{...model.sampleProject().pages[0],...result,engineGeneration:2}];
  assert.equal(model.restoreProject(project).pages[0].finalImage,png);
 }finally{globalThis.fetch=originalFetch;}
});

test('invalid final image responses fail without replacing previous manual text or background',async()=>{
 const originalFetch=globalThis.fetch,previous={...model.sampleProject().pages[0],cleanImage:png,finalImage:png};
 const started=state.transitionPage(previous,{type:'start',requestId:'request-one'});
 globalThis.fetch=async()=>Response.json({id:'saved',projectId:previous.id,pageId:previous.id,status:'completed',result:{blocks:[],final_image:'https://untrusted.test/result.png'}});
 try{
  await assert.rejects(engine.processPage({...previous,jobId:'saved'},'/api/engine','ja','ko',new AbortController().signal,()=>{},()=>{}),/이미지/);
  const failed=state.transitionPage(started,{type:'failure',requestId:'request-one',error:'invalid image',terminal:false});
  assert.deepEqual(failed.blocks,previous.blocks);assert.equal(failed.cleanImage,png);assert.equal(failed.finalImage,png);
  assert.strictEqual(state.transitionPage(started,{type:'result',requestId:'stale',result:{blocks:[]}}),started);
 }finally{globalThis.fetch=originalFetch;}
});

let proxy;
async function loadProxy(){
 if(!proxy){
  const source=await readFile(new URL('../app/api/engine/[...path]/route.ts',import.meta.url),'utf8');
  const target=new URL('engine-route.mjs',directory);await writeFile(target,stripTypeScriptTypes(source));proxy=await import(target);
 }
 return proxy;
}
async function withUpstream(handler,run){
 const old=process.env.MANGOHANA_ENGINE_URL;
 const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
 process.env.MANGOHANA_ENGINE_URL=`http://127.0.0.1:${server.address().port}`;
 try{return await run(await loadProxy());}finally{
  if(old===undefined)delete process.env.MANGOHANA_ENGINE_URL;else process.env.MANGOHANA_ENGINE_URL=old;
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 }
}
const studioOrigin='http://127.0.0.1:5173';
function request(path,options={}){
 return new Request(studioOrigin+'/api/engine/'+path,options);
}
function context(...path){return {params:Promise.resolve({path})};}
function form(fileBytes=1){
 const body=new FormData();body.append('file',new Blob([new Uint8Array(fileBytes)],{type:'image/png'}),'page.png');
 body.append('source_language','ja');body.append('target_language','ko');body.append('project_id','project-one');body.append('page_id','page-one');body.append('idempotency_key','stable-key');return body;
}

test('the local proxy forwards the engine session cookie and returns each Set-Cookie header',async()=>{
 const received=[];
 await withUpstream(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  received.push({url:req.url,method:req.method,cookie:req.headers.cookie,origin:req.headers.origin,authorization:req.headers.authorization,body:Buffer.concat(chunks),type:req.headers['content-type']});
  res.setHeader('Content-Type','application/json');res.setHeader('Set-Cookie',['mangohana_session=fixture; HttpOnly; SameSite=Strict; Path=/','fixture_other=value; HttpOnly; Path=/']);
  res.end(JSON.stringify(req.method==='POST'?{id:'job-one'}:{status:'ok'}));
 },async route=>{
  const health=await route.GET(request('health',{headers:{'sec-fetch-site':'same-origin'}}),context('health'));
  assert.equal(health.status,200);assert.equal(health.headers.getSetCookie().length,2);
  const response=await route.POST(request('jobs',{method:'POST',headers:{Origin:studioOrigin,Cookie:'mangohana_session=fixture',Authorization:'must-not-pass'},body:form()}),context('jobs'));
  assert.equal(response.status,200);assert.equal((await response.json()).id,'job-one');
  assert.equal(received[1].cookie,'mangohana_session=fixture');assert.equal(received[1].authorization,undefined);
  assert.equal(received[1].origin,studioOrigin);
  const posted=await new Request('http://fixture.test',{method:'POST',headers:{'content-type':received[1].type},body:received[1].body}).formData();
  assert.equal(posted.get('idempotency_key'),'stable-key');assert.equal(posted.get('file').size,1);
  const job=await route.GET(request('jobs/job-one',{headers:{Cookie:'mangohana_session=fixture'}}),context('jobs','job-one'));
  assert.equal(job.status,200);assert.equal(received[2].url,'/jobs/job-one');assert.equal(received[2].cookie,'mangohana_session=fixture');
 });
});

test('cross-origin, unsupported paths and unsafe upstreams never reach the engine',async()=>{
 let requests=0;
 await withUpstream((_req,res)=>{requests++;res.end('{}');},async route=>{
  for(const origin of ['http://evil.test','http://127.0.0.1:5174','null']){
   assert.equal((await route.POST(request('jobs',{method:'POST',headers:{Origin:origin},body:form()}),context('jobs'))).status,403);
   assert.equal((await route.GET(request('health',{headers:{Origin:origin}}),context('health'))).status,403);
  }
  assert.equal((await route.POST(request('jobs',{method:'POST',body:form()}),context('jobs'))).status,403);
  assert.equal((await route.GET(request('health',{headers:{'sec-fetch-site':'cross-site'}}),context('health'))).status,403);
  for(const [path,parts] of [['jobs?url=http://evil.test',['jobs']],['jobs/bad%2Fid',['jobs','bad/id']],['jobs/job-one/unknown',['jobs','job-one','unknown']],['secrets',['secrets']]]){
   assert.equal((await route.GET(request(path),context(...parts))).status,400);
  }
  assert.equal((await route.POST(request('health',{method:'POST',headers:{Origin:studioOrigin},body:form()}),context('health'))).status,405);
  const configured=process.env.MANGOHANA_ENGINE_URL;
  for(const address of ['http://localhost:8000','https://127.0.0.1:8000','http://127.0.0.1:8000/path','http://127.0.0.1:8000?url=http://evil.test','http://127.0.0.1.evil.test:8000']){
   process.env.MANGOHANA_ENGINE_URL=address;assert.equal((await route.GET(request('health'),context('health'))).status,503);
  }
  process.env.MANGOHANA_ENGINE_URL=configured;assert.equal(requests,0);
 });
});

test('the proxy enforces the image limit and streaming multipart limit before forwarding',async()=>{
 let requests=0;
 await withUpstream(async(req,res)=>{requests++;for await(const chunk of req){void chunk;}res.end('{"id":"accepted"}');},async route=>{
  const oversized=await route.POST(request('jobs',{method:'POST',headers:{Origin:studioOrigin},body:form(8*1024*1024+1)}),context('jobs'));
  assert.equal(oversized.status,413);
  const bytes=new Uint8Array(8*1024*1024+65536+1);
  const stream=new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}});
  const streamed=await route.POST(request('jobs',{method:'POST',headers:{Origin:studioOrigin,'Content-Type':'multipart/form-data; boundary=fixture'},body:stream,duplex:'half'}),context('jobs'));
  assert.equal(streamed.status,413);assert.equal(requests,0);
  const accepted=await route.POST(request('jobs',{method:'POST',headers:{Origin:studioOrigin},body:form(8*1024*1024)}),context('jobs'));
  assert.equal(accepted.status,200);assert.equal(requests,1);
 });
});

test('upstream redirects do not expand the proxy path whitelist',async()=>{
 const visited=[];
 await withUpstream((req,res)=>{visited.push(req.url);res.writeHead(302,{Location:'/private'});res.end();},async route=>{
  const response=await route.GET(request('health'),context('health'));
  assert.equal(response.status,502);assert.equal(response.headers.has('Location'),false);assert.deepEqual(visited,['/health']);
 });
});
