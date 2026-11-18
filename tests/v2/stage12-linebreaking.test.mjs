import test from 'node:test';
import assert from 'node:assert/strict';
import {tsImport} from 'tsx/esm/api';
const breaking=await tsImport('../../packages/ai-engine/vendor/trio/src/shared/typesettingKoreanBreak.ts',import.meta.url);
const geometry=await tsImport('../../packages/ai-engine/vendor/trio/src/shared/typesettingGeometry.ts',import.meta.url);
const renderer=await tsImport('../../packages/ai-engine/vendor/trio/src/renderer/imageBurnInRenderer.ts',import.meta.url);
const width=t=>[...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(t)].length;
const breakAt=(t,n)=>breaking.evaluateAndBreakKoreanText(t,{estimateWidth:width,getAvailableWidth:()=>n,maxLines:40});
const compact=t=>t.replace(/\s/g,'');

test('user applied CRLF and explicit blank line survive final render text resolution',()=>{
 assert.equal(renderer.getResolvedDialogueText({userTranslation:'첫 줄\r\n\r\n둘째 줄'}),'첫 줄\n\n둘째 줄');
 assert.equal(renderer.getResolvedDialogueText({aiTranslation:'초안'}),'');
});
test('a single Korean utterance remains intact even when a narrow box must report overflow',()=>{
 const text='아무리길어도문자하나생략하지않고끝까지모두보존합니다';
 const lines=breakAt(text,5);assert.deepEqual(lines,[text]);assert.ok(width(lines[0])>5);
});
test('punctuation wholly consumed by KLREQ is never inserted twice',()=>{
 const lines=breakAt('안녕 !',2);assert.equal(compact(lines.join('')),compact('안녕 !'));
});
test('decomposed Hangul and combining marks are never split inside a grapheme',()=>{
 const text='한글자모e\u0301한글';const lines=breakAt(text,2);
 assert.equal(lines.join(''),text);const boundaries=new Set([0,...[...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(text)].map(s=>s.index+s.segment.length)]);
 let offset=0;for(const l of lines){offset+=l.length;assert.ok(boundaries.has(offset));}
});
test('multiple internal spaces are retained rather than silently collapsed',()=>{
 assert.deepEqual(breakAt('둘  사이   간격',99),['둘  사이   간격']);
});
test('empty manual paragraph reserves a line and explicit lines are never rejoined',()=>{
 const r=geometry.layoutTextForBubbleShape('첫째\n\n둘째',{shape:'rectangle',fontSizeRatio:.12});
 assert.deepEqual(r.lines.map(l=>l.text),['첫째','','둘째']);assert.ok(r.lines[2].relativeY>r.lines[0].relativeY+.2);
});
test('long Latin names and numeric units remain unbroken, allowing a fit failure instead of truncation',()=>{
 const text='AlexandertheGreat 123.45kg 정말…!?';const lines=breakAt(text,8);
 assert.ok(lines.some(l=>l.includes('AlexandertheGreat')));assert.ok(lines.some(l=>l.includes('123.45kg')));assert.equal(compact(lines.join('')),compact(text));
});
test('an ordinary eojeol fitting a whole line is not split to fill the preceding short line',()=>{
 for(const [text,word,n]of [['이 말풍선의 대사야.','말풍선의',5],['우라라 선배! 조금만 더예요!','우라라',4],['옆 대사와 겹치면 안 돼!','대사와',4]]){
  assert.ok(breakAt(text,n).some(l=>l.includes(word)),text);
 }
});
test('a long English name keeps its following Korean particle even when the token must overflow',()=>{
 assert.ok(breakAt('AlexandertheGreat는 정말',16).some(l=>l.includes('AlexandertheGreat는')));
});
for(const text of ['안녕!','여러 줄 대사를 전부 보존해 줘.','“정말이야…!?” (그렇다.)','12kg과 30%는 달라요.','Hello 한글 日本語','내가 어제 먹었던 라면은 정말로 맛있었어!']){
 test('complete deterministic layout: '+text,()=>{const options={shape:'ellipse',boxAspectRatio:.8};const a=geometry.autoFitFontSizeForBubbleShape(text,options),b=geometry.autoFitFontSizeForBubbleShape(text,options);assert.deepEqual(a,b);assert.equal(compact(a.lines.map(l=>l.text).join('')),compact(text));});
}
