import { formatUsd, measureStage15Attempt, usdUnits } from '../../apps/engine/stage15-batch-accounting.mjs';
import { stage15RequestIdentity } from '../../apps/engine/stage15-provider-adapter.mjs';
import { contentSha256 } from './dataset-contract.mjs';
import { digest, equal, identifier, measured, measurement, object, requireValue, unknown, validateIdentity } from './offline/contract.mjs';
import { aggregateOperations } from './offline/operations.mjs';
import { verifiedMatrix } from './stage16-experiment-lock.mjs';

const stages = ['OCR', 'TRANSLATE', 'MASK', 'INPAINT', 'TYPESET'];
const outcomes = new Map(Object.entries({ CONFIRMED_SUCCESS: 'succeeded', CONFIRMED_FAILURE: 'failed',
  CONFIRMED_NOT_STARTED: 'not_run', PARTIAL: 'partial', CANCELLED: 'interrupted', RESULT_UNKNOWN: 'unknown' }));
const invalidPlan = 'STAGE16_PLAN_MISMATCH', wrongCell = 'STAGE16_CELL_MISMATCH', wrongStage = 'STAGE16_STAGE_MISMATCH';
const conflict = 'STAGE16_EVIDENCE_CONFLICT', invalidReceipt = 'STAGE16_INVALID_RECEIPT';
const count = n => Number.isSafeInteger(n) && n >= 0;
const cellKey = (page, model, processing) => JSON.stringify([page, model, processing]);
const providerFields = ['providerId', 'modelId', 'modelVersion', 'profileDigest'];
const sameProvider = (a, b) => providerFields.every(k => a?.[k] === b?.[k]);

function rangeOfStages(job) {
  const route = job.separateMask ? stages : stages.filter(stage => stage !== 'MASK');
  requireValue(route.includes(job.firstStage), invalidPlan);
  return route.slice(route.indexOf(job.firstStage));
}

function meter(input, unit, reason) {
  if (input == null) return unknown(reason, unit);
  measurement(input);
  requireValue(input.unit === unit && (unit !== 'bytes' || input.value === null || count(input.value)), invalidReceipt);
  return { ...input };
}

// Sum only individual, validated Stage15 decimal amounts. Never add a subtotal twice on the way up.
function charge(amounts) {
  const confirmed = amounts.length > 0 && !amounts.includes(null);
  const subtotal = formatUsd(amounts.reduce((sum, value) => value === null ? sum : sum + usdUnits(value), 0n));
  return { state: confirmed ? 'CONFIRMED' : 'UNCONFIRMED', currency: 'USD', amount: confirmed ? subtotal : null,
    confirmedSubtotal: subtotal, reason: confirmed ? null : 'CHARGE_EVIDENCE_INCOMPLETE' };
}

function stageAmounts(rows) {
  return rows.flatMap(stage => stage.attempts?.length ? stage.attempts.map(a => a.charge.amount) : [null]);
}

function registerJobs(plan, anchors) {
  requireValue(object(plan), invalidPlan);
  const { lock, matrices, jobs } = plan;
  const record = lock?.record;
  requireValue(lock?.status === 'locked' && digest(anchors?.lockId) && anchors.lockId === lock.lockId &&
    record?.kind === 'stage16-experiment-lock' && record.schemaVersion === 1 && contentSha256(record) === lock.lockId,
  'STAGE16_LOCK_MISMATCH');
  requireValue(Array.isArray(record.samples) && record.samples.length && Array.isArray(matrices) &&
    matrices.length === record.samples.length && Array.isArray(jobs) && digest(anchors.jobsSha256) &&
    contentSha256(jobs) === anchors.jobsSha256, invalidPlan);
  const byPage = new Map(matrices.map(verifiedMatrix).map(m => [m.shared.pageId, m]));
  const cells = new Map(), byJob = new Map(), pageRoutes = new Map(), models = new Map(), providerSlots = new Map();
  for (const sample of record.samples) {
    const m = byPage.get(sample.pageId);
    requireValue(m && m.matrixSha256 === sample.matrixSha256 && m.shared.workId === sample.workId &&
      m.shared.sourceSha256 === sample.sourceSha256 && m.shared.contextSnapshotSha256 === sample.contextSnapshotSha256, invalidPlan);
    byPage.delete(sample.pageId);
    for (const condition of m.conditions) {
      const { workId, pageId, intermediateSha256 } = m.shared;
      cells.set(cellKey(pageId, condition.model, condition.processing), { workId, pageId, matrixSha256: m.matrixSha256,
        shared: m.shared, condition, path: { kind: intermediateSha256 === null ? 'full_path' : 'fixed_intermediate',
          intermediateSha256, firstStage: null }, jobs: [] });
    }
  }
  for (const job of jobs) {
    const cell = cells.get(cellKey(job?.pageId, job?.model, job?.processing)), b = job?.binding, p = job?.primaryProvider;
    requireValue(cell && object(b) && identifier(b.requestId) && !byJob.has(b.requestId) && identifier(b.pageId) &&
      identifier(b.projectId) && ['owner', 'session'].includes(b.ownerScope?.kind) && identifier(b.ownerScope.id) &&
      count(b.pageNumber) && b.pageNumber > 0 && count(b.generation) && count(b.editRevision) && count(b.contextRevision) &&
      count(b.layoutRevision) && b.sourceSha256 === cell.shared.sourceSha256 && digest(b.inputDigest) &&
      ['providerId', 'modelId', 'modelVersion'].every(k => identifier(p?.[k])) && digest(p.profileDigest), invalidPlan);
    const route = rangeOfStages(job);
    requireValue((job.separateMask === undefined || typeof job.separateMask === 'boolean') &&
      (cell.path.kind !== 'full_path' || job.firstStage === 'OCR') &&
      (b.mode === 'FULL_IMAGE' || b.mode === 'TYPESETTING_ONLY' && job.firstStage === 'TYPESET') &&
      (!pageRoutes.has(cell.pageId) || equal(pageRoutes.get(cell.pageId), route)), invalidPlan);
    const version = [p.modelId, p.modelVersion];
    const providerPin = JSON.stringify(providerFields.map(k => p[k]));
    requireValue((!models.has(job.model) || equal(version, models.get(job.model))) &&
      (!providerSlots.has(providerPin) || providerSlots.get(providerPin) === job.model), invalidPlan);
    providerSlots.set(providerPin, job.model);
    models.set(job.model, version);
    pageRoutes.set(cell.pageId, route);
    cell.path.firstStage = job.firstStage;
    cell.jobs.push(job);
    byJob.set(b.requestId, { job, cell });
  }
  requireValue([...cells.values()].every(c => c.jobs.length > 0), invalidPlan);
  return { cells, byJob };
}

function bindPage(receipt, cell, job, lockId) {
  const { page } = receipt, b = job.binding;
  const id = validateIdentity(page.identity);
  requireValue(receipt.lockId === lockId && receipt.matrixSha256 === cell.matrixSha256 &&
    equal(receipt.condition, cell.condition) && receipt.intermediateSha256 === cell.path.intermediateSha256 &&
    page.pageId === cell.pageId && page.sourceHashes?.datasetEncodedSha256 === cell.shared.sourceSha256 &&
    id.workId === cell.workId && id.pageId === b.pageId && id.jobId === b.requestId && id.projectId === b.projectId &&
    id.ownerId === b.ownerScope.id && id.processingGeneration === b.generation && id.editRevision === b.editRevision &&
    id.contextRevision === b.contextRevision, wrongCell);
  requireValue(['synthetic', 'component', 'actual_product', 'cache_reuse', 'not_run'].includes(page.evidenceKind) &&
    ['succeeded', 'failed', 'running', 'interrupted', 'unknown', 'not_run'].includes(page.processing?.status) &&
    (page.attempts == null || Array.isArray(page.attempts) &&
      (!page.attempts.length || page.attempts.at(-1)?.jobId === id.jobId)), invalidReceipt);
}

function readInitialization(init) {
  const mode = init?.mode ?? null;
  requireValue(init == null || (mode === null ? identifier(init.reason) :
    ['cold', 'warm'].includes(mode) && init.reason === null), invalidReceipt);
  return { mode, reason: mode === null ? init?.reason ?? 'INITIALIZATION_MODE_NOT_REPORTED' : null,
    elapsedMs: meter(init?.elapsedMs, 'ms', 'INITIALIZATION_TIME_NOT_REPORTED') };
}

function observedOutcome(row, input) {
  const o = row.observed;
  const status = outcomes.get(o.state);
  requireValue(status && (o.started === null || typeof o.started === 'boolean'), invalidReceipt);
  if (status === 'succeeded') {
    const output = row.output;
    const expected = input.regionIds;
    if (o.started !== true || input.node.regionId !== null || row.providerObservation?.outcome !== 'SUCCESS' || !o.evidenceRefs.length ||
        !identifier(o.artifact?.artifactId) || !digest(o.artifact?.sha256) || output?.complete !== true ||
        !equal(output.artifact, o.artifact) || !Array.isArray(output.missingRegionIds) || output.missingRegionIds.length ||
        !Array.isArray(output.regionIds) || !equal([...output.regionIds].sort(), [...expected].sort()) ||
        row.storageError || (Object.hasOwn(output, 'file') && output.file === null)) {
      return { status: 'unknown', reason: 'COMPLETE_STAGE_EVIDENCE_MISSING', resultSha256: null };
    }
  }
  return { status, reason: status === 'succeeded' ? null : o.errorCode ?? o.state, resultSha256: o.artifact?.sha256 ?? null };
}

function claimEvidence(ref, executionId, seen) {
  requireValue(identifier(ref) && (!seen.evidence.has(ref) || seen.evidence.get(ref) === executionId), conflict);
  seen.evidence.set(ref, executionId);
}

function checkSettlement({ observed, providerObservation: provider, charge: settlement }) {
  const code = 'STAGE16_SETTLEMENT_MISMATCH';
  if (settlement?.state === 'UNCONFIRMED') {
    requireValue(observed.usageConfirmed === false && observed.costUsd === null, code);
    return;
  }
  requireValue(settlement?.state === 'CONFIRMED' && observed.usageConfirmed === true && provider?.usageConfirmed === true &&
    identifier(settlement.source) && provider.usageEvidenceId === settlement.source &&
    [settlement.amount, observed.costUsd, provider.costUsd].every(v => typeof v === 'string'), code);
  const amount = usdUnits(settlement.amount);
  requireValue(usdUnits(observed.costUsd) === amount && usdUnits(provider.costUsd) === amount, code);
}

function observationFacts(row) {
  const o = row.observed;
  return { operation: row.operation, invoked: row.invoked ?? null, lookupStatus: row.lookupStatus ?? null,
    state: o.state, started: o.started, errorCode: o.errorCode ?? null, evidenceRefs: [...o.evidenceRefs],
    providerOutcome: row.providerObservation?.outcome ?? null, evidenceFingerprint: row.evidenceFingerprint ?? null,
    charge: { ...row.charge }, artifactSha256: row.output?.artifact?.sha256 ?? null,
    regionIds: row.output?.regionIds ?? null, missingRegionIds: row.output?.missingRegionIds ?? null };
}

function readAttempt(a, job, stage, seen) {
  const req = a?.request, input = req?.input, id = input?.executionId, pin = a?.pin;
  requireValue(input && equal(input.binding, job.binding) && input.node?.stage === stage &&
    Array.isArray(a.observations) && typeof a.dispatchIntent === 'boolean' && typeof a.cancelled === 'boolean' &&
    ['EXECUTE_STAGE', 'RESERVE_FALLBACK', 'EXECUTE_FALLBACK'].includes(req.action) &&
    digest(pin?.inputFingerprint) && sameProvider(pin.provider, req.provider), wrongStage);
  const identity = stage15RequestIdentity(input, req.provider);
  requireValue(identity.inputFingerprint === pin.inputFingerprint, wrongStage);
  const starts = a.startEvidenceIds ?? [];
  requireValue(Array.isArray(starts) && starts.every(identifier) && (!starts.length || a.dispatchIntent) &&
    (a.dispatchIntent || a.observations.every(r => r.invoked !== true && r.observed?.started !== true)) &&
    (req.action !== 'RESERVE_FALLBACK' || !a.dispatchIntent && !a.observations.length), wrongStage);
  requireValue(!seen.executions.has(id) && !seen.fingerprints.has(pin.inputFingerprint), conflict);
  seen.executions.add(id);
  seen.fingerprints.add(pin.inputFingerprint);
  if (stage === 'TRANSLATE' && req.action === 'EXECUTE_STAGE') {
    requireValue(sameProvider(req.provider, job.primaryProvider), wrongCell);
  }
  const confirmed = new Map(), refs = new Set(starts), lookupRows = new Set(), started = new Set();
  for (const ref of starts) claimEvidence(ref, id, seen);
  if (starts.length) started.add(true);
  let last, ambiguousLookups = false, dispatched = false;
  for (const r of a.observations) {
    const o = r?.observed;
    requireValue(o?.attemptId === id && o.stage === stage && equal(o.binding, job.binding) &&
      r.inputFingerprint === pin.inputFingerprint && r.usageScopeSha256 === identity.usageScopeSha256 &&
      o.parentsSha256 === identity.parentsSha256 && sameProvider(r.provider, req.provider) &&
      ['DISPATCH', 'LOOKUP'].includes(r.operation) && Array.isArray(o.evidenceRefs) &&
      !(r.output && Object.hasOwn(r.output, 'bytes')), wrongStage);
    if (o.started !== null) started.add(o.started);
    if (o.started === true || r.operation === 'DISPATCH' && r.invoked === true) dispatched = true;
    if (r.operation === 'LOOKUP' && r.invoked !== false) {
      const key = contentSha256(r);
      if (lookupRows.has(key)) ambiguousLookups = true;
      lookupRows.add(key);
    }
    for (const ref of [...o.evidenceRefs, ...(r.charge?.source == null ? [] : [r.charge.source])]) {
      claimEvidence(ref, id, seen);
      refs.add(ref);
    }
    checkSettlement(r);
    last = observedOutcome(r, input);
    if (o.state !== 'RESULT_UNKNOWN') {
      const key = contentSha256([o.state, r.output?.artifact ?? null]);
      if (confirmed.get(key)?.status !== 'succeeded') confirmed.set(key, last);
    }
  }
  const ledger = measureStage15Attempt(a);
  const beforeDispatch = !a.dispatchIntent && !a.observations.length && (a.cancelled || req.action === 'RESERVE_FALLBACK');
  const status = confirmed.size > 1 || started.size > 1 ? { status: 'unknown', reason: 'CONFLICTING_STAGE_OUTCOMES' } :
    confirmed.values().next().value ?? last ?? { status: beforeDispatch ? 'not_run' : 'unknown',
      reason: beforeDispatch ? 'BEFORE_DISPATCH' : 'ATTEMPT_RECEIPT_MISSING' };
  const lookupCount = ambiguousLookups ? null : ledger.lookupCount;
  return { executionId: id, action: req.action, previousExecutionId: req.previousExecutionId ?? null, provider: { ...req.provider },
    nodeId: input.node.id, regionId: input.node.regionId, regionIds: [...input.regionIds],
    inputFingerprint: pin.inputFingerprint, usageScopeSha256: identity.usageScopeSha256,
    ...status, resultSha256: status.status === 'succeeded' ? status.resultSha256 : null,
    dispatched: dispatched ? true : beforeDispatch || a.observations.some(r => r.operation === 'DISPATCH' && r.invoked === false) ? false : null,
    evidenceRefs: [...refs], observations: a.observations.map(observationFacts), lookupCount,
    lookupCountReason: lookupCount === null ? 'LOOKUP_MULTIPLICITY_UNKNOWN' : null,
    lookupMs: ambiguousLookups || ledger.values.lookupMs == null ? unknown('LOOKUP_TIME_UNCONFIRMED', 'ms') : measured(ledger.values.lookupMs, 'ms'),
    elapsedMs: ledger.values.elapsedMs == null ? unknown('ATTEMPT_TIME_NOT_REPORTED', 'ms') : measured(ledger.values.elapsedMs, 'ms'),
    charge: charge([ledger.costUsd]) };
}

function readStage(row, stage, job, seen, engineTime) {
  requireValue(row?.attempts == null || Array.isArray(row.attempts), invalidReceipt);
  const attempts = row?.attempts?.map(a => readAttempt(a, job, stage, seen)) ?? [];
  for (const [i, attempt] of attempts.entries()) {
    requireValue(attempt.usageScopeSha256 === attempts[0].usageScopeSha256, wrongStage);
    if (attempt.action !== 'EXECUTE_STAGE') {
      const prior = attempts.slice(0, i).find(a => a.executionId === attempt.previousExecutionId);
      requireValue(prior && prior.provider.providerId !== attempt.provider.providerId, wrongStage);
    }
  }
  const effective = attempts.filter(a => a.action !== 'RESERVE_FALLBACK');
  const last = effective.at(-1);
  const unresolved = effective.slice(0, -1).find(a => a.status === 'unknown');
  const final = unresolved ?? last ?? attempts.at(-1);
  const status = final?.status ?? 'unknown';
  const observedCount = list => !attempts.length || list.some(a => a.dispatched === null) ? null :
    list.filter(a => a.dispatched).length;
  const retryCount = observedCount(effective.filter(a => a.action === 'EXECUTE_STAGE').slice(1));
  const fallbackCount = observedCount(attempts.filter(a => a.action === 'EXECUTE_FALLBACK'));
  return { stage, status, reason: final?.reason ?? (final ? null : 'STAGE_RECEIPT_MISSING'),
    resultSha256: status === 'succeeded' ? final.resultSha256 : null,
    elapsedMs: meter(row?.elapsedMs ?? engineTime, 'ms', 'STAGE_TIME_NOT_REPORTED'),
    peakRamBytes: meter(row?.peakRamBytes, 'bytes', 'STAGE_RAM_NOT_REPORTED'),
    attempts, retryCount, fallbackCount, countReason: retryCount === null || fallbackCount === null ? 'ATTEMPT_HISTORY_INCOMPLETE' : null,
    charge: charge(attempts.map(a => a.charge.amount)) };
}

function readJob(job, receipt, seen) {
  const page = receipt?.page, processing = page?.processing;
  const expected = rangeOfStages(job);
  const byStage = new Map();
  requireValue(receipt?.stages == null || Array.isArray(receipt.stages), invalidReceipt);
  for (const row of receipt?.stages ?? []) {
    requireValue(expected.includes(row?.stage) && !byStage.has(row.stage), wrongStage);
    byStage.set(row.stage, row);
  }
  const rows = expected.map(stage => readStage(byStage.get(stage), stage, job, seen, processing?.stageTimes?.[stage.toLowerCase()]));
  let status = processing?.status ?? 'unknown', reason = processing?.errorCode ?? null;
  if (status === 'succeeded') {
    const blocking = ['failed', 'partial', 'interrupted', 'unknown', 'not_run'].map(s => rows.find(r => r.status === s)).find(Boolean);
    if (blocking) { status = blocking.status; reason = blocking.reason; }
    else if (page.evidenceKind === 'not_run') { status = 'unknown'; reason = 'RUN_EVIDENCE_CONFLICT'; }
    else if (page.typesetting?.subjectSha256 !== rows.at(-1).resultSha256) { status = 'unknown'; reason = 'FINAL_RESULT_PIN_MISMATCH'; }
  }
  if (status !== 'succeeded' && reason === null) reason = receipt ? 'PAGE_' + status.toUpperCase() : 'JOB_RECEIPT_MISSING';
  return { jobId: job.binding.requestId, receiptId: receipt?.receiptId ?? null, receiptSha256: receipt ? contentSha256(receipt) : null,
    evidenceKind: page?.evidenceKind ?? null, reportedStatus: processing?.status ?? null, status, reason,
    resultSha256: status === 'succeeded' ? rows.at(-1).resultSha256 : null,
    initialization: readInitialization(receipt?.initialization), timeScope: processing?.timeScope ?? null,
    elapsedMs: meter(processing?.engineElapsedMs, 'ms', 'ENGINE_TIME_NOT_REPORTED'),
    peakRamBytes: meter(processing?.peakRamBytes, 'bytes', 'RAM_OBSERVATION_NOT_REPORTED'),
    pageAttempts: page?.attempts ?? null, stages: rows, charge: charge(stageAmounts(rows)) };
}

/** Join saved, byte-free receipts to independently pinned jobs. No evaluator, engine or provider is run. */
export function collectStage16Observations(plan, receipts, anchors) {
  const registered = registerJobs(plan, anchors);
  requireValue(Array.isArray(receipts), invalidReceipt);
  const byJob = new Map(), ids = new Map();
  for (const receipt of receipts) {
    requireValue(identifier(receipt?.receiptId), invalidReceipt);
    const id = receipt.page?.identity?.jobId, target = registered.byJob.get(id);
    requireValue(target, wrongCell);
    bindPage(receipt, target.cell, target.job, anchors.lockId);
    const previous = byJob.get(id);
    if (previous || ids.has(receipt.receiptId)) {
      requireValue(ids.get(receipt.receiptId) === id && equal(previous, receipt), 'STAGE16_RECEIPT_CONFLICT');
    } else {
      ids.set(receipt.receiptId, id);
      byJob.set(id, receipt);
    }
  }
  const seen = { executions: new Set(), fingerprints: new Set(), evidence: new Map() };
  const cells = [...registered.cells.values()].map(cell => {
    const jobs = cell.jobs.map(job => readJob(job, byJob.get(job.binding.requestId), seen));
    return { workId: cell.workId, pageId: cell.pageId, matrixSha256: cell.matrixSha256, condition: cell.condition,
      path: cell.path, jobs, completed: jobs.every(j => j.status === 'succeeded') };
  });
  const jobs = cells.flatMap(c => c.jobs);
  const history = aggregateOperations(jobs.map(j => ({
    evidenceKind: j.evidenceKind, processing: { status: j.status, errorCode: j.reason }, attempts: j.pageAttempts,
  })));
  return structuredClone({ schemaVersion: 1, kind: 'stage16-execution-observations', lockId: anchors.lockId,
    jobsSha256: anchors.jobsSha256, cells, summary: { plannedCells: cells.length, completedCells: cells.filter(c => c.completed).length,
      plannedJobs: jobs.length, observedJobs: byJob.size, completedJobs: jobs.filter(j => j.status === 'succeeded').length,
      charge: charge(stageAmounts(jobs.flatMap(j => j.stages))), recordedSuccess: history.recordedSuccess } });
}
