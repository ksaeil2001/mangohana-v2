import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import checkpoint from '../../packages/ai-engine/quality/recovery-checkpoint.cjs';
import graph from '../../packages/ai-engine/quality/stage15-stage-graph.cjs';
import { usageFromReport } from './store.mjs';

const { key } = checkpoint;
const { stageParentsSha256 } = graph;
const ExactUsd = Decimal.clone({ precision: 40 });
const outcomes = new Map([
  ['SUCCESS', 'CONFIRMED_SUCCESS'], ['NOT_STARTED', 'CONFIRMED_NOT_STARTED'], ['FAILURE', 'CONFIRMED_FAILURE'],
  ['UNKNOWN', 'RESULT_UNKNOWN'], ['PARTIAL', 'PARTIAL'], ['CANCELLED', 'CANCELLED'],
]);
const stages = new Set(['OCR', 'TRANSLATE', 'MASK', 'INPAINT', 'TYPESET']);
const scopeField = { OCR: 'regions', TRANSLATE: 'lines', MASK: 'allowedRegions', TYPESET: 'lines' };
const confidenceKinds = new Set(['DETECTOR_SCORE', 'OCR_SCORE', 'SEMANTIC_HEURISTIC', 'CALIBRATED']);
const timeKeys = ['elapsedMs', 'providerMs', 'modelMs', 'queueMs', 'modelRequestMs'];
const tokenKeys = ['promptTokens', 'completionTokens', 'totalTokens'];
const usageKeys = [...timeKeys, 'localModelRequests', 'tokenUsage'];

const record = value => value != null && Object.getPrototypeOf(value) === Object.prototype;
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const usd = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,12})?$/.test(value);
const time = value => Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const unknownCharge = () => ({ state: 'UNCONFIRMED', amount: null, currency: 'USD', source: null });
const nullable = (value, valid) => value == null || valid(value);
const distinctIds = list => Array.isArray(list) && Array.from(list).every(id) && new Set(list).size === list.length;
const sameIds = (left, right) => left.length === right.length && left.every(value => right.includes(value));
const typeOfStart = value => value === true || value === false || value === null;

function requireValue(ok, code) {
  if (!ok) throw Object.assign(new Error(code), { code });
}

function validConfidenceProfile(profile) {
  return record(profile) && confidenceKinds.has(profile.kind) && record(profile.scale) &&
    Number.isFinite(profile.scale.min) && Number.isFinite(profile.scale.max) && profile.scale.min < profile.scale.max &&
    (profile.calibrationRef === null || id(profile.calibrationRef)) && (profile.kind !== 'CALIBRATED' || id(profile.calibrationRef));
}

function registry(providers) {
  const code = 'STAGE15_PROVIDER_INVALID';
  requireValue(Array.isArray(providers) && providers.length > 0, code);
  const entries = new Map();
  for (const provider of providers) {
    const { providerId, modelId, modelVersion, profileDigest, transport, stages: supported,
      supportsLookup, supportsPartial, confidence, port } = provider ?? {};
    requireValue(id(providerId) && !entries.has(providerId) && id(modelId) && id(modelVersion) && hex(profileDigest) &&
      transport === 'SYNTHETIC' && distinctIds(supported) && supported.length > 0 && supported.every(stage => stages.has(stage)) &&
      typeof supportsLookup === 'boolean' && typeof supportsPartial === 'boolean' &&
      (confidence === null || validConfidenceProfile(confidence)) && port?.synthetic === true &&
      typeof port.dispatch === 'function' && supportsLookup === (typeof port.lookup === 'function'), code);
    entries.set(providerId, { profile: structuredClone({ providerId, modelId, modelVersion, profileDigest, transport,
      stages: supported, supportsLookup, supportsPartial, confidence }),
    dispatch: port.dispatch.bind(port), lookup: supportsLookup ? port.lookup.bind(port) : null });
  }
  return entries;
}

function jsonValue(value, depth = 0) {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return true;
  if (Array.isArray(value)) return Array.from(value).every(item => jsonValue(item, depth + 1));
  return record(value) && Object.values(value).every(item => jsonValue(item, depth + 1));
}

function validBinding(binding) {
  const permit = ['permitId', 'proposalSha256', 'approvalEventSha256'];
  return record(binding) && jsonValue(binding) && ['owner', 'session'].includes(binding.ownerScope?.kind) && id(binding.ownerScope?.id) &&
    ['projectId', 'pageId', 'requestId'].every(field => id(binding[field])) && count(binding.pageNumber) && binding.pageNumber > 0 &&
    (count(binding.generation) || id(binding.generation)) && ['editRevision', 'contextRevision', 'layoutRevision'].every(field => count(binding[field])) &&
    hex(binding.sourceSha256) && hex(binding.inputDigest) && ['FULL_IMAGE', 'TYPESETTING_ONLY'].includes(binding.mode) &&
    (permit.every(field => !Object.hasOwn(binding, field)) || id(binding.permitId) && hex(binding.proposalSha256) && hex(binding.approvalEventSha256));
}

/** Reconstruct the journal's identity from metadata, without accessing payload bytes or a provider port. */
export function stage15RequestIdentity(input, profile) {
  const code = 'STAGE15_INPUT_INVALID';
  const { executionId, binding, node, regionIds } = input ?? {};
  requireValue(id(executionId) && validBinding(binding) && record(node) && id(node.id) && stages.has(node.stage) &&
    (binding.mode === 'FULL_IMAGE' || node.stage === 'TYPESET') && distinctIds(regionIds) && regionIds.length > 0 &&
    (node.regionId === null || regionIds.length === 1 && regionIds[0] === node.regionId) &&
    hex(node.inputsSha256) && id(profile?.providerId) && id(profile.modelId) && id(profile.modelVersion) && hex(profile.profileDigest), code);
  const parentsSha256 = stageParentsSha256(node.parents);
  requireValue(parentsSha256 !== null, code);
  const { requestId, inputDigest } = binding;
  const { stage, regionId, inputsSha256 } = node;
  const scope = { requestId, inputDigest, binding, stage, nodeId: node.id, regionId, regionIds, inputsSha256, parentsSha256 };
  const { providerId, profileDigest, modelId, modelVersion } = profile;
  const identity = { ...scope, executionId, providerId, profileDigest, modelId, modelVersion };
  return { ...identity, usageScopeSha256: key(scope), inputFingerprint: key(identity) };
}

function bindRequest(input, profile) {
  const code = 'STAGE15_INPUT_INVALID';
  const identity = stage15RequestIdentity(input, profile);
  const { inputs, node, regionIds } = input;
  requireValue(profile.stages.includes(node.stage) && record(inputs) && jsonValue(inputs) && key(inputs) === node.inputsSha256, code);
  const field = scopeField[node.stage];
  if (field) {
    const rows = inputs[field];
    requireValue(Array.isArray(rows), code);
    const expected = Array.from(rows, row => row?.id);
    requireValue(distinctIds(expected) && sameIds(expected, regionIds), code);
  }
  return structuredClone({ ...identity, inputs });
}

function normalizeOutput(data, request, partial, profile) {
  if (!record(data) || data.complete !== !partial || (partial && !profile.supportsPartial) ||
      !record(data.artifact) || !id(data.artifact.artifactId) || !hex(data.artifact.sha256) ||
      !Buffer.isBuffer(data.bytes) || data.bytes.length === 0 || sha(data.bytes) !== data.artifact.sha256 ||
      !distinctIds(data.regionIds) || !distinctIds(data.missingRegionIds) || data.regionIds.length === 0 ||
      (partial ? data.missingRegionIds.length === 0 : data.missingRegionIds.length !== 0)) return null;
  const scope = [...data.regionIds, ...data.missingRegionIds];
  if (new Set(scope).size !== scope.length || !sameIds(scope, request.regionIds)) return null;
  return { artifact: { artifactId: data.artifact.artifactId, sha256: data.artifact.sha256 }, bytes: Buffer.from(data.bytes),
    regionIds: [...data.regionIds], missingRegionIds: [...data.missingRegionIds], complete: data.complete };
}

function normalizeConfidence(raw, output, request, profile) {
  const scope = request.regionId !== null || output?.complete === false ? 'REGIONS' : 'PAGE';
  const regionIds = output?.regionIds ?? [];
  if (raw === null) return { kind: 'NOT_REPORTED', value: null, scale: null, calibrationRef: null, scope, regionIds: [...regionIds] };
  if (!output || !profile || !validConfidenceProfile(raw) || raw.kind !== profile.kind || raw.scope !== scope ||
      raw.scale.min !== profile.scale.min || raw.scale.max !== profile.scale.max || raw.calibrationRef !== profile.calibrationRef ||
      !Number.isFinite(raw.value) || raw.value < profile.scale.min || raw.value > profile.scale.max) return null;
  return { kind: raw.kind, value: raw.value, scale: { min: raw.scale.min, max: raw.scale.max }, calibrationRef: raw.calibrationRef,
    scope, regionIds: [...regionIds] };
}

function validTokens(tokens) {
  return record(tokens) && tokenKeys.every(field => count(tokens[field])) && tokens.totalTokens === tokens.promptTokens + tokens.completionTokens;
}

function measure(usage) {
  if (usage != null && !record(usage)) return null;
  const { providerMs, modelMs, queueMs, modelRequestMs, localModelRequests, tokenUsage, report } = usage ?? {};
  if (![providerMs, modelMs, queueMs, modelRequestMs].every(value => nullable(value, time)) ||
      !nullable(localModelRequests, count) || !nullable(tokenUsage, validTokens) || !nullable(report, record)) return null;
  // A legacy report is one measurement source for the attempt, including shared page requests.
  if (report && (modelRequestMs != null || localModelRequests != null || tokenUsage != null ||
      !nullable(report.recovery, record) || !nullable(report.recovery?.reusedStages, distinctIds))) return null;
  const derived = report ? usageFromReport(report, null) : {};
  return { providerMs: providerMs ?? null, modelMs: modelMs ?? null, queueMs: queueMs ?? null,
    modelRequestMs: modelRequestMs ?? derived.modelRequestMs ?? null, localModelRequests: localModelRequests ?? derived.localModelRequests ?? null,
    tokenUsage: tokenUsage ? Object.fromEntries(tokenKeys.map(field => [field, tokenUsage[field]])) : derived.tokenUsage ?? null };
}

function errorFor(code, source, state) {
  return { code, source, retryability: state === 'RESULT_UNKNOWN' ? 'LOOKUP_REQUIRED' :
    state === 'CONFIRMED_NOT_STARTED' ? 'BEFORE_START_CONFIRMED' : 'NEVER' };
}

function normalizeReceipt(raw, request, profile, starts, badStart) {
  const bound = record(raw) && ['executionId', 'requestId', 'inputDigest', 'inputFingerprint'].every(field => raw[field] === request[field]) &&
    id(raw.evidenceId) && !starts.has(raw.evidenceId) && outcomes.has(raw.outcome) && typeOfStart(raw.started) &&
    (raw.providerRef === null || id(raw.providerRef)) && id(raw.finishReason);
  if (!bound || badStart || (starts.size > 0 && raw.started === false) ||
      (raw.outcome === 'NOT_STARTED' && raw.started !== false) ||
      (['SUCCESS', 'PARTIAL'].includes(raw.outcome) && raw.started !== true) ||
      (raw.outcome === 'CANCELLED' && raw.started === null)) return { error: errorFor('INVALID_OUTPUT', 'CONTRACT', 'RESULT_UNKNOWN') };

  const amount = raw.costUsd === null || usd(raw.costUsd) ? raw.costUsd : null;
  const source = id(raw.usageEvidenceId) ? raw.usageEvidenceId : null;
  const usageValid = typeof raw.usageConfirmed === 'boolean' && amount === raw.costUsd && (raw.usageEvidenceId === null || source !== null);
  const charge = usageValid && raw.usageConfirmed && amount !== null && source !== null
    ? { state: 'CONFIRMED', amount, currency: 'USD', source } : unknownCharge();
  const providerObservation = { evidenceId: raw.evidenceId, outcome: raw.outcome, started: raw.started,
    providerRef: raw.providerRef, finishReason: raw.finishReason, usageConfirmed: raw.usageConfirmed === true, costUsd: amount, usageEvidenceId: source };
  const usage = measure(raw.usage);
  const expectsOutput = raw.outcome === 'SUCCESS' || raw.outcome === 'PARTIAL';
  const output = expectsOutput ? normalizeOutput(raw.data, request, raw.outcome === 'PARTIAL', profile) : null;
  const confidence = normalizeConfidence(raw.confidence, output, request, profile.confidence);
  const transportUncertain = raw.finishReason === 'TRANSPORT' || raw.finishReason === 'TRANSPORT_UNCONFIRMED';
  const timeout = raw.finishReason === 'TIMEOUT' || raw.finishReason.endsWith('_TIMEOUT');
  let state = outcomes.get(raw.outcome);
  if ((timeout || transportUncertain) && state !== 'CONFIRMED_NOT_STARTED') state = 'RESULT_UNKNOWN';
  const invalid = !usageValid || !usage || !confidence || (expectsOutput ? output === null : raw.data !== null);
  if (invalid && (state === 'CONFIRMED_SUCCESS' || state === 'PARTIAL')) state = 'CONFIRMED_FAILURE';
  const code = invalid ? 'INVALID_OUTPUT' : timeout ? 'TIMEOUT' : transportUncertain ? 'TRANSPORT' :
    state === 'CONFIRMED_SUCCESS' ? null : state === 'PARTIAL' ? 'PARTIAL' : raw.finishReason;
  const usable = !invalid && (state === 'CONFIRMED_SUCCESS' || state === 'PARTIAL');
  const evidenceFingerprint = key({ providerObservation, usage, confidence,
    data: record(raw.data) ? { artifactId: id(raw.data.artifact?.artifactId) ? raw.data.artifact.artifactId : null,
      digest: Buffer.isBuffer(raw.data.bytes) ? sha(raw.data.bytes) : null,
      claimedSha256: hex(raw.data.artifact?.sha256) ? raw.data.artifact.sha256 : null,
      complete: raw.data.complete === true, regionIds: distinctIds(raw.data.regionIds) ? raw.data.regionIds : null,
      missingRegionIds: distinctIds(raw.data.missingRegionIds) ? raw.data.missingRegionIds : null } : null, invalid });
  return { state, started: starts.size ? true : raw.started, providerObservation, usage, charge, evidenceFingerprint,
    output: usable ? output : null, confidence: usable ? confidence : null,
    error: code ? errorFor(code, invalid ? 'CONTRACT' : 'PROVIDER', state) : null };
}

async function callWithDeadline(invoke, signal, deadlineMs, startedAt) {
  const controller = new AbortController();
  let stop;
  const interrupted = new Promise(resolve => { stop = (code, source) => {
    resolve({ fault: { code, source } });
    controller.abort(code);
  }; });
  const cancel = () => stop('CANCELLED', 'CALLER');
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = deadlineMs == null ? null : setTimeout(() => stop('TIMEOUT', 'DEADLINE'), deadlineMs - startedAt);
  try {
    const response = Promise.resolve().then(() => controller.signal.aborted ? interrupted : invoke(controller.signal)).then(
      value => ({ raw: value }), error => ({ fault: { code: ['TIMEOUT', 'ETIMEDOUT'].includes(error?.code) || error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT', source: 'TRANSPORT' } }),
    );
    return await Promise.race([response, interrupted]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/** In-process synthetic adapter with explicit dispatch and same-input lookup. */
export function createStage15ProviderAdapter({ providers, now = () => performance.now() } = {}) {
  const entries = registry(providers);
  requireValue(typeof now === 'function', 'STAGE15_PROVIDER_INVALID');

  async function observe(operation, providerId, input, { signal, deadlineMs, onStarted } = {}) {
    const entry = entries.get(providerId);
    requireValue(entry, 'STAGE15_PROVIDER_UNAVAILABLE');
    const request = bindRequest(input, entry.profile);
    const startedAt = now();
    requireValue(time(startedAt) && nullable(signal, value => value instanceof AbortSignal) &&
      nullable(onStarted, value => typeof value === 'function') && nullable(deadlineMs, time) &&
      (deadlineMs == null || deadlineMs - startedAt <= 2_147_483_647), 'STAGE15_INPUT_INVALID');
    const lookup = operation === 'LOOKUP';
    const starts = new Set();
    let badStart = false, active = true, invoked = false, portSettled = false, elapsed = null, lookupStatus = null;
    let facts;
    const fail = (code, source) => {
      const state = lookup || invoked ? 'RESULT_UNKNOWN' : code === 'CANCELLED' ? 'CANCELLED' : 'CONFIRMED_NOT_STARTED';
      return { state, started: starts.size ? true : !lookup && !invoked ? false : null, error: errorFor(code, source, state) };
    };
    if (lookup && !entry.lookup) {
      lookupStatus = 'UNSUPPORTED';
      facts = fail('LOOKUP_UNSUPPORTED', 'LOOKUP');
    } else if (signal?.aborted || (deadlineMs != null && deadlineMs <= startedAt)) {
      lookupStatus = lookup ? 'ERROR' : null;
      facts = signal?.aborted ? fail('CANCELLED', 'CALLER') : fail('TIMEOUT', 'DEADLINE');
    } else {
      const started = async evidenceId => {
        if (!active) return;
        if (!id(evidenceId)) badStart = true;
        else if (!starts.has(evidenceId)) {
          starts.add(evidenceId);
          await onStarted?.({ executionId: request.executionId, inputFingerprint: request.inputFingerprint, evidenceId });
        }
      };
      const result = await callWithDeadline(async portSignal => {
        invoked = true;
        const context = { signal: portSignal, deadlineMs };
        const owned = structuredClone(request);
        try { return await (lookup ? entry.lookup(request.executionId, owned, context) : entry.dispatch(owned, started, context)); }
        finally { portSettled = true; }
      }, signal, deadlineMs, startedAt);
      active = false;
      const finishedAt = now();
      elapsed = invoked && time(finishedAt) && finishedAt >= startedAt ? finishedAt - startedAt : null;
      if (result.fault) {
        lookupStatus = lookup ? 'ERROR' : null;
        facts = fail(result.fault.code, result.fault.source);
      } else if (lookup && result.raw === null) {
        lookupStatus = 'NOT_FOUND';
        facts = fail('LOOKUP_NOT_FOUND', 'LOOKUP');
      } else {
        lookupStatus = lookup ? 'RETURNED' : null;
        facts = normalizeReceipt(result.raw, request, entry.profile, starts, badStart);
      }
    }
    const charge = facts.charge ?? unknownCharge();
    const output = facts.output ?? null;
    const providerObservation = facts.providerObservation ?? null;
    const evidenceRefs = [...starts];
    if (providerObservation) evidenceRefs.push(providerObservation.evidenceId);
    const usage = { elapsedMs: lookup ? null : elapsed, lookupMs: lookup ? elapsed : null, ...(facts.usage ?? measure(null)) };
    return { operation, invoked, portPending:invoked && !portSettled, lookupStatus, provider: structuredClone(entry.profile), inputFingerprint: request.inputFingerprint,
      usageScopeSha256: request.usageScopeSha256,
      observed: { binding: request.binding, stage: request.stage, parentsSha256: request.parentsSha256, attemptId: request.executionId,
        state: facts.state ?? 'RESULT_UNKNOWN', phase: lookup || invoked ? 'DISPATCHED' : 'BEFORE_DISPATCH',
        started: facts.started ?? (starts.size ? true : null), evidenceRefs, errorCode: facts.error?.code ?? null,
        usageConfirmed: charge.state === 'CONFIRMED', costUsd: charge.amount, artifact: output?.complete ? { ...output.artifact } : null },
      providerObservation, evidenceFingerprint: facts.evidenceFingerprint ?? null, output, confidence: facts.confidence ?? null, charge, usage,
      error: facts.error ?? null };
  }

  // The executor pins the very same request before consuming a durable slot.
  function describe(providerId, input) {
    const entry = entries.get(providerId);
    requireValue(entry, 'STAGE15_PROVIDER_UNAVAILABLE');
    const { modelId, modelVersion, profileDigest, inputFingerprint } = bindRequest(input, entry.profile);
    return { provider: { providerId, modelId, modelVersion, profileDigest }, inputFingerprint };
  }

  return { describe, dispatch: (providerId, input, options) => observe('DISPATCH', providerId, input, options),
    lookup: (providerId, input, options) => observe('LOOKUP', providerId, input, options) };
}

/** Merge append-only measurements for the same execution, then total each execution once. */
export function aggregateStage15Usage(results) {
  const code = 'STAGE15_USAGE_INVALID';
  requireValue(Array.isArray(results), code);
  const attempts = new Map();
  const evidenceOwners = new Map();
  const evidenceFacts = new Map();
  let usageScope = null;
  for (const result of results) {
    const { inputFingerprint, usageScopeSha256, observed, providerObservation, evidenceFingerprint, charge, usage } = result ?? {};
    const executionId = observed?.attemptId;
    requireValue(id(executionId) && hex(inputFingerprint) && hex(usageScopeSha256) && distinctIds(observed.evidenceRefs) && record(usage) &&
      timeKeys.every(field => nullable(usage[field], time)) && nullable(usage.localModelRequests, count) && nullable(usage.tokenUsage, validTokens) &&
      charge?.currency === 'USD' && (charge.state === 'CONFIRMED' ? usd(charge.amount) && id(charge.source) :
        charge.state === 'UNCONFIRMED' && charge.amount === null && charge.source === null), code);
    requireValue(usageScope === null || usageScope === usageScopeSha256, 'STAGE15_USAGE_CONFLICT');
    usageScope = usageScopeSha256;
    for (const ref of charge.source === null ? observed.evidenceRefs : [...observed.evidenceRefs, charge.source]) {
      requireValue(!evidenceOwners.has(ref) || evidenceOwners.get(ref) === inputFingerprint, 'STAGE15_EVIDENCE_CONFLICT');
      evidenceOwners.set(ref, inputFingerprint);
    }
    if (providerObservation !== null) {
      const evidenceId = providerObservation?.evidenceId;
      requireValue(id(evidenceId) && observed.evidenceRefs.includes(evidenceId) && hex(evidenceFingerprint), code);
      requireValue(!evidenceFacts.has(evidenceId) || evidenceFacts.get(evidenceId) === evidenceFingerprint, 'STAGE15_EVIDENCE_CONFLICT');
      evidenceFacts.set(evidenceId, evidenceFingerprint);
    }
    const attempt = attempts.get(executionId) ?? { inputFingerprint, amount: null, usage: {} };
    requireValue(attempt.inputFingerprint === inputFingerprint, 'STAGE15_USAGE_CONFLICT');
    if (charge.amount !== null) {
      requireValue(attempt.amount === null || new ExactUsd(attempt.amount).eq(charge.amount), 'STAGE15_USAGE_CONFLICT');
      attempt.amount = charge.amount;
    }
    for (const field of usageKeys) {
      const value = usage[field];
      if (value == null) continue;
      const previous = attempt.usage[field];
      requireValue(previous === undefined || key(previous) === key(value), 'STAGE15_USAGE_CONFLICT');
      attempt.usage[field] = value;
    }
    attempts.set(executionId, attempt);
  }
  const entries = [...attempts.values()];
  const unconfirmedExecutionIds = [...attempts.keys()].filter(executionId => attempts.get(executionId).amount === null).sort();
  const confirmedSubtotal = entries.reduce((total, entry) => entry.amount === null ? total : total.plus(entry.amount), new ExactUsd(0)).toFixed();
  const confirmed = entries.length > 0 && unconfirmedExecutionIds.length === 0;
  const sum = (read, valid) => {
    if (!entries.length) return null;
    const values = entries.map(read);
    if (!values.every(valid)) return null;
    const total = values.reduce((left, right) => left + right, 0);
    return valid(total) ? total : null;
  };
  const tokens = Object.fromEntries(tokenKeys.map(field => [field, sum(entry => entry.usage.tokenUsage?.[field], count)]));
  return { attemptCount: entries.length, charge: { state: confirmed ? 'CONFIRMED' : 'UNCONFIRMED',
    amount: confirmed ? confirmedSubtotal : null, currency: 'USD', confirmedSubtotal, unconfirmedExecutionIds },
  usage: { ...Object.fromEntries(timeKeys.map(field => [field, sum(entry => entry.usage[field], time)])),
    localModelRequests: sum(entry => entry.usage.localModelRequests, count),
    tokenUsage: Object.values(tokens).every(count) ? tokens : null } };
}
