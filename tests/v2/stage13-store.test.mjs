// Deterministic synthetic providers, real isolated disk and loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createJobStore} from '../../apps/engine/store.mjs';
import {createContextStore} from '../../apps/engine/context.mjs';
import {createEngineServer} from '../../apps/engine/server.mjs';
import {once} from 'node:events';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const sha=x=>createHash('sha256').update(x).digest('hex');
const alice=sha('stage13-alice'),bob=sha('stage13-bob');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLeUAAAAASUVORK5CYII=','base64');
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
async function until(read,check=v=>['completed','failed','cancelled'].includes(v.status)){
 const deadline=Date.now()+5000;while(Date.now()<deadline){const v=await read();if(check(v))return v;await new Promise(r=>setTimeout(r,5));}assert.fail('deterministic fixture did not settle');
}
async function fixture(t,options={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'stage13-store-')),started=gate(),closing=gate(),runs=[];
 const contextStore=options.context?await createContextStore({root:path.join(root,'contexts')}):undefined;
 const engine={health:()=>({ready:true}),inspectImage:()=>({width:1,height:1}),async close(){closing.resolve();await options.close?.();},async run(input){
  runs.push(input);started.resolve();await Promise.race([Promise.resolve().then(()=>options.run?.(input,runs.length)),closing.promise]);
  const source=await fs.readFile(input.inputPath);
  for(const name of ['normalized.png','cleaned.png','removal-mask.png'])await fs.writeFile(path.join(input.outputDirectory,name),source,{flag:'wx'});
  const report={version:1,jobId:input.jobId,evidenceKind:'LOCAL_ENGINE_CANDIDATE',originalPreserved:true,userApproved:false,sourceLanguage:'ja',image:{width:1,height:1,originalMime:'image/png'},hashes:Object.fromEntries(['original','normalized','cleaned','candidate','mask'].map(k=>[k,sha(source)])),warnings:[],ocr:{speechBubbles:[{id:'r'}]},lines:[{id:'r',order:1,sourceText:'合成',aiTranslation:'합성'}],translations:[{id:'r',engine:'local_ai',usedExactTm:false,modelHttpRequests:1,durationMs:4,qaReport:{issues:[]}}],typesetting:{layoutReport:[{id:'r',bbox:{x:0,y:0,width:1,height:1},fontSizePx:14,fontFamily:'Synthetic',productionFontLoaded:true,glyphFontLoaded:true}]}};
  if(input.translationContext)report.translationContext={snapshotSha256:input.translationContext.snapshotSha256,glossaryRevision:input.translationContext.glossaryRevision,consumed:false};
  await options.report?.(report,input);return {pngBytes:source,report};
 }};
 let store=await createJobStore({root:path.join(root,'jobs'),engine,contextStore});
 t.after(async()=>{await store.close().catch(()=>{});await contextStore?.close();});
 const submit=(overrides={})=>store.submit({owner:alice,idempotencyKey:'first',bytes:png,name:'synthetic.png',projectId:'work',pageId:'page',...overrides});
 return {root:path.join(root,'jobs'),engine,contextStore,started,runs,submit,get store(){return store;},async restart(){await store.close();store=await createJobStore({root:path.join(root,'jobs'),engine,contextStore});}};
}
for(const code of ['OCR_REVIEW_REQUIRED','TRANSLATION_TIMEOUT','TEXT_MASK_INVALID','TYPESET_RESULT'])test('preserves '+code+' and never automatically retries',async t=>{
 const f=await fixture(t,{run(){throw Object.assign(Error('synthetic untrusted secret text'),{code});}}),job=await f.submit(),ended=await until(()=>f.store.get(alice,job.id));
 assert.equal(ended.errorCode,code);assert.equal(ended.recovery.automaticRetry,false);assert.equal(f.runs.length,1);assert.ok(!ended.error.includes('secret'));
 if(code==='OCR_REVIEW_REQUIRED')assert.equal(ended.stage,'needs_review');
});
test('same job duplicate and concurrent same-page requests cannot serve an older generation',async t=>{
 const wait=gate(),f=await fixture(t,{run:(_i,n)=>n===1?wait.promise:undefined});t.after(wait.resolve);
 const [a,b]=await Promise.all([f.submit(),f.submit()]);assert.equal(a.id,b.id);await f.started.promise;
 const current=await f.submit({idempotencyKey:'new-page-generation'});wait.resolve();await until(()=>f.store.get(alice,current.id));
 await assert.rejects(f.store.getResult(alice,a.id),{code:'STALE_RESULT'});assert.equal(f.runs.length,2);
 assert.ok((await f.store.getResult(alice,current.id)).blocks.length);await assert.rejects(f.store.getResult(bob,current.id),{code:'JOB_NOT_FOUND'});
 await assert.rejects(f.store.getResult(alice,current.id,{expectedGeneration:0}),{code:'STALE_RESULT'});
});
test('server glossary changes reject a late or previously completed candidate without touching its bytes',async t=>{
 const wait=gate(),f=await fixture(t,{context:true,run:()=>wait.promise});t.after(wait.resolve);
 const job=await f.submit();await f.started.promise;
 await f.contextStore.apply(alice,'work',{expectedRevision:0,idempotencyKey:'edit-term',changes:[{type:'upsert_term',term:{id:'name',source:'合成',target:'사용자 표기'}}]});
 wait.resolve();await until(()=>f.store.get(alice,job.id));const file=path.join(f.root,job.id,'candidate.png'),before=await fs.readFile(file);
 await assert.rejects(f.store.getResult(alice,job.id),{code:'CONTEXT_REEVALUATION_REQUIRED'});assert.deepEqual(await fs.readFile(file),before);assert.equal(f.runs.length,1);
});
test('bounded explicit retry preserves identities and rejects a fourth attempt',async t=>{
 const f=await fixture(t,{run(){throw Object.assign(Error('synthetic timeout'),{code:'TRANSLATION_TIMEOUT'});}}),first=await f.submit();let current=first;
 for(let i=1;i<=3;i++){
  await until(()=>f.store.get(alice,current.id));if(i===3)break;
  const key='retry-'+i,[a,b]=await Promise.all([f.store.retry(alice,current.id,{idempotencyKey:key}),f.store.retry(alice,current.id,{idempotencyKey:key})]);assert.equal(a.id,b.id);current=a;
 }
 await assert.rejects(f.store.retry(alice,current.id,{idempotencyKey:'over-budget'}),{code:'RETRY_BUDGET_EXHAUSTED'});assert.equal(f.runs.length,3);
});
test('cancel request stays pending until the late provider settles; duplicate cancel and late completion are harmless',async t=>{
 const wait=gate(),f=await fixture(t,{run:()=>wait.promise});t.after(wait.resolve);const job=await f.submit();await f.started.promise;
 const pending=await f.store.cancel(alice,job.id);assert.equal(pending.stage,'cancel_requested');assert.equal(pending.status,'running');
 assert.equal((await f.store.cancel(alice,job.id)).stage,'cancel_requested');wait.resolve();const ended=await until(()=>f.store.get(alice,job.id));assert.equal(ended.status,'cancelled');
 await assert.rejects(f.store.getResult(alice,job.id),{code:'RESULT_NOT_READY'});assert.equal((await f.store.cancel(alice,job.id)).status,'cancelled');
 await assert.rejects(f.store.cancel(bob,job.id),{code:'JOB_NOT_FOUND'});await f.restart();assert.equal((await f.store.get(alice,job.id)).status,'cancelled');assert.equal(f.runs.length,1);
});
test('queued cancellation does not abort a different owner job and its explicit new request runs after cleanup',async t=>{
 const wait=gate(),f=await fixture(t,{run:(_i,n)=>n===1?wait.promise:undefined});t.after(wait.resolve);const active=await f.submit();await f.started.promise;
 const queued=await f.submit({idempotencyKey:'queued',owner:bob});assert.equal((await f.store.cancel(bob,queued.id)).status,'cancelled');assert.equal(f.runs[0].signal.aborted,false);
 wait.resolve();await until(()=>f.store.get(alice,active.id));const next=await f.submit({idempotencyKey:'new',owner:bob});assert.equal((await until(()=>f.store.get(bob,next.id))).status,'completed');assert.equal(f.runs.length,2);
});
test('unconfirmed cleanup blocks new work and never claims cancellation completed',async t=>{
 const wait=gate(),f=await fixture(t,{run:async()=>{await wait.promise;throw Object.assign(Error('release unknown'),{code:'CLEANUP_FAILED'});}});t.after(wait.resolve);const job=await f.submit();await f.started.promise;
 await f.store.cancel(alice,job.id);wait.resolve();const ended=await until(()=>f.store.get(alice,job.id));assert.equal(ended.errorCode,'CLEANUP_FAILED');assert.equal(ended.stage,'cleanup_unconfirmed');assert.equal((await f.store.health()).ready,false);
 await assert.rejects(f.submit({idempotencyKey:'blocked'}),{code:'RUNTIME_LEASE_BLOCKED'});assert.equal(f.runs.length,1);
});
test('failed reprocessing preserves an earlier good PNG and repeated reads do not duplicate the commit receipt',async t=>{
 const f=await fixture(t,{run:(_i,n)=>{if(n===2)throw Object.assign(Error('render failed'),{code:'TYPESET_RESULT'});}}),good=await f.submit();await until(()=>f.store.get(alice,good.id));
 const before=await fs.readFile(path.join(f.root,good.id,'candidate.png')),stateFile=path.join(f.root,good.id,'state.json'),state=JSON.parse(await fs.readFile(stateFile,'utf8'));
 assert.equal(state.resultReceipt.candidateSha256,sha(before));assert.equal(state.resultReceipt.reportSha256,state.reportSha256);
 const failed=await f.submit({idempotencyKey:'reprocess'});await until(()=>f.store.get(alice,failed.id));assert.deepEqual(await fs.readFile(path.join(f.root,good.id,'candidate.png')),before);
 assert.deepEqual(JSON.parse(await fs.readFile(stateFile,'utf8')).resultReceipt,state.resultReceipt);assert.equal((await f.store.get(alice,good.id)).status,'completed');
});
test('a contradictory completion receipt is never restored as success',async t=>{
 const f=await fixture(t),job=await f.submit();await until(()=>f.store.get(alice,job.id));await f.store.close();
 const file=path.join(f.root,job.id,'state.json'),state=JSON.parse(await fs.readFile(file,'utf8'));state.resultReceipt={...state.resultReceipt,reportSha256:'0'.repeat(64)};await fs.writeFile(file,JSON.stringify(state));
 await f.restart();assert.equal((await f.store.get(alice,job.id)).status,'failed');assert.equal(f.runs.length,1);
});
test('a state publication write failure cannot expose completed memory or replace an older good candidate',async t=>{
 const wait=gate(),f=await fixture(t,{run:(_i,n)=>n===2?wait.promise:undefined});t.after(wait.resolve);const good=await f.submit();await until(()=>f.store.get(alice,good.id));const before=await fs.readFile(path.join(f.root,good.id,'candidate.png'));
 const job=await f.submit({idempotencyKey:'write-fault'});await until(()=>f.store.get(alice,job.id),v=>v.status==='running');
 const file=path.join(f.root,job.id,'state.json');await fs.rename(file,file+'.before-fault');await fs.mkdir(file);wait.resolve();
 const failed=await until(()=>f.store.get(alice,job.id));assert.equal(failed.status,'failed');await assert.rejects(f.store.getResult(alice,job.id));assert.deepEqual(await fs.readFile(path.join(f.root,good.id,'candidate.png')),before);
 await fs.rmdir(file);await fs.rename(file+'.before-fault',file);
});
test('loopback cancel endpoint enforces owner and origin and keeps the late result cancelled',async t=>{
 const wait=gate(),f=await fixture(t,{run:()=>wait.promise});t.after(wait.resolve);const origin='http://127.0.0.1:5173',server=createEngineServer({store:f.store,allowedOrigin:origin});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port,health=await fetch(base+'/health'),cookie=health.headers.get('set-cookie').split(';')[0];
 const form=new FormData();form.append('file',new Blob([png],{type:'image/png'}),'synthetic.png');for(const [k,v]of Object.entries({project_id:'work',page_id:'page',source_language:'ja',target_language:'ko',idempotency_key:'http-cancel'}))form.append(k,v);
 const created=await fetch(base+'/jobs',{method:'POST',headers:{origin,cookie},body:form});assert.equal(created.status,202);const job=await created.json();await f.started.promise;
 const post=(headers={})=>fetch(base+'/jobs/'+job.id+'/cancel',{method:'POST',headers:{origin,cookie,'content-type':'application/json',...headers},body:'{}'});
 assert.equal((await post({cookie:''})).status,404);assert.equal((await post({origin:'http://untrusted.invalid'})).status,403);
 const requested=await post();assert.equal(requested.status,202);assert.equal((await requested.json()).stage,'cancel_requested');wait.resolve();
 const terminal=await until(async()=>{const response=await fetch(base+'/jobs/'+job.id,{headers:{cookie}});assert.equal(response.status,200);return response.json();});assert.equal(terminal.status,'cancelled');
});
test('an abruptly exited OS worker recovers as interrupted with no inference replay and preserves the previous good PNG',async t=>{
 const f=await fixture(t),good=await f.submit();await until(()=>f.store.get(alice,good.id));const file=path.join(f.root,good.id,'candidate.png'),before=await fs.readFile(file);await f.store.close();
 await assert.rejects(promisify(execFile)(process.execPath,['tests/v2/stage13-crash-child.mjs',f.root,alice,png.toString('base64')],{windowsHide:true}),e=>e.code===23);
 const crash=JSON.parse(await fs.readFile(path.join(f.root,'stage13-abrupt-exit.json'),'utf8'));await f.restart();const job=await f.store.get(alice,crash.jobId);assert.equal(job.status,'failed');assert.equal(job.errorCode,'INTERRUPTED');assert.equal(f.runs.length,1);assert.deepEqual(await fs.readFile(file),before);
});
