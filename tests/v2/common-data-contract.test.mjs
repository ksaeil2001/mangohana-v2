import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCommonContract, readContractAttachment, unknownQuality, qualityFlags,
  qualityFromStage02, transformPoint, normalizedToPixels, pixelsToNormalized,
  decodeMaskPixels, assertMasksDisjoint, assertCommitAllowed, resolveTranslationText, computeContextSnapshotSha256,
} from '../../packages/contracts/src/v2-common-contract.mjs';

const sha = n => n.repeat(64);
const measure = (value = null, unit = 'ratio') => ({ value, unit, reason: value === null ? 'NOT_REPORTED' : null });
const model = { id: 'synthetic-detector', revision: 'fixture-v1', weightsSha256: null, configSha256: null };
const polygon = [[10, 10], [30, 10], [30, 50], [10, 50]];
const scope = { kind: 'owner', id: 'synthetic-owner' };
const userValue = value => ({ value, editRevision: 2 });
const geometry = (frameId = 'page-px') => ({ frameId, polygon: structuredClone(polygon) });
const artifact = (artifactId, kind, hash, parents = []) => ({
  artifactId, kind, sha256: hash, frameId: 'page-px', version: 'fixture-v1', producerStage: 'synthetic',
  parentArtifactIds: parents, sourceLineIds: ['line-1'], materialization: 'materialized',
  unmeasuredReason: null, maskSemantics: null,
});

function fixture() {
  const a = [artifact('original', 'uploaded_original', sha('a')), artifact('normalized', 'normalized', sha('b'), ['original']),
    artifact('raw', 'raw_ocr', sha('c'), ['normalized']), artifact('glyphs', 'source_text_regions', sha('d'), ['raw']),
    artifact('remove', 'removal_mask', sha('e'), ['glyphs']), artifact('protect', 'protection_mask', sha('f'), ['glyphs']),
    artifact('pre', 'pre_lama', sha('1'), ['normalized', 'remove', 'protect']),
    artifact('restored', 'restored_image', sha('2'), ['pre']), artifact('overlay', 'korean_overlay', sha('3'), ['raw']),
    artifact('final', 'final_png', sha('4'), ['restored', 'overlay']), artifact('trio', 'trio_project', sha('5'), ['final'])];
  a.find(x => x.artifactId === 'remove').maskSemantics = 'studio_inverse_alpha';
  a.find(x => x.artifactId === 'protect').maskSemantics = 'binary255_active_protect';
  a.find(x => x.artifactId === 'original').frameId = 'original-px';
  return {
    contractVersion: 1,
    identity: { ownerScope: structuredClone(scope), projectId: 'project-1', workId: 'work-1', pageId: 'page-1', jobId: 'job-1',
      sourceRevision: 1, editRevision: 2, contextRevision: 3, processingGeneration: 4, storageRevision: 5 },
    images: [
      { imageId: 'original-image', kind: 'uploaded_original', artifactId: 'original', sha256: sha('a'), width: 100, height: 200, exifOrientation: null, rotationDegrees: null },
      { imageId: 'normalized-image', kind: 'normalized', artifactId: 'normalized', sha256: sha('b'), width: 100, height: 200, exifOrientation: null, rotationDegrees: null },
    ],
    frames: [
      { frameId: 'original-px', kind: 'original_px', imageId: 'original-image', width: 100, height: 200, parentFrameId: null, toParent: null, crop: null },
      { frameId: 'page-px', kind: 'normalized_px', imageId: 'normalized-image', width: 100, height: 200, parentFrameId: 'original-px', toParent: [1, 0, 0, 1, 0, 0], crop: null },
    ],
    observations: [{ lineId: 'line-1', kind: 'source_detection', ...geometry(), quad: structuredClone(polygon), rawText: 'SYNTHETIC_RAW',
      normalizedText: 'SYNTHETIC_NORMALIZED', uncertainty: 'unknown', detectionConfidence: measure(.95), recognitionConfidence: measure(), model, originArtifactId: 'raw' }],
    groups: [{ groupId: 'group-1', sourceLineIds: ['line-1'], orientation: 'vertical', readingOrder: 1, speakerId: null }],
    regions: [{ regionId: 'region-1', ...geometry(), classification: 'dialogue', confidence: measure(.9) }],
    mappings: [{ sourceLineId: 'line-1', groupId: 'group-1', regionIds: ['region-1'], redetectedLineIds: [], disposition: 'translate', reason: 'EXPLICIT_DIALOGUE', targetId: 'target-1' }],
    refinements: [],
    targets: [{ targetId: 'target-1', sourceLineIds: ['line-1'], regionIds: ['region-1'], contextSnapshotId: null, contextSnapshotSha256: null,
      text: { rawOcr: 'SYNTHETIC_RAW', normalizedOcr: 'SYNTHETIC_NORMALIZED', aiSourceInterpretation: null,
        aiCandidates: [{ id: 'candidate-1', text: 'AI_CANDIDATE' }], userModified: null, userConfirmed: null } }],
    translations: [{ requestId: 'request-1', scope: 'line', targetIds: ['target-1'], sourceLineIds: ['line-1'],
      contextSnapshotId: null, contextSnapshotSha256: null, inputSha256: sha('6'), outputSha256: sha('7'), status: 'proposed' }],
    typesetting: [{ typesetId: 'typeset-1', targetId: 'target-1', requestId: 'request-1', sourceLineIds: ['line-1'],
      ...geometry(), fontVersion: 'synthetic-font-v1', overlayArtifactId: 'overlay' }],
    context: null, artifacts: a, quality: unknownQuality(), executionEvidence: [], receipt: null,
  };
}

function sealed() {
  const f = fixture();
  f.quality.execution = 'succeeded';
  f.receipt = { receiptId: 'receipt-1', jobId: f.identity.jobId, identity: structuredClone(f.identity), manifestSha256: sha('8'), complete: true,
    artifactHashes: f.artifacts.map(a => ({ artifactId: a.artifactId, sha256: a.sha256 })) };
  return f;
}
function commitArgs() {
  const candidate = sealed();
  return { candidate, ticket: { identity: structuredClone(candidate.identity), sourceSha256: sha('a'), normalizedSha256: sha('b'), contextSnapshotSha256: null },
    current: { identity: structuredClone(candidate.identity), sourceSha256: sha('a'), normalizedSha256: sha('b'), execution: 'running',
      cancelled: false, protectedTranslations: [], finalArtifactSha256: sha('9'), contextSnapshotSha256: null } };
}
function bindContext(f) {
  f.context.sha256 = computeContextSnapshotSha256(f.context);
  f.targets[0].contextSnapshotSha256 = f.context.sha256; f.translations[0].contextSnapshotSha256 = f.context.sha256;
  return f;
}
function contextFixture() {
  const f = fixture();
  f.context = { snapshotId: 'snapshot-1', sha256: sha('8'), sourceSnapshotSha256: sha('a'), digestVersion: 'sha256-canonical-v1', revision: 3, ownerScope: structuredClone(scope), projectId: 'project-1', workId: 'work-1',
    pageId: 'page-1', pageOrdinal: 2, terms: [{ id: 'term-1', source: 'SYNTHETIC', target: 'FIXTURE', status: 'user_confirmed', revision: 3, kind: 'term' }],
    previousPages: [{ pageId: 'previous-page', pageOrdinal: 1, ownerScope: structuredClone(scope), projectId: 'project-1', workId: 'work-1',
      sourceSha256: sha('9'), revision: 1, status: 'ai_proposed' }], enginePath: 'gemma_line_default', consumption: 'not_consumed', consumedRequestIds: [] };
  f.targets[0].contextSnapshotId = 'snapshot-1'; f.translations[0].contextSnapshotId = 'snapshot-1';
  return bindContext(f);
}
const invalid = f => assert.throws(() => validateCommonContract(f), { code: 'COMMON_CONTRACT_INVALID' });

test('complete synthetic lineage roundtrips without changing original observations or user data', () => {
  const f = fixture(), before = structuredClone(f); validateCommonContract(f);
  validateCommonContract(JSON.parse(JSON.stringify(f))); assert.deepEqual(f, before);
});
test('legacy workspace/TRIO/report data remain opaque and unreviewed without inventing fields', () => {
  for (const legacy of [{ version: 1, projects: [{ id: 'old', custom: true }] }, { version: 1, format: 'TRIO', reviewed: true }, { version: 1, quality: 'PASS' }]) {
    const before = structuredClone(legacy), read = readContractAttachment(legacy);
    assert.equal(read.contract, null); assert.deepEqual(read.legacy, before); assert.deepEqual(legacy, before);
    assert.equal(read.quality.execution, 'unknown'); assert.equal(read.quality.humanReview.status, 'not_measured');
  }
});
test('an explicit invalid or unknown contract cannot silently fall back to legacy', () => {
  for (const commonDataContract of [{ contractVersion: 2 }, { contractVersion: 1 }, null]) {
    assert.throws(() => readContractAttachment({ version: 1, commonDataContract }), { code: 'COMMON_CONTRACT_INVALID' });
  }
});
test('schema rejects missing, nonfinite, unknown fields, ambiguous null reasons and negative costs', () => {
  for (const mutate of [f => delete f.identity.pageId, f => f.images[0].width = NaN,
    f => f.identity.browserAuthority = '/tmp/arbitrary', f => f.observations[0].recognitionConfidence.reason = null,
    f => f.observations[0].detectionConfidence.value = 2]) { const f = fixture(); mutate(f); invalid(f); }
});
test('duplicate IDs, dangling references and image/artifact hash substitutions are rejected', () => {
  for (const mutate of [f => f.observations.push(structuredClone(f.observations[0])), f => f.groups[0].sourceLineIds = ['foreign'],
    f => f.artifacts[0].sha256 = sha('9'), f => f.targets[0].regionIds = ['foreign'], f => f.artifacts[2].parentArtifactIds = ['foreign']]) {
    const f = fixture(); mutate(f); invalid(f);
  }
});
test('source detection must be normalized-page geometry, never relabeled crop-local evidence', () => {
  const f = fixture(); f.observations[0].frameId = 'original-px'; invalid(f);
});
test('unassigned and multiply assigned source lines cannot disappear between OCR and translation', () => {
  for (const mutate of [f => f.mappings = [], f => f.mappings.push(structuredClone(f.mappings[0])),
    f => f.targets[0].sourceLineIds = [], f => f.translations[0].sourceLineIds = []]) { const f = fixture(); mutate(f); invalid(f); }
});
test('unknown classification is review, never an automatic SFX/preserve decision', () => {
  const f = fixture(); f.regions[0].classification = 'unknown'; f.mappings[0].disposition = 'preserve';
  f.mappings[0].targetId = null; f.targets = []; f.translations = []; f.typesetting = []; invalid(f);
  f.mappings[0].disposition = 'needs_review';
  f.artifacts = f.artifacts.filter(a => ['uploaded_original', 'normalized', 'raw_ocr', 'source_text_regions', 'protection_mask'].includes(a.kind));
  validateCommonContract(f);
});
test('multiple ROI and multiple line membership remain representable without group bbox filtering', () => {
  const f = fixture(); f.regions.push({ ...structuredClone(f.regions[0]), regionId: 'region-2' });
  f.mappings[0].regionIds.push('region-2'); f.targets[0].regionIds.push('region-2'); validateCommonContract(f);
  const line = structuredClone(f.observations[0]); line.lineId = 'line-2'; f.observations.push(line);
  f.groups[0].sourceLineIds.push('line-2'); f.mappings.push({ ...structuredClone(f.mappings[0]), sourceLineId: 'line-2' });
  for (const item of [f.targets[0], f.translations[0], f.typesetting[0]]) item.sourceLineIds.push('line-2'); validateCommonContract(f);
});
test('new detections remain independent from source quads and missing refinement cannot be accepted', () => {
  const f = fixture();
  f.frames.push({ frameId: 'crop-1', kind: 'crop_px', imageId: 'normalized-image', width: 50, height: 80,
    parentFrameId: 'page-px', toParent: [1, 0, 0, 1, 5, 10], crop: { originX: 5, originY: 10, actualWidth: 50, actualHeight: 80,
      scaleX: 1, scaleY: 1, padding: { left: 0, top: 0, right: 0, bottom: 0 }, tileOffset: { x: 0, y: 0 } } });
  f.artifacts.push(artifact('crop-raw', 'crop_ocr', sha('0'), ['raw'])); f.artifacts.at(-1).frameId = 'crop-1';
  f.observations.push({ ...structuredClone(f.observations[0]), lineId: 'new-line-1', kind: 'redetection', frameId: 'crop-1', originArtifactId: 'crop-raw' });
  f.mappings[0].redetectedLineIds = ['new-line-1'];
  f.refinements = [{ refinementId: 'refine-1', parentGroupId: 'group-1', regionIds: ['region-1'], sourceLineIds: ['line-1'],
    redetectedLineIds: ['new-line-1'], cropFrameId: 'crop-1', rawArtifactId: 'crop-raw', outcome: 'needs_review',
    coverageBySourceLine: [{ lineId: 'line-1', ratio: measure(.6735804554807929) }], missingSourceLineIds: ['line-1'], characterPreservation: 'not_measured' }];
  validateCommonContract(f); const original = structuredClone(f.observations[0]);
  f.refinements[0].outcome = 'accepted'; invalid(f); assert.deepEqual(f.observations[0], original);
  f.refinements[0].outcome = 'rejected'; validateCommonContract(f);
});
test('normalized and pixel conversions roundtrip across page dimensions', () => {
  for (const width of [1, 83, 1024]) for (const height of [1, 367, 2048]) for (const x of [0, .125, 1]) for (const y of [0, .5, 1]) {
    assert.deepEqual(pixelsToNormalized(normalizedToPixels([x, y], { width, height }), { width, height }), [x, y]);
  }
  assert.throws(() => normalizedToPixels([1.01, .5], { width: 10, height: 10 }));
});
test('crop-local to parent affine uses scale, padding and tile offset without rewriting evidence', () => {
  const matrix = [.5, 0, 0, .5, 104, 208];
  assert.deepEqual(transformPoint([2, 4], matrix), [105, 210]);
  assert.deepEqual(transformPoint([10, 20], [0, 1, -1, 0, 100, 0]), [80, 10]);
  assert.throws(() => transformPoint([1, 1], null)); assert.throws(() => transformPoint([1, 1], [0, 0, 0, 0, 0, 0]));
});
test('invalid polygon, cycles, singular and inconsistent crop transforms are rejected', () => {
  for (const mutate of [f => f.observations[0].polygon[0][0] = -1,
    f => f.observations[0].quad = [[1, 1], [1, 1], [1, 1], [1, 1]],
    f => f.frames[0].parentFrameId = 'page-px', f => f.frames[1].toParent = [0, 0, 0, 0, 0, 0]]) {
    const f = fixture(); mutate(f); invalid(f);
  }
});
test('studio alpha zero removes; worker luminance requires opaque nonzero pixels; protection stays separate', () => {
  const studio = new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255]);
  assert.deepEqual([...decodeMaskPixels({ kind: 'removal', encoding: 'studio_inverse_alpha', pixels: studio, width: 2, height: 1 })], [1, 0]);
  const worker = new Uint8Array([255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255]);
  assert.deepEqual([...decodeMaskPixels({ kind: 'removal', encoding: 'worker_luminance_alpha', pixels: worker, width: 3, height: 1 })], [0, 0, 1]);
  const protection = decodeMaskPixels({ kind: 'protection', encoding: 'binary255_active_protect', pixels: new Uint8Array([0, 255]), width: 2, height: 1 });
  assertMasksDisjoint(new Uint8Array([1, 0]), protection);
  assert.throws(() => assertMasksDisjoint(new Uint8Array([0, 1]), protection), { code: 'COMMON_CONTRACT_INVALID' });
});
test('binary encodings reject ambiguous values, wrong role and dimensions', () => {
  for (const args of [
    { kind: 'removal', encoding: 'binary01_active_remove', pixels: new Uint8Array([255]), width: 1, height: 1 },
    { kind: 'protection', encoding: 'studio_inverse_alpha', pixels: new Uint8Array([255, 255, 255, 0]), width: 1, height: 1 },
    { kind: 'removal', encoding: 'studio_inverse_alpha', pixels: new Uint8Array([255, 255, 255, 128]), width: 1, height: 1 },
    { kind: 'removal', encoding: 'binary255_active_remove', pixels: new Uint8Array([0]), width: 2, height: 1 },
  ]) assert.throws(() => decodeMaskPixels(args), { code: 'COMMON_CONTRACT_INVALID' });
});
test('artifact roles cannot silently invert remove/protect semantics and parents must be acyclic', () => {
  for (const mutate of [f => f.artifacts.find(a => a.kind === 'protection_mask').maskSemantics = 'studio_inverse_alpha',
    f => f.artifacts[0].parentArtifactIds = ['final'], f => f.typesetting[0].overlayArtifactId = 'remove']) {
    const f = fixture(); mutate(f); invalid(f);
  }
});
test('PNG and rule success keep semantic/image/human/approval/delivery unmeasured', () => {
  const f = sealed(); validateCommonContract(f);
  assert.deepEqual(qualityFlags(f.quality), ['RUN_SUCCEEDED', 'NEEDS_REVIEW']);
  f.quality.delivery = 'ready'; invalid(f);
});
test('reviewed flags include failed reviews and do not imply approval', () => {
  const q = unknownQuality(); q.semanticReview = { status: 'failed', actor: 'ai', evidenceId: 'review-1', subjectArtifactId: 'final' };
  assert.ok(qualityFlags(q).includes('SEMANTIC_REVIEWED')); assert.ok(qualityFlags(q).includes('NEEDS_REVIEW'));
});
test('delivery requires separate evidence dimensions bound to the current final artifact', () => {
  const f = sealed();
  for (const axis of ['ruleQa', 'ocrValidation', 'semanticReview', 'imageReview', 'humanReview', 'userApproval'])
    f.quality[axis] = { status: 'passed', actor: ['humanReview', 'userApproval'].includes(axis) ? 'human' : axis.endsWith('Review') ? 'ai' : 'rule', evidenceId: axis, subjectArtifactId: 'final', subjectSha256: sha('4'), identity: structuredClone(f.identity) };
  f.quality.delivery = 'ready'; validateCommonContract(f); assert.ok(qualityFlags(f.quality).includes('DELIVERABLE_READY'));
  f.quality.humanReview.actor = 'ai'; invalid(f); f.quality.humanReview.actor = 'human';
  f.quality.imageReview.subjectArtifactId = 'normalized'; invalid(f);
});
test('Stage02 PASS/zero/empty denominator and execution evidence retain their original meaning', () => {
  const old = { processingStatus: 'COMPLETED', qualityReviewStatus: 'PASS', executionVerification: 'UNVERIFIED',
    ocrMeasurement: 'MEASURED', precision: null, recall: 0, denominator: 0, unmeasuredReasons: ['NO_PREDICTED_REGIONS'] };
  const result = qualityFromStage02(old); assert.deepEqual(result.stage02, old);
  assert.equal(result.quality.execution, 'succeeded'); assert.equal(result.quality.semanticReview.status, 'not_measured');
  assert.equal(result.quality.humanReview.status, 'not_measured'); assert.equal(result.quality.delivery, 'unknown');
  assert.equal(qualityFromStage02({ ...old, processingStatus: 'NOT_RUN' }).quality.execution, 'not_run');
});
test('foreign owner/work/project, future or same-page context cannot be consumed', () => {
  validateCommonContract(contextFixture());
  for (const mutate of [f => f.context.ownerScope.id = 'foreign', f => f.context.workId = 'foreign',
    f => f.context.projectId = 'foreign', f => f.context.previousPages[0].pageOrdinal = 3,
    f => f.context.previousPages[0].pageId = 'page-1', f => f.context.previousPages[0].ownerScope.id = 'foreign',
    f => f.context.revision = 2, f => f.context.consumedRequestIds = ['foreign']]) { const f = contextFixture(); mutate(f); invalid(f); }
});
test('default Gemma line context is not upgraded to saved-context consumption', () => {
  const f = contextFixture(); f.context.consumption = 'consumed'; f.context.consumedRequestIds = ['request-1']; invalid(f);
  f.context.enginePath = 'experimental_page'; f.translations[0].scope = 'page'; validateCommonContract(bindContext(f));
});
test('confirmed and modified translations outrank AI without overwriting raw OCR', () => {
  const target = fixture().targets[0], raw = target.text.rawOcr;
  target.text.userModified = userValue('USER_EDIT'); target.text.userConfirmed = userValue('USER_CONFIRMED');
  assert.equal(resolveTranslationText(target), 'USER_CONFIRMED'); target.text.userConfirmed = null;
  assert.equal(resolveTranslationText(target), 'USER_EDIT'); target.text.userModified = null;
  assert.equal(resolveTranslationText(target), 'AI_CANDIDATE'); assert.equal(target.text.rawOcr, raw);
});
test('execution evidence keeps observed zero apart from missing and cannot switch job/accounting domain', () => {
  const f = fixture();
  f.executionEvidence = [{ stepId: 'step-1', jobId: 'job-1', stage: 'translation', model, adapterVersion: null, promptVersion: null,
    fontVersion: null, evaluatorVersion: null, datasetVersion: null, inputArtifactIds: ['raw'], outputArtifactIds: ['overlay'],
    measurements: { calls: measure(0, 'count'), cost: measure(null, 'USD'), peakRam: measure(null, 'bytes') } }];
  validateCommonContract(f); assert.equal(f.executionEvidence[0].measurements.calls.value, 0);
  for (const mutate of [f => f.executionEvidence[0].jobId = 'foreign', f => f.executionEvidence[0].measurements.cost.value = -1,
    f => f.executionEvidence[0].measurements.calls.reason = 'NOT_REPORTED', f => f.executionEvidence[0].measurements.codexTokens = measure(0, 'tokens')]) {
    const copy = structuredClone(f); mutate(copy); invalid(copy);
  }
});
test('atomic admission accepts complete matching results without mutating the previous PNG', () => {
  const args = commitArgs(), before = structuredClone(args); assertCommitAllowed(args); assert.deepEqual(args, before);
});
test('late source/edit/context/storage/generation and foreign identity fail before any publish', () => {
  for (const key of ['sourceRevision', 'editRevision', 'contextRevision', 'processingGeneration', 'storageRevision', 'pageId', 'projectId', 'workId', 'jobId']) {
    const args = commitArgs(), before = structuredClone(args.current);
    args.ticket.identity[key] = typeof args.ticket.identity[key] === 'number' ? args.ticket.identity[key] + 1 : 'foreign';
    assert.throws(() => assertCommitAllowed(args), { code: 'COMMON_CONTRACT_STALE' }); assert.deepEqual(args.current, before);
  }
  const args = commitArgs(); args.ticket.identity.ownerScope.id = 'foreign';
  assert.throws(() => assertCommitAllowed(args), { code: 'COMMON_CONTRACT_STALE' });
});
test('cancelled, terminal, partial, missing receipt, incomplete output and tampered hash never commit', () => {
  for (const mutate of [a => a.current.cancelled = true, a => a.current.execution = 'interrupted', a => a.current.execution = 'succeeded',
    a => a.candidate.quality.execution = 'partial_failed', a => a.candidate.receipt = null, a => a.candidate.receipt.complete = false,
    a => a.candidate.artifacts.find(x => x.kind === 'final_png').sha256 = sha('9'), a => a.ticket.normalizedSha256 = sha('0')]) {
    const args = commitArgs(); mutate(args); const before = structuredClone(args.current);
    assert.throws(() => assertCommitAllowed(args)); assert.deepEqual(args.current, before);
  }
});
test('unknown work/revision and replacement of a user-owned value cannot commit', () => {
  const args = commitArgs(); args.current.protectedTranslations = [{ targetId: 'target-1', userModified: userValue('PRESERVE_ME'), userConfirmed: null }];
  assert.throws(() => assertCommitAllowed(args), { code: 'COMMON_CONTRACT_STALE' });
  args.candidate.targets[0].text.userModified = userValue('PRESERVE_ME'); assertCommitAllowed(args);
  for (const key of ['workId', 'sourceRevision', 'editRevision', 'contextRevision', 'storageRevision', 'processingGeneration']) {
    const a = commitArgs(); a.current.identity[key] = null; a.ticket.identity[key] = null; a.candidate.identity[key] = null;
    a.candidate.receipt.identity[key] = null; assert.throws(() => assertCommitAllowed(a));
  }
});
test('a later user edit supersedes a historical confirmation while preserving both values', () => {
  const target = fixture().targets[0];
  target.text.userConfirmed = { value: 'HISTORICAL_CONFIRMATION', editRevision: 1 };
  target.text.userModified = { value: 'LATEST_USER_EDIT', editRevision: 2 };
  assert.equal(resolveTranslationText(target), 'LATEST_USER_EDIT');
  assert.equal(target.text.userConfirmed.value, 'HISTORICAL_CONFIRMATION');
});
test('removal and overlay may not cite preserved/review lines as text to erase or typeset', () => {
  const f = fixture(); f.mappings[0].disposition = 'preserve'; f.mappings[0].targetId = null;
  f.targets = []; f.translations = []; f.typesetting = []; invalid(f);
});
test('failed/unpinned translations and missing layouts cannot form a complete result', () => {
  for (const mutate of [a => a.candidate.translations[0].status = 'failed', a => a.candidate.translations[0].outputSha256 = null,
    a => a.candidate.typesetting = [], a => a.candidate.translations = []]) {
    const a = commitArgs(); mutate(a); assert.throws(() => assertCommitAllowed(a));
  }
});
test('final outputs cannot discard restoration/overlay provenance', () => {
  const f = fixture(); f.artifacts.find(a => a.kind === 'final_png').parentArtifactIds = []; invalid(f);
});
test('redetection must bind its own crop artifact/frame and a recorded refinement', () => {
  const f = fixture(); const observation = structuredClone(f.observations[0]);
  observation.lineId = 'local-1'; observation.kind = 'redetection'; f.observations.push(observation); invalid(f);
});
test('AI terminology is never declared consumed as confirmed terminology', () => {
  const f = contextFixture(); f.context.terms[0].status = 'ai_proposed';
  f.context.consumedConfirmedTermIds = ['term-1']; invalid(f);
  f.context.terms[0].status = 'user_confirmed'; f.context.consumption = 'consumed';
  f.context.enginePath = 'experimental_page'; f.context.consumedRequestIds = ['request-1']; f.translations[0].scope = 'page';
  validateCommonContract(bindContext(f));
});
test('unchanged snapshot IDs and hashes cannot approve modified terms or prior-page context', () => {
  for (const mutate of [f => f.context.terms[0].target = 'TAMPERED_TERM', f => f.context.previousPages[0].status = 'user_confirmed']) {
    const f = contextFixture(); mutate(f); invalid(f);
  }
});
test('reviews of a previous PNG cannot approve replacement bytes with the same artifact ID', () => {
  const f = sealed();
  for (const axis of ['ruleQa', 'ocrValidation', 'semanticReview', 'imageReview', 'humanReview', 'userApproval'])
    f.quality[axis] = { status: 'passed', actor: ['humanReview', 'userApproval'].includes(axis) ? 'human' : axis.endsWith('Review') ? 'ai' : 'rule', evidenceId: axis, subjectArtifactId: 'final', subjectSha256: sha('4'), identity: structuredClone(f.identity) };
  f.quality.delivery = 'ready'; validateCommonContract(f);
  f.artifacts.find(a => a.artifactId === 'final').sha256 = sha('9');
  f.receipt.artifactHashes.find(a => a.artifactId === 'final').sha256 = sha('9'); invalid(f);
});
test('canonical context hashing preserves source-byte provenance and binds requests to exact content', () => {
  const f = contextFixture(), originalBytesHash = f.context.sourceSnapshotSha256;
  const reordered = Object.fromEntries(Object.entries(f.context).reverse());
  assert.equal(computeContextSnapshotSha256(reordered), f.context.sha256);
  f.context.terms[0].target = 'NEW_CANDIDATE'; f.context.sha256 = computeContextSnapshotSha256(f.context);
  invalid(f); assert.equal(f.context.sourceSnapshotSha256, originalBytesHash);
});
test('rehashed inline context cannot bypass an older authoritative snapshot ticket', () => {
  const args = commitArgs(), f = contextFixture();
  args.candidate.context = f.context; args.candidate.targets = f.targets; args.candidate.translations = f.translations;
  args.current.contextSnapshotSha256 = f.context.sha256; args.ticket.contextSnapshotSha256 = f.context.sha256;
  assertCommitAllowed(args);
  args.candidate.context.terms[0].target = 'TAMPERED_AFTER_DISPATCH'; bindContext(args.candidate);
  assert.throws(() => assertCommitAllowed(args), { code: 'COMMON_CONTRACT_STALE' });
});
test('stage failures, validator versions/results and missing provenance retain explicit reasons', () => {
  const f = fixture();
  f.executionEvidence = [{ stepId: 'failed-step', jobId: 'job-1', stage: 'crop_refinement', model,
    adapterVersion: null, promptVersion: null, fontVersion: null, evaluatorVersion: null, datasetVersion: null,
    inputArtifactIds: ['raw'], outputArtifactIds: [], measurements: { elapsed: measure(null, 'ms') },
    failure: { code: 'OCR_REFINEMENT_RESPONSE_INVALID', stage: 'crop_refinement' },
    validationResults: [{ validatorId: 'source-lineage', version: 'fixture-v1', status: 'failed', inputSha256: sha('c'), outputSha256: null, reason: 'MISSING_SOURCE_LINE' }],
    unmeasuredReasons: { weightsSha256: 'NOT_REPORTED', configSha256: 'NOT_REPORTED' } }];
  validateCommonContract(f);
  for (const mutate of [f => f.executionEvidence[0].failure.stage = 'foreign-stage',
    f => f.executionEvidence[0].validationResults[0].version = '',
    f => f.executionEvidence[0].validationResults[0].reason = null]) {
    const copy = structuredClone(f); mutate(copy); invalid(copy);
  }
});
test('encoded image artifacts bind to their own original or normalized pixel frame', () => {
  const f = fixture(); f.artifacts.find(a => a.artifactId === 'original').frameId = 'page-px'; invalid(f);
});
test('a crop rectangle must fit its parent image even when its local affine is consistent', () => {
  const f = fixture();
  f.frames.push({ frameId: 'foreign-crop', kind: 'crop_px', imageId: 'normalized-image', width: 10, height: 10,
    parentFrameId: 'page-px', toParent: [1, 0, 0, 1, 999, 0], crop: { originX: 999, originY: 0, actualWidth: 10, actualHeight: 10,
      scaleX: 1, scaleY: 1, padding: { left: 0, top: 0, right: 0, bottom: 0 }, tileOffset: { x: 0, y: 0 } } });
  invalid(f);
});
