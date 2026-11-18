import { equal, measurement, requireValue, ratio, VERSION } from './contract.mjs';
import { aggregateOperations } from './operations.mjs';

/** Validate exported state/measurement relationships, including null versus zero. */
export function validateOfflineReport(report) {
  requireValue(report?.schemaVersion===1 && report.evaluatorVersion===VERSION && Array.isArray(report.pages),'INVALID_OFFLINE_REPORT');
  const ids=new Set();
  for(const p of report.pages) {
    requireValue(!ids.has(p.pageId),'DUPLICATE_REPORT_PAGE');ids.add(p.pageId);
    requireValue(['succeeded','failed','interrupted','running','not_run','unknown'].includes(p.processing.status),'INVALID_REPORT_PROCESSING');
    requireValue(p.execution.productExecutionVerified===false,'UNSUPPORTED_PRODUCT_CERTIFICATION');
    requireValue(p.deliveryEligibility?.status==='review_required','UNREVIEWED_DELIVERY_PROMOTED');
    if(p.ocrMeasurement.status==='NOT_MEASURED')requireValue(p.ocr===null && typeof p.ocrMeasurement.reason==='string','UNMEASURED_OCR_PROMOTED');
    if(p.semantic.majorCriticalErrors.value!==null)requireValue(p.humanReview.status==='completed' && p.semantic.opinionOrigin==='human_submitted_review','UNMEASURED_QUALITY_PROMOTED');
    if(p.image?.insideArtworkDamage.value!==null && p.image?.insideArtworkDamage!==undefined)requireValue(p.imageLabels.some(e=>e.confirmed && e.type==='inside_artwork_damage'),'UNMEASURED_QUALITY_PROMOTED');
    if(p.common?.document)requireValue(p.common.document.identity.jobId===p.identity.jobId,'REPORT_COMMON_IDENTITY_MISMATCH');
  }
  const qualityUnknown=report.pages.length===0 || report.pages.some(p=>p.semantic.majorCriticalErrors.value===null || p.image?.insideArtworkDamage?.value==null);
  requireValue(report.states?.QUALITY_NOT_MEASURED===qualityUnknown,'UNMEASURED_QUALITY_PROMOTED');
  // These aggregates are derivable from the submitted pages, unlike raw request cost receipts.
  const expectedOperations=aggregateOperations(report.pages);
  for(const key of ['recordedSuccess','recordedFirstAttemptSuccessRate','recordedAfterRetrySuccessRate','recordedAfterManualEditSuccessRate'])
    requireValue(equal(report.summary?.[key],expectedOperations[key]),'REPORT_OPERATION_AGGREGATE_MISMATCH');
  for(const key of ['verifiedFirstAttemptSuccessRate','verifiedCorrectAutomaticCompletionRate'])
    requireValue(report.summary?.[key]?.numerator===null && report.summary?.[key]?.denominator===null && report.summary?.[key]?.value===null,'UNSUPPORTED_PRODUCT_CERTIFICATION');
  const visit=value=>{
    if(!value || typeof value!=='object')return;
    if(Object.hasOwn(value,'value') && Object.hasOwn(value,'unit') && Object.hasOwn(value,'reason'))measurement({value:value.value,unit:value.unit,reason:value.reason});
    if(Object.hasOwn(value,'numerator') && Object.hasOwn(value,'denominator') && Object.hasOwn(value,'value') && Object.hasOwn(value,'reason')) {
      const expected=ratio(value.numerator,value.denominator,value.reason);requireValue(value.value===expected.value && value.reason===expected.reason,'INVALID_REPORT_RATIO');
    }
    Object.values(value).forEach(visit);
  };
  visit(report);
  return report;
}
