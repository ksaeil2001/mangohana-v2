import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';
const dir=new URL('../.sites-runtime/state-checks/',import.meta.url);await mkdir(dir,{recursive:true});
for(const name of ['studio-local-translation','studio-model','studio-engine']){
 const source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');
 await writeFile(new URL(name+'.mjs',dir),transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText.replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"'));
}
const m=await import(new URL('studio-model.mjs',dir));const e=await import(new URL('studio-engine.mjs',dir));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};

test('a processing error does not hide missing dialogue on the same page',()=>{
 const p={...m.sampleProject().pages[2],status:'failed',error:'OCR unavailable'};
 assert.deepEqual(m.getIssues(p).map(x=>x.kind),['error','missing']);
});
test('a pending remote job cannot be reported as a reviewed page',()=>{
 const p={...m.sampleProject().pages[3],jobId:'pending-job'};
 assert.equal(m.pageStatus(p),'paused');
});
test('validating a project backup never mutates the caller snapshot',()=>{
 const p=m.sampleProject();p.pages[0].jobId='keep-in-original';const before=JSON.stringify(p);
 const next=m.validateProject(p);assert.equal(JSON.stringify(p),before);assert.equal(next.pages[0].jobId,undefined);
});
test('project import rejects duplicate page IDs before any workspace mutation',()=>{
 const p=m.sampleProject();p.pages[1].id=p.pages[0].id;assert.throws(()=>m.validateProject(p),/ID/);
});
test('project import rejects a missing page ID rather than editing every undefined-ID page',()=>{
 const p=m.sampleProject();delete p.pages[0].id;assert.throws(()=>m.validateProject(p),/ID/);
});
test('a pre-aborted operation never uploads an image or creates a job',async()=>{
 const old=globalThis.fetch,calls=[];const controller=new AbortController();controller.abort();
 globalThis.fetch=async(url,options)=>{calls.push(String(url));return options?.method==='POST'?Response.json({id:'unwanted-job'}):new Response('image');};
 try{await assert.rejects(e.processPage(m.sampleProject().pages[0],'https://engine.test','ja','ko',controller.signal,()=>{},()=>{}));assert.deepEqual(calls,[]);}finally{globalThis.fetch=old;}
});
test('stopping during job creation preserves the server-issued ID without beginning polling',async()=>{
 const old=globalThis.fetch,entered=deferred(),response=deferred(),ids=[],polls=[];const controller=new AbortController();
 globalThis.fetch=async(url,options)=>{
  if(options?.method==='POST'){
   entered.resolve();return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});response.promise.then(resolve,reject);});
  }
  if(String(url).endsWith('/jobs/safe-id')){polls.push(url);return Response.json({status:'completed',result:{blocks:[]}});}
  return new Response('image');
 };
 try{const pending=e.processPage(m.sampleProject().pages[0],'https://engine.test','ja','ko',controller.signal,id=>ids.push(id),()=>{});await entered.promise;controller.abort();response.resolve(Response.json({id:'safe-id'}));await assert.rejects(pending);assert.deepEqual(ids,['safe-id']);assert.deepEqual(polls,[]);}finally{globalThis.fetch=old;}
});
