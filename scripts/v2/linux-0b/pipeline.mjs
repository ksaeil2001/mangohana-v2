import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { classifyFailure, modelVerdicts } from './attempt.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
const json = bytes => JSON.parse(bytes.toString('utf8'));
const failure = (reason, additional) => ({ status: 'FAIL', reason, ...additional });
const done = additional => ({ status: 'PASS', ...additional });
const outputProblem = error => error.code && !error.code.startsWith('ERR_') ? error.code : 'INVALID_OUTPUT';
const modelLimit = { ocr: 600_000, qwen: 600_000, lama: 90_000 };
const graphStages = new Set(['ocr', 'qwen', 'lama']);
const qwenTokenLimit = 1536;

export function validQwenBudget(budget) {
  const { inputTokens, defaultGenerationLimit, generationLimit, totalTokenLimit } = budget ?? {};
  return [inputTokens, defaultGenerationLimit, generationLimit].every(value => Number.isSafeInteger(value) && value > 0) &&
    totalTokenLimit === qwenTokenLimit && generationLimit === Math.min(defaultGenerationLimit, qwenTokenLimit - inputTokens);
}

export function rgbaDifference(before, after, { mask, allowed, width = 640 } = {}) {
  assert.equal(before.length, after.length);
  if (mask) assert.equal(before.length, mask.length);
  let changedPixels = 0, outsideChanges = 0, alphaChanges = 0, maskedDarkPixels = 0, changedDarkPixels = 0;
  for (let offset = 0; offset < before.length; offset += 4) {
    const pixel = offset / 4;
    const rgbChanged = before[offset] !== after[offset] || before[offset + 1] !== after[offset + 1] || before[offset + 2] !== after[offset + 2];
    const alphaChanged = before[offset + 3] !== after[offset + 3];
    if (alphaChanged) alphaChanges++;
    if (rgbChanged || alphaChanged) changedPixels++;
    const maskAlpha = mask?.[offset + 3];
    if (mask) assert.ok(maskAlpha === 0 || maskAlpha === 255);
    const inArea = mask ? maskAlpha === 0 : allowed ? allowed(pixel % width, Math.floor(pixel / width)) : true;
    if (rgbChanged && !inArea) outsideChanges++;
    if (mask && inArea && before[offset + 3] === 255 && Math.max(...before.subarray(offset, offset + 3)) < 96) {
      maskedDarkPixels++;
      if (rgbChanged) changedDarkPixels++;
    }
  }
  return { changedPixels, outsideChanges, alphaChanges, maskedDarkPixels, changedDarkPixels };
}

export function createStages({
  repo, input, evidence, fixture, runChild, readState, approvedJobId,
  sharp = createRequire('/opt/trio-tools/package.json')('sharp'),
}) {
  const product = createRequire(path.join(repo, 'package.json'));
  const quality = name => product(path.join(repo, 'packages/ai-engine/quality', name + '.cjs'));
  const { extractionFromOnnx, translationRequest, translatedPage } = quality('product-onnx');
  const { buildTranslationInput, validateTranslationBatch } = quality('translation-contract');
  const { assertKoreanOutputBatch } = quality('korean-output');
  const { selectDialogueRegions } = quality('region-selection');
  const { protectedOcrRegions, verifySourceTextMask } = quality('mask-evidence');
  const trio = path.join(repo, 'packages/ai-engine/vendor/trio');
  const { imageHeader, parseLamaResponse } = product(path.join(trio, 'scripts/sites-local/engine-boundaries.cjs'));
  const { inspectTranslationQuality } = product(path.join(trio, 'src/shared/translation/translationQa.ts'));
  const probe = path.join(repo, 'scripts/v2/linux-0b/probe.py');
  const canvas = path.join(repo, 'scripts/v2/linux-0b/canvas.mjs');
  const python = '/work/ocr-pack/bin/python';
  const pyFlags = ['-I', '-B', '-X', 'utf8'];
  const size = { width: fixture.width, height: fixture.height };
  const jobId = approvedJobId;
  const save = async (name, data) => {
    const bytes = Buffer.isBuffer(data) ? data : encode(data);
    const target = path.join(evidence, name);
    try {
      const stream = await open(target, 'wx', 0o600);
      try { await stream.writeFile(bytes); await stream.sync(); }
      finally { await stream.close(); }
    } catch (error) {
      throw Object.assign(new Error('stage evidence write failed', { cause: error }), { code: 'STAGE_EVIDENCE_MISSING' });
    }
    return digest(bytes);
  };
  let rawOcr, selected, prepared, prepareRequest, lines, translationInput, checkedTranslation, cleaned, standalone;
  const [artLeft, artTop, artRight, artBottom] = [120, 155, 520, 293];
  const insideArtArea = (x, y) => x >= artLeft && x < artRight && y >= artTop && y < artBottom;
  const allowedMaskPixels = new Uint8Array(size.width * size.height);
  for (let pixel = 0; pixel < allowedMaskPixels.length; pixel++) {
    allowedMaskPixels[pixel] = insideArtArea(pixel % size.width, Math.floor(pixel / size.width)) ? 0 : 255;
  }

  async function pixels(png) {
    const header = imageHeader(png, 'image/png');
    assert.equal(header.width, size.width);
    assert.equal(header.height, size.height);
    const image = sharp(png, { failOn: 'error' });
    assert.equal((await image.metadata()).format, 'png');
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height, info.channels], [size.width, size.height, 4]);
    return data;
  }

  function sources() {
    return Promise.all(['original.png', 'normalized.png', 'standalone-mask.png'].map(name => readFile(path.join(evidence, name))));
  }

  function pngFrom64(value) {
    assert.equal(typeof value, 'string');
    assert.ok(value.length > 0 && value.length < 8 * 1024 * 1024);
    const bytes = Buffer.from(value, 'base64');
    assert.equal(bytes.toString('base64'), value);
    return bytes;
  }

  function onnxReply(result, stage, raw) {
    const reply = json(result.stdout);
    assert.equal(reply.provider, 'onnx-cpu');
    assert.equal(reply.stage, stage);
    assert.equal(reply.requestSha256, digest(raw));
    assert.ok(reply.data && typeof reply.data === 'object');
    return reply;
  }

  function checkedMask(value, source) {
    const mask = pngFrom64(value.mask.maskPngBase64);
    return pixels(mask).then(bitmap => {
      const evidenceMask = verifySourceTextMask({
        bytes: mask, bitmap, identity: value.mask.identity, expectedIdentity: prepareRequest.maskIdentity,
        expectedPixels: value.mask.maskedPixels,
        allowedRegions: selected.extraction.speechBubbles.map(region => ({
          id: region.id, bbox: region.bbox,
          paddingPx: Math.ceil(Math.min(region.bbox.width * size.width, region.bbox.height * size.height) * 0.5) + 5,
        })),
        protectedRegions: protectedOcrRegions(rawOcr.extraction, selected.selection), protectionPixels: allowedMaskPixels,
      });
      assert.equal(evidenceMask.identity.sourceImageSha256, digest(source));
      return { mask, evidenceMask };
    });
  }

  async function standaloneQwen(source, original) {
    const [x0, y0, x1, y1] = fixture.inkBox;
    const bbox = { x: x0 / size.width, y: y0 / size.height, width: (x1 - x0) / size.width, height: (y1 - y0) / size.height };
    const row = { id: 'standalone-1', kind: 'text_bubble', confidence: 1, source: fixture.sentence, bbox };
    const identity = { jobId, pageNumber: 1, sourceSha256: digest(source), ...size };
    const { extraction, detection } = extractionFromOnnx({
      page: jobId, ...identity, lines: [row], detections: [row], uncoveredBubbles: [],
    }, identity);
    const chosen = selectDialogueRegions(extraction, detection);
    const drafts = chosen.extraction.speechBubbles.map(group => ({
      id: group.id, order: group.readingOrder, pageNumber: 1, sourceText: group.text,
      sourceLanguage: 'ja', ocrEditStatus: 'ai_proposed', sourceLineIds: [...group.inventoryLineIds],
    }));
    const built = buildTranslationInput({
      lines: drafts, extraction: chosen.extraction, selection: chosen.selection,
      scope: { pageNumber: 1, sourceSha256: digest(original) },
    });
    return { drafts, built, request: translationRequest(built, drafts) };
  }

  const lamaRequest = (source, mask) => Buffer.from(JSON.stringify({
    image: source.toString('base64'), mask: mask.toString('base64'),
  }) + '\n');

  async function sealStandaloneInputs() {
    assert.ok(!standalone);
    const [original, source, mask] = await sources();
    const qwen = await standaloneQwen(source, original);
    const qwenSha256 = await save('standalone-qwen.json', qwen.request);
    const lamaSha256 = digest(lamaRequest(source, mask));
    standalone = { qwen, qwenSha256, lamaSha256 };
    return { qwenSha256, lamaSha256 };
  }

  async function childModel(stage, mode, dispatch, raw, args, keepStdin = false) {
    const before = await readState();
    if (before.memoryEvents.oom || before.memoryEvents.oom_kill) return { reason: 'CGROUP_OOM', trace: [] };
    if (before.memorySwapCurrent || before.pidDenials) return { reason: 'RESOURCE_EVIDENCE_MISSING', trace: [] };
    await dispatch(digest(raw));
    const observed = await runChild(stage, mode, {
      program: python, args: [...pyFlags, ...args], stdin: raw, keepStdin, milliseconds: modelLimit[stage],
    });
    let after;
    try { after = await readState(); }
    catch { after = null; }
    const beforeOom = before.memoryEvents;
    const oomEventDelta = after ? Math.max(after.memoryEvents.oom - beforeOom.oom, after.memoryEvents.oom_kill - beforeOom.oom_kill) : 0;
    const trace = observed.trace ?? [];
    const result = { ...observed, trace, oomEventDelta };
    if (!after) result.halt = 'RESOURCE_EVIDENCE_MISSING';
    if (oomEventDelta || observed.exitCode !== 0 || observed.timedOut || observed.cancelled || observed.overflow ||
        trace.some(item => item.failure === 'MEMORY_ALLOCATION_FAILED')) {
      result.reason = classifyFailure({ ...result, invalidOutput: observed.overflow });
    }
    return result;
  }

  function conclude(stage, result, validated, reason) {
    const issue = result.reason ?? reason;
    let verdict = issue ? failure(issue, { invalidOutput: !result.reason && reason !== 'MODEL_EVIDENCE_MISSING' }) : done();
    const models = modelVerdicts(stage, result.trace, verdict);
    if (!issue && Object.values(models).some(model => model.load.status !== 'PASS' || model.compute.status !== 'PASS' || model.output.status !== 'PASS')) {
      verdict = failure('MODEL_EVIDENCE_MISSING');
    }
    return { ...verdict, models, ...(result.halt ? { halt: result.halt } : {}), ...validated };
  }

  async function ocrStage(source, mode, dispatch) {
    const request = { jobId, pageNumber: 1, sourceSha256: digest(source), normalized: path.join(evidence, 'normalized.png'), ...size };
    const raw = encode(request);
    await save('ocr-request.json', raw);
    const result = await childModel('ocr', mode, dispatch, raw, [probe, 'ocr']);
    if (result.reason) return conclude('ocr', result);
    try {
      const reply = onnxReply(result, 'ocr', raw);
      await save('ocr-response.json', reply);
      if (reply.data.failure) return conclude('ocr', result, undefined, classifyFailure(result));
      assert.equal(reply.data.pngSha256, request.sourceSha256);
      const { lines: observed } = reply.data;
      assert.ok(Array.isArray(observed) && observed.length > 0);
      for (const row of observed) {
        assert.ok(Object.values(row.bbox).every(value => Number.isFinite(value) && value >= 0 && value <= 1));
        assert.ok(row.bbox.width > 0 && row.bbox.height > 0 && row.bbox.x + row.bbox.width <= 1 && row.bbox.y + row.bbox.height <= 1);
        assert.ok(Array.isArray(row.pixelBox) && row.pixelBox.length === 4 && row.pixelBox.every(Number.isInteger));
        assert.deepEqual(row.pixelBox, [
          Math.floor(row.bbox.x * size.width), Math.floor(row.bbox.y * size.height),
          Math.ceil((row.bbox.x + row.bbox.width) * size.width), Math.ceil((row.bbox.y + row.bbox.height) * size.height),
        ]);
      }
      rawOcr = extractionFromOnnx(reply.data, request);
      selected = selectDialogueRegions(rawOcr.extraction, rawOcr.detection);
      await save('region-selection.json', selected);
      assert.equal(selected.selection.needsReviewRegions, 0);
      assert.equal(selected.extraction.speechBubbles.length, 1);
      assert.equal(selected.extraction.speechBubbles[0].text.normalize('NFC').trim(), fixture.sentence);
      return conclude('ocr', result, { requestSha256: digest(raw) });
    } catch (error) {
      if (error.code === 'STAGE_EVIDENCE_MISSING') throw error;
      return conclude('ocr', result, undefined, outputProblem(error));
    }
  }

  async function browserStage(stage, spec) {
    const child = await runChild(stage, 'pipeline', {
      program: process.execPath, args: [canvas], stdin: encode(spec), milliseconds: 30_000,
    });
    if (child.halt || child.exitCode !== 0 || child.overflow) {
      throw Object.assign(new Error('Canvas process failed'), { code: child.halt ?? classifyFailure(child) });
    }
    const output = json(child.stdout);
    assert.deepEqual(output.browser, { version: '153.0.8010.12', sandboxRequested: true, closed: true });
    return output;
  }

  async function maskStage(source, original) {
    const extraction = selected.extraction;
    prepareRequest = {
      jobId, ocr: extraction, ...size, sourceLanguage: 'ja', sourcePngBase64: source.toString('base64'),
      maskIdentity: { version: 1, jobId, pageNumber: 1, sourceImageSha256: digest(source),
        ocrSha256: digest(encode(extraction)), coordinateSpace: 'normalized-page-pixels', ...size },
    };
    const reply = await browserStage('mask', { prepare: prepareRequest });
    prepared = await checkedMask(reply.prepared, source);
    lines = reply.prepared.lines;
    translationInput = buildTranslationInput({
      lines, extraction, selection: selected.selection, scope: { pageNumber: 1, sourceSha256: digest(original) },
    });
    await save('pipeline-mask.png', prepared.mask);
    await save('pipeline-mask.json', { ...prepared.evidenceMask, browser: reply.browser });
    await save('translation-input.json', translationInput);
    return done();
  }

  async function qwenStage(source, original, mode, dispatch) {
    const item = mode === 'pipeline'
      ? { drafts: lines, built: translationInput, request: translationRequest(translationInput, lines) }
      : standalone.qwen;
    const raw = encode(item.request);
    if (mode === 'standalone') assert.equal(digest(raw), standalone.qwenSha256);
    const tokenRun = await runChild('budget', mode, { program: python, args: [...pyFlags, probe, 'budget'],
      stdin: raw, milliseconds: 30_000 });
    if (tokenRun.halt) return failure(tokenRun.halt);
    if (tokenRun.exitCode !== 0 || tokenRun.timedOut || tokenRun.cancelled || tokenRun.overflow) {
      return failure(classifyFailure(tokenRun), { halt: 'RESOURCE_EVIDENCE_MISSING' });
    }
    const budget = json(tokenRun.stdout);
    await save('qwen-' + mode + '-budget.json', budget);
    if (!validQwenBudget(budget)) return failure('QWEN_TOKEN_LIMIT');
    await save('qwen-' + mode + '-request.json', raw);
    const result = await childModel('qwen', mode, dispatch, raw, [probe, 'translate']);
    if (result.reason) return conclude('qwen', result);
    try {
      const reply = onnxReply(result, 'translate', raw);
      const responseSha256 = await save('qwen-' + mode + '-response.json', result.stdout);
      if (reply.data.failure) return conclude('qwen', result, undefined, classifyFailure(result));
      const appliedBudgets = result.trace.filter(event => event.phase === 'generation_budget' && event.model === 'qwen')
        .map(event => event.budget);
      if (!isDeepStrictEqual(appliedBudgets, [budget])) return conclude('qwen', result, undefined, 'QWEN_BUDGET_MISMATCH');
      assert.equal(reply.data.generation.inputTokens, budget.inputTokens);
      assert.ok(reply.data.generation.generatedTokens <= budget.generationLimit);
      const translated = translatedPage(reply, item.drafts, inspectTranslationQuality, {
        requestId: randomUUID(), durationMs: result.durationMs, sourceImageSha256: digest(source), responseSha256,
      });
      const checked = assertKoreanOutputBatch(validateTranslationBatch({ input: item.built, results: translated.pending }));
      if (mode === 'pipeline') checkedTranslation = checked;
      await save('qwen-' + mode + '-validated.json', { results: checked, request: translated.request });
      return conclude('qwen', result, { requestSha256: digest(raw) });
    } catch (error) {
      if (error.code === 'STAGE_EVIDENCE_MISSING') throw error;
      return conclude('qwen', result, undefined, outputProblem(error));
    }
  }

  async function lamaStage(source, standaloneMask, mode, dispatch) {
    const mask = mode === 'pipeline' ? prepared.mask : standaloneMask;
    const maskPixels = await pixels(mask);
    for (let offset = 3; offset < maskPixels.length; offset += 4) {
      assert.ok(maskPixels[offset] === 0 || maskPixels[offset] === 255);
      if (maskPixels[offset] === 0) assert.equal(allowedMaskPixels[(offset - 3) / 4], 0);
    }
    const raw = lamaRequest(source, mask);
    if (mode === 'standalone') assert.equal(digest(raw), standalone.lamaSha256);
    // The bridge treats EOF as cancellation until a valid response is complete.
    const result = await childModel('lama', mode, dispatch, raw, [
      path.join(trio, 'scripts/sites-local/lama-stdio.py'), '--python', python,
      '--worker', path.join(trio, 'resources/managed-inpainting/lama_onnx.py'),
      '--model', path.join(input, 'models/lama_fp32.onnx'), '--tile-wrapper', probe,
      '--log-dir', path.join(evidence, 'lama-' + mode),
    ], true);
    if (result.reason) return conclude('lama', result);
    try {
      const { imagePngBase64, ...receipt } = json(result.stdout);
      await save('lama-' + mode + '-response.json', receipt);
      const reply = parseLamaResponse(result.stdout);
      if (reply.error === 'worker_timeout') return conclude('lama', { ...result, reason: 'STAGE_TIMEOUT' });
      if (reply.ok === false && !['invalid_worker_result', 'invalid_request'].includes(reply.error)) {
        return conclude('lama', { ...result, reason: classifyFailure(result) });
      }
      assert.equal(reply.ok, true);
      assert.equal(reply.width, size.width);
      assert.equal(reply.height, size.height);
      const audit = reply.verification;
      assert.equal(audit.normalizedImageSha256, digest(source));
      assert.equal(audit.maskSha256, digest(mask));
      assert.equal(audit.workerCalls, 1);
      assert.equal(audit.cleanupConfirmed, true);
      const counts = result.trace.findLast(event => event.phase === 'compute_counts')?.counts;
      assert.ok(Number.isSafeInteger(audit.tiles) && audit.tiles > 0 && audit.tiles === counts?.lama);
      assert.equal(audit.outsideMaskChangedPixels, 0);
      assert.equal(audit.alphaChangedPixels, 0);
      const bytes = pngFrom64(imagePngBase64);
      assert.equal(audit.cleanedSha256, digest(bytes));
      const checked = rgbaDifference(await pixels(source), await pixels(bytes), { mask: maskPixels, width: size.width });
      assert.equal(checked.outsideChanges, 0);
      assert.equal(checked.alphaChanges, 0);
      assert.ok(checked.maskedDarkPixels > 0 && checked.changedDarkPixels > 0);
      await save('lama-' + mode + '-pixels.json', checked);
      await save('lama-' + mode + '-cleaned.png', bytes);
      if (mode === 'pipeline') cleaned = bytes;
      return conclude('lama', result, { requestSha256: digest(raw) });
    } catch (error) {
      if (error.code === 'STAGE_EVIDENCE_MISSING') throw error;
      if (error.code === 'CLEANUP_FAILED') return conclude('lama', { ...result, reason: 'CLEANUP_UNCONFIRMED' });
      return conclude('lama', result, undefined, outputProblem(error));
    }
  }

  async function renderStage(original) {
    const identity = { ...prepareRequest.maskIdentity, contract: 'stage12-input-v1',
      sourceSha256: digest(original), cleanedImageSha256: digest(cleaned), maskSha256: digest(prepared.mask),
      translationInputFingerprint: translationInput.fingerprint, mode: 'unreviewed_candidate',
      maskReview: 'candidate_validated_not_human_approved' };
    const projected = lines.map((line, index) => ({
      ...line, aiTranslation: checkedTranslation[index].translatedText, aiProposedSource: checkedTranslation[index].proposedSource,
    }));
    const { rendered, browser, replayed } = await browserStage('render', {
      prepare: prepareRequest, previousMaskSha256: digest(prepared.mask), previousLines: lines,
      render: { jobId, lines: projected, cleanedPngBase64: cleaned.toString('base64'), typesettingIdentity: identity,
        returnStructuredFailure: true },
    });
    if (rendered.failure) {
      await save('typesetting-review.json', rendered.failure);
      return failure(rendered.failure.code);
    }
    assert.equal(rendered.jobId, jobId);
    assert.equal(rendered.width, size.width);
    assert.equal(rendered.height, size.height);
    assert.deepEqual(rendered.typesettingIdentity, identity);
    assert.equal(replayed, identity.maskSha256);
    assert.equal(rendered.layoutReport.length, 1);
    const [layout] = rendered.layoutReport;
    assert.equal(layout.id, projected[0].id);
    assert.equal(layout.qaStatus, 'pending');
    assert.equal(layout.productionFontLoaded, true);
    assert.equal(layout.glyphFontLoaded, true);
    assert.equal(layout.textEvidence.sourceText, projected[0].aiTranslation);
    assert.equal(layout.textEvidence.complete, true);
    assert.equal(layout.measuredFit.fitsBox, true);
    assert.equal(layout.measuredFit.linesSeparated, true);
    assert.ok(layout.actualLayout.lines.length > 0 && layout.raster.hasInk);
    assert.equal(layout.glyphEvidence.missingGlyphOccurrences, 0);
    for (const key of ['clippedPixels', 'otherRegionCollisionPixels', 'overlappingInkPixels', 'canvasEdgePixels']) assert.equal(layout.raster[key], 0);
    const bytes = pngFrom64(rendered.pngBase64);
    const box = layout.bbox;
    assert.ok(box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0);
    const placement = (x, y) => insideArtArea(x, y) && x >= Math.floor(box.x * size.width) &&
      x < Math.ceil((box.x + box.width) * size.width) && y >= Math.floor(box.y * size.height) &&
      y < Math.ceil((box.y + box.height) * size.height);
    const measured = rgbaDifference(await pixels(cleaned), await pixels(bytes), { allowed: placement, width: size.width });
    assert.ok(measured.changedPixels > 0);
    assert.equal(measured.outsideChanges, 0);
    assert.equal(measured.alphaChanges, 0);
    const candidateSha256 = await save('candidate.pending.png', bytes);
    assert.equal(digest(await readFile(path.join(evidence, 'candidate.pending.png'))), candidateSha256);
    await save('typesetting.json', { identity, layout, measured, browser, replayed, candidateSha256 });
    return done({ candidateSha256 });
  }

  async function runStage(stage, { mode, dispatch }) {
    const [original, source, standaloneMask] = await sources();
    assert.equal(digest(original), fixture.originalSha256);
    assert.equal(digest(source), fixture.normalizedSha256);
    assert.equal(digest(standaloneMask), fixture.standaloneMaskSha256);
    try {
      if (stage === 'ocr') return await ocrStage(source, mode, dispatch);
      if (stage === 'mask') return await maskStage(source, original);
      if (stage === 'qwen') return await qwenStage(source, original, mode, dispatch);
      if (stage === 'lama') return await lamaStage(source, standaloneMask, mode, dispatch);
      if (stage === 'render') return await renderStage(original);
      throw new Error('unsupported verification stage');
    } catch (error) {
      if (graphStages.has(stage)) throw error;
      return failure(outputProblem(error));
    }
  }

  return { runStage, sealStandaloneInputs };
}
