import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { validateCorpus, characterErrors } from '../../apps/desktop/scripts/evaluate-automation-quality.mjs';
import { pixelsToNormalized } from '../../packages/contracts/src/v2-common-contract.mjs';

// Dynamic import makes missing implementation an assertion failure in the RED cycle.
const api = await import('../../packages/evaluation/dataset-contract.mjs').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});
const images = await import('../../packages/evaluation/image-fingerprint.mjs').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});
const sha = text => createHash('sha256').update(text).digest('hex');
const pin = (name = 'submission.json') => ({ path: name, sha256: sha(name) });
const policy = { version: 'stage05-v1', normalization: 'NFKC_CODEPOINTS_KEEP_SPACE_PUNCTUATION', splitUnit: 'work',
  regionMatching: 'MAX_CARDINALITY_THEN_IOU', iouThreshold: 0.5, nearDuplicateHamming: 6,
  humanReview: 'TWO_INDEPENDENT_JA_KO_REVIEWERS', finalEvaluationExecuted: false };
const canonical = value => JSON.stringify(value, Object.keys(value).sort());
const tagNames = ['connected_bubbles', 'overlapping_bubbles', 'multiline_bubble', 'vertical_text', 'horizontal_text', 'furigana', 'small_text',
  'sfx', 'monologue', 'narration', 'outside_dialogue', 'complex_background', 'artwork_contact', 'long_korean', 'low_resolution',
  'blurred_source', 'speaker_disambiguation', 'work_terms', 'adjacent_context', 'unreadable_source'];
const assessed = value => ({ value, origin: value === null ? 'unassessed' : 'human', evidence: value === null ? null : pin('tags.json') });
function page(id = 'p1', split = 'dev', workId = 'work1') {
  return { pageId: id, workId, split, usedForDevelopment: split === 'dev', duplicateGroupId: `dup-${id}`,
    source: { path: `/synthetic/${id}.png`, sha256: sha(id), width: 100, height: 200, format: 'png', pixelSha256: sha(`pixels-${id}`),
      fingerprintVersion: 1, perceptualHashes: [sha(`dhash-${id}`).slice(0, 16)] }, variants: [],
    pageOrder: { value: null, status: 'unknown', evidence: null },
    provenance: { sourceEvidence: null, origin: 'synthetic_test_only', rights: { status: 'unknown', evidence: null, allowedUses: ['local_inventory'] } },
    bubbleCount: assessed(null), tags: Object.fromEntries(tagNames.map(n => [n, assessed(null)])),
    annotation: { path: `annotations/${split}/${id}.json`, sha256: sha(`annotation-${id}`), status: 'pending' } };
}
function manifest() {
  return { schemaVersion: 1, datasetId: 'synthetic-tests-only', datasetVersion: '0.1.0', commonContractVersion: 1,
    createdAt: '2026-11-12T08:00:00.000Z', criteria: { version: policy.version, path: 'criteria.json', sha256: sha(canonical(policy)) },
    works: [{ workId: 'work1', status: 'unresolved', title: null, identityEvidence: null, leakageGroupId: 'unknown-works' }],
    pages: [page()], reviewers: [], duplicateReviews: [], freeze: null,
    history: [{ version: '0.1.0', at: '2026-11-12T08:00:00.000Z', actor: 'synthetic-fixture', reason: 'Test only', previousManifestSha256: null }] };
}
function annotation(m = manifest()) {
  const p = m.pages[0];
  return { schemaVersion: 1, datasetId: m.datasetId, datasetVersion: m.datasetVersion, annotationVersion: '0.1.0',
    criteriaVersion: policy.version, pageId: p.pageId, workId: p.workId, sourceSha256: p.source.sha256, basisImageSha256: p.source.sha256,
    status: 'pending', statusReason: 'NO_HUMAN_ANNOTATION',
    provenance: { kind: 'unannotated', authorId: null, createdAt: m.createdAt, evidence: null, tool: 'synthetic-test' },
    frame: { frameId: 'original-px', imageId: 'source-image', kind: 'original_px', width: 100, height: 200, parentFrameId: null, toParent: null, crop: null },
    lines: [], regions: [], translations: [],
    imageQuality: { hiddenBackgroundTruth: { available: false, image: null, reason: 'NO_HIDDEN_BACKGROUND_REFERENCE' }, regions: [], minimumReadability: null, reason: 'NOT_ANNOTATED' },
    coverage: { regions: 'pending', ocr: 'pending', translation: 'pending', image: 'pending' }, reviews: [], disagreements: [] };
}
function checked(m = manifest(), annotations = []) { return api.validateDataset(m, { policy, annotations }); }
function fail(code, edit, base = manifest) {
  const m = base(); edit(m);
  assert.throws(() => checked(m), e => e.code === code, code);
}
function reviewedFixture() {
  const m = manifest();
  m.works[0] = { ...m.works[0], status: 'confirmed', title: 'SYNTHETIC ONLY', identityEvidence: pin('identity.json') };
  m.pages[0].provenance.rights = { status: 'authorized', evidence: pin('rights.json'), allowedUses: ['local_inventory', 'local_evaluation'] };
  m.reviewers = ['h1', 'h2'].map(reviewerId => ({ reviewerId, kind: 'human', languages: ['ja', 'ko'], independenceGroup: reviewerId, qualificationEvidence: pin(`${reviewerId}.json`) }));
  const a = annotation(m), geometry = { frameId: 'original-px', polygon: [[10, 10], [20, 10], [20, 50], [10, 50]] };
  a.provenance = { ...a.provenance, kind: 'human_authored', authorId: 'h1', evidence: pin('authored.json') };
  a.lines = [{ lineId: 'l1', geometry, transcription: { status: 'readable', text: 'あ', uncertainSpans: [], reason: null }, role: 'dialogue',
    readingDirection: 'vertical_rtl', readingOrder: { value: 1, status: 'verified', evidence: pin('order.json') }, speaker: { id: null, reason: 'UNIDENTIFIED_SPEAKER' },
    roiMapping: { regionIds: ['r1'], status: 'human', reason: null }, furiganaOf: null,
    ocrComparison: { status: 'not_measured', ocrArtifact: null, outputLineIds: [], missing: null, mergedWith: [], splitInto: [], differences: [] } }];
  a.regions = [{ regionId: 'r1', geometry, role: 'dialogue', sourceLineIds: ['l1'], readingDirection: 'vertical_rtl', relation: 'single', reason: null }];
  a.translations = [{ targetId: 't1', sourceLineIds: ['l1'], status: 'defined', reason: null,
    meaning: { core: 'SYNTHETIC INTERJECTION', acceptableKorean: ['아'], mustPreserve: ['감탄'], polarity: 'neutral', tenseAspect: 'not_applicable',
      utteranceType: 'exclamation', omittedSubject: 'not_applicable', speakerRelation: 'unknown', speechLevel: 'unknown', namesTerms: [], possibleInterpretations: [] }, errors: [] }];
  a.coverage = { regions: 'complete', ocr: 'complete', translation: 'complete', image: 'complete' };
  a.status = 'human_verified'; a.statusReason = null;
  const content = api.annotationContentSha256(a);
  a.reviews = m.reviewers.map(r => ({ reviewId: `review-${r.reviewerId}`, reviewerId: r.reviewerId, role: 'independent', independent: true, blinded: true,
    annotationContentSha256: content, reviewedAt: m.createdAt, outcome: 'approved', evidence: pin(`review-${r.reviewerId}.json`) }));
  m.pages[0].annotation.status = a.status;
  return { m, a };
}

test('dataset API exists before validating any prepared-state claim', () => assert.equal(typeof api.validateDataset, 'function'));
test('pending data is prepared but GT and holdout remain blocked, with unknown tags separate from zero', () => {
  const r = checked();
  assert.deepEqual(r.states, { DATASET_PREPARED: true, HUMAN_GT_PARTIAL: false, HUMAN_GT_COMPLETE: false, HOLDOUT_READY: false, BLOCKED: true });
  assert.equal(r.tagCounts.furigana.humanPresent, 0); assert.equal(r.tagCounts.furigana.unassessed, 1);
  assert.equal(r.tagCounts.furigana.performanceEvaluable, false);
});
test('rejects same work across development and calibration', () => fail('WORK_SPLIT_LEAKAGE', m => m.pages.push(page('p2', 'calibration'))));
test('unknown work identities cannot evade leakage by inventing page-specific work IDs', () => fail('WORK_SPLIT_LEAKAGE', m => {
  m.works.push({ ...m.works[0], workId: 'work2' }); m.pages.push(page('p2', 'calibration', 'work2'));
}));
test('rejects exact bytes duplicated across works and splits', () => fail('DUPLICATE_SPLIT_LEAKAGE', m => {
  m.works.push({ ...m.works[0], workId: 'work2', leakageGroupId: 'different' });
  m.pages.push({ ...page('p2', 'calibration', 'work2'), source: { ...page().source } });
}));
test('rejects reencoded identical pixels across splits', () => fail('DUPLICATE_SPLIT_LEAKAGE', m => {
  m.works.push({ ...m.works[0], workId: 'work2', leakageGroupId: 'different' });
  const b = page('p2', 'calibration', 'work2'); b.source.pixelSha256 = m.pages[0].source.pixelSha256; m.pages.push(b);
}));
test('rejects unadjudicated perceptual near duplicates across splits', () => fail('NEAR_DUPLICATE_SPLIT_LEAKAGE', m => {
  m.works.push({ ...m.works[0], workId: 'work2', leakageGroupId: 'different' });
  const b = page('p2', 'calibration', 'work2'); b.source.perceptualHashes = m.pages[0].source.perceptualHashes; m.pages.push(b);
}));
test('known development pages cannot be relabelled holdout', () => fail('HOLDOUT_ALREADY_USED', m => { m.pages[0].split = 'holdout'; m.pages[0].annotation.path = 'holdout/annotations/p1.json'; }));
test('holdout cannot claim an unresolved work identity', () => fail('UNCONFIRMED_EVALUATION_WORK', m => {
  m.pages[0].split = 'holdout'; m.pages[0].usedForDevelopment = false; m.pages[0].annotation.path = 'holdout/annotations/p1.json';
}));
test('duplicate and dangling page identities fail', () => {
  fail('DUPLICATE_ID', m => m.pages.push(structuredClone(m.pages[0])));
  fail('UNKNOWN_WORK', m => m.pages[0].workId = 'absent');
});
test('schema rejects missing tag, bad hash and ambiguous null without reason/evidence state', () => {
  fail('DATASET_SCHEMA_INVALID', m => delete m.pages[0].tags.furigana);
  fail('DATASET_SCHEMA_INVALID', m => m.pages[0].source.sha256 = 'filename-is-not-a-hash');
  fail('INVALID_ASSESSMENT', m => m.pages[0].tags.furigana.origin = 'human');
});
test('page order cannot be inferred by giving an unverified number', () => fail('UNVERIFIED_PAGE_ORDER', m => m.pages[0].pageOrder.value = 1));
test('AI tag opinions are not human tag prevalence', () => {
  const m = manifest(); m.pages[0].tags.furigana = { value: true, origin: 'ai_candidate', evidence: pin() };
  const r = checked(m); assert.equal(r.tagCounts.furigana.aiPresent, 1); assert.equal(r.tagCounts.furigana.humanPresent, 0);
});
test('pending annotation binds dataset, work, source and original image frame', () => {
  const m = manifest(); assert.equal(api.validateAnnotation(annotation(m), m.pages[0], m).status, 'pending');
  for (const edit of [a => a.sourceSha256 = sha('other'), a => a.workId = 'foreign', a => a.datasetVersion = 'old', a => a.frame.width = 101]) {
    const a = annotation(m); edit(a); assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'ANNOTATION_BINDING_MISMATCH');
  }
});
test('cannot manufacture human GT by changing one status flag', () => {
  const m = manifest(), a = annotation(m); a.status = 'human_verified';
  assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'HUMAN_REVIEW_REQUIRED');
});
test('AI reviewers cannot satisfy the human review requirement', () => {
  const { m, a } = reviewedFixture(); m.reviewers.forEach(r => r.kind = 'ai');
  assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'HUMAN_REVIEW_REQUIRED');
});
test('human approval requires independent bilingual reviewers, evidence and timestamp', () => {
  for (const edit of [m => m.reviewers[1].independenceGroup = 'h1', m => m.reviewers[1].languages = ['ko']]) {
    const { m, a } = reviewedFixture(); edit(m); assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'HUMAN_REVIEW_REQUIRED');
  }
  const { m, a } = reviewedFixture(); a.reviews[0].evidence = null;
  assert.throws(() => api.validateAnnotation(a, m.pages[0], m));
});
test('reviewed content changes invalidate the existing approval hashes', () => {
  const { m, a } = reviewedFixture(); a.lines[0].transcription.text = 'い';
  assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'STALE_HUMAN_REVIEW');
});
test('open disagreements prohibit verified GT even with two approvals', () => {
  const { m, a } = reviewedFixture(); a.disagreements.push({ disagreementId: 'd1', fieldPath: '/lines/0/transcription/text',
    reviewIds: a.reviews.map(r => r.reviewId), values: ['あ', 'い'], status: 'open', resolution: null });
  assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'UNRESOLVED_DISAGREEMENT');
});
test('qualifying synthetic human submissions are distinct from actual obtained GT', () => {
  const { m, a } = reviewedFixture(); assert.equal(api.validateAnnotation(a, m.pages[0], m).status, 'human_verified');
  const r = checked(m, [a]); assert.equal(r.states.HUMAN_GT_COMPLETE, true); assert.equal(r.states.HOLDOUT_READY, false);
});
test('line to ROI mapping cannot use dangling IDs or silently omit an actual line', () => {
  const { m, a } = reviewedFixture(); a.lines[0].roiMapping.regionIds = ['missing'];
  assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'INVALID_REGION_MAPPING');
});
test('coordinate frames never allow original and normalized dimensions to be mixed', () => {
  const { m, a } = reviewedFixture(); a.lines[0].geometry.frameId = 'normalized-px';
  assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'INVALID_GEOMETRY');
  a.lines[0].geometry.frameId = 'original-px'; a.lines[0].geometry.polygon[0][0] = 1000;
  assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'INVALID_GEOMETRY');
});
test('unreadable source cannot receive invented transcription or Korean meaning', () => {
  const { m, a } = reviewedFixture(); a.lines[0].transcription = { status: 'unreadable', text: null, uncertainSpans: [], reason: 'BLURRED' };
  assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'UNREADABLE_MEANING_INVENTED');
  a.lines[0].transcription.text = 'GUESS'; assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'INVALID_TRANSCRIPTION');
});
test('uncertain character spans cannot point beyond the supplied Unicode codepoints', () => {
  const { m, a } = reviewedFixture(); a.lines[0].transcription = { status: 'uncertain', text: 'あ', reason: 'PARTLY_BLURRED',
    uncertainSpans: [{ start: 0, end: 3, reason: 'BLURRED', alternatives: [] }] };
  assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'INVALID_TRANSCRIPTION');
});
test('hidden background pixels are not ground truth without an independent reference image', () => {
  const { m, a } = reviewedFixture(); a.imageQuality.hiddenBackgroundTruth.available = true;
  assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'BACKGROUND_REFERENCE_REQUIRED');
});
test('not measured OCR differences are null, not observed zero or success', () => {
  const { m, a } = reviewedFixture(); a.lines[0].ocrComparison.missing = false;
  assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'UNMEASURED_OCR_CLAIM');
});
test('freeze binds criteria, split, source and annotations and cannot be edited after final use', () => {
  const m = manifest(); m.freeze = { manifestContentSha256: '0'.repeat(64), criteriaSha256: m.criteria.sha256,
    annotationPins: [], frozenAt: m.createdAt, approvedBy: 'absent', evidence: pin('freeze.json'), finalRun: null };
  assert.throws(() => checked(m), e => e.code === 'INVALID_FREEZE');
});
test('holdout labels live outside automatic development annotations', () => fail('ANNOTATION_PATH_SPLIT_MISMATCH', m => m.pages[0].annotation.path = 'holdout/annotations/p1.json'));
test('Stage02 consumes a pending dev metadata view without invented Korean strings', () => {
  const c = api.toStage02PendingCorpus(manifest(), 'dev'); validateCorpus(c);
  assert.deepEqual(c.pages[0].groundTruth, { status: 'pending' }); assert.equal(c.pages[0].split, 'dev');
  assert.throws(() => api.toStage02PendingCorpus(manifest(), 'holdout'), e => e.code === 'HOLDOUT_EXPORT_FORBIDDEN');
  assert.deepEqual(characterErrors('Ａ あ。', 'A あ。'), { errors: 0, referenceCharacters: 4 });
  assert.deepEqual(pixelsToNormalized([10, 20], { width: 100, height: 200 }), [0.1, 0.1]);
});
test('normalized image fingerprints detect reencoding, rotation, mirror, resize and center crop candidates', async () => {
  assert.equal(typeof images.fingerprintImage, 'function');
  const raw = Buffer.alloc(100 * 140 * 3, 255);
  for (let y = 0; y < 140; y++) for (let x = 0; x < 100; x++) {
    const v = (x * 17 + y * 7 + (x > 30 && x < 70 ? 60 : 0)) % 256;
    raw.fill(v, (y * 100 + x) * 3, (y * 100 + x) * 3 + 3);
  }
  const png = await sharp(raw, { raw: { width: 100, height: 140, channels: 3 } }).png().toBuffer();
  const f = await images.fingerprintImage(png);
  for (const b of [await sharp(png).png({ compressionLevel: 0 }).toBuffer(), await sharp(png).rotate(90).png().toBuffer(),
    await sharp(png).flop().png().toBuffer(), await sharp(png).resize(200, 280).png().toBuffer(),
    await sharp(png).extract({ left: 12, top: 17, width: 75, height: 105 }).png().toBuffer()]) {
    const g = await images.fingerprintImage(b); assert.equal(images.duplicateRelation(f, g, 6).candidate, true);
  }
});
test('file verification fails on source or annotation tampering and missing pinned submissions', async () => {
  assert.equal(typeof api.verifyDatasetFiles, 'function');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stage05-dataset-'));
  try {
    const m = manifest(), a = annotation(m);
    const source = await sharp({ create: { width: 100, height: 200, channels: 3, background: '#fff' } }).png().toBuffer();
    const f = await images.fingerprintImage(source);
    m.pages[0].source = { ...m.pages[0].source, path: path.join(dir, 'source.png'), ...f };
    a.sourceSha256 = f.sha256; a.basisImageSha256 = f.sha256;
    await fs.writeFile(m.pages[0].source.path, source);
    await fs.mkdir(path.join(dir, 'annotations/dev'), { recursive: true });
    const ab = JSON.stringify(a); m.pages[0].annotation.sha256 = sha(ab);
    await fs.writeFile(path.join(dir, m.pages[0].annotation.path), ab);
    await fs.writeFile(path.join(dir, 'criteria.json'), canonical(policy));
    const mf = path.join(dir, 'manifest.json'); await fs.writeFile(mf, JSON.stringify(m));
    assert.equal((await api.verifyDatasetFiles(mf)).states.DATASET_PREPARED, true);
    await fs.appendFile(path.join(dir, m.pages[0].annotation.path), ' ');
    await assert.rejects(api.verifyDatasetFiles(mf), e => e.code === 'ASSET_HASH_MISMATCH');
    await fs.writeFile(path.join(dir, m.pages[0].annotation.path), ab);
    await fs.appendFile(m.pages[0].source.path, 'tamper');
    await assert.rejects(api.verifyDatasetFiles(mf), e => e.code === 'ASSET_HASH_MISMATCH');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('file verifier admits human-reviewed submissions only after loading their pinned evidence', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stage05-human-io-'));
  try {
    const { m, a } = reviewedFixture();
    const bytes = await sharp({ create: { width: 100, height: 200, channels: 3, background: '#eee' } }).png().toBuffer();
    const f = await images.fingerprintImage(bytes);
    m.pages[0].source = { path: path.join(dir, 'source.png'), ...f };
    a.sourceSha256 = f.sha256; a.basisImageSha256 = f.sha256;
    a.reviews.forEach(r => r.annotationContentSha256 = api.annotationContentSha256(a));
    const pins = v => v && typeof v === 'object' ? (v.path && v.sha256 && Object.keys(v).length === 2 ? [v] : Object.values(v).flatMap(pins)) : [];
    for (const evidence of [...pins(a), ...pins(m.works), ...pins(m.reviewers), ...pins(m.pages[0].provenance)]) await fs.writeFile(path.join(dir, evidence.path), evidence.path);
    await fs.writeFile(m.pages[0].source.path, bytes);
    await fs.mkdir(path.join(dir, 'annotations/dev'), { recursive: true });
    const ab = JSON.stringify(a); m.pages[0].annotation.sha256 = sha(ab);
    await fs.writeFile(path.join(dir, m.pages[0].annotation.path), ab);
    await fs.writeFile(path.join(dir, 'criteria.json'), canonical(policy));
    const mf = path.join(dir, 'manifest.json'); await fs.writeFile(mf, JSON.stringify(m));
    assert.equal((await api.verifyDatasetFiles(mf)).counts.humanVerifiedPages, 1);
    await fs.unlink(path.join(dir, 'review-h2.json'));
    await assert.rejects(api.verifyDatasetFiles(mf), e => e.code === 'ASSET_MISSING');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('default file validation never opens holdout annotation labels', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stage05-holdout-'));
  try {
    const m = manifest(), p = m.pages[0];
    m.works[0] = { ...m.works[0], status: 'confirmed', title: 'SYNTHETIC', identityEvidence: pin('identity.json') };
    p.provenance.rights = { status: 'authorized', evidence: pin('rights.json'), allowedUses: ['local_evaluation'] };
    p.split = 'holdout'; p.usedForDevelopment = false; p.annotation.path = 'holdout/annotations/p1.json';
    const source = await sharp({ create: { width: 100, height: 200, channels: 3, background: '#ddd' } }).png().toBuffer();
    p.source = { path: path.join(dir, 'source.png'), ...await images.fingerprintImage(source) };
    await fs.writeFile(p.source.path, source);
    for (const name of ['identity.json','rights.json']) await fs.writeFile(path.join(dir, name), name);
    await fs.writeFile(path.join(dir, 'criteria.json'), canonical(policy));
    const mf = path.join(dir, 'manifest.json'); await fs.writeFile(mf, JSON.stringify(m));
    const result = await api.verifyDatasetFiles(mf);
    assert.deepEqual(result.omittedHoldoutPageIds, ['p1']); assert.equal(result.states.HOLDOUT_READY, false);
    await assert.rejects(api.verifyDatasetFiles(mf, { includeHoldout: true }), e => e.code === 'ASSET_MISSING');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('new user-provided originals can remain unassigned without claiming holdout or development exposure', () => {
  const m = manifest(), p = page('new-unassigned', 'unassigned', 'new-unknown');
  p.usedForDevelopment = null;
  m.works.push({ ...m.works[0], workId: 'new-unknown' }); m.pages.push(p);
  const r = checked(m);
  assert.equal(r.counts.splits.unassigned, 1); assert.equal(r.states.HOLDOUT_READY, false);
  assert.equal(api.toStage02PendingCorpus(m, 'dev').pages.length, 1);
});
test('expert reference images submitted by a user are not automatically verified human GT', () => {
  const m = manifest(); m.pages[0].referenceTranslations = [{ image: { ...m.pages[0].source, path: '/synthetic/expert.png', sha256: sha('expert') },
    provenance: { kind: 'user_attested_professional_reference', evidence: pin('user-declaration.json'), reviewerId: null, reviewedAt: null },
    pairing: { status: 'candidate_filename', evidence: null, reason: 'Number labels need source/reference verification' } }];
  assert.equal(checked(m).states.HUMAN_GT_COMPLETE, false);
});

test('approved disagreement history cannot be deleted while retaining the old human approval', () => {
  const { m, a } = reviewedFixture();
  a.disagreements = [{ disagreementId: 'd1', fieldPath: '/translations/0/meaning/core', reviewIds: a.reviews.map(r => r.reviewId), values: ['A', 'B'],
    status: 'resolved', resolution: { reviewerId: 'h1', at: m.createdAt, reason: 'SYNTHETIC_ADJUDICATION', evidence: pin('adjudication.json') } }];
  a.reviews.forEach(r => r.annotationContentSha256 = api.annotationContentSha256(a));
  assert.equal(api.validateAnnotation(a, m.pages[0], m).status, 'human_verified');
  a.disagreements = [];
  assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'STALE_HUMAN_REVIEW');
});
test('uncertain segments preserve an unreadable gap without inventing character offsets or meaning', () => {
  const { m, a } = reviewedFixture(); a.status = 'human_partial'; a.statusReason = 'UNCERTAIN_SOURCE';
  a.lines[0].transcription = { status: 'uncertain', text: null, uncertainSpans: [], reason: 'MIDDLE_LENGTH_UNKNOWN', segments: [
    { segmentId: 's1', kind: 'readable', text: 'あ', length: 1, reason: null },
    { segmentId: 's2', kind: 'unreadable', text: null, length: null, reason: 'BLURRED_LENGTH_UNKNOWN' },
    { segmentId: 's3', kind: 'readable', text: 'い', length: 1, reason: null }] };
  a.translations[0] = { ...a.translations[0], status: 'uncertain', meaning: null, reason: 'SOURCE_INCOMPLETE' };
  a.reviews.forEach(r => r.annotationContentSha256 = api.annotationContentSha256(a));
  assert.equal(api.validateAnnotation(a, m.pages[0], m).status, 'human_partial');
  a.translations[0].status = 'defined'; a.translations[0].meaning = reviewedFixture().a.translations[0].meaning;
  assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'UNREADABLE_MEANING_INVENTED');
});
test('sound effects require an explicit preservation or translation intent in verified labels', () => {
  const { m, a } = reviewedFixture(); a.lines[0].role = 'sfx'; a.translations = [];
  assert.throws(() => api.validateAnnotation(a, m.pages[0], m), e => e.code === 'SFX_DISPOSITION_REQUIRED');
  a.lines[0].processingIntent = { action: 'preserve', reason: 'INTENTIONAL_SOURCE_SFX', evidence: pin('sfx-policy.json') };
  a.reviews.forEach(r => r.annotationContentSha256 = api.annotationContentSha256(a));
  assert.equal(api.validateAnnotation(a, m.pages[0], m).status, 'human_verified');
});
test('a valid frozen synthetic holdout loses readiness after a split or criterion pin change', () => {
  const { m, a } = reviewedFixture(), p = m.pages[0];
  p.split = 'holdout'; p.usedForDevelopment = false; p.annotation.path = 'holdout/annotations/p1.json';
  m.freeze = { manifestContentSha256: api.manifestContentSha256(m), criteriaSha256: m.criteria.sha256, annotationPins: [{ pageId: p.pageId, sha256: p.annotation.sha256 }],
    frozenAt: m.createdAt, approvedBy: 'h2', evidence: pin('freeze.json'), finalRun: null };
  assert.equal(checked(m, [a]).states.HOLDOUT_READY, true);
  m.criteria.sha256 = sha('changed criteria');
  assert.throws(() => checked(m, [a]), e => e.code === 'INVALID_FREEZE');
});

test('a tag is not evaluable when only an unreviewed page has the feature', () => {
  const { m, a } = reviewedFixture(), p = page('p2');
  p.tags.furigana = assessed(true); m.pages.push(p);
  const r = checked(m, [a]);
  assert.equal(r.tagCounts.furigana.humanPresent, 1);
  assert.equal(r.tagCounts.furigana.performanceEvaluable, false);
});
