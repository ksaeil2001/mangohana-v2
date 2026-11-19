import Decimal from 'decimal.js';
import { formatUsd, usdUnits } from '../../apps/engine/stage15-batch-accounting.mjs';
import { contentSha256 } from './dataset-contract.mjs';
import { digest, equal, identifier, measurement, ratio, requireValue, unknown } from './offline/contract.mjs';
import { calculatePolicyMetric } from './policy/policy.mjs';
import policy from './policy/stage08-v1.1.json' with { type: 'json' };

const axes = ['semanticFidelity', 'naturalness'];
const variants = ['baseline', 'improved'];
const modelSlots = ['A', 'B'];
const pinError = 'STAGE16_REPORT_PIN_MISMATCH';
const cohortError = 'STAGE16_REPORT_COHORT_MISMATCH';
const scoreError = 'STAGE16_REPORT_AUTOMATIC_MISMATCH';
const key = (...parts) => JSON.stringify(parts);
const sign = { improved: 1, baseline: -1, tie: 0 };

function checkPin(record, pin) {
  requireValue(record && digest(pin) && contentSha256(record) === pin, pinError);
}

function checkInputs({ lock, preregistration, observations, review, automatic }, pins) {
  checkPin(lock?.record, pins?.lockId);
  checkPin(preregistration, lock.record.preregistrationSha256);
  checkPin(observations, pins.observationsSha256);
  checkPin(review, pins.reviewSha256);
  checkPin(automatic, pins.automaticSha256);
  requireValue(lock.status === 'locked' && lock.lockId === pins.lockId && lock.record.kind === 'stage16-experiment-lock' &&
    observations.kind === 'stage16-execution-observations' && review.kind === 'stage16-blind-returns' &&
    automatic.kind === 'stage16-automatic-scores' && [lock.record, observations, review, automatic].every(r => r.schemaVersion === 1) &&
    [observations, review, automatic].every(r => r.lockId === pins.lockId) && digest(pins.jobsSha256) &&
    observations.jobsSha256 === pins.jobsSha256 && digest(pins.sealSha256) && review.sealSha256 === pins.sealSha256 &&
    [review, automatic].every(r => r.observationsSha256 === pins.observationsSha256), pinError);
  const versions = preregistration.evaluator_and_policy_version;
  requireValue(versions.policySha256 === contentSha256(policy) && automatic.evaluatorSha256 === versions.evaluatorSha256 &&
    ['synthetic', 'saved_automatic'].includes(automatic.evidenceKind), scoreError);
  const primary = preregistration.primary_metric_and_minimum_effect;
  const margins = preregistration.noninferiority_margins;
  requireValue(primary.metric === 'work_paired_score' && Number.isFinite(primary.minimumEffect) && primary.minimumEffect >= 0 &&
    equal(Object.keys(margins), ['naturalness']) && Number.isFinite(margins.naturalness) && margins.naturalness >= 0,
  'STAGE16_REPORT_CRITERIA_UNSUPPORTED');
}

function indexRows(rows, identify, code) {
  requireValue(Array.isArray(rows), code);
  const indexed = new Map(rows.map(row => [identify(row), row]));
  requireValue(indexed.size === rows.length, code);
  return indexed;
}

function readCondition(cell, result, sample, modelPin) {
  requireValue(cell?.workId === sample.workId && cell.matrixSha256 === sample.matrixSha256 &&
    cell.condition.modelSha256 === modelPin && Array.isArray(cell.jobs) && cell.jobs.length &&
    result?.jobs?.length === cell.jobs.length, cohortError);
  const jobs = cell.jobs.map((j, i) => {
    const { jobId, receiptSha256, evidenceKind, status, reason, resultSha256 } = j;
    requireValue(equal(result.jobs[i], { jobId, receiptSha256, evidenceKind, status, reason, resultSha256 }), cohortError);
    const c = j.charge;
    requireValue(c?.currency === 'USD' && typeof c.confirmedSubtotal === 'string' &&
      (c.state === 'CONFIRMED' ? c.amount === c.confirmedSubtotal : c.state === 'UNCONFIRMED' && c.amount === null),
    'STAGE16_REPORT_CHARGE_MISMATCH');
    return { jobId, receiptSha256, status, reason, evidenceKind, amountUsd: c.amount, confirmedSubtotalUsd: c.confirmedSubtotal };
  });
  const finals = new Set(cell.jobs.map(j => j.resultSha256));
  const available = cell.completed && finals.size === 1;
  requireValue(available ? digest(result.resultSha256) && finals.has(result.resultSha256) && result.reason === null :
    result.resultSha256 === null && identifier(result.reason), cohortError);
  return { resultSha256: result.resultSha256, reason: result.reason, jobs };
}

function readScores(row, condition, workId) {
  if (!row) return Object.fromEntries(axes.map(a => [a, unknown(condition.reason ?? 'AUTOMATIC_SCORE_MISSING', 'ratio')]));
  requireValue(row.workId === workId && digest(condition.resultSha256) && row.resultSha256 === condition.resultSha256, scoreError);
  return Object.fromEntries(axes.map(axis => {
    const score = measurement(row[axis]);
    requireValue(score.unit === 'ratio' && (score.value === null || score.value <= 1), scoreError);
    return [axis, { ...score }];
  }));
}

function readAxis(pair, axis, scores, available) {
  requireValue([1, 2].includes(pair.assignments?.length), cohortError);
  const votes = pair.assignments.map(a => {
    const { preference, reason } = a[axis];
    requireValue(preference === null ? identifier(reason) : available && Object.hasOwn(sign, preference) && reason === null &&
      ['synthetic', 'human_submission'].includes(a.evidenceKind), cohortError);
    return { reviewerId: a.reviewerId, evidenceKind: a.evidenceKind, preference, reason };
  });
  const missing = votes.find(v => v.preference === null);
  const comparison = votes.length === 1 ? 'not_overlapped' : missing ? 'not_comparable' :
    votes[0].preference === votes[1].preference ? 'agree' : 'open_disagreement';
  requireValue(comparison === pair.comparison[axis], cohortError);
  const reason = !available ? 'RESULT_PAIR_UNAVAILABLE' : missing?.reason ??
    (comparison === 'open_disagreement' ? 'OPEN_REVIEW_DISAGREEMENT' : null);
  const human = { preference: reason === null ? votes[0].preference : null, reason, comparison, votes };
  const baseline = scores.baseline[axis], improved = scores.improved[axis];
  const delta = baseline.value === null || improved.value === null ? null : improved.value - baseline.value;
  const preference = delta === null ? null : delta > 0 ? 'improved' : delta < 0 ? 'baseline' : 'tie';
  const automatic = { baseline, improved, delta, preference };
  return { human, automatic, disagrees: preference === null || human.preference === null ? null : preference !== human.preference };
}

// Walk the S16-02 roster, never the ballots or score rows. S16-03 and S16-04
// materialize even the unavailable cells/pairs; a truncated or foreign ledger is invalid.
function readWorks({ lock, observations, review, automatic, preregistration }) {
  const samples = indexRows(lock.record.samples, s => s.pageId, cohortError);
  requireValue(samples.size > 0, cohortError);
  const cells = indexRows(observations.cells, c => key(c.pageId, c.condition.model, c.condition.processing), cohortError);
  const pairs = indexRows(review.pairs, p => key(p.pageId, p.model), cohortError);
  const scored = indexRows(automatic.rows, r => key(r.pageId, r.model, r.processing), scoreError);
  const works = new Map(), groups = new Map(), contexts = new Map();
  let sharedAcrossWorks = false;
  for (const s of samples.values()) {
    const { workId, pageId, leakageGroupId, contextSnapshotSha256 } = s;
    requireValue(identifier(workId) && identifier(pageId) && identifier(leakageGroupId) && digest(contextSnapshotSha256), cohortError);
    for (const [map, id] of [[groups, leakageGroupId], [contexts, contextSnapshotSha256]]) {
      if (map.has(id) && map.get(id) !== workId) sharedAcrossWorks = true;
      map.set(id, workId);
    }
    if (!works.has(workId)) works.set(workId, { workId, leakageGroupId, A: [], B: [] });
    const work = works.get(workId);
    requireValue(work.leakageGroupId === leakageGroupId, cohortError);
    for (const model of modelSlots) {
      const pairKey = key(pageId, model), p = pairs.get(pairKey);
      requireValue(p?.workId === workId, cohortError);
      pairs.delete(pairKey);
      const conditions = {}, scores = {};
      for (const variant of variants) {
        const cellKey = key(pageId, model, variant);
        conditions[variant] = readCondition(cells.get(cellKey), p.results[variant], s,
          preregistration.model_adapter_prompt_font_versions.models[model]);
        scores[variant] = readScores(scored.get(cellKey), conditions[variant], workId);
        cells.delete(cellKey);
        scored.delete(cellKey);
      }
      const available = variants.every(v => conditions[v].resultSha256 !== null);
      work[model].push({ pageId, matrixSha256: s.matrixSha256, conditions,
        axes: Object.fromEntries(axes.map(axis => [axis, readAxis(p, axis, scores, available)])) });
    }
  }
  requireValue(!cells.size && !pairs.size, cohortError);
  requireValue(!scored.size, scoreError);
  return { works: [...works.values()], sharedAcrossWorks };
}

/** Exact one-sided binomial upper limit for zero observed events in n independent units. */
export function zeroEventUpper95(n) {
  requireValue(Number.isSafeInteger(n) && n > 0, 'POSITIVE_INDEPENDENT_UNIT_COUNT_REQUIRED');
  return -Math.expm1(Math.log(0.05) / n);
}

function boundedMean(values) {
  let sum = 0, missing = 0;
  for (const v of values) {
    if (v === null) missing++;
    else sum += v;
  }
  const n = values.length;
  return { value: missing ? null : sum / n, lower: (sum - missing) / n, upper: (sum + missing) / n };
}

function pageStats(pages, axis) {
  const rows = pages.map(p => p.axes[axis]);
  const counts = { improved: 0, baseline: 0, tie: 0, missing: 0 };
  let mismatches = 0, comparable = 0;
  for (const row of rows) {
    counts[row.human.preference ?? 'missing']++;
    if (row.disagrees !== null) { comparable++; mismatches += Number(row.disagrees); }
  }
  const planned = rows.length;
  return { counts, confirmedImprovedShare: ratio(counts.improved, planned),
    availability: calculatePolicyMetric(policy, 'evaluation_availability', { evaluablePages: planned - counts.missing, eligiblePages: planned }),
    disagreement: { ...ratio(mismatches, comparable, 'NO_COMPARABLE_PAIRS'), plannedPairs: planned, uncompared: planned - comparable } };
}

function workAxis(pages, axis) {
  return { ...pageStats(pages, axis),
    pairedEffect: boundedMean(pages.map(p => sign[p.axes[axis].human.preference] ?? null)),
    automaticEffect: boundedMean(pages.map(p => p.axes[axis].automatic.delta)) };
}

function equallyWeighted(effects) {
  const mean = field => effects.reduce((sum, e) => sum + e[field], 0) / effects.length;
  return { value: effects.some(e => e.value === null) ? null : mean('value'), lower: mean('lower'), upper: mean('upper') };
}

function gcd(a, b) {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

// Ballot margins are integer fractions. Sum them before rounding so that exact
// cancellation cannot turn into a win, even with a preregistered zero threshold.
function pairedWorkEffect(groups) {
  let signed = 0n, missing = 0n, denominator = 1n;
  for (const { counts, availability } of groups) {
    const pages = BigInt(availability.denominator);
    const divisor = gcd(denominator, pages);
    const oldScale = pages / divisor, workScale = denominator / divisor;
    signed = signed * oldScale + BigInt(counts.improved - counts.baseline) * workScale;
    missing = missing * oldScale + BigInt(counts.missing) * workScale;
    denominator *= oldScale;
  }
  const total = (denominator * BigInt(groups.length)).toString();
  const asNumber = n => new Decimal(n.toString()).div(total).toNumber();
  return { value: missing === 0n ? asNumber(signed) : null, lower: asNumber(signed - missing), upper: asNumber(signed + missing) };
}

function workUncertainty(groups, effect, shared) {
  const n = groups.length;
  const noVotes = groups.every(g => g.availability.numerator === 0);
  const reason = shared ? 'SHARED_GROUP_OR_CONTEXT' : n < 2 ? 'INSUFFICIENT_WORKS' : noVotes ? 'NO_OBSERVED_PAIRS' : null;
  // Independent works, with each work mean bounded in [-1,1]. The endpoints also cover
  // every completion of the missing page differences, before adding sampling uncertainty.
  const halfWidth95 = reason === null ? Math.sqrt(2 * Math.log(40) / n) : null;
  const interval95 = reason === null ? { lower: Math.max(-1, effect.lower - halfWidth95),
    upper: Math.min(1, effect.upper + halfWidth95) } : null;
  const events = groups.filter(g => g.disagreement.numerator > 0).length;
  const unknownWorks = groups.filter(g => g.disagreement.numerator === 0 && g.disagreement.uncompared > 0).length;
  return { method: 'two_sided_hoeffding_independent_works', workCount: n,
    completeWorks: groups.filter(g => g.pairedEffect.value !== null).length, interval95, halfWidth95, reason,
    workDisagreement: { event: 'at_least_one_axis_disagreement_in_work', events, unknownWorks,
      zeroEventUpper95: !shared && !unknownWorks && !events ? zeroEventUpper95(n) : null } };
}

// A job subtotal can exceed the Stage15 size of an individual charge. Keep its integer
// and fractional USD units exact, and sum each registered job once (including repeats).
const usdScale = usdUnits('1');
function subtotalUnits(text) {
  requireValue(/^(0|[1-9]\d*)(\.\d{1,12})?$/.test(text), 'STAGE16_REPORT_CHARGE_MISMATCH');
  const [whole, fraction] = text.split('.');
  return BigInt(whole) * usdScale + (fraction ? usdUnits('0.' + fraction) : 0n);
}

function costAdjusted(pages, fidelity) {
  function efficiency(conditions, winner) {
    let subtotal = 0n, unsettledJobs = 0, plannedJobs = 0;
    for (const p of pages) for (const condition of conditions) for (const job of p.conditions[condition].jobs) {
      subtotal += subtotalUnits(job.confirmedSubtotalUsd);
      if (job.amountUsd === null) unsettledJobs++;
      plannedJobs++;
    }
    const confirmedWins = fidelity.counts[winner], missingPairs = fidelity.counts.missing;
    const confirmedSubtotalUsd = formatUsd(subtotal), amountUsd = unsettledJobs ? null : confirmedSubtotalUsd;
    const money = amountUsd === null ? null : Number(amountUsd);
    const wins = missingPairs ? null : confirmedWins;
    const reason = unsettledJobs ? 'CHARGE_EVIDENCE_INCOMPLETE' : missingPairs ? 'PAIR_OUTCOME_INCOMPLETE' : null;
    return { plannedPairs: pages.length, confirmedWins, missingPairs, plannedJobs, unsettledJobs, confirmedSubtotalUsd, amountUsd,
      winsPerUsd: ratio(wins, money, reason ?? 'ZERO_COST'), usdPerWin: ratio(money, wins, reason ?? 'NO_WINS') };
  }
  return { baseline: efficiency(['baseline'], 'baseline'), improved: efficiency(['improved'], 'improved'),
    comparison: efficiency(variants, 'improved') };
}

function primaryDecision(axis, minimumEffect) {
  const v = axis.pairedEffect.value, ci = axis.uncertainty.interval95;
  const observed = v === null ? 'incomplete' : v === 0 ? 'no_difference' : v < 0 ? 'worse' :
    v < minimumEffect ? 'below_minimum_effect' : 'meets_minimum_effect';
  let inference = 'inconclusive';
  if (axis.uncertainty.reason === 'INSUFFICIENT_WORKS') inference = 'insufficient_works';
  else if (v !== null && ci?.lower > 0 && ci.lower >= minimumEffect) inference = 'supports_improvement';
  else if (v !== null && ci?.upper < 0) inference = 'supports_worsening';
  return { axis: 'semanticFidelity', minimumEffect, observed, inference };
}

function modelReport(cohort, model, preregistration) {
  const works = cohort.works.map(w => {
    const pages = w[model];
    const byAxis = Object.fromEntries(axes.map(axis => [axis, workAxis(pages, axis)]));
    return { workId: w.workId, leakageGroupId: w.leakageGroupId, pages, axes: byAxis,
      costAdjusted: costAdjusted(pages, byAxis.semanticFidelity) };
  });
  const pages = works.flatMap(w => w.pages);
  const byAxis = Object.fromEntries(axes.map(axis => {
    const groups = works.map(w => w.axes[axis]);
    const pairedEffect = pairedWorkEffect(groups);
    return [axis, { ...pageStats(pages, axis), pairedEffect, automaticEffect: equallyWeighted(groups.map(g => g.automaticEffect)),
      uncertainty: workUncertainty(groups, pairedEffect, cohort.sharedAcrossWorks) }];
  }));
  const margin = preregistration.noninferiority_margins.naturalness;
  const value = byAxis.naturalness.pairedEffect.value, ci = byAxis.naturalness.uncertainty.interval95;
  const supported = value === null || !ci ? null : ci.lower >= -margin ? true : ci.upper < -margin ? false : null;
  return { modelSha256: preregistration.model_adapter_prompt_font_versions.models[model], plannedPages: pages.length, works,
    axes: byAxis, primary: primaryDecision(byAxis.semanticFidelity, preregistration.primary_metric_and_minimum_effect.minimumEffect),
    noninferiority: { axis: 'naturalness', margin, observedWithinMargin: value === null ? null : value >= -margin, supported },
    costAdjusted: costAdjusted(pages, byAxis.semanticFidelity) };
}

/** Offline metadata consumer. Pins are independently retained at each input's production boundary. */
export function buildStage16PairedReport(input, pins) {
  checkInputs(input, pins);
  const cohort = readWorks(input);
  const kinds = xs => [...new Set(xs.filter(v => v !== null))].sort();
  const { review, automatic, observations, lock } = input;
  return { schemaVersion: 1, kind: 'stage16-paired-report', metric: 'work_paired_score', policyVersion: policy.policyVersion,
    definitions: { primaryAxis: 'semanticFidelity', pairedSigns: { ...sign }, weighting: 'equal_pages_within_work_then_equal_works',
      automaticDelta: 'improved_minus_baseline_on_unit_interval', costUnit: 'USD',
      costSuccess: 'resolved_fidelity_win_on_completed_pair', comparisonCost: 'all_baseline_and_improved_jobs',
      independentExampleAssumption: 'independent_bernoulli_trials_with_common_event_probability' },
    pins: { lockId: lock.lockId, preregistrationSha256: lock.record.preregistrationSha256, jobsSha256: pins.jobsSha256,
      observationsSha256: pins.observationsSha256, sealSha256: pins.sealSha256, reviewSha256: pins.reviewSha256,
      automaticSha256: pins.automaticSha256, evaluatorSha256: automatic.evaluatorSha256 },
    evidence: { executionKinds: kinds(observations.cells.flatMap(c => c.jobs.map(j => j.evidenceKind))),
      reviewKinds: kinds(review.pairs.flatMap(p => p.assignments.map(a => a.evidenceKind))),
      automaticKind: automatic.evidenceKind, reviewerAuthentication: review.reviewerAuthentication },
    independentZeroDefectExamples: [100, 299].map(independentUnits => ({ independentUnits, events: 0, upper95: zeroEventUpper95(independentUnits) })),
    models: Object.fromEntries(modelSlots.map(m => [m, modelReport(cohort, m, input.preregistration)])) };
}
