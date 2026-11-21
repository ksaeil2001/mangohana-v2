import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { honorificWrapAlternatives, inspectTypesettingText, measureCandidateFit } =
  await tsImport('../../packages/ai-engine/vendor/trio/src/renderer/candidateTypesettingFit.ts', import.meta.url);

test('soft wraps can move either side of a name and honorific, keeping original spaces and punctuation', () => {
  const text = '자 우라라  선배, 이거 마셔.';
  const alternatives = honorificWrapAlternatives(text, ['자 우라라', '선배, 이거', '마셔.']);
  assert.deepEqual(alternatives, [
    ['자 우라라  선배,', '이거', '마셔.'],
    ['자', '우라라  선배, 이거', '마셔.'],
    ['자', '우라라  선배,', '이거 마셔.'],
  ]);
  for (const rows of alternatives) assert.equal(inspectTypesettingText(text, rows).complete, true);
  assert.deepEqual(honorificWrapAlternatives('고마워 히로 군...', ['고마워', '히로', '군...']), [['고마워', '히로 군...']]);
  assert.deepEqual(honorificWrapAlternatives('히로 군의 설명은', ['히로', '군의', '설명은']), [['히로 군의', '설명은']]);
});

test('authored breaks, sentence breaks and words beginning with a title stay intact', () => {
  for (const [text, rows] of [
    ['우라라\n선배, 이거', ['우라라', '선배, 이거']],
    ['기다려! 선배, 이거', ['기다려!', '선배, 이거']],
    ['새로 온 군인은', ['새로 온', '군인은']],
    ['하얀 양말도', ['하얀', '양말도']],
    ['작은 씨앗을', ['작은', '씨앗을']],
    ['여보세요 선배님?', ['여보세요', '선배님?']],
  ]) assert.deepEqual(honorificWrapAlternatives(text, rows), []);
});

test('a suggested wrap is measured with the complete original text as the authority', () => {
  const canvas = { save() {}, restore() {}, measureText(value) {
    const px = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 20), width = [...value].length * px * .65;
    return { width, actualBoundingBoxLeft: width / 2, actualBoundingBoxRight: width / 2,
      actualBoundingBoxAscent: px * .4, actualBoundingBoxDescent: px * .4 };
  } };
  const style = { bbox: { x: .1, y: .1, width: .8, height: .8 }, writingMode: 'horizontal-tb', shape: 'rectangle', lineHeight: 1.3, fontSizeRatio: 20 / 240 };
  const measure = softLines => measureCandidateFit(canvas, '오늘 히로 군이 왔어.', style, 300, 300, { softLines });
  const valid = measure(['오늘', '히로 군이 왔어.']);
  assert.deepEqual(valid.layout.lines.map(line => line.text), ['오늘', '히로 군이 왔어.']);
  assert.ok(valid.completeText && valid.fitsBox);
  assert.equal(measure(['오늘', '히로 왔어.']).status, 'MANUAL_LAYOUT_REQUIRED');
});
