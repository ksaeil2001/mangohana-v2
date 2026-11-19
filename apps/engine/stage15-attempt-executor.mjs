import fs from 'node:fs/promises';
import { lstatSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { atomicState } from './store.mjs';
import { digest, regularDirectory, writeExclusive } from './image-permit-store.mjs';
import { readBounded } from './translation-review-store.mjs';
import { createStage15ProviderAdapter, aggregateStage15Usage } from './stage15-provider-adapter.mjs';
import { batchProviderUsage, checkBatchReservation, usdUnits } from './stage15-batch-accounting.mjs';
import checkpoint from '../../packages/ai-engine/quality/recovery-checkpoint.cjs';
import inspection from '../../packages/ai-engine/quality/stage15-quality-inspection.cjs';
import policy from '../../packages/ai-engine/quality/stage15-quality-decision.cjs';
import dag from '../../packages/ai-engine/quality/stage15-stage-graph.cjs';

const { key } = checkpoint;
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const same = (a, b) => key(a) === key(b);
const fallback = request => ['RESERVE_FALLBACK', 'EXECUTE_FALLBACK'].includes(request.action);
const epochName = n => 'attempt-epoch-' + String(n).padStart(12, '0') + '.json';
const fail = code => Object.assign(new Error(code), { code });
const maxStateBytes = 24 * 1024 * 1024;
// The executable synthetic route accepts terminal provider availability/failure facts.
// A wire outcome of FAILURE alone can also describe stale authority, cancellation or bad output.
const fallbackReasons = new Set(['UNAVAILABLE','PROVIDER_UNAVAILABLE','MODEL_UNAVAILABLE','ENGINE_UNAVAILABLE',
  'FAILED','PROVIDER_FAILED','MODEL_FAILED','NOT_STARTED']);

export function mayExecuteStage15Fallback(value) {
  return ['FAILED','NOT_STARTED'].includes(value.status) && !value.execution.resultUnknown &&
    !value.blockedReasons.length && !value.cancelled && fallbackReasons.has(value.execution.errorCode);
}

function demand(condition, code) {
  if (!condition) throw fail(code);
}

// Each slot retains its original name. Legacy slots are flat files. New writers rename a
// nonempty directory containing the synced snapshot; a competing rename cannot replace it.
function epochStore(root, onBoundary, withFence) {
  async function read() {
    await regularDirectory(root);
    const names = (await fs.readdir(root)).filter(name => /^attempt-epoch-\d{12}\.json$/.test(name)).sort();
    if (!names.length) return { sequence: 0, attempts: [] };
    const latest = names.at(-1);
    const slot = path.join(root, latest);
    let snapshot = slot;
    if ((await fs.lstat(slot)).isDirectory()) {
      await regularDirectory(slot);
      snapshot = path.join(slot, 'state.json');
    }
    const state = JSON.parse(await readBounded(snapshot, maxStateBytes));
    demand(state.version === 1 && epochName(state.sequence) === latest && state.sequence === names.length &&
      Array.isArray(state.attempts) && key(state.attempts) === state.sha256, 'ATTEMPT_STORE_CORRUPT');
    return state;
  }

  async function change(transition, edit) {
    for (;;) {
      const { sequence, attempts } = await read();
      const update = await edit(attempts);
      if (!update.write) return update.value;
      const stagingDirectory = await fs.mkdtemp(path.join(root, '.pending-'));
      let installedDirectory = false;
      try {
        await onBoundary('before-commit', { transition, stagingDirectory });
        await atomicState(stagingDirectory, { version: 1, sequence: sequence + 1, attempts, sha256: key(attempts) });
        const stagedFile = path.join(stagingDirectory, 'state.json');
        demand((await fs.stat(stagedFile)).size <= maxStateBytes, 'ATTEMPT_STORE_FULL');
        const install = () => {
          if (update.guard && !update.guard()) return false;
          const slot = path.join(root, epochName(sequence + 1));
          if (lstatSync(slot, { throwIfNoEntry: false })) return false;
          try {
            renameSync(stagingDirectory, slot);
            installedDirectory = true;
          } catch (error) {
            // Windows volumes report different collision codes. Retry only a claimed slot.
            if (lstatSync(slot, { throwIfNoEntry: false })) return false;
            throw error;
          }
          update.onInstalled?.();
          return true;
        };
        const installed = update.request ? await withFence(update.request, install, transition) : install();
        if (!installed) continue;
        return update.value;
      } finally {
        if (!installedDirectory) await fs.rm(stagingDirectory, { recursive: true, force: true });
      }
    }
  }
  return { read, change };
}

export async function readStage15BatchUsage(root, batch, pages) {
  const {attempts} = await epochStore(root).read();
  return batchProviderUsage(attempts,batch,pages);
}

function logicalKey({ input: { binding: b, node } }) {
  return key([b.ownerScope, b.projectId, b.pageId, b.pageNumber, b.generation, b.editRevision, b.contextRevision,
    b.layoutRevision, b.sourceSha256, b.inputDigest, b.mode, node.stage, node.regionId]);
}

function commandKey({ requestKey, input: { binding: b } }) {
  return key([b.ownerScope, b.projectId, b.pageId, requestKey]);
}

function pageRequestKey({ action, input: { binding: b, node } }) {
  return key([b.ownerScope, b.projectId, b.pageId, b.requestId, node.stage, node.regionId, action]);
}

function find(attempts, executionId) {
  const attempt = attempts.find(a => a.request.input.executionId === executionId);
  demand(attempt, 'ATTEMPT_NOT_FOUND');
  return attempt;
}

function scopeReasons(attempt, authority, now) {
  const request = attempt.request;
  const reasons = [];
  if (authority?.verified !== true || authority.runAuthorityId !== request.runAuthorityId ||
      authority.executionRequestSha256 !== attempt.requestSha256 || !same(authority.binding ?? null, request.input.binding) ||
      typeof authority.cancelled !== 'boolean') reasons.push('AUTHORITY_MISMATCH');
  if (authority?.expiresAt != null && !(Number.isFinite(authority.expiresAt) && now < authority.expiresAt)) reasons.push('AUTHORITY_EXPIRED');
  if (authority?.cancelled || attempt.cancelled) reasons.push('CANCELLED');
  return reasons;
}

// Keep each normalized provider/charge receipt. A lookup miss has no authority to erase a start,
// charge or terminal observation. Conflicting positive evidence stays available for reconciliation.
function facts(attempt) {
  const { request, observations } = attempt;
  const confirmed = observations.filter(r => r.observed.state !== 'RESULT_UNKNOWN');
  const best = confirmed.at(-1) ?? observations.at(-1);
  const beforeStart = !attempt.dispatchIntent && (attempt.cancelled || request.action === 'RESERVE_FALLBACK');
  const observed = structuredClone(best?.observed ?? {
    binding: request.input.binding, stage: request.input.node.stage, attemptId: request.input.executionId,
    parentsSha256: dag.stageParentsSha256(request.input.node.parents),
    state: beforeStart ? (attempt.cancelled ? 'CANCELLED' : 'CONFIRMED_NOT_STARTED') : 'RESULT_UNKNOWN',
    phase: beforeStart ? 'BEFORE_DISPATCH' : 'DISPATCHED', started: beforeStart ? false : null,
    errorCode: beforeStart ? (attempt.cancelled ? 'CANCELLED' : null) : 'RECEIPT_MISSING', artifact: null,
  });
  const starts = new Set(observations.map(r => r.observed.started).filter(v => v !== null));
  if (attempt.startEvidenceIds.length) starts.add(true);
  if (starts.has(true)) observed.started = true;
  observed.evidenceRefs = [...new Set([...attempt.startEvidenceIds, ...observations.flatMap(r => r.observed.evidenceRefs)])];
  observed.checks = [];
  const outcomes = new Set(confirmed.map(r => key([r.observed.state, r.output?.artifact ?? null])));
  let conflict = starts.size > 1 || outcomes.size > 1;
  let cost = null;
  if (observations.length) {
    try {
      const usage = aggregateStage15Usage(observations);
      cost = usage.charge.amount;
      // Keep the provider's decimal representation and its evidence in the execution view.
      if (cost !== null) cost = observations.find(r => r.charge.state === 'CONFIRMED').charge.amount;
    } catch (error) {
      if (!['STAGE15_USAGE_CONFLICT', 'STAGE15_EVIDENCE_CONFLICT'].includes(error.code)) throw error;
      conflict = true;
    }
  }
  if (conflict) Object.assign(observed, { state: 'RESULT_UNKNOWN', artifact: null, errorCode: 'EVIDENCE_CONFLICT' });
  observed.costUsd = cost;
  observed.usageConfirmed = cost !== null;
  let candidate = best?.output ?? null;
  if (candidate && candidate.file === null) {
    // A failed duplicate write cannot retire identical bytes already recorded by this attempt.
    const stored = observations.findLast(r => r.output?.file && same({ ...r.output, file: null }, candidate));
    if (stored) candidate = stored.output;
  }
  return { observed, candidate, lookupStatus: observations.findLast(r => r.operation === 'LOOKUP')?.lookupStatus ?? null };
}

async function allowFallback(attempts, request, statusOf, reserved) {
  const prior = attempts.find(a => a.request.input.executionId === request.previousExecutionId);
  const { ownerScope, projectId } = request.input.binding;
  const lineage = attempts.filter(a => a !== reserved && a.request.lineageId === request.lineageId &&
    a.request.input.binding.projectId === projectId && same(a.request.input.binding.ownerScope, ownerScope));
  demand(!lineage.some(a => fallback(a.request)), 'FALLBACK_CONSUMED');
  demand(prior && lineage.includes(prior) && !prior.cancelled && !fallback(prior.request) &&
    request.input.binding.mode === 'FULL_IMAGE' && request.provider.providerId !== prior.request.provider.providerId &&
    same({ ...prior.request.input, executionId: null }, { ...request.input, executionId: null }) &&
    same(prior.request.ancestors, request.ancestors), 'FALLBACK_INELIGIBLE');
  const previous = prior.observations;
  demand(previous.some(r => ['FAILURE', 'NOT_STARTED'].includes(r.providerObservation?.outcome) ||
    (r.observed.state === 'CONFIRMED_NOT_STARTED' && r.observed.phase === 'BEFORE_DISPATCH')), 'FALLBACK_INELIGIBLE');
  for (const a of lineage) {
    const status = await statusOf(a);
    demand(!status.execution.resultUnknown && status.status !== 'RESULT_UNKNOWN' &&
      (a !== prior || ['FAILED', 'NOT_STARTED'].includes(status.status)), 'FALLBACK_INELIGIBLE');
    if (a === prior && request.action === 'EXECUTE_FALLBACK') demand(mayExecuteStage15Fallback(status),'FALLBACK_INELIGIBLE');
  }
}

const unconfirmedWrite = (value, reason) => ({
  ...value, status: 'RESULT_UNKNOWN', publication: null, blockedReasons: [...value.blockedReasons, reason],
});

/** Internal synthetic composition. currentAuthority synchronously reads the owning scope by execution ID.
 * Only durable reservation winners dispatch. execute on an existing request is a read; recover never dispatches.
 */
export async function createStage15AttemptExecutor({ root, providers, currentAuthority, clock = Date.now, providerNow, onBoundary = () => {},
  withFence = (_request, install) => install(), knownBatchAttempts = () => [] } = {}) {
  demand(typeof root === 'string' && path.isAbsolute(root) && typeof currentAuthority === 'function', 'ATTEMPT_CONFIG_INVALID');
  root = path.resolve(root);
  await regularDirectory(root);
  const adapter = createStage15ProviderAdapter({ providers, now:providerNow });
  const store = epochStore(root, onBoundary, withFence);
  const current = a => structuredClone(currentAuthority(a.request.input.executionId, structuredClone(a.request)) ?? null);
  const read = async id => find((await store.read()).attempts, id);
  const stillCurrent = (a, snapshot) => {
    const latest = current(a);
    return same(snapshot, latest) && !scopeReasons(a, latest, clock()).length;
  };
  function pinMatches(a) {
    try { return same(adapter.describe(a.request.provider.providerId, a.request.input), a.pin); }
    catch { return false; }
  }

  async function view(a, auth) {
    const { request } = a, { binding, node, inputs } = request.input;
    const { observed, candidate, lookupStatus } = facts(a);
    const blockedReasons = scopeReasons(a, auth, clock());
    if (!pinMatches(a)) blockedReasons.push('PROVIDER_PIN_MISMATCH');
    if (request.batchBudget && observed.usageConfirmed && usdUnits(observed.costUsd) > usdUnits(request.batchBudget.quoteUsd))
      blockedReasons.push('STAGE15_BATCH_QUOTE_EXCEEDED');
    const qualityAuthority = { verified: !blockedReasons.length, binding: auth?.binding ?? binding, stage: node.stage,
      artifact: candidate?.artifact ?? null, softApprovals: auth?.softApprovals ?? [], requiredChecks: auth?.requiredChecks ?? [] };
    let assessment = { binding, observed, findings: [], authority: qualityAuthority };
    let graph = null, integrityUnknown = false;
    if (candidate && !blockedReasons.length) {
      let bytes;
      try {
        if (candidate.file == null) throw fail('ENOENT');
        bytes = await readBounded(path.join(root, candidate.file), 32 * 1024 * 1024);
        demand(digest(bytes) === candidate.artifact.sha256, 'CANDIDATE_INTEGRITY_FAILED');
      } catch (error) {
        blockedReasons.push(error.code === 'ENOENT' ? 'CANDIDATE_MISSING' : 'CANDIDATE_INTEGRITY_FAILED');
        integrityUnknown = true;
      }
      if (!integrityUnknown && observed.errorCode !== 'EVIDENCE_CONFLICT') {
        try {
          const subject = { ...node, artifact: candidate.artifact };
          const check = inspection.inspectStage({ binding, node: subject, observed, authority: qualityAuthority, inputs, bytes });
          assessment = check.assessment;
          // The inspector declares its own check. It cannot waive additional checks required by the owner.
          assessment.authority = qualityAuthority;
          graph = dag.analyzeStageGraph({ binding, graph: { binding, nodes: [...request.ancestors, subject] }, inspections: [check] });
        } catch (error) { blockedReasons.push(error.code ?? 'INSPECTION_INVALID'); }
      }
    }
    const decision = policy.assessStage(assessment);
    if (observed.errorCode === 'EVIDENCE_CONFLICT') blockedReasons.push(observed.errorCode);
    const checks = assessment.observed.checks, findings = assessment.findings;
    const publishable = !blockedReasons.length && graph !== null && decision.kind === 'PASS';
    const receipt = publishable ? { executionId: observed.attemptId, requestSha256: a.requestSha256, inputFingerprint: a.pin.inputFingerprint,
      artifact: candidate.artifact, checkEvidenceIds: checks.map(c => c.evidenceId), findings,
      acceptedSoftFindingIds: decision.acceptedSoftFindingIds, reviewEvidenceIds: qualityAuthority.softApprovals
        .filter(approval => decision.acceptedSoftFindingIds.includes(approval.findingId) && policy.assessStage({
          ...assessment, authority: { ...qualityAuthority, softApprovals: [approval] },
        }).acceptedSoftFindingIds.includes(approval.findingId)).map(approval => approval.evidenceId),
      requiredChecks: qualityAuthority.requiredChecks } : null;
    const published = receipt && a.publications.find(p => same(receipt, p));
    let status = decision.kind;
    if (decision.execution.resultUnknown || integrityUnknown) status = 'RESULT_UNKNOWN';
    else if (blockedReasons.includes('CANCELLED')) status = 'CANCELLED';
    else if (blockedReasons.length) status = 'BLOCKED';
    else if (publishable) status = published ? 'SUCCEEDED' : 'CANDIDATE';
    else if (observed.state === 'CONFIRMED_FAILURE') status = 'FAILED';
    else if (observed.state === 'CONFIRMED_NOT_STARTED') status = 'NOT_STARTED';
    if (request.action === 'RESERVE_FALLBACK' && !blockedReasons.length) status = 'FALLBACK_RESERVED';
    return { value: { status, execution: decision.execution, blockedReasons, cancelled: a.cancelled || auth?.cancelled === true,
      lookupStatus, resourceReleaseUnconfirmed:a.observations.some(r=>r.portPending || ['CLEANUP_FAILED','RUNTIME_LEASE_BLOCKED'].includes(r.observed.errorCode)),
      decision, checks, findings, graph, candidate, publication: published ?? null }, receipt };
  }

  async function get(executionId) {
    // A status reader also reopens the bytes and fences changes accepted during inspection.
    for (;;) {
      const a = await read(executionId), auth = current(a);
      const { value } = await view(a, auth);
      if (!value.publication || (stillCurrent(a, auth) && same(a, await read(executionId)) && stillCurrent(a, auth))) return value;
    }
  }

  async function finalize(executionId) {
    try {
      await store.change('publish', async attempts => {
        const a = find(attempts, executionId), auth = current(a);
        const { value, receipt } = await view(a, auth);
        if (!receipt || value.publication) return {};
        await onBoundary('before-publish', { executionId });
        a.publications.push(receipt);
        return { write: true, request: a.request, guard: () => stillCurrent(a, auth) };
      });
    } catch {
      const state = await get(executionId);
      return unconfirmedWrite(state, 'COMMIT_UNKNOWN');
    }
    return get(executionId);
  }

  async function record(executionId, response) {
    let output = null, storageError = null;
    if (response.output) {
      const { bytes, ...meta } = response.output;
      const file = 'candidate-' + randomUUID() + '.bin';
      output = { ...meta, file: null };
      try {
        await onBoundary('before-candidate', { executionId, file });
        // Only a fully synced, exclusively created observation file may enter the journal.
        await writeExclusive(path.join(root, file), bytes);
        output.file = file;
      } catch (error) { storageError = error.code ?? 'CANDIDATE_WRITE_UNCONFIRMED'; }
    }
    const result = { ...response, output, storageError };
    try {
      await store.change('observation', attempts => {
        const a = find(attempts, executionId);
        demand(a.pin.inputFingerprint === result.inputFingerprint && result.observed.attemptId === executionId, 'OBSERVATION_MISMATCH');
        a.observations.push(result);
        return { write: true };
      });
    } catch (error) {
      if (error.code === 'OBSERVATION_MISMATCH') throw error;
      const a = await read(executionId);
      // This caller still knows what it received. A restarted caller needs a durable receipt or a lookup.
      a.observations.push(result);
      return unconfirmedWrite((await view(a, current(a))).value, 'OBSERVATION_COMMIT_UNKNOWN');
    }
    if (storageError) return unconfirmedWrite(await get(executionId), 'CANDIDATE_WRITE_UNCONFIRMED');
    return finalize(executionId);
  }

  async function recordStart({ executionId, inputFingerprint, evidenceId }) {
    await store.change('started', attempts => {
      const a = find(attempts, executionId);
      demand(a.dispatchIntent && a.pin.inputFingerprint === inputFingerprint, 'OBSERVATION_MISMATCH');
      if (a.startEvidenceIds.includes(evidenceId)) return {};
      a.startEvidenceIds.push(evidenceId);
      return { write: true };
    });
  }

  async function execute(command, {signal, deadlineMs = command?.deadlineMs} = {}) {
    const request = structuredClone(command);
    demand(id(request?.requestKey) && id(request.lineageId) && id(request.runAuthorityId) &&
      id(request.input?.executionId) && id(request.provider?.providerId) && Array.isArray(request.ancestors) &&
      (fallback(request) ? id(request.previousExecutionId) : request.action === 'EXECUTE_STAGE' && request.previousExecutionId == null),
    'EXECUTION_REQUEST_REQUIRED');
    demand(isDeepStrictEqual(request, JSON.parse(JSON.stringify(request))), 'EXECUTION_REQUEST_INVALID');
    for (const limit of [request.deadlineMs, deadlineMs])
      demand(limit == null || (Number.isFinite(limit) && limit >= 0 && limit - performance.now() <= 2_147_483_647), 'EXECUTION_DEADLINE_INVALID');
    const executionId = request.input.executionId, requestSha256 = key(request);
    const won = await store.change('reserve', async attempts => {
      const existing = attempts.find(a => commandKey(a.request) === commandKey(request));
      if (existing) {
        demand(existing.requestSha256 === requestSha256, 'IDEMPOTENCY_CONFLICT');
        return { value: false };
      }
      const pin = adapter.describe(request.provider.providerId, request.input);
      demand(same(pin.provider, request.provider), 'PROVIDER_PIN_MISMATCH');
      const a = { request, requestSha256, pin, dispatchIntent: false, cancelled: false, startEvidenceIds: [], observations: [], publications: [] };
      const auth = current(a), reasons = scopeReasons(a, auth, clock());
      demand(!reasons.length, reasons[0]);
      dag.validateStageInputs(request.input.binding, request.ancestors, request.input.node);
      demand(!attempts.some(other => other.request.input.executionId === executionId), 'EXECUTION_ID_CONFLICT');
      checkBatchReservation(attempts, request, knownBatchAttempts());
      if (fallback(request)) {
        await allowFallback(attempts, request, async a => (await view(a, current(a))).value);
      } else {
        demand(!attempts.some(a => !fallback(a.request) && logicalKey(a.request) === logicalKey(request)), 'PRIMARY_CONSUMED');
        demand(!attempts.some(a => pageRequestKey(a.request) === pageRequestKey(request)), 'IDEMPOTENCY_CONFLICT');
      }
      attempts.push(a);
      return { write: true, value: true, request, guard: () => stillCurrent(a, auth) };
    });
    if (!won || request.action === 'RESERVE_FALLBACK') return get(executionId);
    await onBoundary('after-reserve', { executionId });
    let delivery;
    try { await store.change('dispatch-intent', async attempts => {
      const a = find(attempts, executionId), auth = current(a);
      if (scopeReasons(a, auth, clock()).length || a.dispatchIntent || a.observations.length) return { value: false };
      checkBatchReservation(attempts, request, knownBatchAttempts());
      if (fallback(request)) await allowFallback(attempts, request, async prior => (await view(prior, current(prior))).value, a);
      a.dispatchIntent = true;
      return { write: true, request, guard: () => stillCurrent(a, auth), onInstalled() {
        // Enter the port before yielding for staging cleanup. All later callers see the spent slot.
        delivery = adapter.dispatch(request.provider.providerId, request.input, { signal, deadlineMs, onStarted: recordStart });
      } };
    }); } catch (error) {
      // A context fence or staging cleanup may fail *after* the durable CAS entered
      // the provider. Its answer must still be recorded under the consumed attempt.
      if (!delivery) throw error;
    }
    if (!delivery) return get(executionId);
    const response = await delivery;
    await onBoundary('after-response', { executionId });
    return record(executionId, response);
  }

  async function recover(executionId, { signal, deadlineMs } = {}) {
    const a = await read(executionId), auth = current(a), { value } = await view(a, auth);
    // A stored candidate is locally revalidated. Missing receipts require the original port and pin.
    const missingBytes = value.blockedReasons.includes('CANDIDATE_MISSING');
    const latest = current(a);
    if (a.request.action === 'RESERVE_FALLBACK' || (!value.execution.resultUnknown && !missingBytes) || (a.cancelled && !a.dispatchIntent) ||
        value.blockedReasons.some(code => !['CANCELLED', 'CANDIDATE_MISSING'].includes(code)) ||
        !same(auth, latest) || scopeReasons(a, latest, clock()).some(code => code !== 'CANCELLED') || latest?.cancelled) return finalize(executionId);
    let delivery;
    try {
      await withFence(a.request, () => {
        const now = current(a);
        if (same(auth, now) && !now?.cancelled && !scopeReasons(a,now,clock()).some(code => code !== 'CANCELLED'))
          delivery = adapter.lookup(a.request.provider.providerId, a.request.input, { signal, deadlineMs });
      }, 'lookup');
    } catch (error) {
      if (!delivery) return {...value, publication:null, blockedReasons:[...value.blockedReasons,error.code ?? 'LOOKUP_FENCE_UNKNOWN']};
    }
    return delivery ? record(executionId, await delivery) : finalize(executionId);
  }

  async function cancel(executionId) {
    await store.change('cancel', attempts => {
      const a = find(attempts, executionId), auth = current(a);
      demand(auth && same(auth.binding?.ownerScope ?? null, a.request.input.binding.ownerScope), 'AUTHORITY_MISMATCH');
      if (a.cancelled) return {};
      a.cancelled = true;
      return { write: true, guard: () => same(auth, current(a)) };
    });
    return get(executionId);
  }

  return { execute, recover, cancel, get };
}
