import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fixture, sha, png, white, identity, bubble } from './offline-evaluation-fixture.mjs';
import { validateCommonContract } from '../../packages/contracts/src/v2-common-contract.mjs';
import {contentSha256} from '../../packages/evaluation/dataset-contract.mjs';
const api = await import('../../packages/evaluation/offline/evaluator.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
const images = await import('../../packages/evaluation/offline/quality.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
const ops = await import('../../packages/evaluation/offline/operations.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
const ocr = await import('../../packages/evaluation/offline/ocr.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });

test('offline API exists separately from product runtime', () => assert.equal(typeof api.evaluateOfflineRun, 'function'));

test('refined child selection preserves original lineage in the existing offline adapter',async t=>{
 const f=await fixture(t),raw=bubble(),child={...bubble('refined-child'),ocrRefinement:{sourceDetectionIds:['det-1']}};
 child.productionOcrProvenance.sourceDetectionIds=['redetection-1'];
 await f.add('raw','raw_ocr','raw.json',{speechBubbles:[raw],nonSpeechText:[]});
 const a=f.page.artifacts.find(a=>a.kind==='final_ocr'),data=JSON.stringify({speechBubbles:[child],nonSpeechText:[]});await fs.writeFile(path.join(f.assets,a.path),data);a.sha256=sha(data);
 await f.add('selection','region_selection','selection.json',{detection:{imageSha256:sha(f.source),regions:[{id:'roi',kind:'text_bubble',confidence:.9,bbox:raw.bbox}]},selection:{decisions:[{id:child.id,action:'translate',detectorRegionId:'roi',sourceLineIds:['det-1']}]}});
 await f.add('translations','translations','translations.json',{lines:[{id:child.id,sourceText:child.text,aiTranslation:'합성',sourceLineIds:['det-1']}],records:[{id:child.id,requestId:'synthetic-request',modelHttpRequests:1}]});
 const result=await api.evaluateOfflineRun(await f.seal());assert.equal(result.pages[0].lineage.finalSourceCoverage.retainedObservedSourceLines,1);assert.equal(result.pages[0].lineage.translationBindings.status,'structurally_bound');
 assert.equal(result.pages[0].lineage.sourceCharacterLoss.value,null);
});
test('explicit normalized frame supports a distinct original upload hash without accepting foreign uploads',async t=>{
 const f=await fixture(t),artifact=f.page.artifacts.find(a=>a.kind==='normalized');
 // A different encoded, valid PNG; geometry remains in the normalized frame.
 const sharp=(await import('sharp')).default,normalized=await sharp(f.source).png({compressionLevel:0}).toBuffer();assert.notEqual(sha(normalized),sha(f.source));
 await fs.writeFile(path.join(f.assets,artifact.path),normalized);artifact.sha256=sha(normalized);
 const content={kind:'OCR_REFINEMENT_PLAN',version:1,width:2,height:2,sourceSha256:sha(f.source),originalUploadSha256:sha(f.source),sourceImageSha256:sha(normalized),sourceFrame:{kind:'normalized_px',width:2,height:2,imageSha256:sha(normalized)},groups:[]};
 const plan=await f.add('plan','refinement_plan','plan.json',{...content,integritySha256:contentSha256(content)});
 assert.ok((await api.evaluateOfflineRun(await f.seal())).pages[0].lineage);
 content.sourceSha256='f'.repeat(64);const bytes=JSON.stringify({...content,integritySha256:contentSha256(content)});await fs.writeFile(path.join(f.assets,plan.path),bytes);plan.sha256=sha(bytes);
 await assert.rejects(api.evaluateOfflineRun(await f.seal()),{code:'REFINEMENT_IMAGE_BINDING_MISMATCH'});
});
test('pending GT retains null metrics, failed processing and unverified execution', async t => {
  const f = await fixture(t), r = await api.evaluateOfflineRun(await f.seal());
  assert.equal(r.datasetVersion, '0.2.1'); assert.equal(r.pages[0].ocr, null);
  assert.equal(r.pages[0].processing.status, 'failed'); assert.equal(r.pages[0].execution.productExecutionVerified, false);
  assert.equal(r.pages[0].semantic.majorCriticalErrors.value, null); assert.equal(r.pages[0].image.insideArtworkDamage.value, null);
  assert.equal(r.states.HUMAN_GT_BLOCKED, true); assert.equal(r.states.QUALITY_NOT_MEASURED, true);
  assert.equal(r.summary.automaticDeliveryErrorRate.value, null);
  validateCommonContract(r.pages[0].common.document);
});
for (const [name, edit, code] of [
  ['image hash mismatch', f => f.page.artifacts[0].sha256 = sha('tampered'), 'ASSET_HASH_MISMATCH'],
  ['duplicate artifact ID', f => f.page.artifacts.push({ ...f.page.artifacts[0] }), 'DUPLICATE_ARTIFACT_ID'],
  ['stale run', f => f.page.artifacts[0].origin.runId = 'older-run', 'STALE_ARTIFACT'],
  ['stale job', f => f.page.artifacts[0].origin.jobId = 'older-job', 'STALE_ARTIFACT'],
  ['wrong work', f => f.page.binding.workId = 'foreign-work', 'DATASET_PAGE_BINDING_MISMATCH'],
  ['mixed split', f => f.descriptor.split = 'calibration', 'SPLIT_MISMATCH'],
  ['incomplete success claim', f => f.page.declaredOutcome = 'succeeded', 'INCOMPLETE_SUCCESS_CLAIM'],
  ['unknown metric silently submitted as zero', f => f.page.semanticScore = 0, 'INVALID_EVIDENCE_DESCRIPTOR'],
  ['parent traversal', f => f.page.artifacts[0].path = '../source.png', 'ASSET_PATH_ESCAPE'],
]) test('rejects ' + name, async t => { const f = await fixture(t); edit(f); await assert.rejects(api.evaluateOfflineRun(await f.seal()), { code }); });
test('does not certify actual_product self declaration', async t => {
  const f = await fixture(t); f.page.evidenceKind = 'actual_product'; const r = await api.evaluateOfflineRun(await f.seal());
  assert.equal(r.pages[0].execution.productExecutionVerified, false); assert.equal(r.summary.verifiedFirstAttemptSuccessRate.value, null);
});
for (const [name, change] of [
  ['owner', x => x.owner = 'foreign-owner'], ['runtime page', x => x.pageId = 'foreign-page'], ['revision', x => x.sourceRevision = 99],
]) test('rejects ' + name + ' mismatch in durable state', async t => {
  const f = await fixture(t), a = f.page.artifacts.find(x => x.id === 'state'), state = JSON.parse(await fs.readFile(path.join(f.assets,a.path)));
  change(state); await fs.writeFile(path.join(f.assets,a.path),JSON.stringify(state)); a.sha256=sha(JSON.stringify(state));
  await assert.rejects(api.evaluateOfflineRun(await f.seal()), { code: 'STATE_BINDING_MISMATCH' });
});
test('raw detector text is never silently scored as final OCR', async t => {
  const f = await fixture(t); f.page.artifacts.find(x=>x.id==='ocr').kind='raw_ocr'; const r=await api.evaluateOfflineRun(await f.seal());
  assert.equal(r.pages[0].ocrMeasurement.reason, 'FINAL_OCR_NOT_AVAILABLE');
  assert.equal(r.pages[0].lineage.observedSourceLines,1);
});
test('refuses duplicate final OCR regions and lost source-line provenance', async t => {
  const f=await fixture(t), a=f.page.artifacts.find(x=>x.id==='ocr'), file=path.join(f.assets,a.path);
  for(const bubbles of [[bubble(),bubble()], [{...bubble(),productionOcrProvenance:{...bubble().productionOcrProvenance,sourceDetectionIds:[]}}]]) {
    const bytes=JSON.stringify({speechBubbles:bubbles,nonSpeechText:[]}); await fs.writeFile(file,bytes); a.sha256=sha(bytes);
    await assert.rejects(api.evaluateOfflineRun(await f.seal()), e=>['DUPLICATE_OCR_REGION_ID','SOURCE_LINE_PROVENANCE_INVALID'].includes(e.code));
  }
});
test('translation to another group is rejected before quality evaluation', async t=>{
  const f=await fixture(t); await f.add('translations','translations','translations.json',{lines:[{id:'foreign',ocrGroupId:'foreign',sourceText:'SYNTHETIC',aiTranslation:'합성'}],records:[]});
  await assert.rejects(api.evaluateOfflineRun(await f.seal()),{code:'TRANSLATION_LINEAGE_MISMATCH'});
});
test('missing quality evidence remains unmeasured; AI severity never becomes human GT', async t=>{
  const f=await fixture(t); f.page.assessmentArtifactId='assessment'; await f.add('assessment','assessment','assessment.json',{
    schemaVersion:1,identity,subjectArtifactId:'ocr',subjectSha256:f.page.artifacts.find(x=>x.id==='ocr').sha256,actor:'ai',reviewerId:null,
    annotationSha256:null,reviewedAt:'2026-11-12T08:00:00Z',axes:['semantic'],errors:[{axis:'semantic',type:'polarity_reversal',severity:'critical',targetId:'g1',sourceSpan:{start:0,end:1},candidateSpan:{start:0,end:1},rationale:'SYNTHETIC',evidenceArtifactIds:['ocr']}],complete:true});
  const r=await api.evaluateOfflineRun(await f.seal()); assert.equal(r.pages[0].semantic.majorCriticalErrors.value,null);
  assert.equal(r.pages[0].semantic.opinionOrigin,'ai');
});

async function ocrResult(t, expected, actual) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stage06-ocr-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const source=await png(white);await fs.writeFile(path.join(dir,'source.png'),source);
  return ocr.evaluateOcrPages({runId:'synthetic',split:'dev',workspace:path.join(dir,'derived'),pages:[{pageId:'p1',workId:'w1',duplicateGroupId:'d1',source:{path:path.join(dir,'source.png'),sha256:sha(source)},
    groundTruth:{status:'verified',reviewer:'synthetic-only',reviewedAt:'2026-11-12T08:00:00Z',regions:expected},finalOcr:{speechBubbles:actual},evidenceKind:'synthetic'}]});
}
const gt=(id='gt1',text='あ')=>({id,text,translation:'아',bbox:{x:.1,y:.1,width:.3,height:.3},order:1});
for(const [name,expected,actual,counts,cer] of [
  ['correct OCR',[gt()],[bubble()],[1,0,0],0],
  ['missing line',[gt()],[],[0,0,1],1],
  ['extra region',[],[bubble()],[0,1,0],null],
  ['empty OCR and GT',[],[],[0,0,0],null],
  ['CER above one',[gt()],[bubble('g1','あいう')],[1,0,0],2],
])test('Stage02 reuse: '+name,async t=>{const r=await ocrResult(t,expected,actual),m=r.pages[0].ocr;
  assert.deepEqual([m.truePositives,m.falsePositives,m.falseNegatives],counts);assert.equal(m.characterErrorRate,cer);
  assert.equal(r.ocrSummary.microCharacterErrorRate,cer);
});
test('mask outside preservation cannot approve damage inside mask',async()=>{
  const changed=[...white];changed[0]=0;const source=await png(white),cleaned=await png(changed);
  const r=await images.compareImagePixels({source,cleaned,removal:{bytes:await png([255,255,255,255,0,0,0,255,0,0,0,255,0,0,0,255]),encoding:'binary255_active_remove'}});
  assert.equal(r.outsideMaskChangedPixels.value,0);assert.equal(r.insideMaskChangedPixels.value,1);assert.equal(r.insideArtworkDamage.value,null);
});
test('no mask means outside change is unknown, not zero',async()=>{
  const r=await images.compareImagePixels({source:await png(white),cleaned:await png(white),removal:null}); assert.equal(r.outsideMaskChangedPixels.value,null);
});
test('shared translation request is counted once and unknown costs stay null',()=>{
  const r=ops.summarizeRequestRecords([{requestId:'r1',durationMs:10,modelHttpRequests:1},{requestId:'r1',durationMs:10,modelHttpRequests:1}]);
  assert.equal(r.requestDurationMs.value,10);assert.equal(r.modelCalls.value,1);assert.equal(r.apiCost.value,null);
});
test('conflicting shared request receipts cannot be silently deduplicated',()=>assert.throws(()=>ops.summarizeRequestRecords([{requestId:'r1',durationMs:10,modelHttpRequests:1},{requestId:'r1',durationMs:11,modelHttpRequests:1}]),{code:'CONFLICTING_REQUEST_MEASUREMENTS'}));
test('all withheld yields delivery 0 but unaudited error rate null; retries separate',()=>{
  const r=ops.aggregateOperations([{evidenceKind:'synthetic',processing:{status:'succeeded'},execution:{productExecutionVerified:false},attempts:[{attemptId:'a1',number:1,status:'failed',manualEdits:0},{attemptId:'a2',number:2,status:'succeeded',manualEdits:0}],delivery:{decision:'withheld',humanAudit:null}}]);
  assert.equal(r.recordedSuccess.afterRetry,1);assert.equal(r.recordedSuccess.firstAttempt,0);assert.equal(r.automaticDeliveryRate.value,0);assert.equal(r.automaticDeliveryErrorRate.value,null);
});
test('zero pages yields null rates and reason',()=>{
  const r=ops.aggregateOperations([]);assert.equal(r.automaticDeliveryRate.value,null);assert.equal(r.automaticDeliveryRate.reason,'NO_PAGES');
});

test('different-work context is rejected with fixed code, without dialogue or private path',async t=>{
  const f=await fixture(t);await f.add('context','context','context.json',{workId:'foreign',owner:identity.ownerId,projectId:identity.projectId,sourceSha256:sha(f.source),privateDialogue:'DO_NOT_DISCLOSE'});
  await assert.rejects(api.evaluateOfflineRun(await f.seal()),e=>e.code==='CONTEXT_BINDING_MISMATCH' && e.message==='CONTEXT_BINDING_MISMATCH');
});
test('human semantic zero score without independent GT is rejected',async t=>{
  const f=await fixture(t);f.page.assessmentArtifactId='assessment';await f.add('assessment','assessment','assessment.json',{schemaVersion:1,identity,
    subjectArtifactId:'ocr',subjectSha256:f.page.artifacts.find(a=>a.id==='ocr').sha256,actor:'human',reviewerId:'self-declared-human',annotationSha256:f.dataset.pages[0].annotation.sha256,
    reviewedAt:'2026-11-12T08:00:00Z',axes:['semantic'],errors:[],complete:true});
  await assert.rejects(api.evaluateOfflineRun(await f.seal()),{code:'HUMAN_GT_REQUIRED_FOR_QUALITY_SCORE'});
});
test('changed manifest bytes do not match the caller pin',async t=>{
  const f=await fixture(t),options=await f.seal();await fs.appendFile(options.datasetPath,' ');await assert.rejects(api.evaluateOfflineRun(options),{code:'ASSET_HASH_MISMATCH'});
});
test('changed execution bytes do not match the descriptor pin',async t=>{
  const f=await fixture(t),options=await f.seal();await fs.appendFile(options.evidencePath,' ');await assert.rejects(api.evaluateOfflineRun(options),{code:'ASSET_HASH_MISMATCH'});
});
test('undecodable image is rejected even with a matching content SHA',async t=>{
  const f=await fixture(t),a=f.page.artifacts.find(a=>a.id==='normalized');await fs.writeFile(path.join(f.assets,a.path),'not an image');a.sha256=sha('not an image');
  await assert.rejects(api.evaluateOfflineRun(await f.seal()),{code:'INVALID_IMAGE_EVIDENCE'});
});
test('old candidate marked as reused is not a new actual_product result',async t=>{
  const f=await fixture(t);f.page.evidenceKind='actual_product';f.page.artifacts[0].origin.reused=true;
  await assert.rejects(api.evaluateOfflineRun(await f.seal()),{code:'INVALID_ARTIFACT_ORIGIN'});
});
test('claimed success without durable state or a model run is rejected',async t=>{
  const f=await fixture(t);f.page.artifacts=f.page.artifacts.filter(a=>a.kind!=='state');f.page.declaredOutcome='succeeded';f.page.evidenceKind='actual_product';
  await assert.rejects(api.evaluateOfflineRun(await f.seal()),{code:'INCOMPLETE_SUCCESS_CLAIM'});
});
test('foreign ROI reference in opt-in common contract cannot fall back to legacy',async t=>{
  const f=await fixture(t),r=await api.evaluateOfflineRun(await f.seal()),c=r.pages[0].common.document;c.mappings[0].regionIds=['foreign-roi'];
  f.page.commonArtifactId='common';await f.add('common','common','common.json',c);
  await assert.rejects(api.evaluateOfflineRun(await f.seal()),{code:'COMMON_CONTRACT_INVALID'});
});
test('wrong common revision is rejected even when all legacy files match',async t=>{
  const f=await fixture(t),r=await api.evaluateOfflineRun(await f.seal()),c=r.pages[0].common.document;c.identity.contextRevision=42;
  f.page.commonArtifactId='common';await f.add('common','common','common.json',c);
  await assert.rejects(api.evaluateOfflineRun(await f.seal()),{code:'COMMON_IDENTITY_MISMATCH'});
});
test('mask intrusion and protected pixel changes are separate deterministic measurements',async()=>{
  const changed=[...white];changed[0]=0;const mask=await png([255,255,255,255,0,0,0,255,0,0,0,255,0,0,0,255]);
  const r=await images.compareImagePixels({source:await png(white),cleaned:await png(changed),removal:{bytes:mask,encoding:'binary255_active_remove'},protection:{bytes:mask,encoding:'binary255_active_protect'}});
  assert.equal(r.removalProtectionOverlapPixels.value,1);assert.equal(r.protectedChangedPixels.value,1);assert.equal(r.insideArtworkDamage.value,null);
});
test('font loading and partial interior records cannot establish no missing glyphs or zero overflow',()=>{
  const page={renderPath:'engine_png',get:()=>({json:{lines:[{id:'g1'},{id:'g2'}]}}),report:{typesetting:{layoutReport:[{id:'g1',productionFontLoaded:true,glyphFontLoaded:true,raster:{outsideInteriorPixels:0}},{id:'g2',productionFontLoaded:true,glyphFontLoaded:true,raster:{outsideInteriorPixels:null}}]}}};
  const r=images.evaluateTypesetting(page);assert.equal(r.overflowPixels.value,null);assert.equal(r.missingGlyphs.value,null);assert.equal(r.fontLoadedRecords.value,2);
});
test('shared page request proof sums distributed call flags once, without multiplying duration',()=>{
  const records=[{id:'g1',requestId:'r1',requestScope:'page',durationMs:30,modelHttpRequests:1},{id:'g2',requestId:'r1',requestScope:'page',durationMs:30,modelHttpRequests:0}];
  const r=ops.summarizeRequestRecords(records,[{requestId:'r1',httpRequests:1,regionIds:['g1','g2']}]);assert.equal(r.modelCalls.value,1);assert.equal(r.requestDurationMs.value,30);
});
test('partial cost observations keep the total null and exclude Codex usage',()=>{
  const r=ops.summarizeRequestRecords([{requestId:'r1',durationMs:10,modelHttpRequests:1,observedApiCost:{value:.01,currency:'USD',scope:'product_api'}},{requestId:'r2',durationMs:null,modelHttpRequests:null}]);
  assert.equal(r.apiCost.value,null);assert.equal(r.requestDurationMs.value,null);assert.equal(r.apiCost.observedByCurrency.USD.value,.01);assert.equal(r.includesCodexDevelopmentUsage,false);
});
test('final OCR cannot lose original lineage without an explicit observed missing-source record',async t=>{
  const f=await fixture(t);await f.add('raw','raw_ocr','raw.json',{speechBubbles:[bubble()],nonSpeechText:[]});
  const a=f.page.artifacts.find(a=>a.kind==='final_ocr'),bytes=JSON.stringify({speechBubbles:[],nonSpeechText:[]});await fs.writeFile(path.join(f.assets,a.path),bytes);a.sha256=sha(bytes);
  const r=await api.evaluateOfflineRun(await f.seal());assert.deepEqual(r.pages[0].lineage.finalSourceCoverage.missingObservedSourceLineIds,['det-1']);
  assert.equal(r.pages[0].lineage.sourceCharacterLoss.value,null);
});
test('report contract rejects turning an unmeasured semantic value into zero',async t=>{
  const f=await fixture(t),r=await api.evaluateOfflineRun(await f.seal());r.pages[0].semantic.majorCriticalErrors={value:0,unit:'count',reason:null};
  assert.throws(()=>api.validateOfflineReport(r),{code:'UNMEASURED_QUALITY_PROMOTED'});
});
test('legacy provider/model names are losslessly aliased for Stage04 identifier syntax',async t=>{
  const f=await fixture(t),a=f.page.artifacts.find(a=>a.kind==='final_ocr'),g=bubble();g.productionOcrProvenance.detectorModelId='Provider/detector';
  const bytes=JSON.stringify({speechBubbles:[g],nonSpeechText:[]});await fs.writeFile(path.join(f.assets,a.path),bytes);a.sha256=sha(bytes);
  const r=await api.evaluateOfflineRun(await f.seal());validateCommonContract(r.pages[0].common.document);
  assert.equal(r.pages[0].common.modelAliases[0].legacyModelId,'Provider/detector');
});
test('stored image measurements reject a mask with inverted meaning',async t=>{
  const f=await fixture(t),changed=[...white];changed[0]=0;
  await f.add('cleaned','cleaned','cleaned.png',await png(changed));
  await f.add('mask','removal_mask','mask.png',await png([0,0,0,0,255,255,255,255,255,255,255,255,255,255,255,255]),{maskSemantics:'worker_luminance_alpha'});
  await f.add('report','report','report.json',{jobId:identity.jobId,inpainting:{pixels:{measured:true,decodedPixels:4,maskedPixels:1,changedPixels:1,outsideMaskChangedPixels:0,alphaChangedPixels:0}}});
  await assert.rejects(api.evaluateOfflineRun(await f.seal()),{code:'IMAGE_MEASUREMENT_CONTRADICTION'});
});
test('studio inverse alpha has a different removal meaning from worker luminance',async()=>{
  const changed=[...white];changed[0]=0;
  const r=await images.compareImagePixels({source:await png(white),cleaned:await png(changed),removal:{bytes:await png([0,0,0,0,255,255,255,255,255,255,255,255,255,255,255,255]),encoding:'studio_inverse_alpha'}});
  assert.equal(r.maskedPixels.value,1);assert.equal(r.outsideMaskChangedPixels.value,0);assert.equal(r.insideMaskChangedPixels.value,1);
});
test('cohort OCR denominators include pages with no submitted run evidence',async t=>{
  const f=await fixture(t),p2=structuredClone(f.dataset.pages[0]),a2=structuredClone(f.annotation);p2.pageId='dataset-page-2';p2.duplicateGroupId='dup2';a2.pageId=p2.pageId;
  p2.annotation={...await f.pin('annotations/dev/dataset-page-2.json',a2),status:'pending'};f.dataset.pages.push(p2);
  const r=await api.evaluateOfflineRun(await f.seal());assert.equal(r.summary.pages,2);assert.equal(r.summary.ocr.unmeasuredPages,2);
  assert.equal(r.stage02Calculation.report.pages.length,2);
});
test('Canvas rerender does not inherit the engine candidate overflow measurement',()=>{
  const page={renderPath:'canvas_after_user_edit',get:()=>({json:{lines:[{id:'g1'}]}}),report:{typesetting:{layoutReport:[{id:'g1',productionFontLoaded:true,raster:{outsideInteriorPixels:0}}]}}};
  const r=images.evaluateTypesetting(page);assert.equal(r.overflowPixels.value,null);assert.equal(r.fontLoadedRecords.value,null);
});
test('an export receipt must name the actual current job and final PNG hash',async t=>{
  const f=await fixture(t);await f.add('export','final_png','export.png',f.source);
  await f.add('receipt','export_receipt','export-receipt.json',{jobId:'old-job',sourceSha256:sha(f.source),exportSha256:sha(f.source),exportBytes:f.source.length,width:2,height:2});
  await assert.rejects(api.evaluateOfflineRun(await f.seal()),{code:'EXPORT_RECEIPT_MISMATCH'});
});
test('a legacy human-approved flag does not supply a human quality assessment',async t=>{
  const f=await fixture(t);await f.add('review','legacy_review','review.json',{sourceSha256:sha(f.source),humanQualityApproved:true,qualityStatus:'pass'});
  const r=await api.evaluateOfflineRun(await f.seal());assert.equal(r.pages[0].semantic.majorCriticalErrors.value,null);
  assert.equal(r.pages[0].legacyReview.recordedHumanApproval,true);assert.equal(r.pages[0].humanReview.status,'missing');
});
