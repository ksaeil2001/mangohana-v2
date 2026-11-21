import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { hash } from '../../packages/evaluation/offline/contract.mjs';
import { contentSha256 } from '../../packages/evaluation/dataset-contract.mjs';
import { summarizeFirstImagePairs } from '../../packages/evaluation/first-image-paired-report.mjs';
import { captureFirstImageRuns } from '../../scripts/v2/first-image-capture.mjs';

const owner = 'd'.repeat(64);
const writeJson = (file, data) => writeFile(file, JSON.stringify(data));
const byVersion = (rows, version, pageId) => rows.find(row => row.version === version && row.pageId === pageId);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mangohana-first-attempt-'));
  const frames = await Promise.all([20, 70, 190, 210].map(r => sharp({ create: { width: 40, height: 60, channels: 3,
    background: { r, g: 245, b: 230 } } }).png().toBuffer()));
  const cohort = { evidenceKind: 'synthetic', pages: ['p1', 'p2', 'p3'].map((pageId, i) => ({ pageId, workId: 'work-a',
    sourceSha256: hash(frames[i]), annotationSha256: contentSha256({ pageId }), kind: 'typeset', reviewerIds: ['reader-a'] })) };

  async function writeJob(storeRoot, { batchId, stateId, source, pageNumber, status, patch = {} }) {
    const dir = path.join(storeRoot, stateId);
    await mkdir(dir);
    const sourceSha256 = hash(source), state = { id: stateId, owner, projectId: 'test-work', pageId: `engine-${pageNumber}`,
      sequence: pageNumber, pageNumber, sourceSha256, status, stage: status, version: 1, batchId,
      mime: 'image/png', width: 40, height: 60, ...patch };
    await writeFile(path.join(dir, 'source.png'), source);
    if (state.status === 'completed') {
      const candidateSha256 = hash(frames[3]);
      const report = { version: 1, evidenceKind: 'LOCAL_ENGINE_CANDIDATE', jobId: stateId, userApproved: false,
        originalPreserved: true, manualCorrections: 0, hashes: { original: sourceSha256, candidate: candidateSha256 },
        lines: [{ aiTranslation: '합성' }], image: { width: state.width, height: state.height } };
      const bytes = Buffer.from(JSON.stringify(report));
      state.reportSha256 = hash(bytes);
      state.resultReceipt = { revision: 1, jobId: stateId, processingGeneration: state.sequence, sourceSha256,
        reportSha256: state.reportSha256, candidateSha256 };
      await writeFile(path.join(dir, 'report.json'), bytes);
      await writeFile(path.join(dir, 'candidate.png'), frames[3]);
    }
    await writeJson(path.join(dir, 'state.json'), state);
    return { dir, state };
  }

  const stores = [];
  const evidence = {};
  for (const version of ['baseline', 'improved']) {
    const storeRoot = path.join(root, version), batchId = randomUUID(), batchDir = path.join(storeRoot, 'batches', batchId);
    const first = randomUUID(), other = randomUUID(), retry = randomUUID();
    await mkdir(batchDir, { recursive: true });
    const initial = await writeJob(storeRoot, { batchId, stateId: first, source: frames[0], pageNumber: 1,
      status: version === 'baseline' ? 'failed' : 'completed',
      patch: version === 'baseline' ? { stage: 'needs_review', errorCode: 'PARTIAL_TYPESETTING', retryJobId: retry } : {} });
    if (version === 'baseline') await writeJob(storeRoot, { batchId, stateId: retry, source: frames[0], pageNumber: 1,
      status: 'completed', patch: { retryOf: first, sequence: 5 } });
    await writeJob(storeRoot, { batchId, stateId: other, source: frames[1], pageNumber: 2,
      status: version === 'baseline' ? 'result_unknown' : 'failed',
      patch: version === 'baseline' ? { errorCode: 'RESULT_UNKNOWN' }
        : { errorCode: 'CLEANUP_FAILED', recovery: { type: 'cleanup_unknown' } } });
    const batch = { version: 1, id: batchId, owner, projectId: 'test-work', status: 'accepted',
      pages: [first, other].map((jobId, i) => ({ jobId, pageId: `engine-${i + 1}`, pageNumber: i + 1, sourceSha256: hash(frames[i]) })) };
    const batchPath = path.join(batchDir, 'state.json');
    await writeJson(batchPath, batch);
    stores.push({ version, storeRoot, batches: [{ batchId, workId: 'work-a', batchSha256: hash(await readFile(batchPath)) }] });
    evidence[version] = { initial, retry, batch, batchPath };
  }
  const pins = { cohortSha256: contentSha256(cohort) };
  const notRun = ['baseline', 'improved'].map(version => ({ version, pageId: 'p3', reason: 'CAPACITY' }));
  return { root, cohort, stores, evidence, frames, pins, notRun, outputDirectory: path.join(root, 'capture') };
}

test('captures the original admitted job, keeps unknowns ungraded and writes the exact review PNGs', async () => {
  const input = await fixture();
  const result = await captureFirstImageRuns(input);
  assert.equal(result.firstRunsSha256, contentSha256(result.firstRuns));
  assert.deepEqual(JSON.parse(await readFile(path.join(input.outputDirectory, 'first-runs.json'), 'utf8')), result);
  const old = byVersion(result.firstRuns, 'baseline', 'p1');
  assert.equal(old.status, 'held');
  assert.equal(old.attempt, 1);
  assert.equal(old.reason, 'PARTIAL_TYPESETTING');
  assert.equal(old.pngSha256, null);
  assert.equal(byVersion(result.observations, 'baseline', 'p1').jobId, input.evidence.baseline.initial.state.id);
  assert.ok(!JSON.stringify(result).includes(input.evidence.baseline.retry));
  assert.ok(!JSON.stringify(result).includes(owner));
  const improved = byVersion(result.firstRuns, 'improved', 'p1');
  assert.equal(improved.status, 'completed');
  assert.equal(improved.pngSha256, hash(input.frames[3]));
  assert.deepEqual(await readFile(path.join(result.assetsRoot, `${improved.pngSha256}.png`)), input.frames[3]);
  assert.deepEqual(await readFile(path.join(result.assetsRoot, `${old.sourceSha256}.png`)), input.frames[0]);
  assert.equal(byVersion(result.firstRuns, 'baseline', 'p2'), undefined);
  assert.equal(byVersion(result.observations, 'baseline', 'p2').reason, 'RESULT_UNKNOWN');
  assert.equal(byVersion(result.firstRuns, 'improved', 'p2'), undefined);
  assert.equal(byVersion(result.observations, 'improved', 'p2').reason, 'CLEANUP_FAILED');
  assert.equal(byVersion(result.firstRuns, 'baseline', 'p3').status, 'not_run');
  const scored = summarizeFirstImagePairs({ cohort: input.cohort, firstRuns: result.firstRuns, reviews: [] }, result);
  assert.equal(scored.total.baseline.noEditRate.value, null);
  assert.equal(scored.total.baseline.statusCounts.missing, 1);
  assert.equal(scored.total.baseline.noEditRate.denominator, 3);
  assert.deepEqual(await readdir(input.evidence.baseline.initial.dir), ['source.png', 'state.json'].sort());
});

test('a verified file digest cannot make a manually corrected result a first automatic PNG', async () => {
  const input = await fixture();
  const { dir, state } = input.evidence.improved.initial;
  const file = path.join(dir, 'report.json');
  const report = JSON.parse(await readFile(file));
  report.manualCorrections = 1;
  const bytes = Buffer.from(JSON.stringify(report));
  state.reportSha256 = hash(bytes);
  state.resultReceipt.reportSha256 = hash(bytes);
  await writeFile(file, bytes);
  await writeJson(path.join(dir, 'state.json'), state);
  await assert.rejects(captureFirstImageRuns(input), { code: 'FIRST_IMAGE_CAPTURE_RECEIPT_MISMATCH' });
});

test('rejects a changed candidate, wrong recorded run or conflicting no-run declaration', async () => {
  const input = await fixture();
  const candidate = path.join(input.evidence.improved.initial.dir, 'candidate.png');
  await writeFile(candidate, input.frames[0]);
  await assert.rejects(captureFirstImageRuns(input), { code: 'FIRST_IMAGE_CAPTURE_PNG_MISMATCH' });
  await assert.rejects(readFile(path.join(input.outputDirectory, 'first-runs.json')), { code: 'ENOENT' });
  await writeFile(candidate, input.frames[3]);
  input.outputDirectory = path.join(input.root, 'capture-2');
  const baseline = input.evidence.baseline;
  baseline.batch.pages[0].jobId = baseline.retry;
  await writeJson(baseline.batchPath, baseline.batch);
  await assert.rejects(captureFirstImageRuns(input), { code: 'FIRST_IMAGE_CAPTURE_BATCH_MISMATCH' });
  input.stores[0].batches[0].batchSha256 = hash(await readFile(baseline.batchPath));
  await assert.rejects(captureFirstImageRuns({ ...input, outputDirectory: path.join(input.root, 'capture-3') }), { code: 'FIRST_IMAGE_CAPTURE_JOB_MISMATCH' });
  baseline.batch.pages[0].jobId = baseline.initial.state.id;
  await writeJson(baseline.batchPath, baseline.batch);
  input.stores[0].batches[0].batchSha256 = hash(await readFile(baseline.batchPath));
  input.notRun.push({ version: 'baseline', pageId: 'p1', reason: 'CAPACITY' });
  await assert.rejects(captureFirstImageRuns({ ...input, outputDirectory: path.join(input.root, 'capture-4') }), { code: 'FIRST_IMAGE_CAPTURE_NOT_RUN_CONFLICT' });
});
