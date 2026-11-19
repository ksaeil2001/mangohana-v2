import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { contentSha256, toStage02PendingCorpus, validateDataset } from '../../packages/evaluation/dataset-contract.mjs';
import { evaluateOfflineRun } from '../../packages/evaluation/offline/evaluator.mjs';
import { createExperimentLock } from '../../packages/evaluation/stage16-experiment-lock.mjs';
import { addHoldoutPage, experiment, freezeDataset, matrixFor, sha } from './fixtures/stage16-experiment.mjs';

function exposureHeads(input) {
  return { candidateSelectionSha256: contentSha256(input.candidateSelection), holdoutHistorySha256: contentSha256(input.holdoutHistory) };
}

function decide(input, priorPin = contentSha256(input.preregistration), current = exposureHeads(input)) {
  return createExperimentLock(input, priorPin, current);
}

function expectBlocked(input, reason, priorPin) {
  const decision = decide(input, priorPin);
  assert.equal(decision.reason, reason);
  assert.equal(decision.status, 'blocked');
  assert.equal(decision.lockId, null);
  return decision;
}

test('different works and leakage groups cannot reuse a candidate-selection context SHA', () => {
  const input = experiment();
  const exposure = input.candidateSelection.exposures[0];
  assert.notEqual(exposure.workId, input.matrices[0].shared.workId);
  assert.notEqual(exposure.leakageGroupId, input.holdoutHistory[0].leakageGroupId);
  exposure.contextSnapshotSha256 = input.matrices[0].shared.contextSnapshotSha256;
  input.preregistration.work_split_and_exposure = contentSha256(input.candidateSelection);
  expectBlocked(input, 'CANDIDATE_CONTEXT_REUSED');
});

test('an unknown candidate-selection history cannot issue a lock for an independent work', () => {
  const input = experiment();
  input.candidateSelection = { status: 'unknown', evidenceSha256: null, exposures: [] };
  input.preregistration.work_split_and_exposure = contentSha256(input.candidateSelection);
  expectBlocked(input, 'CANDIDATE_EXPOSURE_UNKNOWN');
});

test('independent evidence and frozen criteria issue a reproducible lock for the exact cohort', () => {
  const input = experiment();
  addHoldoutPage(input, 'other-work', 'other-page');
  const before = structuredClone(input);
  const result = decide(input);
  assert.equal(result.status, 'locked');
  assert.match(result.lockId, /^[a-f0-9]{64}$/);
  assert.equal(result.lockId, contentSha256(result.record));
  assert.equal(result.record.preregistrationSha256, contentSha256(input.preregistration));
  assert.deepEqual(result.record.samples.map(s => [s.workId, s.pageId, s.contextSnapshotSha256]), [
    ['work-final', 'page-final', sha('context-page-final')], ['other-work', 'other-page', sha('context-other-page')],
  ]);
  assert.deepEqual(input, before);
  input.matrices.reverse();
  input.preregistration = Object.fromEntries(Object.entries(input.preregistration).reverse());
  assert.deepEqual(decide(input), result);
});

test('an evidenced 11M non-run is distinct from missing history', () => {
  const input = experiment();
  input.candidateSelection = { status: 'not_run', evidenceSha256: sha('11m-did-not-run'), exposures: [] };
  input.preregistration.work_split_and_exposure = contentSha256(input.candidateSelection);
  assert.equal(decide(input).status, 'locked');
});

for (const [name, patch] of [
  ['missing history', null],
  ['unsubstantiated non-run', { status: 'not_run', exposures: [], evidenceSha256: null }],
  ['recorded with no exposures', { status: 'recorded', exposures: [], evidenceSha256: sha('report') }],
  ['non-run with exposures', { status: 'not_run', exposures: experiment().candidateSelection.exposures, evidenceSha256: sha('report') }],
  ['a partially known context', { status: 'recorded', exposures: [{ workId: 'other', leakageGroupId: 'other', contextSnapshotSha256: null }], evidenceSha256: sha('report') }],
]) test(name + ' cannot establish candidate independence', () => {
  const input = experiment();
  input.candidateSelection = patch;
  input.preregistration.work_split_and_exposure = contentSha256(patch);
  expectBlocked(input, 'CANDIDATE_EXPOSURE_UNKNOWN');
});

test('candidate evidence missing from the hashed JSON cannot be supplied by inherited fields', () => {
  for (const missing of ['record', 'entry']) {
    const input = experiment();
    if (missing === 'record') input.candidateSelection = Object.create(input.candidateSelection);
    else input.candidateSelection.exposures[0] = Object.create(input.candidateSelection.exposures[0]);
    input.preregistration.work_split_and_exposure = contentSha256(input.candidateSelection);
    expectBlocked(input, 'CANDIDATE_EXPOSURE_UNKNOWN');
  }
});

for (const [name, edit, reason] of [
  ['candidate work', row => { row.workId = 'work-final'; row.leakageGroupId = 'group-work-final'; }, 'CANDIDATE_WORK_REUSED'],
  ['candidate leakage group under another ID', row => { row.workId = 'external-work'; row.leakageGroupId = 'group-work-final'; }, 'CANDIDATE_GROUP_REUSED'],
  ['a known selection work relabelled with an unrelated group', row => { row.leakageGroupId = 'other-group'; }, 'EXPOSURE_GROUP_MISMATCH'],
]) test(name + ' blocks the experiment', () => {
  const input = experiment();
  edit(input.candidateSelection.exposures[0]);
  input.preregistration.work_split_and_exposure = contentSha256(input.candidateSelection);
  expectBlocked(input, reason);
});

test('a conflict on the second sample blocks the whole experiment', () => {
  const input = experiment();
  addHoldoutPage(input, 'other-work', 'other-page');
  input.candidateSelection.exposures.push({ workId: 'candidate', leakageGroupId: 'elsewhere',
    contextSnapshotSha256: input.matrices[1].shared.contextSnapshotSha256 });
  input.preregistration.work_split_and_exposure = contentSha256(input.candidateSelection);
  expectBlocked(input, 'CANDIDATE_CONTEXT_REUSED');
});

test('an unassigned sibling with unknown development use blocks the group while unrelated inventory stays eligible', () => {
  const input = experiment();
  addHoldoutPage(input, 'unassigned-work', 'unassigned-page');
  input.matrices.pop();
  input.preregistration.source_and_gt_hashes.pop();
  input.holdoutHistory.pop();
  input.preregistration.holdout_freeze.historyLength = input.holdoutHistory.length;
  input.preregistration.holdout_freeze.historySha256 = contentSha256(input.holdoutHistory);
  const page = input.manifest.pages.at(-1);
  page.split = 'unassigned';
  page.usedForDevelopment = null;
  page.annotation = { ...page.annotation, status: 'pending', path: 'annotations/unassigned/unassigned-page.json' };
  freezeDataset(input.manifest);
  input.preregistration.holdout_freeze.manifestSha256 = contentSha256(input.manifest);
  assert.equal(decide(input).status, 'locked');
  input.manifest.works.at(-1).leakageGroupId = 'group-work-final';
  freezeDataset(input.manifest);
  input.preregistration.holdout_freeze.manifestSha256 = contentSha256(input.manifest);
  expectBlocked(input, 'DEVELOPMENT_EXPOSURE_UNKNOWN');
});

for (const [name, change, reason] of [
  ['no frozen split', i => { i.manifest.freeze = null; }, 'DATASET_FREEZE_REQUIRED'],
  ['a changed frozen annotation', i => { i.manifest.pages[1].annotation.sha256 = sha('changed'); }, 'INVALID_FREEZE'],
  ['unconfirmed evaluation rights', i => { i.manifest.pages[1].provenance.rights = { status: 'unknown', allowedUses: [], evidence: null }; }, 'RIGHTS_REQUIRED'],
  ['a development work in the cohort', i => {
    i.matrices[0] = matrixFor(i.manifest.pages[0]);
    i.preregistration.source_and_gt_hashes[0] = { pageId: 'page-dev', sourceSha256: sha('page-dev'),
      groundTruthSha256: i.manifest.pages[0].annotation.sha256, matrixSha256: i.matrices[0].matrixSha256 };
  }, 'SAMPLE_NOT_UNUSED_HOLDOUT'],
  ['a cross-split leakage group', i => { i.manifest.works[0].leakageGroupId = 'group-work-final'; }, 'WORK_SPLIT_LEAKAGE'],
  ['a stale criteria file', i => { i.datasetCriteriaJson += ' '; }, 'DATASET_CRITERIA_PIN_MISMATCH'],
  ['a prior final run', i => {
    const f = i.manifest.freeze;
    f.finalRun = { runId: 'old-run', startedAt: f.frozenAt, criteriaSha256: f.criteriaSha256,
      manifestContentSha256: f.manifestContentSha256, evidence: f.evidence };
    i.preregistration.holdout_freeze.manifestSha256 = contentSha256(i.manifest);
  }, 'FINAL_RUN_ALREADY_STARTED'],
  ['a matrix with a forged cell', i => { i.matrices[0].conditions[1].modelSha256 = sha('forged'); }, 'MATRIX_CONTENT_MISMATCH'],
  ['a matrix with a forged fingerprint', i => { i.matrices[0].matrixSha256 = sha('forged'); }, 'MATRIX_CONTENT_MISMATCH'],
  ['a newly generated matrix with a changed font', i => { i.matrices[0] = matrixFor(i.manifest.pages[1], { shared: { fontSha256: sha('other-font') } }); }, 'SAMPLE_PIN_MISMATCH'],
  ['a newly generated matrix with a changed model', i => { i.matrices[0] = matrixFor(i.manifest.pages[1], { models: { B: sha('other-model') } }); }, 'SAMPLE_PIN_MISMATCH'],
  ['an omitted matrix', i => { i.matrices = []; }, 'COHORT_MISMATCH'],
  ['a duplicate matrix', i => { i.matrices.push(i.matrices[0]); }, 'COHORT_MISMATCH'],
  ['duplicate preregistered pages', i => { i.preregistration.source_and_gt_hashes.push(i.preregistration.source_and_gt_hashes[0]); }, 'COHORT_MISMATCH'],
  ['empty sample', i => { i.preregistration.source_and_gt_hashes = []; i.matrices = []; }, 'COHORT_MISMATCH'],
  ['a pending ground truth pin', i => {
    i.manifest.pages[1].annotation.status = 'pending'; freezeDataset(i.manifest);
    i.preregistration.holdout_freeze.manifestSha256 = contentSha256(i.manifest);
  }, 'SEALED_GROUND_TRUTH_REQUIRED'],
  ['unfrozen evidence substitution', i => { i.candidateSelection.evidenceSha256 = sha('other-proof'); }, 'CANDIDATE_RECORD_CHANGED'],
  ['a missing Stage08 field', i => { delete i.preregistration.blind_randomized_human_review; }, 'INVALID_PREREGISTRATION'],
  ['an empty primary effect', i => { i.preregistration.primary_metric_and_minimum_effect.minimumEffect = null; }, 'INVALID_PREREGISTRATION'],
  ['unknown noninferiority margin', i => { i.preregistration.noninferiority_margins = {}; }, 'INVALID_PREREGISTRATION'],
  ['unknown request limit', i => { i.preregistration.resource_caps_and_stop_rules.maxRequests = null; }, 'INVALID_PREREGISTRATION'],
  ['an invalid stopping rule', i => { i.preregistration.resource_caps_and_stop_rules.stopRulesSha256 = ''; }, 'INVALID_PREREGISTRATION'],
  ['a negative cost cap', i => { i.preregistration.resource_caps_and_stop_rules.maxMoney = -1; }, 'INVALID_PREREGISTRATION'],
  ['a foreign policy fingerprint', i => { i.preregistration.evaluator_and_policy_version.policySha256 = sha('different-policy'); }, 'QUALITY_POLICY_PIN_MISMATCH'],
  ['criteria contradicting Stage05 matching', i => { i.preregistration.matching_unit_and_iou.threshold = 0.1; }, 'DATASET_CRITERIA_PIN_MISMATCH'],
  ['a ground truth payload submitted to a pre-lock', i => { i.nonHoldoutAnnotations = [{ pageId: 'page-final' }]; }, 'HOLDOUT_LABELS_FORBIDDEN'],
]) test(name + ' issues no lock', () => {
  const input = experiment();
  change(input);
  expectBlocked(input, reason);
});

test('no anchor, or a modified criterion or resource cap under the existing anchor, cannot mint another lock', () => {
  const input = experiment();
  const prior = contentSha256(input.preregistration);
  assert.equal(createExperimentLock(input).lockId, null);
  input.preregistration.primary_metric_and_minimum_effect.minimumEffect = 0;
  expectBlocked(input, 'PREREGISTRATION_PIN_MISMATCH', prior);
  const fresh = experiment();
  fresh.preregistration.resource_caps_and_stop_rules.maxMoney = 100;
  expectBlocked(fresh, 'PREREGISTRATION_PIN_MISMATCH', prior);
});

test('changing a pinned model or font inside a newly declared sample still disagrees with the global versions', () => {
  for (const change of [{ models: { B: sha('other-b') } }, { shared: { fontSha256: sha('other-font') } }]) {
    const input = experiment();
    input.matrices[0] = matrixFor(input.manifest.pages[1], change);
    input.preregistration.source_and_gt_hashes[0].matrixSha256 = input.matrices[0].matrixSha256;
    expectBlocked(input, 'EXPERIMENT_VERSION_MISMATCH');
  }
});

test('one comparison cannot mix processing or shared settings between pages', () => {
  for (const change of [{ processing: { improved: sha('other-process') } }, { shared: { settingsSha256: sha('other-settings') } }]) {
    const input = experiment();
    addHoldoutPage(input, 'second-work', 'second-page');
    input.matrices[1] = matrixFor(input.manifest.pages[2], change);
    input.preregistration.source_and_gt_hashes[1].matrixSha256 = input.matrices[1].matrixSha256;
    expectBlocked(input, 'EXPERIMENT_VERSION_MISMATCH');
  }
});

test('no sealed-history evidence before preregistration cannot be repaired by a later assertion', () => {
  const input = experiment();
  input.preregistration.holdout_freeze.historyLength = 0;
  input.preregistration.holdout_freeze.historySha256 = contentSha256([]);
  expectBlocked(input, 'HOLDOUT_EXPOSURE_UNKNOWN');
});

test('an erased or rewritten prefix is detected before later exposure claims are used', () => {
  const input = experiment();
  input.holdoutHistory[0].evidenceSha256 = sha('rewritten');
  expectBlocked(input, 'HOLDOUT_HISTORY_CHANGED');
  input.holdoutHistory = [];
  expectBlocked(input, 'HOLDOUT_HISTORY_CHANGED');
});

test('later sealed claims cannot erase an opened or uncertain holdout', () => {
  for (const [state, reason] of [['opened', 'HOLDOUT_ALREADY_OPENED'], ['unknown', 'HOLDOUT_EXPOSURE_UNKNOWN']]) {
    const input = experiment();
    input.holdoutHistory.push({ ...input.holdoutHistory[0], state, evidenceSha256: sha(state) }, input.holdoutHistory[0]);
    expectBlocked(input, reason);
  }
});

test('tuning after opening demotes the work and its group, preserves history and requires a fresh holdout', () => {
  const input = experiment();
  addHoldoutPage(input, 'work-final', 'sibling');
  addHoldoutPage(input, 'alias-work', 'alias-page', 'group-work-final');
  const originalLock = decide(input);
  const prior = contentSha256(input.preregistration);
  const opened = { ...input.holdoutHistory[0], state: 'opened', evidenceSha256: sha('opened-result') };
  const tuned = { ...opened, state: 'tuned_after_opening', evidenceSha256: sha('changed-after-reading') };
  input.holdoutHistory.push(opened, tuned, input.holdoutHistory[0]);
  const before = structuredClone(input);
  const denied = expectBlocked(input, 'HOLDOUT_TUNED_AFTER_OPENING', prior);
  assert.equal(denied.replacementHoldoutRequired, true);
  assert.equal(denied.disposition.previousManifestSha256, contentSha256(before.manifest));
  assert.equal(denied.disposition.historySha256, contentSha256(before.holdoutHistory));
  assert.deepEqual(denied.disposition.changes.map(c => [c.workId, c.from, c.to, c.pageIds]).sort(), [
    ['alias-work', 'holdout', 'dev', ['alias-page']], ['work-final', 'holdout', 'dev', ['page-final', 'sibling']],
  ]);
  assert.deepEqual(input, before);
  assert.equal(originalLock.status, 'locked');
  assert.equal(originalLock.lockId, contentSha256(originalLock.record));

  addHoldoutPage(input, 'replacement-work', 'replacement-page');
  input.matrices = input.matrices.slice(-1);
  input.preregistration.source_and_gt_hashes = input.preregistration.source_and_gt_hashes.slice(-1);
  const replacement = decide(input);
  assert.equal(replacement.status, 'locked');
  assert.notEqual(originalLock.lockId, replacement.lockId);
  assert.equal(replacement.record.holdoutHistorySha256, contentSha256(input.holdoutHistory));
  assert.deepEqual(input.holdoutHistory.slice(0, before.holdoutHistory.length), before.holdoutHistory);
});

test('a tuned context cannot be relabelled as a new work or group', () => {
  const input = experiment();
  input.holdoutHistory.push({ ...input.holdoutHistory[0], workId: 'previous-work', leakageGroupId: 'previous-group',
    state: 'tuned_after_opening', evidenceSha256: sha('previous-use') });
  expectBlocked(input, 'HOLDOUT_TUNED_AFTER_OPENING');
});

test('a previously valid but truncated history cannot replay the pre-tuning lock against the current evidence', () => {
  const input = experiment();
  const prior = contentSha256(input.preregistration);
  const oldHistory = structuredClone(input.holdoutHistory);
  assert.equal(decide(input, prior).status, 'locked');
  input.holdoutHistory.push({ ...oldHistory[0], state: 'tuned_after_opening', evidenceSha256: sha('tuning') });
  const current = exposureHeads(input);
  assert.equal(decide(input, prior, current).reason, 'HOLDOUT_TUNED_AFTER_OPENING');
  input.holdoutHistory = oldHistory;
  const replay = decide(input, prior, current);
  assert.equal(replay.lockId, null);
  assert.equal(replay.reason, 'HOLDOUT_HISTORY_CHANGED');
});

test('missing current exposure pins or a superseded 11M record cannot authorize a lock', () => {
  const input = experiment();
  const prior = contentSha256(input.preregistration);
  assert.equal(createExperimentLock(input, prior).reason, 'CURRENT_EXPOSURE_UNKNOWN');
  const current = { ...exposureHeads(input), candidateSelectionSha256: sha('newer-11m-record') };
  assert.equal(decide(input, prior, current).reason, 'CANDIDATE_RECORD_CHANGED');
});

test('a recorded final run still yields a development disposition for a subsequently tuned holdout', () => {
  const input = experiment();
  const pin = contentSha256(input.preregistration);
  const originalManifest = contentSha256(input.manifest);
  const f = input.manifest.freeze;
  f.finalRun = { runId: 'viewed-run', startedAt: f.frozenAt, criteriaSha256: f.criteriaSha256,
    manifestContentSha256: f.manifestContentSha256, evidence: f.evidence };
  input.holdoutHistory.push({ ...input.holdoutHistory[0], state: 'tuned_after_opening', evidenceSha256: sha('tuned') });
  const denied = expectBlocked(input, 'HOLDOUT_TUNED_AFTER_OPENING', pin);
  assert.equal(denied.disposition.previousManifestSha256, originalManifest);
  assert.equal(denied.disposition.observedManifestSha256, contentSha256(input.manifest));
  assert.equal(denied.disposition.changes[0].to, 'dev');
});

test('a new independent cohort retains the effective development split of previously tuned works', () => {
  const input = experiment();
  input.holdoutHistory.push({ ...input.holdoutHistory[0], state: 'tuned_after_opening', evidenceSha256: sha('tuned') });
  addHoldoutPage(input, 'replacement-work', 'new-page');
  input.matrices.shift();
  input.preregistration.source_and_gt_hashes.shift();
  const lock = decide(input);
  assert.equal(lock.status, 'locked');
  assert.deepEqual(lock.disposition?.changes.map(c => [c.workId, c.to, c.pageIds]), [['work-final', 'dev', ['page-final']]]);
});

test('foreign work, source, or sealed ground truth cannot be substituted even with a valid matrix fingerprint', () => {
  for (const field of ['workId', 'sourceSha256', 'groundTruthSha256']) {
    const input = experiment();
    if (field === 'groundTruthSha256') {
      input.preregistration.source_and_gt_hashes[0].groundTruthSha256 = sha('unrelated-gt');
    } else {
      input.matrices[0] = matrixFor(input.manifest.pages[1], { shared: { [field]: field === 'workId' ? 'unrelated' : sha('unrelated-source') } });
      input.preregistration.source_and_gt_hashes[0].matrixSha256 = input.matrices[0].matrixSha256;
    }
    expectBlocked(input, 'SAMPLE_PIN_MISMATCH');
  }
});

test('a synthetic pre-lock leaves Stage05 label export and Stage06 final evaluation blocked', async t => {
  const input = experiment();
  assert.equal(decide(input).status, 'locked');
  const datasetState = validateDataset(input.manifest, { policy: JSON.parse(input.datasetCriteriaJson) });
  assert.equal(datasetState.states.HOLDOUT_READY, false);
  assert.equal(datasetState.counts.humanVerifiedPages, 0);
  assert.throws(() => toStage02PendingCorpus(input.manifest, 'holdout'), { code: 'HOLDOUT_EXPORT_FORBIDDEN' });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stage16-metadata-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dataset = JSON.stringify(input.manifest);
  const descriptor = JSON.stringify({ schemaVersion: 1, adapterVersion: 'stage06-v1', runId: 'synthetic-run',
    datasetVersion: '0.2.1', datasetManifestSha256: sha(dataset), split: 'holdout', pages: [] });
  const datasetPath = path.join(dir, 'manifest.json'), evidencePath = path.join(dir, 'descriptor.json');
  await fs.writeFile(datasetPath, dataset);
  await fs.writeFile(evidencePath, descriptor);
  await assert.rejects(evaluateOfflineRun({ datasetPath, datasetSha256: sha(dataset), evidencePath,
    evidenceSha256: sha(descriptor), evidenceRoot: dir }), { code: 'HOLDOUT_EVALUATION_NOT_AUTHORIZED_IN_STAGE06' });
});
