import assert from 'node:assert/strict';
import test from 'node:test';
import { collectStage16Observations } from '../../packages/evaluation/stage16-execution-observations.mjs';
import { contentSha256 } from '../../packages/evaluation/dataset-contract.mjs';
import { batchProviderUsage } from '../../apps/engine/stage15-batch-accounting.mjs';
import { attemptFor, scenario, receiptFor } from './fixtures/stage16-observations.mjs';

test('a receipt for the wrong cell is refused before it contributes a completion', () => {
  const { plan, anchors } = scenario();
  const receipt = receiptFor(plan);
  receipt.condition = { ...plan.matrices[0].conditions[3] };
  assert.throws(() => collectStage16Observations(plan, [receipt], anchors), { code: 'STAGE16_CELL_MISMATCH' });
});

test('replaying a receipt counts one job and one charge', () => {
  const { plan, anchors } = scenario();
  const receipt = receiptFor(plan, plan.jobs[0], { amounts: { TRANSLATE: '0.12' } });
  const result = collectStage16Observations(plan, [receipt, structuredClone(receipt)], anchors);
  assert.equal(result.summary.completedJobs, 1);
  assert.equal(result.cells[0].jobs[0].charge.amount, '0.12');
});

test('a partial stage cannot complete a page that reports success', () => {
  const { plan, anchors } = scenario();
  const receipt = receiptFor(plan, plan.jobs[0], { states: { INPAINT: 'PARTIAL' } });
  const result = collectStage16Observations(plan, [receipt], anchors);
  assert.equal(result.summary.completedJobs, 0);
  assert.equal(result.cells[0].jobs[0].status, 'partial');
  assert.equal(result.cells[0].jobs[0].resultSha256, null);
});

test('an unsettled charge is unknown even when the confirmed subtotal is zero', () => {
  const { plan, anchors } = scenario();
  const receipt = receiptFor(plan, plan.jobs[0], { amounts: { TRANSLATE: null } });
  const charge = collectStage16Observations(plan, [receipt], anchors).cells[0].jobs[0].charge;
  assert.equal(charge.amount, null);
  assert.equal(charge.confirmedSubtotal, '0');
  assert.ok(charge.reason);
});

function row(receipt, stage) { return receipt.stages.find(s => s.stage === stage); }
function lookup(attempt, ms = 4) {
  const result = structuredClone(attempt.observations[0]);
  Object.assign(result, { operation: 'LOOKUP', lookupStatus: 'RETURNED' });
  Object.assign(result.usage, { elapsedMs: null, lookupMs: ms });
  return result;
}

test('four assigned cells retain recovered, partial, successful and missing jobs and their exact subtotal', t => {
  const { plan, anchors } = scenario();
  const first = receiptFor(plan, plan.jobs[0], { states: { TRANSLATE: 'CONFIRMED_FAILURE' }, amounts: { TRANSLATE: '0.10' } });
  const attempts = row(first, 'TRANSLATE').attempts;
  const alternate = { ...plan.jobs[0].primaryProvider, providerId: 'alternate', modelId: 'alternative' };
  const fallback = attemptFor(plan.jobs[0], 'TRANSLATE', { suffix: 'fallback', action: 'EXECUTE_FALLBACK', amount: '0.02',
    provider: alternate, previousExecutionId: attempts[0].request.input.executionId });
  fallback.observations.push(lookup(fallback));
  attempts.push(fallback);
  const partial = receiptFor(plan, plan.jobs[1], { mode: 'warm', states: { INPAINT: 'PARTIAL' }, amounts: { TRANSLATE: null } });
  const free = receiptFor(plan, plan.jobs[2]);
  const result = collectStage16Observations(plan, [partial, first, free, structuredClone(first)], anchors);
  const jobs = result.cells.map(c => c.jobs[0]);
  assert.deepEqual(jobs.map(j => j.status), ['succeeded', 'partial', 'succeeded', 'unknown']);
  assert.deepEqual(jobs.map(j => j.charge.amount), ['0.12', null, '0', null]);
  assert.deepEqual([result.summary.plannedCells, result.summary.completedCells, result.summary.plannedJobs,
    result.summary.observedJobs, result.summary.completedJobs], [4, 2, 4, 3, 2]);
  assert.deepEqual([result.summary.charge.amount, result.summary.charge.confirmedSubtotal], [null, '0.12']);
  const translation = row(jobs[0], 'TRANSLATE');
  assert.deepEqual([translation.retryCount, translation.fallbackCount, translation.attempts.length], [0, 1, 2]);
  assert.deepEqual(translation.attempts.map(a => [a.status, a.provider.providerId, a.charge.amount]),
    [['failed', 'provider-A', '0.1'], ['succeeded', 'alternate', '0.02']]);
  assert.equal(translation.attempts[1].lookupCount, 1);
  assert.deepEqual(translation.attempts[1].lookupMs, { value: 4, unit: 'ms', reason: null });
  assert.equal(jobs[1].initialization.mode, 'warm');
  assert.ok(jobs[3].reason);
  assert.equal(jobs[3].initialization.mode, null);
  assert.equal(row(jobs[3], 'TRANSLATE').fallbackCount, null);
  t.diagnostic('S16_SAMPLE ' + JSON.stringify({ lockId: result.lockId, jobsSha256: result.jobsSha256,
    plannedCells: result.summary.plannedCells, completedCells: result.summary.completedCells,
    plannedJobs: result.summary.plannedJobs, observedJobs: result.summary.observedJobs, completedJobs: result.summary.completedJobs,
    charge: result.summary.charge, cells: result.cells.map((c, i) => ({ model: c.condition.model, processing: c.condition.processing,
      jobId: jobs[i].jobId, status: jobs[i].status, reason: jobs[i].reason, charge: jobs[i].charge })),
    recoveredTranslation: { retryCount: translation.retryCount, fallbackCount: translation.fallbackCount,
      lookupCount: translation.attempts[1].lookupCount, attempts: translation.attempts.map(a => [a.status, a.charge.amount]) } }));
});

test('the intermediate pin and first executed stage fence the path and preserve cold and warm timings', () => {
  for (const fixed of [false, true]) {
    const { plan, anchors } = scenario({ fixed });
    const r = receiptFor(plan, plan.jobs[0], { mode: fixed ? 'warm' : 'cold' });
    const result = collectStage16Observations(plan, [r], anchors);
    const cell = result.cells[0], job = cell.jobs[0];
    assert.deepEqual(cell.path, { kind: fixed ? 'fixed_intermediate' : 'full_path',
      firstStage: fixed ? 'INPAINT' : 'OCR', intermediateSha256: r.intermediateSha256 });
    assert.deepEqual(job.stages.map(s => s.stage), fixed ? ['INPAINT', 'TYPESET'] : ['OCR', 'TRANSLATE', 'MASK', 'INPAINT', 'TYPESET']);
    assert.equal(job.initialization.elapsedMs.value, fixed ? 1 : 7);
    assert.deepEqual([job.elapsedMs.value, job.peakRamBytes.value, job.stages[0].elapsedMs.value, job.stages[0].peakRamBytes.value],
      [40, 900, 5, 100]);
    assert.equal(job.resultSha256, r.page.typesetting.subjectSha256);
    assert.equal(job.evidenceKind, 'synthetic');
    const foreign = structuredClone(r);
    foreign.intermediateSha256 = fixed ? null : '9'.repeat(64);
    assert.throws(() => collectStage16Observations(plan, [foreign], anchors), { code: 'STAGE16_CELL_MISMATCH' });
    if (fixed) {
      r.stages.unshift({ stage: 'OCR', attempts: [] });
      assert.throws(() => collectStage16Observations(plan, [r], anchors), { code: 'STAGE16_STAGE_MISMATCH' });
    }
  }
});

test('all locked pages keep four cells and repeated jobs stay separate under the same cell', () => {
  const { plan, anchors } = scenario({ secondPage: true });
  const warmJob = structuredClone(plan.jobs[0]);
  warmJob.binding.requestId = 'additional-warm-job';
  plan.jobs.push(warmJob);
  anchors.jobsSha256 = contentSha256(plan.jobs);
  const selected = [plan.jobs[0], plan.jobs[4], warmJob];
  const receipts = selected.map((job, i) => receiptFor(plan, job, { mode: i ? 'warm' : 'cold' }));
  const collect = rs => collectStage16Observations(plan, rs, anchors);
  assert.equal(collect(receipts.slice(0, 2)).summary.completedCells, 1);
  const result = collect(receipts);
  assert.deepEqual([result.summary.plannedCells, result.summary.plannedJobs, result.summary.completedCells,
    result.summary.completedJobs], [8, 9, 2, 3]);
  assert.deepEqual(result.cells[0].jobs.map(j => j.jobId), [selected[0].binding.requestId, 'additional-warm-job']);
  assert.deepEqual(result.cells[0].jobs.map(j => j.initialization.mode), ['cold', 'warm']);
  assert.equal(result.cells[4].workId, 'work-other');
  assert.deepEqual(collect([...receipts].reverse()), result);
});

test('the saved lock, canonical matrix and independent job register must all match', () => {
  for (const change of [
    (p, a) => { a.lockId = 'a'.repeat(64); },
    p => { p.lock.status = 'blocked'; },
    p => { p.lock.record.samples[0].workId = 'other'; },
    p => { p.matrices[0].conditions[1].processingSha256 = 'a'.repeat(64); },
    p => { p.matrices = []; },
    p => { p.jobs[0].primaryProvider.modelVersion = 'swapped'; },
    (p, a) => { p.jobs.pop(); a.jobsSha256 = contentSha256(p.jobs); },
    (p, a) => { p.jobs[1].binding.requestId = p.jobs[0].binding.requestId; a.jobsSha256 = contentSha256(p.jobs); },
    (p, a) => { p.jobs[0].firstStage = 'TYPESET'; a.jobsSha256 = contentSha256(p.jobs); },
  ]) {
    const { plan, anchors } = scenario();
    change(plan, anchors);
    assert.throws(() => collectStage16Observations(plan, [], anchors), e => typeof e.code === 'string');
  }
});

test('receipt identities, native provider bindings and evidence cannot move between jobs or stages', () => {
  for (const change of [
    r => { r.lockId = '0'.repeat(64); }, r => { r.matrixSha256 = '0'.repeat(64); },
    r => { r.page.identity.workId = 'another-work'; }, r => { r.page.pageId = 'other'; },
    r => { r.page.identity.ownerId = 'other'; }, r => { r.page.identity.processingGeneration++; },
    r => { r.page.sourceHashes.datasetEncodedSha256 = '0'.repeat(64); },
    r => { r.condition.modelSha256 = '0'.repeat(64); }, r => { r.condition.processingSha256 = '0'.repeat(64); },
    r => { r.stages[0].attempts[0].observations[0].observed.binding.inputDigest = '0'.repeat(64); },
    r => { r.stages[0].attempts[0].observations[0].observed.stage = 'TYPESET'; },
    r => { r.stages[0].attempts[0].observations[0].inputFingerprint = '0'.repeat(64); },
    r => { row(r, 'TRANSLATE').attempts[0].observations[0].provider.modelVersion = 'unregistered'; },
    r => { r.stages[0].attempts[0].observations[0].observed.attemptId = 'wrong-execution'; },
  ]) {
    const { plan, anchors } = scenario();
    const r = receiptFor(plan);
    change(r);
    assert.throws(() => collectStage16Observations(plan, [r], anchors), e => typeof e.code === 'string');
  }
  const { plan, anchors } = scenario();
  const first = receiptFor(plan), second = receiptFor(plan, plan.jobs[1]);
  const ref = first.stages[0].attempts[0].observations[0].charge.source;
  second.stages[0].attempts[0].observations[0].charge.source = ref;
  assert.throws(() => collectStage16Observations(plan, [first, second], anchors), { code: 'STAGE16_EVIDENCE_CONFLICT' });
  assert.throws(() => collectStage16Observations(plan, [first, { ...first, receiptId: 'other-id' }], anchors),
    { code: 'STAGE16_RECEIPT_CONFLICT' });
  const conflicting = structuredClone(first);
  conflicting.initialization.elapsedMs.value++;
  assert.throws(() => collectStage16Observations(plan, [first, conflicting], anchors), { code: 'STAGE16_RECEIPT_CONFLICT' });
});

test('missing stages and missing measurements retain specific reasons and an unknown charge', () => {
  const { plan, anchors } = scenario();
  const r = receiptFor(plan);
  r.initialization = null;
  r.stages = r.stages.filter(s => s.stage !== 'INPAINT');
  r.stages[0].peakRamBytes = { value: null, unit: 'bytes', reason: 'SAMPLER_OFFLINE' };
  delete r.stages[0].elapsedMs;
  r.page.processing.peakRamBytes = { value: null, unit: 'bytes', reason: 'PEAK_UNAVAILABLE' };
  const job = collectStage16Observations(plan, [r], anchors).cells[0].jobs[0];
  assert.equal(job.status, 'unknown');
  assert.equal(job.resultSha256, null);
  assert.equal(job.initialization.mode, null);
  assert.ok(job.initialization.reason);
  assert.deepEqual(job.peakRamBytes, r.page.processing.peakRamBytes);
  assert.deepEqual(job.stages[0].peakRamBytes, r.stages[0].peakRamBytes);
  assert.equal(job.stages[0].elapsedMs.value, null);
  assert.ok(job.stages[0].elapsedMs.reason);
  assert.equal(row(job, 'INPAINT').status, 'unknown');
  assert.equal(job.charge.amount, null);
  assert.ok(job.charge.reason);
});

test('a retry preserves the original failure, while unresolved results or region-only evidence cannot finish a stage', () => {
  const { plan, anchors } = scenario();
  const r = receiptFor(plan, plan.jobs[0], { states: { OCR: 'CONFIRMED_FAILURE' } });
  const attempts = r.stages[0].attempts;
  const retry = attemptFor(plan.jobs[0], 'OCR', { suffix: 'retry' });
  attempts.push(retry);
  const collect = () => collectStage16Observations(plan, [r], anchors).cells[0].jobs[0];
  assert.equal(collect().status, 'succeeded');
  assert.deepEqual(collect().stages[0].attempts.map(a => a.status), ['failed', 'succeeded']);
  assert.deepEqual([collect().stages[0].retryCount, collect().stages[0].fallbackCount], [1, 0]);
  attempts[0] = attemptFor(plan.jobs[0], 'OCR', { state: 'RESULT_UNKNOWN' });
  assert.equal(collect().status, 'unknown');
  attempts.shift();
  attempts[0] = attemptFor(plan.jobs[0], 'OCR', { regionId: 'r1', regionIds: ['r1'] });
  assert.notEqual(collect().status, 'succeeded');
});

test('page failure and missing or foreign final artifact evidence override apparent stage success', () => {
  const { plan, anchors } = scenario();
  for (const state of ['failed', 'interrupted', 'running', 'unknown']) {
    const r = receiptFor(plan);
    r.page.processing.status = state;
    r.page.processing.errorCode = 'PAGE_STOPPED';
    r.page.attempts = null;
    const job = collectStage16Observations(plan, [r], anchors).cells[0].jobs[0];
    assert.equal(job.status, state);
    assert.equal(job.reason, 'PAGE_STOPPED');
    assert.equal(job.resultSha256, null);
  }
  for (const pin of [null, 'a'.repeat(64)]) {
    const r = receiptFor(plan);
    r.page.typesetting.subjectSha256 = pin;
    const job = collectStage16Observations(plan, [r], anchors).cells[0].jobs[0];
    assert.equal(job.status, 'unknown');
    assert.equal(job.resultSha256, null);
  }
});

test('known zero and exact tiny decimals reconcile with the native Stage15 batch ledger', () => {
  const { plan, anchors } = scenario();
  const b = plan.jobs[0].binding;
  Object.assign(b, { batchId: 'batch', batchManifestSha256: 'b'.repeat(64) });
  anchors.jobsSha256 = contentSha256(plan.jobs);
  const r = receiptFor(plan, plan.jobs[0], { amounts: { TRANSLATE: '0.000000000001', TYPESET: '0.1' } });
  const rest = plan.jobs.slice(1).map(j => receiptFor(plan, j));
  const result = collectStage16Observations(plan, [r, ...rest], anchors);
  const peer = batchProviderUsage(row(r, 'TRANSLATE').attempts, { id: b.batchId, owner: b.ownerScope.id,
    projectId: b.projectId, fingerprint: b.batchManifestSha256, stage15ContextRevision: b.contextRevision },
  [{ jobId: b.requestId, pageId: b.pageId, pageNumber: b.pageNumber, sourceSha256: b.sourceSha256, status: 'completed',
    job: { batchId: b.batchId, processingGeneration: b.generation } }]).byJob.get(b.requestId);
  assert.equal(row(result.cells[0].jobs[0], 'TRANSLATE').charge.amount, peer.charge.amount);
  assert.equal(result.summary.charge.amount, '0.100000000001');
  assert.deepEqual([result.summary.completedCells, result.summary.completedJobs], [4, 4]);
});

test('the four pipeline stages accept bundled restoration and keep the native engine timing scope', () => {
  const { plan, anchors } = scenario();
  plan.jobs.forEach(j => { delete j.separateMask; });
  anchors.jobsSha256 = contentSha256(plan.jobs);
  const r = receiptFor(plan);
  const nativeTime = { value: 19, unit: 'ms', reason: null };
  r.page.processing.stageTimes = { inpaint: nativeTime };
  r.page.processing.timeScope = 'ENGINE_THROUGH_CANDIDATE_BEFORE_CLEANUP';
  delete row(r, 'INPAINT').elapsedMs;
  const job = collectStage16Observations(plan, [r], anchors).cells[0].jobs[0];
  assert.equal(job.status, 'succeeded');
  assert.deepEqual(job.stages.map(s => s.stage), ['OCR', 'TRANSLATE', 'INPAINT', 'TYPESET']);
  assert.deepEqual(row(job, 'INPAINT').elapsedMs, nativeTime);
  assert.equal(job.timeScope, r.page.processing.timeScope);
});

test('a provider timeout, its resolving lookup and uncovered regions remain visible in the history', () => {
  const { plan, anchors } = scenario();
  const r = receiptFor(plan, plan.jobs[0], { states: { INPAINT: 'PARTIAL' } });
  const stage = row(r, 'TRANSLATE'), resolved = lookup(stage.attempts[0]);
  const timedOut = attemptFor(plan.jobs[0], 'TRANSLATE', { state: 'RESULT_UNKNOWN', amount: null });
  const earlier = timedOut.observations[0];
  earlier.observed.errorCode = 'TIMEOUT';
  earlier.observed.evidenceRefs = [];
  earlier.providerObservation = null;
  earlier.evidenceFingerprint = null;
  timedOut.observations.push(resolved);
  stage.attempts = [timedOut];
  const job = collectStage16Observations(plan, [r], anchors).cells[0].jobs[0];
  const evidence = row(job, 'TRANSLATE').attempts[0].observations;
  assert.deepEqual(evidence.map(o => [o.operation, o.state, o.started, o.errorCode]),
    [['DISPATCH', 'RESULT_UNKNOWN', null, 'TIMEOUT'], ['LOOKUP', 'CONFIRMED_SUCCESS', true, null]]);
  assert.deepEqual(evidence.map(o => o.charge.amount), [null, '0']);
  assert.equal(row(job, 'TRANSLATE').status, 'succeeded');
  assert.deepEqual(row(job, 'INPAINT').attempts[0].observations[0].missingRegionIds, ['r2']);
  assert.equal(job.status, 'partial');
});

test('another request scope or a smaller retry cannot finish the original stage', () => {
  for (const narrower of [true, false]) {
    const { plan, anchors } = scenario();
    const r = receiptFor(plan, plan.jobs[0], { states: { OCR: 'PARTIAL' } });
    const retry = attemptFor(plan.jobs[0], 'OCR', { suffix: 'retry',
      ...(narrower ? { regionIds: ['r1'] } : { inputsSha256: 'a'.repeat(64) }) });
    r.stages[0].attempts.push(retry);
    assert.throws(() => collectStage16Observations(plan, [r], anchors), { code: 'STAGE16_STAGE_MISMATCH' });
  }
});

test('contradictory evidence cannot certify completion or manufacture a free pre-dispatch cancellation', () => {
  const { plan, anchors } = scenario();
  const collect = r => collectStage16Observations(plan, [r], anchors).cells[0].jobs[0];
  const partial = receiptFor(plan);
  partial.stages[0].attempts[0].observations[0].providerObservation.outcome = 'PARTIAL';
  assert.notEqual(collect(partial).status, 'succeeded');
  const missing = receiptFor(plan);
  missing.page.evidenceKind = 'not_run';
  assert.notEqual(collect(missing).status, 'succeeded');
  const conflict = receiptFor(plan);
  const a = conflict.stages[0].attempts[0], copy = lookup(a);
  copy.evidenceFingerprint = 'a'.repeat(64);
  a.observations.push(copy);
  assert.throws(() => collect(conflict), { code: 'STAGE15_EVIDENCE_CONFLICT' });
  const cancelled = receiptFor(plan);
  const c = cancelled.stages[0].attempts[0];
  Object.assign(c, { dispatchIntent: false, cancelled: true, observations: [], startEvidenceIds: ['provider-started'] });
  assert.throws(() => collect(cancelled), { code: 'STAGE16_STAGE_MISMATCH' });
});

test('a confirmed pre-dispatch reservation is free and ambiguous repeated lookups never inflate usage', () => {
  const { plan, anchors } = scenario();
  const r = receiptFor(plan, plan.jobs[0], { states: { TRANSLATE: 'CONFIRMED_FAILURE' }, amounts: { TRANSLATE: '0.2' } });
  const attempts = row(r, 'TRANSLATE').attempts, primary = attempts[0];
  const reserved = attemptFor(plan.jobs[0], 'TRANSLATE', { suffix: 'reserve', action: 'RESERVE_FALLBACK',
    provider: { ...plan.jobs[0].primaryProvider, providerId: 'alt' }, previousExecutionId: primary.request.input.executionId });
  Object.assign(reserved, { observations: [], dispatchIntent: false });
  const reply = lookup(primary);
  primary.observations.push(reply, structuredClone(reply));
  attempts.push(reserved);
  const job = collectStage16Observations(plan, [r], anchors).cells[0].jobs[0];
  const translation = row(job, 'TRANSLATE');
  assert.equal(job.status, 'failed');
  assert.equal(translation.charge.amount, '0.2');
  assert.equal(translation.fallbackCount, 0);
  assert.equal(translation.attempts[1].charge.amount, '0');
  assert.equal(translation.attempts[0].lookupCount, null);
  assert.ok(translation.attempts[0].lookupCountReason);
});

test('a copied zero without matching provider settlement evidence cannot enter the confirmed total', () => {
  const { plan, anchors } = scenario();
  for (const change of [
    o => { o.charge = { state: 'CONFIRMED', currency: 'USD', amount: '0', source: 'invented-fee' }; },
    o => {
      Object.assign(o.observed, { usageConfirmed: true, costUsd: '0' });
      o.charge = { state: 'CONFIRMED', currency: 'USD', amount: '0', source: 'invented-fee' };
    },
  ]) {
    const r = receiptFor(plan, plan.jobs[0], { amounts: { TRANSLATE: null } });
    change(row(r, 'TRANSLATE').attempts[0].observations[0]);
    assert.throws(() => collectStage16Observations(plan, [r], anchors), { code: 'STAGE16_SETTLEMENT_MISMATCH' });
  }
});

test('distinct model slots cannot use one identical provider version pin, while independently equal results remain separate', () => {
  const { plan, anchors } = scenario();
  const left = receiptFor(plan), right = receiptFor(plan, plan.jobs[2]);
  const sha = left.page.typesetting.subjectSha256;
  const typed = row(right, 'TYPESET').attempts[0].observations[0];
  typed.output.artifact.sha256 = sha;
  typed.observed.artifact.sha256 = sha;
  right.page.typesetting.subjectSha256 = sha;
  const result = collectStage16Observations(plan, [left, right], anchors);
  assert.equal(result.summary.completedJobs, 2);
  for (const job of plan.jobs) job.primaryProvider = { ...plan.jobs[0].primaryProvider };
  anchors.jobsSha256 = contentSha256(plan.jobs);
  assert.throws(() => collectStage16Observations(plan, [], anchors), { code: 'STAGE16_PLAN_MISMATCH' });
});

test('moving both journal labels to another registered cell cannot move the saved execution fingerprint', () => {
  const { plan, anchors } = scenario();
  const r = receiptFor(plan, plan.jobs[1]), source = attemptFor(plan.jobs[0], 'TRANSLATE');
  source.request.input.binding = structuredClone(plan.jobs[1].binding);
  source.observations[0].observed.binding = structuredClone(plan.jobs[1].binding);
  row(r, 'TRANSLATE').attempts = [source];
  assert.throws(() => collectStage16Observations(plan, [r], anchors), { code: 'STAGE16_STAGE_MISMATCH' });
});
