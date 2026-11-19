import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { duplicateRelation, fingerprintImage } from './image-fingerprint.mjs';

// Offline evaluation metadata only. No application, model, database or network imports.
const readSchema = url => JSON.parse(readFileSync(new URL(url, import.meta.url), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(readSchema('../contracts/schemas/v2-common-contract-v1.schema.json'));
const datasetShape = ajv.compile(readSchema('./dataset-v1.schema.json'));
const annotationShape = ajv.compile(readSchema('./annotation-v1.schema.json'));
export const TAG_NAMES = ['connected_bubbles','overlapping_bubbles','multiline_bubble','vertical_text','horizontal_text','furigana','small_text','sfx','monologue','narration','outside_dialogue','complex_background','artwork_contact','long_korean','low_resolution','blurred_source','speaker_disambiguation','work_terms','adjacent_context','unreadable_source'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
export const contentSha256 = value => sha(JSON.stringify(sorted(value)));
export function annotationContentSha256(annotation) {
  const { reviews, status, statusReason, ...content } = annotation;
  return contentSha256(content);
}
export function manifestContentSha256(manifest) { return contentSha256({ ...manifest, freeze: null }); }
function requireValue(ok, code, detail = code) { if (!ok) throw Object.assign(new Error(detail), { code }); }
function shape(check, value, code) {
  requireValue(check(value), code, JSON.stringify(check.errors?.map(e => ({ path: e.instancePath, message: e.message }))));
}
function index(items, key) {
  const map = new Map();
  for (const item of items) { requireValue(!map.has(item[key]), 'DUPLICATE_ID', `Duplicate ${key}: ${item[key]}`); map.set(item[key], item); }
  return map;
}
const equal = (a, b) => contentSha256(a) === contentSha256(b);
const bilingualHuman = r => r?.kind === 'human' && ['ja', 'ko'].every(l => r.languages.includes(l)) && r.qualificationEvidence !== null;
export { bilingualHuman as isBilingualHumanReviewer };
function order(value) {
  requireValue(value.status === 'verified' ? value.value !== null && value.evidence !== null : value.value === null && value.evidence === null, 'UNVERIFIED_PAGE_ORDER');
}
function assessment(value) {
  requireValue(value.origin === 'unassessed' ? value.value === null && value.evidence === null : value.value !== null && value.evidence !== null, 'INVALID_ASSESSMENT');
}
function geometry(g, frame, nullable = false) {
  if (g === null && nullable) return;
  requireValue(g && g.frameId === frame.frameId && g.polygon.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x <= frame.width && y <= frame.height), 'INVALID_GEOMETRY');
  const area = Math.abs(g.polygon.reduce((n, [x, y], i, points) => { const next = points[(i + 1) % points.length]; return n + x * next[1] - next[0] * y; }, 0));
  requireValue(area > 0, 'INVALID_GEOMETRY');
}
function humanApprovals(a, manifest) {
  const reviewers = index(manifest.reviewers, 'reviewerId');
  const approvals = a.reviews.filter(r => r.role === 'independent' && r.outcome === 'approved' && r.independent && r.blinded && bilingualHuman(reviewers.get(r.reviewerId)));
  const distinct = new Set(approvals.map(r => r.reviewerId)), groups = new Set(approvals.map(r => reviewers.get(r.reviewerId).independenceGroup));
  return { approvals, count: Math.min(distinct.size, groups.size) };
}

export function validateAnnotation(a, page, manifest) {
  shape(annotationShape, a, 'ANNOTATION_SCHEMA_INVALID');
  const basis = [page.source, ...page.variants].find(i => i.sha256 === a.basisImageSha256);
  requireValue(a.datasetId === manifest.datasetId && a.datasetVersion === manifest.datasetVersion && a.pageId === page.pageId && a.workId === page.workId
    && a.sourceSha256 === page.source.sha256 && a.criteriaVersion === manifest.criteria.version && basis
    && a.frame.width === basis.width && a.frame.height === basis.height, 'ANNOTATION_BINDING_MISMATCH');
  requireValue(['original_px', 'normalized_px'].includes(a.frame.kind), 'INVALID_GEOMETRY');
  if (a.frame.kind === 'original_px') requireValue(basis.sha256 === page.source.sha256 && a.frame.parentFrameId === null && a.frame.toParent === null, 'ANNOTATION_BINDING_MISMATCH');
  else requireValue(basis.sha256 !== page.source.sha256 && a.frame.parentFrameId !== null && a.frame.toParent !== null
    && Math.abs(a.frame.toParent[0] * a.frame.toParent[3] - a.frame.toParent[1] * a.frame.toParent[2]) > 0, 'ANNOTATION_BINDING_MISMATCH');
  const reviewers = index(manifest.reviewers, 'reviewerId'), reviews = index(a.reviews, 'reviewId');
  index(a.disagreements, 'disagreementId');
  if (a.provenance.kind === 'human_authored') requireValue(bilingualHuman(reviewers.get(a.provenance.authorId)) && a.provenance.evidence !== null, 'HUMAN_REVIEW_REQUIRED');
  else requireValue(a.provenance.authorId === null, 'HUMAN_REVIEW_REQUIRED');
  const human = humanApprovals(a, manifest);
  if (a.status === 'human_verified') requireValue(human.count >= 2 && Object.values(a.coverage).every(v => v === 'complete'), 'HUMAN_REVIEW_REQUIRED');
  if (a.status === 'human_partial') requireValue(human.count >= 1, 'HUMAN_REVIEW_REQUIRED');
  for (const d of a.disagreements) {
    requireValue(new Set(d.reviewIds).size >= 2 && d.reviewIds.every(id => reviews.has(id)), 'INVALID_DISAGREEMENT');
    if (d.status === 'open') requireValue(d.resolution === null && a.status !== 'human_verified', 'UNRESOLVED_DISAGREEMENT');
    else requireValue(d.resolution !== null && bilingualHuman(reviewers.get(d.resolution.reviewerId)), 'INVALID_DISAGREEMENT');
  }
  const lines = index(a.lines, 'lineId'), regions = index(a.regions, 'regionId');
  index(a.translations, 'targetId'); index(a.imageQuality.regions, 'regionId');
  const orders = new Set();
  for (const l of a.lines) {
    geometry(l.geometry, a.frame, a.status !== 'human_verified');
    order(l.readingOrder);
    if (l.readingOrder.value !== null) { requireValue(!orders.has(l.readingOrder.value), 'DUPLICATE_READING_ORDER'); orders.add(l.readingOrder.value); }
    requireValue(l.speaker.id === null ? l.speaker.reason !== null : l.speaker.reason === null, 'SPEAKER_UNCERTAINTY_REQUIRED');
    requireValue(new Set(l.roiMapping.regionIds).size === l.roiMapping.regionIds.length && l.roiMapping.regionIds.every(id => regions.has(id) && regions.get(id).sourceLineIds.includes(l.lineId)), 'INVALID_REGION_MAPPING');
    if (a.status === 'human_verified') requireValue(l.roiMapping.status === 'human' && (l.roiMapping.regionIds.length > 0 || l.roiMapping.reason !== null), 'INVALID_REGION_MAPPING');
    requireValue(l.furiganaOf === null || (l.furiganaOf !== l.lineId && lines.has(l.furiganaOf) && l.role === 'furigana'), 'INVALID_FURIGANA_LINK');
    const t = l.transcription, chars = t.text === null ? [] : [...t.text];
    if (t.segments) {
      index(t.segments, 'segmentId');
      requireValue(t.segments.every(s => s.kind === 'readable' ? s.text !== null && s.length === [...s.text].length && s.reason === null
        : s.text === null && s.reason !== null), 'INVALID_TRANSCRIPTION');
    }
    requireValue(t.status === 'readable' ? chars.length > 0 && t.uncertainSpans.length === 0 && t.reason === null
      : t.status === 'uncertain' ? t.text === null && t.reason !== null && t.uncertainSpans.length === 0 && t.segments?.length > 0 && t.segments.some(s => s.kind !== 'readable')
        : t.text === null && t.uncertainSpans.length === 0 && t.reason !== null, 'INVALID_TRANSCRIPTION');
    if (t.status === 'readable' && t.segments?.length) requireValue(t.segments.every(s => s.kind === 'readable') && t.segments.map(s => s.text).join('') === t.text, 'INVALID_TRANSCRIPTION');
    if (a.status === 'human_verified' && l.role === 'sfx') requireValue(l.processingIntent && l.processingIntent.action !== 'needs_review' && l.processingIntent.evidence !== null, 'SFX_DISPOSITION_REQUIRED');
    if (a.status === 'human_verified') requireValue(t.status !== 'unannotated', 'INCOMPLETE_GROUND_TRUTH');
    const o = l.ocrComparison;
    requireValue(o.status === 'not_measured' ? o.ocrArtifact === null && o.missing === null && [o.outputLineIds,o.mergedWith,o.splitInto,o.differences].every(x => x.length === 0)
      : o.ocrArtifact !== null && typeof o.missing === 'boolean', 'UNMEASURED_OCR_CLAIM');
  }
  for (const r of a.regions) {
    geometry(r.geometry, a.frame);
    requireValue(new Set(r.sourceLineIds).size === r.sourceLineIds.length && r.sourceLineIds.every(id => lines.has(id) && lines.get(id).roiMapping.regionIds.includes(r.regionId)), 'INVALID_REGION_MAPPING');
  }
  for (const t of a.translations) {
    requireValue(new Set(t.sourceLineIds).size === t.sourceLineIds.length && t.sourceLineIds.every(id => lines.has(id)), 'UNKNOWN_TRANSLATION_LINE');
    const unknownMeaning = t.sourceLineIds.some(id => ['unreadable','unannotated','uncertain'].includes(lines.get(id).transcription.status));
    requireValue(!unknownMeaning || (t.meaning === null && t.status !== 'defined' && t.reason !== null), 'UNREADABLE_MEANING_INVENTED');
    requireValue(t.status === 'defined' ? t.meaning !== null && t.reason === null : t.meaning === null && t.reason !== null, 'INVALID_TRANSLATION_MEANING');
    const length = t.sourceLineIds.reduce((n, id) => n + [...(lines.get(id).transcription.text ?? '')].length, 0);
    for (const e of t.errors) requireValue(e.sourceSpan.start <= e.sourceSpan.end && e.sourceSpan.end <= length && e.candidateSpan.start < e.candidateSpan.end, 'INVALID_ERROR_SPAN');
  }
  if (a.status === 'human_verified') {
    requireValue(a.lines.every(l => (l.role === 'sfx' && l.processingIntent.action === 'preserve') || l.role === 'furigana' || a.translations.some(t => t.sourceLineIds.includes(l.lineId))), 'INCOMPLETE_GROUND_TRUTH');
  }
  const hidden = a.imageQuality.hiddenBackgroundTruth;
  requireValue(hidden.available ? hidden.image !== null : hidden.image === null && hidden.reason !== null, 'BACKGROUND_REFERENCE_REQUIRED');
  for (const r of a.imageQuality.regions) {
    geometry(r.geometry, a.frame);
    if (['residue_white_halo','residue_translucent','overflow','clipping','legibility'].includes(r.kind)) requireValue(r.observedResult !== null, 'RESULT_IMAGE_REFERENCE_REQUIRED');
  }
  const digest = annotationContentSha256(a);
  for (const r of a.reviews) {
    requireValue(reviewers.has(r.reviewerId), 'UNKNOWN_REVIEWER');
    requireValue(r.annotationContentSha256 === digest, 'STALE_HUMAN_REVIEW');
  }
  requireValue(a.status === 'human_verified' ? a.statusReason === null : a.statusReason !== null, 'ANNOTATION_STATUS_REASON_REQUIRED');
  return a;
}

export function validateDataset(m, options = {}) { return validateDatasetCore(m, options); }
function validateDatasetCore(m, { policy, annotations = [] } = {}, requireAnnotations = true) {
  shape(datasetShape, m, 'DATASET_SCHEMA_INVALID');
  requireValue(policy && policy.version === m.criteria.version && policy.normalization === 'NFKC_CODEPOINTS_KEEP_SPACE_PUNCTUATION'
    && policy.splitUnit === 'work' && policy.regionMatching === 'MAX_CARDINALITY_THEN_IOU' && policy.iouThreshold === 0.5
    && Number.isInteger(policy.nearDuplicateHamming) && policy.nearDuplicateHamming >= 0 && policy.nearDuplicateHamming <= 6
    && policy.humanReview === 'TWO_INDEPENDENT_JA_KO_REVIEWERS' && policy.finalEvaluationExecuted === false, 'INVALID_CRITERIA');
  // criteria.sha256 pins encoded file bytes at the I/O boundary. Content rules above are checked here.
  const works = index(m.works, 'workId'), pages = index(m.pages, 'pageId'), reviewers = index(m.reviewers, 'reviewerId');
  const splits = new Map(), cross = (key, split, code) => {
    requireValue(!splits.has(key) || splits.get(key) === split, code, key); splits.set(key, split);
  };
  // Check relationships before readiness to expose leakage even for incomplete inventory.
  for (const p of m.pages) {
    const w = works.get(p.workId); requireValue(w, 'UNKNOWN_WORK');
    if (p.split === 'unassigned') continue;
    cross('work:' + w.workId, p.split, 'WORK_SPLIT_LEAKAGE');
    cross('leakage-group:' + w.leakageGroupId, p.split, 'WORK_SPLIT_LEAKAGE');
    cross('duplicate-group:' + p.duplicateGroupId, p.split, 'DUPLICATE_SPLIT_LEAKAGE');
    for (const i of [p.source, ...p.variants]) { cross('bytes:' + i.sha256, p.split, 'DUPLICATE_SPLIT_LEAKAGE'); cross('pixels:' + i.pixelSha256, p.split, 'DUPLICATE_SPLIT_LEAKAGE'); }
  }
  const duplicateReviewMap = new Map();
  for (const r of m.duplicateReviews) {
    const key = [...r.pageIds].sort().join('|');
    requireValue(!duplicateReviewMap.has(key) && new Set(r.pageIds).size === 2 && r.pageIds.every(id => pages.has(id)) && reviewers.get(r.reviewerId)?.kind === 'human', 'INVALID_DUPLICATE_REVIEW');
    duplicateReviewMap.set(key, r);
    if (r.relation === 'same') requireValue(pages.get(r.pageIds[0]).split === pages.get(r.pageIds[1]).split, 'DUPLICATE_SPLIT_LEAKAGE');
  }
  const duplicateCandidates = [];
  for (let x = 0; x < m.pages.length; x++) for (let y = x + 1; y < m.pages.length; y++) {
    const a = m.pages[x], b = m.pages[y];
    let relation = { candidate: false };
    for (const ai of [a.source, ...a.variants]) for (const bi of [b.source, ...b.variants]) {
      const found = duplicateRelation(ai, bi, policy.nearDuplicateHamming);
      if (found.candidate && (!relation.candidate || found.distance < relation.distance || found.kind !== 'perceptual_candidate')) relation = found;
    }
    if (!relation.candidate) continue;
    const review = duplicateReviewMap.get([a.pageId, b.pageId].sort().join('|'));
    const resolvedDistinct = relation.kind === 'perceptual_candidate' && review?.relation === 'distinct';
    if (!resolvedDistinct && a.split !== 'unassigned' && b.split !== 'unassigned') requireValue(a.split === b.split, relation.kind === 'perceptual_candidate' ? 'NEAR_DUPLICATE_SPLIT_LEAKAGE' : 'DUPLICATE_SPLIT_LEAKAGE');
    duplicateCandidates.push({ pageIds: [a.pageId, b.pageId], ...relation, disposition: resolvedDistinct ? 'human_distinct' : review?.relation === 'same' ? 'human_same' : 'needs_review' });
  }
  const annotationsByPage = index(annotations, 'pageId');
  for (const a of annotations) { requireValue(pages.has(a.pageId), 'UNKNOWN_ANNOTATION_PAGE'); validateAnnotation(a, pages.get(a.pageId), m); }
  for (const p of m.pages) {
    const w = works.get(p.workId);
    requireValue(p.split === 'unassigned' ? p.usedForDevelopment === null : typeof p.usedForDevelopment === 'boolean', 'DEVELOPMENT_EXPOSURE_REQUIRED');
    requireValue(p.split !== 'holdout' || !p.usedForDevelopment, 'HOLDOUT_ALREADY_USED');
    requireValue(['dev','unassigned'].includes(p.split) || (w.status === 'confirmed' && w.identityEvidence !== null), 'UNCONFIRMED_EVALUATION_WORK');
    requireValue(w.status !== 'confirmed' || (w.title !== null && w.identityEvidence !== null), 'UNCONFIRMED_EVALUATION_WORK');
    const rights = p.provenance.rights;
    requireValue(rights.status === 'authorized' ? rights.evidence !== null : rights.evidence === null, 'INVALID_RIGHTS_EVIDENCE');
    requireValue(['dev','unassigned'].includes(p.split) || (rights.status === 'authorized' && rights.allowedUses.includes('local_evaluation')), 'RIGHTS_REQUIRED');
    order(p.pageOrder); assessment(p.bubbleCount); Object.values(p.tags).forEach(assessment);
    const expected = p.split === 'holdout' ? 'holdout/annotations/' : `annotations/${p.split}/`;
    requireValue(p.annotation.path.replaceAll('\\', '/').startsWith(expected) && !p.annotation.path.split(/[\\/]/).includes('..') && !path.isAbsolute(p.annotation.path), 'ANNOTATION_PATH_SPLIT_MISMATCH');
    const a = annotationsByPage.get(p.pageId);
    requireValue(!a || a.status === p.annotation.status, 'ANNOTATION_STATUS_MISMATCH');
    if (requireAnnotations && p.split !== 'holdout' && ['human_partial','human_verified'].includes(p.annotation.status)) requireValue(a, 'MISSING_ANNOTATION');
  }
  let frozen = false;
  if (m.freeze) {
    const f = m.freeze, pins = m.pages.map(p => ({ pageId: p.pageId, sha256: p.annotation.sha256 })).sort((a,b) => a.pageId.localeCompare(b.pageId));
    requireValue(f.manifestContentSha256 === manifestContentSha256(m) && f.criteriaSha256 === m.criteria.sha256 && bilingualHuman(reviewers.get(f.approvedBy))
      && equal([...f.annotationPins].sort((a,b) => a.pageId.localeCompare(b.pageId)), pins), 'INVALID_FREEZE');
    if (f.finalRun) requireValue(f.finalRun.criteriaSha256 === f.criteriaSha256 && f.finalRun.manifestContentSha256 === f.manifestContentSha256 && Date.parse(f.finalRun.startedAt) >= Date.parse(f.frozenAt), 'INVALID_FREEZE');
    frozen = true;
  }
  const verified = annotations.filter(a => a.status === 'human_verified').length;
  const partial = annotations.filter(a => a.status === 'human_partial').length;
  const rightsReady = m.pages.every(p => p.provenance.rights.status === 'authorized' && p.provenance.rights.allowedUses.includes('local_evaluation'));
  const holdout = m.pages.filter(p => p.split === 'holdout');
  const complete = m.pages.length > 0 && verified === m.pages.length && rightsReady && m.works.every(w => w.status === 'confirmed') && m.pages.every(p => p.split !== 'unassigned');
  const holdoutReady = holdout.length > 0 && holdout.every(p => annotationsByPage.get(p.pageId)?.status === 'human_verified') && frozen
    && duplicateCandidates.every(c => c.disposition !== 'needs_review');
  const blockingReasons = [];
  if (!rightsReady) blockingReasons.push('RIGHTS_NOT_CONFIRMED');
  if (m.works.some(w => w.status === 'unresolved')) blockingReasons.push('WORK_IDENTITY_NOT_CONFIRMED');
  if (!complete) blockingReasons.push('HUMAN_GROUND_TRUTH_INCOMPLETE');
  if (!holdout.length) blockingReasons.push('NO_UNUSED_HOLDOUT_WORK');
  if (!frozen) blockingReasons.push('FINAL_SPLIT_AND_CRITERIA_NOT_FROZEN');
  if (m.pages.some(p => p.split === 'unassigned')) blockingReasons.push('NEW_SOURCES_NOT_ASSIGNED_TO_EVALUATION_SPLITS');
  if (duplicateCandidates.some(c => c.disposition === 'needs_review')) blockingReasons.push('DUPLICATE_CANDIDATES_NEED_REVIEW');
  const tagCounts = Object.fromEntries(TAG_NAMES.map(tag => {
    const values = m.pages.map(p => p.tags[tag]);
    const count = (origin, value) => values.filter(t => t.origin === origin && t.value === value).length;
    const humanPresent = count('human', true);
    const verifiedFeaturePages = m.pages.filter(p => p.tags[tag].origin === 'human' && p.tags[tag].value === true && annotationsByPage.get(p.pageId)?.status === 'human_verified').length;
    return [tag, { humanPresent, humanAbsent: count('human', false), aiPresent: count('ai_candidate', true), aiAbsent: count('ai_candidate', false),
      unassessed: values.filter(t => t.value === null).length, verifiedFeaturePages, performanceEvaluable: verifiedFeaturePages > 0 }];
  }));
  return { states: { DATASET_PREPARED: true, HUMAN_GT_PARTIAL: verified + partial > 0 && !complete, HUMAN_GT_COMPLETE: complete,
    HOLDOUT_READY: holdoutReady, BLOCKED: !complete || !holdoutReady }, blockingReasons,
    counts: { pages: m.pages.length, confirmedWorks: m.works.filter(w => w.status === 'confirmed').length, actualWorkCount: m.works.some(w => w.status === 'unresolved') ? null : m.works.length,
      splits: Object.fromEntries(['dev','calibration','holdout','unassigned'].map(s => [s, m.pages.filter(p => p.split === s).length])), humanVerifiedPages: verified, humanPartialPages: partial,
      submittedProfessionalReferenceImages: m.pages.reduce((n,p) => n + (p.referenceTranslations ?? []).filter(r => r.provenance.kind === 'user_attested_professional_reference').length, 0) },
    tagCounts, duplicateCandidates, freezeValidated: frozen,
    limitations: ['Submission contracts and file pins do not authenticate real human activity.', 'Perceptual screening cannot prove absence of arbitrary cropped or edited duplicates.', 'No product inference or final evaluation executed.'] };
}

/** Compatibility view contains pending metadata only; richer GT needs a future explicit adapter. */
export function toStage02PendingCorpus(m, split) {
  requireValue(['dev','calibration'].includes(split), 'HOLDOUT_EXPORT_FORBIDDEN');
  return { schemaVersion: 1, datasetId: `${m.datasetId}-${split}-pending`, pages: m.pages.filter(p => p.split === split).map(p => ({ id: p.pageId,
    workId: p.workId, duplicateGroupId: p.duplicateGroupId, usedForDevelopment: p.usedForDevelopment, split: 'dev',
    source: { path: p.source.path, sha256: p.source.sha256 }, groundTruth: { status: 'pending' } })) };
}

async function pinnedAsset(pin, base, contained = false) {
  const file = path.resolve(base, pin.path);
  if (contained) {
    const real = await fs.realpath(file).catch(() => file), relative = path.relative(await fs.realpath(base), real);
    requireValue(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'ASSET_PATH_ESCAPE');
  }
  const bytes = await fs.readFile(file).catch(e => { throw Object.assign(new Error(`Missing pinned asset: ${pin.path}`), { code: 'ASSET_MISSING', cause: e.code }); });
  requireValue(sha(bytes) === pin.sha256, 'ASSET_HASH_MISMATCH', `Pinned bytes changed: ${pin.path}`);
  return bytes;
}
function evidencePins(value) {
  if (!value || typeof value !== 'object') return [];
  if (!Array.isArray(value) && Object.keys(value).length === 2 && typeof value.path === 'string' && typeof value.sha256 === 'string') return [value];
  return Object.values(value).flatMap(evidencePins);
}
export async function verifyDatasetFiles(manifestPath, { includeHoldout = false } = {}) {
  const base = path.dirname(path.resolve(manifestPath)), m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  shape(datasetShape, m, 'DATASET_SCHEMA_INVALID');
  const policy = JSON.parse(await pinnedAsset(m.criteria, base, true));
  // Refuse leakage and bad shape before opening annotation paths.
  validateDatasetCore(m, { policy, annotations: [] }, false);
  const annotations = [], omittedHoldoutPageIds = [], checkedFiles = new Set();
  for (const p of m.pages) {
    for (const i of [p.source, ...p.variants]) {
      const bytes = await pinnedAsset(i, base);
      const f = await fingerprintImage(bytes);
      requireValue(['sha256','width','height','format','pixelSha256','fingerprintVersion','perceptualHashes'].every(k => equal(f[k], i[k])), 'IMAGE_FINGERPRINT_MISMATCH');
      checkedFiles.add(path.resolve(base, i.path));
    }
    for (const reference of p.referenceTranslations ?? []) {
      const bytes = await pinnedAsset(reference.image, base), f = await fingerprintImage(bytes);
      requireValue(['sha256','width','height','format','pixelSha256','fingerprintVersion','perceptualHashes'].every(k => equal(f[k], reference.image[k])), 'IMAGE_FINGERPRINT_MISMATCH');
      await pinnedAsset(reference.provenance.evidence, base, true);
      if (reference.pairing.evidence) await pinnedAsset(reference.pairing.evidence, base, true);
      checkedFiles.add(path.resolve(base, reference.image.path));
    }
    if (p.split === 'holdout' && !includeHoldout) { omittedHoldoutPageIds.push(p.pageId); continue; }
    const a = JSON.parse(await pinnedAsset(p.annotation, base, true));
    validateAnnotation(a, p, m); annotations.push(a);
    checkedFiles.add(path.resolve(base, p.annotation.path));
    for (const pin of evidencePins(a)) { await pinnedAsset(pin, base, true); checkedFiles.add(path.resolve(base, pin.path)); }
  }
  for (const pin of [...m.works.flatMap(evidencePins), ...m.reviewers.flatMap(evidencePins), ...m.pages.flatMap(p => evidencePins({ provenance: p.provenance, pageOrder: p.pageOrder, bubbleCount: p.bubbleCount, tags: p.tags })), ...m.duplicateReviews.flatMap(evidencePins), ...evidencePins(m.freeze)]) {
    await pinnedAsset(pin, base, true); checkedFiles.add(path.resolve(base, pin.path));
  }
  return { ...validateDataset(m, { policy, annotations }), manifestSha256: sha(await fs.readFile(manifestPath)), criteriaSha256: m.criteria.sha256,
    checkedFiles: checkedFiles.size, omittedHoldoutPageIds, includeHoldout, humanAuthentication: 'NOT_PROVIDED_BY_VALIDATOR' };
}
