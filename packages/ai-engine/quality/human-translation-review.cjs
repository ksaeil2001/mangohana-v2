'use strict';
// Trusted controller contract. A downloaded JSON is never an authentication or execution authority.
const {createHash}=require('node:crypto');
const sha=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const clone=x=>structuredClone(x),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const text=x=>typeof x==='string'&&x.trim().length>0&&x.length<=4000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const counter=x=>Number.isSafeInteger(x)&&x>=0;
function must(ok,code='HUMAN_REVIEW_BINDING_INVALID'){if(!ok)throw Object.assign(Error('검수 원본·후보·사용자 revision 또는 승인 근거가 일치하지 않습니다.'),{code});}
function packetHash(packet){const {packetSha256,...unsigned}=packet;return sha(unsigned);}
function submissionHash(submission){return sha(submission);}

function inspectSubmission(packet,submission){
 must(packet?.packetSha256===packetHash(packet)&&packet.status==='HUMAN_REVIEW_PENDING');
 must(submission?.schemaVersion==='stage14r2-human-submission-v1'&&submission.humanApprovalVerified===false);
 const s=packet.scope,b=packet.bindings,e=submission.stage14r3;
 must(e?.version==='stage14r3-review-extension-v1'&&e.executionAuthorized===false&&e.independentGroundTruthVerified===false&&counter(e.revision));
 for(const k of ['pageId','projectId','owner','sourceSha256'])must(submission[k]===s[k]);
 must(submission.packetSha256===packet.packetSha256&&same(submission.bindings,b));
 must(Array.isArray(packet.regions)&&packet.regions.length>0&&packet.regions.length<=128&&same(packet.allRegionIds,packet.regions.map(r=>r.regionId))&&new Set(packet.allRegionIds).size===packet.regions.length);
 must(Array.isArray(submission.regions)&&submission.regions.length===packet.regions.length&&new Set(submission.regions.map(r=>r?.regionId)).size===packet.regions.length);
 must(typeof submission.reviewer==='string'&&submission.reviewer.length<=200&&(submission.submittedAt===null||typeof submission.submittedAt==='string'&&Number.isFinite(Date.parse(submission.submittedAt))));
 const rows=packet.regions.map(bound=>{
  const row=submission.regions.find(r=>r?.regionId===bound.regionId);must(!!row);
  for(const key of ['pageId','regionId','sourceText','translatedText','sourceTextSha256','translationSha256'])must(row[key]===bound[key]);
  must(bound.sourceTextSha256===sha(bound.sourceText)&&bound.translationSha256===sha(bound.translatedText));
  must(row.decision===null||['ACCEPT_AS_IS','CORRECT_TRANSLATION','OCR_CORRECTION_REQUIRED','NEEDS_MORE_CONTEXT','REJECT'].includes(row.decision));
  must(counter(row.editRevision)&&Array.isArray(row.checkedScope)&&row.checkedScope.every(text)&&typeof row.remainingUncertainties==='string'&&row.remainingUncertainties.length<=4000);
  const riskCodes=[...new Set((bound.signals??[]).map(s=>s.code))];
  must(Array.isArray(row.riskDecisions)&&same(row.riskDecisions.map(r=>r.code),riskCodes));
  for(const risk of row.riskDecisions)must([null,'ACCEPT_THIS_SENTENCE','UNRESOLVED'].includes(risk.decision)&&typeof risk.rationale==='string'&&risk.rationale.length<=4000);
  must(row.correctedTranslation==null||row.decision==='CORRECT_TRANSLATION');must(row.correctedOcr==null||row.decision==='OCR_CORRECTION_REQUIRED');
  if(row.decision==='CORRECT_TRANSLATION')must(text(row.correctedTranslation));
  if(row.decision==='OCR_CORRECTION_REQUIRED')must(text(row.correctedOcr));
  const selected=row.decision==='ACCEPT_AS_IS'?bound.translatedText:row.decision==='CORRECT_TRANSLATION'?row.correctedTranslation:null;
  must(row.selectedTranslation===selected);
  must(selected===null?row.selectionOrigin===null:['MODEL_CANDIDATE','AI_SUGGESTION_ADOPTED','USER_EDIT'].includes(row.selectionOrigin));
  if(row.decision==='ACCEPT_AS_IS')must(row.selectionOrigin==='MODEL_CANDIDATE');
  if(row.selectionOrigin==='AI_SUGGESTION_ADOPTED')must(selected===bound.analysis?.suggestedTranslation);
  const complete=row.decision!==null&&row.confirmedByHuman===true&&text(row.rationale)&&text(submission.reviewer)&&typeof submission.submittedAt==='string';
  return {...clone(row),complete};
 });
 const completed=rows.filter(r=>r.complete).length,status=completed===rows.length?'HUMAN_SUBMISSION_UNVERIFIED':'HUMAN_REVIEW_PENDING';
 must(submission.status===status,'HUMAN_REVIEW_STATE_INVALID');
 return {status,completed,regions:rows,humanApprovalVerified:false,executionAuthorized:false,independentGroundTruthVerified:false};
}

/** No mutation, no I/O, no inference. Only the caller can authenticate the actual user event. */
function applyHumanTranslationReview({packet,submission,authority,current,lines}){
 must(authority?.kind==='USER_TRANSLATION_APPLICATION','HUMAN_REVIEW_AUTHORITY_REQUIRED');
 const inspected=inspectSubmission(packet,submission),s=packet.scope,b=packet.bindings;
 must(inspected.completed===packet.regions.length&&submission.stage14r3.applicationApprovalRequested===true&&text(submission.stage14r3.reviewScope));
 must(authority.packetSha256===packet.packetSha256&&authority.submissionSha256===submissionHash(submission)&&authority.reviewer===submission.reviewer&&text(authority.evidenceId)&&typeof authority.approvedAt==='string'&&Number.isFinite(Date.parse(authority.approvedAt)),'HUMAN_REVIEW_AUTHORITY_REQUIRED');
 for(const k of ['projectId','pageId','sourceSha256','pageNumber'])must(current?.[k]===s[k]);
 must(current.ownerScope===s.owner&&current.normalizedSha256===b.normalizedSha256&&current.candidateSetSha256===b.candidateSetSha256&&hex(b.candidateSetSha256)&&hex(b.normalizedSha256));
 must(counter(b.baseEditRevision)&&counter(b.processingGeneration)&&current.editRevision===b.baseEditRevision&&current.processingGeneration===b.processingGeneration,'HUMAN_REVIEW_REVISION_CONFLICT');
 if(b.contextRevision!==undefined)must(current.contextRevision===b.contextRevision,'HUMAN_REVIEW_REVISION_CONFLICT');
 must(Array.isArray(lines)&&lines.length===packet.regions.length&&new Set(lines.map(l=>l?.id)).size===lines.length);
 const selections=packet.regions.map(r=>{
  const row=inspected.regions.find(x=>x.regionId===r.regionId),line=lines.find(l=>l.id===r.regionId);
  must(line&&line.sourceText===r.sourceText&&line.pageNumber===s.pageNumber&&line.order===r.order&&same(line.sourceLineIds??[],r.sourceLineIds??[]));
  must(['ACCEPT_AS_IS','CORRECT_TRANSLATION'].includes(row.decision)&&text(row.selectedTranslation),'HUMAN_REVIEW_UNRESOLVED');
  must(row.riskDecisions.every(r=>r.decision==='ACCEPT_THIS_SENTENCE'&&text(r.rationale)),'HUMAN_REVIEW_RISK_UNRESOLVED');
  must(line.userTranslation===undefined||line.userTranslation===row.selectedTranslation,'HUMAN_REVIEW_REVISION_CONFLICT');
  must(line.aiTranslation===undefined||line.aiTranslation===r.translatedText);
  return {regionId:r.regionId,sourceText:r.sourceText,sourceLineIds:clone(r.sourceLineIds??[]),aiTranslation:r.translatedText,userTranslation:row.selectedTranslation,
   origin:r.origin,selectionOrigin:row.selectionOrigin,editRevision:row.editRevision,rationale:row.rationale,checkedScope:clone(row.checkedScope),remainingUncertainties:row.remainingUncertainties,
   riskDecisions:clone(row.riskDecisions),selectedTranslationSha256:sha(row.selectedTranslation)};
 });
 // Only construct replacements after every row and authority has been checked.
 const next=lines.map(line=>{const v=selections.find(r=>r.regionId===line.id);return {...clone(line),aiTranslation:v.aiTranslation,userTranslation:v.userTranslation};});
 const renderLines=next.map(line=>{const out={...clone(line),aiTranslation:line.userTranslation};delete out.userTranslation;return out;});
 const receipt={version:'stage14r3-human-application-v1',status:'USER_APPROVED_PAGE_TRANSLATIONS',packetSha256:packet.packetSha256,candidateSetSha256:b.candidateSetSha256,submissionSha256:authority.submissionSha256,
  scope:clone(s),normalizedSha256:b.normalizedSha256,baseEditRevision:b.baseEditRevision,processingGeneration:b.processingGeneration,reviewer:authority.reviewer,approvedAt:authority.approvedAt,evidenceId:authority.evidenceId,
  reviewRevision:submission.stage14r3.revision,reviewScope:submission.stage14r3.reviewScope,remainingUncertainties:submission.stage14r3.remainingUncertainties,
  humanApplicationApproved:true,independentGroundTruthVerified:false,independentSemanticEvaluation:null,executionAuthorized:false,
  renderProjection:'USER_TRANSLATION_TO_EXISTING_CANDIDATE_RENDERER',selections};
 receipt.receiptSha256=sha(receipt);
 return {lines:next,renderLines,receipt};
}
function assertReviewExecution(permit,current,receipt){
 must(permit?.kind==='USER_SINGLE_PAGE_EXECUTION'&&text(permit.evidenceId)&&permit.packetSha256===receipt.packetSha256&&permit.submissionSha256===receipt.submissionSha256&&permit.outputDirectory===current.outputDirectory&&permit.maxPages===1&&permit.maxRuns===1,'HUMAN_REVIEW_EXECUTION_REQUIRED');
 return true;
}
function requireReviewedOcr(reviewed,saved){must(!reviewed||!!saved,'HUMAN_REVIEW_OCR_CHECKPOINT_REQUIRED');}
async function resolveEngineReview({resolve,snapshot,lines,phase,previousReceipt}){
 must(typeof resolve==='function','HUMAN_REVIEW_AUTHORITY_REQUIRED');
 const bundle=await resolve({phase,snapshot:clone(snapshot)});must(bundle&&bundle.current);
 for(const k of ['ownerScope','projectId','pageId','pageNumber','sourceSha256','normalizedSha256','candidateSetSha256','editRevision','processingGeneration','contextRevision'])must(bundle.current[k]===snapshot[k],'HUMAN_REVIEW_REVISION_CONFLICT');
 const draftLines=lines??bundle.packet?.regions?.map(r=>({id:r.regionId,sourceText:r.sourceText,sourceLineIds:r.sourceLineIds,order:r.order,pageNumber:bundle.packet.scope.pageNumber}));
 const out=applyHumanTranslationReview({...bundle,lines:draftLines});assertReviewExecution(bundle.executionAuthority,snapshot,out.receipt);
 if(previousReceipt)must(out.receipt.receiptSha256===previousReceipt.receiptSha256,'HUMAN_REVIEW_REVISION_CONFLICT');
 return out;
}
function assertReviewedReport(report){
 const r=report.humanTranslationReview;must(r?.version==='stage14r3-human-application-v1'&&r.humanApplicationApproved===true&&r.independentGroundTruthVerified===false&&r.executionAuthorized===false);
 const {receiptSha256,...unsigned}=r;must(receiptSha256===sha(unsigned)&&hex(receiptSha256));
 must(r.scope.sourceSha256===report.hashes.original&&r.normalizedSha256===report.hashes.normalized&&report.manualCorrections===r.selections.length);
 must(Array.isArray(report.lines)&&report.lines.length===r.selections.length&&new Set(report.lines.map(l=>l.id)).size===r.selections.length);
 for(const line of report.lines){const s=r.selections.find(s=>s.regionId===line.id);must(s&&s.sourceText===line.sourceText&&s.aiTranslation===line.aiTranslation&&s.userTranslation===line.userTranslation&&same(s.sourceLineIds,line.sourceLineIds??[]));}
 return r;
}
function assertReviewedRisks(receipt,validated){
 for(const row of validated){const selected=receipt.selections.find(r=>r.regionId===row.id);must(selected&&sha(row.translatedText)===selected.selectedTranslationSha256);
  for(const signal of row.semantic?.signals??[])must(selected.riskDecisions.some(r=>r.code===signal.code&&r.decision==='ACCEPT_THIS_SENTENCE'&&text(r.rationale)),'HUMAN_REVIEW_RISK_UNRESOLVED');
 }
}
module.exports={packetHash,submissionHash,inspectSubmission,applyHumanTranslationReview,assertReviewExecution,requireReviewedOcr,assertReviewedReport,resolveEngineReview,assertReviewedRisks};
