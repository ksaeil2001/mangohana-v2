import { validateCommonContract, unknownQuality } from '../../contracts/src/v2-common-contract.mjs';
import { contentSha256 } from '../dataset-contract.mjs';
import { equal, hash, identifier, measured, requireValue, unknown } from './contract.mjs';

const alias=id=>'legacy:'+Buffer.from(id).toString('base64url');
const quad=q=>q.map(p=>Array.isArray(p)?p:[p.x,p.y]);
const boxPolygon=(b,w,h)=>[[b.x*w,b.y*h],[(b.x+b.width)*w,b.y*h],[(b.x+b.width)*w,(b.y+b.height)*h],[b.x*w,(b.y+b.height)*h]];
const validBox=b=>b && ['x','y','width','height'].every(k=>Number.isFinite(b[k])) && b.x>=0 && b.y>=0 && b.width>0 && b.height>0 && b.x+b.width<=1.000001 && b.y+b.height<=1.000001;
function groups(artifact) {
  if(!artifact)return null;
  requireValue(Array.isArray(artifact.json.speechBubbles),'INVALID_OCR_EVIDENCE');
  const seen=new Set();for(const g of artifact.json.speechBubbles) {
    requireValue(identifier(g.id) && !seen.has(g.id),'DUPLICATE_OCR_REGION_ID');seen.add(g.id);
    requireValue(typeof g.text==='string' && validBox(g.bbox) && Number.isSafeInteger(g.readingOrder) && g.readingOrder>0,'INVALID_OCR_EVIDENCE');
    if(g.productionOcrProvenance) {
      const p=g.productionOcrProvenance;
      requireValue(Array.isArray(p.sourceDetectionIds) && p.sourceDetectionIds.length>0 && p.sourceDetectionIds.every(id=>typeof id==='string'&&id.length>0)
        && new Set(p.sourceDetectionIds).size===p.sourceDetectionIds.length && Array.isArray(p.sourceQuadsPx) && p.sourceQuadsPx.length===p.sourceDetectionIds.length,'SOURCE_LINE_PROVENANCE_INVALID');
      requireValue(p.sourceQuadsPx.every(q=>Array.isArray(q) && q.length===4 && quad(q).every(p=>p.length===2 && p.every(Number.isFinite))),'SOURCE_LINE_PROVENANCE_INVALID');
    }
  }
  return artifact.json.speechBubbles;
}
function translationLineage(page,raw,final) {
  const payload=page.get('translations')?.json;
  if(!payload) return {status:'not_measured',reason:'TRANSLATIONS_NOT_AVAILABLE',targets:null};
  requireValue(Array.isArray(payload.lines) && Array.isArray(payload.records),'INVALID_TRANSLATION_EVIDENCE');
  const available=new Map((final??raw??[]).map(g=>[g.id,g])),seen=new Set(),records=new Set();
  for(const line of payload.lines) {
    const g=available.get(line.ocrGroupId??line.id);
    requireValue(identifier(line.id) && !seen.has(line.id) && g && line.id===g.id,'TRANSLATION_LINEAGE_MISMATCH');seen.add(line.id);
    requireValue(typeof line.sourceText==='string' && typeof line.aiTranslation==='string','INVALID_TRANSLATION_EVIDENCE');
    // OCR and AI source interpretation are separate; never overwrite g.text.
    if(line.sourceLineIds) requireValue(equal([...line.sourceLineIds].sort(),[...(g.ocrRefinement?.sourceDetectionIds??g.productionOcrProvenance?.sourceDetectionIds??[])].sort()),'TRANSLATION_LINEAGE_MISMATCH');
  }
  for(const r of payload.records) {requireValue(seen.has(r.id) && !records.has(r.id) && identifier(r.requestId),'TRANSLATION_LINEAGE_MISMATCH');records.add(r.id);}
  if(page.state?.status==='completed')requireValue(records.size===seen.size && seen.size===(final??[]).length,'TRANSLATION_LINEAGE_MISMATCH');
  return {status:'structurally_bound',reason:null,targets:payload.lines.length,
    aiInterpretedSources:payload.lines.filter(l=>l.sourceText!==available.get(l.id).text).map(l=>l.id),
    semanticCorrectness:unknown('HUMAN_SOURCE_AND_RESULT_REVIEW_REQUIRED')};
}
function validateSavedBindings(page,raw,final) {
  const normalized=page.get('normalized'),detection=page.get('region_detection')?.json;
  if(detection) requireValue(detection.imageSha256===normalized.sha256 && detection.width===normalized.image.width && detection.height===normalized.image.height,'REGION_IMAGE_BINDING_MISMATCH');
  const selection=page.get('region_selection')?.json;
  if(selection?.detection) requireValue(selection.detection.imageSha256===normalized.sha256,'REGION_IMAGE_BINDING_MISMATCH');
  const regions=selection?.detection?.regions??detection?.regions??[],regionIds=new Set();
  for(const r of regions) {requireValue(identifier(r.id) && !regionIds.has(r.id) && validBox(r.bbox),'INVALID_OR_DUPLICATE_ROI');regionIds.add(r.id);}
  const decisions=selection?.selection?.decisions??[],seen=new Set(),sourceGroups=new Set((raw??final??[]).map(g=>g.id));
  const selectableGroups=new Map([...(raw??[]),...(final??[])].map(g=>[g.id,g]));
  for(const d of decisions) {
    requireValue(selectableGroups.has(d.id) && !seen.has(d.id) && ['translate','preserve','needs_review'].includes(d.action),'REGION_SELECTION_LINEAGE_MISMATCH');seen.add(d.id);
    requireValue(d.detectorRegionId===null || regionIds.has(d.detectorRegionId),'REGION_SELECTION_LINEAGE_MISMATCH');
    if(d.sourceLineIds){const g=selectableGroups.get(d.id);requireValue(equal([...d.sourceLineIds].sort(),[...(g.ocrRefinement?.sourceDetectionIds??g.productionOcrProvenance?.sourceDetectionIds??[])].sort()),'REGION_SELECTION_LINEAGE_MISMATCH');}
  }
  const plan=page.get('refinement_plan')?.json,bound=page.get('bound_crops')?.json;
  const sourceIds=new Set((raw??[]).flatMap(g=>g.productionOcrProvenance?.sourceDetectionIds??[]));
  if(plan) {
    const {integritySha256,...content}=plan;
    requireValue(integritySha256===contentSha256(content),'REFINEMENT_INTEGRITY_MISMATCH');
    const source=page.get('source');
    // New producers explicitly bind upload bytes and normalized coordinates.
    // Older saved plans used normalized bytes for both names; retain that view.
    const sourceBound=plan.sourceFrame
      ? plan.sourceSha256===source.sha256 && plan.originalUploadSha256===source.sha256 && equal(plan.sourceFrame,{kind:'normalized_px',width:normalized.image.width,height:normalized.image.height,imageSha256:normalized.sha256})
      : plan.sourceSha256===normalized.sha256;
    requireValue(plan.sourceImageSha256===normalized.sha256 && sourceBound,'REFINEMENT_IMAGE_BINDING_MISMATCH');
    requireValue(plan.width===normalized.image.width && plan.height===normalized.image.height && Array.isArray(plan.groups),'REFINEMENT_IMAGE_BINDING_MISMATCH');
    // Product plan seals use a canonical digest; exact producer ordering is retained above.
    for(const g of plan.groups) {
      requireValue(sourceGroups.has(g.parentId) && Array.isArray(g.crops),'REFINEMENT_LINEAGE_MISMATCH');
      for(const c of g.crops) requireValue(regionIds.has(c.roiId) && Array.isArray(c.sourceDetectionIds) && c.sourceDetectionIds.every(id=>sourceIds.has(id)),'REFINEMENT_LINEAGE_MISMATCH');
    }
  }
  if(bound) {
    const {integritySha256,...content}=bound;requireValue(integritySha256===contentSha256(content),'REFINEMENT_INTEGRITY_MISMATCH');
    requireValue(plan && equal(bound.plan,plan) && Array.isArray(bound.crops),'BOUND_CROP_PLAN_MISMATCH');
    for(const c of bound.crops) {
      const image=[...page.artifacts.values()].find(a=>a.kind==='crop_image' && a.sha256===c.cropSha256);
      requireValue(image && image.image.width===c.width && image.image.height===c.height && image.bytes.length===c.byteLength,'BOUND_CROP_HASH_MISMATCH');
    }
  }
  return {regions,decisions,plan,bound};
}
function explicitCommon(page) {
  if(page.commonArtifactId===null)return null;
  const a=page.artifacts.get(page.commonArtifactId);requireValue(a?.kind==='common','COMMON_ARTIFACT_MISMATCH');
  const c=a.json;try {validateCommonContract(c);} catch {requireValue(false,'COMMON_CONTRACT_INVALID');}
  const b=page.binding,id=c.identity;
  requireValue(id.ownerScope.kind==='owner' && id.ownerScope.id===b.ownerId && id.projectId===b.projectId && id.pageId===b.pageId && id.jobId===b.jobId && id.workId===b.workId
    && ['sourceRevision','editRevision','contextRevision','processingGeneration','storageRevision'].every(k=>id[k]===b[k]),'COMMON_IDENTITY_MISMATCH');
  for(const x of c.artifacts.filter(x=>x.materialization==='materialized')) requireValue(page.artifacts.get(x.artifactId)?.sha256===x.sha256,'COMMON_ARTIFACT_HASH_MISMATCH');
  requireValue(c.images.find(i=>i.kind==='uploaded_original').sha256===page.get('source').sha256 && c.images.find(i=>i.kind==='normalized').sha256===page.get('normalized').sha256,'COMMON_IMAGE_HASH_MISMATCH');
  return {document:c,status:'validated_explicit_sidecar',missingRelations:[]};
}

/** Conservative compatibility view. Missing human line text/ROI links stay missing. */
export function adaptV2Page(page,dataset) {
  const rawArtifact=page.get('raw_ocr'),finalArtifact=page.get('final_ocr');
  const raw=groups(rawArtifact),final=groups(finalArtifact),sourceGroups=raw??final??[];
  const bound=validateSavedBindings(page,raw,final),translations=translationLineage(page,raw,final);
  const rawSourceIds=raw?new Set(raw.flatMap(g=>g.productionOcrProvenance?.sourceDetectionIds??[])):null;
  const finalSourceIds=final?new Set(final.flatMap(g=>g.ocrRefinement?.sourceDetectionIds??g.productionOcrProvenance?.sourceDetectionIds??[])):null;
  if(rawSourceIds && finalSourceIds)requireValue([...finalSourceIds].every(id=>rawSourceIds.has(id)),'FINAL_SOURCE_LINE_FOREIGN_REFERENCE');
  if(page.report?.ocr && finalArtifact) requireValue(equal(page.report.ocr,finalArtifact.json),'REPORT_OCR_MISMATCH');
  if(page.report?.lines && page.get('translations')) requireValue(equal(page.report.lines,page.get('translations').json.lines),'REPORT_TRANSLATIONS_MISMATCH');
  const missingRelations=[];
  const lineage={observedSourceLines:sourceGroups.reduce((s,g)=>s+(g.productionOcrProvenance?.sourceDetectionIds?.length??0),0),
    observedGroups:sourceGroups.length,observedRois:bound.regions.length,rawDetectorAccuracy:unknown('NO_INDEPENDENT_RAW_DETECTOR_GT','ratio'),
    finalSourceCoverage:{status:rawSourceIds&&finalSourceIds?'observed':'not_measured',reason:rawSourceIds&&finalSourceIds?null:'RAW_AND_FINAL_SOURCE_LINE_IDS_REQUIRED',
      missingObservedSourceLineIds:rawSourceIds&&finalSourceIds?[...rawSourceIds].filter(id=>!finalSourceIds.has(id)):null,
      retainedObservedSourceLines:rawSourceIds&&finalSourceIds?[...rawSourceIds].filter(id=>finalSourceIds.has(id)).length:null,
      scope:'SAVED_DETECTOR_LINE_LINEAGE_NOT_HUMAN_CHARACTER_RECALL'},
    finalOcrAvailable:finalArtifact!==undefined,sourceCharacterLoss:unknown('INDEPENDENT_HUMAN_SOURCE_LINES_REQUIRED'),translationBindings:translations,
    groupTextIs:'MODEL_RECOGNITION_NOT_HUMAN_TRANSCRIPTION',recognitionAccuracy:unknown('DETECTOR_CONFIDENCE_IS_NOT_CHARACTER_ACCURACY','ratio'),
    refinementEvidence:{planArtifactId:page.get('refinement_plan')?.id??null,boundArtifactId:page.get('bound_crops')?.id??null,
      cropOcrArtifactIds:[...page.artifacts.values()].filter(x=>x.kind==='crop_ocr').map(x=>x.id),characterPreservation:unknown('CROP_GEOMETRY_IS_NOT_GLYPH_GROUND_TRUTH')}};
  const supplied=explicitCommon(page);if(supplied)return {common:supplied,lineage,finalOcr:finalArtifact?.json??null};
  if(sourceGroups.some(g=>!g.productionOcrProvenance || typeof g.productionOcrProvenance.detectorModelId!=='string')) return {common:{document:null,status:'blocked',missingRelations:['SOURCE_LINE_PROVENANCE_OR_MODEL_NOT_REPORTED']},lineage,finalOcr:finalArtifact?.json??null};
  const source=page.get('source'),normalized=page.get('normalized'),origin=rawArtifact??finalArtifact;
  const doc={contractVersion:1,identity:{ownerScope:{kind:'owner',id:page.binding.ownerId},projectId:page.binding.projectId,workId:page.binding.workId,pageId:page.binding.pageId,jobId:page.binding.jobId,
    ...Object.fromEntries(['sourceRevision','editRevision','contextRevision','processingGeneration','storageRevision'].map(k=>[k,page.binding[k]]))},
    images:[source,normalized].map((a,i)=>({imageId:i?'normalized-image':'source-image',kind:i?'normalized':'uploaded_original',artifactId:a.id,sha256:a.sha256,width:a.image.width,height:a.image.height,exifOrientation:a.image.orientation??null,rotationDegrees:null})),
    frames:[{frameId:'source-px',kind:'original_px',imageId:'source-image',width:source.image.width,height:source.image.height,parentFrameId:null,toParent:null,crop:null},
      {frameId:'normalized-px',kind:'normalized_px',imageId:'normalized-image',width:normalized.image.width,height:normalized.image.height,parentFrameId:null,toParent:null,crop:null}],
    observations:[],groups:[],regions:[],mappings:[],refinements:[],targets:[],translations:[],typesetting:[],context:null,artifacts:[],quality:unknownQuality(),executionEvidence:[],receipt:null};
  doc.artifacts=[{a:source,kind:'uploaded_original',frameId:'source-px',parents:[]},{a:normalized,kind:'normalized',frameId:'normalized-px',parents:[source.id]},
    ...(origin?[{a:origin,kind:'raw_ocr',frameId:'normalized-px',parents:[normalized.id]}]:[])].map(({a,kind,frameId,parents})=>({artifactId:a.id,kind,sha256:a.sha256,frameId,version:'legacy-offline-projection-v1',producerStage:'saved_evidence',parentArtifactIds:parents,sourceLineIds:[],materialization:'materialized',unmeasuredReason:null,maskSemantics:null}));
  doc.regions=bound.regions.map(r=>({regionId:r.id,frameId:'normalized-px',polygon:boxPolygon(r.bbox,normalized.image.width,normalized.image.height),classification:'unknown',confidence:Number.isFinite(r.confidence)?measured(r.confidence,'ratio'):unknown('ROI_CONFIDENCE_NOT_REPORTED','ratio')}));
  const usedLines=new Set(),aliases=[],modelAliases=new Map();
  for(const g of sourceGroups) {
    const p=g.productionOcrProvenance,ids=p.sourceDetectionIds.map(alias),groupId=g.id;
    const modelId='legacy-model:'+Buffer.from(p.detectorModelId).toString('base64url');
    modelAliases.set(modelId,{commonModelId:modelId,legacyModelId:p.detectorModelId,revision:p.detectorRevision??null});
    doc.groups.push({groupId,sourceLineIds:ids,orientation:['vertical','horizontal'].includes(p.orientation)?p.orientation:'unknown',readingOrder:g.readingOrder,speakerId:null});
    const decision=bound.decisions.find(d=>d.id===g.id);
    for(let i=0;i<ids.length;i++) {
      requireValue(!usedLines.has(ids[i]),'DUPLICATE_SOURCE_LINE_ID');usedLines.add(ids[i]);aliases.push({legacyLineId:p.sourceDetectionIds[i],commonLineId:ids[i]});
      doc.observations.push({lineId:ids[i],kind:'source_detection',frameId:'normalized-px',polygon:quad(p.sourceQuadsPx[i]),quad:quad(p.sourceQuadsPx[i]),rawText:null,normalizedText:null,
        uncertainty:'unknown',detectionConfidence:Number.isFinite(p.sourceDetectionScores?.[i])?measured(p.sourceDetectionScores[i],'ratio'):unknown('DETECTOR_CONFIDENCE_NOT_REPORTED','ratio'),
        recognitionConfidence:unknown('NO_PER_SOURCE_LINE_RECOGNITION_SCORE','ratio'),model:{id:modelId,revision:p.detectorRevision??null,weightsSha256:null,configSha256:null},originArtifactId:origin.id});
      const roiIds=[...new Set([...(decision?.detectorRegionId?[decision.detectorRegionId]:[]),...(bound.plan?.groups??[]).filter(pg=>pg.parentId===g.id).flatMap(pg=>pg.crops.filter(c=>c.sourceDetectionIds.includes(p.sourceDetectionIds[i])).map(c=>c.roiId))])];
      // The old group-level assignment is an observation, not a verified per-line assignment.
      doc.mappings.push({sourceLineId:ids[i],groupId,regionIds:roiIds,redetectedLineIds:[],disposition:'needs_review',reason:'LEGACY_GROUP_TO_ROI_REQUIRES_LINE_REVIEW',targetId:null});
    }
  }
  if(sourceGroups.length)missingRelations.push('PER_SOURCE_LINE_TEXT_NOT_REPORTED','HUMAN_LINE_TO_ROI_NOT_VERIFIED');
  if(bound.plan)missingRelations.push('CROP_LOCAL_OBSERVATIONS_NOT_PROMOTED_TO_ACCEPTED_FINAL_LINES');
  if(translations.targets!==null)missingRelations.push('TRANSLATION_AND_RENDER_LINEAGE_RETAINED_IN_LEGACY_VIEW_ONLY');
  missingRelations.push('REVISION_AND_RUNTIME_RECEIPT_NOT_ATTESTED','SOURCE_TO_NORMALIZED_TRANSFORM_NOT_REPORTED');
  try {validateCommonContract(doc);} catch {requireValue(false,'COMMON_PROJECTION_INVALID');}
  return {common:{document:doc,status:'validated_partial_legacy_projection',missingRelations,aliases,modelAliases:[...modelAliases.values()]},lineage,finalOcr:finalArtifact?.json??null};
}
