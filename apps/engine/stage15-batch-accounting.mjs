import {aggregateStage15Usage} from './stage15-provider-adapter.mjs';
import checkpoint from '../../packages/ai-engine/quality/recovery-checkpoint.cjs';

const {key} = checkpoint;
const precision = 1_000_000_000_000n;
const metrics = ['elapsedMs','lookupMs','providerMs','modelMs','queueMs','modelRequestMs','localModelRequests',
  'promptTokens','completionTokens','totalTokens'];
function requireFact(ok, code) {
  if (!ok) throw Object.assign(new Error(code), {code});
}

export function usdUnits(value) {
  requireFact(typeof value === 'string' && /^(0|[1-9]\d{0,15})(\.\d{1,12})?$/.test(value), 'STAGE15_ADMISSION_DENIED');
  const [integer, fraction = ''] = value.split('.');
  return BigInt(integer + fraction.padEnd(12,'0'));
}
export function formatUsd(units) {
  const fraction = String(units % precision).padStart(12,'0').replace(/0+$/,'');
  return String(units / precision) + (fraction ? '.' + fraction : '');
}
function receiptUsage(attempt) {
  try { return aggregateStage15Usage(attempt.observations); }
  catch (error) {
    if (['STAGE15_USAGE_CONFLICT','STAGE15_EVIDENCE_CONFLICT'].includes(error.code)) return null;
    throw error;
  }
}

const neverDispatched = a => !a.dispatchIntent && !a.observations.length &&
  (a.cancelled || a.request.action === 'RESERVE_FALLBACK');

// Called on the epoch snapshot being installed. A losing reservation repeats the
// check against the winner's held quote, even when the provider has not replied.
export function checkBatchReservation(attempts, request, knownAttempts = []) {
  const binding = request.input.binding;
  if (binding.batchId === undefined && request.batchBudget === undefined) return;
  const {policy,quoteUsd} = request.batchBudget ?? {};
  requireFact(policy && typeof binding.batchId === 'string' && /^[a-f0-9]{64}$/.test(binding.batchManifestSha256) &&
    policy.batchId === binding.batchId && policy.manifestSha256 === binding.batchManifestSha256 &&
    policy.ownerScope && key(policy.ownerScope) === key(binding.ownerScope) && policy.projectId === binding.projectId &&
    policy.contextRevision === binding.contextRevision && [0,1].includes(policy.maxFallbacks),'STAGE15_BATCH_AUTHORITY_MISMATCH');
  let committed = usdUnits(quoteUsd), fallbackSlots = request.action === 'EXECUTE_STAGE' ? 0 : 1;
  const charges = new Map();
  for (const attempt of attempts) {
    const other = attempt.request, b = other.input.binding;
    if (b.batchId !== binding.batchId || b.projectId !== binding.projectId || key(b.ownerScope) !== key(binding.ownerScope)) continue;
    requireFact(other.batchBudget && key(other.batchBudget.policy) === key(policy),'STAGE15_BATCH_AUTHORITY_MISMATCH');
    const receipt = receiptUsage(attempt);
    requireFact(receipt,'STAGE15_BATCH_EVIDENCE_MISSING');
    const amount = receipt.charge.amount;
    charges.set(other.input.executionId,amount);
    if (other.input.executionId === request.input.executionId) continue;
    if (other.action !== 'EXECUTE_STAGE') fallbackSlots++;
    committed += usdUnits(amount ?? (neverDispatched(attempt) ? '0' : other.batchBudget.quoteUsd));
  }
  for (const known of knownAttempts) {
    const amount = charges.get(known.executionId);
    requireFact(charges.has(known.executionId) && (!known.usageConfirmed ||
      (amount != null && usdUnits(amount) === usdUnits(known.costUsd))),'STAGE15_BATCH_EVIDENCE_MISSING');
  }
  requireFact(fallbackSlots <= policy.maxFallbacks,'STAGE15_BATCH_FALLBACK_CONSUMED');
  requireFact(committed <= usdUnits(policy.maximumCostUsd),'STAGE15_BATCH_BUDGET_EXHAUSTED');
}

function measurement(attempt, readUsage = receiptUsage) {
  if (neverDispatched(attempt)) return {id:attempt.request.input.executionId,costUsd:'0',lookupCount:0,lookupSubtotal:0,
    values:Object.fromEntries(metrics.map(field=>[field,0]))};
  const merged = readUsage(attempt);
  const lookups = attempt.observations.filter(r => r.operation === 'LOOKUP' && r.invoked !== false && r.lookupStatus !== 'UNSUPPORTED');
  // The adapter records lookup latency separately from the original request.
  const lookupSubtotal = lookups.reduce((sum,r) => sum + (r.usage.lookupMs ?? 0),0);
  const lookupMs = lookups.every(r => Number.isFinite(r.usage.lookupMs)) ? lookupSubtotal : null;
  const knownInvocations = lookups.every(r=>r.invoked === true || r.usage.lookupMs != null || ['RETURNED','NOT_FOUND'].includes(r.lookupStatus));
  return {id:attempt.request.input.executionId, costUsd:merged?.charge.amount ?? null,
    lookupCount:knownInvocations ? lookups.length : null, lookupSubtotal,
    values:{...merged?.usage,...merged?.usage.tokenUsage,lookupMs}};
}

// A submitted offline receipt can report a conflict directly. The live batch keeps other pages readable.
export function measureStage15Attempt(attempt) {
  return measurement(attempt, a => aggregateStage15Usage(a.observations));
}

function summarize(rows, unconfirmedJobIds = []) {
  const unconfirmedExecutionIds = rows.filter(r => r.costUsd === null).map(r => r.id).sort();
  const confirmedSubtotal = formatUsd(rows.reduce((sum,r) => sum + (r.costUsd === null ? 0n : usdUnits(r.costUsd)),0n));
  const incomplete = unconfirmedJobIds.length > 0;
  const confirmed = !incomplete && !unconfirmedExecutionIds.length;
  const charge = {state:confirmed ? 'CONFIRMED' : 'UNCONFIRMED', currency:'USD',
    amount:confirmed ? confirmedSubtotal : null, confirmedSubtotal, unconfirmedExecutionIds,...(incomplete?{unconfirmedJobIds}:{})};
  const totals = {};
  for (const field of metrics) {
    const missing = rows.filter(r => r.values[field] == null).map(r => r.id).sort();
    const measured = rows.reduce((sum,r) => sum + ((field==='lookupMs' ? r.lookupSubtotal : r.values[field]) ?? 0),0);
    const subtotal = Number.isFinite(measured) && (field.endsWith('Ms') || Number.isSafeInteger(measured)) ? measured : null;
    totals[field] = {total:incomplete || missing.length ? null : subtotal,measuredSubtotal:subtotal,unmeasuredExecutionIds:missing};
  }
  const {localModelRequests,promptTokens,completionTokens,totalTokens,...timing} = totals;
  return {scope:'STAGE15_TRANSLATION_ATTEMPTS_TO_DATE',attemptCount:incomplete ? null : rows.length,
    lookupCount:incomplete || rows.some(r=>r.lookupCount==null) ? null : rows.reduce((sum,r)=>sum+r.lookupCount,0),
    charge,timing,localModelRequests,tokenUsage:{promptTokens,completionTokens,totalTokens}};
}

export function batchProviderUsage(attempts, batch, pages) {
  const members = new Map(pages.map(p => [p.jobId,p])), rows = new Map(), seen = new Set(), missingJobs = [];
  for (const a of attempts) {
    const b = a.request.input.binding;
    if (b.batchId !== batch.id) continue;
    const p = members.get(b.requestId);
    requireFact(p?.job && b.ownerScope.kind === 'session' && b.ownerScope.id === batch.owner && b.projectId === batch.projectId &&
      b.batchManifestSha256 === batch.fingerprint && b.contextRevision === batch.stage15ContextRevision &&
      b.pageId === p.pageId && b.pageNumber === p.pageNumber && b.sourceSha256 === p.sourceSha256 &&
      p.job.batchId === batch.id && b.generation === p.job.processingGeneration &&
      !seen.has(a.request.input.executionId),'STAGE15_BATCH_EVIDENCE_MISMATCH');
    seen.add(a.request.input.executionId);
    const list = rows.get(p.jobId) ?? [];
    list.push(measurement(a)); rows.set(p.jobId,list);
  }
  for (const p of pages) {
    if (p.job && p.job.batchId !== batch.id) continue;
    const list = rows.get(p.jobId) ?? [];
    const missing = (p.job?.stage15Attempts ?? []).filter(a=>{
      const row = list.find(r=>r.id===a.executionId);
      return !row || (a.usageConfirmed && (row.costUsd == null || usdUnits(row.costUsd) !== usdUnits(a.costUsd)));
    });
    if (!p.job || missing.length || (['result_unknown','completed'].includes(p.status) && !list.length)) {
      missingJobs.push(p.jobId);
      for (const a of missing) {
        const row = list.find(r=>r.id===a.executionId);
        if (row) row.costUsd = null;
        else list.push({id:a.executionId,costUsd:null,lookupCount:null,values:{}});
      }
      rows.set(p.jobId,list);
    }
  }
  return {usage:summarize([...rows.values()].flat(),missingJobs),byJob:new Map([...members.keys()].map(id=>
    [id,summarize(rows.get(id) ?? [],missingJobs.includes(id)?[id]:[])]))};
}
