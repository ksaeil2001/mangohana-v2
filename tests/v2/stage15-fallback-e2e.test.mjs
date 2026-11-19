import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHmac, randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import hostApi from '../../apps/engine/host.cjs';
import {fixture, png} from './fixtures/owned-engine-runtime.mjs';
import {calls, key, providers, sha} from './fixtures/stage15-attempt.mjs';

const origin = 'http://127.0.0.1:5173';
const runtime = {head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
  codeSha256:key(['apps/engine/stage15-host-registry.mjs','packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs']
    .map(file => sha(readFileSync(file))))};
const pin = ({providerId, modelId, modelVersion, profileDigest}) => ({providerId, modelId, modelVersion, profileDigest});

async function setup(t, options = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stage15-http-')));
  const ports = [providers(base, {flavor: 'failure', ...options.primary})[0], providers(base, options.alternate)[1]];
  if (options.primaryReceipt) {
    const dispatch = ports[0].port.dispatch;
    ports[0].port.dispatch = async (...args) => ({...await dispatch(...args),...options.primaryReceipt});
  }
  const keyBytes = randomBytes(32);
  const grants = new Map();
  const control = {runtime: {...runtime}, available: true, allowAlternate: true};
  let host, hostConfig, factory, owner;
  const stage15 = {
    providers: ports, receiptKey: keyBytes, currentRuntime: () => control.runtime,
    admission: () => ({available: control.available, maximumCostUsd: options.quote ?? '0.10'}),
    readGrant(binding) {
      if (binding.ownerScope.id !== owner || binding.projectId !== 'book' || binding.pageId !== 'p1' ||
          binding.sourceSha256 !== sha(png) || binding.generation > (options.generations ?? 1) || binding.mode !== 'FULL_IMAGE') return null;
      if (!grants.has(binding.requestId)) grants.set(binding.requestId, {
        verified: true, id: 'owned-grant', lineageId: 'owned-lineage', binding: structuredClone(binding),
        stage: 'TRANSLATE', transport: 'SYNTHETIC', runtime, expiresAt: Date.now() + 120_000,
        primary: pin(ports[0]), alternate: control.allowAlternate ? pin(ports[1]) : null,
        maximumCostUsd: '0.20', maxFallbacks: 1, ...options.grant,
      });
      return grants.get(binding.requestId);
    },
  };
  const open = async (enabled = true) => host = await hostApi.createEngineHost(hostConfig, {createEngine:factory, ...(enabled ? {stage15} : {})});
  t.after(() => host?.close());
  // The existing OCR environment contract requires a private E: profile, even for its Node-only fixture.
  const runtimeBase = process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR ?? 'E:/Dev/Outputs/MangohanaV2-20261111/tests';
  const native = await fixture(t, false, {}, {base:runtimeBase, compose: async (config, createEngine) => {
    hostConfig = {...config, dataRoot: path.join(base, 'jobs'), siteOrigin: origin, port: 0};
    factory = createEngine;
    return (await open()).engine;
  }});
  native.state.ocrResultOverride = {pageNumber:1, nonSpeechText:[], warnings:[],
    speechBubbles:[{id:'line-1', text:'合成', bbox:{x:0,y:0,width:1,height:1}}]};
  native.state.qaIssues = options.qaIssues;
  const address = () => 'http://127.0.0.1:' + host.server.address().port;
  const health = await fetch(address() + '/health');
  const cookie = health.headers.get('set-cookie').split(';')[0];
  await health.arrayBuffer();
  owner = sha(cookie.split('=')[1]);
  const send = (url, init) => fetch(address() + url, {...init, headers: {origin, cookie, ...init?.headers}});
  async function postJob(id = 'one', extra = {}) {
    const body = new FormData();
    body.append('file', new Blob([png], {type: 'image/png'}), 'synthetic.png');
    for (const [k, v] of Object.entries({project_id:'book', page_id:'p1', page_number:'1',
      source_language:'ja', target_language:'ko', idempotency_key:id, ...extra})) body.append(k,v);
    return send('/jobs', {method:'POST', body});
  }
  async function submit(id,extra) {
    const reply = await postJob(id,extra);
    assert.equal(reply.status, 202);
    return reply.json();
  }
  async function terminal(id) {
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const response = await send('/jobs/' + id);
      assert.equal(response.status, 200);
      const value = await response.json();
      if (!['queued','running'].includes(value.status)) return value;
      await delay(15);
    }
    assert.fail('job did not settle');
  }
  t.after(() => {
    const trace = calls(base);
    t.diagnostic(JSON.stringify({syntheticProviderCalls:trace.map(c => [c.op,c.providerId]), nativeTranslationStarts:native.state.modelRecords.length,
      temporaryRoot:base, trace}));
  });
  return {base, control, keyBytes, grants, postJob, submit, send, terminal, native,
    restart: async enabled => { await host.close(); await open(enabled); },
    report: id => fs.readFile(path.join(base, 'jobs', id, 'report.json'), 'utf8').then(JSON.parse)};
}

test('normal HTTP job selects one approved fallback, signs checked bytes and survives duplicate submissions and reopening', async t => {
  const f = await setup(t);
  const [job, duplicate] = await Promise.all([f.submit(), f.submit()]);
  assert.equal(job.id, duplicate.id);
  const settled = await f.terminal(job.id);
  assert.deepEqual(calls(f.base).map(c => [c.op,c.providerId]), [['dispatch','primary'],['dispatch','alternate']], JSON.stringify(settled));
  assert.equal(settled.status, 'completed', JSON.stringify(settled));
  assert.equal(settled.usage.localModelRequests, 0);
  const {stage15: signed} = await f.report(job.id);
  const {signature,...receipt} = signed;
  assert.equal(signature, createHmac('sha256',f.keyBytes).update(key(receipt)).digest('hex'));
  assert.equal(receipt.attempts[0].execution.state, 'CONFIRMED_FAILURE');
  assert.equal(receipt.attempts[0].execution.costUsd, '0.10');
  assert.equal(receipt.attempts[1].provider.providerId, 'alternate');
  assert.equal(receipt.publication.checkEvidenceIds.length, 1);
  assert.equal(receipt.publication.executionId, calls(f.base)[1].id);
  t.diagnostic(JSON.stringify({verifiedPublication:signed}));
  const result = await f.send('/jobs/' + job.id + '/result');
  assert.equal(result.status, 200);
  const studio = await result.json();
  assert.equal(studio.blocks[0].text,'합성');
  assert.equal(studio.evidence.translation_transport,'SYNTHETIC');
  assert.equal(studio.evidence.translation_execution_id,receipt.publication.executionId);
  await f.restart();
  assert.equal((await f.submit()).id,job.id);
  assert.equal((await f.terminal(job.id)).status,'completed');
  assert.equal(calls(f.base).length,2);
  assert.equal(f.native.state.modelRecords.length,0);
});

const post = (f, url, body = {}, headers = {}) => f.send(url,{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json',...headers}});
const dispatches = f => calls(f.base).filter(c => c.op === 'dispatch').map(c => c.providerId);
const unavailable = async (f, id) => {
  const r = await f.send('/jobs/' + id + '/result');
  assert.equal(r.status,409);
  await r.arrayBuffer();
};

for (const lookup of ['missing','unsupported','error']) test('unknown primary with '+lookup+' lookup keeps its effect and spends no fallback', async t => {
  const f = await setup(t,{primary:{loseReply:true, lookup}});
  const job = await f.submit(), settled = await f.terminal(job.id);
  assert.equal(settled.status,'result_unknown');
  assert.equal(settled.errorCode,'RESULT_UNKNOWN');
  assert.equal(settled.stage15Attempts[0].started,true);
  assert.equal(settled.stage15Attempts[0].costUsd,null);
  assert.equal(settled.stage15Attempts[0].lookupStatus,{missing:'NOT_FOUND',unsupported:'UNSUPPORTED',error:'ERROR'}[lookup]);
  assert.deepEqual(dispatches(f),['primary']);
  const log = calls(f.base);
  assert.equal(log.length,lookup === 'unsupported' ? 1 : 2);
  assert.ok(log.every(c => c.id === log[0].id && c.input === log[0].input));
  await unavailable(f,job.id);
  await f.restart();
  assert.equal((await f.terminal(job.id)).status,'result_unknown');
  const retry = await post(f,'/jobs/'+job.id+'/retry',{idempotency_key:'again'});
  assert.equal(retry.status,409); assert.equal((await retry.json()).code,'RETRY_UNSAFE');
  assert.equal((await f.submit()).id,job.id);
  assert.deepEqual(calls(f.base),log);
});

test('a lost alternate response is looked up on the same pin and checked before publication', async t => {
  const f = await setup(t,{alternate:{loseReply:true}});
  const job = await f.submit(), settled = await f.terminal(job.id);
  assert.equal(settled.status,'completed',JSON.stringify(settled));
  const log = calls(f.base);
  assert.deepEqual(log.map(c => [c.op,c.providerId]),[['dispatch','primary'],['dispatch','alternate'],['lookup','alternate']]);
  assert.equal(log[1].id,log[2].id); assert.equal(log[1].input,log[2].input);
  const {stage15} = await f.report(job.id);
  assert.equal(stage15.attempts[1].lookupStatus,'RETURNED');
  assert.equal(stage15.publication.executionId,log[2].id);
});

for (const [name, options, expected, status] of [
  ['confirmed primary success',{primary:{flavor:'pass'}},['primary'],'completed'],
  ['confirmed primary non-start',{primary:{flavor:'not-started'}},['primary','alternate'],'completed'],
  ['unconfirmed settlement',{primary:{flavor:'unsettled'}},['primary'],'result_unknown'],
  ['unconfirmed cleanup',{primary:{flavor:'cleanup-unknown'}},['primary'],'result_unknown'],
  ['provider confirms cancellation',{primaryReceipt:{outcome:'CANCELLED',finishReason:'CANCELLED'}},['primary'],'cancelled'],
  ['provider labels stale input as failure',{primaryReceipt:{finishReason:'STALE_RESULT'}},['primary'],'failed'],
  ['provider labels cancelled input as failure',{primaryReceipt:{finishReason:'CANCELLED'}},['primary'],'failed'],
  ['primary quality block is not a provider failure',{primary:{flavor:'hard'}},['primary'],'failed'],
  ['alternate failed',{alternate:{flavor:'failure'}},['primary','alternate'],'failed'],
  ['alternate unusable QA bytes',{alternate:{flavor:'hard'}},['primary','alternate'],'failed'],
  ['vendor number QA rejects a structurally checked alternate',{qaIssues:[{type:'NUMBER_MISMATCH',severity:'error'}]},['primary','alternate'],'failed'],
  ['extra mandatory check has no proof',{grant:{requiredChecks:[{checkId:'missing-check',version:'v1'}]}},['primary','alternate'],'failed'],
  ['unknown primary later looks up a confirmed failure',{primary:{loseReply:true}},['primary'],'failed'],
  ['alternate response and lookup missing',{alternate:{loseReply:true,lookup:'missing'}},['primary','alternate'],'result_unknown'],
  ['grant only covers primary',{grant:{alternate:null}},['primary'],'failed'],
  ['remaining budget below quoted maximum',{grant:{maximumCostUsd:'0.19'}},['primary'],'failed'],
  ['observed charge exceeds the grant',{quote:'0.01',grant:{maximumCostUsd:'0.05'},primary:{flavor:'pass'}},['primary'],'failed'],
  ['full-image grant carries only typesetting scope',{grant:{stage:'TYPESET'}},[],'failed'],
  ['grant requests a real transport',{grant:{transport:'LOCAL_MODEL'}},[],'failed'],
  ['pinned alternate profile differs',{grant:{alternate:{providerId:'alternate',modelId:'alternate-model',modelVersion:'v1',profileDigest:sha('stale')}}},['primary'],'failed'],
]) test(name, async t => {
  const f = await setup(t,options), job = await f.submit('one',{owner:'browser-value'});
  const settled = await f.terminal(job.id);
  assert.equal(settled.status,status,JSON.stringify(settled)); assert.deepEqual(dispatches(f),expected);
  if (status !== 'completed') await unavailable(f,job.id);
  assert.equal(f.native.state.modelRecords.length,0);
});

test('HTTP fields cannot grant a fallback or select a provider',async t => {
  const f = await setup(t);
  for (const field of ['fallback','provider','mode']) {
    const response = await f.postJob('browser',{[field]:'approved'});
    assert.equal(response.status,422); assert.equal((await response.json()).code,'FIELD_INVALID');
  }
  assert.deepEqual(calls(f.base),[]);
});

test('host refuses to register a non-synthetic transport before any job can dispatch', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'stage15-port-'));
  const ports = providers(root); ports[1].transport = 'REMOTE';
  let engineOpens = 0;
  await assert.rejects(hostApi.createEngineHost({dataRoot:root}, {createEngine:()=>{ engineOpens++; },
    stage15:{providers:ports,receiptKey:randomBytes(32),readGrant:()=>null,currentRuntime:()=>runtime,admission:()=>null}}),
  {code:'STAGE15_HOST_CONFIG_INVALID'});
  assert.deepEqual(calls(root),[]); assert.equal(engineOpens,0);
  t.diagnostic(JSON.stringify({syntheticProviderCalls:calls(root),engineOpens}));
});

async function pausedProvider(t, slot, options = {}) {
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  const f = await setup(t,{...options,[slot]:{...options[slot],duringDispatch:async req => { entered.resolve(req); await released.promise; }}});
  const job = await f.submit();
  const controller = new AbortController();
  const timeout = delay(12_000,null,{signal:controller.signal}).then(() => {throw Error('provider was not reached');});
  let request;
  try { request = await Promise.race([entered.promise,timeout]); } finally { controller.abort(); }
  return {f,job,request,release:released.resolve};
}

test('queued HTTP cancellation dispatches zero for the cancelled job; in-flight cancellation preserves unknown settlement', async t => {
  const {f,job,release} = await pausedProvider(t,'primary');
  try {
    const queued = await f.submit('queued',{page_id:'queued-page'});
    const q = await post(f,'/jobs/'+queued.id+'/cancel'); assert.equal(q.status,202); await q.arrayBuffer();
    assert.equal((await f.terminal(queued.id)).status,'cancelled');
    const cancel = await post(f,'/jobs/'+job.id+'/cancel'); assert.equal(cancel.status,202); await cancel.arrayBuffer();
  } finally { release(); }
  const settled = await f.terminal(job.id);
  assert.equal(settled.status,'result_unknown'); assert.equal(settled.cancellation.confirmedAt,null);
  assert.equal(settled.stage15Attempts[0].started,true);
  assert.deepEqual(dispatches(f),['primary']); await unavailable(f,job.id);
});

for (const drift of ['generation','context','source bytes','HEAD','code digest','revocation','capacity']) test(drift+' change after primary start blocks fallback', async t => {
  const {f,job,release} = await pausedProvider(t,'primary');
  try {
    if (drift === 'generation') await f.submit('new-generation');
    if (drift === 'source bytes') await fs.appendFile(path.join(f.base,'jobs',job.id,'source.png'),'changed synthetic bytes');
    if (drift === 'HEAD') f.control.runtime.head = 'a'.repeat(40);
    if (drift === 'code digest') f.control.runtime.codeSha256 = sha('replaced host code');
    if (drift === 'revocation') f.grants.get(job.id).verified = false;
    if (drift === 'capacity') f.control.available = false;
    if (drift === 'context') {
      const url = '/projects/book/context', initial = await (await f.send(url)).json();
      const edit = await post(f,url,{expected_revision:0,idempotency_key:'edit',changes:[{type:'upsert_term',term:{id:'term',source:'合成',target:'합성'}}]},
        {'x-mangohana-context-scope':initial.scopeId});
      assert.equal(edit.status,200); await edit.arrayBuffer();
    }
  } finally { release(); }
  const settled = await f.terminal(job.id);
  assert.equal(settled.status,'failed',JSON.stringify(settled));
  assert.deepEqual(dispatches(f),['primary']); await unavailable(f,job.id);
});

test('late alternate success after authority changes preserves its charge and cannot publish', async t => {
  const {f,job,release} = await pausedProvider(t,'alternate');
  f.grants.get(job.id).verified = false;
  release();
  const settled = await f.terminal(job.id);
  assert.equal(settled.status,'failed'); assert.deepEqual(dispatches(f),['primary','alternate']);
  assert.equal(settled.stage15Attempts.at(-1).state,'CONFIRMED_SUCCESS');
  assert.equal(settled.stage15Attempts.at(-1).costUsd,'0.10');
  await unavailable(f,job.id);
});

test('a revoked grant and missing primary response retain both blocks', async t => {
  const {f,job,release} = await pausedProvider(t,'primary',{primary:{loseReply:true}});
  f.grants.get(job.id).verified = false;
  release();
  const settled = await f.terminal(job.id);
  assert.equal(settled.status,'result_unknown');
  const attempt = settled.stage15Attempts[0];
  assert.ok(attempt.blockedReasons.includes('AUTHORITY_MISMATCH'));
  assert.equal(attempt.started,true); assert.equal(attempt.costUsd,null);
  assert.deepEqual(calls(f.base).map(c => [c.op,c.providerId]),[['dispatch','primary']]);
  await unavailable(f,job.id);
});

test('changed source bytes also fence same-attempt lookup while the primary remains unknown', async t => {
  const {f,job,release} = await pausedProvider(t,'primary',{primary:{loseReply:true}});
  try { await fs.appendFile(path.join(f.base,'jobs',job.id,'source.png'),'changed'); } finally { release(); }
  const settled = await f.terminal(job.id);
  assert.equal(settled.status,'result_unknown');
  assert.ok(settled.stage15Attempts[0].blockedReasons.includes('STALE_RESULT'));
  assert.deepEqual(calls(f.base).map(c => [c.op,c.providerId]),[['dispatch','primary']]);
});

test('a published receipt with a stale runtime cannot be applied or cause another dispatch', async t => {
  const f = await setup(t), job = await f.submit();
  assert.equal((await f.terminal(job.id)).status,'completed');
  const old = await f.report(job.id);
  f.control.runtime.head = 'a'.repeat(40);
  const denied = await f.send('/jobs/'+job.id+'/result');
  assert.equal(denied.status,409); assert.equal((await denied.json()).code,'STALE_RESULT');
  assert.deepEqual(await f.report(job.id),old); assert.deepEqual(dispatches(f),['primary','alternate']);
});

test('a new job under the same approved lineage cannot reset its fallback slot after host restart', async t => {
  const f = await setup(t,{generations:2});
  const first = await f.submit();
  assert.equal((await f.terminal(first.id)).status,'completed');
  const oldReport = await f.report(first.id);
  await f.restart();
  const second = await f.submit('second');
  const settled = await f.terminal(second.id);
  assert.equal(settled.status,'failed'); assert.equal(settled.errorCode,'FALLBACK_CONSUMED');
  assert.deepEqual(dispatches(f),['primary','alternate','primary']);
  assert.deepEqual(await f.report(first.id),oldReport);
});

test('reopening an interrupted job snapshot retains uncertainty and never requeues the consumed attempt', async t => {
  const {f,job,release} = await pausedProvider(t,'primary',{primary:{loseReply:true,lookup:'missing'}});
  const stateFile = path.join(f.base,'jobs',job.id,'state.json');
  let running;
  try { running = await fs.readFile(stateFile); assert.equal(JSON.parse(running).status,'running'); } finally { release(); }
  assert.equal((await f.terminal(job.id)).status,'result_unknown');
  const history = calls(f.base);
  await fs.writeFile(stateFile,running);
  await f.restart();
  const restored = await f.terminal(job.id);
  assert.equal(restored.status,'result_unknown'); assert.equal(restored.recovery.type,'cleanup_unknown');
  await unavailable(f,job.id); assert.deepEqual(calls(f.base),history);
});

test('reopening without the synthetic verifier preserves a previously committed job until its verifier returns', async t => {
  const f = await setup(t), job = await f.submit();
  assert.equal((await f.terminal(job.id)).status,'completed');
  const stateFile = path.join(f.base,'jobs',job.id,'state.json'), before = await fs.readFile(stateFile);
  await f.restart(false);
  const denied = await f.send('/jobs/'+job.id+'/result');
  assert.equal(denied.status,503); assert.equal((await denied.json()).code,'STAGE15_VERIFIER_UNAVAILABLE');
  assert.deepEqual(await fs.readFile(stateFile),before);
  await f.restart();
  assert.equal((await f.terminal(job.id)).status,'completed'); assert.deepEqual(dispatches(f),['primary','alternate']);
});

test('rehashing a forged signature into a job manifest cannot publish its candidate', async t => {
  const f = await setup(t), job = await f.submit();
  assert.equal((await f.terminal(job.id)).status,'completed');
  const dir = path.join(f.base,'jobs',job.id), report = await f.report(job.id);
  report.stage15.signature = '0'.repeat(64);
  const bytes = JSON.stringify(report);
  const state = JSON.parse(await fs.readFile(path.join(dir,'state.json')));
  state.reportSha256 = state.resultReceipt.reportSha256 = sha(bytes);
  await fs.writeFile(path.join(dir,'report.json'),bytes); await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(state));
  await f.restart();
  const settled = await f.terminal(job.id);
  assert.equal(settled.status,'failed'); assert.equal(settled.errorCode,'INTEGRITY_FAILED');
  await unavailable(f,job.id); assert.deepEqual(dispatches(f),['primary','alternate']);
});
