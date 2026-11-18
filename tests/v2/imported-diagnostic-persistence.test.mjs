import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import os from'node:os';import path from'node:path';import {createRequire}from'node:module';import {createHash}from'node:crypto';
const require=createRequire(import.meta.url);let api={};try{api=require('../../packages/ai-engine/quality/imported-image-diagnostics.cjs');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
const sha=b=>createHash('sha256').update(b).digest('hex'),sharp=createRequire(new URL('../../packages/ai-engine/package.json',import.meta.url))('sharp'),png=await sharp({create:{width:1,height:1,channels:4,background:{r:255,g:255,b:255,alpha:1}}}).png().toBuffer();
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'image-diagnostics-')),output=path.join(root,'synthetic-permit'),work=path.join(output,'work');await fs.mkdir(work,{recursive:true});const current={ownerScope:'synthetic-owner',projectId:'project',pageId:'page',pageNumber:1,editRevision:1,contextRevision:0,normalizedSha256:'a'.repeat(64),sourceSha256:'d'.repeat(64)},binding={...current,selectedSetSha256:'c'.repeat(64)},pin={path:path.join(root,'model.pt'),sha256:'e'.repeat(64),bytes:1};
 return{args:{signal:new AbortController().signal,revalidate:async()=>{},outputDirectory:work,permit:{permitId:'synthetic-permit',executionGeneration:'synthetic-generation',maximumExecutions:1,approvedPages:['page'],binding,outputDirectory:output,readiness:{mask:{maskSha256:'b'.repeat(64)},pins:[pin]}},inputs:{current,application:{selectedSetSha256:'c'.repeat(64)},source:{processingGeneration:2,checkpointSha256:'f'.repeat(64)}},config:{lamaModel:pin.path}},verified:{width:1,height:1},cleaned:{bytes:png,nativePixelVerification:{version:1,status:'VERIFIED',width:1,height:1,normalizedSha256:current.normalizedSha256,maskSha256:'b'.repeat(64),cleanedSha256:sha(png),alphaPixelsChecked:1,alphaPixelsChanged:0,protectedPixelsChecked:1,protectedPixelsChanged:0},verification:{cleanupConfirmed:true,normalizedImageSha256:current.normalizedSha256,maskSha256:'b'.repeat(64),cleanedSha256:sha(png)}}};}
test('verified cleaned bytes and bound provenance survive a later layout failure without becoming a final result',async()=>{
 assert.equal(typeof api.persistVerifiedCleaned,'function');const f=await fixture(),before=Buffer.from(png),r=await api.persistVerifiedCleaned(f),manifest=JSON.parse(await fs.readFile(path.join(r.directory,'manifest.json')));assert.deepEqual(await fs.readFile(path.join(r.directory,'cleaned.diagnostic.png')),before);assert.equal(manifest.kind,'VERIFIED_CLEANED_DIAGNOSTIC_NOT_FINAL_OUTPUT');assert.equal(manifest.cleanedSha256,sha(png));assert.equal(manifest.reuseAuthorized,false);assert.equal(manifest.finalResult,false);assert.equal(manifest.executionGeneration,'synthetic-generation');assert.ok(!r.directory.endsWith('.partial'));
 const original=await fs.readFile(path.join(r.directory,'manifest.json'));const second=await api.persistVerifiedCleaned(f);assert.notEqual(second.directory,r.directory);assert.deepEqual(await fs.readFile(path.join(r.directory,'manifest.json')),original);
});
test('bridge metadata alone cannot replace the independent native mask/alpha proof',async()=>{
 const f=await fixture();delete f.cleaned.nativePixelVerification;await assert.rejects(api.persistVerifiedCleaned(f),{code:'DIAGNOSTIC_NATIVE_PIXEL_PROOF_REQUIRED'});assert.deepEqual(await fs.readdir(f.args.outputDirectory),[]);
});
test('worker failure record is exclusive and an IO error remains visible in runtime stderr',async()=>{
 const f=await fixture(),record={version:1,permitId:'synthetic-permit',executionGeneration:'synthetic-generation',code:'DIAGNOSTIC_SAVE_FAILED'},messages=[],stderr={write:v=>messages.push(v)};
 const first=await api.writeWorkerFailure({directory:f.args.outputDirectory,record,stderr});assert.equal(first.recorded,true);const original=await fs.readFile(path.join(f.args.outputDirectory,'failure.json'));
 const second=await api.writeWorkerFailure({directory:f.args.outputDirectory,record:{...record,code:'OTHER'},stderr});assert.equal(second.recorded,false);assert.equal(second.failure.causeCode,'EEXIST');assert.ok(messages[0].includes('WORKER_FAILURE_RECORD_WRITE_FAILED'));assert.deepEqual(await fs.readFile(path.join(f.args.outputDirectory,'failure.json')),original);
});
test('atomic rename IO failure retains a complete .partial artifact and never publishes it',async t=>{
 const f=await fixture();t.mock.method(fs,'rename',async()=>{throw Object.assign(Error('disk full'),{code:'ENOSPC'});});let error;try{await api.persistVerifiedCleaned(f);}catch(e){error=e;}
 assert.equal(error.code,'DIAGNOSTIC_SAVE_FAILED');assert.equal(error.diagnosticPersistenceError.stage,'atomic-promotion');const names=await fs.readdir(path.join(f.args.outputDirectory,'diagnostics'));assert.equal(names.length,1);assert.ok(names[0].endsWith('.partial'));assert.deepEqual(await fs.readFile(path.join(f.args.outputDirectory,'diagnostics',names[0],'cleaned.diagnostic.png')),png);
});
for(const mismatch of['owner','revision','hash','mask','path'])test('diagnostic capture rejects '+mismatch+' mismatch without touching originals',async()=>{
 const f=await fixture(),marker=path.join(f.args.permit.outputDirectory,'source-marker');await fs.writeFile(marker,'preserve');if(mismatch==='owner')f.args.inputs.current.ownerScope='foreign';if(mismatch==='revision')f.args.inputs.current.editRevision=2;if(mismatch==='hash')f.cleaned.bytes=Buffer.from('invalid');if(mismatch==='mask')f.cleaned.verification.maskSha256='0'.repeat(64);if(mismatch==='path')f.args.outputDirectory=f.args.permit.outputDirectory;
 await assert.rejects(()=>api.persistVerifiedCleaned(f));assert.equal(await fs.readFile(marker,'utf8'),'preserve');assert.equal((await fs.readdir(path.join(f.args.permit.outputDirectory,'work'))).length,0);
});
test('a blocked diagnostic destination leaves existing files and source bytes intact',async()=>{
 const f=await fixture(),target=path.join(f.args.outputDirectory,'diagnostics');await fs.writeFile(target,'existing');await assert.rejects(()=>api.persistVerifiedCleaned(f));assert.equal(await fs.readFile(target,'utf8'),'existing');assert.deepEqual(f.cleaned.bytes,png);
});
test('layout diagnostic capture preserves measured and unknown values separately',async()=>{
 const f=await fixture(),r=await api.persistLayoutDiagnostics({args:f.args,diagnostics:{regions:[{id:'one',fontSizePx:29,fitStatus:'RENDER_NOT_MEASURED'},{id:'two',fontSizePx:null,fitStatus:null}],stage:'renderer-plan'}}),v=JSON.parse(await fs.readFile(path.join(r.directory,'manifest.json')));assert.equal(v.kind,'LAYOUT_DIAGNOSTIC_NOT_FINAL_OUTPUT');assert.equal(v.diagnostics.regions[0].fontSizePx,29);assert.equal(v.diagnostics.regions[1].fontSizePx,null);assert.equal(v.finalResult,false);
});
test('cancellation during diagnostic commit retains incomplete evidence and never promotes it',async()=>{
 const f=await fixture(),controller=new AbortController();f.args.signal=controller.signal;f.args.revalidate=async phase=>{if(phase==='before-diagnostic-commit')controller.abort();};
 await assert.rejects(api.persistVerifiedCleaned(f));const names=await fs.readdir(path.join(f.args.outputDirectory,'diagnostics'));assert.equal(names.length,1);assert.ok(names.every(n=>n.endsWith('.partial')));
});
test('live Permit/generation revalidation rejects promotion without rewriting its cause',async()=>{
 const f=await fixture();f.args.signal=new AbortController().signal;f.args.revalidate=async phase=>{if(phase==='before-diagnostic-commit')throw Object.assign(Error('generation changed'),{code:'IMAGE_PERMIT_STALE'});};
 await assert.rejects(api.persistVerifiedCleaned(f),{code:'IMAGE_PERMIT_STALE'});const names=await fs.readdir(path.join(f.args.outputDirectory,'diagnostics'));assert.ok(names.length===1&&names[0].endsWith('.partial'));
});
test('IO failure has a bounded persistence error and cannot become a final result',async()=>{
 const f=await fixture();f.args.signal=new AbortController().signal;f.args.revalidate=async()=>{};await fs.writeFile(path.join(f.args.outputDirectory,'diagnostics'),'preserve');let e;try{await api.persistVerifiedCleaned(f);}catch(error){e=error;}
 assert.equal(e?.code,'DIAGNOSTIC_SAVE_FAILED');assert.ok(e.diagnosticPersistenceError?.causeCode);assert.equal(await fs.readFile(path.join(f.args.outputDirectory,'diagnostics'),'utf8'),'preserve');
});
