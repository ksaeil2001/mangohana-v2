import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createRequire} from 'node:module';
import {usageFromReport} from '../../apps/engine/store.mjs';
import {readProcessing} from '../../packages/evaluation/offline/operations.mjs';
const {createCheckpointSession,fingerprintFiles}=createRequire(import.meta.url)('../../packages/ai-engine/quality/recovery-checkpoint.cjs');
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'stage13-cache-')),before=path.join(root,'before'),after=path.join(root,'after');await fs.mkdir(before);await fs.mkdir(after);
 const scope={ownerScope:'a'.repeat(64),projectId:'work',pageId:'page',sourceSha256:'1'.repeat(64),normalizedSha256:'2'.repeat(64),sourceLanguage:'ja',pageNumber:1},proofs={};
 const s=createCheckpointSession({directory:before,jobId:'old',scope,onCheckpoint:p=>{proofs[p.stage]=p;}});
 await fs.writeFile(path.join(before,'cleaned.png'),'synthetic valid cleaned bytes');
 await s.save('ocr',{model:'ocr-v1',generation:1},{text:'原文'});
 await s.save('translation',{model:'E2B',prompt:'stage11',contextRevision:2,glossaryRevision:2,ocrGeneration:1},{translation:'후보'});
 await s.save('cleaned',{maskSha256:'3'.repeat(64),lama:'existing'},{verification:{cleanupConfirmed:true}},['cleaned.png']);
 const read=(scopeChange={},proofChange={})=>createCheckpointSession({directory:after,jobId:'new',scope:{...scope,...scopeChange},resumeFrom:{directory:before,jobId:'old',checkpoints:{...proofs,...proofChange}}});
 return {root,before,after,scope,proofs,read};
}
for(const [label,change] of [['source replacement',{sourceSha256:'4'.repeat(64)}],['normalized replacement',{normalizedSha256:'5'.repeat(64)}],['another owner',{ownerScope:'b'.repeat(64)}],['another work',{projectId:'other'}],['another page',{pageId:'other'}]])test('cache rejects '+label+' without modifying a valid entry',async()=>{
 const f=await fixture(),file=path.join(f.before,'checkpoint-ocr.json'),before=await fs.readFile(file),reader=f.read(change);assert.equal(await reader.load('ocr',{model:'ocr-v1',generation:1}),null);assert.deepEqual(await fs.readFile(file),before);assert.equal(reader.evidence().misses.length,1);
});
test('OCR generation invalidates dependent translations while a valid OCR checkpoint stays reusable',async()=>{
 const f=await fixture(),s=f.read();assert.ok(await s.load('ocr',{model:'ocr-v1',generation:1}));assert.equal(await s.load('translation',{model:'E2B',prompt:'stage11',contextRevision:2,glossaryRevision:2,ocrGeneration:2}),null);
});
for(const change of [{model:'other'},{prompt:'new'},{contextRevision:3},{glossaryRevision:3}])test('translation dependency change invalidates only that entry '+JSON.stringify(change),async()=>{
 const f=await fixture(),s=f.read();assert.equal(await s.load('translation',{model:'E2B',prompt:'stage11',contextRevision:2,glossaryRevision:2,ocrGeneration:1,...change}),null);assert.ok(await s.load('ocr',{model:'ocr-v1',generation:1}));assert.ok(await s.load('cleaned',{maskSha256:'3'.repeat(64),lama:'existing'}));
});
test('mask change rejects cleaned reuse while font/geometry and a new render job do not erase valid upstream entries',async()=>{
 const f=await fixture(),s=f.read();assert.equal(await s.load('cleaned',{maskSha256:'4'.repeat(64),lama:'existing'}),null);assert.ok(await s.load('translation',{model:'E2B',prompt:'stage11',contextRevision:2,glossaryRevision:2,ocrGeneration:1}));
 const valid=await f.read().load('cleaned',{maskSha256:'3'.repeat(64),lama:'existing'});assert.equal(valid.assets['cleaned.png'].toString(),'synthetic valid cleaned bytes');
});
test('receipt mismatch, obsolete version, and tampered cleaned bytes cannot be cache hits',async()=>{
 const f=await fixture();assert.equal(await f.read({}, {ocr:{stage:'ocr',sha256:'0'.repeat(64)}}).load('ocr',{model:'ocr-v1',generation:1}),null);
 await fs.writeFile(path.join(f.before,'cleaned.png'),'tampered');assert.equal(await f.read().load('cleaned',{maskSha256:'3'.repeat(64),lama:'existing'}),null);
 const file=path.join(f.before,'checkpoint-translation.json'),saved=JSON.parse(await fs.readFile(file,'utf8'));saved.version='old';await fs.writeFile(file,JSON.stringify(saved));assert.equal(await f.read().load('translation',saved.identity),null);
});
test('cancelled checkpoint lookup throws before a hit or a new receipt; reused requests are not charged twice',async()=>{
 const f=await fixture(),controller=new AbortController();controller.abort();const s=createCheckpointSession({directory:f.after,jobId:'new',scope:f.scope,resumeFrom:{directory:f.before,jobId:'old',checkpoints:f.proofs},signal:controller.signal});
 await assert.rejects(s.load('ocr',{model:'ocr-v1',generation:1}),{name:'AbortError'});assert.deepEqual(await fs.readdir(f.after),[]);
 const usage=usageFromReport({recovery:{fromJobId:'old',reusedStages:['translation']},translations:[{id:'r',modelHttpRequests:1,durationMs:10}]},12);assert.equal(usage.localModelRequests,0);assert.equal(usage.monetaryCost,null);assert.equal(usage.tokenUsage,null);assert.equal(usage.reusedFromJobId,'old');
});
test('configuration fingerprints inspect bytes and transitive imports even at identical file sizes and mtimes',async()=>{
 const f=await fixture(),main=path.join(f.root,'main.js'),dep=path.join(f.root,'dep.js');await fs.writeFile(main,"import './dep.js'; export {value} from './dep.js';");await fs.writeFile(dep,'export const value=1;');const stamp=await fs.stat(dep),before=await fingerprintFiles([main]);await fs.writeFile(dep,'export const value=2;');await fs.utimes(dep,stamp.atime,stamp.mtime);assert.notEqual(await fingerprintFiles([main]),before);
});
function replayPage(bound=true){
 const state={status:'completed',stage:'completed',createdAt:'2026-11-13T00:00:00Z',updatedAt:'2026-11-13T00:00:01Z',retryOf:'previous-job',usage:{localModelRequests:0},checkpoints:bound?{translation:{stage:'translation',sha256:'a'.repeat(64)}}:undefined};
 const report={recovery:{version:'stage13-checkpoint-v1',fromJobId:'previous-job',reusedStages:['translation']},translations:[{id:'r',requestId:'previous-request',modelHttpRequests:1,durationMs:50}]};
 return {state,report,declaredOutcome:null,get:role=>role==='translations'?{json:{records:report.translations}}:{}};
}
test('Stage06 evaluation separates historical reused request evidence from current execution cost',()=>{
 const result=readProcessing(replayPage());assert.equal(result.translationRequests.modelCalls.value,0);assert.equal(result.translationRequests.requestDurationMs.value,0);assert.equal(result.translationRequests.uniqueRequests,0);assert.equal(result.translationRequests.apiCost.value,null);assert.equal(result.translationRequests.inputTokens.value,null);
});
test('an unbound reuse label cannot manufacture a measured zero in the evaluator',()=>{
 assert.throws(()=>readProcessing(replayPage(false)),{code:'REUSED_REQUEST_PROOF_REQUIRED'});
});
