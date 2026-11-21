import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import { contentSha256 } from '../../packages/evaluation/dataset-contract.mjs';
import { hash } from '../../packages/evaluation/offline/contract.mjs';

const seed = '4'.repeat(64);
const script = fileURLToPath(new URL('../../scripts/v2/first-image-review.mjs', import.meta.url));

function run(action, input) {
  const result = spawnSync(process.execPath, [script, action], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  return result;
}

test('exports a local review folder with anonymous, pinned image bytes and collects one first-image answer', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mangohana-review-cli-'));
  const assetsRoot = path.join(root, 'assets');
  await mkdir(assetsRoot);
  const [sourceSha256, pngSha256] = await Promise.all([0, 180].map(async color => {
    const bytes = await sharp({ create: { width: 100, height: 140, channels: 3,
      background: { r: color, g: 238, b: 222 } } }).png().toBuffer();
    const digest = hash(bytes);
    await writeFile(path.join(assetsRoot, digest + '.png'), bytes, { flag: 'wx' });
    return digest;
  }));
  const pageId = 'synthetic-page';
  const cohort = { evidenceKind: 'synthetic', pages: [{ pageId, workId: 'synthetic-work', sourceSha256,
    annotationSha256: contentSha256({ pageId }), kind: 'typeset', reviewerIds: ['reader-a'] }] };
  const firstRuns = [
    { pageId, sourceSha256, version: 'baseline', status: 'held', attempt: 1, pngSha256: null, reason: 'FIXTURE_HOLD', receiptSha256: 'b'.repeat(64) },
    { pageId, sourceSha256, version: 'improved', status: 'completed', attempt: 1, pngSha256, reason: null, receiptSha256: 'c'.repeat(64) },
  ];
  const pins = { cohortSha256: contentSha256(cohort), firstRunsSha256: contentSha256(firstRuns), seedSha256: contentSha256(seed) };
  const prepared = run('prepare', { cohort, firstRuns, pins, seed });
  assert.equal(prepared.status, 0, prepared.stderr);
  const { seal, sealSha256 } = JSON.parse(prepared.stdout);
  const outputDirectory = path.join(root, 'packet');
  const packetInput = { seal, sealSha256, reviewerId: 'reader-a', assetsRoot, outputDirectory };
  const packed = run('packet', packetInput);
  assert.equal(packed.status, 0, packed.stderr);
  const html = await readFile(path.join(outputDirectory, 'index.html'), 'utf8');
  const packet = JSON.parse(html.match(/<script type="application\/json" id="review-data">([^<]+)<\/script>/)[1]);
  const [item] = packet.items;
  assert.deepEqual((await readdir(outputDirectory)).sort(), [`${item.sourceRef}.png`, `${item.images[0].ref}.png`, 'index.html'].sort());
  assert.equal(hash(await readFile(path.join(outputDirectory, item.sourceRef + '.png'))), sourceSha256);
  assert.equal(hash(await readFile(path.join(outputDirectory, item.images[0].ref + '.png'))), pngSha256);
  for (const value of [sourceSha256, pngSha256, pageId, 'baseline', 'improved']) assert.ok(!html.includes(value));
  assert.equal(run('packet', packetInput).status, 1);

  const response = { assignmentId: item.assignmentId, imageRef: item.images[0].ref,
    ratings: Object.fromEntries(Object.keys(packet.questions).map(axis => [axis, 'pass'])), defects: [] };
  const collected = run('collect', { cohort, firstRuns, seal, pins: { ...pins, sealSha256 }, returns: [{ reviewerId: 'reader-a', responses: [response] }] });
  assert.equal(collected.status, 0, collected.stderr);
  const report = JSON.parse(collected.stdout);
  assert.equal(report.evidenceKind, 'synthetic');
  assert.equal(report.total.baseline.statusCounts.held, 1);
  assert.equal(report.total.improved.noEditRate.numerator, 1);

  await writeFile(path.join(assetsRoot, pngSha256 + '.png'), await readFile(path.join(assetsRoot, sourceSha256 + '.png')));
  const wrongOutput = path.join(root, 'wrong-image');
  const refused = run('packet', { ...packetInput, outputDirectory: wrongOutput });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stderr).code, 'FIRST_IMAGE_REVIEW_PNG_MISMATCH');
  await assert.rejects(readFile(path.join(wrongOutput, 'index.html')), { code: 'ENOENT' });
});
