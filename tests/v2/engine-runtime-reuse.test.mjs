// Synthetic Electron/OCR/model providers. No model or user image is loaded by this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import childProcess from 'node:child_process';
import {createJobStore} from '../../apps/engine/store.mjs';
import {fixture,png} from './fixtures/owned-engine-runtime.mjs';

test('default false keeps per-job cold lifecycle, authenticated model identity and original quality guards', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false);await f.run(1);await f.run(2);assert.equal(f.state.statusCalls,2);assert.equal(f.state.modelRecords.length,2);assert.ok(f.state.modelRecords.every(record=>record.closed));assert.equal(f.state.ocrPids.length,2);const calls=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse),posts=calls.filter(call=>call.path==='/v1/chat/completions');assert.equal(posts.length,2);assert.ok(posts.every(call=>call.authorized&&!Object.hasOwn(call.body,'cache_prompt')));assert.ok(calls.some(call=>call.path==='/v1/models'&&!call.authorized));await f.engine.close();assert.equal(f.engine.health().ready,false);
});

test('Stage13 render-only retry reuses verified OCR translation and cleaned checkpoints without another model request',{timeout:30_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false),checkpoints={};f.state.omitTypesettingIdentity=true;
 const extra={pageId:'same-page',pageNumber:1,translationContext:undefined,onCheckpoint:receipt=>{checkpoints[receipt.stage]=receipt;}};
 await assert.rejects(f.run(1,extra),{code:'STALE_RESULT'});
 assert.ok(checkpoints.cleaned,'the validated cleaned result must be recoverable before rendering');
 f.state.omitTypesettingIdentity=false;
 const result=await f.run(2,{...extra,resumeFrom:{directory:path.join(f.root,'page-1'),jobId:'synthetic-1',checkpoints}});
 assert.equal(f.state.statusCalls,1);assert.equal(f.state.modelRecords.length,1);
 assert.deepEqual(result.report.recovery.reusedStages,['ocr','translation','cleaned']);
 assert.equal(result.report.jobId,'synthetic-2');assert.equal(result.report.typesetting.inputIdentity.jobId,'synthetic-2');
 const posts=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse).filter(x=>x.path==='/v1/chat/completions');assert.equal(posts.length,1);
});

test('Stage13 owned store persists checkpoint receipts and commits a render retry once after reopening',{timeout:30_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false),root=path.join(f.root,'owned-jobs'),owner='a'.repeat(64);let store=await createJobStore({root,engine:f.engine});t.after(()=>store.close());
 const until=async id=>{const deadline=Date.now()+15000;while(Date.now()<deadline){const v=await store.get(owner,id);if(['failed','completed'].includes(v.status))return v;await new Promise(r=>setTimeout(r,10));}assert.fail('owned checkpoint job did not settle');};
 f.state.omitTypesettingIdentity=true;const first=await store.submit({owner,idempotencyKey:'render-first',bytes:png,name:'synthetic.png',projectId:'book',pageId:'same-page',sourceLanguage:'ja'});assert.equal((await until(first.id)).status,'failed');
 const state=JSON.parse(await fs.readFile(path.join(root,first.id,'state.json'),'utf8'));assert.ok(state.checkpoints.cleaned.sha256);
 f.state.omitTypesettingIdentity=false;const [retry,duplicate]=await Promise.all([store.retry(owner,first.id,{idempotencyKey:'render-retry'}),store.retry(owner,first.id,{idempotencyKey:'render-retry'})]);assert.equal(retry.id,duplicate.id);
 assert.equal((await until(retry.id)).status,'completed');assert.equal(f.state.modelRecords.length,1);assert.equal(f.state.statusCalls,1);
 const report=JSON.parse(await fs.readFile(path.join(root,retry.id,'report.json'),'utf8'));assert.deepEqual(report.recovery.reusedStages,['ocr','translation','cleaned']);
 const committed=JSON.parse(await fs.readFile(path.join(root,retry.id,'state.json'),'utf8'));assert.equal(committed.usage.localModelRequests,0);assert.equal(committed.usage.monetaryCost,null);
 await store.close();store=await createJobStore({root,engine:f.engine});assert.equal((await store.get(owner,retry.id)).status,'completed');assert.equal((await store.retry(owner,first.id,{idempotencyKey:'render-retry'})).id,retry.id);assert.equal(f.state.modelRecords.length,1);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,retry.id,'state.json'),'utf8')).resultReceipt,committed.resultReceipt);
});

for(const fault of ['omitTypesettingIdentity','staleTypesettingIdentity'])test('Stage12 refuses '+fault+' before any partial candidate PNG is saved',{timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false);f.state[fault]=true;
 await assert.rejects(f.run(1),e=>e.code==='STALE_RESULT');
 assert.equal((await fs.readdir(path.join(f.root,'page-1'))).some(n=>/candidate|result\.png/.test(n)),false);
});

test('health advertises saved terminology consumption for both page and Stage11 text paths', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const supported=await fixture(t,false);assert.equal(supported.engine.health().savedContextSupported,true);await supported.engine.close();
 const legacy=await fixture(t,false,{pageContextTranslation:false});assert.equal(legacy.engine.health().savedContextSupported,true);await legacy.engine.close();
});

test('Stage11 default text path consumes bound context with real TS modules and keeps uncertain semantics as a draft', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false,{pageContextTranslation:false});
 const sourceSha256=createHash('sha256').update(png).digest('hex');
 const snapshot={version:1,owner:'a'.repeat(64),projectId:'book',pageId:'one',pageNumber:1,sourceSha256,glossaryRevision:3,glossary:[{id:'name',source:'テスト',target:'검사'}],profiles:[],previousContext:[{source:'前',translation:'UNREVIEWED_POISON',status:'AI_PROPOSED'}]};
 const context={...snapshot,snapshotSha256:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')};
 const result=await f.run(1,{pageId:'one',translationContext:context});
 assert.equal(result.report.translationInput.version,'stage11-input-v1');assert.equal(result.report.translationContext.consumed,true);
 assert.equal(result.report.translations[0].semantic.automaticQualityApproval,false);assert.equal(result.report.translations[0].semantic.semanticAccuracy,null);
 const calls=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse),posts=calls.filter(x=>x.path==='/v1/chat/completions');
 assert.equal(posts.length,1);assert.equal(posts[0].body.temperature,0.3);assert.equal(JSON.stringify(posts).includes('UNREVIEWED_POISON'),false);
 assert.ok(posts[0].body.messages[1].content.includes('USER_CONFIRMED'));assert.ok(posts[0].body.response_format);
 assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'page-1','translation-input.json'),'utf8')).context.revision,3);
});

for(const page of [false,true])test('Stage11 '+(page?'page':'text')+' partial response cannot publish, erase source, or replace a last normal PNG', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false,{pageContextTranslation:page});
 f.state.ocrResultOverride={pageNumber:1,nonSpeechText:[],warnings:[],speechBubbles:['a','b'].map((suffix,i)=>({id:'line-1-'+suffix,text:'テスト',readingOrder:i+1,bbox:{x:0,y:0,width:1,height:1}}))};
 await fs.writeFile(path.join(f.root,'last-normal.png'),png,{flag:'wx'});
 await fs.writeFile(path.join(f.root,'response-line-1-'+(page?'a':'b')+'.txt'),JSON.stringify({regions:page?[{id:'line-1-a',source_reading:'テスト',translation:'검사',uncertain:false}]:[]}));
 await assert.rejects(f.run(1),{code:'PAGE_TRANSLATION_INVALID'});
 const directory=path.join(f.root,'page-1'),review=JSON.parse(await fs.readFile(path.join(directory,'translation-review.json'),'utf8'));
 assert.equal(review.partialApplied,false);assert.equal(review.automaticRetry,false);assert.deepEqual(review.receivedCandidateIds,page?[]:['line-1-a']);
 for(const name of ['translations.json','cleaned.png','candidate.png','engine-report.json'])await assert.rejects(fs.access(path.join(directory,name)),{code:'ENOENT'});
 assert.deepEqual(await fs.readFile(path.join(f.root,'last-normal.png')),png);
 const posts=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse).filter(x=>x.path==='/v1/chat/completions');assert.equal(posts.length,page?1:2);
});

test('Japanese translation in valid page JSON is rejected before any candidate, restoration or completed report', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false);
 await fs.writeFile(path.join(f.root,'response-line-1.txt'),JSON.stringify({regions:[{id:'line-1',source_reading:'テスト',translation:'テスト',uncertain:false}]}));
 await assert.rejects(f.run(1),{code:'PAGE_TRANSLATION_INVALID'});
 const directory=path.join(f.root,'page-1'),review=JSON.parse(await fs.readFile(path.join(directory,'translation-review.json'),'utf8'));
 assert.equal(review.partialApplied,false);assert.equal(review.automaticRetry,false);
 for(const name of ['translations.json','cleaned.png','candidate.png','engine-report.json'])await assert.rejects(fs.access(path.join(directory,name)),{code:'ENOENT'});
 const posts=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse).filter(x=>x.path==='/v1/chat/completions');assert.equal(posts.length,1);
});

test('a page request binds the server snapshot and records actual glossary/context consumption', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,false),snapshot={version:1,owner:'a'.repeat(64),projectId:'book',pageId:'one',pageNumber:1,sourceSha256:createHash('sha256').update(png).digest('hex'),glossaryRevision:9,glossary:[{id:'name',source:'テスト',target:'이름 표기'}],previousContext:[{source:'前',translation:'앞 페이지 후보',status:'AI_PROPOSED'}]};
 const snapshotSha256=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
 const result=await f.run(1,{pageId:'one',translationContext:{...snapshot,snapshotSha256}});
 assert.deepEqual(result.report.translationContext,{snapshotSha256,glossaryRevision:9,consumed:true});
 assert.equal(result.report.translationRequests[0].contextSnapshotSha256,snapshotSha256);
 const calls=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse),post=calls.find(call=>call.path==='/v1/chat/completions');
 const text=post.body.messages[1].content.find(value=>value.type==='text').text;
 assert.ok(text.includes('이름 표기'));assert.equal(text.includes('앞 페이지 후보'),false);
 assert.ok(result.report.translationInput.excluded.some(e=>e.reason==='UNREVIEWED_AI_CONTEXT'));
 assert.equal(result.report.translationRequests[0].httpRequests,1);
});

test('selected reuse keeps independent OCR/server owners, isolates project switches, and uses fresh page bodies with exact IDs', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,true);const first=await f.run(1),second=await f.run(2);assert.equal(f.state.statusCalls,1);assert.equal(f.state.ocrPids.length,1);assert.equal(f.state.modelRecords.length,1);assert.equal(f.state.modelRecords[0].closed,false);assert.notEqual(first.report.translations[0].requestId,second.report.translations[0].requestId);assert.equal(first.report.translations[0].modelHttpRequests,1);assert.equal(second.report.translations[0].modelHttpRequests,1);
 const calls=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse),posts=calls.filter(call=>call.path==='/v1/chat/completions');assert.equal(posts.length,2);assert.ok(posts.every(call=>call.authorized&&call.body.cache_prompt===false));assert.notDeepEqual(posts[0].body,posts[1].body);assert.deepEqual(posts[0].body.response_format.json_schema.schema.properties.regions.items.properties.id.enum,['line-1']);assert.deepEqual(posts[1].body.response_format.json_schema.schema.properties.regions.items.properties.id.enum,['line-2']);
 const old=f.state.modelRecords[0];await f.run(3,{projectId:'other'});assert.equal(old.closed,true);assert.equal(f.state.statusCalls,2);assert.equal(f.state.modelRecords.length,2);await f.engine.close();assert.ok(f.state.modelRecords.every(record=>record.closed));assert.ok(f.state.allRecords.every(record=>record.closed));assert.ok(f.state.ocrChildren.every(child=>child.exitCode!==null||child.signalCode!==null));assert.equal(globalThis.fetch,f.beforeFetch);
});

test('a warm OCR lazy restart is rejected before spawning and only the next explicit job performs cold preparation', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,true);await f.run(1);f.state.forceSpawn=true;await assert.rejects(f.run(2),error=>error.code==='PROCESS_RESTART_REQUIRED');assert.equal(f.state.ocrPids.length,1);assert.equal(f.state.statusCalls,1);await f.run(3);assert.equal(f.state.statusCalls,2);assert.equal(f.state.ocrPids.length,2);const events=(await fs.readFile(path.join(f.root,'page-2','runtime-events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(events.some(event=>event.phase==='ocr_runtime_cache_failed'&&event.code==='PROCESS_RESTART_REQUIRED'));await f.engine.close();assert.ok(f.state.ocrChildren.every(child=>child.exitCode!==null||child.signalCode!==null));
});

test('engine close cancels active synthetic translation, drains job and caches, then releases hooks', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,true);await fs.writeFile(path.join(f.root,'hold-posts'),'synthetic hold');const running=f.run(1).then(()=>({ok:true}),error=>({ok:false,error}));let posted=false;const until=Date.now()+7000;
 while(Date.now()<until){try{posted=(await fs.readFile(f.diary,'utf8')).includes('/v1/chat/completions');}catch{}if(posted)break;await new Promise(resolve=>setTimeout(resolve,15));}
 assert.equal(posted,true);await f.engine.close();const result=await running;assert.equal(result.ok,false);assert.equal(result.error.code,'CANCELLED');assert.ok(f.state.modelRecords.every(record=>record.closed));assert.ok(f.state.ocrChildren.every(child=>child.exitCode!==null||child.signalCode!==null));assert.equal(globalThis.fetch,f.beforeFetch);assert.equal(f.engine.health().ready,false);
});

test('a cached server reporting a foreign model cannot serve a new page and is disposed before another cold validation', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,true);await f.run(1);const first=f.state.modelRecords[0];await fs.writeFile(path.join(f.root,'wrong-model'),'synthetic identity mismatch');await assert.rejects(f.run(2));assert.equal(first.closed,true);const calls=(await fs.readFile(f.diary,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.filter(call=>call.path==='/v1/chat/completions').length,1);await fs.unlink(path.join(f.root,'wrong-model'));await f.run(3);await f.engine.close();assert.ok(f.state.modelRecords.every(record=>record.closed));
});

test('recognition failure records bounded private diagnostics before generic public error without model work', {timeout:10_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,true),secret='SYNTHETIC_PRIVATE_DIALOGUE_AND_KEY',message='Production OCR sidecar failed: '+secret;f.state.recognitionError=new Error(message);await assert.rejects(f.run(1),error=>error.code==='ENGINE_FAILED'&&!error.message.includes(secret));const text=await fs.readFile(path.join(f.root,'page-1','runtime-events.jsonl'),'utf8'),events=text.trim().split('\n').map(JSON.parse),event=events.find(value=>value.phase==='ocr_failure_diagnostic');assert.ok(event,'original OCR fault needs a diagnostic before its generic error');assert.equal(event.category,'SIDECAR_OPERATION_ERROR');assert.equal(event.errorName,'Error');assert.equal(event.errorCode,null);assert.match(event.messageSha256,/^[a-f0-9]{64}$/);assert.equal(text.includes(secret),false);assert.equal(f.state.modelRecords.length,0);assert.equal(f.state.ocrChildren.length,0);await f.engine.close();
});

test('cold and cached OCR scopes inject private homes while same-executable model and restoration providers keep their environments', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const original=childProcess.spawn,seen=[];childProcess.spawn=function(executable,args,options){if(executable===process.execPath)seen.push({ocr:args.at(-1)==='OCR_ENV_POLICY_FIXTURE',role:path.basename(args[0]),home:options?.env?.HOME,userprofile:options?.env?.USERPROFILE});return original.call(this,executable,args,options);};
 try{for(const reuse of [false,true]){const f=await fixture(t,reuse);f.state.observeEnvironment=true;f.state.suppliedOcrEnvs=[];await f.run(1);if(reuse)await f.run(2);const expected=path.join(f.root,'profile','ocr-home'),ocr=seen.filter(value=>value.ocr&&value.home===expected);assert.equal(ocr.length,1);assert.equal(ocr[0].userprofile,expected);assert.equal(f.state.suppliedOcrEnvs[0].hoMe,'SYNTHETIC_CALLER_HOME');assert.equal(f.state.suppliedOcrEnvs[0].uSeRpRoFiLe,'SYNTHETIC_CALLER_PROFILE');if(reuse){assert.equal(f.state.statusCalls,1);assert.equal(f.state.ocrChildren[0].exitCode,null);}await f.engine.close();}const foreign=seen.filter(value=>['synthetic-server.cjs','synthetic-restoration.cjs'].includes(value.role));assert.ok(foreign.length>0);assert.ok(foreign.every(value=>value.home===undefined&&value.userprofile===undefined));}finally{childProcess.spawn=original;syncBuiltinESMExports();}
});

// This deliberately leaves an uncertain hook resident, so keep it after scope-observation tests.
test('unconfirmed cached owner cleanup blocks the engine and keeps hooks until owner recovery instead of accepting another job', {timeout:20_000,skip:!process.env.MANGOHANA_OWNED_RUNTIME_TEST_DIR},async t=>{
 const f=await fixture(t,true);await f.run(1);f.state.failCleanup=true;await assert.rejects(f.engine.close(),error=>error.code==='CLEANUP_FAILED');assert.equal(f.engine.health().ready,false);assert.notEqual(globalThis.fetch,f.beforeFetch);await assert.rejects(f.run(2),error=>error.code==='ENGINE_UNAVAILABLE');assert.ok(f.state.modelRecords.every(record=>record.closed));
});
