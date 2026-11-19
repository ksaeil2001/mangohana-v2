import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { contentSha256 } from '../../packages/evaluation/dataset-contract.mjs';
import { collectStage16BlindReturns } from '../../packages/evaluation/stage16-blind-review.mjs';
import * as paired from '../../packages/evaluation/stage16-paired-report.mjs';
import { pairedScenario, pages } from './fixtures/stage16-paired.mjs';
import { reviewScenario } from './fixtures/stage16-blind-review.mjs';
import { receiptFor } from './fixtures/stage16-observations.mjs';
import { addHoldoutPage, sha } from './fixtures/stage16-experiment.mjs';

function report(fixture = pairedScenario()) {
  return paired.buildStage16PairedReport(fixture.input, fixture.anchors);
}

function close(actual, expected, tolerance = 1e-12) {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < tolerance, String(actual) + ' vs ' + expected);
}

test('five pages in three works supply three units for model A uncertainty', () => {
  assert.equal(report().models.A.axes.semanticFidelity.uncertainty.workCount, 3);
});

test('the missing fifth pair stays in the denominator of confirmed improvement', () => {
  const share = report().models.A.axes.semanticFidelity.confirmedImprovedShare;
  assert.deepEqual([share.numerator, share.denominator, share.value], [2, 5, 0.4]);
});

test('a tied blind preference counts as a tie and earns no win', () => {
  const counts = report().models.A.axes.semanticFidelity.counts;
  assert.deepEqual([counts.tie, counts.improved], [1, 2]);
});

test('equal work weights reverse the sign of model B page pooling and preserve raw paired scores', () => {
  const { A, B } = report().models;
  const byWork = Object.fromEntries(B.works.map(w => [w.workId, w.axes.semanticFidelity]));
  close(byWork['work-final'].pairedEffect.value, -2 / 3);
  assert.equal(byWork['work-other'].pairedEffect.value, 1);
  assert.equal(byWork['work-last'].pairedEffect.value, 0);
  close(B.axes.semanticFidelity.pairedEffect.value, 1 / 9);
  assert.equal(B.axes.semanticFidelity.counts.improved - B.axes.semanticFidelity.counts.baseline, -1);
  assert.equal(B.primary.observed, 'below_minimum_effect');
  assert.equal(B.axes.naturalness.pairedEffect.value, 0);
  assert.equal(B.noninferiority.observedWithinMargin, true);
  assert.equal(B.noninferiority.supported, null);
  const a1 = A.works.find(w => w.workId === 'work-final').pages.find(p => p.pageId === pages[0]).axes.semanticFidelity;
  assert.deepEqual([a1.automatic.baseline.value, a1.automatic.improved.value, a1.automatic.delta], [0.5, 0.75, 0.25]);
  close(B.axes.semanticFidelity.automaticEffect.value, -1 / 9);
});

test('missing votes bound the full work effect without becoming ties or losses', () => {
  const { A } = report().models;
  assert.deepEqual(A.axes.semanticFidelity.counts, { improved: 2, baseline: 1, tie: 1, missing: 1 });
  const axis = A.axes.semanticFidelity;
  assert.equal(axis.pairedEffect.value, null);
  close(axis.pairedEffect.lower, -4 / 9);
  close(axis.pairedEffect.upper, 2 / 9);
  close(A.axes.naturalness.pairedEffect.lower, -1 / 3);
  close(A.axes.naturalness.pairedEffect.upper, 5 / 9);
  assert.equal(axis.availability.value, 4 / 5);
  assert.equal(axis.uncertainty.completeWorks, 2);
  assert.equal(A.primary.observed, 'incomplete');
  assert.equal(A.works.find(w => w.workId === 'work-last').pages[0].axes.semanticFidelity.human.reason, 'RESULT_PAIR_UNAVAILABLE');
});

test('each axis compares one resolved blind preference to its automatic direction per pair', () => {
  const { A, B } = report().models;
  for (const [axis, wrong, comparable] of [[A.axes.semanticFidelity, 1, 4], [A.axes.naturalness, 0, 2],
    [B.axes.semanticFidelity, 2, 5], [B.axes.naturalness, 0, 5]]) {
    assert.deepEqual([axis.disagreement.numerator, axis.disagreement.denominator, axis.disagreement.value,
      axis.disagreement.plannedPairs, axis.disagreement.uncompared], [wrong, comparable, wrong / comparable, 5, 5 - comparable]);
  }
  const conflict = A.works.flatMap(w => w.pages).find(p => p.pageId === pages[2]).axes.naturalness;
  assert.equal(conflict.human.reason, 'OPEN_REVIEW_DISAGREEMENT');
  assert.equal(conflict.disagrees, null);
  assert.deepEqual(conflict.human.votes.map(v => v.preference).sort(), ['baseline', 'improved']);
  assert.equal(A.works.flatMap(w => w.pages).find(p => p.pageId === pages[3]).axes.naturalness.automatic.improved.reason, 'AXIS_NOT_SCORED');
});

test('exact zero event upper limits distinguish 298 and 299 independent observations', () => {
  const examples = report().independentZeroDefectExamples;
  assert.deepEqual(examples.map(e => e.independentUnits), [100, 299]);
  close(examples[0].upper95, 0.02951305, 1e-8);
  close(examples[1].upper95, 0.00996915, 1e-8);
  assert.ok(paired.zeroEventUpper95(298) > 0.01 && paired.zeroEventUpper95(299) < 0.01);
  for (const n of [0, -1, 0.5, NaN, Infinity]) assert.throws(() => paired.zeroEventUpper95(n));
});

test('work uncertainty uses three bounded work means and counts a work with any mismatch once', () => {
  const { A, B } = report().models;
  const u = B.axes.semanticFidelity.uncertainty;
  assert.equal(u.workCount, 3);
  close(u.halfWidth95, 1.5682, 0.001);
  assert.deepEqual(u.interval95, { lower: -1, upper: 1 });
  assert.equal(B.primary.inference, 'inconclusive');
  assert.deepEqual([u.workDisagreement.events, u.workDisagreement.unknownWorks, u.workDisagreement.zeroEventUpper95], [2, 0, null]);
  close(B.axes.naturalness.uncertainty.workDisagreement.zeroEventUpper95, 0.63159685, 1e-8);
  assert.equal(A.axes.naturalness.uncertainty.workDisagreement.zeroEventUpper95, null);
});

test('known dependence across works withholds independent work limits', () => {
  const b = report(pairedScenario({ lastGroup: 'group-work-other' })).models.B;
  assert.equal(b.axes.semanticFidelity.uncertainty.interval95, null);
  assert.equal(b.axes.semanticFidelity.uncertainty.reason, 'SHARED_GROUP_OR_CONTEXT');
  assert.equal(b.axes.naturalness.uncertainty.workDisagreement.zeroEventUpper95, null);
  close(b.axes.semanticFidelity.pairedEffect.value, 1 / 9);
});

test('three pages from a single work can show worsening but supply no between work interval', () => {
  const f = pairedScenario({ overlapPageCount: 1, configure(e) {
    e.matrices = e.matrices.filter(m => m.shared.workId === 'work-final');
    e.preregistration.source_and_gt_hashes = e.preregistration.source_and_gt_hashes.filter(p => pages.slice(0, 3).includes(p.pageId));
  } });
  const b = report(f).models.B;
  close(b.axes.semanticFidelity.pairedEffect.value, -2 / 3);
  assert.equal(b.primary.observed, 'worse');
  assert.equal(b.primary.inference, 'insufficient_works');
  assert.equal(b.axes.semanticFidelity.uncertainty.interval95, null);
  assert.equal(b.axes.semanticFidelity.uncertainty.workCount, 1);
});

test('cost counts every assigned charge and only a resolved fidelity win earns credit', () => {
  const { A, B } = report().models;
  const costs = B.costAdjusted;
  for (const [row, wins, money, perUsd, perWin] of [
    [costs.baseline, 2, '0.5', 4, 0.25], [costs.improved, 1, '1', 1, 1], [costs.comparison, 1, '1.5', 2 / 3, 1.5],
  ]) {
    assert.equal(row.confirmedWins, wins);
    assert.equal(row.amountUsd, money);
    close(row.winsPerUsd.value, perUsd);
    close(row.usdPerWin.value, perWin);
  }
  const unknown = A.costAdjusted.improved;
  assert.deepEqual([unknown.confirmedWins, unknown.missingPairs, unknown.confirmedSubtotalUsd, unknown.amountUsd], [2, 1, '1', null]);
  assert.equal(unknown.winsPerUsd.reason, 'CHARGE_EVIDENCE_INCOMPLETE');
  assert.equal(unknown.usdPerWin.value, null);
  assert.equal(A.costAdjusted.comparison.confirmedSubtotalUsd, '1.5');
  assert.equal(A.costAdjusted.baseline.winsPerUsd.reason, 'PAIR_OUTCOME_INCOMPLETE');
});

test('zero charge and zero wins have distinct undefined inverse rates', () => {
  const f = pairedScenario({ editReceipts(receipts, plan) {
    for (const [i, job] of plan.jobs.entries()) if (job.model === 'B') receipts[i] = receiptFor(plan, job);
  } });
  const b = report(f).models.B;
  assert.deepEqual([b.costAdjusted.improved.amountUsd, b.costAdjusted.improved.winsPerUsd.value,
    b.costAdjusted.improved.winsPerUsd.reason, b.costAdjusted.improved.usdPerWin.value], ['0', null, 'ZERO_COST', 0]);
  const noWins = b.works.find(w => w.workId === 'work-last').costAdjusted.baseline;
  assert.equal(noWins.usdPerWin.reason, 'NO_WINS');
});

test('a charged repeat with a different final result costs money without earning a second pair', () => {
  const f = pairedScenario({ editJobs(jobs) {
    const job = structuredClone(jobs.find(j => j.model === 'B' && j.pageId === pages[3] && j.processing === 'improved'));
    job.binding.requestId += ':repeat';
    jobs.push(job);
  }, editReceipts(receipts, plan) {
    receipts[receipts.length - 1] = receiptFor(plan, plan.jobs.at(-1), { amounts: { TRANSLATE: '0.000000000001' } });
  } });
  const b = report(f).models.B;
  assert.equal(b.costAdjusted.improved.amountUsd, '1.000000000001');
  assert.equal(b.costAdjusted.improved.confirmedWins, 0);
  assert.equal(b.costAdjusted.improved.missingPairs, 1);
  assert.equal(b.costAdjusted.improved.winsPerUsd.value, null);
  assert.equal(b.axes.semanticFidelity.confirmedImprovedShare.denominator, 5);
  assert.equal(b.works.find(w => w.workId === 'work-other').pages[0].conditions.improved.reason, 'MULTIPLE_FINAL_RESULTS');
});

test('an all tie primary with a frozen zero minimum never supports improvement', () => {
  const f = pairedScenario({ minimumEffect: 0, editEnvelopes(env) {
    for (const e of env) e.responses[0].semanticFidelity = 'tie';
  } });
  const b = report(f).models.B;
  assert.equal(b.axes.semanticFidelity.counts.tie, 5);
  assert.equal(b.primary.observed, 'no_difference');
  assert.equal(b.primary.inference, 'inconclusive');
  assert.equal(b.costAdjusted.improved.winsPerUsd.value, 0);
});

test('exactly cancelling fractional work effects cannot win through floating point rounding', () => {
  const f = pairedScenario({ minimumEffect: 0, configure(e) {
    for (const work of ['work-other', 'work-last']) for (const suffix of ['extra', 'tie']) addHoldoutPage(e, work, work + '-' + suffix);
  }, editEnvelopes(envelopes, seal) {
    const responses = new Map(envelopes.map(e => [e.responses[0].assignmentId, e.responses[0]]));
    for (const p of seal.pairs.filter(p => p.model === 'B')) for (const a of p.assignments) {
      const win = p.workId === 'work-final' ? 'improved' : p.pageId.endsWith('-tie') || p.pageId === 'work-last-extra' ? 'tie' : 'baseline';
      responses.get(a.assignmentId).semanticFidelity = win === 'tie' ? 'tie' : a.A.processing === win ? 'A' : 'B';
    }
  } });
  const b = report(f).models.B;
  // Exactly (1 - 2/3 - 1/3) / 3. The three works also give equal and opposite paired votes.
  assert.equal(b.primary.observed, 'no_difference');
  assert.deepEqual(b.axes.semanticFidelity.pairedEffect, { value: 0, lower: 0, upper: 0 });
});

test('registered minimum effect and naturalness margin govern distinct observations', () => {
  const f = pairedScenario({ minimumEffect: 1 / 12, editEnvelopes(envelopes, seal) {
    for (const p of seal.pairs.filter(p => p.model === 'B')) for (const a of p.assignments) {
      envelopes.find(e => e.responses[0].assignmentId === a.assignmentId).responses[0].naturalness = a.A.processing === 'baseline' ? 'A' : 'B';
    }
  } });
  const b = report(f).models.B;
  assert.equal(b.primary.observed, 'meets_minimum_effect');
  assert.equal(b.primary.inference, 'inconclusive');
  assert.equal(b.noninferiority.margin, 0.02);
  assert.equal(b.noninferiority.observedWithinMargin, false);
  close(b.axes.naturalness.uncertainty.interval95.upper, 0.56820055, 1e-8);
});

test('twelve independent synthetic works can clear a minimum only through the work interval', () => {
  const f = pairedScenario({ configure(e) {
    for (let n = 0; n < 9; n++) addHoldoutPage(e, 'independent-' + n, 'added-page-' + n);
  }, editEnvelopes(envelopes, seal) {
    const byId = new Map(envelopes.map(e => [e.responses[0].assignmentId, e.responses[0]]));
    for (const p of seal.pairs.filter(p => p.model === 'B')) for (const a of p.assignments) {
      const side = a.A.processing === 'improved' ? 'A' : 'B';
      Object.assign(byId.get(a.assignmentId), { semanticFidelity: side, naturalness: side });
    }
  } });
  const b = report(f).models.B;
  assert.equal(b.axes.semanticFidelity.uncertainty.workCount, 12);
  close(b.axes.semanticFidelity.uncertainty.interval95.lower, 0.2158997243, 1e-8);
  assert.equal(b.primary.inference, 'supports_improvement');
  assert.equal(b.noninferiority.supported, true);
});

test('an unsettled fee on a completed winning cell keeps the full cost unknown', () => {
  const f = pairedScenario({ editReceipts(receipts, plan) {
    const i = plan.jobs.findIndex(j => j.pageId === pages[3] && j.model === 'B' && j.processing === 'improved');
    receipts[i] = receiptFor(plan, plan.jobs[i], { amounts: { TRANSLATE: null, TYPESET: '0.05' } });
  } });
  const row = report(f).models.B.costAdjusted.improved;
  assert.deepEqual([row.confirmedWins, row.missingPairs, row.amountUsd, row.confirmedSubtotalUsd], [1, 0, null, '0.85']);
  assert.equal(row.winsPerUsd.reason, 'CHARGE_EVIDENCE_INCOMPLETE');
});

test('empty scores and empty ballots keep every planned comparison with null rates', () => {
  const f = pairedScenario({ editEnvelopes: e => e.splice(0) });
  f.input.automatic.rows = [];
  f.anchors.automaticSha256 = contentSha256(f.input.automatic);
  const b = report(f).models.B;
  assert.deepEqual(b.axes.semanticFidelity.counts, { improved: 0, baseline: 0, tie: 0, missing: 5 });
  assert.deepEqual([b.axes.semanticFidelity.disagreement.value, b.axes.semanticFidelity.disagreement.reason,
    b.axes.semanticFidelity.uncertainty.interval95], [null, 'NO_COMPARABLE_PAIRS', null]);
  assert.equal(b.costAdjusted.improved.amountUsd, '1');
  assert.equal(b.costAdjusted.improved.winsPerUsd.value, null);
});

test('one abstention or unreturned overlap ballot leaves the pair unresolved', () => {
  const f = pairedScenario({ editEnvelopes(envelopes, seal) {
    const a = seal.pairs.find(p => p.model === 'B' && p.pageId === pages[0]).assignments[0];
    const response = envelopes.find(e => e.responses[0].assignmentId === a.assignmentId).responses[0];
    response.semanticFidelity = 'cannot_assess';
    delete response.naturalness;
  } });
  const p = report(f).models.B.works.flatMap(w => w.pages).find(p => p.pageId === pages[0]);
  assert.equal(p.axes.semanticFidelity.human.reason, 'REVIEWER_CANNOT_ASSESS');
  assert.equal(p.axes.naturalness.human.reason, 'AXIS_UNANSWERED');
  assert.equal(p.axes.semanticFidelity.disagrees, null);
});

test('substituting any independently retained pin or the registered policy blocks the report', () => {
  const f = pairedScenario();
  for (const k of ['lockId', 'jobsSha256', 'observationsSha256', 'sealSha256', 'reviewSha256', 'automaticSha256']) {
    assert.throws(() => paired.buildStage16PairedReport(f.input, { ...f.anchors, [k]: sha('other') }), { code: 'STAGE16_REPORT_PIN_MISMATCH' });
  }
  f.input.preregistration.primary_metric_and_minimum_effect.minimumEffect = 0;
  assert.throws(() => report(f), { code: 'STAGE16_REPORT_PIN_MISMATCH' });
  const unsupported = pairedScenario({ configure(e) { e.preregistration.primary_metric_and_minimum_effect.metric = 'another_metric'; } });
  assert.throws(() => report(unsupported), { code: 'STAGE16_REPORT_CRITERIA_UNSUPPORTED' });
});

test('duplicate missing foreign or cross model ledger rows cannot shrink or reassign the frozen cohort', () => {
  for (const alter of [r => r.pairs.pop(), r => r.pairs.push(r.pairs[0]), r => { r.pairs[0].workId = 'other'; },
    r => { r.pairs[0].results.improved = r.pairs[1].results.improved; }]) {
    const f = pairedScenario();
    alter(f.input.review);
    f.anchors.reviewSha256 = contentSha256(f.input.review);
    assert.throws(() => report(f), { code: 'STAGE16_REPORT_COHORT_MISMATCH' });
  }
});

test('a scored cell must match the frozen evaluator final bytes and numeric axis', () => {
  for (const alter of [a => { a.evaluatorSha256 = sha('different-evaluator'); }, a => a.rows.push(a.rows[0]),
    a => { a.rows[0].resultSha256 = sha('foreign'); }, a => { a.rows[0].model = 'B'; },
    a => { a.rows[0].semanticFidelity.value = 1.1; }, a => { a.rows[0].naturalness = { value: null, unit: 'ratio', reason: null }; }]) {
    const f = pairedScenario();
    alter(f.input.automatic);
    f.anchors.automaticSha256 = contentSha256(f.input.automatic);
    assert.throws(() => report(f));
  }
});

test('report records the evidence kinds and replays the saved synthetic example', t => {
  const f = pairedScenario();
  const output = report(f);
  assert.deepEqual(output.evidence.reviewKinds, ['synthetic']);
  assert.deepEqual(output.evidence.executionKinds, ['synthetic']);
  assert.equal(output.evidence.automaticKind, 'synthetic');
  assert.equal(output.evidence.reviewerAuthentication, 'unverified_offline_submission');
  assert.deepEqual(report(structuredClone(f)), output);
  if (process.env.S16_CAPTURE_PAIRED_SAMPLE === '1') t.diagnostic('S16_PAIRED_EXAMPLE ' + JSON.stringify(output));
});

test('the previous handoff sealed synthetic returns feed the report with their original missing slots', () => {
  const sample = name => JSON.parse(readFileSync(new URL('../../docs/validation/stage16-04-20261119/' + name, import.meta.url), 'utf8'));
  const { seal, envelopes } = sample('synthetic-coordinator.json');
  const { sealSha256 } = sample('synthetic-recovery.json');
  const missing = new Set(seal.pairs.flatMap(p => Object.values(p.results).flatMap(c => c.jobs.filter(j => j.receiptSha256 === null).map(j => j.jobId))));
  const f = reviewScenario({ editReceipts(receipts) {
    const retained = receipts.filter(r => !missing.has(r.page.identity.jobId));
    receipts.splice(0, receipts.length, ...retained);
  } });
  assert.equal(f.anchors.observationsSha256, seal.observationsSha256);
  const review = collectStage16BlindReturns(seal, sealSha256, envelopes);
  const automatic = { kind: 'stage16-automatic-scores', schemaVersion: 1, evidenceKind: 'synthetic',
    lockId: seal.lockId, observationsSha256: seal.observationsSha256, evaluatorSha256: f.input.preregistration.evaluator_and_policy_version.evaluatorSha256, rows: [] };
  const { A, B } = report({ input: { ...f.input, review, automatic }, anchors: { ...f.anchors, sealSha256,
    reviewSha256: contentSha256(review), automaticSha256: contentSha256(automatic) } }).models;
  assert.deepEqual([A.axes.semanticFidelity.counts.missing, A.axes.naturalness.counts.improved, B.axes.semanticFidelity.counts.missing], [2, 1, 2]);
  assert.equal(B.costAdjusted.improved.amountUsd, null);
});
