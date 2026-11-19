import { createHash } from 'node:crypto';
import { TAG_NAMES, contentSha256, manifestContentSha256 } from '../../../packages/evaluation/dataset-contract.mjs';
import qualityPolicy from '../../../packages/evaluation/policy/stage08-v1.1.json' with { type: 'json' };
import { createConditionMatrix } from '../../../packages/evaluation/stage16-condition-matrix.mjs';

export const sha = text => createHash('sha256').update(text).digest('hex');
const pin = name => ({ path: name, sha256: sha(name) });
const at = '2026-11-18T00:00:00Z';
const criteria = {
  version: 'stage05-v1', normalization: 'NFKC_CODEPOINTS_KEEP_SPACE_PUNCTUATION', splitUnit: 'work',
  regionMatching: 'MAX_CARDINALITY_THEN_IOU', iouThreshold: 0.5, nearDuplicateHamming: 6,
  humanReview: 'TWO_INDEPENDENT_JA_KO_REVIEWERS', finalEvaluationExecuted: false,
};
const datasetCriteriaJson = JSON.stringify(criteria);

function page(workId, pageId, split) {
  const unknown = { origin: 'unassessed', value: null, evidence: null };
  return {
    workId, pageId, split, usedForDevelopment: split === 'dev', duplicateGroupId: 'dup-' + pageId,
    source: {
      path: pageId + '.unavailable', sha256: sha(pageId), pixelSha256: sha('pixels-' + pageId),
      width: 10, height: 20, format: 'png', fingerprintVersion: 1,
      perceptualHashes: [sha('fingerprint-' + pageId).slice(0, 16)],
    },
    variants: [], pageOrder: { value: null, status: 'unknown', evidence: null },
    provenance: { origin: 'synthetic', sourceEvidence: null,
      rights: { status: 'authorized', evidence: pin('synthetic-rights'), allowedUses: ['local_evaluation'] } },
    bubbleCount: unknown, tags: Object.fromEntries(TAG_NAMES.map(tag => [tag, unknown])),
    annotation: { ...pin((split === 'dev' ? 'annotations/dev/' : 'holdout/annotations/') + pageId + '.json'),
      status: split === 'dev' ? 'pending' : 'human_verified' },
  };
}

export function freezeDataset(manifest) {
  manifest.freeze = {
    manifestContentSha256: manifestContentSha256(manifest), criteriaSha256: manifest.criteria.sha256,
    annotationPins: manifest.pages.map(p => ({ pageId: p.pageId, sha256: p.annotation.sha256 })),
    frozenAt: at, approvedBy: 'fixture-reviewer', evidence: pin('synthetic-freeze'), finalRun: null,
  };
}

export function matrixFor(page, changes = {}) {
  return createConditionMatrix({
    shared: {
      workId: page.workId, pageId: page.pageId, sourceSha256: page.source.sha256,
      contextSnapshotSha256: sha('context-' + page.pageId), fontSha256: sha('fonts'),
      settingsSha256: sha('settings'), intermediateSha256: null, ...changes.shared,
    },
    models: { A: sha('model-a'), B: sha('model-b'), ...changes.models },
    processing: { baseline: sha('baseline'), improved: sha('improved'), ...changes.processing },
  });
}

export function experiment() {
  const dev = page('work-dev', 'page-dev', 'dev');
  const holdout = page('work-final', 'page-final', 'holdout');
  const pages = [dev, holdout];
  const manifest = {
    schemaVersion: 1, datasetId: 'synthetic-s16', datasetVersion: '0.2.1', commonContractVersion: 1,
    createdAt: at, criteria: { version: criteria.version, path: 'criteria.json', sha256: sha(datasetCriteriaJson) },
    works: pages.map(p => ({ workId: p.workId, leakageGroupId: 'group-' + p.workId, status: 'confirmed',
      title: p.workId, identityEvidence: pin('identity-' + p.workId) })),
    pages, reviewers: [{ reviewerId: 'fixture-reviewer', kind: 'human', languages: ['ja', 'ko'],
      independenceGroup: 'fixture-group', qualificationEvidence: pin('synthetic-qualification') }],
    duplicateReviews: [], history: [{ version: '0.2.1', at, actor: 'fixture', reason: 'Synthetic metadata', previousManifestSha256: null }],
    freeze: null,
  };
  freezeDataset(manifest);
  const matrix = matrixFor(holdout);
  const candidateSelection = { status: 'recorded', evidenceSha256: sha('11m-record'), exposures: [
    { workId: dev.workId, leakageGroupId: 'group-work-dev', contextSnapshotSha256: sha('candidate-context') },
  ] };
  const holdoutHistory = [{ workId: holdout.workId, leakageGroupId: 'group-work-final',
    contextSnapshotSha256: matrix.shared.contextSnapshotSha256, state: 'unopened', evidenceSha256: sha('sealed-inventory') }];
  const preregistration = {
    work_split_and_exposure: contentSha256(candidateSelection),
    source_and_gt_hashes: [{ pageId: holdout.pageId, sourceSha256: holdout.source.sha256,
      groundTruthSha256: holdout.annotation.sha256, matrixSha256: matrix.matrixSha256 }],
    ocr_normalization: criteria.normalization,
    matching_unit_and_iou: { unit: 'region', method: criteria.regionMatching, threshold: criteria.iouThreshold },
    error_taxonomy_and_severity: sha('taxonomy'),
    evaluator_and_policy_version: { evaluatorSha256: sha('evaluator'), policySha256: contentSha256(qualityPolicy) },
    model_adapter_prompt_font_versions: { adapterSha256: sha('adapter'), promptSha256: sha('prompt'),
      fontSha256: sha('fonts'), models: { A: sha('model-a'), B: sha('model-b') } },
    environment_and_sampling: sha('environment-and-sampling'),
    approval_policy: sha('approval-rules'),
    primary_metric_and_minimum_effect: { metric: 'work_paired_score', minimumEffect: 0.04 },
    noninferiority_margins: { naturalness: 0.02 },
    resource_caps_and_stop_rules: { maxRequests: 8, maxTokens: 1000, maxDurationMs: 10000, maxRamBytes: 1000000,
      maxGpuBytes: 500000, maxMoney: 0, currency: 'KRW', stopRulesSha256: sha('stop-rules') },
    blind_randomized_human_review: sha('review-protocol'),
    holdout_freeze: { manifestSha256: contentSha256(manifest), historyLength: holdoutHistory.length,
      historySha256: contentSha256(holdoutHistory) },
  };
  return { manifest, datasetCriteriaJson, matrices: [matrix], candidateSelection, holdoutHistory, preregistration };
}

export function addHoldoutPage(input, workId, pageId, leakageGroupId = 'group-' + workId) {
  const next = page(workId, pageId, 'holdout');
  if (!input.manifest.works.some(w => w.workId === workId)) {
    input.manifest.works.push({ workId, leakageGroupId, status: 'confirmed', title: workId, identityEvidence: pin('identity-' + workId) });
  }
  input.manifest.pages.push(next);
  freezeDataset(input.manifest);
  const matrix = matrixFor(next);
  input.matrices.push(matrix);
  input.holdoutHistory.push({ workId, leakageGroupId, contextSnapshotSha256: matrix.shared.contextSnapshotSha256,
    state: 'unopened', evidenceSha256: sha('sealed-' + pageId) });
  input.preregistration.source_and_gt_hashes.push({ pageId, sourceSha256: next.source.sha256,
    groundTruthSha256: next.annotation.sha256, matrixSha256: matrix.matrixSha256 });
  input.preregistration.holdout_freeze = { manifestSha256: contentSha256(input.manifest),
    historyLength: input.holdoutHistory.length, historySha256: contentSha256(input.holdoutHistory) };
}
