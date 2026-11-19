'use strict';

const { createHash } = require('node:crypto');
const { key } = require('./recovery-checkpoint.cjs');
const { assessStage } = require('./stage15-quality-decision.cjs');
const { stageParentsSha256, stageCheckEvidenceId } = require('./stage15-stage-graph.cjs');
const { parsePageTranslationResponse } = require('./page-translation.cjs');
const { assessSemanticRisk } = require('./translation-contract.cjs');
const { bounds, inside, overlaps, validBox } = require('./background-layout.cjs');
const { verifyRenderedBackgrounds } = require('./imported-layout-background.cjs');
const { verifyImportedLayout } = require('./imported-image-contract.cjs');

const version = 'stage15-inspection-v1';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sameArtifact = (a, b) => a && b && id(a.artifactId) && hex(a.sha256) && a.artifactId === b.artifactId && a.sha256 === b.sha256;
const hard = (code, regionId, scope) => ({ severity: 'HARD', code, regionId, scope });
const soft = (code, regionId, scope) => ({ severity: 'SOFT', code, regionId, scope });
const unmeasured = (code, regionId) => [{ severity: 'UNVERIFIED', code, regionId, scope: 'STAGE_INSPECTION' }];

function requireValue(ok, code = 'STAGE15_INSPECTION_INVALID') {
  if (!ok) throw Object.assign(new Error(code), { code });
}

function document(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function scopedIds(rows, regionId) {
  return Array.isArray(rows) && rows.length > 0 && Array.from(rows).every(row => id(row?.id)) &&
    new Set(rows.map(row => row.id)).size === rows.length &&
    (regionId === null || (rows.length === 1 && rows[0].id === regionId));
}

function ocrFindings({ bytes, inputs, binding, regionId }) {
  const expected = inputs.regions;
  requireValue(scopedIds(expected, regionId));
  const sourceIds = new Set();
  const orders = new Set();
  for (const row of expected) {
    requireValue(Number.isSafeInteger(row.readingOrder) && row.readingOrder > 0 && !orders.has(row.readingOrder) &&
      Array.isArray(row.sourceLineIds) && row.sourceLineIds.length > 0);
    orders.add(row.readingOrder);
    for (const sourceId of row.sourceLineIds) {
      requireValue(id(sourceId) && !sourceIds.has(sourceId));
      sourceIds.add(sourceId);
    }
  }
  const output = document(bytes);
  const scope = 'OCR_LINEAGE';
  if (output?.pageNumber !== binding.pageNumber || !Array.isArray(output.speechBubbles) || !Array.isArray(output.warnings)) {
    return [hard('OCR_OUTPUT_INVALID', regionId, scope)];
  }
  const expectedById = new Map(expected.map(row => [row.id, row]));
  const seen = new Set();
  const findings = [];
  if (output.warnings.some(warning => typeof warning !== 'string' || /^OCR_REGION_(CROP|RECOGNITION)_(FAILED|EMPTY):/.test(warning))) {
    findings.push(hard('OCR_INCOMPLETE', regionId, scope));
  }
  for (const row of output.speechBubbles) {
    const id = row?.id;
    const expectedRow = expectedById.get(id);
    if (!expectedRow) {
      findings.push(hard('OCR_REGION_UNEXPECTED', regionId, scope));
      continue;
    }
    if (seen.has(id)) findings.push(hard('OCR_REGION_DUPLICATE', id, scope));
    seen.add(id);
    const lineage = row.productionOcrProvenance?.sourceDetectionIds;
    if (!Array.isArray(lineage) || lineage.length !== expectedRow.sourceLineIds.length ||
        lineage.some((sourceId, i) => sourceId !== expectedRow.sourceLineIds[i])) findings.push(hard('OCR_LINEAGE_MISMATCH', id, scope));
    if (row.readingOrder !== expectedRow.readingOrder) findings.push(hard('OCR_READING_ORDER_INVALID', id, scope));
    if (typeof row.text !== 'string' || !row.text.trim() || !validBox(row.bbox)) findings.push(hard('OCR_REGION_INVALID', id, scope));
  }
  for (const id of expectedById.keys()) {
    if (!seen.has(id)) findings.push(hard('OCR_REGION_MISSING', id, scope));
  }
  return findings;
}

function translationFindings({ bytes, inputs, regionId }) {
  const { lines } = inputs;
  requireValue(scopedIds(lines, regionId) && lines.every(line => typeof line.sourceText === 'string' && line.sourceText.trim()));
  let rows;
  try {
    rows = parsePageTranslationResponse(document(bytes), lines);
  } catch (error) {
    if (error.code !== 'PAGE_TRANSLATION_INVALID') throw error;
    return [hard(error.code, regionId, 'TRANSLATION_STRUCTURE')];
  }
  return rows.flatMap((row, index) => assessSemanticRisk({ ...row, region: lines[index] }).signals
    .map(signal => soft(signal.code, row.id, 'TRANSLATION_SEMANTICS')));
}

function frameSize({ width, height }) {
  requireValue(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0 && width * height <= 12_000_000);
  return width * height;
}

function regionPixels(regions, width, height, size) {
  const pixels = new Uint8Array(size);
  for (const region of regions) {
    const { left, top, width: w, height: h } = bounds(region.bbox, width, height);
    for (let y = top; y < Math.min(top + h, height); y++) pixels.fill(1, y * width + left, y * width + Math.min(left + w, width));
  }
  return pixels;
}

// The in-memory artifact is the exact decoded RGBA mask, with the legacy white/alpha semantics.
function maskFindings({ bytes, inputs, regionId }) {
  const { width, height, allowedRegions, protectedRegions } = inputs;
  const size = frameSize(inputs);
  requireValue(scopedIds(allowedRegions, regionId) && Array.isArray(protectedRegions) &&
    [...allowedRegions, ...protectedRegions].every(region => validBox(region?.bbox)));
  const fail = code => [hard(code, regionId, 'MASK_PIXELS')];
  if (bytes.length !== size * 4) return fail('MASK_FRAME_INVALID');
  const allowed = regionPixels(allowedRegions, width, height, size);
  const protectedPixels = regionPixels(protectedRegions, width, height, size);
  let removed = 0;
  for (let i = 0; i < size; i++) {
    const at = i * 4;
    const alpha = bytes[at + 3];
    if (alpha === 255) {
      if (bytes[at] !== 255 || bytes[at + 1] !== 255 || bytes[at + 2] !== 255) return fail('TEXT_MASK_INVALID');
      continue;
    }
    if (alpha !== 0) return fail('TEXT_MASK_INVALID');
    if (protectedPixels[i]) return fail('MASK_PROTECTED_PIXEL_CHANGED');
    if (!allowed[i]) return fail('MASK_SCOPE_VIOLATION');
    removed++;
  }
  return removed === 0 || removed === size ? fail('TEXT_MASK_INVALID') : [];
}

function typesetFindings({ bytes, inputs, regionId, pixels }) {
  const { width, height, lines, layoutRegions, protectedRegions = [], manualEntries = [], layoutReview } = inputs;
  const size = frameSize(inputs);
  const hashes = { source: inputs.sourceRgbaSha256, mask: inputs.maskRgbaSha256, cleaned: inputs.cleanedRgbaSha256 };
  requireValue(scopedIds(lines, regionId) && lines.every(row => validBox(row.bbox) && typeof row.userTranslation === 'string' && row.userTranslation.trim()) &&
    scopedIds(layoutRegions, regionId) && layoutRegions.length === lines.length &&
    layoutRegions.every(region => validBox(region.allowedBbox) && lines.some(row => row.id === region.id)) &&
    Array.isArray(protectedRegions) && Array.from(protectedRegions).every(region => validBox(region?.bbox)) &&
    Array.isArray(manualEntries) && Object.values(hashes).every(hex));
  const output = document(bytes);
  if (!Array.isArray(output?.layouts) || !hex(output.rasterSha256) || output.layouts.length !== lines.length) {
    return [hard('TYPESET_RESULT', regionId, 'TYPESET_LAYOUT')];
  }
  hashes.final = output.rasterSha256;
  if (!pixels || Object.keys(hashes).some(name => pixels[name] == null)) return unmeasured('RASTER_EVIDENCE_MISSING', regionId);
  for (const [name, expectedHash] of Object.entries(hashes)) {
    requireValue(Buffer.isBuffer(pixels[name]) && pixels[name].length === size * 4);
    requireValue(sha(pixels[name]) === expectedHash, 'SOURCE_INTEGRITY_FAILED');
  }
  const { layouts } = output;
  for (const [index, layout] of layouts.entries()) {
    const row = lines[index];
    const region = layoutRegions.find(r => r.id === row.id);
    if (layout?.id !== row.id || !validBox(layout.bbox) || !validBox(layout.sourceBbox)) return [hard('TYPESET_RESULT', row.id, 'TYPESET_LAYOUT')];
    const neighbors = [...protectedRegions, ...lines.filter(other => other.id !== row.id)];
    if (!inside(layout.bbox, region.allowedBbox) || neighbors.some(other => overlaps(layout.bbox, other.bbox))) {
      return [hard('TYPESET_SCOPE_VIOLATION', row.id, 'TYPESET_LAYOUT')];
    }
  }
  try {
    const { backgroundChecks } = verifyRenderedBackgrounds({
      layouts, inputs: { lines, layoutReview, current: { normalizedSha256: hashes.source } },
      maskEvidence: { width, height, maskSha256: hashes.mask, layoutRegions, extraction: { nonSpeechText: protectedRegions } },
      manualEntries, sourcePixels: pixels.source, maskPixels: pixels.mask,
      cleanedPixels: pixels.cleaned, finalPixels: pixels.final, cleanedSha256: hashes.cleaned,
    });
    const report = verifyImportedLayout(layouts, lines, { backgroundChecks, approvedLayoutReview: layoutReview });
    return report.standards.flatMap(({ id, assessment }) => (assessment?.softWarnings ?? [])
      .map(warning => soft(`${warning.rule}:${warning.code}`, id, 'READABILITY')));
  } catch (error) {
    if (!id(error.code)) throw error;
    const diagnostics = error.layoutDiagnostics;
    const rejectedRegion = diagnostics?.rejectedRegion ?? regionId;
    const failures = diagnostics?.regions.find(row => row.id === rejectedRegion)?.failures ?? [];
    if (error.code === 'MANUAL_LAYOUT_REQUIRED' && failures.every(code => code === 'READABILITY_REVIEW_REQUIRED')) {
      return unmeasured('TYPESET_LAYOUT_REVIEW_REQUIRED', rejectedRegion);
    }
    return [hard(error.code, rejectedRegion, 'TYPESET_LAYOUT')];
  }
}

const adapters = new Map([
  ['OCR', ['ocr-lineage', ocrFindings]],
  ['TRANSLATE', ['page-translation', translationFindings]],
  ['MASK', ['removal-mask-pixels', maskFindings]],
  ['TYPESET', ['typeset-raster', typesetFindings]],
]);

/** Inspect pinned, in-memory stage artifacts. The returned assessment uses the S15-01 contract. */
function inspectStage({ binding, node, observed, authority, inputs, bytes, pixels } = {}) {
  requireValue(record(node) && id(node.id) && id(node.stage) && (node.regionId === null || id(node.regionId)) && hex(node.inputsSha256));
  const { id: nodeId, stage, regionId, artifact, inputsSha256 } = node;
  const parentsSha256 = stageParentsSha256(node.parents);
  requireValue(parentsSha256 !== null && hex(observed?.parentsSha256));
  const [checkId, inspect] = adapters.get(stage) ?? ['stage-inspection', null];
  const required = { checkId, version };
  const assessment = structuredClone({
    binding, observed: { ...observed, checks: [] }, findings: [], authority: { ...authority, requiredChecks: [required] },
  });
  const gate = assessStage(assessment);
  requireValue(!gate.reasons.includes('COMMON_CONTRACT_INVALID'));
  requireValue(gate.kind !== 'BLOCKED' && assessment.observed.stage === stage && sameArtifact(artifact, assessment.authority.artifact) &&
    (assessment.observed.artifact === null || sameArtifact(artifact, assessment.observed.artifact)) &&
    assessment.observed.parentsSha256 === parentsSha256, 'STAGE15_INSPECTION_STALE');
  if (inputs != null) {
    requireValue(record(inputs));
    requireValue(key(inputs) === inputsSha256, 'STAGE15_INSPECTION_STALE');
  }
  if (bytes != null) {
    requireValue(Buffer.isBuffer(bytes));
    requireValue(sha(bytes) === artifact.sha256, 'SOURCE_INTEGRITY_FAILED');
  }
  let findings;
  if (!inspect) findings = unmeasured('CHECK_NOT_IMPLEMENTED', regionId);
  else if (inputs == null || bytes == null || gate.kind === 'RESULT_UNKNOWN' ||
      gate.reasons.some(reason => reason === 'STAGE_INCOMPLETE' || reason === 'OBSERVATION_EVIDENCE_MISSING')) {
    findings = unmeasured('STAGE_EVIDENCE_MISSING', regionId);
  } else {
    findings = inspect({ bytes, inputs, binding: assessment.binding, regionId, pixels });
  }
  const status = findings.some(f => f.severity === 'HARD') ? 'failed'
    : findings.some(f => f.severity === 'UNVERIFIED') ? 'not_measured' : 'passed';
  const measured = status !== 'not_measured';
  const evidenceId = measured ? stageCheckEvidenceId(assessment.binding, node, parentsSha256, { ...required, status }) : null;
  assessment.observed.checks.push({
    ...required, status, evidenceId, identity: measured ? structuredClone(assessment.binding) : null,
    subjectArtifactId: measured ? artifact.artifactId : null, subjectSha256: measured ? artifact.sha256 : null,
  });
  const byId = new Map();
  for (const finding of findings) {
    const id = key({ binding: assessment.binding, nodeId, inputsSha256, artifact, parentsSha256, ...required, ...finding });
    byId.set(id, { ...finding, id, evidenceId, checkId });
  }
  assessment.findings = [...byId.values()];
  return {
    nodeId, regionId, inputsSha256, parentsSha256, assessment,
  };
}

module.exports = { inspectStage };
