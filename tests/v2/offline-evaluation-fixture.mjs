import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { fingerprintImage } from '../../packages/evaluation/image-fingerprint.mjs';
import { TAG_NAMES } from '../../packages/evaluation/dataset-contract.mjs';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const png = (pixels, width = 2, height = 2) => sharp(Buffer.from(pixels), { raw: { width, height, channels: 4 } }).png().toBuffer();
export const white = Array(16).fill(255);
export const identity = { ownerId: 'synthetic-owner', projectId: 'project-1', pageId: 'runtime-page-1', jobId: 'job-1', workId: 'work-1',
  sourceRevision: null, editRevision: null, contextRevision: null, processingGeneration: null, storageRevision: null };
export const bubble = (id = 'g1', text = 'あ') => ({ id, text, bbox: { x: .1, y: .1, width: .3, height: .3 }, readingOrder: 1,
  productionOcrProvenance: { groupId: id, sourceDetectionIds: ['det-1'], sourceQuadsPx: [[{ x: .2, y: .2 }, { x: .8, y: .2 }, { x: .8, y: .8 }, { x: .2, y: .8 }]],
    sourceDetectionScores: [.9], detectorModelId: 'synthetic-detector', detectorRevision: 'fixture', recognizerModelId: 'synthetic-recognizer', recognizerRevision: 'fixture', orientation: 'vertical',
    recognition: { rawOcrText: text, normalizedOcrText: text } } });

export async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mangohana-stage06-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const assets = path.join(dir, 'assets'); await fs.mkdir(assets);
  const source = await png(white), fingerprint = await fingerprintImage(source);
  const policy = { version: 'stage05-v1', normalization: 'NFKC_CODEPOINTS_KEEP_SPACE_PUNCTUATION', splitUnit: 'work',
    regionMatching: 'MAX_CARDINALITY_THEN_IOU', iouThreshold: .5, nearDuplicateHamming: 6, humanReview: 'TWO_INDEPENDENT_JA_KO_REVIEWERS', finalEvaluationExecuted: false };
  const pin = async (file, value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await fs.writeFile(path.join(dir, file), bytes); return { path: file, sha256: sha(bytes) }; };
  await pin('source.png', source);
  const annotation = { schemaVersion: 1, datasetId: 'synthetic-only', datasetVersion: '0.2.1', annotationVersion: '0.1.0', criteriaVersion: policy.version,
    pageId: 'dataset-page-1', workId: 'work-1', sourceSha256: sha(source), basisImageSha256: sha(source), status: 'pending', statusReason: 'NO_HUMAN_ANNOTATION',
    provenance: { kind: 'unannotated', authorId: null, createdAt: '2026-11-12T08:00:00Z', evidence: null, tool: 'synthetic-test' },
    frame: { frameId: 'original-px', imageId: 'source-image', kind: 'original_px', width: 2, height: 2, parentFrameId: null, toParent: null, crop: null },
    lines: [], regions: [], translations: [], imageQuality: { hiddenBackgroundTruth: { available: false, image: null, reason: 'NO_REFERENCE' }, regions: [], minimumReadability: null, reason: 'NOT_ANNOTATED' },
    coverage: { regions: 'pending', ocr: 'pending', translation: 'pending', image: 'pending' }, reviews: [], disagreements: [] };
  const assessed = { value: null, origin: 'unassessed', evidence: null };
  const dataset = { schemaVersion: 1, datasetId: 'synthetic-only', datasetVersion: '0.2.1', commonContractVersion: 1, createdAt: '2026-11-12T08:00:00Z',
    criteria: { version: policy.version, ...await pin('criteria.json', policy) },
    works: [{ workId: 'work-1', status: 'unresolved', title: null, identityEvidence: null, leakageGroupId: 'unknown' }],
    pages: [{ pageId: annotation.pageId, workId: 'work-1', split: 'dev', usedForDevelopment: true, duplicateGroupId: 'dup1',
      source: { path: 'source.png', ...fingerprint }, variants: [], pageOrder: { value: null, status: 'unknown', evidence: null },
      provenance: { origin: 'synthetic', sourceEvidence: null, rights: { status: 'unknown', evidence: null, allowedUses: ['local_inventory'] } },
      bubbleCount: assessed, tags: Object.fromEntries(TAG_NAMES.map(n => [n, assessed])), annotation: { ...await pin('annotations/dev/dataset-page-1.json', annotation), status: 'pending' } }],
    reviewers: [], duplicateReviews: [], freeze: null, history: [{ version: '0.2.1', at: '2026-11-12T08:00:00Z', actor: 'synthetic', reason: 'test', previousManifestSha256: null }] };
  const descriptor = { schemaVersion: 1, adapterVersion: 'stage06-v1', runId: 'run-1', datasetVersion: '0.2.1', datasetManifestSha256: null, split: 'dev', pages: [] };
  const page = { pageId: annotation.pageId, binding: structuredClone(identity), evidenceKind: 'synthetic', artifacts: [], declaredOutcome: null,
    commonArtifactId: null, assessmentArtifactId: null, operationsArtifactId: null, renderPath: 'engine_png' };
  descriptor.pages.push(page);
  const add = async (id, kind, file, bytes, extra = {}) => { const p = await pin('assets/' + file, bytes);
    const a = { id, kind, path: file, sha256: p.sha256, origin: { runId: descriptor.runId, jobId: identity.jobId, reused: false }, ...extra };
    page.artifacts.push(a); return a; };
  await add('source', 'source', 'source.png', source);
  await add('normalized', 'normalized', 'normalized.png', source);
  await add('ocr', 'final_ocr', 'ocr.json', { pageNumber: 1, speechBubbles: [bubble()], nonSpeechText: [], warnings: [] });
  await add('state', 'state', 'state.json', { version: 1, id: identity.jobId, owner: identity.ownerId, projectId: identity.projectId, pageId: identity.pageId,
    sourceSha256: sha(source), status: 'failed', stage: 'failed', createdAt: '2026-11-12T08:00:00Z', updatedAt: '2026-11-12T08:00:01Z', errorCode: 'SYNTHETIC_FAILURE' });
  const seal = async () => { const d = await pin('dataset.json', dataset); descriptor.datasetManifestSha256 = d.sha256;
    const e = await pin('evidence.json', descriptor); return { datasetPath: path.join(dir, d.path), datasetSha256: d.sha256,
      evidencePath: path.join(dir, e.path), evidenceSha256: e.sha256, evidenceRoot: assets, workspace: path.join(dir, 'derived-' + cryptoRandom()) }; };
  return { dir, assets, source, dataset, descriptor, page, annotation, add, pin, seal };
}
const cryptoRandom = () => Math.random().toString(36).slice(2);
