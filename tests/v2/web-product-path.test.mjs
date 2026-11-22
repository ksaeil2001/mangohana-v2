import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {tsImport} from 'tsx/esm/api';
import {runWebBatch} from '../../scripts/v2/web-review-batch.mjs';
import {extractionFromOnnx} from '../../packages/ai-engine/quality/product-onnx.cjs';
import path from 'node:path';
import {once} from 'node:events';
import sharp from 'sharp';
import hostApi from '../../apps/engine/host.cjs';
import {createJobStore} from '../../apps/engine/store.mjs';
import {contentSha256} from '../../packages/evaluation/dataset-contract.mjs';
import {hash} from '../../packages/evaluation/offline/contract.mjs';
import {fixture, png} from './fixtures/owned-engine-runtime.mjs';

const origin = 'http://127.0.0.1:5173';
async function setup(t, configure, overrides = {}, allowedOrigin=origin) {
  const parent = process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR ?? 'E:/Dev/Outputs/MangohanaV2-20261111/tests';
  await mkdir(parent,{recursive:true});
  const base = await mkdtemp(path.join(parent,'web-contract-'));
  const f = await fixture(t, false, overrides, {base});
  configure?.(f);
  const host = await hostApi.createEngineHost({dataRoot:path.join(base,'jobs'),siteOrigin:allowedOrigin,port:0},{createEngine:async()=>f.engine});
  const {server}=host;t.after(()=>host.close());
  const endpoint = 'http://127.0.0.1:'+server.address().port;
  const health = await fetch(endpoint+'/health');
  const cookie = health.headers.get('set-cookie').split(';')[0]; await health.text();
  return {f,host,endpoint,cookie,base};
}
async function submit(env, count=1) {
  const form=new FormData();
  const manifest=[];
  for(let i=1;i<=count;i++){
    form.append('files', new Blob([png]), i+'.png');
    manifest.push({key:'file:'+(i-1),page_id:'p'+i,page_number:i});
  }
  form.set('project_id','test-product');form.set('idempotency_key','one-batch');
  form.set('manifest',JSON.stringify(manifest));
  const post=await fetch(env.endpoint+'/batches',{method:'POST',headers:{origin,cookie:env.cookie},body:form});
  assert.equal(post.status,202);return post.json();
}
async function completed(env,id) {
  for(let n=0;n<1000;n++){
    const r=await fetch(env.endpoint+'/batches/'+id,{headers:{cookie:env.cookie}});
    const batch=await r.json();if(!['queued','running'].includes(batch.status))return batch;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail('batch did not settle');
}
test('HTTP batch uses the product stage graph and retains a missed OCR page beside the unapproved PNG',async t=>{
  const env=await setup(t,f=>{f.state.ocrResultForPage=pageNumber=>({pageNumber,nonSpeechText:[],warnings:[],
    speechBubbles:pageNumber===2?[]:[{id:'kept',text:'テスト',bbox:{x:0,y:0,width:1,height:1}}]});});
  const batch=await completed(env,(await submit(env,2)).id);
  assert.deepEqual(batch.pages.map(p=>p.reviewState),['CANDIDATE_READY','NEEDS_REVIEW']);
  assert.equal(batch.totalPages,2);assert.equal(batch.completedPages,1);
  const [success,missing]=batch.pages;
  assert.equal(missing.job.downloadAvailable,false);
  const result=await (await fetch(env.endpoint+'/jobs/'+success.jobId,{headers:{cookie:env.cookie}})).json();
  assert.equal(result.reviewState,'CANDIDATE_READY');assert.equal(result.result.evidence.quality_status,'pending');
  assert.equal(result.result.blocks[0].id,'kept');assert.match(result.result.final_image,/^data:image\/png;base64,/);
  const root=path.join(env.base,'jobs',success.jobId);
  const report=JSON.parse(await readFile(path.join(root,'engine-report.json'),'utf8'));
  assert.deepEqual(Object.keys(report.hashes).sort(),['candidate','cleaned','mask','normalized','original']);
  assert.equal(success.job.sourceSha256,report.hashes.original);
});
test('the first automatic rendering receives the saved normalized image and removal mask for background verification', async t => {
  const renderInputs = [];
  const env = await setup(t, f => { f.state.inspectRenderInput = value => renderInputs.push(value); },
    { onnxModelsRoot: path.resolve('synthetic-models') });
  const batch = await completed(env, (await submit(env)).id);
  assert.equal(batch.pages[0].reviewState, 'CANDIDATE_READY');
  assert.equal(renderInputs.length, 1);
  const { typesettingIdentity, backgroundContext } = renderInputs[0];
  assert.ok(backgroundContext, 'the ordinary product renderer needs the source and mask to verify a flat gray balloon');
  const jobDir = path.join(env.base, 'jobs', batch.pages[0].jobId);
  assert.deepEqual(Buffer.from(backgroundContext.sourcePngBase64, 'base64'), await readFile(path.join(jobDir, 'normalized.png')));
  assert.deepEqual(Buffer.from(backgroundContext.maskPngBase64, 'base64'), await readFile(path.join(jobDir, 'removal-mask.png')));
  assert.equal(backgroundContext.sourceSha256, typesettingIdentity.sourceImageSha256);
  assert.equal(backgroundContext.maskSha256, typesettingIdentity.maskSha256);
  assert.equal(backgroundContext.cleanedSha256, typesettingIdentity.cleanedImageSha256);
  assert.deepEqual(backgroundContext.allowedBoxes, []);
  assert.equal(backgroundContext.nonWhiteFallback, true);
  assert.equal(backgroundContext.widenSharedBalloon, true);
  assert.equal(backgroundContext.manualEntries, undefined);
});
test('opt-in CPU page translation preserves the request, actual dispatch and original ID through product LaMa and rendering',async t=>{
  const env=await setup(t,null,{onnxModelsRoot:path.resolve('synthetic-models')});
  const batch=await completed(env,(await submit(env)).id),job=batch.pages[0].job;
  assert.equal(job.reviewState,'CANDIDATE_READY',JSON.stringify(job));
  assert.equal(job.usage.localModelRequests,1);
  const result=await (await fetch(env.endpoint+'/jobs/'+job.id+'/result',{headers:{cookie:env.cookie}})).json();
  assert.equal(result.evidence.translation_transport,'onnx-cpu');assert.equal(result.evidence.model_image_input,false);
  assert.deepEqual(result.blocks.map(b=>[b.id,b.source,b.text]),[['bubble-17','テスト','테스트']]);
  assert.equal(result.evidence.automatic_quality_approval,false);
  assert.deepEqual(env.f.state.onnxCalls,['ocr','translate']);assert.equal(env.f.state.statusCalls,0);assert.equal(env.f.state.modelRecords.length,0);
});
async function saveOriginalName({ endpoint, cookie }, confirmed) {
  const url = endpoint + '/projects/test-product/context';
  const read = await fetch(url, { headers: { cookie } });
  assert.equal(read.status, 200);
  const { scopeId, revision } = await read.json();
  assert.ok(scopeId);
  const update = async (expected_revision, idempotency_key, change) => {
    const response = await fetch(url, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json',
      'X-Mangohana-Context-Scope': scopeId }, body: JSON.stringify({ expected_revision, idempotency_key, changes: [change] }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const edited = await update(revision, 'save-name', { type: 'upsert_term', term: { id: 'alice', source: 'アリス', target: 'アリス' } });
  assert.equal(edited.terms[0].status, 'USER_MODIFIED');
  if (confirmed) {
    const approved = await update(edited.revision, 'confirm-name', { type: 'confirm_term', id: 'alice', expectedEntryRevision: 1 });
    assert.equal(approved.terms[0].status, 'USER_CONFIRMED');
  }
}

for (const [label,fault,source,translation,reason,message] of [
  ['an unflagged gasp-only translation','predicate-gasp','寝ちゃったよ！','헉… 헉…','PREDICATE_REDUCED_TO_GASP',/숨소리.*원문과 번역/u],
  ['an unflagged word added to punctuation','punctuation-word','、','그리고','PUNCTUATION_EXPANDED',/문장부호.*원문과 번역/u],
  ['an unflagged repeated numeric field','numeric-fields','【体力：35/100】【気力：80/100】','[체력: 35/100] '+'[기력: 80/100] '.repeat(6).trimEnd(),'REPEATED_NUMERIC_FIELDS',/수치 항목.*원문과 번역/u],
]) test(label+' is returned for review before restoration and keeps the received response', async t => {
  const env = await setup(t, f => { f.state.onnxFault = fault; }, { onnxModelsRoot: path.resolve('synthetic-models') });
  const job = (await completed(env, (await submit(env)).id)).pages[0].job;
  assert.equal(job.reviewState, 'NEEDS_REVIEW');
  assert.equal(job.downloadAvailable, false);
  assert.match(job.error, message);
  assert.deepEqual(env.f.state.onnxCalls, ['ocr', 'translate']);
  const directory = path.join(env.base, 'jobs', job.id);
  const responseBytes = await readFile(path.join(directory, 'onnx-response.json'));
  const response = JSON.parse(responseBytes);
  const review = JSON.parse(await readFile(path.join(directory, 'translation-review.json'), 'utf8'));
  assert.equal(response.data.lines[0].rawKo, translation);
  assert.equal(review.reason, 'PAGE_TRANSLATION_INVALID');
  assert.deepEqual(review.receivedCandidateIds, ['bubble-17']);
  assert.deepEqual(review.semanticReview, [{ id: 'bubble-17', sourceText: source, translatedText: translation, code: reason }]);
  assert.equal(review.partialApplied, false);
  assert.equal(review.automaticRetry, false);
  for (const file of ['cleaned.png', 'candidate.png']) await assert.rejects(readFile(path.join(directory, file)), { code: 'ENOENT' });
  const inventoryUrl = env.endpoint + '/jobs/' + job.id + '/text-inventory';
  const readInventory = async cookie => fetch(inventoryUrl, { headers: { cookie } });
  const detail = await (await readInventory(env.cookie)).json();
  const expected = [{ lineId: 'bubble-17', source, translation, reason }];
  assert.deepEqual(detail.reviewCandidates?.lines, expected);
  assert.equal(detail.reviewCandidates.jobId, job.id);
  assert.equal(detail.reviewCandidates.sourceSha256, job.sourceSha256);
  assert.equal(detail.notes, undefined);
  const {readTextInventory} = await tsImport('../../apps/sites/lib/studio-engine.ts', import.meta.url);
  const forStudio = await readTextInventory(job.id, new AbortController().signal, () => readInventory(env.cookie));
  assert.deepEqual(forStudio.reviewCandidates.lines, expected);
  const secondSession = await fetch(env.endpoint + '/health');
  const foreignCookie = secondSession.headers.get('set-cookie').split(';')[0];
  await secondSession.arrayBuffer();
  assert.equal((await readInventory(foreignCookie)).status, 404);
  response.data.lines[0].ko = '다른 원고의 문구';
  await writeFile(path.join(directory, 'onnx-response.json'), JSON.stringify(response));
  assert.equal((await readInventory(env.cookie)).status, 502);
  await writeFile(path.join(directory, 'onnx-response.json'), responseBytes);
  await env.host.close();
  const reopened = await createJobStore({ root: path.join(env.base, 'jobs'), engine: env.f.engine });
  try { assert.deepEqual((await reopened.getTextInventory(hash(env.cookie.split('=')[1]), job.id)).reviewCandidates, detail.reviewCandidates); }
  finally { await reopened.close(); }
  assert.deepEqual(env.f.state.onnxCalls, ['ocr', 'translate']);
});

for (const [label, fault, confirmed, expected] of [
  ['a confirmed name in Korean dialogue', 'name-inline', true, 'アリス의 설명'],
  ['a confirmed name on its own', 'name-only', true, 'アリス'],
  ['an unconfirmed name edit', 'name-inline', false, null],
  ['untranslated words outside a confirmed name', 'name-copy', true, null],
  ['a request changed into the speaker’s promise', 'name-promise', true, null],
]) {
  test('ONNX terminology gates ' + label, async t => {
    const env = await setup(t, f => { f.state.onnxFault = fault; }, { onnxModelsRoot: path.resolve('synthetic-models') });
    await saveOriginalName(env, confirmed);
    const job = (await completed(env, (await submit(env)).id)).pages[0].job;
    assert.deepEqual(env.f.state.onnxCalls, ['ocr', 'translate']);
    const directory = path.join(env.base, 'jobs', job.id);
    const reply = JSON.parse(await readFile(path.join(directory, 'onnx-response.json'), 'utf8'));
    assert.ok(reply.data.lines[0].flags.includes('JAPANESE_REMAINS'));
    if (expected === null) {
      assert.equal(job.reviewState, 'NEEDS_REVIEW');
      assert.equal(job.downloadAvailable, false);
      await assert.rejects(readFile(path.join(directory, 'candidate.png')), { code: 'ENOENT' });
      return;
    }
    assert.equal(job.reviewState, 'CANDIDATE_READY');
    assert.equal(job.usage.localModelRequests, 1);
    const response = await fetch(env.endpoint + '/jobs/' + job.id + '/result', { headers: { cookie: env.cookie } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.blocks.map(({ id, text }) => [id, text]), [['bubble-17', expected]]);
    assert.equal(result.evidence.automatic_quality_approval, false);
    const report = JSON.parse(await readFile(path.join(directory, 'engine-report.json'), 'utf8'));
    const compliance = report.quality.translation[0].semantic.outputCompliance;
    assert.equal(compliance.status, 'PASS');
    assert.deepEqual(compliance.exceptions.map(({ termId, status }) => [termId, status]), [['alice', 'USER_CONFIRMED_EXACT_SPAN']]);
  });
}

for (const [fault, confirmed, expected] of [
  ['name-note', true, { lineId: 'bubble-17', source: 'アリス', translation: 'アリス' }],
  ['name-mixed', true, { lineId: 'sign', source: 'アリスの説明', translation: 'アリス의 설명' }],
  ['name-mixed', false, null],
]) {
  test(`ONNX terminology gates a ${fault} page with confirmation ${confirmed}`, async t => {
    const env = await setup(t, f => { f.state.onnxFault = fault; }, { onnxModelsRoot: path.resolve('synthetic-models') });
    await saveOriginalName(env, confirmed);
    const job = (await completed(env, (await submit(env)).id)).pages[0].job;
    assert.deepEqual(env.f.state.onnxCalls, ['ocr', 'translate']);
    assert.equal(job.reviewState, fault === 'name-mixed' && confirmed ? 'CANDIDATE_READY' : 'NEEDS_REVIEW');
    const response = await fetch(env.endpoint + '/jobs/' + job.id + '/text-inventory', { headers: { cookie: env.cookie } });
    assert.equal(response.status, 200);
    const inventory = await response.json();
    if (!expected) {
      assert.equal(job.downloadAvailable, false);
      assert.equal(inventory.notes, undefined);
      return;
    }
    assert.equal(inventory.textStatus, 'ready');
    assert.equal(job.usage.localModelRequests, 1);
    assert.deepEqual(inventory.notes.lines, [expected]);
    if (fault === 'name-note') {
      for (const file of ['removal-mask.png', 'cleaned.png', 'candidate.png']) {
        await assert.rejects(readFile(path.join(env.base, 'jobs', job.id, file)), { code: 'ENOENT' });
      }
      return;
    }
    const result = await fetch(env.endpoint + '/jobs/' + job.id + '/result', { headers: { cookie: env.cookie } });
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).blocks.map(({ id, text }) => [id, text]), [['bubble-17', '테스트']]);
  });
}

test('one mixed ONNX request saves free-text notes while only speech reaches the PNG', async t => {
  const env = await setup(t, f => { f.state.onnxFault = 'mixed'; }, { onnxModelsRoot: path.resolve('synthetic-models') });
  const job = (await completed(env, (await submit(env)).id)).pages[0].job;
  assert.equal(job.reviewState, 'CANDIDATE_READY', JSON.stringify(job));
  assert.deepEqual(env.f.state.onnxCalls, ['ocr', 'translate']);
  assert.equal(job.usage.localModelRequests, 1);
  assert.equal(job.textStatus, 'ready');
  const result = await (await fetch(env.endpoint + '/jobs/' + job.id + '/result', { headers: { cookie: env.cookie } })).json();
  assert.deepEqual(result.blocks.map(block => block.id), ['bubble-17']);
  const inventory = await (await fetch(env.endpoint + '/jobs/' + job.id + '/text-inventory', { headers: { cookie: env.cookie } })).json();
  assert.deepEqual(inventory.notes.lines.map(note => note.lineId), ['sign']);
  const directory = path.join(env.base, 'jobs', job.id);
  const request = JSON.parse(await readFile(path.join(directory, 'onnx-request.json'), 'utf8'));
  assert.deepEqual(request.lines.map(line => line.id), ['bubble-17', 'sign']);
  assert.deepEqual(request.noteRegionIds, ['sign']);
  await writeFile(path.join(directory, 'text-notes.json'), '{}');
  const changed = await fetch(env.endpoint + '/jobs/' + job.id + '/text-inventory', { headers: { cookie: env.cookie } });
  assert.equal(changed.status, 502);
  await changed.arrayBuffer();
});
for(const [fault,outcome] of [['miss','NEEDS_REVIEW'],['notes','NEEDS_REVIEW'],['repetition','NEEDS_REVIEW'],['residue','NEEDS_REVIEW'],['unclean','NEEDS_REVIEW'],['restore','PARTIAL'],['margin','PARTIAL'],['layout','PARTIAL'],['unavailable','FAILED'],['lost','RESULT_UNKNOWN']]){
  test('CPU product failure '+fault+' stays visible with state '+outcome,async t=>{
    const env=await setup(t,f=>{f.state.onnxFault=fault;},{onnxModelsRoot:path.resolve('synthetic-models')});
    const id=(await submit(env)).id, batch=await completed(env,id);
    assert.equal(batch.pages.length,1);assert.equal(batch.pages[0].reviewState,outcome,JSON.stringify(batch.pages[0].job));
    assert.equal(batch.pages[0].job.downloadAvailable,false);
    if (fault === 'unclean') {
      const job = batch.pages[0].job;
      assert.match(job.error, /원문.*획.*복원/u);
      const review = JSON.parse(await readFile(path.join(env.base,'jobs',job.id,'restoration-review.json'),'utf8'));
      assert.equal(review.reason, 'SOURCE_RESIDUE_SUSPECTED');
      assert.deepEqual(review.pixels.unchangedDarkRegionIds, ['bubble-17']);
    }
    if (fault === 'miss') {
      const response = await fetch(env.endpoint + '/jobs/' + batch.pages[0].jobId + '/text-inventory', { headers: { cookie: env.cookie } });
      assert.equal(response.status, 200);
      const stored = await response.json();
      assert.equal(stored.status, 'available');
      assert.deepEqual(stored.inventory.lines.map(line => line.lineId), ['bubble-17']);
      assert.deepEqual(stored.inventory.uncoveredBubbles.map(bubble => bubble.observationId), ['hole']);
      assert.deepEqual(env.f.state.onnxCalls, ['ocr']);
    }
    if (fault === 'notes') {
      const job = batch.pages[0].job;
      assert.equal(job.textStatus, 'ready');
      assert.equal(job.usage.localModelRequests, 1);
      assert.deepEqual(env.f.state.onnxCalls, ['ocr', 'translate']);
      const response = await fetch(env.endpoint + `/jobs/${job.id}/text-inventory`, { headers: { cookie: env.cookie } });
      const detail = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(detail.notes.lines, [{ lineId: 'bubble-17', source: 'テスト', translation: '테스트' }]);
      const jobDirectory = path.join(env.base, 'jobs', job.id);
      for (const name of ['removal-mask.png', 'cleaned.png', 'candidate.png'])
        await assert.rejects(readFile(path.join(jobDirectory, name)), { code: 'ENOENT' });
    }
    const calls=[...env.f.state.onnxCalls];
    assert.equal((await submit(env)).id,id);await completed(env,id);
    assert.deepEqual(env.f.state.onnxCalls,calls);
    if(fault==='layout'){
      const review=JSON.parse(await readFile(path.join(env.base,'jobs',batch.pages[0].jobId,'typesetting-review.json'),'utf8'));
      assert.equal(review.regionId,'bubble-17');assert.equal(review.rendererCode,'MANUAL_LAYOUT_REQUIRED');
    }
    if(fault==='lost'){
      const job=batch.pages[0].job;
      assert.equal(job.recovery.manuallyRetryable,false);
      const root=path.join(env.base,'jobs'),{owner}=JSON.parse(await readFile(path.join(root,job.id,'state.json'),'utf8'));
      await env.host.close();
      const reopened=await createJobStore({root,engine:env.f.engine});t.after(()=>reopened.close());
      assert.equal((await reopened.getBatch(owner,id)).pages[0].reviewState,'RESULT_UNKNOWN');
      await assert.rejects(reopened.retry(owner,job.id,{idempotencyKey:'no-repeat'}),{code:'RETRY_UNSAFE'});
      const observed=await reopened.submit({owner,projectId:job.projectId,pageId:job.pageId,name:'1.png',sourceLanguage:'ja',bytes:png,idempotencyKey:'different-generation'});
      assert.equal(observed.id,job.id);
      assert.deepEqual(env.f.state.onnxCalls,calls);
    }
    if(fault==='restore'){
      env.f.state.onnxFault=null;
      const retry=await fetch(env.endpoint+'/jobs/'+batch.pages[0].jobId+'/retry',{method:'POST',headers:{origin,cookie:env.cookie,'content-type':'application/json'},body:JSON.stringify({idempotency_key:'user-retry'})});
      assert.equal(retry.status,202);await retry.json();
      const next=(await completed(env,id)).pages[0].job;
      assert.equal(next.reviewState,'CANDIDATE_READY');assert.equal(next.usage.localModelRequests,0);
      assert.deepEqual(env.f.state.onnxCalls,calls);assert.ok(await readFile(path.join(env.base,'jobs',next.id,'onnx-ocr.json')));
    }
  });
}
test('native local translator losing its response cannot be resubmitted as a new model generation',async t=>{
  const env=await setup(t);
  const syntheticServer=path.join(env.f.root,'synthetic-server.cjs');
  const source=await readFile(syntheticServer,'utf8');
  assert.ok(source.includes("const request=JSON.parse(body)"));
  await writeFile(syntheticServer,source.replace("const request=JSON.parse(body)", "if(req.method==='POST'){req.socket.destroy();return;}const request=JSON.parse(body)"));
  const id=(await submit(env)).id,result=await completed(env,id);
  assert.equal(result.pages[0].reviewState,'RESULT_UNKNOWN');
  assert.equal((await submit(env)).id,id);
  assert.equal(result.pages[0].job.recovery.manuallyRetryable,false);
});
test('a lost single-page web acceptance is observed as unknown',async t=>{
  const {processPage}=await tsImport('../../apps/sites/lib/studio-engine.ts',import.meta.url);
  const responses=[Response.json({status:'ok'}),new Response(png,{headers:{'Content-Type':'image/png'}}),Response.json({error:'unconfirmed'},{status:503})];
  t.mock.method(globalThis,'fetch',async()=>responses.shift());
  const page={id:'page1',name:'1.png',image:'original',blocks:[]};
  await assert.rejects(processPage(page,'/api/engine','ja','ko',new AbortController().signal,()=>{},()=>{},{projectId:'test'}),
    e=>e.outcome==='RESULT_UNKNOWN'&&e.terminal===false);
  assert.equal(responses.length,0);
});
test('valid still WebP can normalize when the Electron decoder declines the format',async t=>{
  const env=await setup(t,f=>{f.state.rejectNativeWebp=true;});
  const input=await sharp({create:{width:1,height:1,channels:3,background:'#fff'}}).webp({lossless:true}).toBuffer();
  assert.deepEqual(await env.f.engine.inspectImage(input,'image/webp'),{width:1,height:1});
  await assert.rejects(env.f.engine.inspectImage(input.subarray(0,-1),'image/webp'));
});
test('detected source coordinates reach the real renderer mask contract',()=>{
  const id='source-box',bbox={x:.125,y:.25,width:.5,height:.375};
  const region={id,bbox,kind:'text_bubble',confidence:.95};
  const extraction=extractionFromOnnx({page:'p',width:128,height:256,sourceSha256:'x',lines:[{...region,source:'猫'}],
    detections:[region],uncoveredBubbles:[]},{jobId:'p',pageNumber:1,width:128,height:256,sourceSha256:'x'}).extraction;
  assert.deepEqual(extraction.speechBubbles[0].polygon,[{x:.125,y:.25},{x:.625,y:.25},{x:.625,y:.625},{x:.125,y:.625}]);
});
test('Studio requires an explicit human action on the current candidate for approval',async()=>{
  const m=await tsImport('../../apps/sites/lib/studio-model.ts',import.meta.url);
  const project=m.emptyProject('test'),block=m.makeBlock({id:'line',text:'검수',source:'検査',size:18,x:10,y:10,w:80,h:50});
  const page={id:'p',name:'p.png',image:'data:image/png;base64,eA==',width:500,height:500,blocks:[block],status:'review',reviewed:false,
    processed:true,finalImage:'data:image/png;base64,eA==',finalImageSignature:m.blockVisualSignature([block]),engineReview:{warnings:['의미와 잔류 확인']}};
  assert.equal(m.pageReviewState(page),'CANDIDATE_READY');
  const approved=m.approvePageCandidate(page);assert.equal(m.pageReviewState(approved),'APPROVED');
  assert.equal(m.restoreProject({...project,pages:[approved]}).pages[0].reviewed,true);
  for(const changed of [{...page,engineOutcome:'PARTIAL'},{...page,jobId:'old'},{...page,blocks:[{...block,text:'수정'}]}]){
    assert.equal(m.approvePageCandidate(changed).reviewed,false);
  }
});
async function cliThroughSites(t, { loseAcceptance = false, configure, engineOptions = {} } = {}) {
  const route=await tsImport('../../apps/sites/app/api/engine/[...path]/route.ts',import.meta.url);
  const requests=[];let drop=loseAcceptance;
  const site=createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const b of req)chunks.push(b);
      const headers=new Headers();for(let i=0;i<req.rawHeaders.length;i+=2)headers.append(req.rawHeaders[i],req.rawHeaders[i+1]);
      const url=new URL(req.url,'http://'+req.headers.host);
      const segments=url.pathname.slice('/api/engine/'.length).split('/');
      requests.push(req.method+' '+segments.join('/'));
      const response=await route[req.method](new Request(url,{method:req.method,headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})}),{params:{path:segments}});
      if(req.method==='POST'&&segments.join('/')==='batches'&&drop&&response.status===202){
        drop=false;await response.arrayBuffer();res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"lost acknowledgement"}');return;
      }
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){res.writeHead(500);res.end(String(error));}
  });
  site.listen(0,'127.0.0.1');await once(site,'listening');t.after(()=>new Promise(resolve=>site.close(resolve)));
  const siteOrigin='http://127.0.0.1:'+site.address().port;
  const env=await setup(t,configure,engineOptions,siteOrigin);
  const previousUrl=process.env.MANGOHANA_ENGINE_URL;process.env.MANGOHANA_ENGINE_URL=env.endpoint;
  t.after(()=>{if(previousUrl===undefined)delete process.env.MANGOHANA_ENGINE_URL;else process.env.MANGOHANA_ENGINE_URL=previousUrl;});
  const originals=path.join(env.base,'cli-originals'),output=path.join(env.base,'cli-out');await mkdir(originals);
  return { env, requests, originals, output, siteOrigin };
}
test('CLI resolves a lost acceptance via the Sites proxy and retains the full original manifest on resume',async t=>{
  const { requests, originals, output, siteOrigin } = await cliThroughSites(t, {
    loseAcceptance: true, configure: f => { f.state.ocrResultForPage = pageNumber => ({ pageNumber, nonSpeechText: [], warnings: [],
      speechBubbles: pageNumber === 2 ? [] : [{ id: 'stable', text: 'テスト', bbox: { x: 0, y: 0, width: 1, height: 1 } }] });
    },
  });
  const rows=[1,2].map(index=>({id:'검사-'+index,work:'작품합성',index,source:index+'.png'}));
  for(const row of rows)await writeFile(path.join(originals,row.source),png,{flag:'wx'});
  const args={rows,originals,output,siteOrigin,pollIntervalMs:20};
  const first=await runWebBatch(args);assert.deepEqual(first.pages.map(p=>p.reviewState),['RESULT_UNKNOWN','RESULT_UNKNOWN']);
  const second=await runWebBatch(args);assert.deepEqual(second.pages.map(p=>p.reviewState),['CANDIDATE_READY','NEEDS_REVIEW']);
  assert.equal(second.ready,1);assert.equal(second.total,2);assert.deepEqual(await readFile(path.join(output,second.pages[0].file)),png);
  assert.deepEqual((await runWebBatch(args)).pages.map(p=>p.jobId),second.pages.map(p=>p.jobId));
  assert.equal(requests.filter(r=>r==='POST batches').length,1);assert.equal(requests.filter(r=>r==='POST batches/resolve').length,1);
  assert.ok(!requests.some(r=>r.endsWith('/retry')));assert.ok(second.pages.every(p=>p.webId&&p.sourceSha256));
});
test('CLI exports and reopens owned OCR lines and text notes through the same Sites proxy without new generation', async t => {
  const { env, originals, output, siteOrigin } = await cliThroughSites(t, {
    configure: f => { f.state.onnxFault = 'notes'; }, engineOptions: { onnxModelsRoot: path.resolve('synthetic-models') },
  });
  const rows = [{ id: 'p', work: 'synthetic', index: 1, source: 'page.png' }];
  await writeFile(path.join(originals, 'page.png'), png, { flag: 'wx' });
  const args = { rows, originals, output, siteOrigin, pollIntervalMs: 20 };
  const first = await runWebBatch(args);
  const [page] = first.pages;
  assert.equal(page.reviewState, 'NEEDS_REVIEW');
  assert.equal(page.textStatus, 'ready');
  assert.equal(first.ready, 0);
  const artifact = JSON.parse(await readFile(path.join(output, page.textInventoryFile), 'utf8'));
  assert.equal(artifact.lines[0].source, 'テスト');
  assert.equal(artifact.notes.lines[0].translation, '테스트');
  const resumed = (await runWebBatch(args)).pages[0];
  assert.equal(resumed.jobId, page.jobId);
  assert.equal(resumed.textInventoryFile, page.textInventoryFile);
  assert.deepEqual(env.f.state.onnxCalls, ['ocr', 'translate']);
});

test('first-image capture uses the original batch job even after the live web view shows a successful retry', async t => {
  const onnx = { onnxModelsRoot: path.resolve('synthetic-models') };
  const baseline = await setup(t, f => { f.state.onnxFault = 'restore'; }, onnx);
  const firstBatch = await completed(baseline, (await submit(baseline)).id);
  const { job: first } = firstBatch.pages[0];
  assert.equal(first.reviewState, 'PARTIAL');
  baseline.f.state.onnxFault = null;
  const retry = await fetch(baseline.endpoint + `/jobs/${first.id}/retry`, { method: 'POST',
    headers: { origin, cookie: baseline.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ idempotency_key: 'compare-original-before-retry' }) });
  assert.equal(retry.status, 202);
  await retry.json();
  const latest = (await completed(baseline, firstBatch.id)).pages[0].job;
  assert.equal(latest.reviewState, 'CANDIDATE_READY');
  assert.equal(latest.retryOf, first.id);
  assert.notEqual(latest.id, first.id);

  const improved = await setup(t, null, onnx);
  const otherBatch = await completed(improved, (await submit(improved)).id);
  const other = otherBatch.pages[0].job;
  assert.equal(other.reviewState, 'CANDIDATE_READY');
  assert.equal(other.sourceSha256, first.sourceSha256);
  const sourceSha256 = first.sourceSha256, cohort = { evidenceKind: 'synthetic', pages: [{
    pageId: 'test-page', workId: 'test-product', sourceSha256,
    annotationSha256: contentSha256({ sourceSha256 }), kind: 'typeset', reviewerIds: ['test-reader'],
  }] };
  const cohortSha256 = contentSha256(cohort), outputDirectory = path.join(baseline.base, 'first-image-capture');
  const stores = [];
  for (const [version, env, batch] of [['baseline', baseline, firstBatch], ['improved', improved, otherBatch]]) {
    const storeRoot = path.join(env.base, 'jobs');
    const bytes = await readFile(path.join(storeRoot, 'batches', batch.id, 'state.json'));
    stores.push({ version, storeRoot, batches: [{ batchId: batch.id, batchSha256: hash(bytes), workId: 'test-product' }] });
  }
  const calls = [baseline, improved].map(env => [...env.f.state.onnxCalls]);
  const reviewCommand = (action, input) => JSON.parse(execFileSync(process.execPath,
    ['scripts/v2/first-image-review.mjs', action], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true }));
  const capture = reviewCommand('capture', { cohort, stores, pins: { cohortSha256 }, outputDirectory });
  assert.deepEqual(capture.firstRuns.map(row => [row.version, row.status, row.pngSha256]), [
    ['baseline', 'held', null], ['improved', 'completed', other.candidateSha256],
  ]);
  assert.deepEqual(capture.observations.map(row => row.jobId), [first.id, other.id]);
  assert.ok(!JSON.stringify(capture).includes(latest.id));
  const bytes = await readFile(path.join(capture.assetsRoot, `${other.candidateSha256}.png`));
  assert.deepEqual(bytes, await readFile(path.join(improved.base, 'jobs', other.id, 'candidate.png')));
  const { firstRuns, firstRunsSha256, assetsRoot } = capture, seed = '8'.repeat(64);
  const pins = { cohortSha256, firstRunsSha256, seedSha256: contentSha256(seed) };
  const { seal, sealSha256 } = reviewCommand('prepare', { cohort, firstRuns, pins, seed });
  assert.deepEqual(seal.assignments[0].images.map(({ version }) => version), ['improved']);
  const packet = reviewCommand('packet', { seal, sealSha256, assetsRoot, reviewerId: 'test-reader',
    outputDirectory: path.join(baseline.base, 'blind-review') });
  assert.equal(packet.reviewPages, 1);
  assert.ok((await readFile(path.join(packet.outputDirectory, 'index.html'), 'utf8')).includes('첫 자동 이미지 판정표'));
  assert.deepEqual([baseline, improved].map(env => env.f.state.onnxCalls), calls);
  t.diagnostic('SYNTHETIC_FIRST_CAPTURE=' + outputDirectory);
});

test('hybrid ONNX OCR with native CUDA translation routes OCR to product_onnx and translation to llama.cpp', async t => {
  const env = await setup(t, null, { onnxModelsRoot: path.resolve('synthetic-models'), onnxTranslation: false });
  const health = await (await fetch(env.endpoint + '/health')).json();
  assert.equal(health.providerProfile, 'native');
  const batch = await completed(env, (await submit(env)).id);
  const job = batch.pages[0].job;
  assert.equal(job.reviewState, 'CANDIDATE_READY', JSON.stringify(job));
  assert.equal(job.usage.localModelRequests, 1);
  assert.deepEqual(env.f.state.onnxCalls, ['ocr']);
  assert.equal(env.f.state.statusCalls, 0);
  assert.equal(env.f.state.modelRecords.length, 1);
  const result = await (await fetch(env.endpoint + '/jobs/' + job.id + '/result', { headers: { cookie: env.cookie } })).json();
  assert.equal(result.evidence.translation_transport, undefined);
  assert.deepEqual(result.blocks.map(b => [b.id, b.source, b.text]), [['bubble-17', 'テスト', '합성 검사 응답']]);
  const report = JSON.parse(await readFile(path.join(env.base, 'jobs', job.id, 'engine-report.json'), 'utf8'));
  assert.equal(report.translations[0].engine, 'local_ai');
  assert.equal(report.translationRequests[0].httpRequests, 1);
  const notPartial = await fetch(env.endpoint + '/jobs/' + job.id + '/partial-draft', { headers: { cookie: env.cookie } });
  assert.equal(notPartial.status, 409);
});

test('PARTIAL_TYPESETTING exposes cleaned image and translated draft blocks via /jobs/:id/partial-draft', async t => {
  const env = await setup(t, f => { f.state.onnxFault = 'layout'; }, { onnxModelsRoot: path.resolve('synthetic-models') });
  const job = (await completed(env, (await submit(env)).id)).pages[0].job;
  assert.equal(job.reviewState, 'PARTIAL');
  assert.equal(job.downloadAvailable, false);
  const draftRes = await fetch(env.endpoint + '/jobs/' + job.id + '/partial-draft', { headers: { cookie: env.cookie } });
  assert.equal(draftRes.status, 200);
  const draft = await draftRes.json();
  assert.equal(draft.version, 1);
  assert.equal(draft.jobId, job.id);
  assert.match(draft.clean_image, /^data:image\/png;base64,/);
  assert.equal(draft.rejectedRegionId, 'bubble-17');
  assert.deepEqual(draft.reasonCodes, ['HARD_LAYOUT_FAILED']);
  assert.deepEqual(draft.blocks.map(b => [b.id, b.source, b.text]), [['bubble-17', 'テスト', '테스트']]);
});
