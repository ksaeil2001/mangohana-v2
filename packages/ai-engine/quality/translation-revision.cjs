'use strict';
// Pure candidate planning/comparison only. No inference, store adapter or retry.
const {createHash}=require('node:crypto');
const {validateTranslationBatch}=require('./translation-contract.cjs');
const {assertKoreanOutputBatch}=require('./korean-output.cjs');
const VERSION='stage14r3-selective-v1',MAX_ATTEMPTS=2;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const must=(ok,code='TRANSLATION_RESPONSE_INVALID')=>{if(!ok)throw Object.assign(Error('선택 번역의 원문·문맥·이전 후보·시도 한도를 확인해야 합니다. 기존 후보는 보존했습니다.'),{code});};
function planSelectiveTranslation({input,previousResults,regionIds,attempt,currentContextRevision=input.context.revision,ownedRegionIds=[]}){
 const {fingerprint,...unsigned}=input;must(fingerprint===hash(unsigned),'TRANSLATION_IDENTITY_INVALID');
 must(Number.isSafeInteger(attempt)&&attempt>=1&&attempt<=MAX_ATTEMPTS);
 must(Array.isArray(regionIds)&&regionIds.length>0&&new Set(regionIds).size===regionIds.length&&regionIds.every(id=>input.regions.some(r=>r.id===id)));
 must(Array.isArray(ownedRegionIds)&&!regionIds.some(id=>ownedRegionIds.includes(id)));
 must(!input.regions.some(r=>r.userTranslation!==undefined)||!input.regions.some(r=>regionIds.includes(r.id)&&r.userTranslation!==undefined));
 must(Array.isArray(previousResults)&&!previousResults.some(r=>regionIds.includes(r.id)&&(r.userTranslation!==undefined||['USER_CONFIRMED','USER_MODIFIED'].includes(r.status))));
 validateTranslationBatch({input,results:previousResults,currentContextRevision});
 const regions=input.regions.filter(r=>regionIds.includes(r.id));
 const selected={...structuredClone(unsigned),regions:structuredClone(regions),pageContext:structuredClone(input.pageContext??input.regions),parentInputFingerprint:fingerprint};
 selected.fingerprint=hash(selected);
 return {version:VERSION,attempt,maximumAttempts:MAX_ATTEMPTS,automaticRetry:false,regionIds:regions.map(r=>r.id),parentInputFingerprint:fingerprint,previousResultsFingerprint:hash(previousResults),contextRevision:input.context.revision,input:selected,applied:false,executionAuthorized:false};
}
function reviewSelectiveReplacement({plan,input,previousResults,replacementResults,currentContextRevision=input.context.revision,ownedRegionIds=[]}){
 const expected=planSelectiveTranslation({input,previousResults,regionIds:plan.regionIds,attempt:plan.attempt,currentContextRevision,ownedRegionIds});
 // CAS ticket binds the complete prior candidate set, full context, attempt and
 // exact subset. A stale/forged plan cannot choose a new source of authority.
 must(hash(expected)===hash(plan),'TRANSLATION_CONTEXT_STALE');
 const preserved=reasons=>({version:VERSION,status:'REJECTED_PRESERVED',reasons,candidates:structuredClone(previousResults),applied:false,executionAuthorized:false,automaticRetry:false,humanSemanticVerified:null,semanticAccuracy:null});
 try{
  must(Array.isArray(replacementResults)&&!replacementResults.some(r=>r.userTranslation!==undefined||['USER_CONFIRMED','USER_MODIFIED'].includes(r.status)));
  const subset=validateTranslationBatch({input:plan.input,results:replacementResults,currentContextRevision});assertKoreanOutputBatch(subset);
  const before=validateTranslationBatch({input,results:previousResults,currentContextRevision}),reasons=[];
  for(const row of subset){
   const prior=before.find(r=>r.id===row.id),codes=new Set(prior.semantic.signals.map(s=>s.code));
   for(const signal of row.semantic.signals)if(!codes.has(signal.code))reasons.push({id:row.id,code:'NEW_RISK',signal:signal.code});
   const oldErrors=new Set((prior.qaReport?.issues??[]).filter(x=>x.severity==='error').map(x=>x.type));
   for(const issue of row.qaReport?.issues??[])if(issue.severity==='error'&&!oldErrors.has(issue.type))reasons.push({id:row.id,code:'NEW_QA_ERROR',issue:issue.type});
  }
  if(reasons.length)return preserved(reasons);
  const candidates=previousResults.map(r=>structuredClone(replacementResults.find(n=>n.id===r.id)??r));
  const validated=validateTranslationBatch({input,results:candidates,currentContextRevision});assertKoreanOutputBatch(validated);
  return {version:VERSION,status:'UNREVIEWED_CANDIDATE_SET',candidates,validation:validated.map(r=>({id:r.id,semantic:r.semantic})),applied:false,executionAuthorized:false,automaticRetry:false,humanSemanticVerified:null,semanticAccuracy:null,qualityComparison:'LIMITED_RULE_NONREGRESSION_NOT_SEMANTIC_APPROVAL'};
 }catch(error){return preserved([{code:error.code??'TRANSLATION_RESPONSE_INVALID',outputCompliance:error.outputCompliance??null}]);}
}
module.exports={VERSION,MAX_ATTEMPTS,planSelectiveTranslation,reviewSelectiveReplacement};
