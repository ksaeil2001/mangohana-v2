import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { annotationContentSha256, contentSha256 } from '../../packages/evaluation/dataset-contract.mjs';
import { summarizeTextCoverage } from '../../packages/evaluation/offline/text-coverage.mjs';
import { evaluateOcrPages } from '../../packages/evaluation/offline/ocr.mjs';

const sourceSha256 = 'a'.repeat(64);

function fixture(count = 10) {
  const lines = Array.from({ length: count }, (_, index) => ({
    lineId: `truth-${index}`,
    role: index === 9 ? 'sfx' : 'dialogue',
    transcription: { status: 'readable', text: '確認' },
    readingOrder: { status: 'verified', value: index + 1 },
  }));
  return {
    annotation: { pageId: 'page', sourceSha256, status: 'human_verified', coverage: { ocr: 'complete', regions: 'complete' }, lines },
    inventory: { pageId: 'page', sourceSha256, lines: lines.map((line, index) => ({
      lineId: `seen-${index}`, source: line.transcription.text, readingOrder: index + 1,
    })) },
    matches: lines.map(({ lineId }, index) => ({ lineId, parts: [{ outputLineId: `seen-${index}` }] })),
  };
}

function compare({ annotation, inventory, matches }) {
  return { annotationSha256: annotationContentSha256(annotation), inventorySha256: contentSha256(inventory), matches };
}

function summarize(fixtureValue) {
  return summarizeTextCoverage({ ...fixtureValue, comparison: compare(fixtureValue) });
}

test('one missed sound effect in ten truth lines yields 9/10 detection and 0/1 complete page', () => {
  const input = fixture();
  input.inventory.lines.pop();
  input.matches[9].parts = [];

  const result = summarize(input);
  assert.deepEqual(result.detection, { numerator: 9, denominator: 10, value: 0.9, reason: null });
  assert.equal(result.completeReadablePage, false);
  assert.deepEqual(result.missingLineIds, ['truth-9']);
  assert.deepEqual(result.blankLineIds, []);
  assert.equal(result.byRole.sfx.missing, 1);
});

test('blank and misread lines are distinct from missed geometry and duplicate detections', () => {
  const input = fixture();
  input.inventory.lines[0].source = '';
  input.inventory.lines[1].source = '確忍';
  input.inventory.lines.push({ lineId: 'duplicate', source: '確認', readingOrder: 11 });
  input.matches[1].duplicateOutputLineIds = ['duplicate'];

  const result = summarize(input);
  assert.equal(result.detection.numerator, 10);
  assert.equal(result.nonblankRecognition.numerator, 9);
  assert.deepEqual(result.blankLineIds, ['truth-0']);
  assert.deepEqual(result.incorrectLineIds, ['truth-1']);
  assert.deepEqual(result.duplicateLineIds, ['truth-1']);
  assert.deepEqual(result.extraOutputLineIds, []);
  assert.equal(result.completeReadablePage, false);
});

test('a merge with distinct confirmed character spans and a split both retain the truth lines', () => {
  const input = fixture(3);
  input.inventory.lines = [
    { lineId: 'joined', source: '確認確認', readingOrder: 1 },
    { lineId: 'first', source: '確', readingOrder: 2 },
    { lineId: 'second', source: '認', readingOrder: 3 },
  ];
  input.matches[0].parts = [{ outputLineId: 'joined', start: 0, end: 2 }];
  input.matches[1].parts = [{ outputLineId: 'joined', start: 2, end: 4 }];
  input.matches[2].parts = [{ outputLineId: 'first' }, { outputLineId: 'second' }];

  const result = summarize(input);
  assert.equal(result.completeReadablePage, true);
  assert.equal(result.detection.numerator, 3);
  assert.deepEqual(result.incorrectLineIds, []);
  assert.deepEqual(result.extraOutputLineIds, []);
  assert.deepEqual(result.orderErrorLineIds, []);
  input.matches[1].parts[0].start = 1;
  assert.throws(() => summarize(input), { code: 'TEXT_COVERAGE_COMPARISON_INVALID' });
});

test('known text-free pages expose false detections and missing truth stays unmeasured', () => {
  const input = fixture(0);
  input.inventory.lines = [{ lineId: 'artwork', source: '', readingOrder: 1 }];
  const result = summarize(input);
  assert.deepEqual(result.extraOutputLineIds, ['artwork']);
  assert.equal(result.completeReadablePage, null);
  assert.equal(result.detection.value, null);

  const missing = summarizeTextCoverage({ inventory: input.inventory });
  assert.equal(missing.reason, 'VERIFIED_TEXT_ANNOTATION_REQUIRED');
  assert.equal(missing.detection.value, null);
});

test('coverage binds the changed prediction bytes and detects swapped read order', () => {
  const input = fixture(2);
  const comparison = compare(input);
  input.inventory.lines[0].readingOrder = 2;
  input.inventory.lines[1].readingOrder = 1;
  assert.throws(() => summarizeTextCoverage({ ...input, comparison }), { code: 'TEXT_COVERAGE_COMPARISON_INVALID' });
  assert.deepEqual(summarize(input).orderErrorLineIds, ['truth-0', 'truth-1']);
});

test('the offline OCR adapter can include bound line coverage without changing the Stage02 record', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'mangohana-text-coverage-'));
  t.after(async () => {
    assert.equal(path.dirname(workspace), path.resolve(tmpdir()));
    await rm(workspace, { force: true, recursive: true });
  });
  const input = fixture();
  const bytes = Buffer.from('separate synthetic source fixture');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const source = path.join(workspace, 'source.png');
  await writeFile(source, bytes);
  input.annotation.sourceSha256 = sha;
  input.inventory.sourceSha256 = sha;
  input.inventory.lines.pop();
  input.matches[9].parts = [];
  const page = { pageId: 'page', workId: 'work', duplicateGroupId: 'example',
    source: { path: source, sha256: sha }, groundTruth: { status: 'pending' }, evidenceKind: 'synthetic',
    textCoverageEvidence: { annotation: input.annotation, inventory: input.inventory, comparison: compare(input) } };
  const report = await evaluateOcrPages({ runId: 'synthetic-coverage', split: 'dev', workspace: path.join(workspace, 'derived'), pages: [page] });
  assert.equal(report.pages[0].ocr, null);
  assert.equal(report.textCoverage[0].pageId, 'page');
  assert.equal(report.textCoverage[0].detection.numerator, 9);
  assert.equal(report.textCoverage[0].completeReadablePage, false);
});
