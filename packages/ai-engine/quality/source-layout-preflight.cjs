'use strict';
// Pure source/mask planning and font-measurement contract. Never creates cleaned pixels.
const {createBackgroundScene,footprintFits,normalizeManualEntries,overlaps,bounds,inside}=require('./background-layout.cjs');
const {requiresSingleUtteranceLine}=require('./korean-utterance.cjs');
const {evaluateKoreanTypesetting,VERSION}=require('./korean-typesetting-standard.cjs');
const must=(v,code)=>{if(!v)throw Object.assign(Error(code),{code});};
function planSourceLayouts({sourcePixels,maskPixels,width,height,sourceSha256,maskSha256,regions,manualEntries=[],protectedBoxes=[],inferCandidateBox,fontGlyphsVerified=false,reviewedWarnings}){
 must(typeof inferCandidateBox==='function'&&Array.isArray(regions)&&regions.length>0&&new Set(regions.map(r=>r.id)).size===regions.length,'SOURCE_LAYOUT_INPUT_INVALID');
 const scene=createBackgroundScene({sourcePixels,maskPixels,width,height,sourceSha256,maskSha256});
 const manual=manualEntries.length?normalizeManualEntries(manualEntries,regions,width,height):[];
 const otherBoxes=[...regions.map(r=>({id:r.id,bbox:r.bbox})),...manual.map(r=>({id:r.id,bbox:r.bbox})),...protectedBoxes.map((bbox,i)=>({id:'protected-'+i,bbox}))];
 const plans=regions.map(r=>{
  const entry=manual.find(e=>e.id===r.id),options={id:r.id,bbox:entry?.bbox??r.bbox,allowedBbox:entry?r.allowedBbox:r.bbox,otherBoxes};
  const uniform=scene.inspectUniform(options),review=entry?scene.inspectManual(options):null;
  const inferred=entry?null:inferCandidateBox({getImageData(left,top,w,h){
   const data=new Uint8ClampedArray(w*h*4);
   for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(top+y)*width+left+x,j=(y*w+x)*4;
    // A logical maximum of white possibilities only, not restored image evidence.
    data.set(maskPixels[i*4+3]===0?[255,255,255,sourcePixels[i*4+3]]:sourcePixels.subarray(i*4,i*4+4),j);}
   return{data};
  }},{id:r.id,order:r.order,pageNumber:1,sourceText:r.sourceText,aiTranslation:r.text,typesetting:{bbox:{...r.bbox},writingMode:'horizontal-tb'}},otherBoxes,width,height,r.allowedBbox??r.bbox);
  const background=entry?'MANUAL_APPROVED_SOURCE':inferred?.interior?'CLOSED_WHITE_LOGICAL_UPPER_BOUND':uniform.sourceReviewable?'UNIFORM_SOURCE_BACKGROUND':'UNPROVEN';
  const bbox=entry?.bbox??(inferred?.interior?inferred.bbox:r.bbox),interior=entry?review.previewInterior:inferred?.interior??uniform.previewInterior;
  const b=bounds(r.bbox,width,height);let editablePixels=0,protectedNonwhitePixels=0;
  for(let y=b.top;y<b.top+b.height;y++)for(let x=b.left;x<b.left+b.width;x++){const at=(y*width+x)*4;if(maskPixels[at+3]===0)editablePixels++;else if(Math.min(...sourcePixels.subarray(at,at+3))<240)protectedNonwhitePixels++;}
  return{region:r,entry,bbox,interior,background,sourceReviewable:entry?review.sourceReviewable:!!inferred?.interior||uniform.sourceReviewable,
   uniformEvidence:uniform.evidence,uniformReasons:uniform.reasonCodes,whiteReasons:inferred?.reasons??[],
   otherRoiIds:regions.filter(o=>o.id!==r.id&&overlaps(o.bbox,r.bbox)).map(o=>o.id),editablePixels,protectedNonwhitePixels,
   measurementEntry:{id:r.id,bbox:{...bbox},text:entry?.text??r.text,...(entry?{fontSizePx:entry.fontSizePx,lineHeight:entry.lineHeight}:{})}};
 });
 return{version:1,width,height,plans,measurementEntries:plans.map(p=>p.measurementEntry),sourceSha256,maskSha256,fontGlyphsVerified,reviewedWarnings};
}
function intraWordBreaks(source,lines){let cursor=0,count=0;for(let i=0;i<lines.length;i++){while(/\s/u.test(source[cursor]??'\0'))cursor++;cursor+=lines[i].text.length;if(i+1<lines.length&&source[cursor]&&!/\s/u.test(source[cursor]))count++;}return count;}
function finishSourcePreflight(plan,measurement){
 const measured=measurement?.entries;must(Array.isArray(measured)&&measured.length===plan.plans.length&&new Set(measured.map(m=>m.id)).size===measured.length&&measured.every(m=>plan.plans.some(p=>p.region.id===m.id)),'SOURCE_LAYOUT_MEASUREMENT_MISMATCH');
 const regions=plan.plans.map(p=>{
  const m=measured.find(m=>m.id===p.region.id),reasons=[],lines=m.layout?.lines,breaks=Array.isArray(lines)?intraWordBreaks(p.measurementEntry.text,lines):null;
  const roiValid=inside(p.bbox,p.region.allowedBbox??p.region.bbox);if(!roiValid)reasons.push('AUTO_CANDIDATE_OUTSIDE_ALLOWED_ROI');
  if(!p.sourceReviewable)reasons.push('AUTO_BACKGROUND_UNPROVEN');
  const footprintVerified=!!p.interior&&footprintFits(p.interior,m.inkBounds);
  const invalidFit=!Number.isFinite(m.fontSizePx)||m.fontSizePx<=12||m.completeText!==true||m.fitsBox!==true||m.linesSeparated!==true||!Array.isArray(lines)||!lines.length;
  const split=requiresSingleUtteranceLine(p.region.text)&&(!Array.isArray(lines)||lines.length!==1||lines[0].text!==p.region.text);
  if(invalidFit)reasons.push('SOURCE_FONT_OR_TEXT_FIT_BLOCKED');
  if(split)reasons.push('SINGLE_UTTERANCE_SPLIT');
  if(!footprintVerified)reasons.push('SOURCE_FOOTPRINT_UNVERIFIED');
  if(!p.entry&&breaks>0)reasons.push('INTRA_WORD_BREAK_REVIEW');
  const standard=evaluateKoreanTypesetting({text:p.region.text,lines:lines?.map(l=>l.text),stage:'SOURCE_METRICS',fontSizePx:m.fontSizePx,lineHeight:p.entry?.lineHeight??(lines?.length>1?(lines[1].relativeY-lines[0].relativeY)*p.bbox.height*plan.height/m.fontSizePx:1.3),shape:'rectangle',measurement:m,
   safety:{safeAreaVerified:!roiValid?false:p.sourceReviewable?footprintVerified:undefined,otherRegionCollision:p.otherRoiIds.length>0,protectedArtworkCollision:false},glyphs:plan.fontGlyphsVerified?{supported:true,missingGlyphOccurrences:0}:{},
   mapping:{expectedId:p.region.id,actualId:m.id,expectedOrder:p.region.order??0,actualOrder:p.region.order??0}});
  if(standard.status==='BLOCKED')reasons.push(...standard.hardViolations.map(v=>v.rule+':'+v.code));
  const warned=standard.softWarnings.map(v=>v.code),record=plan.reviewedWarnings;
  const warningsReviewed=!!p.entry&&record?.version===VERSION&&warned.every(code=>record.regions?.find(r=>r.id===p.region.id)?.codes?.includes(code));
  if(standard.status==='WARN'&&!warningsReviewed)reasons.push('KOREAN_STANDARD_SOFT_REVIEW');
  const sourceStatus=invalidFit||split||standard.status==='BLOCKED'?'DEFINITE_BLOCKER':reasons.length?'MANUAL_REVIEW_REQUIRED':'SOURCE_PREFLIGHT_PASS';
  return{id:p.region.id,order:p.region.order,text:p.region.text,sourceBbox:p.region.bbox,candidateBbox:p.bbox,allowedBbox:p.region.allowedBbox,otherRoiIds:p.otherRoiIds,
   sourceStatus,cleanedValidation:'CLEANED_VALIDATION_PENDING',requiresManualReview:sourceStatus!=='SOURCE_PREFLIGHT_PASS',manualApproved:!!p.entry,background:p.background,
   uniformSourceEvidence:p.uniformEvidence,uniformReasons:p.uniformReasons,whiteReasons:p.whiteReasons,editablePixels:p.editablePixels,protectedNonwhitePixels:p.protectedNonwhitePixels,
   fontSizePx:m.fontSizePx,completeText:m.completeText,fitsBox:m.fitsBox,linesSeparated:m.linesSeparated,renderedLines:lines?.map(l=>l.text)??null,intraWordBreaks:breaks,sourceFootprintVerified:footprintVerified,
   fitStatus:null,actualRasterVerified:false,actualCleanedVerified:false,reasonCodes:reasons,standard,warningsReviewed,measurement:m};
 });
 return{version:1,kind:'SOURCE_ONLY_ALL_REGION_LAYOUT_PREFLIGHT',status:regions.some(r=>r.requiresManualReview)?'BLOCKED':'SOURCE_PREFLIGHT_PASS',actualCleanedVerified:false,actualImageQualityVerified:false,
  regions,blockers:regions.filter(r=>r.requiresManualReview).map(r=>({id:r.id,order:r.order,sourceStatus:r.sourceStatus,reasonCodes:r.reasonCodes})),measurement:{fontLoaded:measurement.fontLoaded??null,paintCalls:measurement.paintCalls??null,encodeCalls:measurement.encodeCalls??null}};
}
module.exports={planSourceLayouts,finishSourcePreflight};
