import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  classifyFailure, executeAttempt, hostReadyAfter, modelVerdicts, reviewMemory, stageHostDecision,
} from '../../scripts/v2/linux-0b/attempt.mjs';
import { createStages, digest } from '../../scripts/v2/linux-0b/pipeline.mjs';
import { reviewRecord } from '../../scripts/v2/linux-0b/review.mjs';

const models = new Set(['ocr', 'qwen', 'lama']);
const pass = { status: 'PASS' };
const fail = reason => ({ status: 'FAIL', reason });

test('0B accepts only a timely query that began after the previous child settled', () => {
  const sample = { ready: true, windowsQueryStartedBootMs: 1000, windowsSampledBootMs: 1800, sampledAtBootMs: 1810 };
  assert.equal(hostReadyAfter(sample, 990, 1900), true);
  assert.equal(hostReadyAfter(sample, 1100, 1900), false);
  assert.equal(hostReadyAfter(sample, 990, 13_000), true);
  assert.equal(hostReadyAfter(sample, 990, 13_001), false);
  assert.equal(hostReadyAfter(sample, 990, 1800), false);
  assert.equal(hostReadyAfter({ ...sample, ready: false }, 990, 1900), false);
  assert.equal(hostReadyAfter({ ready: true, sampledAtMs: 1810 }, 990, 1900), false);
});

test('0B waits for measured memory recovery without accepting missing or stale host observations', () => {
  const sample = (at, ready = false, runtimeIssue = null) => ({
    windowsQueryStartedBootMs: at - 50, windowsSampledBootMs: at - 10, sampledAtBootMs: at,
    ready, runtimeIssue,
  });
  const decision = (observation, now) => stageHostDecision(observation, 1_000, 1_000, now);

  assert.equal(decision(sample(13_200), 13_200), 'WAIT');
  assert.equal(decision(sample(25_300, true), 25_300), null);
  assert.equal(decision(sample(31_000), 31_000), 'HOST_MEMORY_UNAVAILABLE');
  assert.equal(decision(sample(31_000, true), 31_000), 'HOST_MEMORY_UNAVAILABLE');
  assert.equal(decision(sample(1_070, true), 13_100), 'HOST_SAMPLE_UNAVAILABLE');
  assert.equal(decision(undefined, 13_000), 'HOST_SAMPLE_UNAVAILABLE');
  assert.equal(decision(sample(1_080, false, 'HOST_MEMORY_PRESSURE'), 1_080), 'HOST_MEMORY_PRESSURE');
  assert.equal(decision(sample(1_090, false, 'HOST_COMMIT_PRESSURE'), 1_090), 'HOST_COMMIT_PRESSURE');
});

function scenario(changes = {}, ready = () => null) {
  const dispatches = [];
  const visited = [];
  return {
    dispatches, visited,
    run: () => executeAttempt({
      canContinue: ready,
      recordDispatch: event => dispatches.push([event.stage, event.mode, event.inputSha256]),
      runStage: async (stage, { mode, dispatch }) => {
        visited.push([stage, mode]);
        const result = changes[`${stage}:${mode}`] ?? pass;
        if (models.has(stage) && !result.beforeDispatch) await dispatch('a'.repeat(64));
        return result;
      },
    }),
  };
}

test('0B shares the pipeline calls with model evidence and never starts standalone work on success', async () => {
  const run = scenario();
  const receipt = await run.run();
  assert.deepEqual(run.visited, ['ocr', 'mask', 'qwen', 'lama', 'render'].map(stage => [stage, 'pipeline']));
  assert.deepEqual(receipt.calls, { ocr: 1, qwen: 1, lama: 1 });
  assert.equal(receipt.pipeline.status, 'PASS');
  assert.ok(run.dispatches.every(([, mode, digest]) => mode === 'pipeline' && digest === 'a'.repeat(64)));
});

test('0B records the first pipeline failure and uses untouched LaMa and Qwen slots in that order', async () => {
  const run = scenario({ 'ocr:pipeline': fail('OCR_REVIEW_REQUIRED') });
  const receipt = await run.run();
  assert.deepEqual(run.visited, [['ocr', 'pipeline'], ['lama', 'standalone'], ['qwen', 'standalone']]);
  assert.deepEqual(receipt.pipeline, { status: 'FAIL', stage: 'ocr', reason: 'OCR_REVIEW_REQUIRED' });
  assert.deepEqual(receipt.calls, { ocr: 1, qwen: 1, lama: 1 });
  assert.equal(receipt.stages.at(-1).mode, 'standalone');
});

test('0B only reassigns a Qwen slot when dispatch was proven absent', async () => {
  const rejected = scenario({ 'qwen:pipeline': { ...fail('QWEN_TOKEN_LIMIT'), beforeDispatch: true } });
  const uncertain = scenario({ 'qwen:pipeline': fail('RESULT_UNKNOWN') });
  await rejected.run();
  await uncertain.run();
  assert.deepEqual(rejected.dispatches.map(([stage, mode]) => [stage, mode]),
    [['ocr', 'pipeline'], ['lama', 'standalone'], ['qwen', 'standalone']]);
  assert.deepEqual(uncertain.dispatches.map(([stage, mode]) => [stage, mode]),
    [['ocr', 'pipeline'], ['qwen', 'pipeline'], ['lama', 'standalone']]);
});

test('0B pauses all unstarted work after memory failure or unconfirmed process cleanup', async () => {
  for (const reason of ['CGROUP_OOM', 'MEMORY_ALLOCATION_FAILED', 'CLEANUP_UNCONFIRMED']) {
    const run = scenario({ 'qwen:pipeline': fail(reason) });
    const receipt = await run.run();
    assert.deepEqual(receipt.calls, { ocr: 1, qwen: 1, lama: 0 });
    assert.equal(receipt.halted, reason);
    assert.equal(receipt.pipeline.stage, 'qwen');
  }
});

test('0B requires a fresh resource gate before an independent call', async () => {
  const run = scenario({ 'ocr:pipeline': fail('OCR_REVIEW_REQUIRED') }, mode => (
    mode === 'standalone' ? 'HOST_MEMORY_UNAVAILABLE' : null
  ));
  const receipt = await run.run();
  assert.deepEqual(receipt.calls, { ocr: 1, qwen: 0, lama: 0 });
  assert.equal(receipt.halted, 'HOST_MEMORY_UNAVAILABLE');
});

test('0B stops before reserving Qwen if host pressure appears after tokenizer preparation', async () => {
  let preparedQwen = false;
  const dispatches = [];
  const result = await executeAttempt({
    canContinue: () => preparedQwen ? 'HOST_COMMIT_PRESSURE' : null,
    recordDispatch: ({ stage }) => dispatches.push(stage),
    runStage: async (stage, { dispatch }) => {
      if (stage === 'qwen') preparedQwen = true;
      if (models.has(stage)) await dispatch('a'.repeat(64));
      return pass;
    },
  });
  assert.deepEqual(dispatches, ['ocr']);
  assert.deepEqual(result.calls, { ocr: 1, qwen: 0, lama: 0 });
  assert.deepEqual(result.pipeline, { status: 'FAIL', stage: 'qwen', reason: 'HOST_COMMIT_PRESSURE' });
});

test('0B classifies OOM, allocation, explicit compatibility, malformed output, and a bare SIGKILL separately', () => {
  assert.equal(classifyFailure({ oomEventDelta: 1, exitCode: 137 }), 'CGROUP_OOM');
  assert.equal(classifyFailure({ dockerOomKilled: true }), 'CGROUP_OOM');
  assert.equal(classifyFailure({ trace: [{ failure: 'MEMORY_ALLOCATION_FAILED' }], exitCode: 1 }), 'MEMORY_ALLOCATION_FAILED');
  assert.equal(classifyFailure({ trace: [{ failure: 'MODEL_COMPATIBILITY' }], exitCode: 1 }), 'MODEL_COMPATIBILITY');
  assert.equal(classifyFailure({ invalidOutput: true, exitCode: 0 }), 'INVALID_OUTPUT');
  assert.equal(classifyFailure({ exitCode: 137, signal: 'SIGKILL' }), 'KILL_CAUSE_UNCONFIRMED');
  assert.equal(classifyFailure({ timedOut: true, signal: 'SIGKILL' }), 'STAGE_TIMEOUT');
});

test('0B preserves known compute success on invalid output, partial work on OOM, and skipped OCR components', () => {
  const qwen = [
    { phase: 'load_ok', graph: 'qwen', provider: 'CPUExecutionProvider' },
    { phase: 'compute_start', graph: 'qwen' },
    { phase: 'compute_ok', graph: 'qwen' },
    { phase: 'model_complete', model: 'qwen' },
  ];
  const verdict = modelVerdicts('qwen', qwen, { status: 'FAIL', reason: 'INVALID_OUTPUT' }).qwen;
  assert.deepEqual([verdict.load.status, verdict.compute.status, verdict.output.status], ['PASS', 'PASS', 'FAIL']);
  const partial = modelVerdicts('qwen', qwen.slice(0, 3), { status: 'FAIL', reason: 'CGROUP_OOM' }).qwen;
  assert.deepEqual([partial.load.status, partial.compute.status, partial.output.status], ['PASS', 'FAIL', 'BLOCKED']);
  const ocr = modelVerdicts('ocr', [{ phase: 'load_start', graph: 'rtdetr' }], { status: 'FAIL', reason: 'MODEL_COMPATIBILITY' });
  assert.deepEqual([ocr.rtdetr.load.status, ocr.ppocrv4.load.status, ocr.baberu.compute.status], ['FAIL', 'BLOCKED', 'BLOCKED']);
});

test('0B reviews existing cgroup and phase records without inferring a minimum RAM requirement', () => {
  const review = reviewMemory({
    trace: [{ phase: 'load_start', graph: 'qwen' }],
    resources: [
      { memoryMax: 6442450944, memoryPeak: 128, memoryEvents: { oom: 0, oom_kill: 0 }, memorySwapCurrent: 0 },
      { memoryMax: 6442450944, memoryPeak: 6442450944, memoryEvents: { oom: 1, oom_kill: 1 }, memorySwapCurrent: 0,
        memoryStat: { anon: 5333, file: 333, shmem: 33 } },
    ],
    docker: { OOMKilled: false, ExitCode: 137 },
  });
  assert.equal(review.cause, 'CGROUP_OOM');
  assert.equal(review.lastQwenPhase, 'load_start');
  assert.equal(review.peakBytes, 6442450944);
  assert.equal(review.minimumRequiredMemoryBytes, null);
  assert.equal(review.oomKillDelta, 1);
});

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const jobId = '0b-synthetic-test';
const dimensions = { width: 640, height: 480, channels: 4 };
const box = { x: 0.25, y: 0.4375, width: 0.5, height: 0.125 };
const pixelBox = [160, 210, 480, 270];
const sentence = '駅で待ってるよ。';
const browser = { version: '153.0.8010.12', sandboxRequested: true, closed: true };
const qwenRevision = '41a4dd4d147229f83043afb98a4d4c803b8bfcbb';

function traceFor(entries) {
  return Object.entries(entries).flatMap(([model, graphs]) => [
    ...graphs.flatMap(graph => [
      { phase: 'load_start', graph }, { phase: 'load_ok', graph, provider: 'CPUExecutionProvider' },
      { phase: 'compute_start', graph }, { phase: 'compute_ok', graph },
    ]),
    { phase: 'model_complete', model },
  ]);
}

async function fixtureRuntime(t, { ocrError = false, corruptRestoration = false, cleanupUnconfirmed = false,
  budgetCleanupUnconfirmed = false, oomDuringBudget = false, exhaustedBudget = false, runtimeBudget = 'matching' } = {}) {
  const evidence = await mkdtemp(path.join(tmpdir(), 'mangohana-0b-fixture-'));
  t.after(() => rm(evidence, { force: true, recursive: true }));
  const png = async (x, y, rgba) => {
    const pixels = Buffer.alloc(640 * 480 * 4, 255);
    if (rgba) Buffer.from(rgba).copy(pixels, (y * 640 + x) * 4);
    return sharp(pixels, { raw: dimensions }).png().toBuffer();
  };
  const original = await png(320, 231, [0, 0, 0, 255]);
  const mask = await png(320, 231, [0, 0, 0, 0]);
  const cleaned = corruptRestoration ? await png(10, 10, [0, 0, 0, 255]) : await png();
  const candidate = await png(320, 235, [0, 0, 0, 255]);
  for (const [name, buffer] of Object.entries({ original, normalized: original, 'standalone-mask': mask })) {
    await writeFile(path.join(evidence, name + '.png'), buffer, { flag: 'wx' });
  }
  const fixture = {
    ...dimensions, sentence, inkBox: pixelBox,
    originalSha256: digest(original), normalizedSha256: digest(original), standaloneMaskSha256: digest(mask),
  };
  const rawOcr = { id: 'actual-ocr-1', kind: 'text_bubble', bbox: box, pixelBox, source: sentence, confidence: 0.99 };
  const drafts = [{ id: rawOcr.id, order: 1, pageNumber: 1, sourceText: sentence, sourceLanguage: 'ja', ocrEditStatus: 'ai_proposed' }];
  const budget = exhaustedBudget
    ? { inputTokens: 1536, defaultGenerationLimit: 3104, generationLimit: 0, totalTokenLimit: 1536 }
    : { inputTokens: 525, defaultGenerationLimit: 1082, generationLimit: 1011, totalTokenLimit: 1536 };
  let oom = 0;
  const runChild = async (stage, mode, command) => {
    const request = JSON.parse(command.stdin.toString('utf8'));
    const wrap = (reply, trace = []) => ({
      exitCode: 0, stdout: Buffer.from(JSON.stringify(reply)), trace, durationMs: 10,
    });
    if (stage === 'ocr') {
      return wrap({ provider: 'onnx-cpu', stage: 'ocr', requestSha256: digest(command.stdin), data: {
        page: jobId, width: 640, height: 480, sourceSha256: digest(original), pngSha256: digest(original),
        lines: [rawOcr], detections: [rawOcr], uncoveredBubbles: ocrError ? ['uncovered'] : [],
      } }, traceFor({ rtdetr: ['rtdetr'], ppocrv4: ['ppocrv4'],
        baberu: ['baberu_vision', 'baberu_prefill', 'baberu_step'] }));
    }
    if (stage === 'mask') {
      const [group] = request.prepare.ocr.speechBubbles;
      assert.deepEqual(group.inventoryLineIds, [rawOcr.id]);
      return wrap({ prepared: {
        jobId, lines: drafts.map(draft => ({ ...draft, sourceLineIds: group.inventoryLineIds })),
        mask: { identity: request.prepare.maskIdentity, maskPngBase64: mask.toString('base64'), maskedPixels: 1 },
      }, browser });
    }
    if (stage === 'budget') {
      if (oomDuringBudget) oom = 1;
      return { ...wrap(budget),
        ...(budgetCleanupUnconfirmed ? { halt: 'CLEANUP_UNCONFIRMED' } : {}) };
    }
    if (stage === 'qwen') {
      assert.equal(request.lines[0].id, mode === 'pipeline' ? rawOcr.id : 'standalone-1');
      const observed = runtimeBudget === 'matching' ? budget : { ...budget, generationLimit: budget.defaultGenerationLimit };
      const trace = traceFor({ qwen: ['qwen'] });
      if (runtimeBudget !== 'missing') trace.push({ phase: 'generation_budget', model: 'qwen', budget: observed });
      return wrap({ provider: 'onnx-cpu', stage: 'translate', requestSha256: digest(command.stdin), data: {
        revision: qwenRevision, generation: { inputTokens: budget.inputTokens, generatedTokens: 14, eos: true },
        lines: [{ ...request.lines[0], ko: '역에서 기다릴게.', rawKo: '역에서 기다릴게.', flags: [], normalizations: [] }],
      } }, trace);
    }
    if (stage === 'lama' && cleanupUnconfirmed) return wrap({
      version: 1, ok: false, error: 'worker_cleanup_failed', cleanupConfirmed: false,
    });
    if (stage === 'lama') return wrap({
      version: 1, ok: true, width: 640, height: 480, imagePngBase64: cleaned.toString('base64'),
      verification: {
        normalizedImageSha256: digest(original), maskSha256: digest(mask), cleanedSha256: digest(cleaned),
        workerCalls: 1, tiles: 1, cleanupConfirmed: true, outsideMaskChangedPixels: 0, alphaChangedPixels: 0,
      },
    }, [...traceFor({ lama: ['lama'] }), { phase: 'compute_counts', counts: { lama: 1 } }]);
    assert.equal(stage, 'render');
    assert.equal(request.previousMaskSha256, digest(mask));
    return wrap({ browser, replayed: digest(mask), rendered: {
      jobId, width: 640, height: 480, typesettingIdentity: request.render.typesettingIdentity,
      pngBase64: candidate.toString('base64'), layoutReport: [{
        id: rawOcr.id, bbox: box, qaStatus: 'pending', productionFontLoaded: true, glyphFontLoaded: true,
        textEvidence: { sourceText: request.render.lines[0].aiTranslation, complete: true },
        measuredFit: { fitsBox: true, linesSeparated: true }, actualLayout: { lines: ['역에서 기다릴게.'] },
        raster: { hasInk: true, clippedPixels: 0, otherRegionCollisionPixels: 0, overlappingInkPixels: 0, canvasEdgePixels: 0 },
        glyphEvidence: { missingGlyphOccurrences: 0 },
      }],
    } });
  };
  const readState = () => ({ memoryEvents: { oom, oom_kill: 0 } });
  const runtime = createStages({ repo, input: evidence, evidence, fixture, runChild, readState, approvedJobId: jobId, sharp });
  const sealed = await runtime.sealStandaloneInputs();
  const dispatched = [];
  const result = await executeAttempt({
    runStage: runtime.runStage, canContinue: () => null, recordDispatch: event => dispatched.push(event),
  });
  return { result, evidence, sealed, dispatched, candidate };
}

test('0B applies real product validators and keeps a single uncommitted candidate after mock stage responses', async t => {
  const { result, evidence, candidate } = await fixtureRuntime(t);
  assert.equal(result.pipeline.status, 'PASS');
  const translationInput = JSON.parse(await readFile(path.join(evidence, 'translation-input.json'), 'utf8'));
  assert.deepEqual(translationInput.regions.map(region => region.sourceLineIds), [['actual-ocr-1']]);
  assert.equal(result.stages[0].models.baberu.compute.status, 'PASS');
  assert.equal(digest(await readFile(path.join(evidence, 'candidate.pending.png'))), digest(candidate));
  await assert.rejects(readFile(path.join(evidence, 'candidate.png')), { code: 'ENOENT' });
});

test('0B uses presealed standalone request bytes after OCR review and exposes no final candidate', async t => {
  const { result, evidence, sealed, dispatched } = await fixtureRuntime(t, { ocrError: true });
  assert.equal(result.pipeline.status, 'FAIL');
  assert.equal(result.pipeline.stage, 'ocr');
  assert.deepEqual(dispatched.slice(1).map(item => [item.stage, item.mode, item.inputSha256]),
    [['lama', 'standalone', sealed.lamaSha256], ['qwen', 'standalone', sealed.qwenSha256]]);
  for (const stage of ['lama', 'qwen']) {
    const model = result.stages.find(item => item.stage === stage).models[stage];
    assert.deepEqual([model.load.status, model.compute.status, model.output.status], ['PASS', 'PASS', 'PASS']);
  }
  await assert.rejects(readFile(path.join(evidence, 'candidate.pending.png')), { code: 'ENOENT' });
});

test('0B catches protected pixel changes even when the LaMa response claims that all protected pixels match', async t => {
  const { result } = await fixtureRuntime(t, { corruptRestoration: true });
  assert.equal(result.pipeline.stage, 'lama');
  assert.equal(result.pipeline.reason, 'INVALID_OUTPUT');
  const model = result.stages.find(item => item.stage === 'lama').models.lama;
  assert.deepEqual([model.load.status, model.compute.status, model.output.status], ['PASS', 'PASS', 'FAIL']);
});

test('0B honors the product LaMa cleanup exception and never uses Qwen after it', async t => {
  const { result, dispatched } = await fixtureRuntime(t, { ocrError: true, cleanupUnconfirmed: true });
  assert.deepEqual(dispatched.map(item => item.stage), ['ocr', 'lama']);
  assert.equal(result.halted, 'CLEANUP_UNCONFIRMED');
  assert.equal(result.pipeline.stage, 'ocr');
});

test('0B never dispatches Qwen after tokenizer preparation leaves an OOM or unconfirmed process', async t => {
  for (const [options, reason] of [[{ budgetCleanupUnconfirmed: true }, 'CLEANUP_UNCONFIRMED'], [{ oomDuringBudget: true }, 'CGROUP_OOM']]) {
    const { result, dispatched } = await fixtureRuntime(t, options);
    assert.deepEqual(dispatched.map(item => item.stage), ['ocr']);
    assert.equal(result.halted, reason);
  }
});

test('0B does not start Qwen when the prompt consumes the entire token allowance', async t => {
  const { result, dispatched } = await fixtureRuntime(t, { exhaustedBudget: true });
  assert.deepEqual(dispatched.map(item => item.stage), ['ocr', 'lama']);
  assert.equal(result.pipeline.reason, 'QWEN_TOKEN_LIMIT');
});

test('0B rejects a Qwen response lacking evidence that the preflight limit was applied', async t => {
  for (const runtimeBudget of ['missing', 'unlimited']) {
    const { result, dispatched } = await fixtureRuntime(t, { runtimeBudget });
    assert.equal(result.pipeline.reason, 'QWEN_BUDGET_MISMATCH');
    assert.equal(dispatched.filter(item => item.stage === 'qwen').length, 1);
  }
});

test('0B offline review recovers Qwen phase and host OOM from archived evidence without a retry', async t => {
  const record = await mkdtemp(path.join(tmpdir(), 'mangohana-0b-review-'));
  t.after(() => rm(record, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(record, 'work/qwen-pipeline'), { recursive: true });
  await writeFile(path.join(record, 'result.json'), JSON.stringify({
    pipeline: { status: 'FAIL', reason: 'CGROUP_OOM' }, supervision: 'CGROUP_OOM',
    container: { OOMKilled: true }, dispatches: { qwen: { mode: 'pipeline' } },
  }));
  await writeFile(path.join(record, 'work/qwen-pipeline/model-events.jsonl'),
    '{"phase":"load_start","graph":"qwen"}\n{"phase":"compute');
  const reported = await reviewRecord(record);
  assert.equal(reported.models.qwen.load.status, 'FAIL');
  assert.equal(reported.models.qwen.compute.status, 'BLOCKED');
  assert.equal(reported.memory.cause, 'CGROUP_OOM');
  assert.equal(reported.memory.lastQwenPhase, 'load_start');
  assert.equal(reported.memory.minimumRequiredMemoryBytes, null);
});
