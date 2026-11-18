import { loadOfflineEvidence } from './evidence.mjs';
import { adaptV2Page } from './v2-adapter.mjs';
import { evaluateOcrPages } from './ocr.mjs';
import { compareImagePixels, verifyImageMeasurementClaims, evaluateAssessment, evaluateTypesetting } from './quality.mjs';
import { readProcessing, readOperations, aggregateOperations } from './operations.mjs';
import { VERSION, measured, ratio, unknown } from './contract.mjs';
import { validateOfflineReport } from './report.mjs';
import path from 'node:path';
export { validateOfflineReport } from './report.mjs';

/** Stage05 human targets explicitly define the unit of final OCR comparison. */
export function stage02GroundTruth(page) {
  const a=page.annotation,pending=reason=>({groundTruth:{status:'pending'},reason});
  if(a.status!=='human_verified')return pending('HUMAN_GROUND_TRUTH_NOT_VERIFIED');
  if(a.basisImageSha256!==page.get('normalized').sha256)return pending('GT_AND_FINAL_OCR_PIXEL_BASIS_DIFFER');
  const lines=new Map(a.lines.map(l=>[l.lineId,l]));
  const relevant=a.lines.filter(l=>l.role!=='furigana' && l.processingIntent?.action!=='preserve');
  if(relevant.some(l=>l.transcription.status!=='readable' || l.readingOrder.status!=='verified' || l.readingOrder.value===null || !l.geometry))
    return pending('UNCERTAIN_SOURCE_OR_READING_ORDER_REQUIRES_EXPLICIT_PARTIAL_GT_ADAPTER');
  const seen=new Set(),regions=[];
  for(const target of a.translations) {
    const members=target.sourceLineIds.map(id=>lines.get(id));
    if(members.some(l=>!relevant.includes(l)) || members.length===0 || members.some(l=>seen.has(l.lineId)))return pending('GT_FINAL_OCR_GROUPING_NOT_UNAMBIGUOUS');
    members.forEach(l=>seen.add(l.lineId));members.sort((a,b)=>a.readingOrder.value-b.readingOrder.value);
    const points=members.flatMap(l=>l.geometry.polygon),xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
    const x=Math.min(...xs)/a.frame.width,y=Math.min(...ys)/a.frame.height,width=(Math.max(...xs)-Math.min(...xs))/a.frame.width,height=(Math.max(...ys)-Math.min(...ys))/a.frame.height;
    const translation=target.meaning?.acceptableKorean?.[0];if(typeof translation!=='string' || !translation.length)return pending('HUMAN_TARGET_MEANING_NOT_DEFINED');
    regions.push({id:target.targetId,text:members.map(l=>l.transcription.text).join(''),translation,bbox:{x,y,width,height},sourceOrder:members[0].readingOrder.value});
  }
  if(seen.size!==relevant.length)return pending('GT_FINAL_OCR_GROUPING_INCOMPLETE');
  regions.sort((a,b)=>a.sourceOrder-b.sourceOrder);
  return {groundTruth:{status:'verified',reviewer:a.reviews[0].reviewerId,reviewedAt:a.reviews[0].reviewedAt,
    regions:regions.map(({sourceOrder,...r},i)=>({...r,order:i+1}))},reason:null};
}

/** No model, provider, application runtime, database or publish path is imported. */
export async function evaluateOfflineRun(options) {
  const loaded=await loadOfflineEvidence(options),adapted=loaded.pages.map(p=>adaptV2Page(p,loaded.dataset));
  const groundTruth=loaded.pages.map(stage02GroundTruth);
  const selected=loaded.dataset.pages.filter(p=>p.split===loaded.descriptor.split),missing=selected.filter(p=>!loaded.pages.some(row=>row.pageId===p.pageId));
  const stage02=await evaluateOcrPages({runId:loaded.descriptor.runId,split:loaded.descriptor.split,workspace:options.workspace,
    pages:loaded.pages.map((p,i)=>({pageId:p.pageId,workId:p.datasetPage.workId,duplicateGroupId:p.datasetPage.duplicateGroupId,
      source:{path:p.get('normalized').file,sha256:p.get('normalized').sha256},groundTruth:groundTruth[i].groundTruth,finalOcr:adapted[i].finalOcr,evidenceKind:p.evidenceKind}))
      .concat(missing.map(p=>({pageId:p.pageId,workId:p.workId,duplicateGroupId:p.duplicateGroupId,source:{path:path.resolve(path.dirname(options.datasetPath),p.source.path),sha256:p.source.sha256},
        groundTruth:{status:'pending'},finalOcr:null,evidenceKind:'not_run'})))});
  const pages=[];
  for(let i=0;i<loaded.pages.length;i++) {
    const page=loaded.pages[i],projection=adapted[i],computed=stage02.pages[i],processing=readProcessing(page),operations=readOperations(page),quality=evaluateAssessment(page,loaded.dataset);
    const removal=page.get('removal_mask'),protection=page.get('protection_mask');
    const image=await compareImagePixels({source:page.get('normalized').bytes,cleaned:page.get('cleaned')?.bytes,
      removal:removal?.maskSemantics?{bytes:removal.bytes,encoding:removal.maskSemantics}:null,
      protection:protection?.maskSemantics?{bytes:protection.bytes,encoding:protection.maskSemantics}:null});
    verifyImageMeasurementClaims(page.report?.inpainting?.pixels,image);
    const source=page.get('source'),normalized=page.get('normalized');
    pages.push({pageId:page.pageId,split:loaded.descriptor.split,evidenceKind:page.evidenceKind,
      identity:page.binding,sourceHashes:{datasetEncodedSha256:page.datasetPage.source.sha256,inputFileSha256:source.sha256,normalizedFileSha256:normalized.sha256,
        stateClaimedSourceSha256:page.state?.sourceSha256??null,reportClaimedSourceSha256:page.report?.hashes?.original??null,
        refinementClaimedSourceSha256:page.get('refinement_plan')?.json?.sourceSha256??null,
        semantics:'ENCODED_FILE_BYTES_SEPARATE_FROM_LEGACY_NAMED_CLAIMS'},
      evidence:page.artifacts.size?[...page.artifacts.values()].map(a=>({artifactId:a.id,kind:a.kind,sha256:a.sha256,bytes:a.bytes.length,origin:a.origin,
        file:a.file,verified:true})):[],
      common:projection.common,lineage:projection.lineage,processing:{...processing,...Object.fromEntries(Object.entries(operations.resources??{}))},
      execution:{status:page.evidenceKind==='synthetic'?'synthetic':page.evidenceKind==='not_run'?'not_run':'saved_files_bound',
        productExecutionVerified:false,reason:page.evidenceKind==='synthetic'?'SYNTHETIC_EVIDENCE':'INDEPENDENT_RUNTIME_RECEIPT_NOT_AVAILABLE',
        completeRuntimeReceipt:false,modelExecutionAuthenticated:false},
      ocr:computed.ocr,ocrMeasurement:!projection.finalOcr?{status:'NOT_MEASURED',reason:'FINAL_OCR_NOT_AVAILABLE'}
        :groundTruth[i].reason?{status:'NOT_MEASURED',reason:groundTruth[i].reason}:computed.ocrMeasurement,
      ocrEvaluationUnit:'FINAL_OCR_PROPOSALS_VS_HUMAN_TARGET_SOURCE_LINE_UNIONS',semantic:quality.semantic,image,
      imageLabels:quality.imageLabels,typesetting:{...evaluateTypesetting(page),labels:quality.typesettingLabels,subjectArtifactId:page.get('candidate')?.id??null,subjectSha256:page.get('candidate')?.sha256??null},
      renderArtifacts:{engineCandidateId:page.get('candidate')?.id??null,finalPngId:page.get('final_png')?.id??null,finalPngRenderPath:'unknown',
        finalPngBinding:page.get('export_receipt')?'PINNED_EXPORT_RECEIPT_MATCHES_JOB_SOURCE_AND_FILE':'EXPORT_RECEIPT_NOT_AVAILABLE',
        trio:page.get('trio')?'HASH_VERIFIED_LEGACY_FILE_NOT_REOPENED_BY_PRODUCT':'NOT_SUPPLIED'},
      legacyReview:{artifactId:page.get('legacy_review')?.id??null,recordedHumanApproval:page.get('legacy_review')?.json?.humanQualityApproved??null,
        independentQualityAttested:false,reason:'LEGACY_FLAGS_ARE_NOT_HASH_BOUND_INDEPENDENT_HUMAN_GT'},
      humanReview:quality.humanReview,humanAudit:quality.humanAudit,attempts:operations.attempts,delivery:operations.delivery,
      deliveryEligibility:{status:'review_required',reasons:[...(quality.humanReview.status!=='completed'?['HUMAN_QUALITY_REVIEW_REQUIRED']:[]),'INDEPENDENT_RUNTIME_EXECUTION_NOT_VERIFIED']},
      ruleInspection:{status:'passed',scope:'INPUT_HASH_IDENTITY_LINEAGE_ONLY_NOT_PRODUCT_QUALITY'},
      failureImage:processing.status==='failed'?{sourceArtifactId:source.id,sourceSha256:source.sha256,file:source.file}:null});
  }
  // Cohort denominators include dataset pages for which no run evidence was provided.
  for(const p of missing)pages.push({pageId:p.pageId,split:p.split,evidenceKind:'not_run',processing:{status:'not_run'},execution:{productExecutionVerified:false},
    ocr:null,ocrMeasurement:{status:'NOT_MEASURED',reason:'RUN_EVIDENCE_NOT_SUPPLIED'},semantic:{majorCriticalErrors:unknown('NO_RUN_EVIDENCE')},
    humanReview:{status:'missing',reason:'NO_RUN_EVIDENCE'},humanAudit:null,attempts:null,delivery:null,deliveryEligibility:{status:'review_required',reasons:['NO_RUN_EVIDENCE']}});
  const summary=aggregateOperations(pages);
  return validateOfflineReport({schemaVersion:1,evaluatorVersion:VERSION,datasetId:loaded.dataset.datasetId,datasetVersion:loaded.dataset.datasetVersion,criteriaVersion:loaded.dataset.criteria.version,
    runId:loaded.descriptor.runId,split:loaded.descriptor.split,datasetManifestSha256:loaded.datasetSha256,evidenceDescriptorSha256:loaded.evidenceSha256,
    states:{EVALUATOR_PREPARED:true,V2_ADAPTER_VERIFIED:loaded.pages.length>0,HUMAN_GT_BLOCKED:selected.some(p=>p.annotation.status!=='human_verified'),
      HOLDOUT_BLOCKED:!loaded.validation.states.HOLDOUT_READY,QUALITY_NOT_MEASURED:pages.length===0 || pages.some(p=>p.semantic.majorCriticalErrors.value===null || p.image?.insideArtworkDamage?.value==null)},
    adapterVerificationScope:'EXPLICITLY_PINNED_SAVED_FILES_AND_PARTIAL_COMMON_PROJECTION_NOT_PRODUCT_E2E',
    datasetReadiness:loaded.validation,summary:{...summary,evidencePages:loaded.pages.length,missingRunPages:missing.length,
      ocr:stage02.ocrSummary,ocrCohort:{totalPages:selected.length,measuredPages:pages.filter(p=>p.ocr!==null).length,unmeasuredPages:pages.filter(p=>p.ocr===null).length,
        reasons:pages.reduce((m,p)=>{if(p.ocrMeasurement.reason)m[p.ocrMeasurement.reason]=(m[p.ocrMeasurement.reason]??0)+1;return m;},{})},
      samples:selected.length,confirmedWorks:loaded.dataset.works.filter(w=>w.status==='confirmed' && selected.some(p=>p.workId===w.workId)).length,
      actualWorkCount:loaded.dataset.works.some(w=>w.status==='unresolved' && selected.some(p=>p.workId===w.workId))?null:new Set(selected.map(p=>p.workId)).size,
      semanticMajorCriticalErrorsPerReviewedPage:ratio(pages.some(p=>p.semantic.majorCriticalErrors.value!==null)?pages.reduce((s,p)=>s+(p.semantic.majorCriticalErrors.value??0),0):null,
        pages.filter(p=>p.semantic.majorCriticalErrors.value!==null).length,'NO_INDEPENDENT_SEMANTIC_REVIEWED_PAGES'),
      productQualityConfidence95:{value:null,reason:'NO_INDEPENDENT_HUMAN_QUALITY_SAMPLE'},
      qualityMeasurementCoverage:measured(pages.filter(p=>p.humanAudit?.verified).length)},pages,
    stage02Calculation:{version:1,splitProjection:loaded.descriptor.split==='calibration'?'CALIBRATION_RUN_SEPARATELY_AS_LEGACY_DEV_BUCKET':'DEV',
      metricsSource:'apps/desktop/scripts/evaluate-automation-quality.mjs',report:stage02},
    limitations:['File hashes and supplied human reviews do not authenticate model execution or reviewer identity.',
      'Legacy group text is not split into invented source-line transcriptions. Missing mappings require review.',
      'Zero pixels changed outside a removal mask cannot establish preservation of artwork inside it.',
      'No new model, final holdout, mutation campaign, browser flow or human quality audit was executed.']});
}
