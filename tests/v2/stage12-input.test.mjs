import test from 'node:test';import assert from 'node:assert/strict';import {tsImport} from 'tsx/esm/api';
const renderer=await tsImport('../../packages/ai-engine/vendor/trio/scripts/local-preview/renderer.ts',import.meta.url);
const ocr=()=>({pageNumber:2,warnings:[],nonSpeechText:[],speechBubbles:[{id:'a',readingOrder:1,bbox:{x:.2,y:.2,width:.3,height:.3},text:'原文',confidence:1,type:'speech_bubble'}]});
test('OCR needs_review cannot become a typesetting-ready draft',()=>{const input=ocr();input.speechBubbles[0].ocrReview={status:'needs_review'};assert.throws(()=>renderer.draftLines(input));});
test('preserved sound effects never enter automatic speech typesetting',()=>{const input=ocr();input.speechBubbles[0].type='sound_effect';assert.throws(()=>renderer.draftLines(input));});
test('source identity and user geometry can be snapshotted without changing a confirmed value',()=>{
 assert.equal(typeof renderer.validateCandidateSourceSnapshot,'function');
 const lines=renderer.draftLines(ocr()),incoming=structuredClone(lines);incoming[0].aiTranslation='한국어';
 const before=structuredClone(incoming);renderer.validateCandidateSourceSnapshot(incoming,lines);assert.deepEqual(incoming,before);
 for(const patch of [{pageNumber:1},{sourceText:'다른 원문'},{order:2},{typesetting:{bbox:{x:.1,y:.1,width:.3,height:.3},writingMode:'horizontal-tb'}},{ocrEditStatus:'user_confirmed'},{userTranslation:'확정 번역'}]){
  const bad=structuredClone(incoming);Object.assign(bad[0],patch);assert.throws(()=>renderer.validateCandidateSourceSnapshot(bad,lines));
 }
 assert.throws(()=>renderer.validateCandidateSourceSnapshot([incoming[0],incoming[0]],lines));
});
