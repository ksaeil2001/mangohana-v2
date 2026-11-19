import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { aggregateStage15Usage, createStage15ProviderAdapter } from '../../apps/engine/stage15-provider-adapter.mjs';
import checkpoint from '../../packages/ai-engine/quality/recovery-checkpoint.cjs';
import inspection from '../../packages/ai-engine/quality/stage15-quality-inspection.cjs';
import decision from '../../packages/ai-engine/quality/stage15-quality-decision.cjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesOf = value => Buffer.from(JSON.stringify(value));
const noUsage = { usageConfirmed: false, costUsd: null, usageEvidenceId: null };
const ids = ['r1', 'r2'];

function input(executionId = 'attempt-1') {
  const inputs = { lines: ids.map(id => ({ id, sourceText: '合成', sourceLanguage: 'ja' })) };
  return {
    executionId, inputs, regionIds: [...ids],
    binding: {
      ownerScope: { kind: 'session', id: 'synthetic-owner' }, projectId: 'work', pageId: 'page-1',
      pageNumber: 1, requestId: 'request-1', generation: 2, editRevision: 1, contextRevision: 0,
      layoutRevision: 3, sourceSha256: sha('source'), inputDigest: sha('page-input'), mode: 'FULL_IMAGE',
    },
    node: { id: 'translate-page', stage: 'TRANSLATE', regionId: null, inputsSha256: checkpoint.key(inputs),
      parents: [{ nodeId: 'ocr', artifactId: 'current-ocr', sha256: sha('ocr') }] },
  };
}

function finalResponse() {
  const content = JSON.stringify({ regions: ids.map(id => ({ id, source_reading: '合成', translation: '합성', uncertain: false })) });
  return bytesOf({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
}

function receipt(request, overrides = {}) {
  const bytes = finalResponse();
  return {
    executionId: request.executionId, requestId: request.requestId, inputDigest: request.inputDigest,
    inputFingerprint: request.inputFingerprint, evidenceId: `${request.executionId}:outcome`,
    outcome: 'SUCCESS', started: true, providerRef: 'synthetic-reference', finishReason: 'COMPLETED',
    usageConfirmed: true, costUsd: '0.10', usageEvidenceId: `${request.executionId}:usage`,
    usage: { providerMs: 8, modelMs: 6, queueMs: 1,
      tokenUsage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } },
    confidence: { value: 0.8, kind: 'SEMANTIC_HEURISTIC', scale: { min: 0, max: 1 }, calibrationRef: null, scope: 'PAGE' },
    data: { artifact: { artifactId: `${request.executionId}:artifact`, sha256: sha(bytes) }, bytes,
      regionIds: [...ids], missingRegionIds: [], complete: true },
    ...overrides,
  };
}

function fixture(options = {}) {
  const calls = [];
  let clock = 100;
  const providers = ['primary', 'alternate'].map(providerId => {
    const alternate = providerId === 'alternate';
    const descriptor = {
      providerId, modelId: `${providerId}-synthetic`, modelVersion: 'v1', profileDigest: sha(providerId),
      transport: 'SYNTHETIC', stages: ['TRANSLATE'], supportsLookup: !alternate, supportsPartial: !alternate,
      confidence: { kind: 'SEMANTIC_HEURISTIC', scale: { min: 0, max: alternate ? 100 : 1 }, calibrationRef: null },
    };
    const port = {
      synthetic: true,
      async dispatch(request, started, context) {
        calls.push([providerId, 'dispatch', request.executionId]);
        clock += alternate ? 15 : 10;
        if (!alternate && options.dispatch) return options.dispatch(request, started, context);
        await started(`${request.executionId}:started`);
        return receipt(request, alternate ? { costUsd: '0.20', confidence: null } : {});
      },
      ...(!alternate ? { async lookup(executionId, request, context) {
        calls.push([providerId, 'lookup', executionId]);
        clock += 4;
        return options.lookup ? options.lookup(executionId, request, context) : null;
      } } : {}),
    };
    return { ...descriptor, port };
  });
  return { adapter: createStage15ProviderAdapter({ providers, now: () => clock }), providers, calls };
}

function inspect(result, request) {
  const { observed, output } = result;
  return inspection.inspectStage({
    binding: request.binding, node: { ...request.node, artifact: observed.artifact }, observed,
    authority: { verified: true, binding: request.binding, stage: request.node.stage, artifact: observed.artifact, softApprovals: [] },
    inputs: request.inputs, bytes: output.bytes,
  }).assessment;
}

test('two synthetic profiles stay pinned and the complete result feeds the existing inspection contract', async () => {
  const { adapter, calls } = fixture();
  const request = input();
  const before = structuredClone(request);
  const primary = await adapter.dispatch('primary', request);
  const alternate = await adapter.dispatch('alternate', input('attempt-2'));
  assert.equal(primary.observed.state, 'CONFIRMED_SUCCESS');
  assert.equal(primary.providerObservation.outcome, 'SUCCESS');
  assert.equal(primary.observed.parentsSha256, checkpoint.key(request.node.parents));
  assert.equal(primary.observed.artifact.sha256, sha(primary.output.bytes));
  assert.deepEqual(primary.observed.evidenceRefs, ['attempt-1:started', 'attempt-1:outcome']);
  assert.deepEqual(primary.usage, { elapsedMs: 10, lookupMs: null, providerMs: 8, modelMs: 6, queueMs: 1,
    modelRequestMs: null, localModelRequests: null, tokenUsage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } });
  assert.equal(primary.provider.profileDigest, sha('primary'));
  assert.equal(alternate.provider.profileDigest, sha('alternate'));
  assert.equal(alternate.confidence.kind, 'NOT_REPORTED');
  assert.equal(decision.assessStage(inspect(primary, request)).kind, 'PASS');
  assert.deepEqual(request, before);
  assert.deepEqual(calls, [['primary', 'dispatch', 'attempt-1'], ['alternate', 'dispatch', 'attempt-2']]);
});

test('a complete provider receipt leaves actual final content QA to the existing inspector', async () => {
  const { adapter } = fixture({ dispatch(request) {
    const result = receipt(request);
    result.data.bytes = bytesOf({ choices: [] });
    result.data.artifact.sha256 = sha(result.data.bytes);
    return result;
  } });
  const request = input();
  const result = await adapter.dispatch('primary', request);
  assert.equal(result.providerObservation.outcome, 'SUCCESS');
  assert.equal(result.observed.state, 'CONFIRMED_SUCCESS');
  assert.equal(decision.assessStage(inspect(result, request)).kind, 'BLOCKED');
  assert.deepEqual(result.charge, { state: 'CONFIRMED', amount: '0.10', currency: 'USD', source: 'attempt-1:usage' });
});

test('registry and current input reject non-synthetic, stale, malformed or unsupported values before a call', async () => {
  const { adapter, calls, providers } = fixture();
  assert.throws(() => createStage15ProviderAdapter({ providers: [{ ...providers[0], transport: 'LOCAL' }] }), { code: 'STAGE15_PROVIDER_INVALID' });
  assert.throws(() => createStage15ProviderAdapter({ providers: [providers[0], providers[0]] }), { code: 'STAGE15_PROVIDER_INVALID' });
  const stale = input();
  stale.inputs.lines[0].sourceText = 'different';
  await assert.rejects(adapter.dispatch('primary', stale), { code: 'STAGE15_INPUT_INVALID' });
  const badScope = input();
  badScope.regionIds.push('r1');
  await assert.rejects(adapter.dispatch('primary', badScope), { code: 'STAGE15_INPUT_INVALID' });
  const incompatible = input();
  incompatible.binding.mode = 'TYPESETTING_ONLY';
  await assert.rejects(adapter.dispatch('primary', incompatible), { code: 'STAGE15_INPUT_INVALID' });
  await assert.rejects(adapter.dispatch('unknown', input()), { code: 'STAGE15_PROVIDER_UNAVAILABLE' });
  assert.deepEqual(calls, []);
});

test('unbound provider reply preserves the acknowledged start but cannot confirm output or cost', async () => {
  const { adapter } = fixture({ async dispatch(request, started) {
    await started('ack-1');
    return receipt(request, { inputFingerprint: sha('foreign-binding') });
  } });
  const result = await adapter.dispatch('primary', input());
  assert.equal(result.observed.state, 'RESULT_UNKNOWN');
  assert.equal(result.observed.started, true);
  assert.equal(result.providerObservation, null);
  assert.equal(result.error.code, 'INVALID_OUTPUT');
  assert.deepEqual(result.observed.evidenceRefs, ['ack-1']);
  assert.equal(result.charge.amount, null);
  assert.equal(result.output, null);
});

test('bound invalid payload preserves the provider receipt and confirmed cost while rejecting the output', async () => {
  for (const mutate of [
    reply => { reply.data.regionIds[1] = 'foreign'; },
    reply => { reply.data.artifact.sha256 = sha('different bytes'); },
    reply => { reply.data.bytes = '{}'; },
    reply => { reply.confidence.scale.max = 100; },
  ]) {
    const { adapter } = fixture({ dispatch(request) { const reply = receipt(request); mutate(reply); return reply; } });
    const result = await adapter.dispatch('primary', input());
    assert.equal(result.observed.state, 'CONFIRMED_FAILURE');
    assert.equal(result.providerObservation.outcome, 'SUCCESS');
    assert.equal(result.error.code, 'INVALID_OUTPUT');
    assert.equal(result.output, null);
    assert.equal(result.charge.amount, '0.10');
  }
});

test('partial output accounts for all requested regions and stays incomplete', async () => {
  const make = valid => fixture({ dispatch(request) {
    const reply = receipt(request, { outcome: 'PARTIAL', finishReason: 'PARTIAL', confidence: null });
    const bytes = bytesOf({ r1: 'verified portion' });
    reply.data = { ...reply.data, bytes, artifact: { ...reply.data.artifact, sha256: sha(bytes) },
      regionIds: ['r1'], missingRegionIds: [valid ? 'r2' : 'r1'], complete: false };
    return reply;
  } });
  const partial = await make(true).adapter.dispatch('primary', input());
  assert.equal(partial.observed.state, 'PARTIAL');
  assert.equal(partial.observed.artifact, null);
  assert.deepEqual(partial.output.regionIds, ['r1']);
  assert.deepEqual(partial.output.missingRegionIds, ['r2']);
  assert.equal(partial.output.complete, false);
  const malformed = await make(false).adapter.dispatch('primary', input());
  assert.equal(malformed.error.code, 'INVALID_OUTPUT');
  assert.equal(malformed.output, null);
});

test('deadline before dispatch proves no start and does not infer a fee', async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.dispatch('primary', input(), { deadlineMs: 100 });
  assert.equal(result.observed.state, 'CONFIRMED_NOT_STARTED');
  assert.equal(result.observed.phase, 'BEFORE_DISPATCH');
  assert.equal(result.observed.started, false);
  assert.deepEqual(result.error, { code: 'TIMEOUT', source: 'DEADLINE', retryability: 'BEFORE_START_CONFIRMED' });
  assert.equal(result.charge.amount, null);
  assert.deepEqual(calls, []);
});

test('transport timeout after dispatch preserves start evidence and does not trigger a fallback', async () => {
  const { adapter, calls } = fixture({ async dispatch(_, started) {
    await started('ack-1');
    throw Object.assign(new Error('transport did not finish'), { code: 'ETIMEDOUT' });
  } });
  const result = await adapter.dispatch('primary', input());
  assert.equal(result.observed.state, 'RESULT_UNKNOWN');
  assert.equal(result.observed.phase, 'DISPATCHED');
  assert.equal(result.observed.started, true);
  assert.deepEqual(result.error, { code: 'TIMEOUT', source: 'TRANSPORT', retryability: 'LOOKUP_REQUIRED' });
  assert.deepEqual(result.observed.evidenceRefs, ['ack-1']);
  assert.equal(result.charge.amount, null);
  assert.deepEqual(calls, [['primary', 'dispatch', 'attempt-1']]);
});

test('a disconnected transport without an acknowledgement cannot assert that execution never started', async () => {
  const { adapter } = fixture({ dispatch() { throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }); } });
  const result = await adapter.dispatch('primary', input());
  assert.equal(result.observed.state, 'RESULT_UNKNOWN');
  assert.equal(result.observed.started, null);
  assert.equal(result.error.code, 'TRANSPORT');
  assert.equal(result.providerObservation, null);
});

test('an RPC timeout is distinct from a transport failure and preserves its provider receipt', async () => {
  const { adapter } = fixture({ dispatch(request) {
    return receipt(request, { ...noUsage, data: null, confidence: null, outcome: 'UNKNOWN', started: true, finishReason: 'TIMEOUT' });
  } });
  const result = await adapter.dispatch('primary', input());
  assert.equal(result.observed.state, 'RESULT_UNKNOWN');
  assert.deepEqual(result.error, { code: 'TIMEOUT', source: 'PROVIDER', retryability: 'LOOKUP_REQUIRED' });
  assert.equal(result.providerObservation.evidenceId, 'attempt-1:outcome');
  assert.equal(result.observed.started, true);
});

test('caller abort after entry settles the local wait and a late start cannot rewrite its observation', async () => {
  let entered, acknowledge;
  const inside = new Promise(resolve => { entered = resolve; });
  const { adapter, calls } = fixture({ dispatch(_, started, context) {
    acknowledge = started;
    assert.equal(context.signal.aborted, false);
    entered();
    return new Promise(() => {});
  } });
  const controller = new AbortController();
  const pending = adapter.dispatch('primary', input(), { signal: controller.signal });
  await inside;
  controller.abort();
  const result = await pending;
  assert.equal(result.observed.state, 'RESULT_UNKNOWN');
  assert.equal(result.error.code, 'CANCELLED');
  await acknowledge('late-start');
  assert.deepEqual(result.observed.evidenceRefs, []);
  assert.equal(result.observed.started, null);
  assert.equal(calls.length, 1);
});

test('the adapter deadline ends a hung synthetic call without confirming provider cancellation', async () => {
  const { adapter, calls } = fixture({ async dispatch(_, started, context) {
    assert.equal(context.deadlineMs, 102);
    await started('ack-before-deadline');
    return new Promise(() => {});
  } });
  const result = await adapter.dispatch('primary', input(), { deadlineMs: 102 });
  assert.equal(result.observed.state, 'RESULT_UNKNOWN');
  assert.equal(result.observed.started, true);
  assert.deepEqual(result.error, { code: 'TIMEOUT', source: 'DEADLINE', retryability: 'LOOKUP_REQUIRED' });
  assert.deepEqual(result.observed.evidenceRefs, ['ack-before-deadline']);
  assert.equal(calls.length, 1);
});

test('lookup is read-only with separate unsupported, missing and confirmed results', async () => {
  const { adapter, calls } = fixture({ lookup(executionId, request) {
    assert.equal(executionId, request.executionId);
    return executionId === 'attempt-1' ? receipt(request) : null;
  } });
  const unsupported = await adapter.lookup('alternate', input());
  assert.equal(unsupported.lookupStatus, 'UNSUPPORTED');
  assert.equal(unsupported.observed.state, 'RESULT_UNKNOWN');
  const missing = await adapter.lookup('primary', input('missing'));
  assert.equal(missing.lookupStatus, 'NOT_FOUND');
  assert.equal(missing.observed.started, null);
  const found = await adapter.lookup('primary', input());
  assert.equal(found.lookupStatus, 'RETURNED');
  assert.equal(found.observed.state, 'CONFIRMED_SUCCESS');
  assert.equal(found.usage.lookupMs, 4);
  assert.equal(found.usage.elapsedMs, null);
  assert.deepEqual(calls, [['primary', 'lookup', 'missing'], ['primary', 'lookup', 'attempt-1']]);
});

test('provider success and unconfirmed settlement remain separate from a justified zero', async () => {
  const unconfirmed = await fixture({ dispatch(request) { return receipt(request, { usageConfirmed: true, costUsd: null, usageEvidenceId: null }); } })
    .adapter.dispatch('primary', input());
  assert.equal(unconfirmed.providerObservation.outcome, 'SUCCESS');
  assert.equal(unconfirmed.observed.state, 'CONFIRMED_SUCCESS');
  assert.equal(unconfirmed.observed.costUsd, null);
  assert.equal(unconfirmed.observed.usageConfirmed, false);
  assert.equal(unconfirmed.charge.state, 'UNCONFIRMED');
  const zero = await fixture({ dispatch(request) { return receipt(request, { costUsd: '0.00' }); } }).adapter.dispatch('primary', input());
  assert.equal(zero.charge.amount, '0.00');
  assert.equal(zero.charge.state, 'CONFIRMED');
  const missingProof = await fixture({ dispatch(request) { return receipt(request, { costUsd: '0.00', usageEvidenceId: null }); } })
    .adapter.dispatch('primary', input());
  assert.equal(missingProof.charge.amount, null);
  assert.equal(missingProof.observed.state, 'CONFIRMED_SUCCESS');
  assert.equal(missingProof.providerObservation.costUsd, '0.00');
});

test('shared page usage is pulled once from the existing report aggregator', async () => {
  const { adapter } = fixture({ dispatch(request) {
    const record = { requestId: 'page-model-call', requestScope: 'page' };
    return receipt(request, { usage: { report: {
      translations: [{ id: 'r1', ...record }, { id: 'r2', ...record }],
      translationRequests: [{ requestId: record.requestId, scope: 'page', httpRequests: 1, durationMs: 6,
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }],
    } } });
  } });
  const result = await adapter.dispatch('primary', input());
  assert.equal(result.usage.localModelRequests, 1);
  assert.equal(result.usage.modelRequestMs, 6);
  assert.deepEqual(result.usage.tokenUsage, { promptTokens: 4, completionTokens: 2, totalTokens: 6 });
});

test('malformed legacy usage after dispatch leaves a bound failure observation and keeps independent charge evidence', async () => {
  const { adapter } = fixture({ dispatch(request) {
    return receipt(request, { usage: { report: { recovery: { reusedStages: {} } } } });
  } });
  const result = await adapter.dispatch('primary', input());
  assert.equal(result.error.code, 'INVALID_OUTPUT');
  assert.equal(result.providerObservation.outcome, 'SUCCESS');
  assert.equal(result.observed.started, true);
  assert.equal(result.charge.amount, '0.10');
});

test('primary and alternate sum exact costs and wall time once per execution, including a replayed receipt', async () => {
  const { adapter } = fixture({ lookup(_, request) { return receipt(request); } });
  const a = await adapter.dispatch('primary', input());
  const b = await adapter.dispatch('alternate', input('attempt-2'));
  const sameReceipt = await adapter.lookup('primary', input());
  const total = aggregateStage15Usage([sameReceipt, b, a, a]);
  assert.equal(total.attemptCount, 2);
  assert.equal(total.usage.elapsedMs, 25);
  assert.equal(total.usage.providerMs, 16);
  assert.equal(total.usage.tokenUsage.totalTokens, 14);
  assert.deepEqual(total.charge, { state: 'CONFIRMED', amount: '0.3', currency: 'USD', confirmedSubtotal: '0.3', unconfirmedExecutionIds: [] });
});

test('a confirmed subtotal does not erase one unknown execution or an absent duration', async () => {
  const { adapter } = fixture({ dispatch(request) { return receipt(request, { ...noUsage }); } });
  const a = await adapter.dispatch('primary', input());
  const b = await adapter.dispatch('alternate', input('attempt-2'));
  const notFound = await adapter.lookup('primary', input('attempt-3'));
  const total = aggregateStage15Usage([a, b, notFound]);
  assert.deepEqual(total.charge, { state: 'UNCONFIRMED', amount: null, currency: 'USD', confirmedSubtotal: '0.2',
    unconfirmedExecutionIds: ['attempt-1', 'attempt-3'] });
  assert.equal(total.usage.elapsedMs, null);
});

test('an explicit lookup can add cost evidence for the same attempt without re-counting the execution', async () => {
  const { adapter, calls } = fixture({
    dispatch(request) { return receipt(request, { ...noUsage, outcome: 'UNKNOWN', finishReason: 'TIMEOUT', data: null, confidence: null, usage: null }); },
    lookup(_, request) { return receipt(request, { evidenceId: 'reconciled', costUsd: '0.07' }); },
  });
  const initial = await adapter.dispatch('primary', input());
  const resolved = await adapter.lookup('primary', input());
  const total = aggregateStage15Usage([initial, resolved]);
  assert.equal(total.attemptCount, 1);
  assert.equal(total.charge.confirmedSubtotal, '0.07');
  assert.equal(total.usage.elapsedMs, 10);
  assert.deepEqual(calls, [['primary', 'dispatch', 'attempt-1'], ['primary', 'lookup', 'attempt-1']]);
});

test('duplicate evidence identifiers with different facts or attempts cannot be summed', async () => {
  const { adapter } = fixture({ dispatch(request) { return receipt(request, { evidenceId: 'reused-evidence' }); },
    lookup(_, request) { return receipt(request, { evidenceId: 'reused-evidence', costUsd: '0.90' }); } });
  const a = await adapter.dispatch('primary', input());
  const b = await adapter.dispatch('primary', input('attempt-2'));
  const contradiction = await adapter.lookup('primary', input());
  assert.throws(() => aggregateStage15Usage([a, b]), { code: 'STAGE15_EVIDENCE_CONFLICT' });
  assert.throws(() => aggregateStage15Usage([a, contradiction]), { code: 'STAGE15_EVIDENCE_CONFLICT' });
});

test('usage totals are confined to one current stage input, even across distinct providers', async () => {
  const { adapter } = fixture();
  const a = await adapter.dispatch('primary', input());
  const changed = input('attempt-2');
  changed.binding.layoutRevision++;
  const b = await adapter.dispatch('alternate', changed);
  assert.throws(() => aggregateStage15Usage([a, b]), { code: 'STAGE15_USAGE_CONFLICT' });
});

test('a changed provider model version alters the pinned evidence input even with the same profile digest', async () => {
  const { adapter, providers } = fixture();
  const original = await adapter.dispatch('primary', input());
  const upgraded = createStage15ProviderAdapter({ providers: [{ ...providers[0], modelVersion: 'v2' }] });
  const newer = await upgraded.dispatch('primary', input());
  assert.notEqual(newer.inputFingerprint, original.inputFingerprint);
});
