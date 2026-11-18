import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const api=await import('../../packages/evaluation/policy/policy.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const policyFile=new URL('../../packages/evaluation/policy/stage08-v1.1.json',import.meta.url);
const load=()=>fs.existsSync(policyFile)?JSON.parse(fs.readFileSync(policyFile,'utf8')):null;
const available=name=>assert.equal(typeof api[name],'function',`${name} must exist`);
const identity={ownerId:'owner-test',projectId:'project-test',workId:'work-test',pageId:'page-test',jobId:'job-test',sourceRevision:1,editRevision:2,contextRevision:3,processingGeneration:4,storageRevision:5};
const axes=['execution','structure','ocr','translationRuleQa','independentSemantic','imageQuality','typesetting','humanReview','userApproval'];
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
function assessment(){
 const evidence=axis=>({evidenceId:'evidence-'+axis,actor:['independentSemantic','imageQuality','typesetting','humanReview'].includes(axis)?'human':axis==='userApproval'?'user':'system',
  independent:true,identity:structuredClone(identity),subjectArtifactId:axis==='ocr'?'ocr':'final',subjectSha256:axis==='ocr'?'b'.repeat(64):'a'.repeat(64),
  coverage:coverage[axis]??[],humanVerification:['independentSemantic','imageQuality','typesetting','humanReview'].includes(axis)?'human_verified':null});
 return {schemaVersion:1,policyVersion:'stage08-v1.1',evidenceKind:'actual_product',identity:structuredClone(identity),finalArtifactId:'final',
  artifacts:[{artifactId:'final',sha256:'a'.repeat(64)},{artifactId:'ocr',sha256:'b'.repeat(64)}],
  dimensions:Object.fromEntries(axes.map(axis=>[axis,{status:'PASS',reason:null,evidence:evidence(axis)}])),findings:[]};
}
const decide=a=>{available('evaluateQualityGates');return api.evaluateQualityGates(load(),a);};

test('policy conflicts cannot activate runtime delivery, retries, or storage',()=>{
 available('validateQualityPolicy');const p=load();assert.ok(p);assert.equal(api.validateQualityPolicy(p),p);
 for(const field of ['automaticDeliveryEnabled','automaticRetryEnabled','savePathConnected']){const x=structuredClone(p);x.runtime[field]=true;assert.throws(()=>api.validateQualityPolicy(x),{code:'POLICY_RUNTIME_FORBIDDEN'});}
});
test('missing gates, unsupported critical coverage and weakened guards invalidate the policy',()=>{
 available('validateQualityPolicy');
 for(const mutate of [p=>p.dimensions.pop(),p=>p.requiredCoverage.imageQuality.splice(0,1),p=>p.safeguards.ocrQuadCoverage=.5,p=>p.safeguards.minimumFreeHostMiB=256,p=>p.runtime.manualReviewPreserved=false]){
  const p=load();mutate(p);assert.throws(()=>api.validateQualityPolicy(p));
 }
});
test('unmeasured numeric goals cannot be advertised as achieved or validated',()=>{
 available('validateQualityPolicy');for(const status of ['ACHIEVED','VALIDATED']){const p=load();p.targets.find(t=>t.id==='micro_cer').classification=status;assert.throws(()=>api.validateQualityPolicy(p),{code:'POLICY_TARGET_NOT_CALIBRATED'});}
});
test('a changed metric denominator requires a new contract rather than silently changing stage08-v1.1',()=>{
 available('validateQualityPolicy');const p=load();p.metrics.defective_among_accepted.denominator=[['TP',1],['FN',1]];
 assert.throws(()=>api.validateQualityPolicy(p),{code:'POLICY_METRIC_DEFINITION_MISMATCH'});
});
test('confirmed severity requires an explicit automatic approval consequence',()=>{
 available('validateQualityPolicy');const p=load();p.severity.Critical.decision='PASS';assert.throws(()=>api.validateQualityPolicy(p),{code:'POLICY_SEVERITY_CONFLICT'});
});
test('unfunded resource limits and uncalibrated retry counts cannot become active limits',()=>{
 available('validateQualityPolicy');for(const mutate of [p=>p.reprocessing.applied=true,p=>p.reprocessing.pageLimits.maxMoney=1,p=>p.reprocessing.correctionAttempts=99]){
  const p=load();mutate(p);assert.throws(()=>api.validateQualityPolicy(p),{code:'POLICY_REPROCESSING_NOT_CALIBRATED'});
 }
});
test('model comparison and preregistration cannot omit their blocking prerequisites',()=>{
 available('validateQualityPolicy');for(const mutate of [p=>p.modelComparison.baselinePreserved=false,p=>p.modelComparison.maximumNewCandidates=2,p=>p.modelComparison.requiredConditions=7,p=>p.preregistrationRequired.pop(),p=>p.unsupportedAutomaticChecks.pop()]){
  const p=load();mutate(p);assert.throws(()=>api.validateQualityPolicy(p));
 }
});
test('zero-tolerance targets cannot be relaxed inside an unchanged policy version',()=>{
 available('validateQualityPolicy');const p=load();p.targets.find(t=>t.id==='confirmed_removal_target_residue').value=1;
 assert.throws(()=>api.validateQualityPolicy(p),{code:'POLICY_TARGET_NOT_CALIBRATED'});
});
test('all submitted independent gates can pass offline while runtime delivery remains blocked',()=>{
 const a=assessment(),before=structuredClone(a),r=decide(a);
 assert.equal(r.releaseRecommendation.status,'PASS');assert.equal(r.automaticDelivery.status,'BLOCKED');assert.equal(r.automaticDelivery.enabled,false);
 assert.equal(r.manualReviewAvailable,true);assert.equal(r.basis,'OFFLINE_BOUND_SUBMISSIONS_NOT_EXECUTION_OR_REVIEWER_AUTHENTICATION');assert.deepEqual(a,before);
 assert.equal(r.dimensions.independentSemantic.status,'PASS');
});
test('PNG completion and rule QA cannot promote unmeasured semantics to quality PASS',()=>{
 const a=assessment();a.dimensions.independentSemantic={status:'NOT_MEASURED',reason:'NO_INDEPENDENT_SEMANTIC_GT',evidence:null};
 const r=decide(a);assert.equal(r.dimensions.execution.status,'PASS');assert.equal(r.dimensions.translationRuleQa.status,'PASS');
 assert.equal(r.dimensions.independentSemantic.status,'NOT_MEASURED');assert.equal(r.qualityStatus,'NOT_MEASURED');assert.equal(r.releaseRecommendation.status,'NEEDS_REVIEW');
});
for(const status of ['FAIL','NEEDS_REVIEW','NOT_MEASURED','BLOCKED'])test('one '+status+' gate never becomes release PASS',()=>{
 const a=assessment();a.dimensions.ocr={status,reason:'OCR_EVIDENCE_STATE',evidence:status==='FAIL'?a.dimensions.ocr.evidence:null};
 const r=decide(a);assert.equal(r.releaseRecommendation.status,status==='NOT_MEASURED'?'NEEDS_REVIEW':status);assert.equal(r.dimensions.ocr.status,status);
});
test('execution failure does not manufacture semantic failure or destroy manual review',()=>{
 const a=assessment();a.dimensions.execution.status='FAIL';a.dimensions.execution.reason='HOST_MEMORY_PRESSURE';
 const r=decide(a);assert.equal(r.releaseRecommendation.status,'FAIL');assert.equal(r.dimensions.independentSemantic.status,'PASS');assert.equal(r.qualityStatus,'PASS');assert.equal(r.manualReviewAvailable,true);
});
test('blocked prerequisites take priority over review and unmeasured states without hiding either axis',()=>{
 const a=assessment();a.dimensions.structure={status:'BLOCKED',reason:'RECEIPTS_UNAVAILABLE',evidence:null};a.dimensions.ocr={status:'NOT_MEASURED',reason:'NO_GT',evidence:null};
 const r=decide(a);assert.equal(r.releaseRecommendation.status,'BLOCKED');assert.equal(r.dimensions.ocr.status,'NOT_MEASURED');
});
test('unsupported semantic or image checks keep an otherwise passed result on review hold',()=>{
 for(const [axis,check]of [['independentSemantic','critical_major_meaning'],['imageQuality','inside_artwork_damage'],['typesetting','actual_glyphs']]){
  const a=assessment();a.dimensions[axis].evidence.coverage=a.dimensions[axis].evidence.coverage.filter(x=>x!==check);
  const r=decide(a);assert.equal(r.dimensions[axis].status,'NEEDS_REVIEW');assert.equal(r.releaseRecommendation.status,'NEEDS_REVIEW');assert.ok(r.coverageGaps.includes(axis+':'+check));
 }
});
test('execution, structure, rule QA and user approval require explicit coverage as well as binding',()=>{
 for(const [axis,check]of [['execution','stage_completion'],['structure','operation_aggregate_consistency'],['translationRuleQa','bound_translation_input'],['userApproval','explicit_user_action']]){
  const a=assessment();a.dimensions[axis].evidence.coverage=a.dimensions[axis].evidence.coverage.filter(x=>x!==check);
  const r=decide(a);assert.equal(r.dimensions[axis].status,'NEEDS_REVIEW',axis);assert.equal(r.releaseRecommendation.status,'NEEDS_REVIEW');
 }
});
test('a failure before a final PNG exists can retain its independent unmeasured dimensions',()=>{
 const a=assessment();a.finalArtifactId=null;a.artifacts=[];
 for(const axis of axes)a.dimensions[axis]={status:'NOT_MEASURED',reason:'NO_RESULT_ARTIFACT',evidence:null};
 a.dimensions.execution={status:'FAIL',reason:'OCR_INITIALIZATION_FAILED',evidence:{...assessment().dimensions.execution.evidence,subjectArtifactId:'state',subjectSha256:'c'.repeat(64)}};
 a.artifacts=[{artifactId:'state',sha256:'c'.repeat(64)}];
 const r=decide(a);assert.equal(r.releaseRecommendation.status,'FAIL');assert.equal(r.qualityStatus,'NOT_MEASURED');assert.equal(r.dimensions.independentSemantic.status,'NOT_MEASURED');assert.equal(r.manualReviewAvailable,true);
});
test('missing final image prevents release PASS without preventing a pre-run assessment',()=>{
 const a=assessment();a.finalArtifactId=null;a.artifacts=[];
 for(const axis of axes)a.dimensions[axis]={status:'NOT_MEASURED',reason:'NOT_RUN',evidence:null};
 const r=decide(a);assert.equal(r.releaseRecommendation.status,'BLOCKED');assert.ok(r.coverageGaps.includes('final_artifact_missing'));
});
test('the weaker reviewed draft cannot be interpreted as the final policy version',()=>{
 available('validateQualityPolicy');const p=load();p.policyVersion='stage08-v1';assert.throws(()=>api.validateQualityPolicy(p),{code:'INVALID_QUALITY_POLICY'});
});
test('self QA or AI review cannot attest the current human semantic requirement',()=>{
 const a=assessment();a.dimensions.independentSemantic.evidence.actor='ai';
 const r=decide(a);assert.equal(r.dimensions.independentSemantic.status,'NEEDS_REVIEW');assert.equal(r.releaseRecommendation.status,'NEEDS_REVIEW');
 a.dimensions.humanReview.evidence.actor='ai';assert.equal(decide(a).dimensions.humanReview.status,'NEEDS_REVIEW');
});
test('one-person partial review cannot satisfy Stage05 human_verified',()=>{
 const a=assessment();a.dimensions.independentSemantic.evidence.humanVerification='human_partial';assert.equal(decide(a).releaseRecommendation.status,'NEEDS_REVIEW');
});
test('stale revision, cross-owner, modified bytes or wrong final artifact invalidate approval',()=>{
 for(const mutate of [a=>a.dimensions.userApproval.evidence.identity.editRevision++,a=>a.dimensions.imageQuality.evidence.identity.ownerId='other',a=>a.dimensions.humanReview.evidence.subjectSha256='c'.repeat(64),a=>{a.dimensions.independentSemantic.evidence.subjectArtifactId='ocr';a.dimensions.independentSemantic.evidence.subjectSha256='b'.repeat(64);}]){
  const a=assessment();mutate(a);assert.throws(()=>decide(a),{code:'POLICY_EVIDENCE_BINDING_MISMATCH'});
 }
});
test('unknown current revisions cannot authorize a current approval binding',()=>{
 const a=assessment();a.identity.editRevision=null;for(const d of Object.values(a.dimensions))d.evidence.identity.editRevision=null;
 assert.throws(()=>decide(a),{code:'POLICY_CURRENT_IDENTITY_INCOMPLETE'});
});
test('missing dimension, invented state and PASS without evidence fail the input contract',()=>{
 available('evaluateQualityGates');
 for(const mutate of [a=>delete a.dimensions.userApproval,a=>a.dimensions.ocr.status='UNKNOWN',a=>a.dimensions.ocr.evidence=null]){
  const a=assessment();mutate(a);assert.throws(()=>decide(a));
 }
});
for(const severity of ['Critical','Major','Minor'])test('confirmed '+severity+' finding prevents automatic acceptance',()=>{
 const a=assessment();a.findings.push({id:'finding',type:'dialogue_omission',dimension:'independentSemantic',severity,confirmed:true,evidence:a.dimensions.independentSemantic.evidence,targetIds:['line-1'],impact:'Source content is missing',scope:'target'});
 const r=decide(a);assert.equal(r.releaseRecommendation.status,severity==='Minor'?'NEEDS_REVIEW':'FAIL');assert.equal(r.automaticDelivery.enabled,false);
 assert.equal(r.dimensions.independentSemantic.status,severity==='Minor'?'NEEDS_REVIEW':'FAIL');
});
test('severity is not guessed for uncertain findings',()=>{
 const a=assessment();a.findings.push({id:'uncertain',type:'source_residue',dimension:'imageQuality',severity:null,confirmed:false,evidence:null,targetIds:['roi-1'],impact:'Not independently adjudicated',scope:'region'});
 const r=decide(a);assert.equal(r.releaseRecommendation.status,'NEEDS_REVIEW');assert.equal(r.findings[0].severity,null);
 a.findings[0].confirmed=true;assert.throws(()=>decide(a),{code:'POLICY_FINDING_EVIDENCE_REQUIRED'});
});
test('synthetic or historical claims cannot certify real product delivery',()=>{
 for(const evidenceKind of ['synthetic','saved_record']){const a=assessment();a.evidenceKind=evidenceKind;assert.equal(decide(a).releaseRecommendation.status,'BLOCKED');}
});
test('defect escape, accepted defect proportion, false alarm and false discovery use distinct denominators',()=>{
 available('calculatePolicyMetric');const c={TP:3,FP:1,FN:2,TN:6};
 for(const [id,value,denominator]of [['precision',.75,4],['recall',.6,5],['f1',2/3,9],['defect_escape',.4,5],['defective_among_accepted',.25,8],['false_positive',1/7,7],['false_discovery',.25,4]]){
  const r=api.calculatePolicyMetric(load(),id,c);assert.equal(r.value,value,id);assert.equal(r.denominator,denominator,id);
 }
});
test('micro CER keeps insertion errors over 100 percent and uses pooled counts',()=>{
 available('calculatePolicyMetric');assert.equal(api.calculatePolicyMetric(load(),'micro_cer',{characterErrors:3,referenceCharacters:2}).value,1.5);
 assert.equal(api.calculatePolicyMetric(load(),'micro_cer',{characterErrors:2,referenceCharacters:10}).value,.2);
});
test('zero denominator, absent GT, and partial observation remain explicit unknown states',()=>{
 available('calculatePolicyMetric');
 const zero=api.calculatePolicyMetric(load(),'recall',{TP:0,FN:0});assert.equal(zero.value,null);assert.equal(zero.reason,'ZERO_DENOMINATOR');assert.equal(zero.numerator,0);
 const missing=api.calculatePolicyMetric(load(),'recall',{TP:null,FN:null});assert.equal(missing.value,null);assert.equal(missing.status,'NOT_MEASURED');assert.equal(missing.reason,'MISSING_COUNTS_OR_GT');
 const partial=api.calculatePolicyMetric(load(),'recall',{TP:9,FN:1},{coverage:'partial'});assert.equal(partial.value,null);assert.equal(partial.observedSubsetValue,.9);assert.equal(partial.reason,'PARTIAL_OBSERVATION');
 const cer=api.calculatePolicyMetric(load(),'micro_cer',{characterErrors:1,referenceCharacters:0});assert.equal(cer.numerator,1);assert.equal(cer.value,null);
});
test('inconsistent rates, negative counts and review counts in a binary denominator are rejected',()=>{
 available('calculatePolicyMetric');assert.throws(()=>api.calculatePolicyMetric(load(),'automatic_delivery',{automaticDelivered:2,eligiblePages:1}));
 assert.throws(()=>api.calculatePolicyMetric(load(),'recall',{TP:-1,FN:2}));
 assert.throws(()=>api.calculatePolicyMetric(load(),'recall',{TP:1,FN:0,review:3}));
 assert.throws(()=>api.calculatePolicyMetric(load(),'automatic_delivery',{automaticDelivered:1,eligiblePages:0}));
});
test('first try, retry success, audit errors and data availability never share a convenient denominator',()=>{
 available('calculatePolicyMetric');
 for(const [id,counts,want]of [
  ['first_correct_automatic',{firstCorrectAutomatic:1,eligiblePages:10},.1],
  ['retry_success',{verifiedRetrySuccess:1,eligibleRetriedPages:2},.5],
  ['automatic_delivery_audit_error',{auditedMajorCritical:1,auditedAutomaticDelivered:4},.25],
  ['evaluation_availability',{evaluablePages:3,eligiblePages:10},.3],
  ['synthetic_detection_coverage',{detectedSyntheticDefects:18,oracleSyntheticDefects:55},18/55],
 ])assert.equal(api.calculatePolicyMetric(load(),id,counts).value,want);
});
function requests(){const r=id=>({id,requestId:'shared-1',requestScope:'page',durationMs:20,modelHttpRequests:id==='line-1'?1:0,inputTokens:10,outputTokens:4,observedApiCost:{value:.25,currency:'USD',scope:'product_api'}});
 return {records:[r('line-1'),r('line-2')],pageRequests:[{requestId:'shared-1',httpRequests:1,regionIds:['line-1','line-2']}]};}
const correctTotals={uniqueRequests:1,requestDurationMs:{value:20,unit:'ms',reason:null},modelCalls:{value:1,unit:'count',reason:null},inputTokens:{value:10,unit:'tokens',reason:null},outputTokens:{value:4,unit:'tokens',reason:null},apiCost:{value:.25,unit:'USD',reason:null,scope:'product_api'}};
test('shared request duration, tokens and cost are counted once then compared to reported totals',()=>{
 available('validateRequestAggregate');const x=requests();assert.equal(api.validateRequestAggregate({...x,reported:correctTotals}).apiCost.value,.25);
 const wrong=structuredClone(correctTotals);wrong.apiCost.value=.5;assert.throws(()=>api.validateRequestAggregate({...x,reported:wrong}),{code:'POLICY_OPERATION_AGGREGATE_MISMATCH'});
 for(const key of ['requestDurationMs','inputTokens','outputTokens','modelCalls']){const y=structuredClone(correctTotals);y[key].value*=2;assert.throws(()=>api.validateRequestAggregate({...x,reported:y}),{code:'POLICY_OPERATION_AGGREGATE_MISMATCH'});}
});
test('conflicting duplicate requests and unknown costs cannot be silently resolved to zero',()=>{
 available('validateRequestAggregate');const x=requests();x.records[1].inputTokens=99;assert.throws(()=>api.validateRequestAggregate({...x,reported:correctTotals}),{code:'CONFLICTING_REQUEST_MEASUREMENTS'});
 const empty={records:[],pageRequests:[],reported:correctTotals};assert.throws(()=>api.validateRequestAggregate(empty),{code:'POLICY_OPERATION_AGGREGATE_MISMATCH'});
 const unknown=requests();unknown.records.forEach(r=>r.observedApiCost=null);const zero=structuredClone(correctTotals);zero.apiCost.value=0;
 assert.throws(()=>api.validateRequestAggregate({...unknown,reported:zero}),{code:'POLICY_OPERATION_AGGREGATE_MISMATCH'});
});
