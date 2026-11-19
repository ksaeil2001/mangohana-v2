import { contentSha256 } from '../../../packages/evaluation/dataset-contract.mjs';
import { collectStage16BlindReturns, prepareStage16BlindReview } from '../../../packages/evaluation/stage16-blind-review.mjs';
import { collectStage16Observations } from '../../../packages/evaluation/stage16-execution-observations.mjs';
import { buildStage16PairedReport } from '../../../packages/evaluation/stage16-paired-report.mjs';
import { addHoldoutPage, experiment, freezeDataset, sha } from './stage16-experiment.mjs';
import { fixtureSeed, readerIds } from './stage16-blind-review.mjs';
import { receiptFor, scenario } from './stage16-observations.mjs';

// All identifiers and hashes describe generated labels. The experiment has two works,
// one page each, and a preregistered overlap on one page for both model comparisons.
export function acceptanceScenario(options = {}) {
  const registration = experiment();
  addHoldoutPage(registration, 'work-other', 'page-other');
  const { manifest, matrices, preregistration } = registration;
  // Negative test only: labels claim actual provenance while every value still comes from this fixture.
  const claims = options.unverifiedActualLabels === true;
  if (claims) for (const page of manifest.pages.filter(p => p.split === 'holdout')) {
    page.provenance.origin = 'claimed_source';
    page.provenance.sourceEvidence = { path: 'fixture-only.unavailable', sha256: sha('fixture claim ' + page.pageId) };
  }
  for (const reviewerId of readerIds) {
    manifest.reviewers.push({ ...manifest.reviewers[0], reviewerId, independenceGroup: 'group-' + reviewerId });
  }
  freezeDataset(manifest);
  preregistration.holdout_freeze.manifestSha256 = contentSha256(manifest);
  const caps = preregistration.resource_caps_and_stop_rules;
  Object.assign(caps, { maxRequests: 100, maxMoney: 4, currency: 'USD' });
  const protocol = { schemaVersion: 1, reviewerIds: [...readerIds], overlapPageCount: 1,
    seedSha256: contentSha256(fixtureSeed) };
  preregistration.blind_randomized_human_review = contentSha256(protocol);
  const { plan, anchors } = scenario({ input: registration });
  const { lock, jobs } = plan;
  const approval = { schemaVersion: 1, kind: 'stage16-execution-approval', evidenceKind: claims ? 'verified_execution_approval' : 'synthetic',
    decision: 'approved', lockId: lock.lockId, jobsSha256: anchors.jobsSha256,
    approvalEvidenceSha256: sha('fixture approval'), routeReadinessSha256: sha('fixture resource and runtime checks') };
  const pins = { ...anchors, preregistrationSha256: contentSha256(preregistration),
    candidateSelectionSha256: contentSha256(registration.candidateSelection),
    holdoutHistorySha256: contentSha256(registration.holdoutHistory),
    approvalSha256: contentSha256(approval) };
  // Independently retained at the synthetic start, before returning the downstream evidence to the caller.
  pins.startSha256 = contentSha256({ schemaVersion: 1, kind: 'stage16-start-evidence', scope: claims ? 'actual' : 'synthetic',
    lockId: lock.lockId, jobsSha256: pins.jobsSha256, approvalSha256: pins.approvalSha256 });
  const receipts = jobs.map(job => receiptFor(plan, job, { amounts: { TRANSLATE: '0.25' },
    mode: job.processing === 'baseline' ? 'cold' : 'warm' }));
  if (claims) for (const receipt of receipts) receipt.page.evidenceKind = 'actual_product';
  options.editReceipts?.(receipts, plan);
  const observations = collectStage16Observations(plan, receipts, anchors);
  pins.observationsSha256 = contentSha256(observations);
  const { seal, sealSha256 } = prepareStage16BlindReview({ lock, matrices, preregistration, manifest, observations, protocol },
    pins, fixtureSeed);
  const envelopes = [];
  const automatic = { schemaVersion: 1, kind: 'stage16-automatic-scores', evidenceKind: claims ? 'saved_automatic' : 'synthetic', lockId: lock.lockId,
    observationsSha256: pins.observationsSha256, evaluatorSha256: preregistration.evaluator_and_policy_version.evaluatorSha256,
    rows: [] };
  for (const pair of seal.pairs) {
    for (const [processing, result] of Object.entries(pair.results)) {
      if (!result.resultSha256) continue;
      const score = value => ({ value, unit: 'ratio', reason: null });
      automatic.rows.push({ workId: pair.workId, pageId: pair.pageId, model: pair.model, processing,
        resultSha256: result.resultSha256, semanticFidelity: score(pair.model === 'A' && processing === 'baseline' ? 1 : 0.5),
        naturalness: score(0.5) });
    }
    if (!pair.results.baseline.resultSha256 || !pair.results.improved.resultSha256) continue;
    for (const a of pair.assignments) {
      const preference = pair.model === 'A' ? (a.A.processing === 'baseline' ? 'A' : 'B') : 'tie';
      envelopes.push({ reviewerId: a.reviewerId, evidenceKind: claims ? 'human_submission' : 'synthetic', responses: [{ assignmentId: a.assignmentId,
        sourceRef: a.sourceRef, contextRef: a.contextRef, A: a.A.ref, B: a.B.ref,
        semanticFidelity: preference, naturalness: 'tie' }] });
    }
  }
  options.editEnvelopes?.(envelopes, seal);
  const review = collectStage16BlindReturns(seal, sealSha256, envelopes);
  Object.assign(pins, { sealSha256, reviewSha256: contentSha256(review), automaticSha256: contentSha256(automatic) });
  const pairedReport = buildStage16PairedReport({ lock, preregistration, observations, review, automatic }, pins);
  pins.reportSha256 = contentSha256(pairedReport);
  return { input: { experiment: registration, lock, jobs, approval, receipts, protocol, seed: fixtureSeed,
    envelopes, automatic, pairedReport }, pins, observations, review };
}
