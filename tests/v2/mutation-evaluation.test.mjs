import test from 'node:test';
import assert from 'node:assert/strict';
import { mutationCatalog, materializeCase, applyOperator } from '../../packages/evaluation/mutation/catalog.mjs';
import { fixture } from './offline-evaluation-fixture.mjs';
import { evaluateOfflineRun, validateOfflineReport } from '../../packages/evaluation/offline/evaluator.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runMutationCampaign } from '../../packages/evaluation/mutation/runner.mjs';
const api = await import('../../packages/evaluation/mutation/metrics.mjs').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e;
});

test('review and unsupported detectors are never true positives or binary negatives', () => {
  assert.equal(typeof api.summarizeMutations, 'function');
  const row = (truth, decision) => ({ lane: 'quality', independentOracle: true, truth, decision });
  const r = api.summarizeMutations([row('defect','error'),row('defect','pass'),row('normal','pass'),row('normal','error'),row('defect','review'),row('defect','unsupported'),row('normal','unmeasured')]);
  assert.deepEqual(r.binary, { TP: 1, FP: 1, FN: 1, TN: 1, cases: 4 });
  assert.equal(r.recall.value, .5); assert.equal(r.precision.value, .5);
  assert.equal(r.falsePositiveRate.value, .5); assert.equal(r.falseAcceptRate.value, .5);
  assert.equal(r.reviewHoldRate.value, 1/7); assert.equal(r.measurableCaseRate.value, 4/7);
  assert.equal(r.allOracleDefectDetectionCoverage.value, 1/4);
});
test('empty denominators remain null and evidence lanes never merge into quality performance', () => {
  assert.equal(typeof api.summarizeMutations, 'function');
  assert.equal(api.summarizeMutations([]).recall.value, null);
  const r = api.summarizeByLane([{lane:'integrity',truth:'defect',independentOracle:true,decision:'error'}, {lane:'quality',truth:'defect',independentOracle:true,decision:'unsupported'}]);
  assert.equal(r.integrity.binary.TP, 1); assert.equal(r.quality.binary.TP, 0);
  assert.equal(r.quality.recall.value, null); assert.equal(r.quality.allOracleDefectDetectionCoverage.value, 0);
});
test('normal review and unmeasured controls retain their real outcome', () => {
  assert.equal(typeof api.classifyMutation, 'function');
  assert.equal(api.classifyMutation({truth:'normal',decision:'review'}), 'NEEDS_REVIEW');
  assert.equal(api.classifyMutation({truth:'normal',decision:'unmeasured'}), 'NOT_MEASURABLE');
  assert.equal(api.classifyMutation({truth:'defect',decision:'unsupported'}), 'UNSUPPORTED_DETECTOR');
  assert.equal(api.classifyMutation({truth:'defect',decision:'pass'}), 'MISSED');
  assert.throws(()=>api.classifyMutation({truth:'defect',decision:'crashed'}));
});

test('all requested cases have effective operators, preserved oracles and distinct pristine fixtures', () => {
  const cases=mutationCatalog();
  for(const [prefix,n] of [['OCR-',15],['SEM-',15],['IMG-',12],['TYPE-',12],['OPS-',15]])
    assert.equal(cases.filter(c=>new RegExp('^'+prefix+'[0-9]{2}$').test(c.mutationId)).length,n);
  for(const c of cases) {const before=structuredClone(c.baseline),r=materializeCase(c);assert.deepEqual(c.baseline,before);assert.equal(r.proof.verified,true);assert.notEqual(r.baseline,r.mutant);}
  assert.throws(()=>applyOperator({},[{op:'set',path:['absent','field'],value:1}]));
  const noop={...cases[1],patches:[{op:'set',path:['regions'],value:cases[1].baseline.regions}]};assert.throws(()=>materializeCase(noop));
});
test('operators remove actual OCR content, preserve alternatives and resolve one image defect while introducing another', () => {
  const cases=mutationCatalog(),mutate=id=>materializeCase(cases.find(c=>c.mutationId===id));
  const missing=mutate('OCR-02');assert.equal(missing.mutant.regions.length,missing.baseline.regions.length-1);
  const polarity=mutate('SEM-01');assert.equal(polarity.baseline.translation,'안 갈게');assert.equal(polarity.mutant.translation,'갈게');
  const names=mutate('SEM-05');assert.equal(names.baseline.translation,'다나카(20)');assert.equal(names.mutant.translation,'다나카');
  const composite=mutate('COMPOUND-01');assert.deepEqual(composite.baseline.cleaned.slice(18*4,18*4+4),[0,0,0,255]);
  assert.deepEqual(composite.mutant.cleaned.slice(18*4,18*4+4),[255,255,255,255]);
  assert.deepEqual(composite.mutant.cleaned.slice(42*4,42*4+4),[255,255,255,255]);
  assert.deepEqual(composite.baseline.cleaned.slice(42*4,42*4+4),[0,0,0,255]);
});

for(const [name,mutate,code] of [
  ['invented first-attempt success',r=>r.summary.recordedSuccess.firstAttempt=1,'REPORT_OPERATION_AGGREGATE_MISMATCH'],
  ['invented verified runtime success',r=>r.summary.verifiedFirstAttemptSuccessRate={numerator:1,denominator:1,value:1,reason:null},'UNSUPPORTED_PRODUCT_CERTIFICATION'],
  ['unknown quality marked measured',r=>r.states.QUALITY_NOT_MEASURED=false,'UNMEASURED_QUALITY_PROMOTED'],
  ['unreviewed result marked deliverable',r=>r.pages[0].deliveryEligibility={status:'deliverable',reasons:[]},'UNREVIEWED_DELIVERY_PROMOTED'],
])test('report contract rejects '+name,async t=>{
  const f=await fixture(t),r=await evaluateOfflineRun(await f.seal());validateOfflineReport(r);
  const changed=structuredClone(r);mutate(changed);assert.throws(()=>validateOfflineReport(changed),{code});
});

test('real runner separates valid quality defects from hash rejection and preserves geometry ambiguity',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stage07-integration-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const ids=['INT-01','SEM-01','OCR-14','OCR-15','IMG-11','IMG-C03','TYPE-12','COMPOUND-01','STRUCT-C01','OPS-10','OPS-07'];
  const r=await runMutationCampaign({outputDir:path.join(dir,'campaign'),cases:mutationCatalog().filter(c=>ids.includes(c.mutationId))});
  const row=id=>r.results.find(x=>x.mutationId===id);
  assert.equal(row('INT-01').classification,'DETECTED');assert.equal(row('INT-01').lane,'integrity');
  assert.equal(row('SEM-01').classification,'UNSUPPORTED_DETECTOR');assert.equal(row('SEM-01').detectionEvidence.ruleQa.score,100);
  assert.equal(row('SEM-01').detectionEvidence.structuralValidation,'passed');
  assert.equal(row('OCR-14').detectionEvidence.syntheticGlyphRetention,1);assert.equal(row('OCR-15').detectionEvidence.syntheticGlyphRetention,.5);
  assert.equal(row('OCR-14').classification,'NEEDS_REVIEW');assert.equal(row('OCR-15').classification,'NEEDS_REVIEW');
  assert.equal(row('IMG-11').classification,'DETECTED');assert.equal(row('IMG-C03').detectionEvidence.pixelMeasurements.outsideMaskChangedPixels.value,0);
  assert.equal(row('IMG-C03').classification,'UNSUPPORTED_DETECTOR');assert.equal(row('TYPE-12').detectionEvidence.report.missingGlyphs.value,null);
  assert.equal(row('COMPOUND-01').detectionEvidence.pixelMeasurements.protectedChangedPixels.value,1);
  assert.equal(row('STRUCT-C01').classification,'CORRECT_PASS');
  assert.equal(row('OPS-10').classification,'MISSED');
  assert.ok(row('OPS-10').effectiveInjectionProof.changes.some(c=>c.path.endsWith('apiCost.value') && c.before===.25 && c.after===.5));
  assert.ok(row('INT-01').effectiveInjectionProof.changes.some(c=>c.path.includes('warnings')));
  assert.ok(row('OPS-07').effectiveInjectionProof.changes.some(c=>c.path==='candidate.targets.0.text.userConfirmed' || c.path.startsWith('candidate.targets.0.text.userConfirmed.')));
  assert.equal(row('OPS-07').detectionEvidence.currentUnchanged,true);
  await assert.rejects(runMutationCampaign({outputDir:path.join(dir,'campaign'),cases:[]}),{code:'EEXIST'});
});
