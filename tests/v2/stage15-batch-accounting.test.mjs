import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import hostApi from '../../apps/engine/host.cjs';
import {fixture} from './fixtures/owned-engine-runtime.mjs';
import {authority, calls, providers, request, sha} from './fixtures/stage15-attempt.mjs';
import {createStage15AttemptExecutor, readStage15BatchUsage} from '../../apps/engine/stage15-attempt-executor.mjs';

const origin = 'http://127.0.0.1:5173';
const pin = ({providerId,modelId,modelVersion,profileDigest}) => ({providerId,modelId,modelVersion,profileDigest});
const runtime = {head:'1'.repeat(40),codeSha256:sha('synthetic batch runtime')};
const image = r => sharp({create:{width:1,height:1,channels:4,background:{r,g:80,b:130,alpha:1}}}).png().toBuffer();
const terminalStates = new Set(['completed','failed','cancelled','result_unknown']);

async function setup(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'stage15-batch-')));
  const pages = await Promise.all(['a','b','c'].map(async (id,i) => ({id, number:i+1, bytes:await image(20+i*60)})));
  let factory, config, host, owner, clock = 0;
  const requests = [], grants = new Map(), trace = [];
  const stagePorts = providers(root).map((entry,index) => {
    function select(req) {
      const selected = options.scenario?.(req.binding.pageId,entry.providerId) ?? {};
      return {port:providers(root,selected)[index].port, selected};
    }
    async function call(operation, req, started) {
      const {port,selected} = select(req);
      trace.push({operation,provider:entry.providerId,executionId:req.executionId,pageId:req.binding.pageId,input:req.inputFingerprint,regionIds:req.regionIds});
      const raw = operation === 'dispatch' ? await port.dispatch(req,started) : await port.lookup(req.executionId,req);
      if(operation==='lookup') options.afterLookup?.();
      if (!raw) return raw;
      return {...raw,...(selected.finishReason ? {finishReason:selected.finishReason} : {}),...(raw.usageConfirmed ? {costUsd:selected.cost ?? '0.10'} : {}),
        usage:{providerMs:12, modelMs:8, queueMs:2, modelRequestMs:9, localModelRequests:0,
          tokenUsage:{promptTokens:3,completionTokens:2,totalTokens:5}}};
    }
    return {...entry,port:{synthetic:true,dispatch:(req,started)=>call('dispatch',req,started),lookup:(_id,req)=>call('lookup',req)}};
  });
  const ports = {providers:stagePorts,receiptKey:randomBytes(32),currentRuntime:()=>runtime,providerNow:options.providerNow ?? (()=>clock+=5),
    admission:options.admission ?? (()=>({available:true,maximumCostUsd:'0.10'})),
    readGrant(binding) {
      const member = pages.find(p=>p.id===binding.pageId);
      if (!member || binding.ownerScope.id!==owner || binding.projectId!=='book' || binding.sourceSha256!==sha(member.bytes)) return null;
      if (!grants.has(binding.requestId)) {
        const parent = {batchId:binding.batchId,manifestSha256:binding.batchManifestSha256,ownerScope:binding.ownerScope,
          projectId:binding.projectId,contextRevision:binding.contextRevision,maximumCostUsd:'0.60',maxFallbacks:1,...options.parent};
        const grant = {verified:true,id:'grant-'+binding.pageId,lineageId:'page-lineage-'+binding.pageId,binding:structuredClone(binding),
          stage:'TRANSLATE',transport:'SYNTHETIC',runtime,expiresAt:Date.now()+120_000,primary:pin(stagePorts[0]),alternate:pin(stagePorts[1]),
          maximumCostUsd:'0.20',maxFallbacks:1,...(options.noParent?{}:{batch:parent}),...options.grant?.(binding)};
        grants.set(binding.requestId,grant);
      }
      return grants.get(binding.requestId);
    }};
  async function open(enabled=true) { host=await hostApi.createEngineHost(config,{createEngine:factory,...(enabled?{stage15:ports}:{})}); return host.engine; }
  t.after(()=>host?.close());
  const native = await fixture(t,false,{}, {base:process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR ?? 'E:/Dev/Outputs/MangohanaV2-20261111/tests',
    compose:(supplied,createEngine)=>{config={...supplied,dataRoot:path.join(root,'jobs'),siteOrigin:origin,port:0};factory=createEngine;return open();}});
  // Both regions share one provider request; the same region names may appear on another page.
  native.state.ocrResultForPage = pageNumber => ({pageNumber,warnings:[],nonSpeechText:[],
    speechBubbles:['r1','r2'].map(id=>({id,text:'合成',bbox:{x:0,y:0,width:1,height:1}}))});
  const url = ()=>'http://127.0.0.1:'+host.server.address().port;
  const health=await fetch(url()+'/health'),cookie=health.headers.get('set-cookie').split(';')[0];
  await health.arrayBuffer();owner=sha(cookie.split('=')[1]);
  async function http(route,init={}) {
    const res=await fetch(url()+route,{...init,headers:{origin,cookie,...init.headers}});
    return {status:res.status,data:await res.json()};
  }
  async function submit(ids=['a','b'],requestKey='batch-one',overrides={}) {
    const form=new FormData(), members=ids.map(id=>pages.find(p=>p.id===id));
    for (const p of members) form.append('files',new Blob([p.bytes],{type:'image/png'}),p.id+'.png');
    form.set('project_id','book');form.set('idempotency_key',requestKey);
    form.set('manifest',JSON.stringify(members.map((p,i)=>({key:'file:'+i,page_id:p.id,page_number:p.number}))));
    for(const [k,v] of Object.entries(overrides)) form.set(k,v);
    const reply=await http('/batches',{method:'POST',body:form});requests.push(reply.status);
    return reply;
  }
  async function done(id) {
    const until=Date.now()+25_000;
    while(Date.now()<until){
      const reply=await http('/batches/'+id);assert.equal(reply.status,200);
      if(reply.data.pages.every(p=>terminalStates.has(p.status)))return reply.data;
      await delay(15);
    }
    assert.fail('batch did not settle');
  }
  async function files(id) {
    return Object.fromEntries(await Promise.all(['source.png','candidate.png','report.json','state.json'].map(async name=>
      [name,sha(await fs.readFile(path.join(config.dataRoot,id,name)))])));
  }
  t.after(()=>t.diagnostic(JSON.stringify({root,trace,requests,fixtureTranslationStarts:native.state.modelRecords.length})));
  return {root,pages,http,submit,done,files,grants,trace,native,reopen:async(enabled=true)=>{await host.close();await open(enabled);},
    post:(route,body={})=>http(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})};
}

test('normal batch keeps A when B is unknown and deduplicates its shared translation and same-attempt lookup',async t=>{
  const f=await setup(t,{scenario:id=>id==='a'?{loseReply:true}:{loseReply:true,lookup:'missing'}});
  const {status,data:batch}=await f.submit();assert.equal(status,202);
  const result=await f.done(batch.id);
  assert.deepEqual(result.pages.map(p=>p.status),['completed','result_unknown']);
  assert.equal(result.status,'partial');assert.equal(result.completedPages,1);assert.equal(result.unknownPages,1);assert.equal(result.failedPages,0);
  const [a,b]=result.pages, usage=result.usage;
  assert.deepEqual(usage.charge,{state:'UNCONFIRMED',currency:'USD',amount:null,confirmedSubtotal:'0.1',unconfirmedExecutionIds:[b.jobId+'-primary']});
  assert.equal(usage.attemptCount,2);assert.equal(usage.lookupCount,2);
  assert.equal(usage.timing.providerMs.total,null);assert.equal(usage.timing.providerMs.measuredSubtotal,12);
  assert.equal(usage.timing.modelRequestMs.measuredSubtotal,9);
  assert.equal(a.providerUsage.charge.amount,'0.1');assert.equal(a.providerUsage.timing.modelMs.total,8);
  assert.equal(usage.tokenUsage.totalTokens.total,null);assert.equal(usage.tokenUsage.totalTokens.measuredSubtotal,5);
  assert.equal(usage.timing.elapsedMs.total,10);assert.equal(usage.timing.lookupMs.total,10);
  const first=await f.http('/jobs/'+a.jobId+'/result');assert.equal(first.status,200);assert.equal(first.data.blocks.length,2);
  const before=await f.files(a.jobId);
  assert.equal((await f.http('/jobs/'+b.jobId+'/result')).status,409);
  const originalCalls=structuredClone(f.trace);
  assert.deepEqual(originalCalls.map(c=>[c.pageId,c.operation]),[['a','dispatch'],['a','lookup'],['b','dispatch'],['b','lookup']]);
  assert.deepEqual(originalCalls[0].regionIds,['r1','r2']);assert.equal(originalCalls[0].input,originalCalls[1].input);
  await f.reopen();
  assert.equal((await f.submit()).data.id,batch.id);
  assert.deepEqual((await f.done(batch.id)).usage,usage);assert.deepEqual(await f.files(a.jobId),before);
  assert.deepEqual((await f.http('/jobs/'+a.jobId+'/result')).data,first.data);
  assert.equal((await f.post('/jobs/'+b.jobId+'/retry',{idempotency_key:'retry-unknown'})).status,409);
  assert.deepEqual(f.trace,originalCalls);assert.deepEqual(calls(f.root).map(c=>c.op),['dispatch','lookup','dispatch','lookup']);
  t.diagnostic(JSON.stringify({example:'partial',usage,successfulPageSha256:before}));
});

async function heldPage(t, pageId, options={}) {
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const f=await setup(t,{...options,scenario:id=>id===pageId?{duringDispatch:async()=>{entered.resolve();await release.promise;}}:{}});
  const {status,data:b}=await f.submit();assert.equal(status,202);
  const timeout=setTimeout(()=>entered.reject(Error('synthetic provider did not start')),15_000);
  try{await entered.promise;}finally{clearTimeout(timeout);}
  return {f,b,release:release.resolve};
}

test('cancel a queued page through HTTP while A runs; B spends zero and the completed A survives replay',async t=>{
  const {f,b,release}=await heldPage(t,'a');
  try{const cancel=await f.post('/jobs/'+b.pages[1].jobId+'/cancel');assert.equal(cancel.status,202);assert.equal(cancel.data.status,'cancelled');}
  finally{release();}
  const settled=await f.done(b.id),[a,cancelled]=settled.pages;
  assert.deepEqual(settled.pages.map(p=>p.status),['completed','cancelled']);assert.equal(settled.status,'partial');
  assert.equal(settled.cancelledPages,1);assert.ok(cancelled.job.cancellation.confirmedAt);
  assert.equal(cancelled.providerUsage.attemptCount,0);assert.equal(cancelled.providerUsage.charge.amount,'0');
  assert.equal(settled.usage.charge.amount,'0.1');assert.deepEqual(f.trace.map(c=>c.pageId),['a']);
  const before=await f.files(a.jobId);await f.reopen();assert.equal((await f.submit()).data.id,b.id);
  assert.deepEqual(await f.files(a.jobId),before);assert.equal((await f.http('/jobs/'+a.jobId+'/result')).status,200);
  assert.equal(f.trace.length,1);
});

test('cancel B after provider start; a late response cannot publish B or change A',async t=>{
  const {f,b,release}=await heldPage(t,'b'),[a,busy]=b.pages;
  let before,old,settled;
  try{
    before=await f.files(a.jobId);old=await f.http('/jobs/'+a.jobId+'/result');assert.equal(old.status,200);
    assert.equal((await f.post('/jobs/'+busy.jobId+'/cancel')).status,202);
    settled=await f.done(b.id);
  }finally{release();}
  const last=settled.pages[1];
  assert.deepEqual(settled.pages.map(p=>p.status),['completed','result_unknown']);
  assert.ok(last.job.cancellation.requestedAt);assert.equal(last.job.cancellation.confirmedAt,null);
  assert.equal(last.job.recovery.type,'cleanup_unknown');
  assert.equal(last.job.stage15Attempts[0].started,true);assert.equal(settled.usage.charge.amount,null);
  assert.equal(settled.usage.charge.confirmedSubtotal,'0.1');
  assert.equal((await f.http('/jobs/'+busy.jobId+'/result')).status,409);
  assert.deepEqual(await f.files(a.jobId),before);assert.deepEqual((await f.http('/jobs/'+a.jobId+'/result')).data,old.data);
  assert.deepEqual(f.trace.map(c=>[c.operation,c.provider]),[['dispatch','primary'],['dispatch','primary']]);
});

test('independent pages using matching region names account exactly, and reused output belongs to the original batch',async t=>{
  const f=await setup(t,{scenario:id=>({cost:{a:'0.000000000001',b:'0.000000000002',c:'0'}[id]})});
  const replies=await Promise.all([f.submit(),f.submit()]);
  const b=replies.find(r=>r.status===202)?.data;assert.ok(b);
  for (const r of replies) {
    if(r.status===429){assert.equal(r.data.code,'BATCH_UPLOAD_BUSY');assert.equal((await f.submit()).data.id,b.id);}
    else {assert.equal(r.status,202);assert.equal(r.data.id,b.id);}
  }
  const original=await f.done(b.id),a=original.pages[0];assert.equal(original.status,'completed');
  assert.equal(original.usage.charge.amount,'0.000000000003');assert.equal(original.usage.timing.modelRequestMs.total,18);
  assert.equal(original.usage.tokenUsage.totalTokens.total,10);assert.equal(original.usage.timing.lookupMs.total,0);
  assert.notEqual(f.trace[0].input,f.trace[1].input);assert.deepEqual(f.trace[0].regionIds,f.trace[1].regionIds);
  const before=await f.files(a.jobId);
  assert.equal((await f.submit(['a','c'])).status,409);
  for (const route of ['/batches/'+b.id,'/jobs/'+a.jobId+'/result']) assert.equal((await f.http(route,{headers:{cookie:''}})).status,404);
  const foreign={method:'POST',headers:{cookie:'','content-type':'application/json'}};
  assert.equal((await f.http('/jobs/'+a.jobId+'/cancel',{...foreign,body:'{}'})).status,404);
  assert.equal((await f.http('/batches/resolve',{...foreign,body:JSON.stringify({project_id:'book',idempotency_key:'batch-one'})})).status,404);
  const reused=await f.submit(['a','c'],'other-batch');assert.equal(reused.status,202);
  const next=await f.done(reused.data.id);assert.equal(next.pages[0].jobId,a.jobId);assert.equal(next.pages[0].reused,true);
  assert.equal(next.pages[0].providerUsage,null);assert.equal(next.usage.attemptCount,1);assert.equal(next.usage.charge.amount,'0');
  assert.deepEqual(f.trace.map(c=>c.pageId),['a','b','c']);assert.deepEqual(await f.files(a.jobId),before);
});

test('one unknown page holds its quote; the other may run only within the remaining parent budget',async t=>{
  const f=await setup(t,{parent:{maximumCostUsd:'0.20'},scenario:id=>id==='a'?{loseReply:true,lookup:'missing'}:{}});
  const {data:b}=await f.submit(['a','b','c']),s=await f.done(b.id);
  assert.deepEqual(s.pages.map(p=>p.status),['result_unknown','completed','failed']);
  assert.equal(s.pages[2].job.errorCode,'STAGE15_BATCH_BUDGET_EXHAUSTED');
  assert.equal(s.usage.charge.amount,null);assert.equal(s.usage.charge.confirmedSubtotal,'0.1');
  assert.deepEqual(f.trace.filter(c=>c.operation==='dispatch').map(c=>c.pageId),['a','b']);
  assert.equal((await f.http('/jobs/'+s.pages[1].jobId+'/result')).status,200);
  const other=await f.submit(['a'],'different-key');assert.equal(other.status,409);assert.equal(f.trace.length,3);
});

test('only one approved fallback is shared across page grants, counted once with two confirmed primary failures',async t=>{
  const f=await setup(t,{scenario:(_id,provider)=>({flavor:provider==='primary'?'failure':'pass'})});
  const {data:b}=await f.submit(),s=await f.done(b.id);
  assert.deepEqual(s.pages.map(p=>p.status),['completed','failed']);assert.equal(s.pages[1].job.errorCode,'STAGE15_BATCH_FALLBACK_CONSUMED');
  assert.deepEqual(f.trace.map(c=>[c.pageId,c.provider]),[['a','primary'],['a','alternate'],['b','primary']]);
  assert.equal(s.usage.charge.amount,'0.3');assert.equal(s.usage.timing.modelMs.total,24);
  await f.reopen();assert.deepEqual((await f.done(b.id)).usage,s.usage);assert.equal((await f.submit()).data.id,b.id);assert.equal(f.trace.length,3);
});

test('a page cap rejects its fallback even with unused batch funds; a raised parent policy cannot replenish the budget',async t=>{
  const f=await setup(t,{scenario:(id,provider)=>id==='a'&&provider==='primary'?{flavor:'failure'}:{},
    grant:b=>b.pageId==='a'?{maximumCostUsd:'0.15'}:{batch:{batchId:b.batchId,manifestSha256:b.batchManifestSha256,
      ownerScope:b.ownerScope,projectId:b.projectId,contextRevision:b.contextRevision,maximumCostUsd:'1.00',maxFallbacks:1}}});
  const {data:b}=await f.submit(),s=await f.done(b.id);
  assert.deepEqual(s.pages.map(p=>p.job.errorCode),['STAGE15_ADMISSION_DENIED','STAGE15_BATCH_AUTHORITY_MISMATCH']);
  assert.deepEqual(f.trace.map(c=>[c.pageId,c.provider]),[['a','primary']]);assert.equal(s.usage.charge.amount,'0.1');
});

test('a confirmed charge above the admitted quote remains payable and blocks publication and subsequent over-budget work',async t=>{
  const f=await setup(t,{parent:{maximumCostUsd:'0.20'},scenario:id=>({cost:id==='a'?'0.11':'0.10'})});
  const {data:b}=await f.submit(),s=await f.done(b.id);
  assert.deepEqual(s.pages.map(p=>p.status),['failed','failed']);
  assert.deepEqual(s.pages.map(p=>p.job.errorCode),['STAGE15_BATCH_QUOTE_EXCEEDED','STAGE15_BATCH_BUDGET_EXHAUSTED']);
  assert.equal(s.usage.charge.amount,'0.11');assert.equal(s.pages[0].job.stage15Attempts[0].costUsd,'0.11');
  assert.equal(s.pages[0].job.stage15Attempts[0].status,'BLOCKED');
  assert.ok(s.pages[0].job.stage15Attempts[0].blockedReasons.includes('STAGE15_BATCH_QUOTE_EXCEEDED'));
  assert.equal((await f.http('/jobs/'+s.pages[0].jobId+'/result')).status,409);assert.deepEqual(f.trace.map(c=>c.pageId),['a']);
});

test('a revoked prior page cannot supply translation context to another batch and keeps its saved result files',async t=>{
  const f=await setup(t),{data:first}=await f.submit(['a']),s=await f.done(first.id),a=s.pages[0];
  const before=await f.files(a.jobId);f.grants.get(a.jobId).verified=false;
  assert.equal((await f.submit(['a'],'revoked-reuse')).status,409);
  const {data:second}=await f.submit(['b'],'next-page'),next=await f.done(second.id);
  assert.equal(next.status,'completed');
  const context=JSON.parse(await fs.readFile(path.join(f.root,'jobs',next.pages[0].jobId,'translation-context.json'),'utf8'));
  assert.deepEqual(context.previousPages,[]);assert.deepEqual(context.excludedPriorPages,[{jobId:a.jobId,reason:'STALE_RESULT'}]);
  assert.deepEqual(await f.files(a.jobId),before);assert.equal((await f.http('/jobs/'+a.jobId+'/result')).status,409);
  assert.deepEqual(f.trace.map(c=>c.pageId),['a','b']);
});

test('batch grant must bind the current owner, manifest, context and parent; no dispatch for rejected pages',async t=>{
  const f=await setup(t,{grant:b=>({batch:b.pageId==='c'?null:{batchId:b.batchId,manifestSha256:b.pageId==='a'?sha('wrong'):b.batchManifestSha256,
    ownerScope:b.pageId==='a'?b.ownerScope:{kind:'session',id:'other'},projectId:b.projectId,contextRevision:b.contextRevision+1,
    maximumCostUsd:'0.6',maxFallbacks:1}})});
  const {data:b}=await f.submit(['a','b','c']),s=await f.done(b.id);
  assert.ok(s.pages.every(p=>p.status==='failed'));assert.deepEqual(s.pages.map(p=>p.job.errorCode),
    ['STAGE15_BATCH_AUTHORITY_MISMATCH','STAGE15_BATCH_AUTHORITY_MISMATCH','STAGE15_ADMISSION_DENIED']);
  assert.equal(s.usage.attemptCount,0);assert.equal(f.trace.length,0);
});

test('context edit after A completes fences B and queued C; old bytes survive rejection and a new batch cannot adopt the stale A',async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const f=await setup(t,{scenario:id=>id==='b'?{duringDispatch:async()=>{entered.resolve();await release.promise;}}:{}});
  const {data:b}=await f.submit(['a','b','c']),a=b.pages[0];let before;
  const timer=setTimeout(()=>entered.reject(Error('B did not start')),15_000);
  try{
    await entered.promise;before=await f.files(a.jobId);
    const ctx=await f.http('/projects/book/context');
    const edit=await f.http('/projects/book/context',{method:'POST',headers:{'content-type':'application/json','x-mangohana-context-scope':ctx.data.scopeId},
      body:JSON.stringify({expected_revision:0,idempotency_key:'edit',changes:[{type:'upsert_term',term:{id:'term',source:'合成',target:'합성'}}]})});
    assert.equal(edit.status,200);
  }finally{clearTimeout(timer);release.resolve();}
  const s=await f.done(b.id);assert.deepEqual(s.pages.map(p=>p.status),['completed','result_unknown','failed']);
  assert.ok(s.pages[1].job.stage15Attempts[0].blockedReasons.includes('COMMIT_UNKNOWN'));
  assert.equal((await f.http('/jobs/'+a.jobId+'/result')).data.code,'CONTEXT_REEVALUATION_REQUIRED');
  assert.equal((await f.submit(['a'],'stale-reuse')).status,409);assert.deepEqual(await f.files(a.jobId),before);
  assert.deepEqual(f.trace.map(c=>c.pageId),['a','b']);assert.equal(s.usage.charge.amount,'0.2');
});

test('a missing journal receipt leaves the affected charge open and does not hide the completed sibling',async t=>{
  const f=await setup(t,{scenario:id=>id==='b'?{loseReply:true,lookup:'missing'}:{}});
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),ocr=f.native.state.ocrResultForPage;
  f.native.state.ocrResultForPage=async n=>{if(n===3){entered.resolve();await release.promise;}return ocr(n);};
  const {data:b}=await f.submit(['a','b','c']),[a,unknown]=b.pages;
  const timer=setTimeout(()=>entered.reject(Error('C did not reach OCR')),15_000);
  t.after(()=>{clearTimeout(timer);release.resolve();});await entered.promise;
  const before=await f.files(a.jobId),dir=path.join(f.root,'jobs','stage15-attempts');
  // Expose an earlier valid epoch after a simulated backup rollback in this test-owned journal.
  const epochs=(await fs.readdir(dir)).filter(n=>n.startsWith('attempt-epoch-')).sort();
  for(const name of epochs){
    const snapshot=JSON.parse(await fs.readFile(path.join(dir,name,'state.json'),'utf8'));
    if(snapshot.attempts.some(at=>at.request.input.binding.requestId===unknown.jobId)) await fs.rename(path.join(dir,name),path.join(dir,'isolated-'+name));
  }
  const reply=await f.http('/batches/'+b.id);assert.equal(reply.status,200);
  assert.deepEqual(reply.data.pages.map(p=>p.status),['completed','result_unknown','running']);
  assert.equal(reply.data.pages[0].providerUsage.charge.amount,'0.1');assert.equal(reply.data.usage.charge.amount,null);
  assert.equal(reply.data.usage.charge.confirmedSubtotal,'0.1');assert.ok(reply.data.usage.charge.unconfirmedExecutionIds.includes(unknown.jobId+'-primary'));
  assert.equal((await f.http('/jobs/'+a.jobId+'/result')).status,200);assert.deepEqual(await f.files(a.jobId),before);assert.equal(f.trace.length,3);
  release.resolve();
  const final=await f.done(b.id);assert.equal(final.pages[2].job.errorCode,'STAGE15_BATCH_EVIDENCE_MISSING');assert.equal(f.trace.length,3);
  await fs.writeFile(path.join(dir,'attempt-epoch-999999999999.json'),'{',{flag:'wx'});
  const damaged=await f.http('/batches/'+b.id);assert.equal(damaged.status,200);assert.equal(damaged.data.usage,null);
  assert.equal(damaged.data.usageErrorCode,'STAGE15_BATCH_EVIDENCE_UNAVAILABLE');
  assert.equal((await f.http('/jobs/'+a.jobId+'/result')).status,200);assert.deepEqual(await f.files(a.jobId),before);
});

test('two copies of the same confirmed charge and model measurements are counted once even when outcome stays unknown',async t=>{
  const f=await setup(t,{scenario:()=>({finishReason:'TIMEOUT'})});
  const {data:b}=await f.submit(['a']),s=await f.done(b.id);
  assert.equal(s.status,'result_unknown');assert.equal(s.unknownPages,1);assert.equal(s.usage.charge.amount,'0.1');
  assert.equal(s.usage.timing.providerMs.total,12);assert.equal(s.usage.tokenUsage.totalTokens.total,5);
  assert.equal(s.usage.timing.elapsedMs.total,5);assert.equal(s.usage.timing.lookupMs.total,5);
  assert.deepEqual(f.trace.map(c=>c.operation),['dispatch','lookup']);assert.equal(f.trace[0].executionId,f.trace[1].executionId);
});

test('a returned lookup with no valid clock reading still counts once and keeps lookup time unmeasured',async t=>{
  let clock=0,unmeasured=false;
  const f=await setup(t,{scenario:()=>({loseReply:true}),afterLookup:()=>{unmeasured=true;},
    providerNow:()=>{if(unmeasured){unmeasured=false;return NaN;}return clock+=5;}});
  const {data:b}=await f.submit(['a']),s=await f.done(b.id);
  assert.equal(s.status,'completed');assert.equal(s.usage.lookupCount,1);assert.equal(s.usage.timing.lookupMs.total,null);
  assert.equal(s.usage.charge.amount,'0.1');assert.deepEqual(f.trace.map(c=>c.operation),['dispatch','lookup']);
});

test('unconfirmed provider cleanup keeps the next page queued across restart while A and known charges remain accessible',async t=>{
  const f=await setup(t,{scenario:id=>id==='b'?{flavor:'cleanup-unknown'}:{}});
  const {data:b}=await f.submit(['a','b','c']);let settled;
  for(let i=0;i<300;i++){
    const {data}=await f.http('/batches/'+b.id);
    if(data.pages?.[1].status==='result_unknown'){settled=data;break;}
    await delay(20);
  }
  assert.ok(settled);const a=settled.pages[0],before=await f.files(a.jobId);
  assert.deepEqual(settled.pages.map(p=>p.status),['completed','result_unknown','queued']);
  assert.equal(settled.pages[1].job.recovery.type,'cleanup_unknown');assert.equal(settled.usage.charge.amount,'0.2');
  await f.reopen();assert.equal((await f.submit(['a','b','c'])).data.id,b.id);
  assert.deepEqual((await f.http('/batches/'+b.id)).data.pages.map(p=>p.status),['completed','result_unknown','queued']);
  assert.deepEqual(await f.files(a.jobId),before);assert.deepEqual(f.trace.filter(c=>c.operation==='dispatch').map(c=>c.pageId),['a','b']);
});

test('a disabled synthetic registry can read historical batch usage without admitting new work on saved pages',async t=>{
  const f=await setup(t);const {data:b}=await f.submit(['a']),s=await f.done(b.id),a=s.pages[0],before=await f.files(a.jobId);
  await f.reopen(false);
  const prior=await f.http('/batches/'+b.id);assert.equal(prior.status,200);assert.deepEqual(prior.data.usage,s.usage);
  assert.equal((await f.submit(['a'],'new-key')).data.code,'STAGE15_VERIFIER_UNAVAILABLE');
  assert.deepEqual(await f.files(a.jobId),before);assert.equal(f.trace.length,1);
});

test('competing independent executors cannot both reserve the last 0.1 USD from a shared parent epoch',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'stage15-batch-race-')),barrier=Promise.withResolvers();let arrivals=0;
  const timer=setTimeout(()=>barrier.reject(Error('reservation race barrier timed out')),5_000);t.after(()=>clearTimeout(timer));
  const policy={batchId:'parent',manifestSha256:sha('manifest'),ownerScope:{kind:'session',id:'test-owner'},
    projectId:'book',contextRevision:2,maximumCostUsd:'0.10',maxFallbacks:1};
  async function race(i,synchronize){
    const cmd=request(String(i));Object.assign(cmd.input.binding,{pageId:'page-'+i,pageNumber:i,batchId:policy.batchId,batchManifestSha256:policy.manifestSha256});
    cmd.batchBudget={policy,quoteUsd:'0.10'};
    const executor=await createStage15AttemptExecutor({root,providers:providers(root),currentAuthority:(_id,c)=>authority(c),
      onBoundary:async(name,detail)=>{if(synchronize && name==='before-commit'&&detail.transition==='reserve'){
        if(++arrivals===2)barrier.resolve();await barrier.promise;
      }}});
    return executor.execute(cmd);
  }
  const both=await Promise.allSettled([race(1,true),race(2,true)]);
  assert.equal(both.filter(r=>r.value?.status==='SUCCEEDED').length,1);assert.equal(both.find(r=>r.status==='rejected').reason.code,'STAGE15_BATCH_BUDGET_EXHAUSTED');
  await assert.rejects(race(3,false),{code:'STAGE15_BATCH_BUDGET_EXHAUSTED'});
  assert.equal(calls(root).length,1);t.diagnostic(JSON.stringify({root,race:calls(root)}));
});

test('an explicitly cancelled pre-dispatch reservation retains its identity and has zero incremental charge and provider time',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'stage15-batch-reserved-')),cmd=request('reserved');
  const b=cmd.input.binding;Object.assign(b,{batchId:'parent',batchManifestSha256:sha('manifest')});
  cmd.batchBudget={policy:{batchId:b.batchId,manifestSha256:b.batchManifestSha256,ownerScope:b.ownerScope,projectId:b.projectId,
    contextRevision:b.contextRevision,maximumCostUsd:'0.1',maxFallbacks:1},quoteUsd:'0.1'};
  const executor=await createStage15AttemptExecutor({root,providers:providers(root),currentAuthority:()=>authority(cmd),
    onBoundary:async name=>{if(name==='after-reserve')await executor.cancel(cmd.input.executionId);}});
  assert.equal((await executor.execute(cmd)).status,'CANCELLED');assert.equal(calls(root).length,0);
  const batch={id:b.batchId,owner:b.ownerScope.id,projectId:b.projectId,fingerprint:b.batchManifestSha256,stage15ContextRevision:b.contextRevision};
  const {usage}=await readStage15BatchUsage(root,batch,[{...b,jobId:b.requestId,status:'cancelled',job:{batchId:b.batchId,processingGeneration:b.generation}}]);
  assert.equal(usage.attemptCount,1);assert.equal(usage.charge.amount,'0');assert.equal(usage.timing.providerMs.total,0);
  t.diagnostic(JSON.stringify({root,preDispatch:calls(root)}));
});
