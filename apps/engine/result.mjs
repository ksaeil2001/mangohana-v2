import { createHash } from 'node:crypto';
import humanReviewContract from '../../packages/ai-engine/quality/human-translation-review.cjs';
import onnxProvider from '../../packages/ai-engine/quality/product-onnx.cjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function requireValue(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code:'INVALID_ENGINE_RESULT' });
}
function indexed(values, label) {
  requireValue(Array.isArray(values) && values.length > 0 && values.length <= 1000, `${label} 결과가 비어 있습니다.`);
  const result = new Map();
  for (const value of values) {
    requireValue(typeof value?.id === 'string' && value.id.length > 0 && value.id.length <= 200 && !result.has(value.id), `${label} 영역 ID가 없거나 중복됩니다.`);
    result.set(value.id, value);
  }
  return result;
}
function box(value) {
  requireValue(value && ['x','y','width','height'].every(key => Number.isFinite(value[key])), '식자 좌표가 올바르지 않습니다.');
  requireValue(value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0 && value.x + value.width <= 1.000001 && value.y + value.height <= 1.000001, '식자 좌표가 이미지 밖에 있습니다.');
  return value;
}
function png(bytes, width, height) {
  requireValue(Buffer.isBuffer(bytes) && bytes.length >= 24 && bytes.length <= 32*1024*1024, '결과 이미지 크기가 올바르지 않습니다.');
  requireValue(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.readUInt32BE(16) === width && bytes.readUInt32BE(20) === height, '결과 PNG와 원본 크기가 다릅니다.');
  return 'data:image/png;base64,' + bytes.toString('base64');
}

function pageRequestProofs(report, translations, stage15, onnxReceipt) {
  const requests = report.translationRequests ?? [];
  requireValue(Array.isArray(requests) && requests.length <= 128, '페이지 번역 요청 기록이 올바르지 않습니다.');
  const byId = new Map();
  for (const request of requests) {
    requireValue(typeof request?.requestId === 'string' && request.requestId.length > 0 && request.requestId.length <= 200 && !byId.has(request.requestId), '페이지 번역 요청 식별자가 중복되거나 누락됐습니다.');
    const synthetic = stage15 && request.requestId === stage15.publication.executionId && request.contextFingerprint === stage15.publication.inputFingerprint;
    if (request.transport === 'onnx-cpu') {
      requireValue(!stage15 && requests.length===1 && request.scope==='page' && onnxReceipt?.requestSha256===request.contextFingerprint &&
        onnxReceipt?.responseSha256===request.responseSha256 && request.providerRevision===onnxProvider.revision &&
        request.sourceImageSha256===report.hashes.normalized && request.localGenerations===1 && request.httpRequests===0 &&
        request.usedImageContext===false && request.imageSha256===null, 'ONNX 페이지 번역의 원요청·응답 근거가 다릅니다.');
    } else {
      requireValue(!onnxReceipt && request.scope === 'page' && (synthetic ? request.httpRequests === 0 && request.usedImageContext === false : request.httpRequests === 1 && request.usedImageContext === true) &&
        /^[a-f0-9]{64}$/.test(request.contextFingerprint) && /^[a-f0-9]{64}$/.test(request.imageSha256) &&
        request.imageSha256 === report.hashes.normalized, '실제 페이지 그림·문맥 번역 실행 기록이 필요합니다.');
    }
    requireValue(Array.isArray(request.regionIds) && request.regionIds.length > 0 && request.regionIds.length <= 128 &&
      new Set(request.regionIds).size === request.regionIds.length, '페이지 번역의 대사 목록이 중복되거나 비어 있습니다.');
    const members = [...translations.values()].filter(record => record.requestId === request.requestId);
    requireValue(members.length === request.regionIds.length && members.every(record => request.regionIds.includes(record.id)), '페이지 요청과 응답의 대사 ID 목록이 다릅니다.');
    let calls = 0;
    for (const member of members) {
      requireValue(member.requestScope === 'page' && member.responseIdentity === 'validated_page_json_ids' &&
        member.requestedContextFingerprint === request.contextFingerprint && member.returnedContextFingerprint === request.contextFingerprint &&
        Number.isInteger(member.modelHttpRequests) && member.modelHttpRequests >= 0 && member.modelHttpRequests <= 1,
      '페이지 번역 응답과 요청 문맥의 대응을 확인하지 못했습니다.');
      calls += member.modelHttpRequests;
    }
    requireValue(calls === request.httpRequests, '공유 페이지 번역의 실제 호출 수가 일치하지 않습니다.');
    byId.set(request.requestId, request);
  }
  return byId;
}

/** Convert only a trusted, integrity-checked engine report; this does not approve translation quality. */
export function reportToStudioResult(report, { cleanedPng, candidatePng, verifiedStage15, verifiedOnnx }) {
  requireValue(Boolean(report?.stage15) === Boolean(verifiedStage15), '합성 번역 게시 서명을 확인해 주세요.');
  requireValue(report?.version === 1 && report.evidenceKind === 'LOCAL_ENGINE_CANDIDATE' && report.originalPreserved === true && report.userApproved === false, '실제 엔진의 원본 보존 보고서가 필요합니다.');
  requireValue(!report.regionSelection?.decisions?.some(d=>d.action==='needs_review') && !report.ocrRefinement?.reviews?.length &&
    !report.ocr?.speechBubbles?.some(g=>g.ocrReview?.status==='needs_review'), '미확정 대사가 남아 있어 원문·OCR 후보 검토가 필요합니다.');
  let humanReview=null;
  if(report.humanTranslationReview){try{humanReview=humanReviewContract.assertReviewedReport(report);}catch{requireValue(false,'사용자 번역 검수 영수증과 현재 결과가 다릅니다.');}}
  else requireValue(!report.lines?.some(line=>line.userTranslation!==undefined),'사용자 확정문의 검수 영수증이 없습니다.');
  const { width, height } = report.image ?? {};
  requireValue(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width*height <= 12_000_000, '원본 이미지 크기가 올바르지 않습니다.');
  requireValue(digest(cleanedPng) === report.hashes?.cleaned && digest(candidatePng) === report.hashes?.candidate, '저장된 결과의 해시가 엔진 보고서와 다릅니다.');
  const lines = indexed(report.lines,'대사');
  const translations = indexed(report.translations,'번역');
  const pageRequests = pageRequestProofs(report, translations, verifiedStage15, verifiedOnnx);
  const layouts = indexed(report.typesetting?.layoutReport,'식자');
  const stage12 = [...layouts.values()].some(l=>l.contractVersion==='stage12-layout-v1');
  const typesettingIdentity = report.typesetting?.inputIdentity;
  if(stage12)requireValue(typesettingIdentity?.contract==='stage12-input-v1'&&typesettingIdentity.jobId===report.jobId&&typesettingIdentity.width===width&&typesettingIdentity.height===height&&
    typesettingIdentity.coordinateSpace==='normalized-page-pixels'&&typesettingIdentity.mode==='unreviewed_candidate'&&typesettingIdentity.maskReview==='candidate_validated_not_human_approved'&&
    typesettingIdentity.sourceSha256===report.hashes.original&&typesettingIdentity.sourceImageSha256===report.hashes.normalized&&typesettingIdentity.cleanedImageSha256===report.hashes.cleaned&&typesettingIdentity.maskSha256===report.hashes.mask&&
    typesettingIdentity.translationInputFingerprint===report.translationInput?.fingerprint,'식자 입력의 원본·cleaned·마스크·번역 identity가 다릅니다.');
  const ocr = indexed(report.ocr?.speechBubbles,'OCR');
  requireValue(lines.size === translations.size && lines.size === layouts.size && lines.size === ocr.size, 'OCR·번역·식자 영역 개수가 다릅니다.');
  const blocks = [...lines.values()].sort((a,b) => (a.order ?? 0)-(b.order ?? 0)).map(line => {
    const translation = translations.get(line.id), layout = layouts.get(line.id);
    requireValue(ocr.has(line.id) && translation && layout, '원문과 번역/식자 영역 ID가 다릅니다.');
    if(line.sourceLineIds!==undefined){
      const group=ocr.get(line.id),expected=group.ocrRefinement?.sourceDetectionIds??group.productionOcrProvenance?.sourceDetectionIds??[];
      requireValue(Array.isArray(line.sourceLineIds)&&new Set(line.sourceLineIds).size===line.sourceLineIds.length&&
        line.sourceLineIds.length===expected.length&&line.sourceLineIds.every(id=>expected.includes(id)), '원본 글줄과 재OCR 자식의 대응이 변경되었습니다.');
    }
    requireValue(typeof line.sourceText === 'string' && line.sourceText.trim() && typeof line.aiTranslation === 'string' && line.aiTranslation.trim(), '원문 또는 번역문이 누락됐습니다.');
    const actualRequest = translation.requestScope === 'page'
      ? pageRequests.has(translation.requestId)
      : translation.requestScope === undefined && Number.isInteger(translation.modelHttpRequests) && translation.modelHttpRequests > 0;
    const reviewed=humanReview&&translation.engine==='human_review'&&translation.modelHttpRequests===0&&translation.rawModelTranslation===line.aiTranslation&&translation.humanReviewReceiptSha256===humanReview.receiptSha256;
    const synthetic = verifiedStage15 && !humanReview && translation.engine === 'stage15_synthetic' && actualRequest &&
      translation.requestId === verifiedStage15.publication.executionId && translation.modelHttpRequests === 0;
    requireValue(((translation.engine === 'local_ai' && actualRequest&&!humanReview&&!verifiedStage15)||reviewed||synthetic) && translation.usedExactTm === false && Array.isArray(translation.qaReport?.issues), '실제 번역 요청과 대사별 대응 기록이 누락됐습니다.');
    const effectiveText=reviewed?line.userTranslation:line.aiTranslation;
    if(report.translationInput?.version==='stage11-input-v1'){
      const semantic=translation.semantic;
      requireValue(semantic?.version==='stage11-risk-v1'&&semantic.automaticQualityApproval===false&&semantic.semanticAccuracy===null&&semantic.humanSemanticVerified===null&&semantic.independentSemanticEvaluation===null&&semantic.humanReviewRequired===true&&semantic.semanticReviewRequired===true&&Array.isArray(semantic.signals)&&semantic.statuses?.includes('SEMANTIC_NOT_MEASURED'),'의미 검토 상태가 누락됐거나 자동 승인으로 변경되었습니다.');
    }
    requireValue(layout.productionFontLoaded === true && layout.glyphFontLoaded === true && Number.isFinite(layout.fontSizePx) && layout.fontSizePx >= 10, '식자 글꼴 검증 기록이 누락됐습니다.');
    if(stage12)requireValue(layout.contractVersion==='stage12-layout-v1'&&layout.qaStatus==='pending'&&['FIT_VERIFIED','FIT_WARNING'].includes(layout.fitStatus)&&
      line.pageNumber===typesettingIdentity.pageNumber&&layout.textEvidence?.sourceText===effectiveText&&layout.textEvidence.complete===true&&layout.textEvidence.missingCharacters===0&&layout.textEvidence.extraCharacters===0&&
      Array.isArray(layout.actualLayout?.lines)&&JSON.stringify(layout.actualLayout.lines.map(l=>l.text))===JSON.stringify(layout.textEvidence.renderedLines)&&
      layout.glyphEvidence?.measured===true&&layout.glyphEvidence.missingGlyphOccurrences===0&&layout.raster?.paintedPixels>0&&
      layout.raster.clippedPixels===0&&layout.raster.otherRegionCollisionPixels===0&&layout.raster.overlappingInkPixels===0&&[0,null].includes(layout.raster.outsideInteriorPixels),'식자 문자열·글리프·픽셀 증거가 누락됐거나 모순됩니다.');
    if (layout.placement && layout.placement!=='page') throw Object.assign(new Error('원위치 식자가 완료되지 않았습니다.'),{code:'PARTIAL_TYPESETTING'});
    const bbox = box(layout.bbox), sourceBbox = box(layout.sourceBbox ?? bbox);
    return {
      id:line.id, source:line.sourceText, text:effectiveText,
      x:bbox.x*100, y:bbox.y*100, w:bbox.width*100, h:bbox.height*100,
      font:'sans', size:layout.fontSizePx, weight:600, align:'center', color:'#202020', lineHeight:1.4, fill:false,
      ...(Number.isFinite(line.parseConfidence) ? { confidence:Math.min(1,Math.max(0,line.parseConfidence)) } : {}),
      sourceBox:{x:sourceBbox.x*100,y:sourceBbox.y*100,w:sourceBbox.width*100,h:sourceBbox.height*100},
      readingOrder:line.order,
      engineLayout:{ fontFamily:layout.fontFamily, ...(layout.actualLayout ? { actualLayout:layout.actualLayout } : {}) },
    };
  });
  return {
    clean_image:png(cleanedPng,width,height), final_image:png(candidatePng,width,height), blocks,
    evidence:{ kind:report.evidenceKind, quality_status:'pending', semantic_review:report.quality?.semanticReview ?? 'pending', residual_source_text:report.quality?.residualSourceText ?? 'not_measured', source_preserved:true,
      ...(Array.isArray(report.ocr.nonSpeechText)?{sound_effects:{
        preserved:report.ocr.nonSpeechText.filter(region=>region?.type==='sound_effect').length,
        translated:blocks.filter(block=>ocr.get(block.id).type==='sound_effect').length,
      }}:{}),
      ...(verifiedOnnx ? {translation_transport:'onnx-cpu',model_image_input:false,automatic_quality_approval:false} : {}),
      ...(verifiedStage15 ? {translation_transport:'SYNTHETIC', translation_execution_id:verifiedStage15.publication.executionId,
        translation_artifact_sha256:verifiedStage15.publication.artifact.sha256} : {}),
      ...(humanReview?{human_translation_review:structuredClone(humanReview),manual_translation_selections:humanReview.selections.length}:{}),
      ...(report.translationInput?.version==='stage11-input-v1'?{automatic_quality_approval:false,translation_semantics:[...translations.values()].map(t=>({id:t.id,...t.semantic}))}:{}),
      ...(stage12?{typesetting_input_identity:structuredClone(typesettingIdentity),typesetting_layouts:structuredClone([...layouts.values()])}:{}) },
    warnings:Array.isArray(report.warnings) ? report.warnings.filter(value=>typeof value==='string') : [],
  };
}
