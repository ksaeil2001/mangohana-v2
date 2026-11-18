import {digest, equal, identifier, keys, object, ratio, requireValue, validateIdentity} from '../offline/contract.mjs';
import {summarizeRequestRecords} from '../offline/operations.mjs';

const axes=['execution','structure','ocr','translationRuleQa','independentSemantic','imageQuality','typesetting','humanReview','userApproval'];
const states=['PASS','FAIL','NEEDS_REVIEW','NOT_MEASURED','BLOCKED'];
const coverage={
  execution:['current_job_attempt','stage_completion','storage_export_receipt'],
  structure:['materialized_bytes','identity_revision','lineage_frames','atomic_admission','operation_aggregate_consistency'],
  translationRuleQa:['bound_translation_input','id_number_language_rules'],
  ocr:['human_source_gt','region_matching','micro_cer','line_roi_mapping'],
  independentSemantic:['critical_major_meaning','dialogue_omission','names_titles_quantities','context'],
  imageQuality:['source_residue','inside_artwork_damage','outside_mask','protected_artwork','preserve_sfx'],
  typesetting:['actual_glyphs','actual_safe_area','clipping','minimum_size','human_legibility'],
  humanReview:['semantic','image','typesetting'],
  userApproval:['explicit_user_action'],
};
const finalAxes=['independentSemantic','imageQuality','typesetting','humanReview','userApproval'];
const humanAxes=['independentSemantic','imageQuality','typesetting','humanReview'];
const unsupported=['independent_semantic_correctness','single_japanese_residue','inside_mask_artwork_damage','actual_korean_glyph_coverage','human_readability'];
const preregistration=['work_split_and_exposure','source_and_gt_hashes','ocr_normalization','matching_unit_and_iou','error_taxonomy_and_severity','evaluator_and_policy_version','model_adapter_prompt_font_versions','environment_and_sampling','approval_policy','primary_metric_and_minimum_effect','noninferiority_margins','resource_caps_and_stop_rules','blind_randomized_human_review','holdout_freeze'];
const formula=(num,den,bounded=true,population='binary_independent_oracle')=>({numerator:num,denominator:den,bounded,population});
// Frozen v1 denominators. New semantics require a new version, never new labels on old receipts.
const metrics={
  precision:formula([['TP',1]],[['TP',1],['FP',1]]),recall:formula([['TP',1]],[['TP',1],['FN',1]]),
  f1:formula([['TP',2]],[['TP',2],['FP',1],['FN',1]]),
  micro_cer:formula([['characterErrors',1]],[['referenceCharacters',1]],false,'pooled_measurable_ocr_counts'),
  false_positive:formula([['FP',1]],[['FP',1],['TN',1]]),false_discovery:formula([['FP',1]],[['TP',1],['FP',1]]),
  defect_escape:formula([['FN',1]],[['TP',1],['FN',1]]),defective_among_accepted:formula([['FN',1]],[['FN',1],['TN',1]]),
  automatic_delivery:formula([['automaticDelivered',1]],[['eligiblePages',1]],true,'preregistered_eligible_cohort'),
  automatic_delivery_audit_error:formula([['auditedMajorCritical',1]],[['auditedAutomaticDelivered',1]],true,'independently_human_audited_automatic_deliveries'),
  first_correct_automatic:formula([['firstCorrectAutomatic',1]],[['eligiblePages',1]],true,'preregistered_eligible_cohort'),
  retry_success:formula([['verifiedRetrySuccess',1]],[['eligibleRetriedPages',1]],true,'actually_retried_pages_without_manual_edits'),
  review_hold:formula([['reviewHeld',1]],[['eligiblePages',1]],true,'preregistered_eligible_cohort'),
  evaluation_availability:formula([['evaluablePages',1]],[['eligiblePages',1]],true,'preregistered_eligible_cohort'),
  unmeasured:formula([['unmeasuredPages',1]],[['eligiblePages',1]],true,'single_declared_dimension_in_eligible_cohort'),
  synthetic_detection_coverage:formula([['detectedSyntheticDefects',1]],[['oracleSyntheticDefects',1]],true,'all_independent_synthetic_defects_including_unsupported'),
  real_detection_coverage:formula([['detectedRealDefects',1]],[['oracleRealDefects',1]],true,'independently_human_adjudicated_real_defects'),
  delivered_defective:formula([['defectiveDelivered',1]],[['allDelivered',1]],true,'complete_human_census_of_all_delivered_results'),
};
const sameSet=(a,b)=>Array.isArray(a)&&a.length===b.length&&new Set(a).size===a.length&&b.every(x=>a.includes(x));

/** Validate this stage's offline contract, not a runtime configuration or an empirical calibration. */
export function validateQualityPolicy(p) {
  requireValue(p?.schemaVersion===1 && p.policyVersion==='stage08-v1.1' && p.mode==='offline_only','INVALID_QUALITY_POLICY');
  requireValue(p.runtime?.automaticDeliveryEnabled===false && p.runtime?.automaticRetryEnabled===false && p.runtime?.savePathConnected===false,'POLICY_RUNTIME_FORBIDDEN');
  requireValue(p.runtime.manualReviewPreserved===true && sameSet(p.dimensions,axes) && sameSet(p.states,states),'POLICY_REQUIRED_DIMENSION_MISSING');
  requireValue(equal(p.requiredCoverage,coverage),'POLICY_REQUIRED_COVERAGE_MISSING');
  requireValue(sameSet(p.unsupportedAutomaticChecks,unsupported),'POLICY_REQUIRED_COVERAGE_MISSING');
  requireValue(equal(p.metrics,metrics),'POLICY_METRIC_DEFINITION_MISMATCH');
  for(const [severity,decision]of [['Critical','FAIL'],['Major','FAIL'],['Minor','NEEDS_REVIEW']])
    requireValue(p.severity?.[severity]?.decision===decision && p.severity[severity].requiresIndependentEvidence===true && p.severity[severity].scopeAndImpactRequired===true,'POLICY_SEVERITY_CONFLICT');
  requireValue(p.severity?.Uncertain?.decision==='NEEDS_REVIEW' && p.severity.Uncertain.severityMustRemainNull===true,'POLICY_SEVERITY_CONFLICT');
  requireValue(p.safeguards?.ocrQuadCoverage===.75 && p.safeguards.minimumFreeHostMiB>=512 && p.safeguards.minimumReportedFontPx===10,'POLICY_GUARD_WEAKENED');
  requireValue(Array.isArray(p.targets) && p.targets.length===17 && new Set(p.targets.map(t=>t.id)).size===17,'POLICY_TARGET_MISSING');
  for(const t of p.targets) requireValue(['STRUCTURAL_INVARIANT','INITIAL_NUMERIC_CANDIDATE','HUMAN_CALIBRATION_REQUIRED','CONFIRMED_ERROR_ZERO_TOLERANCE','INSUFFICIENT_REAL_DATA'].includes(t.classification) && t.achieved===null,'POLICY_TARGET_NOT_CALIBRATED');
  for(const [id,value]of [['major_dialogue_recall',.99],['major_dialogue_precision',.98],['micro_cer',.02]]) {
    const t=p.targets.find(t=>t.id===id);requireValue(t?.classification==='INITIAL_NUMERIC_CANDIDATE' && t.value===value && t.operator===(id==='micro_cer'?'<=':'>='),'POLICY_TARGET_NOT_CALIBRATED');
  }
  for(const [classification,ids]of [
    ['STRUCTURAL_INVARIANT',['id_loss_duplicate','outside_authorized_mask_changed_pixels']],
    ['CONFIRMED_ERROR_ZERO_TOLERANCE',['confirmed_critical_major_semantic_errors','missing_major_dialogue','major_name_title_quantity_mismatch','confirmed_removal_target_residue','protected_artwork_major_damage','unauthorized_preserved_sfx_removal']],
    ['HUMAN_CALIBRATION_REQUIRED',['wrong_bubble_mapping','actual_missing_glyphs','actual_safe_area_overflow']],
  ])for(const id of ids){const t=p.targets.find(t=>t.id===id);requireValue(t?.classification===classification&&t.value===0&&t.operator==='=','POLICY_TARGET_NOT_CALIBRATED');}
  const font=p.targets.find(t=>t.id==='minimum_display_px');requireValue(font?.classification==='HUMAN_CALIBRATION_REQUIRED'&&font.value===10&&font.operator==='>=','POLICY_TARGET_NOT_CALIBRATED');
  for(const id of ['minimum_adoption_effect','minor_error_tolerance']){const t=p.targets.find(t=>t.id===id);requireValue(t?.classification==='INSUFFICIENT_REAL_DATA'&&t.value===null&&t.operator===null,'POLICY_TARGET_NOT_CALIBRATED');}
  const r=p.reprocessing;
  requireValue(r?.applied===false && r.classification==='PROVISIONAL_NOT_RUNTIME' && r.correctionAttempts===2 && r.modelFallbacks===1 && r.fallbackIncludedInCorrections===true && r.stopOnRepeatedRootCause===true && r.preserveBetterPreviousCandidate===true && r.preserveUserConfirmedValues===true && r.unknownCompletionNeverAutoRetried===true && equal(r.pageLimits,{maxRequests:null,maxTokens:null,maxDurationMs:null,maxMoney:null,maxGpuBytes:null}),'POLICY_REPROCESSING_NOT_CALIBRATED');
  requireValue(sameSet(p.datasetStates,['DATASET_PREPARED','HUMAN_GT_BLOCKED','HOLDOUT_BLOCKED']) && equal(p.datasetCounts,{dev:10,unassigned:10,professionalReferences:10,humanVerified:0,holdout:0}),'POLICY_GT_PROMOTION_FORBIDDEN');
  requireValue(p.finalEvaluation?.unseenWorkRequired===true && p.finalEvaluation.developmentWorkExcluded===true && p.finalEvaluation.postOutcomeThresholdChangesForbidden===true && p.finalEvaluation.criteriaFreeze===null,'POLICY_HOLDOUT_NOT_FROZEN');
  requireValue(sameSet(p.preregistrationRequired,preregistration),'POLICY_PREREGISTRATION_MISSING');
  requireValue(equal(p.modelComparison,{executed:false,baselinePreserved:true,maximumNewCandidates:1,requiredConditions:8,memoryFailureIsSemanticError:false}),'POLICY_MODEL_COMPARISON_BLOCKED');
  requireValue(p.legacyMetricInterpretation?.['stage07.falseAcceptRate']==='defective_among_accepted' && p.legacyMetricInterpretation?.['stage07.defectEscapeRate']==='defect_escape' && p.legacyMetricInterpretation.rawStage07Rewritten===false && p.legacyMetricInterpretation.oldResultsAreProductDeliveryRates===false,'POLICY_LEGACY_REWRITE_FORBIDDEN');
  return p;
}

function validateEvidence(e,a,axis) {
  requireValue(object(e) && identifier(e.evidenceId) && ['system','ai','human','user'].includes(e.actor) && typeof e.independent==='boolean' && Array.isArray(e.coverage) && e.coverage.every(identifier),'POLICY_EVIDENCE_REQUIRED');
  validateIdentity(e.identity);
  const artifact=a.artifacts.find(x=>x.artifactId===e.subjectArtifactId);
  requireValue(equal(e.identity,a.identity) && artifact?.sha256===e.subjectSha256 && (!finalAxes.includes(axis) || e.subjectArtifactId===a.finalArtifactId),'POLICY_EVIDENCE_BINDING_MISMATCH');
}
const combine=statuses=>['FAIL','BLOCKED','NEEDS_REVIEW','NOT_MEASURED'].find(s=>statuses.includes(s))??'PASS';

/** Pure recommendations on supplied, bound evidence. No file writes, approval actions, retries or publishing. */
export function evaluateQualityGates(policy,a) {
  validateQualityPolicy(policy);
  requireValue(a?.schemaVersion===1 && a.policyVersion===policy.policyVersion && ['actual_product','synthetic','saved_record'].includes(a.evidenceKind),'INVALID_POLICY_ASSESSMENT');
  validateIdentity(a.identity);
  requireValue(Object.values(a.identity).every(v=>v!==null),'POLICY_CURRENT_IDENTITY_INCOMPLETE');
  requireValue(Array.isArray(a.artifacts) && new Set(a.artifacts.map(x=>x.artifactId)).size===a.artifacts.length && a.artifacts.every(x=>identifier(x.artifactId)&&digest(x.sha256)) && (a.finalArtifactId===null || a.artifacts.some(x=>x.artifactId===a.finalArtifactId)),'POLICY_ARTIFACT_REGISTRY_REQUIRED');
  requireValue(object(a.dimensions) && sameSet(Object.keys(a.dimensions),axes) && Array.isArray(a.findings),'POLICY_REQUIRED_DIMENSION_MISSING');
  const dimensions=structuredClone(a.dimensions),coverageGaps=[];
  for(const axis of axes) {
    const d=dimensions[axis];
    requireValue(object(d) && states.includes(d.status) && (d.status==='PASS'?d.reason===null:identifier(d.reason)),'INVALID_POLICY_DIMENSION');
    if(['PASS','FAIL'].includes(d.status))validateEvidence(d.evidence,a,axis);
    else requireValue(d.evidence===null,'POLICY_PENDING_EVIDENCE_MUST_BE_NULL');
    if(d.status!=='PASS')continue;
    const missing=(coverage[axis]??[]).filter(check=>!d.evidence.coverage.includes(check));
    if(humanAxes.includes(axis) && (d.evidence.actor!=='human' || d.evidence.independent!==true || d.evidence.humanVerification!=='human_verified'))missing.push('independent_human_verified_review');
    if(axis==='userApproval' && d.evidence.actor!=='user')missing.push('explicit_user_action');
    if(missing.length) {coverageGaps.push(...missing.map(check=>axis+':'+check));d.status='NEEDS_REVIEW';d.reason='REQUIRED_INDEPENDENT_COVERAGE_MISSING';}
  }
  const findings=structuredClone(a.findings),findingDecisions=[];
  const findingIds=new Set();
  for(const f of findings) {
    requireValue(identifier(f.id) && !findingIds.has(f.id) && identifier(f.type) && axes.includes(f.dimension) && typeof f.confirmed==='boolean' && Array.isArray(f.targetIds) && f.targetIds.length>0 && f.targetIds.every(identifier) && typeof f.impact==='string' && f.impact.trim().length>0 && identifier(f.scope),'INVALID_POLICY_FINDING');findingIds.add(f.id);
    if(f.confirmed) {
      requireValue(['Critical','Major','Minor'].includes(f.severity) && f.evidence?.independent===true,'POLICY_FINDING_EVIDENCE_REQUIRED');validateEvidence(f.evidence,a,f.dimension);
      if(humanAxes.includes(f.dimension))requireValue(f.evidence.actor==='human' && f.evidence.humanVerification==='human_verified','POLICY_FINDING_EVIDENCE_REQUIRED');
      findingDecisions.push(policy.severity[f.severity].decision);
    } else {requireValue(f.severity===null,'POLICY_FINDING_EVIDENCE_REQUIRED');findingDecisions.push('NEEDS_REVIEW');}
    const decision=findingDecisions.at(-1),d=dimensions[f.dimension];
    d.status=combine([d.status,decision]);d.reason=d.status==='FAIL'?'CONFIRMED_FINDING':'FINDING_REQUIRES_REVIEW';
  }
  const qualityAxes=['ocr','translationRuleQa','independentSemantic','imageQuality','typesetting','humanReview'];
  const qualityStatus=combine([...qualityAxes.map(axis=>dimensions[axis].status),...findings.filter(f=>qualityAxes.includes(f.dimension)).map(f=>f.confirmed?policy.severity[f.severity].decision:'NEEDS_REVIEW')]);
  let release=combine([...axes.map(axis=>dimensions[axis].status),...findingDecisions]);
  if(a.finalArtifactId===null){coverageGaps.push('final_artifact_missing');release=combine([release,'BLOCKED']);}
  if(release==='NOT_MEASURED')release='NEEDS_REVIEW';
  if(a.evidenceKind!=='actual_product' && release!=='FAIL')release='BLOCKED';
  return {policyVersion:policy.policyVersion,dimensions,qualityStatus,findings,coverageGaps,
    releaseRecommendation:{status:release,reason:release==='PASS'?null:release==='FAIL'?'CONFIRMED_FAILURE':release==='BLOCKED'?'PRECONDITION_OR_EVIDENCE_SCOPE_BLOCKED':'INDEPENDENT_REVIEW_REQUIRED'},
    automaticDelivery:{status:'BLOCKED',enabled:false,reason:'OFFLINE_POLICY_NOT_ACTIVATED_IN_RUNTIME'},manualReviewAvailable:true,
    basis:'OFFLINE_BOUND_SUBMISSIONS_NOT_EXECUTION_OR_REVIEWER_AUTHENTICATION'};
}

/** Caller supplies independently established counts and cohort completeness; this function cannot create GT. */
export function calculatePolicyMetric(policy,id,counts,{coverage:observedCoverage='complete'}={}) {
  validateQualityPolicy(policy);
  const m=policy.metrics[id];requireValue(m && object(counts) && ['complete','partial','none'].includes(observedCoverage),'INVALID_POLICY_METRIC');
  const used=[...new Set([...m.numerator,...m.denominator].map(([k])=>k))];
  keys(counts,m.population==='binary_independent_oracle'?['TP','FP','FN','TN']:used,'INVALID_POLICY_METRIC_COUNTS');
  requireValue(Object.values(counts).every(v=>v===null || Number.isSafeInteger(v)&&v>=0),'INVALID_POLICY_METRIC_COUNTS');
  const missing=used.some(k=>counts[k]==null),sum=terms=>terms.reduce((n,[key,weight])=>n+counts[key]*weight,0);
  const numerator=missing?null:sum(m.numerator),denominator=missing?null:sum(m.denominator);
  requireValue(missing || Number.isSafeInteger(numerator)&&Number.isSafeInteger(denominator) && (!m.bounded || numerator<=denominator),'INVALID_POLICY_METRIC_COUNTS');
  const reason=missing || observedCoverage==='none'?'MISSING_COUNTS_OR_GT':observedCoverage==='partial'?'PARTIAL_OBSERVATION':'ZERO_DENOMINATOR';
  const computed=ratio(numerator,denominator,reason);
  return {...computed,value:observedCoverage==='complete'&&!missing?computed.value:null,
    reason:observedCoverage==='complete'&&!missing?computed.reason:reason,status:computed.value!==null && observedCoverage==='complete'?'PASS':'NOT_MEASURED',
    coverage:observedCoverage,observedSubsetValue:observedCoverage==='partial'&&!missing?computed.value:null,population:m.population,
    meaning:'MEASUREMENT_AVAILABLE_NOT_QUALITY_TARGET_ACHIEVEMENT'};
}

/** Recompute bound request-record claims. Receipt/file authenticity and actual settlement remain separate. */
export function validateRequestAggregate({records,pageRequests,reported}) {
  const recomputed=summarizeRequestRecords(records,pageRequests);
  requireValue(object(reported),'POLICY_OPERATION_AGGREGATE_MISMATCH');
  for(const key of ['uniqueRequests','requestDurationMs','modelCalls','inputTokens','outputTokens','apiCost'])
    requireValue(equal(reported[key],recomputed[key]),'POLICY_OPERATION_AGGREGATE_MISMATCH');
  return recomputed;
}
