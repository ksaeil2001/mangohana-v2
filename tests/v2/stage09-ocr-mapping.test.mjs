// Saved model observations and explicitly mutated observations, never human GT.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {planOcrRefinement,bindOcrRefinementCrops,applyOcrRefinement}=require('../../packages/ai-engine/quality/ocr-refinement.cjs');
const {selectDialogueRegions}=require('../../packages/ai-engine/quality/region-selection.cjs');
const root=new URL('./fixtures/stage09/',import.meta.url),read=name=>JSON.parse(fs.readFileSync(new URL(name,root),'utf8'));
const parentId='group-5674a8a783ddd7e7',sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function savedFixture(){
 const extraction=read('raw-ocr.json'),bound=read('ocr-refinement/bound-crops.json'),detection=read('region-detection.json');
 const cropResults=bound.crops.map((t,i)=>({...t,sourceSha256:bound.plan.sourceSha256,sourceImageSha256:bound.plan.sourceImageSha256,result:read(`ocr-refinement/crop-00${i+1}.raw-ocr.json`)}));
 return {extraction,bound,detection,cropResults};
}
const apply=f=>applyOcrRefinement({extraction:f.extraction,plan:f.bound,cropResults:f.cropResults});
const projected=(f,out)=>{const replacements=new Map(out.replacements.map(g=>[g.parentId,g.children]));const speechBubbles=[...f.extraction.speechBubbles].sort((a,b)=>a.readingOrder-b.readingOrder).flatMap(g=>structuredClone(replacements.get(g.id)??[g]));speechBubbles.forEach((g,i)=>g.readingOrder=i+1);return {...structuredClone(f.extraction),speechBubbles};};

test('saved three real crop responses survive margin contraction with all five source identities and pending glyph review',()=>{
 const f=savedFixture(),before=structuredClone(f),out=apply(f),children=out.replacements.find(g=>g.parentId===parentId).children;
 assert.equal(children.length,3);assert.deepEqual(children.map(g=>g.text),['ヒロくんの説明','すごく分かりやすいよ','私ももっと見てもらいたかったな']);
 assert.deepEqual(children.flatMap(g=>g.ocrRefinement.sourceDetectionIds).sort(),['det-0010','det-0011','det-0015','det-0016','det-0019']);
 assert.equal(children.map(g=>g.text).join(''),f.extraction.speechBubbles.find(g=>g.id===parentId).text);
 for(const child of children){const trace=child.ocrRefinement;assert.equal(trace.validation.method,'margin_correspondence_and_recognition_agreement');assert.equal(trace.validation.glyphPreservation,null);assert.equal(trace.validation.requiresHumanReview,true);assert.equal(trace.lineCorrespondence.length,trace.sourceDetectionIds.length);assert.ok(trace.lineCorrespondence.every(x=>x.redetectionIds.length===1));}
 assert.ok(children[0].ocrRefinement.sourceQuadCoverage[0].coverage<.75);assert.deepEqual(f,before);
 const selected=selectDialogueRegions(projected(f,out),f.detection);
 assert.ok(children.every(g=>selected.extraction.speechBubbles.some(x=>x.id===g.id)));
 for(const child of children){const decision=selected.selection.decisions.find(x=>x.id===child.id);assert.equal(decision.action,'translate');assert.equal(decision.detectorRegionId,child.ocrRefinement.roiId);assert.deepEqual(decision.sourceLineIds,child.ocrRefinement.sourceDetectionIds);}
});

test('saved unrefined connected parent is explicitly needs_review with five line owners and three ROIs, never silent preserve',()=>{
 const f=savedFixture(),selection=read('connected-region-selection.json'),input=read('connected-raw-ocr.json');
 const out=selectDialogueRegions(input,selection.detection),d=out.selection.decisions.find(x=>x.id===parentId);
 assert.equal(d.action,'needs_review');assert.equal(d.reason,'connected_group_requires_actual_crop_recognition');
 assert.equal(d.lineMapping.length,5);assert.equal(new Set(d.lineMapping.flatMap(x=>x.roiIds)).size,3);
 assert.deepEqual(d.sourceLineIds,['det-0010','det-0011','det-0015','det-0016','det-0019']);assert.ok(out.selection.needsReviewRegions>0);
 assert.ok(out.extraction.nonSpeechText.some(x=>x.id===parentId));assert.equal(out.extraction.speechBubbles.some(x=>x.id===parentId),false);
});

test('binding the actual saved PNG bytes reproduces each historic crop hash and rejects byte tampering',()=>{
 const f=savedFixture(),crops=f.bound.crops.map((t,i)=>({cropId:t.cropId,pngBytes:fs.readFileSync(new URL(`ocr-refinement/crop-00${i+1}.png`,root))}));
 const bound=bindOcrRefinementCrops({plan:f.bound.plan,sourceImageSha256:f.bound.plan.sourceImageSha256,crops});
 assert.deepEqual(bound.crops,f.bound.crops);crops[0].pngBytes[50]^=1;assert.throws(()=>bindOcrRefinementCrops({plan:f.bound.plan,sourceImageSha256:f.bound.plan.sourceImageSha256,crops}));
});

test('margin geometry with changed recognition is retained for review rather than accepted or partially applied',()=>{
 const f=savedFixture(),local=f.cropResults[1].result.speechBubbles[0];local.text='SYNTHETIC_CHANGED_RECOGNITION';local.productionOcrProvenance.recognition.normalizedOcrText=local.text;local.productionOcrProvenance.recognition.rawOcrText=local.text;
 const before=structuredClone(f.extraction),out=apply(f);assert.equal(out.replacements.length,0);assert.equal(out.reviews[0].parentId,parentId);assert.equal(out.reviews[0].reason,'recognition_agreement_unverified');assert.equal(out.reviews[0].candidateChildren.length,3);assert.deepEqual(f.extraction,before);
});

for(const defect of ['missing-line','duplicate-redetection','extra-line','foreign-roi','foreign-page','foreign-model','foreign-support-model','foreign-normalization','foreign-frame','crop-hash','empty-text','order','mixed-bubbles'])test('saved-derived negative rejects '+defect+' without mutating the original extraction',()=>{
 const f=savedFixture(),response=f.cropResults[1],g=response.result.speechBubbles[0],p=g.productionOcrProvenance;
 if(defect==='missing-line'){p.sourceDetectionIds.pop();p.sourceQuadsPx.pop();p.sourceDetectionScores.pop();p.sourceDetectionModels.pop();}
 if(defect==='duplicate-redetection'){p.sourceDetectionIds[1]=p.sourceDetectionIds[0];}
 if(defect==='extra-line'){p.sourceDetectionIds.push('synthetic-extra');p.sourceQuadsPx.push(p.sourceQuadsPx[0].map(x=>({...x,y:x.y+100})));p.sourceDetectionScores.push(.9);p.sourceDetectionModels.push(p.sourceDetectionModels[0]);}
 if(defect==='foreign-roi')response.roiId='synthetic-foreign';
 if(defect==='foreign-page')response.result.pageNumber=2;
 if(defect==='foreign-model')p.detectorRevision='synthetic-foreign';
 if(defect==='foreign-support-model')p.sourceDetectionSupportModels=p.sourceDetectionIds.map(()=>({modelId:'synthetic-foreign-support',revision:'synthetic-foreign'}));
 if(defect==='foreign-normalization')p.recognition.normalization='synthetic-foreign';
 if(defect==='foreign-frame')p.cropTransform.imageWidth++;
 if(defect==='crop-hash')response.cropSha256='a'.repeat(64);
 if(defect==='empty-text'){g.text='';p.recognition.normalizedOcrText='';}
 if(defect==='order')g.readingOrder=2;
 if(defect==='mixed-bubbles'){p.sourceQuadsPx[0]=p.sourceQuadsPx[0].map(x=>({...x,x:1}));}
 const before=structuredClone(f.extraction);assert.throws(()=>apply(f),{code:'OCR_REFINEMENT_RESPONSE_INVALID'});assert.deepEqual(f.extraction,before);
});

for(const defect of ['global-duplicate-source','duplicate-source-quad','duplicate-order','source-envelope','empty-source','user-confirmed'])test('source admission protects '+defect,()=>{
 const f=savedFixture(),g=f.extraction.speechBubbles.find(x=>x.id===parentId),p=g.productionOcrProvenance;
 if(defect==='global-duplicate-source')f.extraction.speechBubbles[0].productionOcrProvenance.sourceDetectionIds[0]=p.sourceDetectionIds[0];
 if(defect==='duplicate-source-quad')p.sourceQuadsPx[1]=structuredClone(p.sourceQuadsPx[0]);
 if(defect==='duplicate-order')g.readingOrder=f.extraction.speechBubbles[0].readingOrder;
 if(defect==='source-envelope')g.bbox.width/=4;
 if(defect==='empty-source'){g.text='';p.recognition.rawOcrText='';p.recognition.normalizedOcrText='';}
 if(defect==='user-confirmed')g.ocrEditStatus='user_confirmed';
 const before=structuredClone(f.extraction);assert.throws(()=>planOcrRefinement({...f.bound.plan,extraction:f.extraction,detection:f.detection}));assert.deepEqual(f.extraction,before);
});

test('stale parent text or revision cannot overwrite a user change',()=>{
 for(const field of ['text','editRevision','userTranslation']){const f=savedFixture();f.extraction.speechBubbles[0][field]='SYNTHETIC_USER_CHANGE';const before=structuredClone(f.extraction);assert.throws(()=>apply(f),{code:'OCR_REFINEMENT_STALE'});assert.deepEqual(f.extraction,before);}
});

test('new planner labels normalized geometry and upload hashes independently and preserves original line observations',()=>{
 const f=savedFixture(),originalHash=sha(Buffer.from('SYNTHETIC_UPLOAD_DISTINCT_FROM_NORMALIZED'));
 const plan=planOcrRefinement({...f.bound.plan,sourceSha256:originalHash,extraction:f.extraction,detection:f.detection});
 assert.equal(plan.sourceFrame.kind,'normalized_px');assert.equal(plan.sourceFrame.imageSha256,f.bound.plan.sourceImageSha256);assert.equal(plan.originalUploadSha256,originalHash);
 const mapping=plan.groups[0].sourceLineRoiMapping;assert.equal(mapping.length,5);assert.ok(mapping.every(x=>x.status==='unique'));
});
