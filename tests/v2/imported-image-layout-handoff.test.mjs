import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {fixture} from './imported-page-fixture.mjs';import {createImportedPageController} from '../../apps/engine/imported-page-controller.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
test('OCR importer is the exact existing audited source; image layout metadata does not change its trusted digest',async()=>{
 const policy=JSON.parse(await fs.readFile('packages/ai-engine/quality/ocr-compatibility-policy.json')),row=policy.allowedNonOcrChanges.find(r=>r.path==='packages/ai-engine/quality/imported-page-input.cjs');assert.ok(row);assert.equal(sha(await fs.readFile(row.path)),row.sha256);
});
async function setup(t,{forged=false,withoutBinding=false}={}){
 const f=await fixture(t),layout={version:1,layoutRevision:4,state:'APPROVED_SOURCE_LAYOUT_CLEANED_PENDING',entries:[{id:'r12',text:'한줄!'}],source:{},planSha256:'a'.repeat(64)},outputRoot=path.join(f.root,'outputs'),root=path.join(f.root,'permits');await fs.mkdir(outputRoot);
 const reviewStore={...f.store,withEngineInputs:(owner,id,expected,inspect)=>f.store.withEngineInputs(owner,id,expected,(b,revalidate)=>inspect({...b,...(!withoutBinding?{layoutReview:structuredClone(layout)}:{})},revalidate))};let observed;
 const controller=await createImportedPageController({root,outputRoot,reviewStore,inspectInputs:async binding=>{const value=await f.inspect(binding);delete value.layoutReview;if(forged)value.layoutReview={...layout,layoutRevision:99};return value;},preflight:async args=>{observed=args.inputs;return {status:'READY',blockers:[],fingerprint:sha('synthetic-ready')};},runPipeline:async()=>{throw Error('REAL_IMAGE_FORBIDDEN');},verifyOutput:async()=>{throw Error('REAL_IMAGE_FORBIDDEN');}});t.after(()=>controller.close());
 return {...f,layout,root,controller,observed:()=>observed,prepare:()=>controller.prepare(f.principal,f.document.documentId,f.expected)};
}
test('image controller appends its authoritative layout after the verified OCR-only inspection',async t=>{
 const f=await setup(t),p=await f.prepare();assert.equal(p.state,'AWAITING_APPROVAL');assert.equal(p.binding.layoutRevision,4);assert.deepEqual(f.observed().layoutReview,f.layout);assert.notEqual(f.observed().layoutReview,f.layout);assert.equal(f.observed().ocrRegions,13);assert.equal(f.observed().userTranslationsUsable,13);
});
for(const withoutBinding of [false,true])test('inspector-supplied foreign layout is refused before Permit creation, binding absent='+withoutBinding,async t=>{
 const f=await setup(t,{forged:true,withoutBinding});await assert.rejects(f.prepare(),{code:'LAYOUT_EXECUTION_BINDING_INVALID'});assert.equal((await fs.readdir(f.root)).filter(n=>/^[a-f0-9-]{36}$/.test(n)).length,0);
});
