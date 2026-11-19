import { contentSha256 } from '../../../packages/evaluation/dataset-contract.mjs';
import { createExperimentLock } from '../../../packages/evaluation/stage16-experiment-lock.mjs';
import { addHoldoutPage, experiment, matrixFor, sha } from './stage16-experiment.mjs';

export const stageOrder = ['OCR', 'TRANSLATE', 'MASK', 'INPAINT', 'TYPESET'];
const reading = (value, unit) => ({ value, unit, reason: null });
const providerFor = name => ({ providerId: 'provider-' + name, modelId: 'model-' + name,
  modelVersion: 'synthetic-v1', profileDigest: sha('profile-' + name) });

export function scenario({ fixed = false, secondPage = false, input = experiment() } = {}) {
  if (secondPage) addHoldoutPage(input, 'work-other', 'page-other');
  if (fixed) {
    for (const [i, sample] of input.preregistration.source_and_gt_hashes.entries()) {
      const page = input.manifest.pages.find(p => p.pageId === sample.pageId);
      input.matrices[i] = matrixFor(page, { shared: { intermediateSha256: sha('checkpoint-' + page.pageId) } });
      sample.matrixSha256 = input.matrices[i].matrixSha256;
    }
  }
  const lock = createExperimentLock(input, contentSha256(input.preregistration), {
    candidateSelectionSha256: contentSha256(input.candidateSelection), holdoutHistorySha256: contentSha256(input.holdoutHistory),
  });
  const jobs = input.matrices.flatMap((matrix, i) => matrix.conditions.map(c => {
    const { pageId, sourceSha256 } = matrix.shared;
    const requestId = [pageId, c.model, c.processing].join(':');
    return { pageId, model: c.model, processing: c.processing, firstStage: fixed ? 'INPAINT' : 'OCR', separateMask: true,
      primaryProvider: providerFor(c.model), binding: {
        ownerScope: { kind: 'session', id: 'synthetic-owner' }, projectId: 'synthetic-project',
        requestId, pageId: 'runtime-' + pageId, pageNumber: i + 1, sourceSha256,
        inputDigest: sha('input-' + requestId), generation: 1, editRevision: 0, contextRevision: 0,
        layoutRevision: 0, mode: 'FULL_IMAGE',
      } };
  }));
  return { plan: { lock, matrices: input.matrices, jobs }, anchors: { lockId: lock.lockId, jobsSha256: contentSha256(jobs) } };
}

// Metadata in the shape retained by the Stage15 journal. All hashes below describe synthetic labels.
export function attemptFor(job, stage, { suffix = 'primary', state = 'CONFIRMED_SUCCESS', amount = '0',
  action = 'EXECUTE_STAGE', previousExecutionId, provider = job.primaryProvider, regionId = null,
  regionIds = ['r1', 'r2'], inputsSha256 = sha('inputs-' + stage) } = {}) {
  const binding = structuredClone(job.binding);
  const executionId = [binding.requestId, stage, suffix].join(':');
  const parents = [{ nodeId: 'parent', artifactId: 'parent-' + stage, sha256: sha('parents-' + stage) }];
  const parentsSha256 = contentSha256(parents);
  const node = { id: stage.toLowerCase(), stage, regionId, inputsSha256, parents };
  const scope = { requestId: binding.requestId, inputDigest: binding.inputDigest, binding, stage,
    nodeId: node.id, regionId, regionIds, inputsSha256, parentsSha256 };
  const inputFingerprint = contentSha256({ ...scope, executionId, ...provider });
  const artifact = { artifactId: executionId + ':output', sha256: sha('output-' + executionId) };
  const complete = state === 'CONFIRMED_SUCCESS';
  const started = state === 'RESULT_UNKNOWN' ? null : state !== 'CONFIRMED_NOT_STARTED';
  const charge = { state: amount === null ? 'UNCONFIRMED' : 'CONFIRMED', amount, currency: 'USD',
    source: amount === null ? null : executionId + ':fee' };
  const outcome = { CONFIRMED_SUCCESS: 'SUCCESS', PARTIAL: 'PARTIAL', CONFIRMED_FAILURE: 'FAILURE',
    RESULT_UNKNOWN: 'UNKNOWN', CONFIRMED_NOT_STARTED: 'NOT_STARTED', CANCELLED: 'CANCELLED' }[state];
  const evidenceId = executionId + ':receipt';
  const observed = { binding, stage, attemptId: executionId, state, started, phase: 'DISPATCHED',
    usageConfirmed: amount !== null, costUsd: amount, artifact: complete ? artifact : null,
    evidenceRefs: [evidenceId], parentsSha256, errorCode: complete ? null : outcome };
  const observation = { operation: 'DISPATCH', invoked: true, lookupStatus: null, inputFingerprint,
    usageScopeSha256: contentSha256(scope), provider: { ...provider }, observed,
    providerObservation: { evidenceId, outcome, started, finishReason: complete ? 'COMPLETED' : outcome,
      usageConfirmed: amount !== null, costUsd: amount, usageEvidenceId: charge.source },
    evidenceFingerprint: contentSha256({ state, artifact, amount }), charge,
    output: complete || state === 'PARTIAL' ? { complete, artifact, regionIds: complete ? regionIds : ['r1'],
      missingRegionIds: complete ? [] : ['r2'] } : null,
    usage: { elapsedMs: 3, lookupMs: null, providerMs: 2, modelMs: 1, queueMs: null,
      modelRequestMs: null, localModelRequests: null, tokenUsage: null } };
  return { request: { action, ...(previousExecutionId ? { previousExecutionId } : {}), provider: { ...provider }, input: {
    executionId, binding, regionIds, node } },
    pin: { provider: { ...provider }, inputFingerprint }, dispatchIntent: true, cancelled: false, observations: [observation] };
}

export function receiptFor(plan, job = plan.jobs[0], { states = {}, amounts = {}, mode = 'cold' } = {}) {
  const matrix = plan.matrices.find(m => m.shared.pageId === job.pageId);
  const cell = matrix.conditions.find(c => c.model === job.model && c.processing === job.processing);
  const b = job.binding;
  const route = stageOrder.filter(s => s !== 'MASK' || job.separateMask);
  const stages = route.slice(route.indexOf(job.firstStage)).map(stage => ({
    stage, elapsedMs: reading(5, 'ms'), peakRamBytes: reading(100, 'bytes'),
    attempts: [attemptFor(job, stage, { state: states[stage], amount: amounts[stage] })],
  }));
  return { receiptId: 'receipt:' + b.requestId, lockId: plan.lock.lockId, matrixSha256: matrix.matrixSha256,
    condition: { ...cell }, intermediateSha256: matrix.shared.intermediateSha256,
    initialization: { mode, reason: null, elapsedMs: reading(mode === 'cold' ? 7 : 1, 'ms') }, stages,
    page: { pageId: job.pageId, evidenceKind: 'synthetic', identity: {
      ownerId: b.ownerScope.id, projectId: b.projectId, pageId: b.pageId, jobId: b.requestId, workId: matrix.shared.workId,
      sourceRevision: null, editRevision: b.editRevision, contextRevision: b.contextRevision,
      processingGeneration: b.generation, storageRevision: null },
      sourceHashes: { datasetEncodedSha256: matrix.shared.sourceSha256 },
      processing: { status: 'succeeded', errorCode: null, engineElapsedMs: reading(40, 'ms'), peakRamBytes: reading(900, 'bytes') },
      typesetting: { subjectSha256: stages.at(-1).attempts[0].observations[0].observed.artifact?.sha256 ?? null },
      attempts: [{ attemptId: 'history:' + b.requestId, jobId: b.requestId, number: 1, manualEdits: 0, status: 'succeeded' }],
    } };
}
