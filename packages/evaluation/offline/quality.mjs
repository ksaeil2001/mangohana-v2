import sharp from 'sharp';
import { decodeMaskPixels } from '../../contracts/src/v2-common-contract.mjs';
import { equal, identifier, keys, measured, requireValue, unknown, SEMANTIC_ERRORS, IMAGE_ERRORS, TYPESETTING_ERRORS, SEVERITIES } from './contract.mjs';

async function rgba(bytes) {
  try { return await sharp(bytes,{failOn:'error',limitInputPixels:120000000}).ensureAlpha().raw().toBuffer({resolveWithObject:true}); }
  catch { requireValue(false,'IMAGE_DECODE_FAILED'); }
}
async function maskPixels(mask,width,height,kind) {
  const {data,info}=await rgba(mask.bytes);
  requireValue(info.width === width && info.height === height,'MASK_DIMENSIONS_MISMATCH');
  const encoding=mask.encoding,rgbaEncoding=['studio_inverse_alpha','worker_luminance_alpha'].includes(encoding);
  let pixels=data;
  if(!rgbaEncoding) {
    pixels=new Uint8Array(width*height);
    for(let i=0;i<pixels.length;i++) {const o=i*4;requireValue(data[o]===data[o+1] && data[o]===data[o+2] && data[o+3]===255,'MASK_CHANNELS_INVALID');pixels[i]=data[o];}
  }
  try {return decodeMaskPixels({kind,encoding,pixels,width,height});} catch {requireValue(false,'MASK_ENCODING_INVALID');}
}
const imageUnknown=reason=>({outsideMaskChangedPixels:unknown(reason),insideMaskChangedPixels:unknown(reason),protectedChangedPixels:unknown(reason),
  removalProtectionOverlapPixels:unknown(reason),insideArtworkDamage:unknown('NO_CLEAN_BACKGROUND_OR_HUMAN_DAMAGE_GT'),sourceResidue:unknown('INDEPENDENT_SOURCE_RESIDUE_REVIEW_REQUIRED'),
  whiteHalo:unknown('INDEPENDENT_WHITE_HALO_REVIEW_REQUIRED'),preservedSfxDamage:unknown('HUMAN_PRESERVE_SFX_REGIONS_REQUIRED'),
  removalMaskAccuracy:unknown('HUMAN_GLYPH_MASK_GT_REQUIRED','ratio'),bubbleBorderDamage:unknown('HUMAN_BUBBLE_BORDER_REVIEW_REQUIRED'),visualDefects:unknown('INDEPENDENT_VISUAL_REVIEW_REQUIRED')});

/** Normalized source versus cleaned image. Candidate text is a different comparison. */
export async function compareImagePixels({source,cleaned,removal,protection=null}) {
  const result=imageUnknown('IMAGE_OR_MASK_EVIDENCE_NOT_AVAILABLE');
  if(!source || !cleaned) return result;
  const a=await rgba(source),b=await rgba(cleaned);
  requireValue(a.info.width===b.info.width && a.info.height===b.info.height && a.info.channels===4 && b.info.channels===4,'IMAGE_FRAME_MISMATCH');
  const count=a.info.width*a.info.height,r=removal?await maskPixels(removal,a.info.width,a.info.height,'removal'):null,p=protection?await maskPixels(protection,a.info.width,a.info.height,'protection'):null;
  let changed=0,inside=0,outside=0,protectedChanges=0,overlap=0,masked=0,alphaChanged=0;
  for(let i=0;i<count;i++) {
    const o=i*4,different=a.data[o]!==b.data[o] || a.data[o+1]!==b.data[o+1] || a.data[o+2]!==b.data[o+2] || a.data[o+3]!==b.data[o+3];
    if(r?.[i]) masked++;if(r?.[i] && p?.[i]) overlap++;
    if(a.data[o+3]!==b.data[o+3])alphaChanged++;
    if(different) {changed++;if(r) {if(r[i]) inside++;else outside++;}if(p?.[i])protectedChanges++;}
  }
  return {...result,decodedPixels:measured(count),changedPixels:measured(changed),alphaChangedPixels:measured(alphaChanged),maskedPixels:r?measured(masked):unknown('REMOVAL_MASK_NOT_AVAILABLE'),
    outsideMaskChangedPixels:r?measured(outside):unknown('REMOVAL_MASK_NOT_AVAILABLE'),insideMaskChangedPixels:r?measured(inside):unknown('REMOVAL_MASK_NOT_AVAILABLE'),
    protectedChangedPixels:p?measured(protectedChanges):unknown('PROTECTION_MASK_NOT_AVAILABLE'),removalProtectionOverlapPixels:r&&p?measured(overlap):unknown('REMOVAL_OR_PROTECTION_MASK_NOT_AVAILABLE'),
    comparison:'NORMALIZED_SOURCE_VS_CLEANED_RGBA_EXACT',qualityApproval:false};
}
export function verifyImageMeasurementClaims(claim,result) {
  if(claim?.measured!==true)return;
  for(const key of ['decodedPixels','maskedPixels','changedPixels','outsideMaskChangedPixels','alphaChangedPixels']) {
    if(claim[key]!==undefined && result[key]?.value!==null)requireValue(Number.isSafeInteger(claim[key]) && claim[key]>=0 && claim[key]===result[key]?.value,'IMAGE_MEASUREMENT_CONTRADICTION');
  }
}

export function evaluateTypesetting(page) {
  const layouts=page.report?.typesetting?.layoutReport;
  const targets=page.get('translations')?.json?.lines??page.report?.lines;
  const base={renderPath:page.renderPath,missingGlyphs:unknown('ACTUAL_GLYPH_COVERAGE_NOT_MEASURED'),missingText:unknown('RENDERED_TEXT_NOT_INDEPENDENTLY_VERIFIED'),
    overflowPixels:unknown('BUBBLE_INTERIOR_NOT_MEASURED'),forcedClipping:unknown('CLIPPING_NOT_MEASURED'),minimumSizePass:unknown('READABILITY_THRESHOLD_NOT_HUMAN_DEFINED'),
    longKorean:unknown('LONG_KOREAN_LAYOUT_NOT_REVIEWED'),verticalRotated:unknown('TEXT_ORIENTATION_NOT_REVIEWED'),userEditRerender:unknown('USER_EDIT_RENDER_PATH_NOT_RECORDED'),
    fontLoadedRecords:unknown('TYPESETTING_REPORT_NOT_AVAILABLE'),translationRenderIdMatch:unknown('TYPESETTING_OR_TRANSLATION_NOT_AVAILABLE')};
  if(page.renderPath!=='engine_png')return {...base,evidenceScope:'ENGINE_REPORT_DOES_NOT_MEASURE_CANVAS_OR_UNKNOWN_RENDER_PATH'};
  if(!Array.isArray(layouts) || !Array.isArray(targets)) return base;
  const ids=new Set(targets.map(x=>x.id)),seen=new Set();
  for(const l of layouts) {requireValue(identifier(l.id) && !seen.has(l.id) && ids.has(l.id),'TYPESETTING_LINEAGE_MISMATCH');seen.add(l.id);}
  requireValue(seen.size===ids.size,'TYPESETTING_LINEAGE_MISMATCH');
  const outside=layouts.map(l=>l.raster?.outsideInteriorPixels??null);
  requireValue(outside.every(v=>v===null || Number.isSafeInteger(v) && v>=0),'INVALID_TYPESETTING_MEASUREMENT');
  const allMeasured=outside.every(v=>v!==null),sizes=layouts.map(l=>l.fontSizePx).filter(Number.isFinite);
  return {...base,translationRenderIdMatch:measured(1,'boolean'),fontLoadedRecords:measured(layouts.filter(l=>l.productionFontLoaded===true).length),
    reportedGlyphFontLoadedRecords:measured(layouts.filter(l=>l.glyphFontLoaded===true).length),
    minimumReportedFontSizePx:sizes.length?measured(Math.min(...sizes),'px'):unknown('FONT_SIZE_NOT_REPORTED','px'),
    overflowPixels:layouts.length>0 && allMeasured?{...measured(outside.reduce((s,n)=>s+n,0)),basis:'ENGINE_RASTER_INTERIOR_CLAIM'}
      :{...unknown('BUBBLE_INTERIOR_NOT_MEASURED_FOR_ALL_TARGETS'),measuredTargets:outside.filter(v=>v!==null).length,totalTargets:layouts.length,observedSubtotal:outside.reduce((s,v)=>s+(v??0),0)},
    evidenceScope:'BOUND_ENGINE_REPORT_CLAIMS_NOT_INDEPENDENT_GLYPH_AUDIT'};
}

function span(value) {return value && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && value.start>=0 && value.end>=value.start;}
export function evaluateAssessment(page,dataset) {
  const pending={semantic:{majorCriticalErrors:unknown('INDEPENDENT_HUMAN_SOURCE_GT_REQUIRED'),allErrors:unknown('INDEPENDENT_HUMAN_SOURCE_GT_REQUIRED'),opinionOrigin:null,labels:[]},
    humanReview:{status:'missing',reason:'QUALITY_REVIEW_NOT_SUPPLIED'},humanAudit:null,imageLabels:[],typesettingLabels:[]};
  if(page.assessmentArtifactId === null) return pending;
  const artifact=page.artifacts.get(page.assessmentArtifactId);requireValue(artifact?.kind==='assessment','ASSESSMENT_ARTIFACT_MISMATCH');
  const a=artifact.json;keys(a,['schemaVersion','identity','subjectArtifactId','subjectSha256','actor','reviewerId','annotationSha256','reviewedAt','axes','errors','complete'],'INVALID_QUALITY_ASSESSMENT');
  requireValue(a.schemaVersion===1 && equal(a.identity,page.binding) && ['human','ai'].includes(a.actor) && typeof a.complete==='boolean'
    && Array.isArray(a.axes) && new Set(a.axes).size===a.axes.length && a.axes.every(x=>['semantic','image','typesetting'].includes(x)) && Array.isArray(a.errors)
    && Number.isFinite(Date.parse(a.reviewedAt)),'INVALID_QUALITY_ASSESSMENT');
  const subject=page.artifacts.get(a.subjectArtifactId);
  requireValue(subject?.sha256===a.subjectSha256,'QUALITY_SUBJECT_HASH_MISMATCH');
  const targets=new Map((page.get('translations')?.json?.lines??page.report?.lines??[]).map(x=>[x.id,x]));
  const observedGroups=new Map((page.get('final_ocr')?.json?.speechBubbles??page.get('raw_ocr')?.json?.speechBubbles??[]).map(x=>[x.id,x]));
  const labels=[];
  for(const e of a.errors) {
    keys(e,['axis','type','severity','targetId','sourceSpan','candidateSpan','rationale','evidenceArtifactIds'],'INVALID_QUALITY_LABEL');
    requireValue(a.axes.includes(e.axis) && ({semantic:SEMANTIC_ERRORS,image:IMAGE_ERRORS,typesetting:TYPESETTING_ERRORS})[e.axis]?.includes(e.type)
      && SEVERITIES.includes(e.severity) && typeof e.rationale==='string' && e.rationale.length>0 && e.rationale.length<=4096
      && Array.isArray(e.evidenceArtifactIds) && e.evidenceArtifactIds.length>0 && e.evidenceArtifactIds.every(id=>page.artifacts.has(id)),'INVALID_QUALITY_LABEL');
    requireValue(e.targetId===null || targets.has(e.targetId) || observedGroups.has(e.targetId),'QUALITY_TARGET_MISMATCH');
    if(e.axis==='semantic') {
      requireValue(e.targetId!==null && span(e.sourceSpan) && span(e.candidateSpan),'INVALID_QUALITY_SPAN');
      const target=targets.get(e.targetId),group=observedGroups.get(e.targetId);
      const source=target?.sourceText??group?.text,candidate=target?.aiTranslation;
      if(typeof source==='string')requireValue(e.sourceSpan.end<=[...source].length,'INVALID_QUALITY_SPAN');
      if(typeof candidate==='string')requireValue(e.candidateSpan.end<=[...candidate].length,'INVALID_QUALITY_SPAN');
    } else requireValue(e.sourceSpan===null && e.candidateSpan===null,'INVALID_QUALITY_SPAN');
    labels.push({axis:e.axis,type:e.type,severity:e.severity,targetId:e.targetId,sourceSpan:e.sourceSpan,candidateSpan:e.candidateSpan,evidenceArtifactIds:e.evidenceArtifactIds,
      confirmed:false,origin:a.actor});
  }
  if(a.actor==='ai') {
    requireValue(a.reviewerId===null && a.annotationSha256===null,'AI_CANNOT_ATTEST_HUMAN_GT');
    return {...pending,semantic:{...pending.semantic,opinionOrigin:'ai',labels:labels.filter(e=>e.axis==='semantic')},
      imageLabels:labels.filter(e=>e.axis==='image'),typesettingLabels:labels.filter(e=>e.axis==='typesetting'),humanReview:{status:'pending',reason:'AI_OPINION_IS_NOT_HUMAN_REVIEW'}};
  }
  requireValue(page.annotation.status==='human_verified' && a.annotationSha256===page.datasetPage.annotation.sha256,'HUMAN_GT_REQUIRED_FOR_QUALITY_SCORE');
  const reviewer=dataset.reviewers.find(r=>r.reviewerId===a.reviewerId);
  requireValue(reviewer?.kind==='human' && reviewer.languages.includes('ja') && reviewer.languages.includes('ko'),'HUMAN_REVIEWER_REQUIRED');
  requireValue(['candidate','final_png'].includes(subject.kind),'HUMAN_REVIEW_FINAL_RESULT_REQUIRED');
  for(const e of labels) {
    if(e.axis==='semantic') requireValue(targets.has(e.targetId) && typeof targets.get(e.targetId).sourceText==='string' && typeof targets.get(e.targetId).aiTranslation==='string','HUMAN_REVIEW_TRANSLATION_REQUIRED');
    e.confirmed=e.severity!=='uncertain';
  }
  const semanticLabels=labels.filter(e=>e.axis==='semantic'),known=a.complete && a.axes.includes('semantic') && !semanticLabels.some(e=>!e.confirmed);
  const major=labels.filter(e=>e.confirmed && ['major','critical'].includes(e.severity)).length;
  return {semantic:{majorCriticalErrors:known?measured(semanticLabels.filter(e=>e.confirmed && ['major','critical'].includes(e.severity)).length):unknown('SEMANTIC_ASSESSMENT_INCOMPLETE'),
    allErrors:known?measured(semanticLabels.length):unknown('SEMANTIC_ASSESSMENT_INCOMPLETE'),opinionOrigin:'human_submitted_review',labels:semanticLabels},
    humanReview:{status:a.complete?'completed':'partial',reason:a.complete?null:'QUALITY_AXES_INCOMPLETE',axes:a.axes,reviewerIdentityAuthenticated:false},
    humanAudit:a.complete && a.axes.length===3 && !labels.some(e=>!e.confirmed)?{verified:true,majorCriticalErrors:major,subjectArtifactId:a.subjectArtifactId,subjectSha256:a.subjectSha256,basis:'HASH_BOUND_HUMAN_REVIEW_SUBMISSION_NOT_IDENTITY_AUTHENTICATION'}:null,
    imageLabels:labels.filter(e=>e.axis==='image'),typesettingLabels:labels.filter(e=>e.axis==='typesetting')};
}
