'use strict';

// Processing, human review and settlement are separate facts. Old jobs have no reviewState.
function pageReviewState(job) {
  if (!job) return 'NOT_STARTED';
  if (job.status === 'result_unknown' || job.stage === 'cleanup_unconfirmed' ||
      job.stage === 'retry_acceptance_unknown' || job.errorCode === 'RESULT_UNKNOWN') return 'RESULT_UNKNOWN';
  if (job.status === 'queued') return 'NOT_STARTED';
  if (job.status === 'running') return 'RUNNING';
  if (job.status === 'completed') return 'CANDIDATE_READY';
  if (job.errorCode === 'PARTIAL_TYPESETTING') return 'PARTIAL';
  if (job.recovery?.type === 'needs_review' ||
      ['OCR_EMPTY','OCR_INCOMPLETE','NO_TRANSLATABLE_REGIONS','OCR_REVIEW_REQUIRED','PAGE_TRANSLATION_INVALID'].includes(job.errorCode))
    return 'NEEDS_REVIEW';
  if (job.status === 'failed' && (job.checkpoints?.translation || job.checkpoints?.cleaned)) return 'PARTIAL';
  return 'FAILED';
}

module.exports = {pageReviewState};
