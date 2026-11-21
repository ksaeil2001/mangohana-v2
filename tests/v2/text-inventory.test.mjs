import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEngineServer } from '../../apps/engine/server.mjs';
import { createJobStore } from '../../apps/engine/store.mjs';
import inventoryApi from '../../packages/ai-engine/quality/text-inventory.cjs';
import onnxApi from '../../packages/ai-engine/quality/product-onnx.cjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+A5XkAAAAASUVORK5CYII=', 'base64');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const origin = 'http://127.0.0.1:5173';
const owner = hash('only synthetic OCR owner');
const foreign = hash('separate owner');
const reviewRequired = () => Object.assign(new Error('Synthetic OCR needs review'), { code: 'OCR_REVIEW_REQUIRED' });

test('the saved inventory exposes an unfinished high-resolution tile search and protects the image path', () => {
  const bbox = { x: .1, y: .1, width: .2, height: .2 };
  const row = { id: 'line', kind: 'text_bubble', confidence: .9, source: 'テスト', bbox };
  const binding = { jobId: 'synthetic', pageId: 'page', pageNumber: 1, processingGeneration: 1,
    sourceSha256: hash('original'), normalizedSha256: hash('normalized'), ocrSha256: hash('ocr'),
    configuration: hash('config'), ocrSourceJobId: 'synthetic', width: 100, height: 100 };
  const data = { page: 'synthetic', sourceSha256: binding.normalizedSha256, width: 100, height: 100,
    lines: [row], detections: [row], uncoveredBubbles: [],
    independentSearch: { plannedTiles: 4, processedTiles: 3, unsearchedPixelBoxes: [[55, 55, 100, 100]] } };
  const inventory = inventoryApi.buildTextInventory(data, binding);
  assert.deepEqual(inventory.independentSearch.unsearchedPixelBoxes, [[55, 55, 100, 100]]);
  assert.throws(() => onnxApi.extractionFromOnnx(data, { ...binding, sourceSha256: binding.normalizedSha256 }),
                { code: 'OCR_REVIEW_REQUIRED' });
});

test('partial OCR remains available to its owner after reopening without producing a PNG or invoking translation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mangohana-ocr-inventory-'));
  let runs = 0;
  let latePublish;
  const engine = {
    health: () => ({ ready: true }),
    async inspectImage() { return { width: 1, height: 1 }; },
    async run({ jobId, pageId, outputDirectory, onTextInventory }) {
      runs++;
      if (pageId === 'legacy-page') throw reviewRequired();
      const lines = Array.from({ length: 6 }, (_, index) => ({
        id: `line-${index}`, kind: 'text_bubble', confidence: 0.9,
        source: index === 5 ? '' : 'テスト',
        ...(index === 0 ? { rawSource: ' テスト ' } : {}),
        bbox: { x: index / 6, y: 0, width: 1 / 6, height: 1 },
      }));
      await writeFile(path.join(outputDirectory, 'normalized.png'), png, { flag: 'wx' });
      await writeFile(path.join(outputDirectory, 'onnx-ocr.json'), JSON.stringify({ requestSha256: hash('request'), data: {
        page: jobId, sourceSha256: hash(png), width: 1, height: 1, lines, detections: lines, uncoveredBubbles: [],
      } }), { flag: 'wx' });
      const evidence = { normalizedSha256: hash(png), ocrSourceJobId: jobId, configuration: hash('ocr config') };
      await onTextInventory(evidence);
      await assert.rejects(onTextInventory(evidence), { code: 'OUTPUT_INVALID' });
      latePublish = () => onTextInventory(evidence);
      throw reviewRequired();
    },
    async close() {},
  };
  let store = await createJobStore({ root, engine });
  t.after(async () => {
    await store.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    await rm(root, { force: true, recursive: true });
  });
  const submit = (who, pageId) => store.submit({ owner: who, idempotencyKey: pageId, bytes: png, name: 'synthetic.png', projectId: 'synthetic', pageId });
  const wait = async job => {
    for (let i = 0; i < 100; i++) {
      const value = await store.get(owner, job.id);
      if (value.status === 'failed') return value;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Expected a limited OCR attempt');
  };

  const partial = await wait(await submit(owner, 'partial-page'));
  assert.equal(partial.reviewState, 'NEEDS_REVIEW');
  assert.equal(partial.textInventoryAvailable, true);
  assert.equal(partial.downloadAvailable, false);
  await assert.rejects(latePublish(), { code: 'STALE_RESULT' });
  await assert.rejects(readFile(path.join(root, partial.id, 'candidate.png')), { code: 'ENOENT' });
  const detail = await store.getTextInventory(owner, partial.id);
  assert.equal(detail.status, 'available');
  assert.deepEqual(detail.inventory.lines.map(line => line.status), ['read', 'read', 'read', 'read', 'read', 'needs_review']);
  assert.equal(detail.inventory.lines[0].rawSource, ' テスト ');
  assert.equal(detail.inventory.lines[1].rawSource, null);
  assert.equal(detail.inventory.lines[5].reason, 'OCR_TRANSCRIPTION_BLANK');
  assert.ok(detail.inventory.lines[5].pixelBox.length === 4);
  await assert.rejects(store.getTextInventory(foreign, partial.id), { code: 'JOB_NOT_FOUND' });
  await store.close();
  store = await createJobStore({ root, engine });
  assert.deepEqual(await store.getTextInventory(owner, partial.id), detail);
  assert.equal(runs, 1);
  const legacy = await wait(await submit(owner, 'legacy-page'));
  assert.equal((await store.getTextInventory(owner, legacy.id)).status, 'not_recorded');

  await writeFile(path.join(root, partial.id, 'onnx-ocr.json'), '{}');
  await assert.rejects(store.getTextInventory(owner, partial.id), { code: 'OUTPUT_INVALID' });
});

test('text-inventory HTTP path dispatches the existing session owner and stays isolated', async t => {
  const id = 'a1111111-1111-4111-8111-111111111111';
  const owners = [];
  const store = {
    health: async () => ({ ready: true }), submit() {}, get() {}, getResult() {},
    async getTextInventory(ownerId, jobId) {
      assert.equal(jobId, id);
      owners.push(ownerId);
      if (owners.length === 1) return { status: 'available' };
      throw Object.assign(new Error('Different owner'), { code: 'JOB_NOT_FOUND', status: 404 });
    },
  };
  const server = createEngineServer({ store, allowedOrigin: origin });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const status of [200, 404]) {
    const health = await fetch(base + '/health');
    const cookie = health.headers.get('set-cookie').split(';')[0];
    await health.arrayBuffer();
    const result = await fetch(base + `/jobs/${id}/text-inventory`, { headers: { cookie } });
    assert.equal(result.status, status);
    await result.arrayBuffer();
    assert.equal(owners.at(-1), hash(cookie.split('=')[1]));
  }
  assert.notEqual(owners[0], owners[1]);
});
