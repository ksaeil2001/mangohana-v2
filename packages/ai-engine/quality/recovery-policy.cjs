'use strict';
// Stage08 automatic retry stays disabled. Every user retry is a new immutable job.
const MAX_ATTEMPTS=3;
const review=new Set(['OCR_REVIEW_REQUIRED','OCR_REFINEMENT_AMBIGUOUS','NO_TRANSLATABLE_REGIONS','TRANSLATION_CONTEXT_STALE','TRANSLATION_RESPONSE_INVALID','PAGE_TRANSLATION_INVALID','TRANSLATION_MISSING','TRANSLATION_NUMBER_MISMATCH','STALE_RESULT','CONTEXT_REEVALUATION_REQUIRED','CONTEXT_FRESHNESS_UNKNOWN','PARTIAL_TYPESETTING','SOURCE_RESIDUE_SUSPECTED']);
const transient=new Set(['OCR_UNAVAILABLE','ENGINE_UNAVAILABLE','TRANSLATION_PROVIDER_UNAVAILABLE','LLM_START_FAILED','LLM_START_TIMEOUT','OCR_TIMEOUT','TRANSLATION_TIMEOUT','TRANSLATION_ITEM_TIMEOUT','INPAINT_TIMEOUT','TYPESET_TIMEOUT','REGION_DETECTOR_TIMEOUT','TEXT_MASK_TIMEOUT']);
const unsafe=new Set(['CLEANUP_FAILED','RUNTIME_LEASE_BLOCKED','CHECKPOINT_INVALID','SOURCE_CHANGED','SOURCE_INTEGRITY_FAILED','INTEGRITY_FAILED','LLM_AUTH_UNSUPPORTED','RETRY_COMMIT_UNKNOWN','CANCELLED','INTERRUPTED','RAM_LIMIT','HOST_MEMORY_PRESSURE']);
const input=new Set(['IMAGE_BYTES','IMAGE_LIMIT','IMAGE_FORMAT','IMAGE_MIME','INVALID_IMAGE','ANIMATED_IMAGE','OCR_INCOMPLETE','OCR_EMPTY','OCR_REFINEMENT_INVALID','OCR_REFINEMENT_STALE','OCR_REFINEMENT_RESPONSE_INVALID','TRANSLATION_ID','TRANSLATION_RESULT','TRANSLATION_IDENTITY_INVALID','TRANSLATION_CONTEXT_INVALID','TRANSLATION_INPUT_LIMIT','INPAINT_RESPONSE','INPAINT_PIXELS','TYPESET_ALPHA','TYPESET_RESULT','OUTPUT_INVALID','TEXT_MASK_INVALID','MASK_INVALID','REGION_DETECTOR_RESULT','REGION_SELECTION_INVALID','PROCESS_RESTART_REQUIRED','OUTPUT_EXISTS','ENGINE_FAILED','PROCESSING_FAILED']);
function classifyFailure(error){
 const raw=error?.cleanupUncertain===true?'CLEANUP_FAILED':error?.code,code=[review,transient,unsafe,input].some(s=>s.has(raw))?raw:raw==='ENOENT'?'OUTPUT_INVALID':'PROCESSING_FAILED';
 const cleanup=['CLEANUP_FAILED','RUNTIME_LEASE_BLOCKED'].includes(code);
 return {code,type:cleanup?'cleanup_unknown':review.has(code)?'needs_review':transient.has(code)?'transient_execution':unsafe.has(code)?'unsafe_to_repeat':'permanent_or_unclassified',severity:cleanup?'critical':'error',
  stage:cleanup?'cleanup_unconfirmed':review.has(code)?'needs_review':'failed',sourceRegion:null,evidence:{code},confidence:'code_contract',recommended_action:cleanup?'recover_runtime_owner':review.has(code)?'review_input_and_explicit_retry':'inspect_before_explicit_retry',
  automaticRetry:false,automaticAttempts:0,maximumAttempts:MAX_ATTEMPTS,manuallyRetryable:!unsafe.has(code)&&code!=='PARTIAL_TYPESETTING',monetaryCost:null};
}
module.exports={MAX_ATTEMPTS,classifyFailure};
