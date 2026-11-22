import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
const directory=new URL('../.sites-runtime/batch-proxy-checks/',import.meta.url);await mkdir(directory,{recursive:true});
const source=await readFile(new URL('../app/api/engine/[...path]/route.ts',import.meta.url),'utf8');
await writeFile(new URL('route.mjs',directory),stripTypeScriptTypes(source));const route=await import(new URL('route.mjs',directory));
const originalFetch=globalThis.fetch;
const form=()=>{const data=new FormData();data.append('files',new Blob([new Uint8Array(5*1024*1024)],{type:'image/png'}),'001.png');data.append('files',new Blob([new Uint8Array(5*1024*1024)],{type:'image/png'}),'002.png');for(const [name,value]of Object.entries({project_id:'book-one',source_language:'ja',target_language:'ko',idempotency_key:'a'.repeat(64),manifest:JSON.stringify([{key:'file:0',page_id:'page-one'},{key:'file:1',page_id:'page-two'}]),current_page_id:'page-one'}))data.append(name,value);return data;};
const request=(path,method='GET',body,headers={})=>new Request('https://site.test/api/engine/'+path.join('/'),{method,headers:{Origin:'https://site.test',Cookie:'mangohana_engine_session=synthetic-owner',...headers},...(body===undefined?{}:{body})});
const invoke=(path,method='GET',body,headers)=>route[method](request(path,method,body,headers),{params:Promise.resolve({path})});

test('text inventory is a read-only loopback job path and forwards the same session cookie', async () => {
  const before = process.env.MANGOHANA_ENGINE_URL;
  process.env.MANGOHANA_ENGINE_URL = 'http://127.0.0.1:45678';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, cookie: init.headers.get('Cookie') });
    return Response.json({ status: 'not_recorded' });
  };
  try {
    const path = ['jobs', 'job-one', 'text-inventory'];
    assert.equal((await invoke(path)).status, 200);
    assert.equal((await invoke(path, 'POST')).status, 405);
    assert.deepEqual(calls, [{ url: 'http://127.0.0.1:45678/jobs/job-one/text-inventory', method: 'GET', cookie: 'mangohana_engine_session=synthetic-owner' }]);
  } finally {
    globalThis.fetch = originalFetch;
    if (before === undefined) delete process.env.MANGOHANA_ENGINE_URL; else process.env.MANGOHANA_ENGINE_URL = before;
  }
});

test('completed job result endpoint is a read-only GET path and forwards the session cookie', async () => {
  const before = process.env.MANGOHANA_ENGINE_URL;
  process.env.MANGOHANA_ENGINE_URL = 'http://127.0.0.1:45678';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, cookie: init.headers.get('Cookie') });
    return Response.json({ blocks: [] });
  };
  try {
    const path = ['jobs', 'job-one', 'result'];
    assert.equal((await invoke(path)).status, 200);
    assert.equal((await invoke(path, 'POST')).status, 405);
    const partialPath = ['jobs', 'job-one', 'partial-draft'];
    assert.equal((await invoke(partialPath)).status, 200);
    assert.equal((await invoke(partialPath, 'POST')).status, 405);
    assert.deepEqual(calls, [
      { url: 'http://127.0.0.1:45678/jobs/job-one/result', method: 'GET', cookie: 'mangohana_engine_session=synthetic-owner' },
      { url: 'http://127.0.0.1:45678/jobs/job-one/partial-draft', method: 'GET', cookie: 'mangohana_engine_session=synthetic-owner' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (before === undefined) delete process.env.MANGOHANA_ENGINE_URL; else process.env.MANGOHANA_ENGINE_URL = before;
  }
});

test('the fixed loopback proxy accepts a bounded multi-image body and preserves manifest/cookie bytes',async()=>{
 const before=process.env.MANGOHANA_ENGINE_URL;process.env.MANGOHANA_ENGINE_URL='http://127.0.0.1:45678';let forwarded;
 globalThis.fetch=async(url,init)=>{forwarded={url:String(url),init};return Response.json({id:'accepted'},{status:202,headers:{'Set-Cookie':'mangohana_engine_session=synthetic-owner; HttpOnly'}});};
 try{const response=await invoke(['batches'],'POST',form());assert.equal(response.status,202);assert.equal(forwarded.url,'http://127.0.0.1:45678/batches');assert.equal(forwarded.init.headers.get('Cookie'),'mangohana_engine_session=synthetic-owner');const data=await new Request('https://synthetic.test',{method:'POST',headers:forwarded.init.headers,body:forwarded.init.body}).formData();assert.equal(data.getAll('files').length,2);assert.equal(JSON.parse(data.get('manifest'))[1].page_id,'page-two');assert.equal(response.headers.getSetCookie().length,1);}finally{globalThis.fetch=originalFetch;if(before===undefined)delete process.env.MANGOHANA_ENGINE_URL;else process.env.MANGOHANA_ENGINE_URL=before;}
});
test('batch resolver, priority and selective retry forward only their exact small JSON contracts',async()=>{
 const before=process.env.MANGOHANA_ENGINE_URL;process.env.MANGOHANA_ENGINE_URL='http://127.0.0.1:45678';const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push([String(url),JSON.parse(new TextDecoder().decode(init.body))]);return Response.json({ok:true});};
 try{
  for(const [path,body]of [[['batches','resolve'],{project_id:'book-one',idempotency_key:'key-one'}],[['projects','book-one','priority'],{page_id:'page-two'}],[['jobs','job-one','retry'],{idempotency_key:'retry-one'}]])assert.equal((await invoke(path,'POST',JSON.stringify(body),{'Content-Type':'application/json'})).status,200);
  assert.equal(calls.length,3);assert.deepEqual(calls[0][1],{project_id:'book-one',idempotency_key:'key-one'});
  const unknown=await invoke(['jobs','job-one','retry'],'POST',JSON.stringify({idempotency_key:'key',owner:'other'}),{'Content-Type':'application/json'});assert.equal(unknown.status,400);assert.equal(calls.length,3);
  assert.equal((await invoke(['projects','book-one','priority'],'POST',JSON.stringify({page_id:'page-one',key:'extra'}),{'Content-Type':'application/json'})).status,400);
 }finally{globalThis.fetch=originalFetch;if(before===undefined)delete process.env.MANGOHANA_ENGINE_URL;else process.env.MANGOHANA_ENGINE_URL=before;}
});
test('body, mapping and path limits fail before any upstream call',async()=>{
 const before=process.env.MANGOHANA_ENGINE_URL;process.env.MANGOHANA_ENGINE_URL='http://127.0.0.1:45678';let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};
 try{
  const huge=request(['batches'],'POST','x',{'Content-Type':'multipart/form-data; boundary=test','Content-Length':String(160*1024*1024+128*1024+1)});assert.equal((await route.POST(huge,{params:{path:['batches']}})).status,413);
  assert.equal((await invoke(['batches','resolve'],'POST',JSON.stringify({project_id:'book-one',idempotency_key:'x'.repeat(9000)}),{'Content-Type':'application/json'})).status,413);
  const malformed=form();malformed.set('manifest',JSON.stringify([{key:'file:0',page_id:'same'},{key:'file:1',page_id:'same'}]));assert.equal((await invoke(['batches'],'POST',malformed)).status,400);
  assert.equal((await invoke(['batches','resolve'],'GET')).status,405);assert.equal((await invoke(['projects','book-one','delete'],'POST','{}',{'Content-Type':'application/json'})).status,400);
  assert.equal((await route.POST(new Request('https://site.test/api/engine/batches',{method:'POST',headers:{Origin:'https://other.test'},body:form()}),{params:{path:['batches']}})).status,403);
  assert.equal(calls,0);
 }finally{globalThis.fetch=originalFetch;if(before===undefined)delete process.env.MANGOHANA_ENGINE_URL;else process.env.MANGOHANA_ENGINE_URL=before;}
});
