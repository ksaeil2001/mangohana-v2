import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { reportToStudioResult } from '../../apps/engine/result.mjs';

// Synthetic report fixtures validate the adapter contract, not AI quality.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=', 'base64');
const digest = createHash('sha256').update(png).digest('hex');
function report() {
  return {
    version:1,jobId:'job-test',evidenceKind:'LOCAL_ENGINE_CANDIDATE',qaStatus:'pending',userApproved:false,
    originalPreserved:true,manualCorrections:0,image:{width:1,height:1},
    hashes:{cleaned:digest,candidate:digest},
    ocr:{speechBubbles:[{id:'bubble-1'}]},
    lines:[{id:'bubble-1',sourceText:'行こう。',aiTranslation:'가자.',order:1,parseConfidence:0.9}],
    translations:[{id:'bubble-1',engine:'local_ai',usedExactTm:false,modelHttpRequests:1,qaReport:{issues:[]}}],
    typesetting:{layoutReport:[{id:'bubble-1',bbox:{x:.2,y:.3,width:.4,height:.5},sourceBbox:{x:.1,y:.1,width:.2,height:.2},fontSizePx:14,fontFamily:'Pretendard',productionFontLoaded:true,glyphFontLoaded:true,reviewReasons:[]}]},
    quality:{semanticReview:'pending',residualSourceText:'not_measured'},warnings:[],
  };
}
const assets={cleanedPng:png,candidatePng:png};

test('sound effect treatment follows explicit OCR classification and the verified typeset IDs',()=>{
 const r=report();
 assert.equal(reportToStudioResult(r,assets).evidence.sound_effects,undefined);
 r.ocr.nonSpeechText=[{type:'unknown'},{type:'sound_effect',text:'ドン'},{type:'sign_or_label'}];
 r.ocr.speechBubbles[0].type='dialogue';
 assert.deepEqual(reportToStudioResult(r,assets).evidence.sound_effects,{preserved:1,translated:0});
 r.ocr.speechBubbles[0].type='sound_effect';
 assert.deepEqual(reportToStudioResult(r,assets).evidence.sound_effects,{preserved:1,translated:1});
});

function stage12Report(){
 const r=report(),identity={version:1,contract:'stage12-input-v1',jobId:r.jobId,pageNumber:1,width:1,height:1,sourceSha256:digest,sourceImageSha256:digest,cleanedImageSha256:digest,maskSha256:digest,ocrSha256:'b'.repeat(64),translationInputFingerprint:'a'.repeat(64),coordinateSpace:'normalized-page-pixels',mode:'unreviewed_candidate',maskReview:'candidate_validated_not_human_approved'};
 r.hashes={...r.hashes,original:digest,normalized:digest,mask:digest};r.translationInput={version:'synthetic-layout-input',fingerprint:identity.translationInputFingerprint};r.typesetting.inputIdentity=identity;r.lines[0].pageNumber=1;
 Object.assign(r.typesetting.layoutReport[0],{contractVersion:'stage12-layout-v1',fitStatus:'FIT_WARNING',qaStatus:'pending',textEvidence:{complete:true,sourceText:r.lines[0].aiTranslation,renderedLines:[r.lines[0].aiTranslation],missingCharacters:0,extraCharacters:0},actualLayout:{lines:[{text:r.lines[0].aiTranslation}]},glyphEvidence:{measured:true,missingGlyphOccurrences:0},raster:{paintedPixels:3,clippedPixels:0,otherRegionCollisionPixels:0,overlappingInkPixels:0,outsideInteriorPixels:null}});
 return r;
}
test('Stage12 adapter keeps candidate-only identity, full text and measured raster evidence without approving it',()=>{
 const r=stage12Report(),out=reportToStudioResult(r,assets);assert.deepEqual(out.evidence.typesetting_input_identity,r.typesetting.inputIdentity);assert.equal(out.evidence.typesetting_layouts[0].fitStatus,'FIT_WARNING');assert.equal(out.evidence.quality_status,'pending');
});
test('editing starts with the measured ink, outline, weight and line spacing from the candidate',()=>{
 const r=stage12Report(),layout=r.typesetting.layoutReport[0];
 layout.lineHeight=1.25;
 layout.paint={font:'bold 14px Pretendard, sans-serif',align:'right',color:'#ffffff',strokeColor:'#080808',strokeWidth:1.5};
 const [b]=reportToStudioResult(r,assets).blocks;
 assert.deepEqual([b.font,b.color,b.strokeColor,b.strokeWidth,b.weight,b.align,b.lineHeight],['pretendard','#ffffff','#080808',1.5,700,'right',1.25]);
 layout.paint={font:'bold 14px Pretendard, sans-serif',align:'center',strokeWidth:1};
 const [defaultInk]=reportToStudioResult(r,assets).blocks;
 assert.deepEqual([defaultInk.color,defaultInk.strokeColor],['#000000','#ffffff']);
 const [legacy]=reportToStudioResult(report(),assets).blocks;
 assert.deepEqual([legacy.color,legacy.weight,legacy.lineHeight,legacy.strokeWidth],['#202020',600,1.4,undefined]);
});
test('Stage12 adapter refuses contradictory source, text, glyph or raster claims and missing binding',()=>{
 for(const mutate of [r=>delete r.typesetting.inputIdentity,r=>r.typesetting.inputIdentity.cleanedImageSha256='0'.repeat(64),r=>r.typesetting.inputIdentity.pageNumber=2,r=>r.typesetting.layoutReport[0].textEvidence.sourceText='다른 대사',r=>r.typesetting.layoutReport[0].textEvidence.complete=false,r=>r.typesetting.layoutReport[0].actualLayout.lines=[],r=>r.typesetting.layoutReport[0].glyphEvidence.missingGlyphOccurrences=1,r=>r.typesetting.layoutReport[0].raster.clippedPixels=1,r=>r.typesetting.layoutReport[0].raster.paintedPixels=0]){const r=stage12Report();mutate(r);assert.throws(()=>reportToStudioResult(r,assets),{code:'INVALID_ENGINE_RESULT'});}
});

test('a review-required dialogue cannot be silently exported as a complete candidate',()=>{
 for(const mutate of [r=>r.regionSelection={decisions:[{id:'pending-dialogue',action:'needs_review'}]},r=>r.ocrRefinement={reviews:[{parentId:'pending-dialogue',status:'needs_review'}]}]){
  const r=report();mutate(r);assert.throws(()=>reportToStudioResult(r,assets),{code:'INVALID_ENGINE_RESULT'});
 }
});
test('refined child IDs and original line IDs remain distinct through translation, typesetting and result conversion',()=>{
 const r=report(),baseLine=r.lines[0],baseTranslation=r.translations[0],baseLayout=r.typesetting.layoutReport[0];
 const children=[['refined-right',['source-5']],['refined-middle',['source-1','source-2']],['refined-left',['source-3','source-4']]];
 r.lines=children.map(([id,sourceLineIds],i)=>({...baseLine,id,order:i+1,sourceLineIds}));
 r.translations=children.map(([id])=>({...baseTranslation,id}));r.typesetting.layoutReport=children.map(([id])=>({...baseLayout,id}));
 r.ocr.speechBubbles=children.map(([id,sourceDetectionIds])=>({id,ocrRefinement:{sourceDetectionIds},productionOcrProvenance:{sourceDetectionIds:[id+':redetection']}}));
 assert.deepEqual(reportToStudioResult(r,assets).blocks.map(b=>b.id),['refined-right','refined-middle','refined-left']);
 r.lines[0].sourceLineIds=['source-1'];assert.throws(()=>reportToStudioResult(r,assets),{code:'INVALID_ENGINE_RESULT'});
});

test('joins OCR, translation and actual typeset layout by ID and preserves both images',()=>{
  const r=reportToStudioResult(report(),assets);
  assert.deepEqual(r.blocks.map(b=>({id:b.id,source:b.source,text:b.text,x:b.x,y:b.y,w:b.w,h:b.h,size:b.size})),[
    {id:'bubble-1',source:'行こう。',text:'가자.',x:20,y:30,w:40,h:50,size:14},
  ]);
  assert.equal(r.clean_image,'data:image/png;base64,'+png.toString('base64'));
  assert.equal(r.final_image,'data:image/png;base64,'+png.toString('base64'));
  assert.equal(r.evidence.quality_status,'pending');
  assert.equal(r.evidence.semantic_review,'pending');
});

test('Stage11 preserves semantic risks as an unreviewed draft and rejects claimed semantic auto-approval',()=>{
 const r=report();r.translationInput={version:'stage11-input-v1'};
 r.translations[0].semantic={version:'stage11-risk-v1',automaticQualityApproval:false,humanSemanticVerified:null,semanticAccuracy:null,independentSemanticEvaluation:null,humanReviewRequired:true,semanticReviewRequired:true,statuses:['SEMANTIC_RISK_FLAGGED','SEMANTIC_REVIEW_REQUIRED','SEMANTIC_NOT_MEASURED'],signals:[{code:'POLARITY_RISK',confirmedError:false}]};
 const out=reportToStudioResult(r,assets);assert.deepEqual(out.evidence.translation_semantics[0].signals,r.translations[0].semantic.signals);assert.equal(out.evidence.automatic_quality_approval,false);
 r.translations[0].semantic.automaticQualityApproval=true;assert.throws(()=>reportToStudioResult(r,assets),{code:'INVALID_ENGINE_RESULT'});
 r.translations[0].semantic.automaticQualityApproval=false;
 r.translations[0].semantic.independentSemanticEvaluation={status:'PASS',score:1};assert.throws(()=>reportToStudioResult(r,assets),{code:'INVALID_ENGINE_RESULT'});
 r.translations[0].semantic.independentSemanticEvaluation=null;r.translations[0].semantic.humanReviewRequired=false;assert.throws(()=>reportToStudioResult(r,assets),{code:'INVALID_ENGINE_RESULT'});
});

test('rejects incomplete or mismatched region identities instead of completing',()=>{
  for(const mutate of [
    r=>r.translations.splice(0),r=>r.translations[0].id='other',r=>r.typesetting.layoutReport[0].id='other',
    r=>r.lines.push({...r.lines[0]}),r=>r.lines[0].aiTranslation=' ',r=>r.ocr.speechBubbles[0].id='other',
  ]) { const r=report();mutate(r);assert.throws(()=>reportToStudioResult(r,assets)); }
});

test('rejects simulated evidence, altered assets, invalid geometry and unverified fonts',()=>{
  for(const mutate of [
    r=>r.evidenceKind='SYNTHETIC',r=>r.originalPreserved=false,r=>r.hashes.candidate='0'.repeat(64),
    r=>r.typesetting.layoutReport[0].bbox.x=NaN,r=>r.typesetting.layoutReport[0].bbox.width=2,
    r=>r.typesetting.layoutReport[0].productionFontLoaded=false,r=>r.translations[0].engine='fixture',
  ]) { const r=report();mutate(r);assert.throws(()=>reportToStudioResult(r,assets)); }
});

function pageReport() {
  const r=report(), fingerprint='a'.repeat(64);
  r.hashes.normalized=digest;
  r.lines.push({...r.lines[0],id:'bubble-2',order:2});
  r.ocr.speechBubbles.push({id:'bubble-2'});
  r.typesetting.layoutReport.push({...r.typesetting.layoutReport[0],id:'bubble-2'});
  r.translations=r.lines.map((line,index)=>({id:line.id,engine:'local_ai',usedExactTm:false,
    requestId:'request-page',requestScope:'page',requestedContextFingerprint:fingerprint,
    returnedContextFingerprint:fingerprint,responseIdentity:'validated_page_json_ids',
    modelHttpRequests:index===0?1:0,qaReport:{issues:[]}}));
  r.translationRequests=[{requestId:'request-page',scope:'page',regionIds:r.lines.map(line=>line.id),
    httpRequests:1,contextFingerprint:fingerprint,usedImageContext:true,imageSha256:digest,
    modelAlias:'local-test-model',durationMs:123,usage:null}];
  return r;
}

test('accepts one real page request shared by an exact set of dialogue IDs',()=>{
  const result=reportToStudioResult(pageReport(),assets);
  assert.deepEqual(result.blocks.map(block=>block.id),['bubble-1','bubble-2']);
  assert.equal(result.evidence.quality_status,'pending');
});

test('rejects missing, duplicated or mismatched proof of a shared page request',()=>{
  for(const mutate of [
    r=>delete r.translationRequests,r=>r.translationRequests[0].httpRequests=0,
    r=>r.translationRequests[0].regionIds.pop(),r=>r.translationRequests[0].regionIds.push('foreign'),
    r=>r.translationRequests[0].regionIds[1]='bubble-1',
    r=>r.translationRequests.push({...r.translationRequests[0]}),
    r=>r.translationRequests[0].imageSha256='0'.repeat(64),
    r=>r.translations[1].returnedContextFingerprint='b'.repeat(64),
    r=>r.translations[1].requestId='foreign',r=>r.translations[1].modelHttpRequests=1,
    r=>r.translations[0].modelHttpRequests=0,r=>r.translations[0].responseIdentity='unverified',
    r=>delete r.translations[1].requestScope,
  ]) {const r=pageReport();mutate(r);assert.throws(()=>reportToStudioResult(r,assets),{code:'INVALID_ENGINE_RESULT'});}
});
