import test from'node:test';import assert from'node:assert/strict';import {tsImport}from'tsx/esm/api';
const {measureCandidateFit}=await tsImport('../../packages/ai-engine/vendor/trio/src/renderer/candidateTypesettingFit.ts',import.meta.url);
function canvas(){return{font:'',save(){},restore(){},measureText(t){const px=Number(this.font.match(/([\d.]+)px/)?.[1]??20),width=[...t].length*px*.8;return{width,actualBoundingBoxLeft:width/2,actualBoundingBoxRight:width/2,actualBoundingBoxAscent:px*.45,actualBoundingBoxDescent:px*.45};}};}
const style={bbox:{x:.1,y:.1,width:.4,height:.6},writingMode:'horizontal-tb',shape:'rectangle',lineHeight:1.3};
test('real-metrics fit reports the common standard and source-only evidence for ordinary Korean',()=>{const r=measureCandidateFit(canvas(),'오늘은 정말 기분이 좋아!',{...style,fontSizeRatio:24/600},1000,1000);assert.equal(r.standard?.profile,'KO_GENERAL_HORIZONTAL_V1');assert.equal(r.standard.finalRasterVerified,false);assert.equal(r.standard.hardViolations.length,0);assert.equal(r.selection.rule,'KO_STANDARD_V1');});
test('a fixed below-minimum size remains unchanged and is BLOCKED rather than silently resized',()=>{const r=measureCandidateFit(canvas(),'아싸~!',{...style,fontSizeRatio:12/600},1000,1000);assert.equal(r.fontSizePx,12);assert.equal(r.standard?.status,'BLOCKED');assert.equal(r.status,'MANUAL_LAYOUT_REQUIRED');});
test('special shape and vertical fits retain the legacy profile instead of general Korean certification',()=>{for(const override of[{shape:'spiky'},{writingMode:'vertical-rl'}]){const r=measureCandidateFit(canvas(),'다음엔 둘이서,',{...style,...override,fontSizeRatio:24/600},1000,1000);assert.equal(r.standard?.profile??'OUT_OF_GENERAL_PROFILE','OUT_OF_GENERAL_PROFILE');assert.equal(r.selection.rule,'SIZE_AND_EOJEOL_V1');}});
test('an intact word overflowing the configured inner span is blocked even when its ink stays inside the outer box',()=>{const r=measureCandidateFit(canvas(),'설명은',{...style,bbox:{x:.1,y:.1,width:73/500,height:357/500},fontSizeRatio:27/357},500,500);assert.deepEqual(r.layout.lines.map(l=>l.text),['설명은']);assert.ok(r.inkBounds[0].left>=0&&r.inkBounds[0].right<=73);assert.equal(r.fitsBox,false);assert.equal(r.standard.status,'BLOCKED');});
test('line search uses the same existing measured span tolerance as the fit gate instead of falling back to one token per line',()=>{const r=measureCandidateFit(canvas(),'가나다라 좀 더 마바사아',{...style,bbox:{x:.1,y:.1,width:75/500,height:300/500},fontSizeRatio:20/300},500,500);assert.equal(r.fontSizePx,20);assert.equal(r.fitsBox,true);assert.deepEqual(r.layout.lines.map(l=>l.text),['가나다라','좀 더','마바사아']);});
test('short automatic dialogue in a shallow box tries the readable minimum before asking for manual lettering', () => {
  const shallow = { ...style, bbox: { x: .1, y: .1, width: 80 / 500, height: 25 / 500 } };
  const fitted = measureCandidateFit(canvas(), '그래!', shallow, 500, 500);
  assert.equal(fitted.fontSizePx, 13);
  assert.equal(fitted.fitsBox, true);
  assert.equal(fitted.standard.hardViolations.length, 0);
  assert.deepEqual(fitted.layout.lines.map(line => line.text), ['그래!']);
  const tooShallow = measureCandidateFit(canvas(), '그래!', { ...shallow, bbox: { ...shallow.bbox, height: 9 / 500 } }, 500, 500);
  assert.equal(tooShallow.status, 'MANUAL_LAYOUT_REQUIRED');
});
