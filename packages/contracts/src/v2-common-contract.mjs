import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';

// Opt-in Stage04 sidecar only. This module neither publishes results nor changes
// legacy serializers, model settings, OCR thresholds, or algorithm decisions.
const schema = JSON.parse(readFileSync(new URL('../schemas/v2-common-contract-v1.schema.json', import.meta.url), 'utf8'));
const validateShape = new Ajv({ allErrors: true, strict: true }).compile(schema);
const axes = ['ruleQa', 'ocrValidation', 'semanticReview', 'imageReview', 'humanReview', 'userApproval'];
const removeSemantics = ['studio_inverse_alpha', 'binary01_active_remove', 'binary255_active_remove', 'worker_luminance_alpha'];
const protectSemantics = ['binary01_active_protect', 'binary255_active_protect'];
const done = review => ['passed', 'failed'].includes(review?.status);
const canonical = value => JSON.stringify(sort(value));
const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
const equal = (a, b) => canonical(a) === canonical(b);
function requireValue(condition, detail, code = 'COMMON_CONTRACT_INVALID') {
  if (!condition) throw Object.assign(new Error(detail), { code });
}
function index(items, key) {
  const result = new Map();
  for (const item of items) {
    requireValue(!result.has(item[key]), `Duplicate ${key}`);
    result.set(item[key], item);
  }
  return result;
}
const sameMembers = (a, b) => a.length === b.length && a.every(id => b.includes(id));
function requireRefs(ids, values, description) {
  requireValue(ids.every(id => values.has(id)), `Unknown ${description}`);
}
function acyclic(values, edges) {
  const finished = new Set(), active = new Set();
  function visit(id) {
    requireValue(!active.has(id), 'Cyclic provenance');
    if (finished.has(id)) return;
    active.add(id);
    for (const next of edges(values.get(id))) {
      requireValue(values.has(next), 'Dangling provenance'); visit(next);
    }
    active.delete(id); finished.add(id);
  }
  for (const id of values.keys()) visit(id);
}
function validMatrix(matrix) {
  return Array.isArray(matrix) && matrix.length === 6 && matrix.every(Number.isFinite) &&
    Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) > 1e-12;
}
function polygonInFrame(points, frame) {
  requireValue(frame && points.every(([x, y]) => x >= 0 && y >= 0 && x <= frame.width && y <= frame.height), 'Geometry outside declared frame');
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length]; twiceArea += a[0] * b[1] - a[1] * b[0];
  }
  requireValue(Math.abs(twiceArea) > 1e-9, 'Degenerate polygon');
}
function ratio(measurement) {
  requireValue(measurement.unit === 'ratio' && (measurement.value === null || measurement.value <= 1), 'Not a bounded ratio');
}

export function unknownQuality() {
  return { execution: 'unknown', ...Object.fromEntries(axes.map(axis => [axis,
    { status: 'not_measured', actor: null, evidenceId: null, subjectArtifactId: null, subjectSha256: null, identity: null }])), delivery: 'unknown' };
}
const readyAxes = quality => quality.execution === 'succeeded' && axes.every(axis => quality[axis]?.status === 'passed');
/** Derived labels, to be used only after validating their containing document. */
export function qualityFlags(quality) {
  const flags = [];
  if (quality.execution === 'succeeded') flags.push('RUN_SUCCEEDED');
  if (quality.ruleQa?.status === 'passed') flags.push('RULE_QA_PASSED');
  if (done(quality.semanticReview)) flags.push('SEMANTIC_REVIEWED');
  if (done(quality.humanReview)) flags.push('HUMAN_REVIEWED');
  if (quality.execution === 'partial_failed') flags.push('PARTIAL_FAILED');
  if (quality.delivery === 'ready' && readyAxes(quality)) flags.push('DELIVERABLE_READY');
  else flags.push('NEEDS_REVIEW');
  return flags;
}

/** Keep Stage02 measurements/denominators verbatim; PASS is a supplied claim. */
export function qualityFromStage02(page) {
  const quality = unknownQuality();
  quality.execution = { COMPLETED: 'succeeded', FAILED: 'failed', NOT_RUN: 'not_run', NEEDS_REVIEW: 'unknown' }[page.processingStatus] ?? 'unknown';
  return { stage02: structuredClone(page), quality };
}

export function transformPoint(point, matrix) {
  requireValue(Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) && validMatrix(matrix), 'Missing or invalid affine transform');
  const [x, y] = point, [a, b, c, d, e, f] = matrix;
  return [a * x + c * y + e, b * x + d * y + f];
}
function validSize(size) {
  return size && Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height) && size.width > 0 && size.height > 0 && size.width * size.height <= 12_000_000;
}
export function normalizedToPixels(point, size) {
  requireValue(validSize(size) && Array.isArray(point) && point.length === 2 && point.every(x => Number.isFinite(x) && x >= 0 && x <= 1), 'Invalid normalized point');
  return [point[0] * size.width, point[1] * size.height];
}
export function pixelsToNormalized(point, size) {
  requireValue(validSize(size) && Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) &&
    point[0] >= 0 && point[0] <= size.width && point[1] >= 0 && point[1] <= size.height, 'Invalid pixel point');
  return [point[0] / size.width, point[1] / size.height];
}

/** Decoded raster semantics. Encoded PNG hashes/dimensions are owning IO checks. */
export function decodeMaskPixels({ kind, encoding, pixels, width, height }) {
  requireValue(validSize({ width, height }) && pixels instanceof Uint8Array &&
    (kind === 'removal' && removeSemantics.includes(encoding) || kind === 'protection' && protectSemantics.includes(encoding)), 'Invalid mask role or encoding');
  const rgba = ['studio_inverse_alpha', 'worker_luminance_alpha'].includes(encoding), count = width * height;
  requireValue(pixels.length === count * (rgba ? 4 : 1), 'Mask dimension mismatch');
  const result = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if (encoding === 'studio_inverse_alpha') {
      const offset = i * 4, alpha = pixels[offset + 3];
      requireValue(alpha === 0 || alpha === 255, 'Nonbinary studio alpha');
      requireValue(alpha === 0 || pixels[offset] === 255 && pixels[offset + 1] === 255 && pixels[offset + 2] === 255, 'Invalid preserved RGB');
      result[i] = alpha === 0 ? 1 : 0;
    } else if (encoding === 'worker_luminance_alpha') {
      const offset = i * 4;
      requireValue(pixels[offset] === pixels[offset + 1] && pixels[offset] === pixels[offset + 2], 'Expected decoded grayscale channels');
      result[i] = pixels[offset] > 0 && pixels[offset + 3] > 0 ? 1 : 0;
    } else {
      const active = encoding.startsWith('binary01') ? 1 : 255;
      requireValue(pixels[i] === 0 || pixels[i] === active, 'Nonbinary mask value'); result[i] = pixels[i] === active ? 1 : 0;
    }
  }
  return result;
}
export function assertMasksDisjoint(removal, protection) {
  requireValue(removal instanceof Uint8Array && protection instanceof Uint8Array && removal.length === protection.length && removal.length > 0, 'Mask size mismatch');
  for (let i = 0; i < removal.length; i++) requireValue([0, 1].includes(removal[i]) && [0, 1].includes(protection[i]) && !(removal[i] && protection[i]), 'Remove/protect intersection');
}

export function resolveTranslationText(target) {
  const modified = target.text.userModified, confirmed = target.text.userConfirmed;
  if (modified && confirmed && modified.editRevision > confirmed.editRevision) return modified.value;
  return target.text.userConfirmed?.value ?? target.text.userModified?.value ?? target.text.aiCandidates.at(-1)?.text ?? null;
}

/** Canonical inline snapshot digest, separate from original serialized bytes.
 * Consumption receipts are appended later and are not snapshot content. */
export function computeContextSnapshotSha256(context) {
  const { sha256: _hash, consumption: _consumption, consumedRequestIds: _requests,
    consumedConfirmedTermIds: _terms, ...content } = context;
  return createHash('sha256').update('MANGOHANA_CONTEXT_V1\0' + canonical(content)).digest('hex');
}

export function validateCommonContract(document) {
  requireValue(validateShape(document), 'Invalid common contract shape');
  const d = document, images = index(d.images, 'imageId'), frames = index(d.frames, 'frameId'), observations = index(d.observations, 'lineId');
  const groups = index(d.groups, 'groupId'), regions = index(d.regions, 'regionId'), targets = index(d.targets, 'targetId');
  const requests = index(d.translations, 'requestId'), artifacts = index(d.artifacts, 'artifactId');
  index(d.refinements, 'refinementId'); index(d.typesetting, 'typesetId'); index(d.executionEvidence, 'stepId');
  const source = new Map(d.observations.filter(o => o.kind === 'source_detection').map(o => [o.lineId, o]));
  const redetected = new Map(d.observations.filter(o => o.kind === 'redetection').map(o => [o.lineId, o]));
  for (const kind of ['uploaded_original', 'normalized']) {
    const list = d.images.filter(image => image.kind === kind);
    requireValue(list.length === 1, 'Exactly one original and normalized image required');
    const image = list[0], asset = artifacts.get(image.artifactId);
    requireValue(validSize(image) && asset?.kind === kind && asset.sha256 === image.sha256 && asset.materialization === 'materialized', 'Image artifact binding mismatch');
    requireValue(frames.get(asset.frameId)?.imageId === image.imageId &&
      frames.get(asset.frameId)?.kind === (kind === 'uploaded_original' ? 'original_px' : 'normalized_px'), 'Image artifact pixel frame mismatch');
  }
  for (const frame of frames.values()) {
    requireValue(images.has(frame.imageId) && validSize(frame), 'Unknown frame image or dimensions');
    if (frame.toParent !== null) requireValue(validMatrix(frame.toParent), 'Singular transform');
    if (['original_px', 'normalized_px'].includes(frame.kind)) {
      const image = images.get(frame.imageId);
      requireValue(frame.width === image.width && frame.height === image.height && image.kind === (frame.kind === 'original_px' ? 'uploaded_original' : 'normalized') && frame.crop === null, 'Image frame mismatch');
      requireValue(frame.kind !== 'original_px' || frame.parentFrameId === null && frame.toParent === null, 'Original frame must be a root');
    } else {
      requireValue(frame.crop && frame.parentFrameId && validMatrix(frame.toParent), 'Crop transform missing');
      const c = frame.crop, expected = [1 / c.scaleX, 0, 0, 1 / c.scaleY,
        c.originX + c.tileOffset.x - c.padding.left / c.scaleX, c.originY + c.tileOffset.y - c.padding.top / c.scaleY];
      requireValue(frame.toParent.every((x, i) => Math.abs(x - expected[i]) < 1e-8) &&
        Math.abs(frame.width - (c.actualWidth * c.scaleX + c.padding.left + c.padding.right)) < 1e-8 &&
        Math.abs(frame.height - (c.actualHeight * c.scaleY + c.padding.top + c.padding.bottom)) < 1e-8, 'Inconsistent crop scale/padding/tile transform');
      requireValue(frames.get(frame.parentFrameId)?.imageId === frame.imageId, 'Crop uses a foreign image');
      const parent = frames.get(frame.parentFrameId);
      requireValue(c.originX + c.tileOffset.x + c.actualWidth <= parent.width &&
        c.originY + c.tileOffset.y + c.actualHeight <= parent.height, 'Crop rectangle outside parent pixels');
    }
  }
  acyclic(frames, frame => frame.parentFrameId === null ? [] : [frame.parentFrameId]);
  for (const item of [...observations.values(), ...regions.values(), ...d.typesetting]) {
    const frame = frames.get(item.frameId); polygonInFrame(item.polygon, frame);
    if (item.quad !== undefined && item.quad !== null) polygonInFrame(item.quad, frame);
  }
  for (const observation of observations.values()) {
    ratio(observation.detectionConfidence); ratio(observation.recognitionConfidence);
    const asset = artifacts.get(observation.originArtifactId), frame = frames.get(observation.frameId);
    requireValue(asset?.kind === (observation.kind === 'source_detection' ? 'raw_ocr' : 'crop_ocr'), 'Wrong observation origin');
    requireValue(asset.frameId === observation.frameId, 'Observation artifact frame mismatch');
    requireValue(observation.kind !== 'source_detection' || frame.kind === 'normalized_px', 'Source detection must use normalized page pixels');
    requireValue(observation.kind !== 'redetection' || ['crop_px', 'tile_px'].includes(frame.kind), 'Redetection must retain its local frame');
    if (observation.parentLineId != null) requireValue(source.has(observation.parentLineId) && observation.parentLineId !== observation.lineId, 'Foreign parent text line');
    if (observation.textRole === 'furigana') requireValue(observation.parentLineId != null, 'Furigana parent relation missing');
  }
  for (const region of regions.values()) ratio(region.confidence);
  const groupLines = new Set();
  for (const group of groups.values()) for (const line of group.sourceLineIds) {
    requireValue(source.has(line) && !groupLines.has(line), 'Missing or multiply grouped source line'); groupLines.add(line);
  }
  requireValue(groupLines.size === source.size, 'Ungrouped source line');
  const mappings = index(d.mappings, 'sourceLineId');
  requireValue(sameMembers([...mappings.keys()], [...source.keys()]), 'Missing source mapping');
  for (const mapping of mappings.values()) {
    requireValue(groups.get(mapping.groupId)?.sourceLineIds.includes(mapping.sourceLineId), 'Foreign source/group mapping');
    requireRefs(mapping.regionIds, regions, 'ROI'); requireRefs(mapping.redetectedLineIds, redetected, 'redetection');
    if (mapping.disposition !== 'needs_review') requireValue(mapping.regionIds.length > 0 &&
      mapping.regionIds.every(id => regions.get(id).classification !== 'unknown'), 'Unknown text requires review');
    if (mapping.disposition === 'translate') requireValue(targets.get(mapping.targetId)?.sourceLineIds.includes(mapping.sourceLineId), 'Unmapped translation target');
    else requireValue(mapping.targetId === null, 'Nontranslation cannot have a target');
  }
  for (const refinement of d.refinements) {
    requireValue(groups.has(refinement.parentGroupId) && frames.get(refinement.cropFrameId)?.kind === 'crop_px' && artifacts.get(refinement.rawArtifactId)?.kind === 'crop_ocr', 'Invalid refinement origin');
    requireRefs(refinement.regionIds, regions, 'refinement ROI'); requireRefs(refinement.sourceLineIds, source, 'refinement source');
    requireRefs(refinement.redetectedLineIds, redetected, 'refinement redetection');
    requireValue(refinement.sourceLineIds.every(id => groups.get(refinement.parentGroupId).sourceLineIds.includes(id)) &&
      refinement.redetectedLineIds.every(id => redetected.get(id).frameId === refinement.cropFrameId), 'Refinement frame/group mismatch');
    const coverage = index(refinement.coverageBySourceLine, 'lineId');
    requireValue(sameMembers([...coverage.keys()], refinement.sourceLineIds) && refinement.missingSourceLineIds.every(id => refinement.sourceLineIds.includes(id)), 'Incomplete per-source coverage accounting');
    for (const value of coverage.values()) ratio(value.ratio);
    if (refinement.outcome === 'accepted') requireValue(refinement.missingSourceLineIds.length === 0 && refinement.characterPreservation !== 'failed' &&
      refinement.redetectedLineIds.length > 0 && refinement.sourceLineIds.every(id => mappings.get(id).redetectedLineIds.some(x => refinement.redetectedLineIds.includes(x))), 'Missing source lines cannot be accepted');
  }
  for (const mapping of mappings.values()) for (const lineId of mapping.redetectedLineIds)
    requireValue(d.refinements.some(r => r.sourceLineIds.includes(mapping.sourceLineId) && r.redetectedLineIds.includes(lineId)), 'Redetection lineage has no refinement');
  for (const target of targets.values()) {
    requireRefs(target.sourceLineIds, source, 'target source'); requireRefs(target.regionIds, regions, 'target ROI');
    requireValue(target.sourceLineIds.every(id => mappings.get(id).targetId === target.targetId && mappings.get(id).disposition === 'translate') &&
      sameMembers(target.regionIds, [...new Set(target.sourceLineIds.flatMap(id => mappings.get(id).regionIds))]), 'Target lineage mismatch');
    requireValue(target.contextSnapshotId === (d.context?.snapshotId ?? null), 'Target context snapshot mismatch');
    requireValue(target.contextSnapshotSha256 === (d.context?.sha256 ?? null), 'Target context hash mismatch');
    index(target.text.aiCandidates, 'id');
    for (const user of [target.text.userModified, target.text.userConfirmed]) if (user !== null) requireValue(d.identity.editRevision !== null && user.editRevision <= d.identity.editRevision, 'Future user edit revision');
  }
  for (const request of requests.values()) {
    requireRefs(request.targetIds, targets, 'request target');
    requireValue(sameMembers(request.sourceLineIds, [...new Set(request.targetIds.flatMap(id => targets.get(id).sourceLineIds))]) &&
      request.contextSnapshotId === (d.context?.snapshotId ?? null) && request.contextSnapshotSha256 === (d.context?.sha256 ?? null), 'Request lineage/context mismatch');
  }
  for (const layout of d.typesetting) requireValue(targets.has(layout.targetId) && requests.get(layout.requestId)?.targetIds.includes(layout.targetId) && requests.get(layout.requestId)?.status === 'proposed' &&
    sameMembers(layout.sourceLineIds, targets.get(layout.targetId).sourceLineIds) && artifacts.get(layout.overlayArtifactId)?.kind === 'korean_overlay', 'Typesetting lineage mismatch');
  for (const artifact of artifacts.values()) {
    requireValue(artifact.frameId === null || frames.has(artifact.frameId), 'Unknown artifact frame');
    requireRefs(artifact.sourceLineIds, source, 'artifact source');
    requireValue(artifact.materialization === 'materialized' ? artifact.sha256 !== null && artifact.unmeasuredReason === null : artifact.sha256 === null && artifact.unmeasuredReason !== null, 'Unmeasured artifact cannot claim a hash');
    if (artifact.kind === 'removal_mask') requireValue(removeSemantics.includes(artifact.maskSemantics), 'Wrong removal mask semantics');
    else if (artifact.kind === 'protection_mask') requireValue(protectSemantics.includes(artifact.maskSemantics), 'Wrong protection mask semantics');
    else requireValue(artifact.maskSemantics === null, 'Nonmask artifact has mask semantics');
    if (artifact.materialization === 'materialized' && ['removal_mask', 'korean_overlay'].includes(artifact.kind)) requireValue(artifact.sourceLineIds.length > 0 &&
      artifact.sourceLineIds.every(id => mappings.get(id).disposition === 'translate'), 'Erasure/overlay includes preserved or review text');
    const requiredParents = { normalized: ['uploaded_original'], source_text_regions: ['raw_ocr'], removal_mask: ['source_text_regions'],
      protection_mask: ['source_text_regions'], pre_lama: ['normalized', 'removal_mask', 'protection_mask'], restored_image: ['pre_lama'],
      final_png: ['restored_image', 'korean_overlay'], trio_project: ['final_png'] }[artifact.kind] ?? [];
    requireValue(requiredParents.every(kind => artifact.parentArtifactIds.some(id => artifacts.get(id)?.kind === kind)), 'Required artifact ancestry missing');
  }
  acyclic(artifacts, artifact => artifact.parentArtifactIds);
  validateContext(d, requests);
  for (const evidence of d.executionEvidence) {
    requireValue(evidence.jobId === d.identity.jobId, 'Foreign execution job');
    if (evidence.failure != null) requireValue(evidence.failure.stage === evidence.stage, 'Failure stage mismatch');
    requireRefs(evidence.inputArtifactIds, artifacts, 'execution input'); requireRefs(evidence.outputArtifactIds, artifacts, 'execution output');
    for (const [key, measurement] of Object.entries(evidence.measurements)) {
      if (['calls', 'retries', 'apiCalls', 'localCalls', 'inputTokens', 'outputTokens', 'peakRam', 'peakGpu'].includes(key))
        requireValue(measurement.value === null || Number.isSafeInteger(measurement.value), 'Nonintegral resource observation');
      const unit = ['peakRam', 'peakGpu'].includes(key) ? 'bytes' : ['inputTokens', 'outputTokens'].includes(key) ? 'tokens' : key === 'elapsed' ? 'ms' : key === 'cost' ? null : 'count';
      requireValue(unit === null || measurement.unit === unit, 'Resource unit mismatch');
    }
  }
  validateQuality(d, artifacts);
  if (d.receipt !== null) {
    requireValue(d.receipt.jobId === d.identity.jobId && equal(d.receipt.identity, d.identity), 'Receipt scope mismatch');
    const pins = index(d.receipt.artifactHashes, 'artifactId');
    for (const pin of pins.values()) requireValue(artifacts.get(pin.artifactId)?.sha256 === pin.sha256 && artifacts.get(pin.artifactId)?.materialization === 'materialized', 'Receipt artifact hash mismatch');
    if (d.receipt.complete) requireValue(sameMembers([...pins.keys()], d.artifacts.filter(a => a.materialization === 'materialized').map(a => a.artifactId)), 'Incomplete receipt artifact pins');
  }
  return document;
}

function validateContext(d, requests) {
  const c = d.context;
  if (c === null) return;
  requireValue(equal(c.ownerScope, d.identity.ownerScope) && c.projectId === d.identity.projectId && c.workId === d.identity.workId &&
    c.pageId === d.identity.pageId && c.revision === d.identity.contextRevision, 'Foreign or stale context');
  requireValue(c.sha256 === computeContextSnapshotSha256(c), 'Context snapshot content hash mismatch');
  index(c.terms, 'id'); index(c.previousPages, 'pageId');
  for (const term of c.terms) requireValue(term.revision <= c.revision, 'Future term revision');
  const consumedTerms = c.consumedConfirmedTermIds ?? [];
  requireValue(consumedTerms.every(id => c.terms.some(t => t.id === id && t.status === 'user_confirmed')) &&
    (c.consumption === 'consumed' || consumedTerms.length === 0), 'Unconfirmed terminology cannot be consumed as confirmed');
  for (const page of c.previousPages) requireValue(equal(page.ownerScope, c.ownerScope) && page.projectId === c.projectId && page.workId === c.workId &&
    page.pageId !== c.pageId && page.pageOrdinal < c.pageOrdinal, 'Foreign or future narrative context');
  requireRefs(c.consumedRequestIds, requests, 'consumed request');
  requireValue(c.consumption === 'consumed' ? c.consumedRequestIds.length > 0 && c.enginePath === 'experimental_page' &&
    c.consumedRequestIds.every(id => requests.get(id).scope === 'page' && requests.get(id).contextSnapshotId === c.snapshotId) : c.consumedRequestIds.length === 0, 'Unsupported context consumption claim');
}
function validateQuality(d, artifacts) {
  for (const axis of axes) {
    const review = d.quality[axis];
    if (done(review)) {
      requireValue(review.evidenceId !== null && artifacts.get(review.subjectArtifactId)?.materialization === 'materialized' && review.actor !== null, 'Review evidence missing');
      requireValue(review.subjectSha256 === artifacts.get(review.subjectArtifactId).sha256 && equal(review.identity, d.identity), 'Review hash or revision binding mismatch');
      if (['humanReview', 'userApproval'].includes(axis)) requireValue(review.actor === 'human', 'AI review is not human approval');
      if (['semanticReview', 'imageReview'].includes(axis)) requireValue(review.actor !== 'rule', 'Rules cannot establish semantic/image review');
    } else requireValue(review.evidenceId === null && review.subjectArtifactId === null && review.actor === null && review.subjectSha256 === null && review.identity === null, 'Unmeasured review cannot carry an approval');
  }
  if (d.quality.delivery === 'ready') {
    const finals = d.artifacts.filter(a => a.kind === 'final_png' && a.materialization === 'materialized');
    requireValue(readyAxes(d.quality) && finals.length === 1 && d.receipt?.complete === true &&
      d.mappings.every(m => m.disposition !== 'needs_review') && d.refinements.every(r => r.outcome !== 'needs_review') &&
      ['semanticReview', 'imageReview', 'humanReview', 'userApproval'].every(axis => d.quality[axis].subjectArtifactId === finals[0].artifactId), 'Delivery requires independent bound reviews and a complete receipt');
  }
}

/** Read-only projection. No automatic insertion into legacy saves or TRIO files. */
export function readContractAttachment(legacy) {
  requireValue(legacy !== null && typeof legacy === 'object' && !Array.isArray(legacy), 'Expected an existing document');
  const copy = structuredClone(legacy);
  if (!Object.hasOwn(copy, 'commonDataContract')) return { legacy: copy, contract: null, quality: unknownQuality(), reasons: ['LEGACY_CONTRACT_NOT_SUPPLIED'] };
  const contract = validateCommonContract(copy.commonDataContract);
  return { legacy: copy, contract, quality: structuredClone(contract.quality), reasons: [] };
}

/** Pure admission predicate. Owning API/worker must check AND publish under one
 * transaction/lock and pin actual files using existing immutable job receipts. */
export function assertCommitAllowed({ current, ticket, candidate }) {
  validateCommonContract(candidate);
  const stale = condition => requireValue(condition, 'Stale or unbound processing result', 'COMMON_CONTRACT_STALE');
  stale(current && ticket && equal(current.identity, ticket.identity) && equal(candidate.identity, ticket.identity));
  stale(candidate.identity.workId !== null && ['sourceRevision', 'editRevision', 'contextRevision', 'processingGeneration', 'storageRevision'].every(key => candidate.identity[key] !== null));
  stale(current.execution === 'running' && current.cancelled === false && candidate.quality.execution === 'succeeded');
  const original = candidate.images.find(i => i.kind === 'uploaded_original'), normalized = candidate.images.find(i => i.kind === 'normalized');
  stale(current.sourceSha256 === ticket.sourceSha256 && original.sha256 === ticket.sourceSha256 &&
    current.normalizedSha256 === ticket.normalizedSha256 && normalized.sha256 === ticket.normalizedSha256);
  stale(Object.hasOwn(current, 'contextSnapshotSha256') && Object.hasOwn(ticket, 'contextSnapshotSha256') &&
    current.contextSnapshotSha256 === ticket.contextSnapshotSha256 && ticket.contextSnapshotSha256 === (candidate.context?.sha256 ?? null));
  stale(Array.isArray(current.protectedTranslations));
  for (const value of current.protectedTranslations) {
    const target = candidate.targets.find(t => t.targetId === value.targetId);
    stale(target && equal(target.text.userModified, value.userModified) && equal(target.text.userConfirmed, value.userConfirmed));
  }
  requireValue(candidate.receipt?.complete === true && candidate.artifacts.every(a => a.materialization === 'materialized'), 'Incomplete result receipt');
  for (const kind of ['uploaded_original', 'normalized', 'source_text_regions', 'removal_mask', 'protection_mask', 'pre_lama', 'restored_image', 'korean_overlay', 'final_png'])
    requireValue(candidate.artifacts.filter(a => a.kind === kind).length === 1, 'Required output missing or ambiguous');
  requireValue(candidate.targets.every(target => candidate.typesetting.some(layout => layout.targetId === target.targetId &&
    candidate.translations.some(request => request.requestId === layout.requestId && request.status === 'proposed' && request.outputSha256 !== null))), 'Translation/layout output incomplete');
  const maskLines = candidate.artifacts.find(a => a.kind === 'removal_mask').sourceLineIds;
  requireValue(sameMembers(maskLines, [...new Set(candidate.targets.flatMap(t => t.sourceLineIds))]), 'Incomplete removal lineage');
  return true;
}
