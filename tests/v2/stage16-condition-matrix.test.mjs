import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createConditionMatrix } from '../../packages/evaluation/stage16-condition-matrix.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const cli = fileURLToPath(new URL('../../scripts/v2/prepare-stage16-matrix.mjs', import.meta.url));

function fixture() {
  return {
    shared: {
      workId: 'synthetic-work', pageId: 'synthetic-page',
      sourceSha256: sha('source'), fontSha256: sha('font'), settingsSha256: sha('settings'),
      contextSnapshotSha256: sha('context'), intermediateSha256: sha('intermediate'),
    },
    models: { A: sha('model-a-version'), B: sha('model-b-version') },
    processing: { baseline: sha('old-pipeline'), improved: sha('new-pipeline') },
  };
}

function runCli(input, args = []) {
  return spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });
}

test('offline CLI constructs exactly four planned conditions for the same synthetic page', () => {
  const input = fixture();
  const run = runCli(JSON.stringify(input));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const { matrixSha256, ...matrix } = JSON.parse(run.stdout);
  const cell = (model, processing) => ({
    model, modelSha256: input.models[model],
    processing, processingSha256: input.processing[processing],
  });
  assert.deepEqual(matrix, {
    schemaVersion: 1, kind: 'stage16-condition-matrix', shared: input.shared,
    conditions: [cell('A', 'baseline'), cell('A', 'improved'), cell('B', 'baseline'), cell('B', 'improved')],
  });
  assert.equal(matrixSha256, sha(JSON.stringify(matrix)));
});

test('reordering equivalent JSON does not change its matrix fingerprint', () => {
  const input = fixture();
  const reversed = object => Object.fromEntries(Object.entries(object).reverse());
  const reordered = reversed({
    shared: reversed(input.shared), models: reversed(input.models), processing: reversed(input.processing),
  });
  assert.deepEqual(createConditionMatrix(reordered), createConditionMatrix(input));
});

test('the work, page, every shared pin and each axis pin bind the matrix identity', () => {
  const input = fixture();
  const identity = createConditionMatrix(input).matrixSha256;
  for (const [section, fields] of Object.entries(input)) {
    for (const field of Object.keys(fields)) {
      const changed = structuredClone(input);
      changed[section][field] = field.endsWith('Id') ? 'other-id' : sha('different');
      assert.notEqual(createConditionMatrix(changed).matrixSha256, identity, field);
    }
  }
});

test('explicitly planning the full path has a distinct identity from fixed intermediate input', () => {
  const input = fixture();
  const fixed = createConditionMatrix(input);
  input.shared.intermediateSha256 = null;
  const full = createConditionMatrix(input);
  assert.equal(full.shared.intermediateSha256, null);
  assert.notEqual(full.matrixSha256, fixed.matrixSha256);
  assert.deepEqual(full.conditions, fixed.conditions);
});

test('input and output remain independent after planning', () => {
  const input = fixture();
  const before = structuredClone(input);
  const matrix = createConditionMatrix(input);
  assert.deepEqual(input, before);
  input.shared.sourceSha256 = sha('later-source');
  input.models.A = sha('later-model');
  assert.equal(matrix.shared.sourceSha256, before.shared.sourceSha256);
  assert.equal(matrix.conditions[0].modelSha256, before.models.A);
});

const invalid = 'INVALID_STAGE16_MATRIX';
const invalidCases = [
  ['missing model B', input => { delete input.models.B; }, invalid],
  ['a third model', input => { input.models.C = sha('c'); }, invalid],
  ['a missing processing revision', input => { delete input.processing.improved; }, invalid],
  ['the same model version in both slots', input => { input.models.B = input.models.A; }, 'STAGE16_MODEL_PINS_IDENTICAL'],
  ['the same processing version in both slots', input => { input.processing.improved = input.processing.baseline; }, 'STAGE16_PROCESSING_PINS_IDENTICAL'],
  ['a mutable model label', input => { input.models.A = 'model-latest'; }, invalid],
  ['an unpinned processing revision', input => { input.processing.improved = null; }, invalid],
  ['an omitted intermediate decision', input => { delete input.shared.intermediateSha256; }, invalid],
  ['an invalid intermediate fingerprint', input => { input.shared.intermediateSha256 = ''; }, invalid],
  ['a missing work identity', input => { delete input.shared.workId; }, invalid],
  ['a blank page identity', input => { input.shared.pageId = ' '; }, invalid],
  ['an unpinned source', input => { input.shared.sourceSha256 = 'page.png'; }, invalid],
  ['an unpinned font', input => { delete input.shared.fontSha256; }, invalid],
  ['an unpinned settings file', input => { input.shared.settingsSha256 = 0; }, invalid],
  ['unknown context', input => { input.shared.contextSnapshotSha256 = null; }, invalid],
  ['per-condition overrides', input => { input.conditions = [{ model: 'A', fontSha256: sha('other-font') }]; }, invalid],
  ['results in a pre-run plan', input => { input.shared.score = 1; }, invalid],
  ['a non-object axis', input => { input.processing = []; }, invalid],
  ['a model pin inherited instead of supplied', input => { input.models = Object.assign(Object.create({ A: input.models.A }), { B: input.models.B }); }, invalid],
];

for (const [description, edit, code] of invalidCases) {
  test(`rejects ${description}`, () => {
    const input = fixture();
    edit(input);
    assert.throws(() => createConditionMatrix(input), { code });
  });
}

test('invalid stdin and arguments fail with a fixed code and no partial plan or input echo', () => {
  const bad = fixture();
  bad.shared.fontSha256 = 'private-fixture-text';
  for (const [stdin, args, code] of [
    ['private-fixture-text', [], 'INVALID_JSON'],
    [JSON.stringify(bad), [], invalid],
    [JSON.stringify(fixture()), ['--execute'], 'INVALID_ARGUMENTS'],
  ]) {
    const run = runCli(stdin, args);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.deepEqual(JSON.parse(run.stderr), { code });
  }
});
