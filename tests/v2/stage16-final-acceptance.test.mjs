import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { contentSha256 } from '../../packages/evaluation/dataset-contract.mjs';
import { assessStage16Acceptance, assessStage16Start } from '../../packages/evaluation/stage16-final-acceptance.mjs';
import { buildStage16PairedReport } from '../../packages/evaluation/stage16-paired-report.mjs';
import { acceptanceScenario } from './fixtures/stage16-acceptance.mjs';
import { readerIds } from './fixtures/stage16-blind-review.mjs';
import { sha } from './fixtures/stage16-experiment.mjs';
import { attemptFor } from './fixtures/stage16-observations.mjs';
import { pairedScenario } from './fixtures/stage16-paired.mjs';

const official = ['experimentLock', 'conditionTable', 'humanAudit', 'uncertaintyPairedReport', 'costAdjustedSuccess'];
const officialFiles = { experimentLock: 'experiment-lock.json', conditionTable: 'condition-table.json', humanAudit: 'human-audit.json',
  uncertaintyPairedReport: 'uncertainty-paired-report.json', costAdjustedSuccess: 'cost-adjusted-success.json' };
const assess = fixture => assessStage16Acceptance(fixture.input, fixture.pins, 'synthetic');

function blocked(result, reason) {
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers.includes(reason), JSON.stringify(result.blockers));
}

test('a saved lock cannot start without current unused work evidence', () => {
  const { input, pins } = acceptanceScenario();
  delete input.experiment.holdoutHistory;
  blocked(assessStage16Start(input, pins, 'synthetic'), 'UNUSED_HOLDOUT_REQUIRED');
});

test('a locked four condition plan cannot start without scoped execution approval', () => {
  const { input, pins } = acceptanceScenario();
  delete input.approval;
  blocked(assessStage16Start(input, pins, 'synthetic'), 'EXECUTION_APPROVAL_REQUIRED');
});

test('a report with one missing assigned receipt cannot reach final acceptance', () => {
  const { input, pins } = acceptanceScenario({ editReceipts: rows => rows.pop() });
  blocked(assessStage16Acceptance(input, pins, 'synthetic'), 'EXECUTION_RECEIPTS_REQUIRED');
});

test('a report with only one returning reviewer cannot reach final acceptance', () => {
  const { input, pins } = acceptanceScenario({ editEnvelopes(rows) {
    const retained = rows.filter(r => r.reviewerId === readerIds[0]);
    rows.splice(0, rows.length, ...retained);
  } });
  blocked(assessStage16Acceptance(input, pins, 'synthetic'), 'INDEPENDENT_REVIEW_REQUIRED');
});

test('a missing or replaced pre-execution start commitment blocks final reconciliation', () => {
  const { input, pins } = acceptanceScenario();
  for (const startSha256 of [undefined, sha('another scope')]) {
    blocked(assessStage16Acceptance(input, { ...pins, startSha256 }, 'synthetic'), 'START_EVIDENCE_REQUIRED');
  }
});

test('subsequent approval cannot retroactively replace the one recorded at start', () => {
  const { input, pins } = acceptanceScenario();
  input.approval.approvalEvidenceSha256 = sha('later approval');
  pins.approvalSha256 = contentSha256(input.approval);
  blocked(assessStage16Acceptance(input, pins, 'synthetic'), 'START_EVIDENCE_REQUIRED');
});

test('approval facts absent from its pinned content cannot open the gate', () => {
  const { input, pins } = acceptanceScenario();
  delete input.approval.decision;
  pins.approvalSha256 = contentSha256(input.approval);
  Object.setPrototypeOf(input.approval, { decision: 'approved' });
  blocked(assessStage16Start(input, pins, 'synthetic'), 'EXECUTION_APPROVAL_REQUIRED');
});

test('start can precede every post-run artifact and its synthetic record is scoped', () => {
  const { input, pins } = acceptanceScenario();
  const { experiment, jobs, lock, approval } = input;
  const start = assessStage16Start({ experiment, jobs, lock, approval }, pins, 'synthetic');
  assert.equal(start.status, 'rehearsal_ready');
  assert.deepEqual(start.blockers, []);
  assert.equal(contentSha256(start.record), pins.startSha256);
  assert.equal(start.startSha256, pins.startSha256);
  blocked(assessStage16Start(input, pins), 'ACTUAL_HOLDOUT_REQUIRED');
});

test('exposed tuned and unauthorized works cannot reuse a previously valid start', () => {
  for (const change of ['opened', 'tuned_after_opening', 'rights']) {
    const { input, pins } = acceptanceScenario();
    const e = input.experiment;
    if (change === 'rights') {
      e.manifest.pages.find(p => p.split === 'holdout').provenance.rights = { status: 'unknown', evidence: null, allowedUses: [] };
    } else {
      e.holdoutHistory.push({ ...e.holdoutHistory[0], state: change });
      pins.holdoutHistorySha256 = contentSha256(e.holdoutHistory);
    }
    const start = assessStage16Start(input, pins, 'synthetic');
    assert.equal(start.status, 'blocked');
    assert.equal(start.record, null);
    if (change === 'tuned_after_opening') assert.equal(start.lock.replacementHoldoutRequired, true);
    assert.equal(assessStage16Acceptance(input, pins, 'synthetic').artifacts, null);
  }
});

test('an approval with foreign jobs foreign lock refusal or missing route evidence blocks start', () => {
  for (const edit of [{ jobsSha256: sha('other jobs') }, { lockId: sha('other lock') },
    { decision: 'refused' }, { routeReadinessSha256: null }, { approvalEvidenceSha256: null }]) {
    const { input, pins } = acceptanceScenario();
    Object.assign(input.approval, edit);
    pins.approvalSha256 = contentSha256(input.approval);
    blocked(assessStage16Start(input, pins, 'synthetic'), 'EXECUTION_APPROVAL_REQUIRED');
  }
});

test('changed model scope or an unassigned fourth cell blocks even a newly pinned job list', () => {
  for (const edit of [jobs => jobs.pop(), jobs => { jobs[0].primaryProvider.modelVersion = 'other-version'; }]) {
    const { input, pins } = acceptanceScenario();
    edit(input.jobs);
    pins.jobsSha256 = contentSha256(input.jobs);
    input.approval.jobsSha256 = pins.jobsSha256;
    pins.approvalSha256 = contentSha256(input.approval);
    blocked(assessStage16Start(input, pins, 'synthetic'), 'STAGE16_PLAN_MISMATCH');
  }
});

test('the five official artifacts reproduce the same locked cohort receipts returns and cost rows', t => {
  const { input, pins, observations, review } = acceptanceScenario();
  const result = assessStage16Acceptance(input, pins, 'synthetic');
  assert.equal(result.status, 'synthetic_reconciled');
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(Object.keys(result.artifacts), official);
  const { experimentLock, conditionTable, humanAudit, uncertaintyPairedReport, costAdjustedSuccess } = result.artifacts;
  assert.deepEqual(experimentLock, input.lock);
  assert.equal(contentSha256(experimentLock.record), pins.lockId);
  assert.deepEqual(conditionTable.observations, observations);
  assert.equal(conditionTable.lockId, pins.lockId);
  assert.equal(contentSha256(conditionTable.observations), pins.observationsSha256);
  for (const sample of experimentLock.record.samples) {
    const cells = observations.cells.filter(c => c.pageId === sample.pageId);
    const matrix = conditionTable.matrices.find(m => m.shared.pageId === sample.pageId);
    assert.equal(matrix.matrixSha256, sample.matrixSha256);
    assert.deepEqual(cells.map(c => c.condition), matrix.conditions);
    assert.ok(cells.every(c => c.workId === sample.workId && c.matrixSha256 === matrix.matrixSha256 && c.completed));
    for (const { jobs } of cells) for (const job of jobs) {
      assert.equal(job.receiptSha256, contentSha256(input.receipts.find(r => r.receiptId === job.receiptId)));
    }
  }
  assert.deepEqual(humanAudit.returns, review);
  assert.equal(humanAudit.returns.observationsSha256, pins.observationsSha256);
  assert.equal(humanAudit.returns.sealSha256, pins.sealSha256);
  assert.equal(new Set(humanAudit.reviewers.map(r => r.independenceGroup)).size, 2);
  assert.equal(humanAudit.returns.summary.overlapPairs, 2);
  assert.deepEqual(uncertaintyPairedReport, input.pairedReport);
  assert.equal(uncertaintyPairedReport.pins.reviewSha256, contentSha256(humanAudit.returns));
  assert.equal(costAdjustedSuccess.pairedReportSha256, contentSha256(uncertaintyPairedReport));
  for (const model of ['A', 'B']) assert.deepEqual(costAdjustedSuccess.models[model], uncertaintyPairedReport.models[model].costAdjusted);
  for (const name of official) assert.equal(result.artifactSha256[name], contentSha256(result.artifacts[name]));
  if (process.env.S16_CAPTURE_FINAL === '1') {
    t.diagnostic('S16_FINAL_SAMPLE ' + JSON.stringify({ pins, result, actualWithoutEvidence: assessStage16Acceptance() }));
  }
});

test('unfavorable tied and uncertain outcomes survive reconciliation without a winner requirement', () => {
  const { artifacts, status } = assess(acceptanceScenario());
  assert.equal(status, 'synthetic_reconciled');
  const { A, B } = artifacts.uncertaintyPairedReport.models;
  assert.deepEqual([A.primary.observed, B.primary.observed], ['worse', 'no_difference']);
  assert.deepEqual([A.primary.inference, B.primary.inference], ['inconclusive', 'inconclusive']);
  assert.equal(A.axes.semanticFidelity.uncertainty.workCount, 2);
  assert.equal(B.axes.naturalness.counts.tie, 2);
  assert.equal(A.costAdjusted.baseline.confirmedWins, 2);
  assert.equal(A.costAdjusted.comparison.amountUsd, '1');
  assert.equal(B.costAdjusted.comparison.usdPerWin.value, null);
});

test('a missing stage or attempt receipt keeps every planned cell and its original reason', () => {
  for (const [reason, edit] of [['STAGE_RECEIPT_MISSING', r => r[0].stages.pop()],
    ['ATTEMPT_RECEIPT_MISSING', r => { r[0].stages[1].attempts[0].observations = []; }]]) {
    const result = assess(acceptanceScenario({ editReceipts: edit }));
    blocked(result, 'EXECUTION_RECEIPTS_REQUIRED');
    const cells = result.artifacts.conditionTable.observations.cells;
    assert.equal(cells.length, 8);
    assert.deepEqual(cells.filter(c => !c.completed).map(c => c.jobs[0].reason), [reason]);
    assert.equal(result.artifacts.uncertaintyPairedReport.models.A.plannedPages, 2);
  }
});

test('an unsettled fee blocks final cost acceptance and preserves the confirmed subtotal', () => {
  const result = assess(acceptanceScenario({ editReceipts(receipts, plan) {
    receipts[0].stages[1].attempts = [attemptFor(plan.jobs[0], 'TRANSLATE', { amount: null })];
  } }));
  blocked(result, 'SETTLEMENT_RECEIPT_REQUIRED');
  const cost = result.artifacts.costAdjustedSuccess.models.A.comparison;
  assert.equal(cost.confirmedSubtotalUsd, '0.75');
  assert.equal(cost.amountUsd, null);
  assert.equal(cost.winsPerUsd.value, null);
  assert.equal(cost.unsettledJobs, 1);
});

test('a later success and a billing reference cannot hide a failed attempt without an execution receipt', () => {
  const f = acceptanceScenario({ editReceipts(rows, plan) {
    const failed = attemptFor(plan.jobs[0], 'TRANSLATE', { suffix: 'first', state: 'CONFIRMED_FAILURE' });
    rows[0].stages[1].attempts.unshift(failed);
  } });
  const stage = assess(f).artifacts.conditionTable.observations.cells[0].jobs[0].stages[1];
  assert.deepEqual(stage.attempts.map(a => a.status), ['failed', 'succeeded']);
  assert.equal(stage.charge.state, 'CONFIRMED');
  const earlier = f.input.receipts[0].stages[1].attempts[0].observations[0];
  earlier.observed.evidenceRefs = [];
  earlier.providerObservation.evidenceId = null;
  blocked(assess(f), 'STAGE15_USAGE_INVALID');
});

test('every scheduled ballot needs both axes even if another overlap is fully answered', () => {
  const result = assess(acceptanceScenario({ editEnvelopes(rows) { delete rows[0].responses[0].naturalness; } }));
  blocked(result, 'INDEPENDENT_REVIEW_REQUIRED');
  assert.equal(result.artifacts.humanAudit.returns.summary.partial, 1);
});

test('two independent submitted judgments can disagree or explicitly abstain', () => {
  const result = assess(acceptanceScenario({ editEnvelopes(rows, seal) {
    const pair = seal.pairs.find(p => p.assignments.length === 2);
    const ticket = pair.assignments[0].assignmentId;
    const answer = rows.find(row => row.responses[0].assignmentId === ticket).responses[0];
    answer.naturalness = 'A';
    answer.semanticFidelity = 'cannot_assess';
  } }));
  assert.equal(result.status, 'synthetic_reconciled');
  const audit = result.artifacts.humanAudit.returns;
  assert.ok(audit.pairs.some(p => p.comparison.naturalness === 'open_disagreement' && p.comparison.semanticFidelity === 'not_comparable'));
  assert.ok(audit.pairs.some(p => p.assignments.some(a => a.semanticFidelity.reason === 'REVIEWER_CANNOT_ASSESS')));
});

test('an axis with no assessable independent overlap cannot be accepted on returned forms alone', () => {
  const result = assess(acceptanceScenario({ editEnvelopes(rows, seal) {
    const overlap = new Set(seal.pairs.filter(p => p.assignments.length === 2)
      .flatMap(p => p.assignments.map(a => a.assignmentId)));
    for (const row of rows) if (overlap.has(row.responses[0].assignmentId)) row.responses[0].naturalness = 'cannot_assess';
  } }));
  blocked(result, 'INDEPENDENT_REVIEW_REQUIRED');
  const audit = result.artifacts.humanAudit.returns;
  assert.equal(audit.summary.answered, audit.summary.plannedAssignments);
  assert.ok(audit.pairs.filter(p => p.assignments.length === 2).every(p => p.comparison.naturalness === 'not_comparable'));
});

test('a replayed receipt counts once and a receipt for a foreign job blocks the dossier', () => {
  const f = acceptanceScenario();
  f.input.receipts.push(structuredClone(f.input.receipts[0]));
  assert.equal(assess(f).artifacts.conditionTable.observations.summary.observedJobs, 8);
  f.input.receipts.at(-1).page.identity.jobId = 'foreign-job';
  blocked(assess(f), 'STAGE16_CELL_MISMATCH');
});

test('substituted downstream pins or an edited effect or cost report cannot be accepted', () => {
  const f = acceptanceScenario();
  for (const [pin, blocker] of Object.entries({ observationsSha256: 'STAGE16_OBSERVATIONS_PIN_MISMATCH',
    sealSha256: 'STAGE16_REVIEW_SEAL_MISMATCH', reviewSha256: 'STAGE16_RETURNS_PIN_MISMATCH',
    automaticSha256: 'STAGE16_REPORT_PIN_MISMATCH', reportSha256: 'STAGE16_PAIRED_REPORT_MISMATCH' })) {
    blocked(assessStage16Acceptance(f.input, { ...f.pins, [pin]: sha('foreign') }, 'synthetic'), blocker);
  }
  for (const edit of [r => { r.models.A.primary.observed = 'meets_minimum_effect'; },
    r => { r.models.B.costAdjusted.comparison.amountUsd = '0'; }]) {
    const changed = structuredClone(f);
    edit(changed.input.pairedReport);
    changed.pins.reportSha256 = contentSha256(changed.input.pairedReport);
    blocked(assess(changed), 'STAGE16_PAIRED_REPORT_MISMATCH');
  }
});

test('receipt and ballot evidence kinds cannot be mixed into a synthetic reconciliation', () => {
  const differentReceipt = assess(acceptanceScenario({ editReceipts(rows) { rows[0].page.evidenceKind = 'component'; } }));
  blocked(differentReceipt, 'EXECUTION_EVIDENCE_KIND_MISMATCH');
  const differentBallot = assess(acceptanceScenario({ editEnvelopes(rows) { rows[0].evidenceKind = 'human_submission'; } }));
  blocked(differentBallot, 'INDEPENDENT_REVIEW_REQUIRED');
});

test('empty actual evidence and a complete synthetic dossier both leave actual gates blocked', () => {
  const absent = assessStage16Acceptance();
  assert.deepEqual(assessStage16Acceptance(null, null), absent);
  assert.deepEqual(assessStage16Start(null, null), absent.start);
  assert.deepEqual(absent.start.blockers, ['UNUSED_HOLDOUT_REQUIRED', 'EXECUTION_APPROVAL_REQUIRED']);
  assert.deepEqual(absent.blockers, [...absent.start.blockers, 'START_EVIDENCE_REQUIRED', 'EXECUTION_RECEIPTS_REQUIRED',
    'INDEPENDENT_REVIEW_REQUIRED', 'PAIRED_REPORT_REQUIRED']);
  assert.equal(absent.artifacts, null);
  const { input, pins } = acceptanceScenario();
  const actual = assessStage16Acceptance(input, pins);
  blocked(actual, 'ACTUAL_HOLDOUT_REQUIRED');
  blocked(actual, 'EXECUTION_APPROVAL_REQUIRED');
  assert.equal(actual.start.status, 'blocked');
  assert.equal(actual.artifacts, null);
});

test('self-labelled human submissions still need two independent authenticated return records', () => {
  const { input, pins } = acceptanceScenario({ unverifiedActualLabels: true });
  blocked(assessStage16Acceptance(input, pins), 'ACTUAL_HOLDOUT_REQUIRED');
  // Simulate the upstream manifest check only. No identity record or real submission is supplied.
  pins.verifiedActual = { holdoutLockId: pins.lockId };
  const result = assessStage16Acceptance(input, pins);
  blocked(result, 'AUTHENTICATED_HUMAN_RETURNS_REQUIRED');
  assert.equal(result.artifacts.humanAudit.returns.reviewerAuthentication, 'unverified_offline_submission');
  const reviewer = { ...result.artifacts.humanAudit.reviewers[0], sealSha256: pins.sealSha256, reviewSha256: pins.reviewSha256,
    authenticationEvidenceSha256: sha('one simulated identity receipt') };
  for (const reviewers of [[reviewer], [reviewer, reviewer]]) {
    pins.verifiedActual.reviewers = reviewers;
    blocked(assessStage16Acceptance(input, pins), 'AUTHENTICATED_HUMAN_RETURNS_REQUIRED');
  }
});

test('the S16-05 handoff report replays exactly and cannot substitute for a start receipt', () => {
  const file = new URL('../../docs/validation/stage16-05-20261119/synthetic-report.json', import.meta.url);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  const previous = pairedScenario();
  assert.deepEqual(buildStage16PairedReport(previous.input, previous.anchors), saved);
  const result = assessStage16Acceptance({ ...previous.input, pairedReport: saved }, previous.anchors, 'synthetic');
  blocked(result, 'START_EVIDENCE_REQUIRED');
  blocked(result, 'EXECUTION_APPROVAL_REQUIRED');
  assert.equal(result.artifacts, null);
});

test('all five saved JSON artifacts reopen against the index and the independent synthetic replay', () => {
  const dir = new URL('../../docs/validation/stage16-06-20261119/', import.meta.url);
  const read = filename => JSON.parse(readFileSync(new URL(filename, dir), 'utf8'));
  const index = read('synthetic-index.json');
  const fixture = acceptanceScenario();
  const replay = assess(fixture);
  assert.equal(index.scope, 'synthetic');
  assert.equal(index.status, replay.status);
  assert.deepEqual(index.blockers, []);
  assert.deepEqual(index.pins, fixture.pins);
  assert.equal(contentSha256(index.start), fixture.pins.startSha256);
  assert.deepEqual(index.actualWithoutEvidence, assessStage16Acceptance());
  assert.deepEqual(index.artifactSha256, replay.artifactSha256);
  assert.deepEqual(index.files, officialFiles);
  for (const name of official) {
    const saved = read(officialFiles[name]);
    assert.equal(contentSha256(saved), index.artifactSha256[name]);
    assert.deepEqual(saved, replay.artifacts[name]);
  }
});
