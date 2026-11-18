'use strict';

// Geometry and evidence contracts only: this module never crops, recognizes,
// splits a string, or changes the original extraction. The caller must execute
// each planned PNG through the real OCR service before applying replacements.
const {createHash}=require('node:crypto');
const {EPSILON,COVERAGE,pixels,rectangle,bounds,area,validQuad,coverage,intersects,uniqueQuads,readingCompare,mapSourceLinesToRois,matchRedetections}=require('./source-line-roi.cjs');
const VERSION=1, MAX_CROPS=64;
const SHA=/^[a-f0-9]{64}$/;
const clone=value=>structuredClone(value);
const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:canonical(value)).digest('hex');
function canonical(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}
function fail(code='OCR_REFINEMENT_INVALID'){throw Object.assign(new Error('OCR 재인식의 영역·원본·결과 대응을 확인하지 못했습니다.'),{code});}
const requireValue=(condition,code)=>{if(!condition)fail(code);};
const id=value=>typeof value==='string'&&value.length>0&&value.length<=200;
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isFinite(value)&&value>0;
function dimensions(width,height,code){requireValue(Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0&&width<=8000&&height<=8000&&width*height<=12_000_000,code);}
function validBox(box,width=1,height=1){return record(box)&&['x','y','width','height'].every(key=>Number.isFinite(box[key]))&&box.x>=-EPSILON&&box.y>=-EPSILON&&box.width>0&&box.height>0&&box.x+box.width<=width+EPSILON&&box.y+box.height<=height+EPSILON;}
function integerEnvelope(points,width,height){const b=bounds(points),x=Math.max(0,Math.floor(b.x)),y=Math.max(0,Math.floor(b.y)),right=Math.min(width,Math.ceil(b.x+b.width)),bottom=Math.min(height,Math.ceil(b.y+b.height));return {x,y,width:right-x,height:bottom-y};}
function same(a,b){return canonical(a)===canonical(b);}
function seal(value){return freeze({...value,integritySha256:digest(value)});}
function verifySeal(value,kind){requireValue(record(value)&&value.kind===kind&&value.version===VERSION&&SHA.test(value.integritySha256));const {integritySha256,...payload}=value;requireValue(digest(payload)===integritySha256);}
function provenance(group,width,height,code='OCR_REFINEMENT_INVALID'){
 const p=group.productionOcrProvenance;
 requireValue(record(p)&&p.contractVersion===1&&p.groupId===group.id&&id(p.detectorModelId)&&id(p.detectorRevision)&&id(p.recognizerModelId)&&id(p.recognizerRevision)&&
  Array.isArray(p.sourceDetectionIds)&&p.sourceDetectionIds.length>0&&p.sourceDetectionIds.length<=1000&&p.sourceDetectionIds.every(id)&&new Set(p.sourceDetectionIds).size===p.sourceDetectionIds.length&&
  Array.isArray(p.sourceQuadsPx)&&p.sourceQuadsPx.length===p.sourceDetectionIds.length&&p.sourceQuadsPx.every(q=>validQuad(q,width,height))&&
  Array.isArray(p.sourceDetectionScores)&&p.sourceDetectionScores.length===p.sourceDetectionIds.length&&p.sourceDetectionScores.every(s=>Number.isFinite(s)&&s>=0&&s<=1)&&
  ['horizontal','vertical','unknown'].includes(p.orientation)&&record(p.cropTransform)&&p.cropTransform.imageWidth===width&&p.cropTransform.imageHeight===height&&
  p.cropTransform.rotationDegrees===0&&p.cropTransform.paddingRatio===.08&&validBox(p.cropTransform.sourceBboxPx,width,height)&&validBox(p.cropTransform.cropBboxPx,width,height)&&
  p.confidenceSource==='detector_min'&&uniqueQuads(p.sourceQuadsPx),code);
 if(p.cropTransform.additionalPaddingPx!==undefined){
  const t=p.cropTransform,e=t.additionalPaddingPx,b=t.sourceBboxPx;
  requireValue(record(e)&&Object.keys(e).length===4&&['left','top','right','bottom'].every(k=>Number.isInteger(e[k])&&e[k]>=0&&e[k]<=Math.ceil(Math.min(b.width,b.height))),code);
  const x=Math.max(0,Math.floor(b.x-b.width*.08)),y=Math.max(0,Math.floor(b.y-b.height*.08)),right=Math.min(width,Math.ceil(b.x+b.width*1.08)),bottom=Math.min(height,Math.ceil(b.y+b.height*1.08));
  requireValue(same(t.cropBboxPx,{x:x-e.left,y:y-e.top,width:right-x+e.left+e.right,height:bottom-y+e.top+e.bottom}),code);
 }
 if(p.sourceDetectionModels!==undefined)requireValue(Array.isArray(p.sourceDetectionModels)&&p.sourceDetectionModels.length===p.sourceDetectionIds.length&&p.sourceDetectionModels.every(m=>id(m?.modelId)&&id(m.revision)),code);
 if(p.sourceDetectionSupportModels!==undefined)requireValue(Array.isArray(p.sourceDetectionSupportModels)&&p.sourceDetectionSupportModels.length===p.sourceDetectionIds.length&&p.sourceDetectionSupportModels.every(m=>m===null||(id(m?.modelId)&&id(m.revision))),code);
 if(p.recognition!==undefined)requireValue(record(p.recognition)&&typeof p.recognition.rawOcrText==='string'&&p.recognition.normalizedOcrText===group.text&&id(p.recognition.normalization),code);
 return p;
}
function validateExtraction(extraction,width,height){
 requireValue(record(extraction)&&(extraction.pageNumber===null||(Number.isInteger(extraction.pageNumber)&&extraction.pageNumber>0))&&Array.isArray(extraction.speechBubbles)&&extraction.speechBubbles.length<=1000&&Array.isArray(extraction.nonSpeechText)&&extraction.nonSpeechText.length<=1000&&Array.isArray(extraction.warnings));
 const seen=new Set(),sourceIds=new Set(),orders=new Set(),all=[];
 for(const group of [...extraction.speechBubbles,...extraction.nonSpeechText]){
  requireValue(record(group)&&id(group.id)&&!seen.has(group.id)&&typeof group.text==='string'&&validBox(group.bbox));seen.add(group.id);
  const p=group.productionOcrProvenance===undefined?undefined:provenance(group,width,height);
  if(p)requireValue(p.sourceQuadsPx.every(q=>coverage(q,pixels(group.bbox,width,height))>=1-EPSILON));
  if(extraction.speechBubbles.includes(group)){
   requireValue(group.text.trim().length>0);
   requireValue(Number.isInteger(group.readingOrder)&&group.readingOrder>0&&!orders.has(group.readingOrder));orders.add(group.readingOrder);
   requireValue(!['user_modified','user_confirmed'].includes(group.ocrEditStatus)&&group.userTranslation===undefined&&group.userConfirmed===undefined);
  }
  if(p)for(const sourceId of p.sourceDetectionIds){requireValue(!sourceIds.has(sourceId));sourceIds.add(sourceId);}
  all.push({id:group.id,group,quads:p?p.sourceQuadsPx:[rectangle(pixels(group.bbox,width,height))],provenance:p,speech:extraction.speechBubbles.includes(group)});
 }
 requireValue(all.reduce((sum,g)=>sum+g.quads.length,0)<=4096);
 return all;
}

/** Plan only clear multi-ROI ownership; a single old OCR string is never split. */
function planOcrRefinement({width,height,sourceSha256,sourceImageSha256,extraction,detection}={}){
 dimensions(width,height);requireValue(SHA.test(sourceSha256)&&SHA.test(sourceImageSha256));
 const all=validateExtraction(extraction,width,height);
 requireValue(record(detection)&&detection.ok===true&&detection.version===1&&detection.width===width&&detection.height===height&&detection.imageSha256===sourceImageSha256&&Array.isArray(detection.regions)&&detection.regions.length<=1000);
 const ids=new Set();for(const roi of detection.regions){requireValue(record(roi)&&id(roi.id)&&!ids.has(roi.id)&&['bubble','text_bubble','text_free'].includes(roi.kind)&&Number.isFinite(roi.confidence)&&roi.confidence>=0&&roi.confidence<=1&&validBox(roi.bbox));ids.add(roi.id);}
 const rois=detection.regions.filter(r=>r.kind==='text_bubble'&&r.confidence>=.5).map(r=>({...clone(r),rectPx:pixels(r.bbox,width,height)}));
 const groups=[],unchangedGroupIds=[];
 for(const entry of all.filter(g=>g.speech)){
  if(!entry.provenance){unchangedGroupIds.push(entry.id);continue;}
  const sourceLineRoiMapping=mapSourceLinesToRois({sourceDetectionIds:entry.provenance.sourceDetectionIds,sourceQuadsPx:entry.quads,width,height,regions:detection.regions});
  const matches=sourceLineRoiMapping.map(line=>rois.filter(roi=>line.roiIds.includes(roi.id)));
  const support=new Set(matches.flat().map(r=>r.id));
  if(support.size<2){unchangedGroupIds.push(entry.id);continue;}
  requireValue(matches.every(m=>m.length===1),'OCR_REFINEMENT_AMBIGUOUS');
  const partitions=new Map();matches.forEach((m,index)=>{const roi=m[0];if(!partitions.has(roi.id))partitions.set(roi.id,{roi,indices:[]});partitions.get(roi.id).indices.push(index);});
  const crops=[];
  for(const {roi,indices} of partitions.values()){
   const own=new Set(indices),quads=indices.map(i=>entry.quads[i]);
   const obstacles=all.flatMap(other=>other.id===entry.id?other.quads.filter((_,i)=>!own.has(i)):other.quads);
   let rectPx=integerEnvelope([...rectangle(roi.rectPx),...quads.flat()],width,height);
   if(obstacles.some(q=>intersects(q,rectPx)))rectPx=integerEnvelope(quads.flat(),width,height);
   requireValue(validBox(rectPx,width,height)&&!obstacles.some(q=>intersects(q,rectPx)),'OCR_REFINEMENT_AMBIGUOUS');
   const crop={parentId:entry.id,roiId:roi.id,roi:clone(roi),rectPx,sourceQuadsPx:clone(quads),sourceDetectionIds:indices.map(i=>entry.provenance.sourceDetectionIds[i]),sourceDetectionScores:indices.map(i=>entry.provenance.sourceDetectionScores[i])};
   crop.cropId='ocr-crop-'+digest({version:VERSION,sourceSha256,sourceImageSha256,...crop}).slice(0,40);crops.push(crop);
  }
  const vertical=entry.provenance.orientation==='vertical';
  // Text geometry, rather than ROI IDs, model enumeration or ROI whitespace,
  // determines order within a parent. The caller assigns final integer orders
  // on a separate copy of the page after all crops have succeeded.
  crops.sort((a,b)=>{const x=bounds(a.sourceQuadsPx.flat()),y=bounds(b.sourceQuadsPx.flat());return vertical?(y.x+y.width/2)-(x.x+x.width/2)||x.y-y.y||a.roiId.localeCompare(b.roiId):x.y-y.y||x.x-y.x||a.roiId.localeCompare(b.roiId);});
  crops.forEach((crop,index)=>crop.orderWithinParent=index+1);
  groups.push({parentId:entry.id,parentSha256:digest(entry.group),originalReadingOrder:entry.group.readingOrder??null,parentProvenance:clone(entry.provenance),sourceLineRoiMapping,crops});
 }
 requireValue(groups.reduce((n,g)=>n+g.crops.length,0)<=MAX_CROPS);
 return seal({kind:'OCR_REFINEMENT_PLAN',version:VERSION,width,height,sourceSha256,sourceImageSha256,originalUploadSha256:sourceSha256,sourceFrame:{kind:'normalized_px',width,height,imageSha256:sourceImageSha256},pageNumber:extraction.pageNumber,extractionSha256:digest(extraction),detectionSha256:digest(detection),policy:'unique_quad_roi_coverage_0.75_confidence_0.5_no_foreign_text',groups,unchangedGroupIds});
}

const PNG_SIGNATURE=Buffer.from('89504e470d0a1a0a','hex');
const CRC_TABLE=Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);return c>>>0;});
function crc32(bytes){let c=0xffffffff;for(const byte of bytes)c=CRC_TABLE[(c^byte)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function pngDimensions(bytes){
 requireValue(Buffer.isBuffer(bytes)&&bytes.length>=57&&bytes.length<=32*1024*1024&&bytes.subarray(0,8).equals(PNG_SIGNATURE));
 let offset=8,header,hasData=false,ended=false,chunks=0;
 while(offset<bytes.length){
  requireValue(++chunks<=10000&&offset+12<=bytes.length);const length=bytes.readUInt32BE(offset),end=offset+12+length;requireValue(end<=bytes.length);
  const type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,end-4);requireValue(crc32(bytes.subarray(offset+4,end-4))===bytes.readUInt32BE(end-4));
  if(!header){requireValue(type==='IHDR'&&length===13);header={width:data.readUInt32BE(0),height:data.readUInt32BE(4)};dimensions(header.width,header.height);requireValue([1,2,4,8,16].includes(data[8])&&[0,2,3,4,6].includes(data[9])&&data[10]===0&&data[11]===0&&[0,1].includes(data[12]));}
  else requireValue(type!=='IHDR');
  if(type==='IDAT'){requireValue(length>0);hasData=true;}
  if(type==='IEND'){requireValue(length===0&&end===bytes.length);ended=true;}
  offset=end;if(ended)break;
 }
 requireValue(header&&hasData&&ended);return header;
}
function bindOcrRefinementCrops({plan,sourceImageSha256,crops}={}){
 verifySeal(plan,'OCR_REFINEMENT_PLAN');requireValue(sourceImageSha256===plan.sourceImageSha256&&Array.isArray(crops));
 const requested=plan.groups.flatMap(g=>g.crops),byId=new Map();
 requireValue(crops.length===requested.length);for(const crop of crops){requireValue(record(crop)&&id(crop.cropId)&&!byId.has(crop.cropId));byId.set(crop.cropId,crop);}
 const tickets=requested.map(crop=>{const actual=byId.get(crop.cropId);requireValue(actual);const shape=pngDimensions(actual.pngBytes);requireValue(shape.width===crop.rectPx.width&&shape.height===crop.rectPx.height);return {cropId:crop.cropId,parentId:crop.parentId,roiId:crop.roiId,rectPx:clone(crop.rectPx),...shape,cropSha256:digest(actual.pngBytes),pngHeaderSha256:digest(actual.pngBytes.subarray(0,33)),byteLength:actual.pngBytes.length};});
 return seal({kind:'OCR_REFINEMENT_BOUND_CROPS',version:VERSION,plan:clone(plan),crops:tickets});
}
function modelIdentityAllowed(local,parent){
 if(local.recognizerModelId!==parent.recognizerModelId||local.recognizerRevision!==parent.recognizerRevision)return false;
 const known=[{modelId:parent.detectorModelId,revision:parent.detectorRevision},...(parent.sourceDetectionModels??[])];
 if(!known.some(m=>m.modelId===local.detectorModelId&&m.revision===local.detectorRevision))return false;
 const support=parent.sourceDetectionSupportModels??[];
 return (local.sourceDetectionModels??[]).every(m=>known.some(k=>same(m,k)))&&
  (local.sourceDetectionSupportModels??[]).every(m=>m===null||support.some(k=>k!==null&&same(m,k)))&&
  (!parent.recognition||(local.recognition&&local.recognition.normalization===parent.recognition.normalization));
}
const translateBox=(box,rect)=>({...clone(box),x:box.x+rect.x,y:box.y+rect.y});
/** Return replacements, never mutate raw/user records or invent their final page order. */
function applyOcrRefinement({extraction,plan:bound,cropResults}={}){
 verifySeal(bound,'OCR_REFINEMENT_BOUND_CROPS');const plan=bound.plan;verifySeal(plan,'OCR_REFINEMENT_PLAN');
 requireValue(digest(extraction)===plan.extractionSha256,'OCR_REFINEMENT_STALE');
 validateExtraction(extraction,plan.width,plan.height);
 if(plan.sourceFrame)requireValue(same(plan.sourceFrame,{kind:'normalized_px',width:plan.width,height:plan.height,imageSha256:plan.sourceImageSha256})&&plan.originalUploadSha256===plan.sourceSha256);
 const requested=plan.groups.flatMap(g=>g.crops),tickets=new Map(bound.crops.map(c=>[c.cropId,c]));
 requireValue(bound.crops.length===requested.length&&tickets.size===requested.length);
 for(const crop of requested){const ticket=tickets.get(crop.cropId);requireValue(ticket&&ticket.parentId===crop.parentId&&ticket.roiId===crop.roiId&&same(ticket.rectPx,crop.rectPx)&&ticket.width===crop.rectPx.width&&ticket.height===crop.rectPx.height&&SHA.test(ticket.cropSha256)&&SHA.test(ticket.pngHeaderSha256));}
 const code='OCR_REFINEMENT_RESPONSE_INVALID',responses=new Map(),reviews=[];
 requireValue(Array.isArray(cropResults)&&cropResults.length===requested.length,code);
 for(const response of cropResults){requireValue(record(response)&&id(response.cropId)&&!responses.has(response.cropId)&&tickets.has(response.cropId),code);responses.set(response.cropId,response);}
 const replacements=[];
 for(const group of plan.groups){
  const parent=extraction.speechBubbles.find(g=>g.id===group.parentId),assigned=group.crops.flatMap(c=>c.sourceDetectionIds);
  requireValue(parent&&digest(parent)===group.parentSha256&&same(parent.productionOcrProvenance,group.parentProvenance)&&assigned.length===new Set(assigned).size&&same([...assigned].sort(),[...group.parentProvenance.sourceDetectionIds].sort()),code);
  const ordered=[...group.crops].sort((a,b)=>readingCompare(a.sourceQuadsPx.flat(),b.sourceQuadsPx.flat(),group.parentProvenance.orientation));
  requireValue(group.crops.every((c,i)=>c.cropId===ordered[i].cropId&&c.orderWithinParent===i+1),code);
  const children=group.crops.map(crop=>{
   const response=responses.get(crop.cropId),ticket=tickets.get(crop.cropId),result=response.result;
   requireValue(response.parentId===group.parentId&&response.roiId===crop.roiId&&response.sourceSha256===plan.sourceSha256&&response.sourceImageSha256===plan.sourceImageSha256&&response.cropSha256===ticket.cropSha256&&record(result)&&result.pageNumber===plan.pageNumber&&Array.isArray(result.speechBubbles)&&result.speechBubbles.length===1&&Array.isArray(result.nonSpeechText)&&result.nonSpeechText.length===0&&Array.isArray(result.warnings)&&result.warnings.every(w=>typeof w==='string'&&!/^OCR_REGION_(?:CROP|RECOGNITION)_(?:FAILED|EMPTY)(?::|$)/.test(w)),code);
   const local=result.speechBubbles[0];requireValue(record(local)&&id(local.id)&&local.type==='speech_bubble'&&typeof local.text==='string'&&local.text.trim().length>0&&local.readingOrder===1&&validBox(local.bbox)&&Number.isFinite(local.confidence)&&local.confidence>=0&&local.confidence<=1,code);
   const p=provenance(local,ticket.width,ticket.height,code);requireValue(modelIdentityAllowed(p,group.parentProvenance)&&p.orientation===group.parentProvenance.orientation,code);
   if(local.polygon!==undefined)requireValue(Array.isArray(local.polygon)&&local.polygon.length>=3&&local.polygon.length<=1000&&local.polygon.every(point=>Number.isFinite(point?.x)&&Number.isFinite(point?.y)&&point.x>=0&&point.y>=0&&point.x<=1&&point.y<=1)&&area(local.polygon)>0,code);
   const quads=p.sourceQuadsPx.map(q=>q.map(point=>({x:point.x+crop.rectPx.x,y:point.y+crop.rectPx.y})));
   const localEnvelope={x:crop.rectPx.x+local.bbox.x*ticket.width,y:crop.rectPx.y+local.bbox.y*ticket.height,width:local.bbox.width*ticket.width,height:local.bbox.height*ticket.height};
   requireValue(quads.every(q=>coverage(q,crop.roi.rectPx)>=COVERAGE-EPSILON&&coverage(q,localEnvelope)>=1-EPSILON),code);
   const child=clone(local),childId='ocr-refined-'+digest({version:VERSION,sourceSha256:plan.sourceSha256,sourceImageSha256:plan.sourceImageSha256,parentId:group.parentId,parentSha256:group.parentSha256,roiId:crop.roiId,cropId:crop.cropId,cropSha256:ticket.cropSha256,localId:local.id}).slice(0,48);
   const redetectionIds=p.sourceDetectionIds.map((_,i)=>childId+':'+i);
   const correspondence=matchRedetections({sourceDetectionIds:crop.sourceDetectionIds,sourceQuadsPx:crop.sourceQuadsPx,redetectionIds,redetectedQuadsPx:quads,orientation:p.orientation});
   requireValue(correspondence.method!=='invalid',code);
   child.id=childId;delete child.readingOrder;
   child.bbox={x:(crop.rectPx.x+local.bbox.x*ticket.width)/plan.width,y:(crop.rectPx.y+local.bbox.y*ticket.height)/plan.height,width:local.bbox.width*ticket.width/plan.width,height:local.bbox.height*ticket.height/plan.height};
   if(local.polygon)child.polygon=local.polygon.map(point=>({x:(crop.rectPx.x+point.x*ticket.width)/plan.width,y:(crop.rectPx.y+point.y*ticket.height)/plan.height}));
   child.productionOcrProvenance={...clone(p),groupId:childId,sourceDetectionIds:redetectionIds,sourceQuadsPx:quads,cropTransform:{...clone(p.cropTransform),sourceBboxPx:translateBox(p.cropTransform.sourceBboxPx,crop.rectPx),cropBboxPx:translateBox(p.cropTransform.cropBboxPx,crop.rectPx),imageWidth:plan.width,imageHeight:plan.height}};
   child.ocrRefinement={version:VERSION,policy:plan.policy,sourceSha256:plan.sourceSha256,sourceImageSha256:plan.sourceImageSha256,sourceFrame:{kind:'normalized_px',width:plan.width,height:plan.height,imageSha256:plan.sourceImageSha256},redetectionFrame:{kind:'crop_px',width:ticket.width,height:ticket.height,imageSha256:ticket.cropSha256,offsetPx:{x:crop.rectPx.x,y:crop.rectPx.y}},parentId:group.parentId,parentSha256:group.parentSha256,roiId:crop.roiId,cropId:crop.cropId,cropSha256:ticket.cropSha256,pngHeaderSha256:ticket.pngHeaderSha256,rectPx:clone(crop.rectPx),sourceDetectionIds:clone(crop.sourceDetectionIds),sourceQuadsPx:clone(crop.sourceQuadsPx),sourceQuadCoverage:correspondence.sourceQuadCoverage,lineCorrespondence:correspondence.lineCorrespondence,orderWithinParent:crop.orderWithinParent,cropLocalProvenance:clone(p),warnings:clone(result.warnings),validation:{method:correspondence.method,status:'candidate',requiresHumanReview:true,glyphPreservation:null}};
   return child;
  });
  const needsAgreement=children.some(c=>c.ocrRefinement.validation.method==='margin_correspondence');
  // Compare whole independent recognition outputs in geometric crop order. No
  // substring is attributed to a source line. This is OCR agreement, not GT.
  const agreement=children.map(c=>c.text).join('')===parent.text;
  if(needsAgreement&&!agreement){reviews.push({parentId:group.parentId,status:'needs_review',reason:'recognition_agreement_unverified',sourceDetectionIds:clone(assigned),candidateChildren:children});continue;}
  for(const child of children){child.ocrRefinement.validation.recognitionAgreement=agreement?'exact_parent_concatenation':'not_required_by_union_guard';if(needsAgreement)child.ocrRefinement.validation.method='margin_correspondence_and_recognition_agreement';}
  replacements.push({parentId:group.parentId,children});
 }
 const ids=replacements.flatMap(r=>r.children.map(c=>c.id));requireValue(new Set(ids).size===ids.length&&!ids.some(child=>plan.unchangedGroupIds.includes(child)),code);
 return {version:VERSION,replacements,reviews,unchangedGroupIds:clone(plan.unchangedGroupIds),requiresOrderProjection:true,additionalOcrCalls:cropResults.length};
}

module.exports={planOcrRefinement,bindOcrRefinementCrops,applyOcrRefinement};
