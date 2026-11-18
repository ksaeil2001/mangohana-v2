'use strict';
// Output-free checks shared by preflight and the separately permitted image worker.
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const {verifySourceTextMask,verifyLearnedMask,protectedOcrRegions}=require('./mask-evidence.cjs');
const {singleUtteranceLineVerified}=require('./korean-utterance.cjs');
const {isGeneralKorean,inspectKoreanText,evaluateKoreanTypesetting,VERSION}=require('./korean-typesetting-standard.cjs');
const sha=b=>createHash('sha256').update(b).digest('hex');
const must=(ok,code='IMPORTED_IMAGE_INVALID')=>{if(!ok)throw Object.assign(Error('원본·마스크·글꼴·실행 자원을 확인하지 못해 중단했습니다.'),{code});};
function assertExecutionEnvironment(e){
 must(Number.isFinite(e.ramFreeMiB)&&e.ramFreeMiB>=512,'HOST_MEMORY_PRESSURE');must(Number.isFinite(e.vramFreeMiB)&&e.vramFreeMiB>=128,'GPU_MEMORY_PRESSURE');
 must(Number.isFinite(e.diskFreeBytes)&&e.diskFreeBytes>=512*1048576,'OUTPUT_SPACE_LOW');must(e.outputWritable===true,'OUTPUT_WRITE_FAILED');
 must(Array.isArray(e.otherEngineProcesses)&&e.otherEngineProcesses.length===0,'OTHER_ENGINE_RUNNING');must(e.repositoryLocked===false,'IMAGE_EXECUTION_LOCKED');must(e.recoveryAvailable===true,'IMAGE_RECOVERY_UNAVAILABLE');
}
function inspectFontGlyphs(b,text){
 try{
  must(Buffer.isBuffer(b)&&b.length>=28&&b.length<=16*1024*1024,'FONT_UNAVAILABLE');let cmap;const tables=[];
  for(let i=0;i<b.readUInt16BE(4);i++){const at=12+i*16;if(b.toString('ascii',at,at+4)==='cmap')cmap=b.readUInt32BE(at+8);}
  must(cmap!==undefined,'FONT_UNAVAILABLE');
  for(let i=0;i<b.readUInt16BE(cmap+2);i++){const at=cmap+4+i*8,p=b.readUInt16BE(at),e=b.readUInt16BE(at+2),o=cmap+b.readUInt32BE(at+4),format=b.readUInt16BE(o);if((p===0||p===3&&[1,10].includes(e))&&[4,12].includes(format))tables.push({o,format});}
  must(tables.length>0,'FONT_UNAVAILABLE');
  function glyph(cp){for(const {o,format}of tables){if(format===12){let low=0,high=b.readUInt32BE(o+12)-1;while(low<=high){const n=(low+high)>>1,a=o+16+n*12,start=b.readUInt32BE(a),end=b.readUInt32BE(a+4);if(cp<start)high=n-1;else if(cp>end)low=n+1;else if(b.readUInt32BE(a+8)+cp-start)return true;else break;}}
   else if(cp<=65535){const n=b.readUInt16BE(o+6)/2,end=o+14,start=end+n*2+2,delta=start+n*2,range=delta+n*2;for(let i=0;i<n;i++)if(cp<=b.readUInt16BE(end+i*2)){const first=b.readUInt16BE(start+i*2);if(cp<first)break;const r=b.readUInt16BE(range+i*2),d=b.readInt16BE(delta+i*2);let g=r?b.readUInt16BE(range+i*2+r+(cp-first)*2):(cp+d)&65535;if(r&&g)g=(g+d)&65535;if(g)return true;break;}}}return false;}
  const points=[...new Set([...text].filter(c=>!/^\s$/u.test(c)).map(c=>c.codePointAt(0)))],missing=points.filter(cp=>!glyph(cp));must(!missing.length,'FONT_GLYPH_MISSING');
  return {fontIdentity:'Pretendard Std Variable@1.3.9',sha256:sha(b),uniqueCodepoints:points.length,missing:[],cmapFormats:[...new Set(tables.map(t=>t.format))],canvasGlyphValidation:'REQUIRED_AFTER_APPROVAL'};
 }catch(e){if(e.code)throw e;throw Object.assign(Error('한글 글꼴 cmap을 읽지 못했습니다.'),{code:'FONT_UNAVAILABLE'});}
}
async function verifyImportedMask({sourceDirectory,inputs,expectedAlgorithm,read=fs.readFile}){
 const sharp=require('sharp');must(inputs?.status==='IMPORTED_PAGE_INPUTS_READY'&&inputs.lines.length===13,'IMAGE_INPUTS_REQUIRED');
 const cpBytes=await read(path.join(sourceDirectory,'checkpoint-ocr.json'));must(sha(cpBytes)===inputs.source.checkpointSha256,'IMPORTED_MASK_SOURCE_CHANGED');
 const payload=JSON.parse(cpBytes).payload;must(payload&&sha(JSON.stringify(payload))===inputs.source.payloadSha256,'IMPORTED_MASK_SOURCE_CHANGED');
 const e=payload.extraction,selection=payload.regionSelection,detection=payload.regionDetection,normalized=await read(path.join(sourceDirectory,'normalized.png'));
 must(sha(normalized)===inputs.current.normalizedSha256,'IMPORTED_PAGE_IMAGE_MISMATCH');
 const original=await read(path.join(sourceDirectory,'source.png'));must(sha(original)===inputs.current.sourceSha256,'IMPORTED_PAGE_IMAGE_MISMATCH');
 const frame=await sharp(normalized,{limitInputPixels:12_000_000}).metadata(),originalFrame=await sharp(original,{limitInputPixels:12_000_000}).metadata();
 const {width,height}=frame;must(frame.format==='png'&&originalFrame.format==='png'&&width===detection.width&&height===detection.height&&width===originalFrame.width&&height===originalFrame.height&&(!frame.pages||frame.pages===1),'IMPORTED_MASK_FRAME');
 const selectedIds=inputs.lines.map(l=>l.id);must(new Set(selectedIds).size===13&&e.speechBubbles.length===13&&e.speechBubbles.every(g=>inputs.lines.some(l=>l.id===g.id&&l.sourceText===g.text&&JSON.stringify(l.bbox)===JSON.stringify(g.bbox))),'IMPORTED_MASK_REGIONS');
 const ids=[...new Set(selection.decisions.filter(d=>d.action==='translate').map(d=>d.detectorRegionId))],regions=ids.map(id=>{const r=detection.regions.find(r=>r.id===id&&r.kind==='text_bubble');must(r,'IMPORTED_MASK_ROI');return {id,bbox:r.bbox};});
 const bytes=await read(path.join(sourceDirectory,'removal-mask.png')),grayBytes=await read(path.join(sourceDirectory,'removal-mask-learned-gray.png'));
 const reply=JSON.parse(await read(path.join(sourceDirectory,'learned-mask-evidence.json'))),sourceEvidence=JSON.parse(await read(path.join(sourceDirectory,'source-mask-evidence.json')));
 const bitmap=await sharp(bytes,{limitInputPixels:12_000_000}).ensureAlpha().raw().toBuffer(),grayBitmap=await sharp(grayBytes,{limitInputPixels:12_000_000}).ensureAlpha().raw().toBuffer();
 const protectedRegions=protectedOcrRegions(payload.preSelectionExtraction,selection),protection=verifyLearnedMask({reply,request:{imageSha256:inputs.current.normalizedSha256,width,height,regions},bytes,grayBytes,bitmap,grayBitmap,protectedRegions,expectedAlgorithm});
 const identity={version:1,jobId:JSON.parse(cpBytes).jobId,pageNumber:e.pageNumber,sourceImageSha256:inputs.current.normalizedSha256,ocrSha256:sha(JSON.stringify(e)),coordinateSpace:'normalized-page-pixels',width,height};
 const sourceMask=verifySourceTextMask({bytes,bitmap,identity:sourceEvidence.identity,expectedIdentity:identity,expectedPixels:protection.maskedPixels,
  allowedRegions:e.speechBubbles.map(r=>({id:r.id,bbox:r.bbox,paddingPx:Math.ceil(Math.min(r.bbox.width*width,r.bbox.height*height)*.5)+5})),protectedRegions});
 must(sourceEvidence.maskSha256===sourceMask.maskSha256&&sourceEvidence.maskedPixels===sourceMask.maskedPixels&&reply.regions.every(r=>JSON.stringify(r.sourceDialogueIds)===JSON.stringify(selection.decisions.filter(d=>d.action==='translate'&&d.detectorRegionId===r.id).map(d=>d.id))),'IMPORTED_MASK_EVIDENCE');
 const layoutRegions=e.speechBubbles.map(g=>{const decision=selection.decisions.find(d=>d.id===g.id&&d.action==='translate'),roi=detection.regions.find(r=>r.id===decision?.detectorRegionId);must(roi,'IMPORTED_MASK_ROI');const a=g.bbox,b=roi.bbox,x=Math.min(a.x,b.x),y=Math.min(a.y,b.y);return {id:g.id,bbox:{...a},allowedBbox:{x,y,width:Math.min(1,Math.max(a.x+a.width,b.x+b.width))-x,height:Math.min(1,Math.max(a.y+a.height,b.y+b.height))-y}};});
 return {status:'VALIDATED_EXISTING_MASK',width,height,maskSha256:sha(bytes),graySha256:sha(grayBytes),evidenceSha256:sha(JSON.stringify(reply)),sourceEvidenceSha256:sha(JSON.stringify(sourceEvidence)),sourceMask,protection,layoutRegions,
  artworkSemanticVerification:null,humanMaskApproval:false,sourceGeneration:inputs.source.processingGeneration,maskModelCalls:0,extraction:e};
}
const compact=text=>text.replace(/\s/gu,'');
function safeAreaVerified(l,context){
 if(l?.safeAreaEvidence?.basis==='CLOSED_WHITE_COMPONENT_INSET_RECTANGLE')return true;
 const basis=l?.safeAreaEvidence?.basis,verified=context?.backgroundChecks?.get(l?.id);
 return ['UNIFORM_BACKGROUND_INSET_RECTANGLE','USER_REVIEWED_PROTECTED_ROI_RECTANGLE'].includes(basis)&&verified?.status==='SAFE_PIXELS_VERIFIED'&&verified.evidence?.basis===basis&&verified.evidence.cleanedVerified===true&&
  JSON.stringify(verified.evidence)===JSON.stringify(l.safeAreaEvidence.background)&&verified.paint?.color===l.paint?.color&&verified.paint?.strokeColor===l.paint?.strokeColor;
}
function layoutStandard(l,rows,list,context){
 const row=rows.find(r=>r?.id===l?.id);if(typeof row?.userTranslation!=='string')return null;
 const scope={text:row.userTranslation,writingMode:row.typesetting?.writingMode??'horizontal-tb',shape:row.typesetting?.shape??'rectangle',dialogueType:row.dialogueType??'speech',rotationDegrees:row.typesetting?.rotationDegrees??0};
 if(!isGeneralKorean(scope))return null;
 return evaluateKoreanTypesetting({...scope,lines:Array.isArray(l.actualLayout?.lines)?l.actualLayout.lines.map(v=>v?.text):null,stage:'FINAL_RASTER',fontSizePx:l.fontSizePx,lineHeight:l.lineHeight??1.3,shape:l.shape??scope.shape,measurement:l.measuredFit,
  safety:{safeAreaVerified:safeAreaVerified(l,context),otherRegionCollision:l.raster?.otherRegionCollisionPixels!==0,protectedArtworkCollision:l.raster?.outsideInteriorPixels!==0},
  glyphs:{supported:l.productionFontLoaded===true&&l.glyphFontLoaded===true,missingGlyphOccurrences:l.glyphEvidence?.missingGlyphOccurrences},
  mapping:{expectedId:row.id,actualId:l.id,expectedOrder:rows.indexOf(row),actualOrder:list.indexOf(l),...(row.speaker!==undefined?{expectedSpeaker:row.speaker,actualSpeaker:l.speaker}:{})},raster:l.raster});
}
function readabilityApproved(l,standard,context){
 if(!standard?.softWarnings.length)return true;
 const review=context?.approvedLayoutReview,entry=review?.entries?.find(e=>e.id===l.id),approval=review?.approval?.typesettingStandard;
 return review?.state==='APPROVED_SOURCE_LAYOUT_CLEANED_PENDING'&&entry&&review.planSha256===l.manualLayoutApprovalSha256&&approval?.version===VERSION&&
  standard.softWarnings.every(v=>approval.regions?.find(r=>r.id===l.id)?.codes?.includes(v.code));
}
function layoutDiagnostics(layouts,lines,rejectedCode,rejectedRegion,context){
 const list=Array.isArray(layouts)?layouts:[],rows=Array.isArray(lines)?lines:[],number=v=>Number.isFinite(v)?v:null,bool=v=>typeof v==='boolean'?v:null,label=v=>typeof v==='string'?v.slice(0,200):null;
 return {version:1,rejectedCode:label(rejectedCode),rejectedRegion:label(rejectedRegion),expectedRegions:Array.isArray(lines)?lines.length:null,observedRegions:Array.isArray(layouts)?layouts.length:null,truncated:list.length>128,
  regions:list.slice(0,128).map(l=>{const row=rows.find(r=>r?.id===l?.id),m=l?.measuredFit,r=l?.raster,actual=l?.actualLayout?.lines;
   const textMatches=Array.isArray(actual)&&actual.every(v=>typeof v?.text==='string')&&typeof row?.userTranslation==='string'?compact(actual.map(v=>v.text).join(''))===compact(row.userTranslation):null;
   const failures=[];if(l?.fitStatus!=='FIT_VERIFIED')failures.push('FIT_STATUS_NOT_VERIFIED');if(!(l?.fontSizePx>12))failures.push('FONT_SIZE_NOT_SAFE');if(m?.completeText!==true)failures.push('COMPLETE_TEXT_NOT_VERIFIED');if(m?.fitsBox!==true)failures.push('BOX_FIT_NOT_VERIFIED');if(m?.linesSeparated!==true)failures.push('LINE_SEPARATION_NOT_VERIFIED');if(!safeAreaVerified(l,context))failures.push('SAFE_AREA_NOT_VERIFIED');if(!singleUtteranceLineVerified(row?.userTranslation,Array.isArray(actual)?actual.map(v=>v?.text):null))failures.push('SINGLE_UTTERANCE_LINE_BREAK');
   if(l?.productionFontLoaded!==true||l?.glyphFontLoaded!==true||l?.glyphEvidence?.missingGlyphOccurrences!==0||l?.textEvidence?.complete!==true)failures.push('FONT_OR_TEXT_NOT_VERIFIED');
   if(!(r?.paintedPixels>0)||['outsideInteriorPixels','clippedPixels','canvasEdgePixels','otherRegionCollisionPixels','overlappingInkPixels'].some(k=>r?.[k]!==0))failures.push('RASTER_BOUNDS_NOT_VERIFIED');if(textMatches!==true)failures.push('SELECTED_TEXT_NOT_VERIFIED');
   const standard=layoutStandard(l,rows,list,context);if(standard)failures.push(...standard.hardViolations.map(v=>v.rule+':'+v.code),...(standard.profile!=='KO_GENERAL_HORIZONTAL_V1'?['GENERAL_PROFILE_CHANGED']:[]),...(!readabilityApproved(l,standard,context)&&standard.status==='WARN'?['READABILITY_REVIEW_REQUIRED']:[]));
   return {id:label(l?.id),fitStatus:label(l?.fitStatus),fontSizePx:number(l?.fontSizePx),productionFontLoaded:bool(l?.productionFontLoaded),glyphFontLoaded:bool(l?.glyphFontLoaded),missingGlyphOccurrences:number(l?.glyphEvidence?.missingGlyphOccurrences),textComplete:bool(l?.textEvidence?.complete),standard,
    measuredFit:{completeText:bool(m?.completeText),fitsBox:bool(m?.fitsBox),linesSeparated:bool(m?.linesSeparated)},safeAreaBasis:label(l?.safeAreaEvidence?.basis),raster:Object.fromEntries(['paintedPixels','outsideInteriorPixels','clippedPixels','canvasEdgePixels','otherRegionCollisionPixels','overlappingInkPixels'].map(k=>[k,number(r?.[k])])),renderedLineCount:Array.isArray(actual)?actual.length:null,selectedTextMatches:textMatches,failures};})};
}
function verifyImportedLayout(layouts,lines,context){
 let rejectedRegion=null;try{
 must(Array.isArray(layouts)&&layouts.length===lines.length&&new Set(layouts.map(l=>l.id)).size===lines.length&&layouts.every((l,i)=>l.id===lines[i].id),'TYPESET_RESULT');
 for(const l of layouts){rejectedRegion=l.id;const row=lines.find(r=>r.id===l.id),r=l.raster,m=l.measuredFit;must(row&&l.productionFontLoaded===true&&l.glyphFontLoaded===true&&l.glyphEvidence?.missingGlyphOccurrences===0&&l.textEvidence?.complete===true,'FONT_OR_GLYPH_ERROR');
  must(l.fitStatus==='FIT_VERIFIED'&&l.fontSizePx>12&&m?.completeText===true&&m.fitsBox===true&&m.linesSeparated===true&&safeAreaVerified(l,context),'MANUAL_LAYOUT_REQUIRED');
  must(singleUtteranceLineVerified(row.userTranslation,Array.isArray(l.actualLayout?.lines)?l.actualLayout.lines.map(v=>v?.text):null),'MANUAL_LAYOUT_REQUIRED');
  // Retain the established specific failure codes before aggregating the new
  // standard. Diagnostics still include every H/S measurement on rejection.
  must(r?.paintedPixels>0&&['outsideInteriorPixels','clippedPixels','canvasEdgePixels','otherRegionCollisionPixels','overlappingInkPixels'].every(k=>r[k]===0),'TYPESET_OVERFLOW');
  must(Array.isArray(l.actualLayout?.lines)&&compact(l.actualLayout.lines.map(v=>v.text).join(''))===compact(row.userTranslation),'TYPESET_TEXT_MISMATCH');
  const standard=layoutStandard(l,lines,layouts,context);
  if(standard){
   must(standard.profile==='KO_GENERAL_HORIZONTAL_V1','MANUAL_LAYOUT_REQUIRED');
   const actual=l.actualLayout?.lines?.map(v=>v.text),check=inspectKoreanText(row.userTranslation,actual);
   must(check.complete,'TYPESET_TEXT_MISMATCH');must(check.intraWordBreaks===0&&!check.punctuationOnlyLines.length&&!check.leadingDetachedPunctuation.length,'MANUAL_LAYOUT_REQUIRED');
   must(standard.status!=='BLOCKED','MANUAL_LAYOUT_REQUIRED');
   must(readabilityApproved(l,standard,context),'MANUAL_LAYOUT_REQUIRED');
  }
  const fixed=context?.approvedLayoutReview?.entries?.find(e=>e.id===l.id);if(fixed)must(l.fontSizePx===fixed.fontSizePx&&l.manualLayoutApprovalSha256===context.approvedLayoutReview.planSha256,'MANUAL_LAYOUT_REQUIRED');
 }
 const standards=layouts.map(l=>({id:l.id,assessment:layoutStandard(l,lines,layouts,context)}));
 return {status:'PASS',standardStatus:standards.some(r=>r.assessment?.status==='WARN')?'WARN':'PASS',standards,regions:lines.length,glyphs:true,lineBreaks:true,overflowPixels:0,humanReadabilityReview:'NOT_REVIEWED'};
 }catch(error){error.layoutDiagnostics=layoutDiagnostics(layouts,lines,error.code,rejectedRegion,context);const messages={TYPESET_RESULT:'식자 영역 구성이 승인한 영역과 다릅니다.',FONT_OR_GLYPH_ERROR:'식자 글꼴·문자 보존 검증을 통과하지 못했습니다.',MANUAL_LAYOUT_REQUIRED:'식자 결과가 글자 크기·줄 간격·검증된 안전 영역 기준을 통과하지 못했습니다.',TYPESET_OVERFLOW:'식자 픽셀이 안전 영역 또는 충돌 기준을 통과하지 못했습니다.',TYPESET_TEXT_MISMATCH:'식자 출력이 승인한 전체 번역문과 일치하지 않습니다.'};if(messages[error.code])error.message=messages[error.code];throw error;}
}
module.exports={assertExecutionEnvironment,inspectFontGlyphs,verifyImportedMask,verifyImportedLayout};
