// Pure geometry and synthetic PNG/report contracts only. No image decoder, OCR or AI execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),hash=value=>createHash('sha256').update(value).digest('hex');
let api={};try{api=require('../../packages/ai-engine/quality/ocr-refinement.cjs');}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
const need=name=>assert.equal(typeof api[name],'function',name+' must exist');
const box=(x,y,width,height)=>({x,y,width,height}),quad=(x,y,width,height)=>[{x,y},{x:x+width,y},{x:x+width,y:y+height},{x,y:y+height}];
const bounds=points=>{const xs=points.map(p=>p.x),ys=points.map(p=>p.y);return box(Math.min(...xs),Math.min(...ys),Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));};
const normalized=(rect,w,h)=>box(rect.x/w,rect.y/h,rect.width/w,rect.height/h);
function group(id,quads,width,height,text='SYNTHETIC_PARENT_TEXT_NEVER_SPLIT',order=1){const rect=bounds(quads.flat());return {id,type:'speech_bubble',text,language:'ja',bbox:normalized(rect,width,height),polygon:quad(rect.x/width,rect.y/height,rect.width/width,rect.height/height),readingOrder:order,confidence:.9,orientation:'vertical',notes:'',speakerCandidates:[],productionOcrProvenance:{contractVersion:1,detectorModelId:'synthetic-detector',detectorRevision:'synthetic-detector-revision',recognizerModelId:'synthetic-recognizer',recognizerRevision:'synthetic-recognizer-revision',groupId:id,sourceDetectionIds:quads.map((_,i)=>id+'-member-'+i),sourceQuadsPx:quads,sourceDetectionScores:quads.map(()=>.9),orientation:'vertical',cropTransform:{sourceBboxPx:rect,cropBboxPx:rect,paddingRatio:.08,rotationDegrees:0,imageWidth:width,imageHeight:height},confidenceSource:'detector_min',recognition:{rawOcrText:text,normalizedOcrText:text,normalization:'synthetic-normalization'}}};}
function fixture(){const width=1000,height=1000,parent=group('parent',[quad(110,110,40,70),quad(310,130,50,80),quad(510,120,50,80)],width,height),other=group('other',[quad(750,750,50,50)],width,height,'SYNTHETIC_OTHER_UNCHANGED',2),sourceSha256=hash('synthetic-original'),sourceImageSha256=hash('synthetic-normalized');return {width,height,sourceSha256,sourceImageSha256,extraction:{pageNumber:1,speechBubbles:[parent,other],nonSpeechText:[],warnings:['SYNTHETIC_FIXTURE_NOT_AI']},detection:{version:1,ok:true,width,height,imageSha256:sourceImageSha256,regions:[{id:'left',kind:'text_bubble',confidence:.9,bbox:box(.1,.1,.07,.1)},{id:'middle',kind:'text_bubble',confidence:.9,bbox:box(.3,.12,.08,.1)},{id:'right',kind:'text_bubble',confidence:.9,bbox:box(.5,.11,.08,.1)},{id:'other-roi',kind:'text_bubble',confidence:.9,bbox:box(.74,.74,.08,.08)}]}};}
function plan(f){need('planOcrRefinement');return api.planOcrRefinement(f);}
function crc32(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function png(width,height){const chunk=(kind,data)=>{const type=Buffer.from(kind),body=Buffer.concat([type,data]),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);body.copy(out,4);out.writeUInt32BE(crc32(body),out.length-4);return out;};const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=0;const row=Buffer.alloc((width+1)*height,255);for(let y=0;y<height;y++)row[y*(width+1)]=0;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(row)),chunk('IEND',Buffer.alloc(0))]);}
function bind(f,p=plan(f)){need('bindOcrRefinementCrops');return api.bindOcrRefinementCrops({plan:p,sourceImageSha256:f.sourceImageSha256,crops:p.groups.flatMap(g=>g.crops).map(crop=>({cropId:crop.cropId,pngBytes:png(crop.rectPx.width,crop.rectPx.height)}))});}
function responses(f,bound){return bound.crops.map((ticket,index)=>{const crop=bound.plan.groups.flatMap(g=>g.crops).find(c=>c.cropId===ticket.cropId),local=crop.sourceQuadsPx.map(q=>q.map(p=>({x:p.x-crop.rectPx.x,y:p.y-crop.rectPx.y})));return {cropId:ticket.cropId,parentId:ticket.parentId,roiId:ticket.roiId,sourceSha256:f.sourceSha256,sourceImageSha256:f.sourceImageSha256,cropSha256:ticket.cropSha256,result:{pageNumber:1,speechBubbles:[group('local-ocr',local,ticket.width,ticket.height,'SYNTHETIC_ACTUAL_CROP_OCR_'+index,1)],nonSpeechText:[],warnings:['SYNTHETIC_FIXTURE_NOT_AI']}};});}
function apply(f,bound=bind(f),cropResults=responses(f,bound)){need('applyOcrRefinement');return api.applyOcrRefinement({extraction:f.extraction,plan:bound,cropResults});}

test('one actual-quad parent gets three crop plans while all raw text and other groups remain unchanged',()=>{
 const f=fixture(),before=structuredClone(f),p=plan(f);assert.equal(p.groups.length,1);assert.equal(p.groups[0].parentId,'parent');assert.equal(p.groups[0].crops.length,3);assert.deepEqual(p.unchangedGroupIds,['other']);assert.deepEqual(f,before);assert.equal(p.groups[0].crops.some(crop=>Object.hasOwn(crop,'text')),false);assert.ok(Object.isFrozen(p));assert.deepEqual(plan(f),p);
});
test('the saved missing-page geometry plans three ROIs without any production text or coordinate branch',()=>{
 const f=fixture();f.width=2039;f.height=2880;const q=[quad(346,351,64,348),quad(410,351,57,153),quad(264,309,67,261),quad(206,309,64,507),[{x:467,y:211},{x:543,y:210},{x:550,y:569},{x:474,y:570}]];f.extraction.speechBubbles=[group('actual-geometry-only',q,f.width,f.height)];f.detection={...f.detection,width:f.width,height:f.height,regions:[{id:'roi16',kind:'text_bubble',confidence:.8519365787506104,bbox:box(.09800885599462819,.10396685070461698,.06506570663564401,.18278557459513348)},{id:'roi20',kind:'text_bubble',confidence:.788567066192627,bbox:box(.2333892627695485,.0751043266720242,.035888058230712054,.12521267467074923)},{id:'roi21',kind:'text_bubble',confidence:.7821435928344727,bbox:box(.16888626794595238,.1166002697414822,.06035600169258062,.13520109388563367)}]};const p=plan(f);assert.equal(p.groups.length,1);assert.equal(p.groups[0].crops.length,3);assert.deepEqual(p.groups[0].crops.map(c=>c.sourceDetectionIds.length).sort(),[1,2,2]);for(const crop of p.groups[0].crops)for(const point of crop.sourceQuadsPx.flat())assert.ok(point.x>=crop.rectPx.x&&point.y>=crop.rectPx.y&&point.x<=crop.rectPx.x+crop.rectPx.width&&point.y<=crop.rectPx.y+crop.rectPx.height);assert.equal(apply(f).additionalOcrCalls,3);
});
test('overlapping ROI whitespace is allowed when actual text ownership stays unique and crops avoid foreign text',()=>{
 const f=fixture();f.detection.regions[0].bbox.width=.205;f.detection.regions[1].bbox.x=.295;assert.equal(plan(f).groups[0].crops.length,3);
});
test('within-parent order follows vertical RTL or horizontal geometry regardless of ROI and source member enumeration',()=>{
 const vertical=fixture();vertical.detection.regions.reverse();const provenance=vertical.extraction.speechBubbles[0].productionOcrProvenance;provenance.sourceQuadsPx.reverse();provenance.sourceDetectionIds.reverse();assert.deepEqual(plan(vertical).groups[0].crops.map(c=>c.roiId),['right','middle','left']);
 const horizontal=fixture();horizontal.extraction.speechBubbles[0].orientation='horizontal';horizontal.extraction.speechBubbles[0].productionOcrProvenance.orientation='horizontal';horizontal.detection.regions.reverse();assert.deepEqual(plan(horizontal).groups[0].crops.map(c=>c.roiId),['left','right','middle']);
});
test('duplicate ROI support, an orphan member and protected nonspeech intrusion all fail closed',()=>{
 for(const defect of ['duplicate','orphan','nonspeech']){const f=fixture();if(defect==='duplicate')f.detection.regions.push({...f.detection.regions[0],id:'duplicate'});if(defect==='orphan')f.detection.regions=f.detection.regions.filter(r=>r.id!=='middle');if(defect==='nonspeech')f.extraction.nonSpeechText=[{id:'protected',type:'unknown',text:'SYNTHETIC_PROTECTED',bbox:box(.12,.13,.01,.01)}];const before=structuredClone(f);assert.throws(()=>plan(f),{code:'OCR_REFINEMENT_AMBIGUOUS'});assert.deepEqual(f,before);}
});
test('single supported groups do not get substring-based crops, and foreign image detection is invalid',()=>{
 const f=fixture();f.extraction.speechBubbles=[f.extraction.speechBubbles[1]];assert.equal(plan(f).groups.length,0);f.detection.imageSha256='f'.repeat(64);assert.throws(()=>plan(f),{code:'OCR_REFINEMENT_INVALID'});
});
test('malformed/duplicate quad identities cannot be used as split provenance',()=>{
 for(const defect of ['length','duplicate','outside','degenerate']){const f=fixture(),p=f.extraction.speechBubbles[0].productionOcrProvenance;if(defect==='length')p.sourceQuadsPx.pop();if(defect==='duplicate')p.sourceDetectionIds[1]=p.sourceDetectionIds[0];if(defect==='outside')p.sourceQuadsPx[0][0].x=-1;if(defect==='degenerate')p.sourceQuadsPx[0]=Array(4).fill({x:1,y:1});assert.throws(()=>plan(f),{code:'OCR_REFINEMENT_INVALID'});}
});
test('binding uses actual PNG bytes, shape and source-image identity, rejecting missing or duplicate crops',()=>{
 const f=fixture(),p=plan(f),bound=bind(f,p);assert.equal(bound.crops.length,3);assert.ok(bound.crops.every(c=>/^[0-9a-f]{64}$/.test(c.cropSha256)));for(const defect of ['foreign-image','missing','duplicate','wrong-size','not-png']){const args={plan:p,sourceImageSha256:f.sourceImageSha256,crops:p.groups.flatMap(g=>g.crops).map(c=>({cropId:c.cropId,pngBytes:png(c.rectPx.width,c.rectPx.height)}))};if(defect==='foreign-image')args.sourceImageSha256='f'.repeat(64);if(defect==='missing')args.crops.pop();if(defect==='duplicate')args.crops[1]=args.crops[0];if(defect==='wrong-size')args.crops[0].pngBytes=png(1,1);if(defect==='not-png')args.crops[0].pngBytes=Buffer.from('not a png');assert.throws(()=>api.bindOcrRefinementCrops(args),{code:'OCR_REFINEMENT_INVALID'});}
});
test('applied crop OCR maps exact geometry into the full image and preserves local signed evidence separately',()=>{
 const f=fixture(),before=structuredClone(f),bound=bind(f),cropResults=responses(f,bound),out=apply(f,bound,cropResults);assert.equal(out.replacements.length,1);assert.equal(out.replacements[0].children.length,3);assert.equal(out.requiresOrderProjection,true);assert.equal(out.additionalOcrCalls,3);assert.deepEqual(out.unchangedGroupIds,['other']);assert.deepEqual(f,before);for(const child of out.replacements[0].children){const trace=child.ocrRefinement,ticket=bound.crops.find(c=>c.cropId===trace.cropId),response=cropResults.find(r=>r.cropId===trace.cropId),local=response.result.speechBubbles[0];assert.equal(child.text,local.text);assert.equal(Object.hasOwn(child,'readingOrder'),false);assert.equal(child.productionOcrProvenance.groupId,child.id);assert.equal(child.bbox.x,(ticket.rectPx.x+local.bbox.x*ticket.width)/f.width);assert.equal(child.bbox.y,(ticket.rectPx.y+local.bbox.y*ticket.height)/f.height);assert.deepEqual(trace.cropLocalProvenance,local.productionOcrProvenance);assert.equal(trace.sourceSha256,f.sourceSha256);assert.equal(trace.sourceImageSha256,f.sourceImageSha256);assert.equal(trace.cropSha256,ticket.cropSha256);assert.ok(child.productionOcrProvenance.sourceDetectionIds.every(id=>id.startsWith(child.id+':')));}
});
test('refined IDs are deterministic and bound to source/parent/ROI/crop evidence',()=>{
 const f=fixture(),bound=bind(f),a=apply(f,bound),b=apply(f,bound);assert.deepEqual(a.replacements,b.replacements);const ids=a.replacements[0].children.map(c=>c.id);assert.equal(new Set(ids).size,3);assert.ok(ids.every(id=>id!=='parent'&&id!=='local-ocr'&&id.length<=200));const changed=fixture();changed.sourceSha256=hash('different-original');assert.notDeepEqual(apply(changed).replacements[0].children.map(c=>c.id),ids);
});
test('empty, ambiguous, foreign or duplicate crop responses cannot partially replace a parent',()=>{
 for(const defect of ['empty','multiple','foreign-crop','foreign-sha','foreign-parent','foreign-roi','foreign-image','duplicate','missing']){const f=fixture(),bound=bind(f),r=responses(f,bound),before=structuredClone(f.extraction);if(defect==='empty')r[0].result.speechBubbles=[];if(defect==='multiple')r[0].result.speechBubbles.push(structuredClone(r[0].result.speechBubbles[0]));if(defect==='foreign-crop')r[0].cropId='foreign';if(defect==='foreign-sha')r[0].cropSha256='f'.repeat(64);if(defect==='foreign-parent')r[0].parentId='foreign';if(defect==='foreign-roi')r[0].roiId='foreign';if(defect==='foreign-image')r[0].sourceImageSha256='f'.repeat(64);if(defect==='duplicate')r[1]=r[0];if(defect==='missing')r.pop();assert.throws(()=>apply(f,bound,r),{code:'OCR_REFINEMENT_RESPONSE_INVALID'});assert.deepEqual(f.extraction,before);}
});
test('changed parent/user content or a tampered plan is rejected before applying late crop results',()=>{
 const f=fixture(),p=plan(f),bound=bind(f,p),r=responses(f,bound);f.extraction.speechBubbles[0].text='MANUAL_EDIT_MUST_SURVIVE';assert.throws(()=>apply(f,bound,r),{code:'OCR_REFINEMENT_STALE'});assert.equal(f.extraction.speechBubbles[0].text,'MANUAL_EDIT_MUST_SURVIVE');const original=fixture(),copy=structuredClone(bind(original));copy.crops[0].rectPx.x++;assert.throws(()=>apply(original,copy,responses(original,bind(original))),{code:'OCR_REFINEMENT_INVALID'});
});
test('bad local frame, model identity, warning or text fails instead of fabricating full-image evidence',()=>{
 for(const defect of ['outside','transform','rotation','model','warning','text','nonspeech']){const f=fixture(),bound=bind(f),r=responses(f,bound),child=r[0].result.speechBubbles[0];if(defect==='outside')child.bbox.x=2;if(defect==='transform')child.productionOcrProvenance.cropTransform.imageWidth++;if(defect==='rotation')child.productionOcrProvenance.cropTransform.rotationDegrees=90;if(defect==='model')child.productionOcrProvenance.recognizerModelId='foreign';if(defect==='warning')r[0].result.warnings=['OCR_REGION_RECOGNITION_FAILED: fixture'];if(defect==='text')child.text=' ';if(defect==='nonspeech')r[0].result.nonSpeechText=[{id:'unhandled'}];assert.throws(()=>apply(f,bound,r),{code:'OCR_REFINEMENT_RESPONSE_INVALID'});}
});
test('a nonempty crop group missing one of two original quads cannot replace the parent',()=>{
 const f=fixture();f.extraction.speechBubbles[0]=group('parent',[quad(110,110,15,70),quad(140,110,15,70),quad(310,130,50,80)],f.width,f.height);const bound=bind(f),r=responses(f,bound),target=r.find(value=>value.roiId==='left'),ticket=bound.crops.find(value=>value.cropId===target.cropId),original=target.result.speechBubbles[0];target.result.speechBubbles[0]=group(original.id,[original.productionOcrProvenance.sourceQuadsPx[0]],ticket.width,ticket.height,original.text);assert.throws(()=>apply(f,bound,r),{code:'OCR_REFINEMENT_RESPONSE_INVALID'});
});
test('new OCR may merge or split original geometry when its union covers every assigned quad',()=>{
 for(const mode of ['merged','split','overlapping-half']){const f=fixture();f.extraction.speechBubbles[0]=group('parent',[quad(110,110,15,70),quad(140,110,15,70),quad(310,130,50,80)],f.width,f.height);const bound=bind(f),r=responses(f,bound),target=r.find(value=>value.roiId==='left'),ticket=bound.crops.find(value=>value.cropId===target.cropId),original=target.result.speechBubbles[0],qs=original.productionOcrProvenance.sourceQuadsPx;let replacement;if(mode==='merged'){const b=bounds(qs.flat());replacement=[quad(b.x,b.y,b.width,b.height)];}else if(mode==='split')replacement=qs.flatMap(q=>{const b=bounds(q);return [quad(b.x,b.y,b.width,b.height/2),quad(b.x,b.y+b.height/2,b.width,b.height/2)];});else {const b=bounds(qs[0]);replacement=[quad(b.x,b.y,b.width,b.height/2),quad(b.x,b.y,b.width,b.height/2)];}target.result.speechBubbles[0]=group(original.id,replacement,ticket.width,ticket.height,original.text);if(mode==='overlapping-half')assert.throws(()=>apply(f,bound,r),{code:'OCR_REFINEMENT_RESPONSE_INVALID'});else assert.equal(apply(f,bound,r).additionalOcrCalls,2);}
});

test('legal context padding is accepted without accepting a mismatched padding transform',()=>{
 const f=fixture(),p=f.extraction.speechBubbles[1].productionOcrProvenance;
 p.cropTransform.cropBboxPx=box(744,745,62,60);p.cropTransform.additionalPaddingPx={left:2,top:1,right:2,bottom:1};
 assert.equal(plan(f).groups.length,1);p.cropTransform.additionalPaddingPx.right=3;
 assert.throws(()=>plan(f),{code:'OCR_REFINEMENT_INVALID'});
});
test('small vertical and horizontal source lines retain exact coordinates through integer crop offsets',()=>{
 for(const orientation of ['vertical','horizontal']){
  const f=fixture();f.width=100;f.height=100;
  f.extraction.speechBubbles=f.extraction.speechBubbles.map(g=>{const next=group(g.id,g.productionOcrProvenance.sourceQuadsPx.map(q=>q.map(p=>({x:p.x/10,y:p.y/10}))),100,100,g.text,g.readingOrder);next.orientation=orientation;next.productionOcrProvenance.orientation=orientation;return next;});
  f.detection.width=100;f.detection.height=100;const bound=bind(f),r=responses(f,bound);
  for(const response of r){response.result.speechBubbles[0].orientation=orientation;response.result.speechBubbles[0].productionOcrProvenance.orientation=orientation;}
  const out=apply(f,bound,r);assert.equal(out.replacements[0].children.length,3);
  assert.ok(out.replacements[0].children.every(g=>g.productionOcrProvenance.sourceQuadsPx.flat().every(p=>p.x>=0&&p.x<=100&&p.y>=0&&p.y<=100)));
 }
});
test('two original source lines in one bubble remain separate line correspondences in a single child',()=>{
 const f=fixture();f.extraction.speechBubbles[0]=group('parent',[quad(110,110,15,70),quad(140,110,15,70),quad(310,130,50,80)],f.width,f.height);
 const out=apply(f),left=out.replacements[0].children.find(g=>g.ocrRefinement.roiId==='left');
 assert.equal(left.ocrRefinement.lineCorrespondence.length,2);assert.ok(left.ocrRefinement.lineCorrespondence.every(x=>x.redetectionIds.length===1));
});
test('duplicate redetection geometry under distinct IDs cannot inflate source coverage',()=>{
 const f=fixture(),bound=bind(f),r=responses(f,bound),g=r[0].result.speechBubbles[0],p=g.productionOcrProvenance;
 p.sourceDetectionIds.push('SYNTHETIC_DUPLICATE');p.sourceQuadsPx.push(structuredClone(p.sourceQuadsPx[0]));p.sourceDetectionScores.push(.9);
 assert.throws(()=>apply(f,bound,r),{code:'OCR_REFINEMENT_RESPONSE_INVALID'});
});
