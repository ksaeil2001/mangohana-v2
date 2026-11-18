'use strict';
const {createHash}=require('node:crypto'),{createBackgroundScene,normalizeManualEntries,layoutTextMatches,bounds,inside,overlaps}=require('./background-layout.cjs');
const sha=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex'),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const must=(v,code='LAYOUT_EXECUTION_BINDING_INVALID')=>{if(!v)throw Object.assign(Error(code),{code});};
const {layoutPlanDigest}=require('./layout-roi-contract.cjs');
function checkLayoutBinding(inputs,permit){
 const layout=inputs.layoutReview,expected=permit.binding.layoutReviewSha256;
 if(layout===undefined){must(expected===undefined);return null;}
 must(hex(expected)&&sha(layout)===expected&&permit.binding.layoutRevision===layout.layoutRevision&&layout.version===1&&Number.isSafeInteger(layout.layoutRevision)&&Array.isArray(layout.entries));
 if(layout.state==='UNREVIEWED'){must(layout.layoutRevision===0&&layout.entries.length===0&&layout.source===null&&layout.planSha256===null);return layout;}
 must(layout.state==='APPROVED_SOURCE_LAYOUT_CLEANED_PENDING'&&layout.layoutRevision>0&&layout.entries.length>0&&layout.entries.length<=128&&hex(layout.sourceReviewFingerprint)&&hex(layout.planSha256)&&layout.planSha256===layoutPlanDigest(layout.sourceReviewFingerprint,layout.entries,layout.roiExpansion));
 if(layout.roiExpansion)must(permit.executionMode==='TYPESETTING_ONLY'&&inputs.typesettingSource?.layoutAdapter?.layoutReviewSha256===sha(layout)&&inputs.typesettingSource.layoutAdapter.roiReceiptSha256===layout.roiExpansion.receiptSha256,'ROI_EXECUTION_AUTHORITY_INVALID');
 must(layout.approval?.kind==='USER_REVIEWED_LAYOUT_SOURCE'&&['sourceReviewed','maskReviewed','artworkReviewed','translationPreserved'].every(k=>layout.approval[k]===true)&&layout.approval.cleanedVerified===false&&layout.approval.imageExecutionAuthorized===false);
 return layout;
}
function nativeEntries(inputs,maskEvidence,fontSha256){
 const layout=inputs.layoutReview;if(!layout?.entries.length)return [];
 must(layout.source.sourceSha256===inputs.current.sourceSha256&&layout.source.normalizedSha256===inputs.current.normalizedSha256&&layout.source.checkpointSha256===inputs.source.checkpointSha256&&layout.source.maskSha256===maskEvidence.maskSha256&&layout.source.fontSha256===fontSha256&&layout.source.width===maskEvidence.width&&layout.source.height===maskEvidence.height,'LAYOUT_SOURCE_STALE');
 return normalizeManualEntries(layout.entries,maskEvidence.layoutRegions.map(r=>({...r,text:inputs.lines.find(l=>l.id===r.id)?.userTranslation})),maskEvidence.width,maskEvidence.height);
}
// A separate, non-painting pass over ACTUAL cleaned pixels. It uses the same
// production geometry and background contracts as Stage12; text/raster gates
// remain pending. No source-only result is promoted to cleaned verification.
function inspectCleanedBackgrounds({inputs,maskEvidence,manualEntries,sourcePixels,cleanedPixels,maskPixels,cleanedSha256,inferCandidateBox,renderLines=inputs.lines}){
 const {width,height}=maskEvidence,rows=inputs.lines;
 must(typeof inferCandidateBox==='function'&&rows.length===13&&new Set(rows.map(r=>r.id)).size===13,'IMPORTED_IMAGE_REGION_MISMATCH');
 const scene=createBackgroundScene({sourcePixels,cleanedPixels,maskPixels,width,height,sourceSha256:inputs.current.normalizedSha256,cleanedSha256,maskSha256:maskEvidence.maskSha256});
 const sourceBoxes=rows.map(r=>({id:r.id,bbox:r.bbox})),otherBoxes=[...sourceBoxes,...manualEntries.map(r=>({id:r.id,bbox:r.bbox})),...maskEvidence.extraction.nonSpeechText.map((r,i)=>({id:'protected-'+i,bbox:r.bbox}))];
 const context={getImageData(left,top,w,h){const data=new Uint8ClampedArray(w*h*4);for(let y=0;y<h;y++)data.set(cleanedPixels.subarray(((top+y)*width+left)*4,((top+y)*width+left+w)*4),y*w*4);return {data};}};
 const summary=i=>i?{left:i.left,top:i.top,width:i.width,height:i.height,safePixels:i.mask.reduce((n,v)=>n+(v?1:0),0)}:null;
 const priority=r=>r.order===2?0:r.order===4?1:2,ordered=[...rows].sort((a,b)=>priority(a)-priority(b)||a.order-b.order),regions=[];
 for(const row of ordered){const manual=manualEntries.find(m=>m.id===row.id),allowed=maskEvidence.layoutRegions.find(r=>r.id===row.id)?.allowedBbox;
  const region={id:row.id,order:row.order,sourceBbox:{...row.bbox},candidateBbox:null,manualApproved:!!manual,manualApprovalSha256:manual?inputs.layoutReview?.planSha256:null,backgroundStatus:'MANUAL_LAYOUT_REQUIRED',basis:null,reasonCodes:[],background:null,whiteSearch:null,uniformFallback:null,interior:null,textFitStatus:'PENDING',finalRasterStatus:'PENDING',humanImageQualityVerified:false};
  try{
   must(allowed,'IMPORTED_IMAGE_REGION_MISMATCH');
   const prepared=renderLines.find(l=>l.id===row.id);must(prepared,'IMPORTED_IMAGE_REGION_MISMATCH');
   const inferred=manual?{bbox:{...manual.bbox},reasons:['USER_REVIEWED_SOURCE_LAYOUT'],expanded:false}:inferCandidateBox(context,{...prepared,userTranslation:undefined,typesetting:{...prepared.typesetting,bbox:{...row.bbox}}},sourceBoxes,width,height,allowed);
   region.candidateBbox={...inferred.bbox};region.whiteSearch={reasons:inferred.reasons,expanded:inferred.expanded,interiorVerified:!!inferred.interior};
   must(inside(inferred.bbox,allowed)&&!otherBoxes.some(r=>r.id!==row.id&&overlaps(inferred.bbox,r.bbox)),'ROI_OR_OTHER_REGION_CONFLICT');
   const options={id:row.id,bbox:manual?.bbox??row.bbox,allowedBbox:manual?allowed:row.bbox,otherBoxes,approvalSha256:inputs.layoutReview?.planSha256};
   const fallback=manual?scene.inspectManual(options):scene.inspectUniform(options);
   region.uniformFallback={status:fallback.status,reasonCodes:fallback.reasonCodes,evidence:fallback.evidence};
   if(!manual&&inferred.interior){region.backgroundStatus='SAFE_PIXELS_VERIFIED';region.basis='CLOSED_WHITE_COMPONENT_INSET_RECTANGLE';region.interior=summary(inferred.interior);}
   else{region.backgroundStatus=fallback.status;region.basis=fallback.evidence.basis;region.reasonCodes=fallback.reasonCodes;region.background=fallback.evidence;region.interior=summary(fallback.interior);region.candidateBbox={...(manual?.bbox??row.bbox)};}
  }catch(error){region.reasonCodes=[error.code??'BACKGROUND_INSPECTION_FAILED'];region.exception={code:error.code??null,message:String(error.message).slice(0,1000)};}
  regions.push(region);
 }
 return {version:4,stage:'before-typeset-backgrounds',cleanedSha256,inspectionOrder:ordered.map(r=>r.order),regions:regions.sort((a,b)=>a.order-b.order),blocked:regions.filter(r=>r.backgroundStatus!=='SAFE_PIXELS_VERIFIED').length,textFitStatus:'PENDING',finalRasterStatus:'PENDING'};
}
function verifyRenderedBackgrounds({layouts,inputs,maskEvidence,manualEntries,sourcePixels,cleanedPixels,maskPixels,finalPixels,cleanedSha256}){
 const width=maskEvidence.width,height=maskEvidence.height,scene=createBackgroundScene({sourcePixels,cleanedPixels,maskPixels,width,height,sourceSha256:inputs.current.normalizedSha256,cleanedSha256,maskSha256:maskEvidence.maskSha256}),backgroundChecks=new Map(),allowed=new Uint8Array(width*height);
 const otherBoxes=[...inputs.lines.map(r=>({id:r.id,bbox:r.bbox})),...manualEntries.map(r=>({id:r.id,bbox:r.bbox})),...maskEvidence.extraction.nonSpeechText.map((r,i)=>({id:'protected-'+i,bbox:r.bbox}))];
 for(const l of layouts){const row=inputs.lines.find(r=>r.id===l.id);must(row&&same(l.sourceBbox,row.bbox),'TYPESET_BBOX_MISMATCH');const manual=manualEntries.find(r=>r.id===l.id),basis=l.safeAreaEvidence?.basis;
  if(manual)must(same(l.bbox,manual.bbox)&&l.fontSizePx===manual.fontSizePx&&l.manualLayoutApprovalSha256===inputs.layoutReview.planSha256&&basis==='USER_REVIEWED_PROTECTED_ROI_RECTANGLE'&&l.textEvidence?.sourceText===manual.text&&layoutTextMatches(manual.text,l.actualLayout?.lines.map(r=>r.text).join('\n')),'MANUAL_LAYOUT_RESULT_MISMATCH');
  if(manual&&inputs.layoutReview?.roiExpansion)must(same(manual.text.replace(/\r\n?/g,'\n').split('\n'),l.actualLayout?.lines?.map(r=>r.text)),'MANUAL_LAYOUT_RESULT_MISMATCH');
  if(basis==='CLOSED_WHITE_COMPONENT_INSET_RECTANGLE'){
   must(inside(l.bbox,maskEvidence.layoutRegions?.find(r=>r.id===l.id)?.allowedBbox??row.bbox),'TYPESET_BBOX_MISMATCH');
   const b=bounds(l.bbox,width,height);must(b.left>=0&&b.top>=0&&b.left+b.width<=width&&b.top+b.height<=height,'TYPESET_BBOX_MISMATCH');
   for(let y=b.top;y<b.top+b.height;y++)for(let x=b.left;x<b.left+b.width;x++){const i=y*width+x,at=i*4;if(cleanedPixels[at+3]>=250&&Math.min(cleanedPixels[at],cleanedPixels[at+1],cleanedPixels[at+2])>=240)allowed[i]=1;}
  }else{
   must(manual||same(l.bbox,row.bbox),'TYPESET_BBOX_MISMATCH');const options={id:l.id,bbox:manual?.bbox??row.bbox,allowedBbox:manual?maskEvidence.layoutRegions.find(r=>r.id===l.id).allowedBbox:row.bbox,otherBoxes,approvalSha256:inputs.layoutReview?.planSha256};
   const proof=manual?scene.inspectManual(options):scene.inspectUniform(options);must(proof.status==='SAFE_PIXELS_VERIFIED'&&proof.interior,'MANUAL_LAYOUT_REQUIRED');backgroundChecks.set(l.id,proof);
   const {mask,left,top,width:w,height:h}=proof.interior;for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(mask[y*w+x])allowed[(top+y)*width+left+x]=1;
  }
 }
 must(finalPixels.length===cleanedPixels.length,'TYPESET_FRAME_INVALID');let changedPixels=0;
 for(let i=0;i<allowed.length;i++){const at=i*4;must(finalPixels[at+3]===cleanedPixels[at+3],'TYPESET_ALPHA');if([0,1,2].some(k=>finalPixels[at+k]!==cleanedPixels[at+k])){must(allowed[i]===1,'TYPESET_PROTECTED_PIXEL_CHANGED');changedPixels++;}}
 must(changedPixels>0,'TYPESET_EMPTY_OUTPUT');return {backgroundChecks,independentPixels:{status:'PASS',changedPixels,changedOutsideVerifiedAreas:0,originalOutsideRemovalMaskPreserved:true}};
}
module.exports={checkLayoutBinding,nativeEntries,inspectCleanedBackgrounds,verifyRenderedBackgrounds};
