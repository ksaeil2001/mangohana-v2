import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tsImport} from 'tsx/esm/api';
import {runWebBatch} from '../../scripts/v2/web-review-batch.mjs';
import {extractionFromOnnx} from '../../packages/ai-engine/quality/product-onnx.cjs';
import path from 'node:path';
import {once} from 'node:events';
import sharp from 'sharp';
import hostApi from '../../apps/engine/host.cjs';
import {createJobStore} from '../../apps/engine/store.mjs';
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
for(const [fault,outcome] of [['miss','NEEDS_REVIEW'],['repetition','NEEDS_REVIEW'],['residue','NEEDS_REVIEW'],['unclean','NEEDS_REVIEW'],['restore','PARTIAL'],['margin','PARTIAL'],['layout','PARTIAL'],['unavailable','FAILED'],['lost','RESULT_UNKNOWN']]){
  test('CPU product failure '+fault+' stays visible with state '+outcome,async t=>{
    const env=await setup(t,f=>{f.state.onnxFault=fault;},{onnxModelsRoot:path.resolve('synthetic-models')});
    const id=(await submit(env)).id, batch=await completed(env,id);
    assert.equal(batch.pages.length,1);assert.equal(batch.pages[0].reviewState,outcome,JSON.stringify(batch.pages[0].job));
    assert.equal(batch.pages[0].job.downloadAvailable,false);
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
test('CLI resolves a lost acceptance via the Sites proxy and retains the full original manifest on resume',async t=>{
  const route=await tsImport('../../apps/sites/app/api/engine/[...path]/route.ts',import.meta.url);
  const requests=[];let drop=true;
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
  const env=await setup(t,f=>{f.state.ocrResultForPage=pageNumber=>({pageNumber,nonSpeechText:[],warnings:[],speechBubbles:
    pageNumber===2?[]:[{id:'stable',text:'テスト',bbox:{x:0,y:0,width:1,height:1}}]});}, {}, siteOrigin);
  const previousUrl=process.env.MANGOHANA_ENGINE_URL;process.env.MANGOHANA_ENGINE_URL=env.endpoint;
  t.after(()=>{if(previousUrl===undefined)delete process.env.MANGOHANA_ENGINE_URL;else process.env.MANGOHANA_ENGINE_URL=previousUrl;});
  const originals=path.join(env.base,'cli-originals'),output=path.join(env.base,'cli-out');await mkdir(originals);
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
