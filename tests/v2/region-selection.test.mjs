import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {selectDialogueRegions}=createRequire(import.meta.url)('../../packages/ai-engine/quality/region-selection.cjs');
const box=(x,y,width=.1,height=.1)=>({x,y,width,height});
const ocr=()=>({pageNumber:1,speechBubbles:[{id:'speech',text:'おはよう',bbox:box(.1,.1),readingOrder:1,notes:''},{id:'effect',text:'ドン',bbox:box(.7,.2),readingOrder:2,notes:''}],nonSpeechText:[],warnings:[]});
const detection=(regions)=>({regions});
const region=(id,kind,bbox,confidence=.9)=>({id,kind,bbox,confidence});
test('learned dialogue support selects speech while free text is preserved without inventing a kind',()=>{
 const input=ocr(),copy=structuredClone(input);
 const result=selectDialogueRegions(input,detection([region('d1','text_bubble',box(.09,.09,.13,.13)),region('d2','text_free',box(.69,.19,.13,.13))]));
 assert.deepEqual(result.extraction.speechBubbles.map(r=>r.id),['speech']);
 assert.equal(result.extraction.nonSpeechText[0].id,'effect');assert.equal(result.extraction.nonSpeechText[0].type,'unknown');
 assert.equal(result.selection.decisions.find(r=>r.id==='effect').action,'preserve');assert.deepEqual(input,copy);
});
test('partial, low confidence and bubble-frame-only support do not authorize erasure',()=>{
 for(const support of [region('d1','text_bubble',box(.1,.1,.04,.1)),region('d1','text_bubble',box(.1,.1),.49),region('d1','bubble',box(.1,.1))]){
  const result=selectDialogueRegions(ocr(),detection([support]));assert.equal(result.extraction.speechBubbles.length,0);assert.equal(result.selection.preservedRegions,2);
 }
});
test('a narration-like free region remains visible in the preserved evidence',()=>{
 const input=ocr();input.speechBubbles[1].text='翌朝、彼は学校へ向かった。';
 const result=selectDialogueRegions(input,detection([]));assert.equal(result.extraction.nonSpeechText[1].text,input.speechBubbles[1].text);
});
test('duplicate identities, invalid boxes and untrusted detector kinds are rejected',()=>{
 const duplicate=ocr();duplicate.speechBubbles[1].id='speech';assert.throws(()=>selectDialogueRegions(duplicate,detection([])),/식별자/);
 for(const invalid of [region('x','unknown',box(.1,.1)),region('x','text_bubble',box(.95,.1)),region('x','text_bubble',box(.1,.1),NaN)])assert.throws(()=>selectDialogueRegions(ocr(),detection([invalid])),/좌표/);
});

test('overlapping confident bubble ownership is review-required rather than arbitrarily selecting the first ROI',()=>{
 const out=selectDialogueRegions(ocr(),detection([region('a','text_bubble',box(.09,.09,.13,.13)),region('b','text_bubble',box(.09,.09,.13,.13))]));
 assert.equal(out.selection.decisions[0].action,'needs_review');assert.equal(out.extraction.speechBubbles.length,0);
});
