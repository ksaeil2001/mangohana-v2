'use strict';
const {pixels,rectangle,coverage,validQuad,uniqueQuads,mapSourceLinesToRois}=require('./source-line-roi.cjs');

const failure=message=>Object.assign(new Error(message),{code:'REGION_SELECTION_INVALID'});
function validBox(box){return box&&['x','y','width','height'].every(key=>Number.isFinite(box[key]))&&box.x>=0&&box.y>=0&&box.width>0&&box.height>0&&box.x+box.width<=1.000001&&box.y+box.height<=1.000001;}
/** Preserve the complete OCR evidence. Uncontained text is not silently declared to be an SFX. */
function selectDialogueRegions(extraction,detection){
 if(!Array.isArray(extraction?.speechBubbles)||!Array.isArray(extraction.nonSpeechText)||!Array.isArray(detection?.regions)||detection.regions.length>1000)throw failure('OCR 및 영역 탐지 기록이 필요합니다.');
 const detections=detection.regions;
 if(detections.some(d=>!d||!['bubble','text_bubble','text_free'].includes(d.kind)||typeof d.id!=='string'||!d.id||!Number.isFinite(d.confidence)||d.confidence<0||d.confidence>1||!validBox(d.bbox))||new Set(detections.map(d=>d.id)).size!==detections.length)throw failure('영역 탐지의 ID·종류·좌표가 올바르지 않습니다.');
 const speech=[],preserved=[],decisions=[];const ids=new Set(),sourceIds=new Set();
 for(const region of extraction.speechBubbles){
  if(!region||typeof region.id!=='string'||!region.id||ids.has(region.id)||!validBox(region.bbox))throw failure('OCR 영역 식별자 또는 좌표가 올바르지 않습니다.');
  ids.add(region.id);
  const matches=detections.filter(d=>d.kind==='text_bubble'&&d.confidence>=.5).map(d=>({d,coverage:coverage(rectangle(region.bbox),d.bbox)})).sort((a,b)=>b.coverage-a.coverage||b.d.confidence-a.d.confidence);
  const best=matches[0],p=region.productionOcrProvenance,trace=region.ocrRefinement;
  let lineMapping=[],sourceLineIds=[],ownerIds=[],lineEligible=true;
  if(p){
   const width=p.cropTransform?.imageWidth,height=p.cropTransform?.imageHeight;
   if(!Number.isInteger(width)||!Number.isInteger(height)||width!==detection.width||height!==detection.height||p.groupId!==region.id||!Array.isArray(p.sourceDetectionIds)||!Array.isArray(p.sourceQuadsPx))throw failure('OCR 글줄 좌표 frame을 확인하지 못했습니다.');
   sourceLineIds=trace?.sourceDetectionIds??p.sourceDetectionIds;
   const quads=trace?.sourceQuadsPx??p.sourceQuadsPx;
   if(!sourceLineIds.length||sourceLineIds.length!==quads?.length||!uniqueQuads(quads)||quads.some(q=>!validQuad(q,width,height))||sourceLineIds.some(id=>typeof id!=='string'||!id||sourceIds.has(id))||new Set(sourceLineIds).size!==sourceLineIds.length)throw failure('원본 글줄 소유권이 누락·중복되었습니다.');
   sourceLineIds.forEach(id=>sourceIds.add(id));
   if(trace&&(trace.sourceFrame?.imageSha256!==detection.imageSha256||trace.sourceFrame.width!==width||trace.sourceFrame.height!==height||trace.validation?.status!=='candidate'))throw failure('재OCR 원본 이미지·검토 상태가 일치하지 않습니다.');
   lineMapping=mapSourceLinesToRois({sourceDetectionIds:sourceLineIds,sourceQuadsPx:quads,width,height,regions:detections});
   ownerIds=[...new Set(lineMapping.flatMap(x=>x.roiIds))];
   lineEligible=lineMapping.every(x=>x.status==='unique')&&ownerIds.length===1;
   if(trace&&(!lineEligible||ownerIds[0]!==trace.roiId))throw failure('재OCR 자식과 원본 ROI 소유권이 일치하지 않습니다.');
  }
  const confident=matches.filter(x=>x.coverage>=.75),free=detections.some(d=>d.kind==='text_free'&&d.confidence>=.5&&coverage(rectangle(region.bbox),d.bbox)>=.75);
  const eligible=!region.ocrReview&&lineEligible&&(p?ownerIds.length===1:confident.length===1);
  const connected=ownerIds.length>1;
  const action=eligible?'translate':!region.ocrReview&&!connected&&free&&ownerIds.length===0?'preserve':'needs_review';
  const owner=eligible?(p?detections.find(d=>d.id===ownerIds[0]):best.d):undefined;
  const decision={id:region.id,action,role:eligible?'dialogue':action==='preserve'?'free_text':'uncertain_text',
   detectorRegionId:owner?.id??best?.d.id??null,
   ...(best?{confidence:best.d.confidence,coverage:best.coverage}:{}),
   sourceLineIds,lineMapping,
   reason:region.ocrReview?'recognition_agreement_unverified':connected?'connected_group_requires_actual_crop_recognition':eligible?'learned_text_in_bubble_support':action==='preserve'?'learned_free_text_preservation':'no_confident_unique_dialogue_evidence'};
  decisions.push(decision);
  if(eligible)speech.push(structuredClone(region));
  else preserved.push({...structuredClone(region),type:'unknown',notes:[region.notes,'말풍선 밖 또는 불확실한 원문을 그대로 보존했습니다. 효과음·설명문 구분은 검토가 필요합니다.'].filter(Boolean).join(' ')});
 }
 return {extraction:{...structuredClone(extraction),speechBubbles:speech,nonSpeechText:[...structuredClone(extraction.nonSpeechText),...preserved]},
  selection:{version:1,sourceRegions:extraction.speechBubbles.length,translatedRegions:speech.length,preservedRegions:preserved.length,
   needsReviewRegions:decisions.filter(d=>d.action==='needs_review').length,
   policy:'source_line_unique_roi_coverage_0.75_confidence_0.5',decisions}};
}

module.exports={selectDialogueRegions};
