import { contentSha256 } from './dataset-contract.mjs';
import { digest, object, requireValue } from './offline/contract.mjs';
import { collectStage16BlindReturns, prepareStage16BlindReview } from './stage16-blind-review.mjs';
import { collectStage16Observations } from './stage16-execution-observations.mjs';
import { createExperimentLock } from './stage16-experiment-lock.mjs';
import { buildStage16PairedReport } from './stage16-paired-report.mjs';

function matches(value, sha256) {
  return value != null && digest(sha256) && contentSha256(value) === sha256;
}

function add(blockers, code) {
  if (!blockers.includes(code)) blockers.push(code);
}

const approvalFields = ['schemaVersion', 'kind', 'evidenceKind', 'decision', 'lockId', 'jobsSha256',
  'approvalEvidenceSha256', 'routeReadinessSha256'];

// Contract failures are evidence of a blocked comparison. Propagate unexpected implementation errors.
function contractFailure(error, blockers) {
  if (typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]+$/.test(error.code)) throw error;
  add(blockers, error.code);
}

function currentLock(input, pins, scope, blockers) {
  const e = input.experiment;
  if (!e?.manifest || !e.preregistration || !e.matrices?.length || !e.holdoutHistory?.length || !e.candidateSelection) {
    add(blockers, 'UNUSED_HOLDOUT_REQUIRED');
    return null;
  }
  const lock = createExperimentLock(e, pins.preregistrationSha256, {
    candidateSelectionSha256: pins.candidateSelectionSha256, holdoutHistorySha256: pins.holdoutHistorySha256,
  });
  if (lock.status !== 'locked') {
    add(blockers, lock.reason);
    return lock; // Includes the development-set disposition after tuning.
  }
  if (lock.lockId !== pins.lockId || input.lock?.status !== 'locked' || input.lock.lockId !== lock.lockId ||
      !matches(input.lock.record, lock.lockId)) add(blockers, 'STAGE16_LOCK_MISMATCH');
  const pages = new Map(e.manifest.pages.map(page => [page.pageId, page]));
  const sources = lock.record.samples.map(s => pages.get(s.pageId).provenance);
  if (scope === 'actual') {
    if (pins.verifiedActual?.holdoutLockId !== lock.lockId ||
        sources.some(s => s.origin === 'synthetic' || !digest(s.sourceEvidence?.sha256))) add(blockers, 'ACTUAL_HOLDOUT_REQUIRED');
  } else if (sources.some(s => s.origin !== 'synthetic')) add(blockers, 'SYNTHETIC_HOLDOUT_REQUIRED');
  return lock;
}

/** Operator-side, metadata-only preflight. Pins and verifiedActual come from the owner of the evidence.
 * The return value records evidence readiness. Execution and identity verification belong to the operator.
 */
export function assessStage16Start(input, pins, scope = 'actual') {
  input ??= {};
  pins ??= {};
  requireValue(scope === 'actual' || scope === 'synthetic', 'INVALID_STAGE16_SCOPE');
  const blockers = [];
  const lock = currentLock(input, pins, scope, blockers);
  const approval = input.approval;
  const recordedFields = Object.keys(approval ?? {});
  if (!matches(approval, pins.approvalSha256) || !approvalFields.every(k => recordedFields.includes(k)) ||
      approval.schemaVersion !== 1 || approval.kind !== 'stage16-execution-approval' ||
      approval.decision !== 'approved' || approval.evidenceKind !== (scope === 'actual' ? 'verified_execution_approval' : 'synthetic') ||
      !digest(approval.approvalEvidenceSha256) || !digest(approval.routeReadinessSha256) ||
      !digest(approval.lockId) || approval.lockId !== pins.lockId ||
      !digest(approval.jobsSha256) || approval.jobsSha256 !== pins.jobsSha256) add(blockers, 'EXECUTION_APPROVAL_REQUIRED');
  if (lock?.status === 'locked') {
    try {
      // S16-03 validates every job, route, frozen cell, provider and revision even before the first receipt.
      collectStage16Observations({ lock, matrices: input.experiment.matrices, jobs: input.jobs }, [], pins);
    } catch (error) { contractFailure(error, blockers); }
  }
  const record = blockers.length ? null : { schemaVersion: 1, kind: 'stage16-start-evidence', scope,
    lockId: lock.lockId, jobsSha256: pins.jobsSha256, approvalSha256: pins.approvalSha256 };
  return { scope, status: blockers.length ? 'blocked' : scope === 'actual' ? 'start_evidence_verified' : 'rehearsal_ready',
    blockers, lock, record, startSha256: record && contentSha256(record) };
}

function checkReceipts(observations, scope, blockers) {
  const kind = scope === 'actual' ? 'actual_product' : 'synthetic';
  for (const cell of observations.cells) {
    for (const job of cell.jobs) {
      if (!digest(job.receiptSha256) || job.stages.some(stage => !stage.attempts.length ||
          stage.attempts.some(a => a.reason === 'ATTEMPT_RECEIPT_MISSING'))) add(blockers, 'EXECUTION_RECEIPTS_REQUIRED');
      if (job.receiptSha256 && job.evidenceKind !== kind) add(blockers, 'EXECUTION_EVIDENCE_KIND_MISMATCH');
      if (job.charge.state !== 'CONFIRMED') add(blockers, 'SETTLEMENT_RECEIPT_REQUIRED');
    }
  }
}

function checkReview(seal, review, scope, pins, blockers) {
  const kind = scope === 'actual' ? 'human_submission' : 'synthetic';
  // S16-04 replay verifies qualifications, distinct independence groups and the committed overlap draw.
  // Different answers and explicit abstentions remain in the paired report.
  for (const pair of review.pairs) {
    if (pair.results.baseline.resultSha256 === null || pair.results.improved.resultSha256 === null) {
      add(blockers, 'FOUR_CONDITION_RESULTS_REQUIRED');
    }
    if (pair.assignments.some(a => a.status !== 'answered' || a.evidenceKind !== kind)) add(blockers, 'INDEPENDENT_REVIEW_REQUIRED');
  }
  const overlap = review.pairs.filter(p => p.assignments.length === 2);
  for (const axis of ['semanticFidelity', 'naturalness']) {
    if (!overlap.some(p => p.assignments.every(a => a[axis].preference !== null))) add(blockers, 'INDEPENDENT_REVIEW_REQUIRED');
  }
  if (scope === 'actual') {
    // A saved seal proves assignment, not authorship. The identity owner must independently
    // attest the returned ledger for this exact draw and these two reviewers.
    const identities = pins.verifiedActual?.reviewers;
    const verified = Array.isArray(identities) && identities.length === seal.reviewers.length &&
      seal.reviewers.every(({ reviewerId, independenceGroup }) => identities.some(r => r?.reviewerId === reviewerId &&
        r.independenceGroup === independenceGroup && r.sealSha256 === pins.sealSha256 &&
        r.reviewSha256 === pins.reviewSha256 && digest(r.authenticationEvidenceSha256)));
    if (!verified) add(blockers, 'AUTHENTICATED_HUMAN_RETURNS_REQUIRED');
  }
}

function reconcile(input, pins, scope, lock, blockers) {
  const { matrices, manifest, preregistration } = input.experiment;
  const observations = collectStage16Observations({ lock, matrices, jobs: input.jobs }, input.receipts ?? [], pins);
  checkReceipts(observations, scope, blockers);
  requireValue(matches(observations, pins.observationsSha256), 'STAGE16_OBSERVATIONS_PIN_MISMATCH');
  const { seal, sealSha256 } = prepareStage16BlindReview(
    { lock, matrices, manifest, preregistration, protocol: input.protocol, observations }, pins, input.seed);
  requireValue(sealSha256 === pins.sealSha256, 'STAGE16_REVIEW_SEAL_MISMATCH');
  const review = collectStage16BlindReturns(seal, sealSha256, input.envelopes ?? []);
  checkReview(seal, review, scope, pins, blockers);
  requireValue(matches(review, pins.reviewSha256), 'STAGE16_RETURNS_PIN_MISMATCH');
  requireValue(object(input.automatic) && input.automatic.evidenceKind === (scope === 'actual' ? 'saved_automatic' : 'synthetic'),
    'AUTOMATIC_EVIDENCE_REQUIRED');
  const report = buildStage16PairedReport({ lock, preregistration, observations, review, automatic: input.automatic }, pins);
  requireValue(matches(input.pairedReport, pins.reportSha256) && matches(report, pins.reportSha256), 'STAGE16_PAIRED_REPORT_MISMATCH');
  const lockId = lock.lockId;
  return {
    experimentLock: lock,
    conditionTable: { schemaVersion: 1, kind: 'stage16-condition-table', scope, lockId, matrices, observations },
    humanAudit: { schemaVersion: 1, kind: 'stage16-human-audit', scope, lockId, protocolSha256: seal.protocolSha256,
      reviewers: seal.reviewers, returns: review },
    uncertaintyPairedReport: report,
    costAdjustedSuccess: { schemaVersion: 1, kind: 'stage16-cost-adjusted-success', scope, lockId,
      pairedReportSha256: pins.reportSha256, models: { A: report.models.A.costAdjusted, B: report.models.B.costAdjusted } },
  };
}

/** Replay the locked receipts, blind returns and report. A blocked result can still contain all five
 * artifacts when the missing observations themselves were recorded and pinned by S16-03 through S16-05.
 */
export function assessStage16Acceptance(input, pins, scope = 'actual') {
  input ??= {};
  pins ??= {};
  const start = assessStage16Start(input, pins, scope);
  const blockers = [...start.blockers];
  // The operator retains this pin before collecting results. Re-approving a different scope later is insufficient.
  const recordedStart = start.record !== null && start.startSha256 === pins.startSha256;
  if (!recordedStart) add(blockers, 'START_EVIDENCE_REQUIRED');
  if (!input.receipts?.length) add(blockers, 'EXECUTION_RECEIPTS_REQUIRED');
  if (!input.envelopes?.length) add(blockers, 'INDEPENDENT_REVIEW_REQUIRED');
  if (!input.pairedReport) add(blockers, 'PAIRED_REPORT_REQUIRED');
  let artifacts = null;
  if (recordedStart) {
    try { artifacts = reconcile(input, pins, scope, start.lock, blockers); }
    catch (error) { contractFailure(error, blockers); }
  }
  const artifactSha256 = artifacts && Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, contentSha256(value)]));
  return { scope, start, status: blockers.length ? 'blocked' : scope === 'actual' ? 'acceptance_evidence_verified' : 'synthetic_reconciled',
    blockers, artifacts, artifactSha256 };
}
