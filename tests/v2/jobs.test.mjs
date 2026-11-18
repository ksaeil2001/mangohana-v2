// Synthetic images and an injected fixture engine only; no AI or model runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createJobStore } from '../../apps/engine/store.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLeUAAAAASUVORK5CYII=', 'base64');
const hash = value => createHash('sha256').update(value).digest('hex');
const alice = hash('synthetic-alice'), bob = hash('synthetic-bob');
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(read, predicate = value => ['completed', 'failed'].includes(value.status)) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await sleep(10); }
  assert.fail('The synthetic job did not reach the expected state.');
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mangohana-v2-jobs-'));
  const runs = [], started = deferred(); let active = 0, maximum = 0, closed = 0;
  const engine = {
    health: () => ({ ready: true }),
    inspectImage(bytes, mime) {
      assert.equal(mime, 'image/png');
      if (!bytes.subarray(0, 8).equals(png.subarray(0, 8))) throw Error('Synthetic invalid image');
      return { width: 1, height: 1 };
    },
    async run(input) {
      runs.push(input.jobId); active++; maximum = Math.max(maximum, active); started.resolve(input);
      try {
        await input.onProgress({ stage: 'ocr', message: 'Synthetic OCR boundary', progress: 15 });
        await options.wait?.(input, runs.length);
        const source = await readFile(input.inputPath);
        for (const file of ['normalized.png', 'cleaned.png', 'removal-mask.png']) {
          if (options.missing !== file) await writeFile(path.join(input.outputDirectory, file), source, { flag: 'wx' });
        }
        const report = { version: 1, jobId: input.jobId, evidenceKind: 'LOCAL_ENGINE_CANDIDATE',
          originalPreserved: true, sourceLanguage: input.sourceLanguage, qaStatus: 'pending', userApproved: false,
          image: { width: 1, height: 1, originalMime: 'image/png' },
          hashes: { original: hash(source), normalized: hash(source), cleaned: hash(source), candidate: hash(source), mask: hash(source) },
          warnings: ['SYNTHETIC_FIXTURE_NOT_AI'],
          ocr: { speechBubbles: [{ id: 'bubble-fixture' }] },
          lines: [{ id: 'bubble-fixture', sourceText: '合成入力', aiTranslation: '합성 번역', order: 1 }],
          translations: [{ id: 'bubble-fixture', engine: 'local_ai', usedExactTm: false, modelHttpRequests: 1, qaReport: { issues: [] } }],
          typesetting: { layoutReport: [{ id: 'bubble-fixture', bbox: { x: 0, y: 0, width: 1, height: 1 },
            fontSizePx: 14, fontFamily: 'Synthetic Fixture', productionFontLoaded: true, glyphFontLoaded: true }] } };
        options.mutate?.(report);
        await writeFile(path.join(input.outputDirectory, 'engine-report.json'), JSON.stringify(report), { flag: 'wx' });
        return { pngBytes: source, report };
      } finally { active--; }
    },
    async close() { closed++; },
  };
  const store = await createJobStore({ root, engine });
  t.after(async () => {
    await store.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const submit = overrides => store.submit({ owner: alice, idempotencyKey: 'test:request-1', bytes: png,
    name: 'synthetic.png', projectId: 'project-fixture', pageId: 'page-fixture', sourceLanguage: 'ja', ...overrides });
  return { root, store, engine, submit, runs, started, maximum: () => maximum, closed: () => closed };
}

test('concurrent duplicate submissions retain immutable source and one owned job', async t => {
  const gate = deferred(); const f = await fixture(t, { wait: () => gate.promise });
  t.after(() => gate.resolve());
  const mutable = Buffer.from(png);
  const [first, duplicate] = await Promise.all([f.submit({ bytes: mutable }), f.submit()]);
  assert.equal(first.id, duplicate.id);
  mutable.fill(0);
  assert.deepEqual(await readFile(path.join(f.root, first.id, 'source.png')), png);
  await assert.rejects(f.store.get(bob, first.id), { status: 404, code: 'JOB_NOT_FOUND' });
  await assert.rejects(f.submit({ bytes: Buffer.concat([png, Buffer.from('changed')]) }), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.submit({ pageId: 'other-page' }), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  const progress = await until(() => f.store.get(alice, first.id), value => value.progress === 15);
  assert.equal(progress.stage, 'ocr');
  assert.equal('owner' in progress, false); assert.equal('inputPath' in progress, false);
  gate.resolve();
  assert.equal((await until(() => f.store.get(alice, first.id))).status, 'completed');
  assert.deepEqual(f.runs, [first.id]);
});

test('distinct jobs run in FIFO order with a maximum of one engine invocation', async t => {
  const gate = deferred(); const f = await fixture(t, { wait: (_input, index) => index === 1 ? gate.promise : undefined });
  t.after(() => gate.resolve());
  const first = await f.submit(); await f.started.promise;
  const second = await f.submit({ idempotencyKey: 'second' });
  const otherOwner = await f.submit({ owner: bob, idempotencyKey: 'test:request-1' });
  assert.equal((await f.store.get(alice, second.id)).status, 'queued');
  gate.resolve();
  for (const [owner, job] of [[alice, first], [alice, second], [bob, otherOwner]]) {
    assert.equal((await until(() => f.store.get(owner, job.id))).status, 'completed');
  }
  assert.deepEqual(f.runs, [first.id, second.id, otherOwner.id]); assert.equal(f.maximum(), 1);
});

for (const defect of ['evidenceKind', 'jobId', 'original', 'normalized', 'cleaned', 'candidate', 'mask', 'missing normalized']) {
  test(`does not publish completion with invalid ${defect} evidence`, async t => {
    const f = await fixture(t, { missing: defect === 'missing normalized' ? 'normalized.png' : undefined,
      mutate(report) { if (defect in report.hashes) report.hashes[defect] = '0'.repeat(64);
        else if (defect === 'evidenceKind') report.evidenceKind = 'UNVERIFIED'; else if (defect === 'jobId') report.jobId = 'foreign-job'; } });
    const job = await f.submit(); const result = await until(() => f.store.get(alice, job.id));
    assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'OUTPUT_INVALID');
    assert.equal(result.downloadAvailable, false);
    assert.deepEqual(await readFile(path.join(f.root, job.id, 'source.png')), png);
  });
}

for (const defect of ['translation ID', 'OCR ID', 'layout ID', 'font verification']) {
  test(`does not publish completion when the actual result converter rejects ${defect}`, async t => {
    const f = await fixture(t, { mutate(report) {
      if (defect === 'translation ID') report.translations[0].id = 'foreign-bubble';
      if (defect === 'OCR ID') report.ocr.speechBubbles[0].id = 'foreign-bubble';
      if (defect === 'layout ID') report.typesetting.layoutReport[0].id = 'foreign-bubble';
      if (defect === 'font verification') report.typesetting.layoutReport[0].productionFontLoaded = false;
    } });
    const job = await f.submit(); const result = await until(() => f.store.get(alice, job.id));
    assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'OUTPUT_INVALID');
    const state = JSON.parse(await readFile(path.join(f.root, job.id, 'state.json'), 'utf8'));
    assert.equal(state.status, 'failed'); assert.equal(result.downloadAvailable, false);
  });
}

test('restoring a legacy completed report rejects valid file hashes with mismatched dialogue IDs', async t => {
  const f = await fixture(t); const job = await f.submit();
  assert.equal((await until(() => f.store.get(alice, job.id))).status, 'completed');
  await f.store.close();
  const jobDirectory = path.join(f.root, job.id), reportFile = path.join(jobDirectory, 'report.json');
  const report = JSON.parse(await readFile(reportFile, 'utf8')); report.translations[0].id = 'foreign-bubble';
  const reportBytes = Buffer.from(JSON.stringify(report)); await writeFile(reportFile, reportBytes);
  const stateFile = path.join(jobDirectory, 'state.json'), state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.reportSha256 = hash(reportBytes); await writeFile(stateFile, JSON.stringify(state));
  const restored = await createJobStore({ root: f.root, engine: f.engine }); t.after(() => restored.close());
  const result = await restored.get(alice, job.id);
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'INTEGRITY_FAILED');
  assert.equal(f.runs.length, 1);
});

test('completed jobs are revalidated after files change and on restart', async t => {
  const f = await fixture(t); const job = await f.submit();
  assert.equal((await until(() => f.store.get(alice, job.id))).status, 'completed');
  await f.store.close();
  const restored = await createJobStore({ root: f.root, engine: f.engine }); t.after(() => restored.close());
  const duplicate = await restored.submit({ owner: alice, idempotencyKey: 'test:request-1', bytes: png,
    name: 'synthetic.png', projectId: 'project-fixture', pageId: 'page-fixture', sourceLanguage: 'ja' });
  assert.equal(duplicate.id, job.id); assert.equal(duplicate.status, 'completed'); assert.equal(f.runs.length, 1);
  await writeFile(path.join(f.root, job.id, 'cleaned.png'), Buffer.from('corrupted synthetic output'));
  const invalid = await restored.get(alice, job.id);
  assert.equal(invalid.status, 'failed'); assert.equal(invalid.errorCode, 'INTEGRITY_FAILED');
});

test('process restart marks an interrupted running job failed without another inference', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mangohana-v2-jobs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleURL = new URL('../../apps/engine/store.mjs', import.meta.url).href;
  const code = `import {createJobStore} from ${JSON.stringify(moduleURL)};
    const engine={health:()=>({ready:true}),inspectImage:()=>({width:1,height:1}),close:async()=>{},
      run:async ({jobId})=>{process.stdout.write(jobId+'\\n');process.exit(0)}};
    const store=await createJobStore({root:process.argv[1],engine});
    await store.submit({owner:process.argv[2],idempotencyKey:'restart',bytes:Buffer.from(process.argv[3],'base64'),name:'source.png',sourceLanguage:'ja'});`;
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, root, alice, png.toString('base64')], { windowsHide: true });
  const id = child.stdout.trim(); assert.match(id, /^[0-9a-f-]{36}$/);
  let runs = 0;
  const store = await createJobStore({ root, engine: { health: () => ({ ready: true }), inspectImage: () => ({ width: 1, height: 1 }),
    run: async () => { runs++; throw Error('No automatic resubmit'); }, close: async () => {} } });
  t.after(() => store.close());
  const recovered = await store.get(alice, id);
  assert.equal(recovered.status, 'failed'); assert.equal(recovered.errorCode, 'INTERRUPTED'); assert.equal(runs, 0);
});

test('rejects oversized, unsupported and path-like input before accepting a job', async t => {
  const f = await fixture(t);
  for (const value of [{ bytes: Buffer.alloc(8 * 1024 * 1024 + 1) }, { bytes: Buffer.from('not an image') },
    { name: '../source.png' }, { sourceLanguage: 'en' }, { idempotencyKey: 'invalid/key' }]) await assert.rejects(f.submit(value));
  assert.equal(f.runs.length, 0); assert.deepEqual(await readdir(f.root), []);
});
