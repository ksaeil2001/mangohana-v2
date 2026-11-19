import { contentSha256, validateDataset } from './dataset-contract.mjs';
import { digest, equal, hash, identifier, keys, object, requireValue } from './offline/contract.mjs';
import { validateQualityPolicy } from './policy/policy.mjs';
import qualityPolicy from './policy/stage08-v1.1.json' with { type: 'json' };
import { createConditionMatrix } from './stage16-condition-matrix.mjs';

const blocked = reason => ({ status: 'blocked', lockId: null, reason });
const invalid = 'INVALID_PREREGISTRATION';
const requiredSections = [...validateQualityPolicy(qualityPolicy).preregistrationRequired];
const policySha256 = contentSha256(qualityPolicy);
const nonnegative = n => Number.isFinite(n) && n >= 0;
const count = n => Number.isSafeInteger(n) && n >= 0;

function fields(record, names, reason = invalid) {
  keys(record, names, reason);
  requireValue(names.every(k => Object.hasOwn(record, k)), reason);
}

function checkPreregistration(p, expectedSha256) {
  fields(p, requiredSections);
  requireValue(digest(expectedSha256) && contentSha256(p) === expectedSha256, 'PREREGISTRATION_PIN_MISMATCH');
  for (const key of ['error_taxonomy_and_severity', 'environment_and_sampling', 'approval_policy',
    'blind_randomized_human_review', 'work_split_and_exposure']) requireValue(digest(p[key]), invalid);

  const evaluator = p.evaluator_and_policy_version;
  fields(evaluator, ['evaluatorSha256', 'policySha256']);
  requireValue(digest(evaluator.evaluatorSha256), invalid);
  requireValue(evaluator.policySha256 === policySha256, 'QUALITY_POLICY_PIN_MISMATCH');
  const versions = p.model_adapter_prompt_font_versions;
  fields(versions, ['models', 'fontSha256', 'adapterSha256', 'promptSha256']);
  fields(versions.models, ['A', 'B']);
  requireValue([versions.models.A, versions.models.B, versions.fontSha256, versions.adapterSha256, versions.promptSha256].every(digest), invalid);

  const primary = p.primary_metric_and_minimum_effect;
  fields(primary, ['metric', 'minimumEffect']);
  requireValue(identifier(primary.metric) && nonnegative(primary.minimumEffect), invalid);
  const margins = p.noninferiority_margins;
  requireValue(object(margins) && Object.keys(margins).length > 0 &&
    Object.entries(margins).every(([metric, value]) => identifier(metric) && nonnegative(value)), invalid);
  const caps = p.resource_caps_and_stop_rules;
  const limits = ['maxRequests', 'maxTokens', 'maxDurationMs', 'maxRamBytes', 'maxGpuBytes'];
  fields(caps, [...limits, 'maxMoney', 'currency', 'stopRulesSha256']);
  requireValue(limits.every(k => count(caps[k])) && nonnegative(caps.maxMoney) &&
    typeof caps.currency === 'string' && /^[A-Z]{3}$/.test(caps.currency) && digest(caps.stopRulesSha256), invalid);
  const freeze = p.holdout_freeze;
  fields(freeze, ['manifestSha256', 'historyLength', 'historySha256']);
  requireValue(digest(freeze.manifestSha256) && count(freeze.historyLength) && digest(freeze.historySha256), invalid);
}

function frozenDataset({ manifest, datasetCriteriaJson, nonHoldoutAnnotations = [], preregistration }) {
  requireValue(typeof datasetCriteriaJson === 'string' && hash(datasetCriteriaJson) === manifest?.criteria?.sha256,
    'DATASET_CRITERIA_PIN_MISMATCH');
  let criteria;
  try { criteria = JSON.parse(datasetCriteriaJson); } catch { requireValue(false, 'INVALID_CRITERIA'); }
  requireValue(Array.isArray(manifest.pages) && Array.isArray(nonHoldoutAnnotations), 'INVALID_STAGE16_INPUT');
  const holdoutIds = new Set(manifest.pages.filter(p => p?.split === 'holdout').map(p => p.pageId));
  requireValue(nonHoldoutAnnotations.every(a => a && !holdoutIds.has(a.pageId)), 'HOLDOUT_LABELS_FORBIDDEN');
  const checked = validateDataset(manifest, { policy: criteria, annotations: nonHoldoutAnnotations });
  requireValue(checked.freezeValidated, 'DATASET_FREEZE_REQUIRED');
  requireValue(preregistration.ocr_normalization === criteria.normalization && equal(preregistration.matching_unit_and_iou,
    { unit: 'region', method: criteria.regionMatching, threshold: criteria.iouThreshold }), 'DATASET_CRITERIA_PIN_MISMATCH');
  return checked;
}

// Rebuild the four cells through S16-01. A copied matrixSha256 is insufficient.
export function verifiedMatrix(matrix) {
  const reason = 'MATRIX_CONTENT_MISMATCH';
  requireValue(Array.isArray(matrix?.conditions) && matrix.conditions.length === 4, reason);
  const [baseline, improved, modelB] = matrix.conditions;
  const rebuilt = createConditionMatrix({
    shared: matrix.shared, models: { A: baseline?.modelSha256, B: modelB?.modelSha256 },
    processing: { baseline: baseline?.processingSha256, improved: improved?.processingSha256 },
  });
  requireValue(equal(matrix, rebuilt), reason);
  return rebuilt;
}

function frozenSamples({ manifest, matrices, preregistration }, checked, groups) {
  const pins = preregistration.source_and_gt_hashes;
  const mismatch = 'COHORT_MISMATCH';
  requireValue(Array.isArray(pins) && pins.length > 0 && Array.isArray(matrices) && matrices.length === pins.length, mismatch);
  const byPage = new Map(matrices.map(verifiedMatrix).map(m => [m.shared.pageId, m]));
  requireValue(byPage.size === pins.length, mismatch);
  const pages = new Map(manifest.pages.map(p => [p.pageId, p]));
  const unresolved = new Set(checked.duplicateCandidates.filter(c => c.disposition === 'needs_review').flatMap(c => c.pageIds));
  const unknownDevelopmentGroups = new Set(manifest.pages.filter(p => p.usedForDevelopment === null).map(p => groups.get(p.workId)));
  const versions = preregistration.model_adapter_prompt_font_versions;
  const [first] = byPage.values();
  return pins.map(pin => {
    fields(pin, ['pageId', 'sourceSha256', 'groundTruthSha256', 'matrixSha256'], mismatch);
    const page = pages.get(pin.pageId), matrix = byPage.get(pin.pageId);
    requireValue(page && matrix, mismatch);
    byPage.delete(pin.pageId);
    requireValue(page.split === 'holdout' && page.usedForDevelopment === false, 'SAMPLE_NOT_UNUSED_HOLDOUT');
    requireValue(!unknownDevelopmentGroups.has(groups.get(page.workId)), 'DEVELOPMENT_EXPOSURE_UNKNOWN');
    requireValue(page.annotation.status === 'human_verified', 'SEALED_GROUND_TRUTH_REQUIRED');
    requireValue(!unresolved.has(page.pageId), 'DUPLICATE_CANDIDATES_NEED_REVIEW');
    const { shared, conditions } = matrix;
    requireValue(shared.workId === page.workId && shared.sourceSha256 === page.source.sha256 &&
      pin.sourceSha256 === page.source.sha256 && pin.groundTruthSha256 === page.annotation.sha256 &&
      pin.matrixSha256 === matrix.matrixSha256, 'SAMPLE_PIN_MISMATCH');
    requireValue(versions.fontSha256 === shared.fontSha256 && conditions.every(c => versions.models[c.model] === c.modelSha256) &&
      equal(conditions, first.conditions) && shared.settingsSha256 === first.shared.settingsSha256, 'EXPERIMENT_VERSION_MISMATCH');
    return { ...pin, workId: page.workId, leakageGroupId: groups.get(page.workId), contextSnapshotSha256: shared.contextSnapshotSha256 };
  });
}

function bindGroup(entry, groups) {
  requireValue(!groups.has(entry.workId) || groups.get(entry.workId) === entry.leakageGroupId, 'EXPOSURE_GROUP_MISMATCH');
  groups.set(entry.workId, entry.leakageGroupId);
}

function candidateExposures(record) {
  const unknown = 'CANDIDATE_EXPOSURE_UNKNOWN';
  fields(record, ['status', 'exposures', 'evidenceSha256'], unknown);
  requireValue(digest(record.evidenceSha256) && Array.isArray(record.exposures), unknown);
  requireValue(record.status === 'not_run' ? record.exposures.length === 0
    : record.status === 'recorded' && record.exposures.length > 0, unknown);
  for (const entry of record.exposures) {
    fields(entry, ['workId', 'leakageGroupId', 'contextSnapshotSha256'], unknown);
    requireValue(identifier(entry.workId) && identifier(entry.leakageGroupId) && digest(entry.contextSnapshotSha256), unknown);
  }
  return record.exposures;
}

const sameExposure = (a, b) => a.workId === b.workId || a.leakageGroupId === b.leakageGroupId ||
  a.contextSnapshotSha256 === b.contextSnapshotSha256;

function holdoutUse({ holdoutHistory: history, preregistration, manifest }, samples, groups, currentHistorySha256, manifestSha256) {
  const frozen = preregistration.holdout_freeze;
  requireValue(Array.isArray(history) && history.length >= frozen.historyLength, 'HOLDOUT_HISTORY_CHANGED');
  requireValue(contentSha256(history) === currentHistorySha256, 'HOLDOUT_HISTORY_CHANGED');
  const prefix = history.slice(0, frozen.historyLength);
  requireValue(contentSha256(prefix) === frozen.historySha256, 'HOLDOUT_HISTORY_CHANGED');
  for (const row of history) {
    const reason = 'HOLDOUT_EXPOSURE_UNKNOWN';
    fields(row, ['workId', 'leakageGroupId', 'contextSnapshotSha256', 'state', 'evidenceSha256'], reason);
    requireValue(identifier(row.workId) && identifier(row.leakageGroupId) && digest(row.contextSnapshotSha256) &&
      ['unopened', 'opened', 'tuned_after_opening', 'unknown'].includes(row.state) &&
      (digest(row.evidenceSha256) || (row.state === 'unknown' && row.evidenceSha256 === null)), reason);
    bindGroup(row, groups);
  }
  const tuned = history.filter(row => row.state === 'tuned_after_opening');
  const demotedGroups = new Set(tuned.map(row => row.leakageGroupId));
  const tunedContexts = new Set(tuned.map(row => row.contextSnapshotSha256));
  // A shared tuned context disqualifies its other work and leakage group, including unselected siblings.
  for (const row of [...history, ...samples]) {
    if (tunedContexts.has(row.contextSnapshotSha256)) demotedGroups.add(row.leakageGroupId);
  }
  let disposition;
  if (demotedGroups.size) {
    const changes = manifest.works.filter(w => demotedGroups.has(w.leakageGroupId)).map(w => ({
      workId: w.workId, leakageGroupId: w.leakageGroupId, from: 'holdout', to: 'dev',
      pageIds: manifest.pages.filter(p => p.split === 'holdout' && p.workId === w.workId).map(p => p.pageId),
    })).filter(change => change.pageIds.length > 0);
    disposition = { previousManifestSha256: frozen.manifestSha256, observedManifestSha256: manifestSha256,
      previousHistorySha256: frozen.historySha256, historySha256: currentHistorySha256, changes };
    if (samples.some(s => demotedGroups.has(s.leakageGroupId))) {
      return { ...blocked('HOLDOUT_TUNED_AFTER_OPENING'), replacementHoldoutRequired: true, disposition };
    }
  }
  for (const sample of samples) {
    const related = history.filter(row => sameExposure(row, sample));
    requireValue(!related.some(row => row.state === 'opened'), 'HOLDOUT_ALREADY_OPENED');
    requireValue(!related.some(row => row.state === 'unknown') && prefix.some(row => row.state === 'unopened' &&
      row.workId === sample.workId && row.leakageGroupId === sample.leakageGroupId &&
      row.contextSnapshotSha256 === sample.contextSnapshotSha256), 'HOLDOUT_EXPOSURE_UNKNOWN');
  }
  return { disposition };
}

/** Both the saved preregistration SHA and the latest exposure pins come from outside the submitted metadata. */
export function createExperimentLock(input, expectedPreregistrationSha256, currentExposure) {
  try {
    keys(input, ['manifest', 'datasetCriteriaJson', 'nonHoldoutAnnotations', 'matrices', 'candidateSelection',
      'holdoutHistory', 'preregistration'], 'INVALID_STAGE16_INPUT');
    const { preregistration, manifest } = input;
    checkPreregistration(preregistration, expectedPreregistrationSha256);
    const unknown = 'CURRENT_EXPOSURE_UNKNOWN';
    fields(currentExposure, ['candidateSelectionSha256', 'holdoutHistorySha256'], unknown);
    requireValue(digest(currentExposure.candidateSelectionSha256) && digest(currentExposure.holdoutHistorySha256), unknown);
    const checked = frozenDataset(input);
    const groups = new Map(manifest.works.map(w => [w.workId, w.leakageGroupId]));
    const samples = frozenSamples(input, checked, groups);
    const manifestSha256 = contentSha256(manifest);
    const frozenSha256 = preregistration.holdout_freeze.manifestSha256;
    // Stage05 can append a finalRun receipt to the frozen inventory. It can explain a demotion, never a new lock.
    requireValue(manifestSha256 === frozenSha256 || (manifest.freeze.finalRun !== null &&
      contentSha256({ ...manifest, freeze: { ...manifest.freeze, finalRun: null } }) === frozenSha256), 'FROZEN_MANIFEST_CHANGED');
    const use = holdoutUse(input, samples, groups, currentExposure.holdoutHistorySha256, manifestSha256);
    if (use.status === 'blocked') return use;
    requireValue(manifest.freeze.finalRun === null, 'FINAL_RUN_ALREADY_STARTED');
    const exposures = candidateExposures(input.candidateSelection);
    requireValue(contentSha256(input.candidateSelection) === currentExposure.candidateSelectionSha256 &&
      currentExposure.candidateSelectionSha256 === preregistration.work_split_and_exposure, 'CANDIDATE_RECORD_CHANGED');
    for (const row of exposures) bindGroup(row, groups);
    for (const sample of samples) {
      requireValue(!exposures.some(row => row.workId === sample.workId), 'CANDIDATE_WORK_REUSED');
      requireValue(!exposures.some(row => row.leakageGroupId === sample.leakageGroupId), 'CANDIDATE_GROUP_REUSED');
      requireValue(!exposures.some(row => row.contextSnapshotSha256 === sample.contextSnapshotSha256), 'CANDIDATE_CONTEXT_REUSED');
    }
    const record = { schemaVersion: 1, kind: 'stage16-experiment-lock', preregistrationSha256: expectedPreregistrationSha256,
      manifestSha256, candidateSelectionSha256: preregistration.work_split_and_exposure,
      holdoutHistorySha256: currentExposure.holdoutHistorySha256, samples };
    const lock = { status: 'locked', lockId: contentSha256(record), record };
    return use.disposition ? { ...lock, disposition: use.disposition } : lock;
  } catch (error) {
    if (typeof error.code !== 'string') throw error;
    return blocked(error.code);
  }
}
