import { contentSha256 } from '../../../packages/evaluation/dataset-contract.mjs';
import { collectStage16BlindReturns, prepareStage16BlindReview } from '../../../packages/evaluation/stage16-blind-review.mjs';
import { collectStage16Observations } from '../../../packages/evaluation/stage16-execution-observations.mjs';
import { fixtureSeed, readerIds } from './stage16-blind-review.mjs';
import { addHoldoutPage, experiment, freezeDataset, sha } from './stage16-experiment.mjs';
import { receiptFor, scenario } from './stage16-observations.mjs';

// Indices 0,1,2 belong to one work. Each remaining page belongs to its own work.
export const pages = ['page-final', 'page-second', 'page-third', 'page-other', 'page-last'];
const ballots = {
  A: { semanticFidelity: ['+', '+', '=', '-', null], naturalness: ['=', '+', 'split', '=', null] },
  B: { semanticFidelity: ['=', '-', '-', '+', '='], naturalness: ['+', '=', '-', '=', '='] },
};
const scores = {
  A: { semanticFidelity: [1, 0, 0, -1, null], naturalness: [0, 1, -1, null, null] },
  B: { semanticFidelity: [0, -1, 0, -1, 0], naturalness: [1, 0, -1, 0, 0] },
};
function choice(symbol, assignment, index) {
  if (symbol === 'split') symbol = index === 0 ? '+' : '-';
  if (symbol === '=' || symbol === null) return symbol === '=' ? 'tie' : null;
  return assignment.A.processing === (symbol === '+' ? 'improved' : 'baseline') ? 'A' : 'B';
}

export function pairedScenario(options = {}) {
  const e = experiment();
  addHoldoutPage(e, 'work-other', pages[3]);
  addHoldoutPage(e, 'work-final', pages[1]);
  addHoldoutPage(e, 'work-final', pages[2]);
  addHoldoutPage(e, 'work-last', pages[4], options.lastGroup ?? 'group-work-last');
  const { preregistration, manifest } = e;
  preregistration.primary_metric_and_minimum_effect.minimumEffect = options.minimumEffect ?? 0.2;
  options.configure?.(e);
  for (const reviewerId of readerIds) manifest.reviewers.push({ ...manifest.reviewers[0], reviewerId,
    independenceGroup: 'group-' + reviewerId,
    qualificationEvidence: { path: reviewerId + '.unavailable', sha256: sha('qualified-' + reviewerId) } });
  freezeDataset(manifest);
  preregistration.holdout_freeze.manifestSha256 = contentSha256(manifest);
  const protocol = { schemaVersion: 1, reviewerIds: [...readerIds],
    overlapPageCount: options.overlapPageCount ?? 5, seedSha256: contentSha256(fixtureSeed) };
  preregistration.blind_randomized_human_review = contentSha256(protocol);
  const { plan, anchors } = scenario({ input: e });
  const { lock, matrices, jobs } = plan;
  options.editJobs?.(jobs);
  anchors.jobsSha256 = contentSha256(jobs);
  const receipts = jobs.map(job => {
    const amount = job.processing === 'baseline' ? '0.10' : '0.20';
    const receipt = receiptFor(plan, job, { amounts: { TRANSLATE: amount } });
    if (job.model === 'A' && job.pageId === pages[4] && job.processing === 'improved') receipt.stages.pop();
    return receipt;
  });
  options.editReceipts?.(receipts, plan);
  const observations = collectStage16Observations(plan, receipts, anchors);
  anchors.observationsSha256 = contentSha256(observations);
  const { seal, sealSha256 } = prepareStage16BlindReview({ lock, matrices, preregistration, manifest, observations, protocol }, anchors, fixtureSeed);
  const envelopes = [];
  const rows = [];
  for (const p of seal.pairs) {
    const i = pages.indexOf(p.pageId);
    if (p.results.baseline.resultSha256 && p.results.improved.resultSha256) {
      for (const [r, a] of p.assignments.entries()) {
        const response = { assignmentId: a.assignmentId, sourceRef: a.sourceRef, contextRef: a.contextRef, A: a.A.ref, B: a.B.ref };
        for (const axis of ['semanticFidelity', 'naturalness']) response[axis] = choice(ballots[p.model][axis][i] ?? null, a, r);
        envelopes.push({ reviewerId: a.reviewerId, evidenceKind: 'synthetic', responses: [response] });
      }
    }
    for (const processing of ['baseline', 'improved']) {
      const resultSha256 = p.results[processing].resultSha256;
      if (resultSha256 === null) continue;
      const row = { pageId: p.pageId, workId: p.workId, model: p.model, processing, resultSha256 };
      for (const axis of ['semanticFidelity', 'naturalness']) {
        const delta = scores[p.model][axis][i] ?? null;
        const value = processing === 'baseline' ? 0.5 : delta === null ? null : 0.5 + delta / 4;
        row[axis] = { value, unit: 'ratio', reason: value === null ? 'AXIS_NOT_SCORED' : null };
      }
      rows.push(row);
    }
  }
  options.editEnvelopes?.(envelopes, seal);
  const review = collectStage16BlindReturns(seal, sealSha256, envelopes);
  const automatic = { schemaVersion: 1, kind: 'stage16-automatic-scores', evidenceKind: 'synthetic', lockId: lock.lockId,
    observationsSha256: anchors.observationsSha256, evaluatorSha256: preregistration.evaluator_and_policy_version.evaluatorSha256, rows };
  return { input: { lock, preregistration, observations, review, automatic }, anchors: { ...anchors, sealSha256,
    reviewSha256: contentSha256(review), automaticSha256: contentSha256(automatic) } };
}
