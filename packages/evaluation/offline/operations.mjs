import { digest, equal, identifier, keys, measured, measurement, ratio, requireValue, unknown } from './contract.mjs';

/** Request IDs identify shared page requests; per-dialogue copies are not time units. */
export function summarizeRequestRecords(records = [], pageRequests = []) {
  requireValue(Array.isArray(records) && Array.isArray(pageRequests),'INVALID_REQUEST_MEASUREMENTS');
  const groups=new Map(),proofs=new Map();
  for(const proof of pageRequests) { requireValue(identifier(proof.requestId) && !proofs.has(proof.requestId),'INVALID_REQUEST_MEASUREMENTS'); proofs.set(proof.requestId,proof); }
  for(const r of records) { requireValue(identifier(r.requestId),'INVALID_REQUEST_MEASUREMENTS'); if(!groups.has(r.requestId)) groups.set(r.requestId,[]); groups.get(r.requestId).push(r); }
  let duration=0,calls=0,knownDuration=0,knownCalls=0;
  const observedCosts=new Map(),tokenTotals={inputTokens:0,outputTokens:0},tokenKnown={inputTokens:0,outputTokens:0};
  for(const [id,members] of groups) {
    const proof=proofs.get(id),durations=members.map(m=>m.durationMs ?? null);
    requireValue(durations.every(v=>v === null || Number.isFinite(v) && v >= 0),'INVALID_REQUEST_MEASUREMENTS');
    requireValue(durations.every(v=>v === durations[0]),'CONFLICTING_REQUEST_MEASUREMENTS');
    if(durations[0] !== null) { duration+=durations[0];knownDuration++; }
    let n;
    if(members.some(m=>m.requestScope === 'page')) {
      requireValue(proof && Number.isSafeInteger(proof.httpRequests) && proof.httpRequests >= 0 && members.every(m=>m.requestScope === 'page'), 'SHARED_REQUEST_PROOF_REQUIRED');
      const byRegion=new Map();
      for(const m of members) { requireValue(identifier(m.id) && !byRegion.has(m.id),'INVALID_REQUEST_MEASUREMENTS');byRegion.set(m.id,m); }
      requireValue(Array.isArray(proof.regionIds) && proof.regionIds.length === members.length && proof.regionIds.every(id=>byRegion.has(id)),'SHARED_REQUEST_PROOF_REQUIRED');
      requireValue(members.every(m=>Number.isSafeInteger(m.modelHttpRequests) && m.modelHttpRequests >= 0) && members.reduce((s,m)=>s+m.modelHttpRequests,0) === proof.httpRequests,'CONFLICTING_REQUEST_MEASUREMENTS');
      n=proof.httpRequests;
    } else {
      const values=members.map(m=>m.modelHttpRequests ?? null);
      requireValue(values.every(v=>v === values[0]),'CONFLICTING_REQUEST_MEASUREMENTS');n=values[0];
    }
    requireValue(n === null || Number.isSafeInteger(n) && n >= 0,'INVALID_REQUEST_MEASUREMENTS');
    if(n !== null) {calls+=n;knownCalls++;}
    for(const key of ['inputTokens','outputTokens']) {
      const values=members.map(m=>m[key] ?? null); requireValue(values.every(v=>equal(v,values[0])),'CONFLICTING_REQUEST_MEASUREMENTS');
      if(values[0] !== null) {requireValue(Number.isSafeInteger(values[0]) && values[0] >= 0,'INVALID_REQUEST_MEASUREMENTS');tokenTotals[key]+=values[0];tokenKnown[key]++;}
    }
    const costs=members.map(m=>m.observedApiCost ?? null);requireValue(costs.every(c=>equal(c,costs[0])),'CONFLICTING_REQUEST_MEASUREMENTS');
    if(costs[0] !== null) {
      const c=costs[0];keys(c,['value','currency','scope'],'INVALID_COST');requireValue(c.scope === 'product_api' && /^[A-Z]{3}$/.test(c.currency) && Number.isFinite(c.value) && c.value >= 0,'INVALID_COST');
      const total=observedCosts.get(c.currency)??{value:0,requests:0};total.value+=c.value;total.requests++;observedCosts.set(c.currency,total);
    }
  }
  const count=groups.size,complete=(n,v,unit,reason)=>count > 0 && n === count ? measured(v,unit) : {...unknown(reason,unit),observedSubtotal:v,measuredRequests:n,totalRequests:count};
  return {uniqueRequests:count,requestDurationMs:complete(knownDuration,duration,'ms','REQUEST_TIME_INCOMPLETE'),modelCalls:complete(knownCalls,calls,'count','MODEL_CALLS_NOT_FULLY_REPORTED'),
    inputTokens:complete(tokenKnown.inputTokens,tokenTotals.inputTokens,'tokens','TOKEN_USAGE_NOT_FULLY_REPORTED'),outputTokens:complete(tokenKnown.outputTokens,tokenTotals.outputTokens,'tokens','TOKEN_USAGE_NOT_FULLY_REPORTED'),
    apiCost:observedCosts.size === 1 && [...observedCosts.values()][0].requests === count ? {...measured([...observedCosts.values()][0].value,[...observedCosts.keys()][0]),scope:'product_api'}
      : {...unknown('API_COST_NOT_FULLY_REPORTED','currency'),observedByCurrency:Object.fromEntries(observedCosts)},
    basis:'PINNED_PRODUCT_RECORDS_NOT_CODEX_USAGE',includesCodexDevelopmentUsage:false};
}

export function readProcessing(page) {
  const state=page.state,report=page.report;
  const complete=state?.status === 'completed';
  if(complete) requireValue(state.stage === 'completed' && page.get('report') && page.get('candidate') && page.get('cleaned') && page.get('final_ocr') && page.get('translations'),'INCOMPLETE_COMPLETION_EVIDENCE');
  const status=complete ? 'succeeded' : ['failed','cancelled','interrupted','running','queued'].includes(state?.status)
    ? ({cancelled:'interrupted',queued:'not_run'})[state.status]??state.status : 'unknown';
  if(page.declaredOutcome === 'succeeded') requireValue(status === 'succeeded','INCOMPLETE_SUCCESS_CLAIM');
  else if(page.declaredOutcome !== null) requireValue(status === page.declaredOutcome,'PROCESSING_OUTCOME_MISMATCH');
  const timestampsValid=state && Number.isFinite(Date.parse(state.createdAt)) && Number.isFinite(Date.parse(state.updatedAt)) && Date.parse(state.updatedAt) >= Date.parse(state.createdAt);
  if(state) requireValue(timestampsValid,'INVALID_EXECUTION_TIMESTAMPS');
  const stageTimes={},rows=report?.measurements?.stages??[];
  for(const r of rows) {
    requireValue(identifier(r.stage) && !Object.hasOwn(stageTimes,r.stage) && Number.isFinite(r.durationMs) && r.durationMs >= 0,'INVALID_STAGE_TIMING');
    if(r.startElapsedMs !== undefined || r.endElapsedMs !== undefined) requireValue(Number.isFinite(r.startElapsedMs) && Number.isFinite(r.endElapsedMs)
      && r.startElapsedMs >= 0 && r.endElapsedMs >= r.startElapsedMs && Math.abs(r.endElapsedMs-r.startElapsedMs-r.durationMs) < .01,'INVALID_STAGE_TIMING');
    stageTimes[r.stage]=measured(r.durationMs,'ms');
  }
  const events=page.get('events')?.events??[];
  const eventTime=(phase)=>{const matches=events.filter(e=>e.phase === phase);return matches.length === 1 && Number.isFinite(matches[0].durationMs) && matches[0].durationMs >= 0 ? measured(matches[0].durationMs,'ms') : unknown('EVENT_DURATION_NOT_REPORTED','ms');};
  const requestRecords=page.get('translations')?.json?.records??report?.translations??[];
  let translationRequests=summarizeRequestRecords(requestRecords,report?.translationRequests??[]);
  if(report?.recovery?.reusedStages?.includes('translation')){
    requireValue(report.recovery.version==='stage13-checkpoint-v1'&&identifier(report.recovery.fromJobId)&&report.recovery.fromJobId===state?.retryOf&&
      state?.checkpoints?.translation?.stage==='translation'&&digest(state.checkpoints.translation.sha256)&&state?.usage?.localModelRequests===0,'REUSED_REQUEST_PROOF_REQUIRED');
    // Raw past requests remain pinned in the original report; they are not new execution units.
    // Absence of observed money/tokens is still unknown, including on a cache hit.
    translationRequests={...summarizeRequestRecords(),requestDurationMs:measured(0,'ms'),modelCalls:measured(0,'count')};
  }
  const elapsed=report?.measurements?.elapsedMs ?? state?.usage?.engineMeasuredMs ?? null;
  const pageWall=timestampsValid?Date.parse(state.updatedAt)-Date.parse(state.createdAt):null;
  return {status,basis:state?'PINNED_DURABLE_STATE':'STATE_NOT_AVAILABLE',errorCode:identifier(state?.errorCode)?state.errorCode:null,
    pageWallMs:pageWall === null?unknown('DURABLE_TIMESTAMPS_NOT_REPORTED','ms'):measured(pageWall,'ms'),
    engineElapsedMs:elapsed === null?unknown('ENGINE_TIME_NOT_REPORTED','ms'):measured(elapsed,'ms'),
    consumedProcessingMs:state?.usage?.processingMs == null?unknown('CONSUMED_PROCESSING_TIME_NOT_REPORTED','ms'):measured(state.usage.processingMs,'ms'),
    stageTimes,ocrPreparationMs:unknown('OCR_PREPARATION_NOT_SEPARATELY_REPORTED','ms'),ocrRecognitionMs:unknown('OCR_RECOGNITION_NOT_SEPARATELY_REPORTED','ms'),
    translationModelLoadMs:eventTime('llama_load_ready'),translationRequests,
    peakRamBytes:unknown('RAM_OBSERVATION_NOT_REPORTED','bytes'),peakGpuBytes:unknown('GPU_MEMORY_OBSERVATION_NOT_REPORTED','bytes'),
    timeScope:report?.measurements?.scope === 'engine_through_candidate_validation_before_cleanup'?'ENGINE_THROUGH_CANDIDATE_BEFORE_CLEANUP':'LEGACY_REPORTED_SCOPE',
    finalExportMs:unknown('FINAL_EXPORT_TIME_NOT_SEPARATELY_REPORTED','ms')};
}

export function readOperations(page) {
  if(page.operationsArtifactId === null) return {attempts:null,delivery:null,historyReason:'ATTEMPT_AND_DELIVERY_HISTORY_NOT_REPORTED'};
  const a=page.artifacts.get(page.operationsArtifactId);
  requireValue(a?.kind === 'operations','OPERATIONS_ARTIFACT_MISMATCH');const x=a.json;
  keys(x,['schemaVersion','identity','attempts','delivery','resources'],'INVALID_OPERATIONS');
  requireValue(x.schemaVersion === 1 && equal(x.identity,page.binding) && Array.isArray(x.attempts),'OPERATIONS_BINDING_MISMATCH');
  validateAttempts(x.attempts);
  if(x.attempts.length) requireValue(x.attempts.at(-1).jobId === page.binding.jobId && x.attempts.at(-1).status === ({completed:'succeeded',cancelled:'interrupted'})[page.state?.status]
    || x.attempts.at(-1).jobId === page.binding.jobId && x.attempts.at(-1).status === page.state?.status,'ATTEMPT_STATE_MISMATCH');
  if(x.delivery !== null) {
    keys(x.delivery,['decision','subjectArtifactId','subjectSha256','humanAudit'],'INVALID_DELIVERY_RECORD');
    const subject=page.artifacts.get(x.delivery.subjectArtifactId);
    requireValue(['automatic','manual','withheld'].includes(x.delivery.decision) && subject?.sha256 === x.delivery.subjectSha256,'DELIVERY_BINDING_MISMATCH');
    // Actual auditing is resolved using the separately validated assessment, not this ledger.
    requireValue(x.delivery.humanAudit === null,'HUMAN_AUDIT_REQUIRES_QUALITY_ASSESSMENT');
  }
  const resources=x.resources??{};
  keys(resources,['peakRamBytes','peakGpuBytes'],'INVALID_RESOURCES');
  for(const [key,value] of Object.entries(resources)) {measurement(value);requireValue(value.unit === 'bytes' && (value.value === null || Number.isSafeInteger(value.value)),'INVALID_RESOURCES');}
  return {attempts:x.attempts,delivery:x.delivery,resources,historyReason:null,basis:'PINNED_LEDGER_CLAIMS_NOT_INDEPENDENT_EXECUTION'};
}
function validateAttempts(attempts) {
  const ids=new Set();for(let i=0;i<attempts.length;i++) {
    const a=attempts[i];requireValue(identifier(a.attemptId) && !ids.has(a.attemptId) && a.number === i+1
      && ['succeeded','failed','interrupted','running'].includes(a.status) && Number.isSafeInteger(a.manualEdits) && a.manualEdits >= 0,'INVALID_ATTEMPT_HISTORY');
    ids.add(a.attemptId);requireValue(i === attempts.length-1 || ['failed','interrupted'].includes(a.status),'INVALID_ATTEMPT_HISTORY');
  }
}
export function aggregateOperations(pages) {
  const n=pages.length,history=pages.filter(p=>Array.isArray(p.attempts) && p.attempts.length),success={firstAttempt:0,afterRetry:0,afterManualEdits:0};
  for(const p of history) {validateAttempts(p.attempts);if(p.processing.status !== 'succeeded') continue;
    const last=p.attempts.at(-1);requireValue(last.status === 'succeeded','ATTEMPT_STATE_MISMATCH');
    success[p.attempts.some(a=>a.manualEdits>0)?'afterManualEdits':last.number>1?'afterRetry':'firstAttempt']++;
  }
  const decisions=pages.filter(p=>p.delivery),complete=decisions.length === n;
  const automatic=decisions.filter(p=>p.delivery.decision === 'automatic'),audited=automatic.filter(p=>p.humanAudit?.verified === true);
  const auditErrors=audited.filter(p=>p.humanAudit.majorCriticalErrors>0).length;
  const reasons={};for(const p of pages) if(p.processing.status === 'failed') reasons[p.processing.errorCode??'UNCLASSIFIED_FAILURE']=(reasons[p.processing.errorCode??'UNCLASSIFIED_FAILURE']??0)+1;
  return {pages:n,recordedSuccess:{...success,pagesWithHistory:history.length,denominator:n,basis:'PINNED_HISTORY_CLAIMS',byEvidenceKind:Object.fromEntries(['actual_product','component','cache_reuse','synthetic','not_run'].map(k=>[k,history.filter(p=>p.evidenceKind===k).length]))},
    recordedFirstAttemptSuccessRate:ratio(history.length===n?success.firstAttempt:null,n,n?'ATTEMPT_HISTORY_INCOMPLETE':'NO_PAGES'),
    recordedAfterRetrySuccessRate:ratio(success.afterRetry,history.filter(p=>p.attempts.length>1 && !p.attempts.some(a=>a.manualEdits>0)).length,'NO_RETRY_PAGES'),
    recordedAfterManualEditSuccessRate:ratio(success.afterManualEdits,history.filter(p=>p.attempts.some(a=>a.manualEdits>0)).length,'NO_MANUALLY_EDITED_PAGES'),
    verifiedFirstAttemptSuccessRate:ratio(null,null,n?'INDEPENDENT_PRODUCT_EXECUTION_NOT_VERIFIED':'NO_PAGES'),
    verifiedCorrectAutomaticCompletionRate:ratio(null,null,'INDEPENDENT_EXECUTION_AND_HUMAN_QUALITY_REQUIRED'),
    automaticDeliveryRate:ratio(complete?automatic.length:null,n,n?'DELIVERY_RECORDS_INCOMPLETE':'NO_PAGES'),
    withheldRate:ratio(complete?decisions.filter(p=>p.delivery.decision==='withheld').length:null,n,n?'DELIVERY_RECORDS_INCOMPLETE':'NO_PAGES'),
    worstCaseWithheldRate:ratio(decisions.filter(p=>p.delivery.decision==='withheld').length+n-decisions.length,n,'NO_PAGES'),
    automaticDeliveryErrorRate:ratio(auditErrors,audited.length,'NO_HUMAN_AUDITED_AUTOMATIC_DELIVERIES'),
    automaticDeliveryErrorConfidence95:{value:null,reason:audited.length?'AUDIT_SAMPLING_INDEPENDENCE_NOT_ESTABLISHED':'NO_AUDIT_SAMPLE'},
    evaluationDataAvailability:ratio(pages.filter(p=>p.ocr!==null && p.humanAudit?.verified).length,n,'NO_PAGES'),
    indeterminateRate:ratio(pages.filter(p=>p.humanReview?.status!=='completed').length,n,'NO_PAGES'),failuresByType:reasons};
}
