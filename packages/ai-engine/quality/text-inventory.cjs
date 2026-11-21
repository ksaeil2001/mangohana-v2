'use strict';

const { onnxFlagsAllowed } = require('./product-onnx.cjs');
const { draftReviewReason } = require('./translation-contract.cjs');
const digest = /^[a-f0-9]{64}$/;
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
function requireEvidence(condition) {
  if (!condition) throw Object.assign(new Error('글줄 목록과 원본 판독 기록이 일치하지 않습니다.'), { code: 'OUTPUT_INVALID', status: 502 });
}

function pixelBox(bbox, width, height) {
  requireEvidence(bbox && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(bbox[k])) &&
    bbox.x >= 0 && bbox.y >= 0 && bbox.width > 0 && bbox.height > 0 &&
    bbox.x + bbox.width <= 1.000001 && bbox.y + bbox.height <= 1.000001);
  return [Math.floor(bbox.x * width), Math.floor(bbox.y * height),
    Math.min(width, Math.ceil((bbox.x + bbox.width) * width)),
    Math.min(height, Math.ceil((bbox.y + bbox.height) * height))];
}

function buildTextInventory(data, binding) {
  const { jobId, pageId, processingGeneration, sourceSha256, normalizedSha256, configuration, ocrSourceJobId, ocrSha256, width, height } = binding;
  requireEvidence(id.test(jobId ?? '') && id.test(pageId ?? '') && id.test(ocrSourceJobId ?? '') &&
    Number.isSafeInteger(processingGeneration) && processingGeneration > 0 &&
    [sourceSha256, normalizedSha256, ocrSha256, configuration].every(value => digest.test(value ?? '')) &&
    data?.page === ocrSourceJobId && data.sourceSha256 === normalizedSha256 && data.width === width && data.height === height &&
    Array.isArray(data.lines) && Array.isArray(data.detections) && Array.isArray(data.uncoveredBubbles));
  const seen = new Set();
  const lines = data.lines.map((row, index) => {
    requireEvidence(id.test(row?.id ?? '') && !seen.has(row.id) && ['text_bubble', 'text_free'].includes(row.kind) &&
      typeof row.source === 'string' && (row.rawSource === undefined || typeof row.rawSource === 'string') &&
      (row.refinedFrom === undefined || id.test(row.refinedFrom)));
    seen.add(row.id);
    const rawSource = row.rawSource ?? null, blank = !row.source.trim();
    return { lineId: row.id, kind: row.kind, pixelBox: pixelBox(row.bbox, width, height), readingOrder: index + 1,
      ...(Number.isSafeInteger(row.panelOrder) && row.panelOrder > 0 ? { panelOrder: row.panelOrder } : {}),
      source: row.source, rawSource, rawSourceReason: rawSource === null ? 'RAW_SOURCE_NOT_RECORDED' : null,
      observationIds: row.refinedFrom ? [row.id, row.refinedFrom] : [row.id],
      status: blank ? 'needs_review' : 'read', reason: blank ? 'OCR_TRANSCRIPTION_BLANK' : null };
  });
  const detections = new Map(data.detections.filter(row => row?.kind === 'bubble').map(row => [row.id, row.bbox]));
  requireEvidence(new Set(data.uncoveredBubbles).size === data.uncoveredBubbles.length);
  const uncoveredBubbles = data.uncoveredBubbles.map(bubbleId => {
    requireEvidence(id.test(bubbleId ?? ''));
    const bbox = detections.get(bubbleId);
    return { observationId: bubbleId, pixelBox: bbox ? pixelBox(bbox, width, height) : null, reason: 'OCR_TEXT_NOT_LINKED' };
  });
  const search = data.independentSearch;
  if (search !== undefined) requireEvidence(search && Number.isSafeInteger(search.plannedTiles) && Number.isSafeInteger(search.processedTiles) &&
    search.processedTiles >= 0 && search.plannedTiles >= search.processedTiles && Array.isArray(search.unsearchedPixelBoxes) &&
    search.unsearchedPixelBoxes.length === search.plannedTiles - search.processedTiles && search.unsearchedPixelBoxes.every(box =>
      Array.isArray(box) && box.length === 4 && box.every(Number.isSafeInteger) && box[0] >= 0 && box[1] >= 0 &&
      box[2] > box[0] && box[3] > box[1] && box[2] <= width && box[3] <= height));
  return { version: 1, jobId, pageId, processingGeneration, sourceSha256, normalizedSha256, configuration, ocrSourceJobId,
    ocrSha256, width, height, lines, uncoveredBubbles, ...(search ? { independentSearch: structuredClone(search) } : {}) };
}

function buildTextNotes(inventory, request, reply, requestSha256, responseSha256, translationInput) {
  const data = reply?.data, generated = data?.generation;
  const expectedNotes = inventory.lines.filter(line => line.kind === 'text_free').map(line => line.lineId);
  const textOnly = request?.purpose === 'text_notes';
  const declaredNotes = request?.noteRegionIds ?? (textOnly ? expectedNotes : null);
  requireEvidence(expectedNotes.length > 0 &&
    (textOnly ? expectedNotes.length === inventory.lines.length : request?.purpose === 'image_and_text_notes' && expectedNotes.length < inventory.lines.length) &&
    Array.isArray(declaredNotes) && declaredNotes.length === expectedNotes.length && declaredNotes.every((id, index) => id === expectedNotes[index]) &&
    reply?.requestSha256 === requestSha256 &&
    digest.test(requestSha256) && digest.test(responseSha256) && generated?.eos === true &&
    [generated.inputTokens, generated.generatedTokens].every(n => Number.isSafeInteger(n) && n > 0) &&
    Array.isArray(request.lines) && Array.isArray(data.lines) &&
    request.lines.length === inventory.lines.length && data.lines.length === inventory.lines.length);
  const lines = inventory.lines.map((line, index) => {
    const input = request.lines[index], output = data.lines[index];
    requireEvidence(line.status === 'read' && input?.id === line.lineId &&
      input.source === line.source && output?.id === line.lineId && output.source === line.source &&
      typeof output.ko === 'string' && output.ko.trim() && onnxFlagsAllowed(output, translationInput));
    return { lineId: line.lineId, source: line.source, translation: output.ko };
  }).filter(line => expectedNotes.includes(line.lineId));
  return { version: 1, jobId: inventory.jobId, sourceSha256: inventory.sourceSha256, requestSha256, responseSha256, lines };
}

function heldTranslationCandidates(inventory, inputs, receipt) {
  requireEvidence(receipt.requestSha256 === inputs.requestSha256 && receipt.responseSha256 === inputs.responseSha256 &&
    digest.test(inputs.requestSha256) && digest.test(inputs.responseSha256));
  const request = JSON.parse(inputs.request), reply = JSON.parse(inputs.response);
  const ids = receipt.lineIds;
  requireEvidence(reply.requestSha256 === inputs.requestSha256 && Array.isArray(request.lines) && Array.isArray(reply.data?.lines) &&
    request.lines.length === reply.data.lines.length && new Set(request.lines.map(row => row.id)).size === request.lines.length &&
    Array.isArray(ids) && ids.length > 0 && ids.every(value => id.test(value)) && new Set(ids).size === ids.length);
  const originals = new Map(inventory.lines.map(line => [line.lineId, line]));
  const held = new Set(ids), lines = [];
  for (const [index, row] of request.lines.entries()) {
    const original = originals.get(row.id), candidate = reply.data.lines[index];
    requireEvidence(original?.status === 'read' && row.source === original.source && candidate?.id === row.id && candidate.source === original.source);
    if (held.has(row.id)) {
      requireEvidence(typeof candidate.ko === 'string' && candidate.ko.trim());
      const reason = draftReviewReason(original.source, candidate.ko);
      requireEvidence(reason);
      lines.push({ lineId: row.id, source: original.source, translation: candidate.ko, reason });
    }
  }
  requireEvidence(lines.length === held.size);
  return { jobId: inventory.jobId, sourceSha256: inventory.sourceSha256, lines };
}

module.exports = { buildTextInventory, buildTextNotes, heldTranslationCandidates };
