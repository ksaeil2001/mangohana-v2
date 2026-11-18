import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const stages = ['DETECTION', 'GROUPING', 'CROP', 'RECOGNITION', 'READING_ORDER', 'TRANSLATION', 'MASK', 'INPAINT', 'TYPESETTING'];
const evidenceKinds = ['actual_product', 'actual_component', 'reused', 'fixture', 'not_run'];
const qualityChecks = ['meaning', 'omissionsAndDuplicates', 'sourceTextRemoval', 'artworkPreservation', 'typesettingReadability'];
const hash = value => createHash('sha256').update(value).digest('hex');
const requireValue = (condition, reason) => { if (!condition) throw new Error(reason); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.trim().length > 0;
const reviewed = value => object(value) && value.status === 'verified' && id(value.reviewer) && typeof value.reviewedAt === 'string' && Number.isFinite(Date.parse(value.reviewedAt));
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validBox(box) {
  return object(box) && ['x', 'y', 'width', 'height'].every(key => typeof box[key] === 'number' && Number.isFinite(box[key]))
    && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= 1.000001 && box.y + box.height <= 1.000001;
}

/** Compare Unicode codepoints, preserving spaces/punctuation; no model-specific cleanup. */
export function characterErrors(expected, actual) {
  const reference = [...expected.normalize('NFKC')], candidate = [...actual.normalize('NFKC')];
  let previous = Array.from({ length: candidate.length + 1 }, (_, index) => index);
  for (let row = 1; row <= reference.length; row++) {
    const current = [row];
    for (let col = 1; col <= candidate.length; col++) {
      current[col] = Math.min(current[col - 1] + 1, previous[col] + 1, previous[col - 1] + (reference[row - 1] === candidate[col - 1] ? 0 : 1));
    }
    previous = current;
  }
  return { errors: previous[candidate.length], referenceCharacters: reference.length };
}

function iou(a, b) {
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return intersection / (a.width * a.height + b.width * b.height - intersection);
}

/** Maximize match count, then total IoU, without using text or predicted reading order. */
function matchRegions(expected, actual) {
  const n = expected.length, columns = actual.length + n;
  const overlaps = expected.map(region => actual.map(candidate => iou(region.bbox, candidate.bbox)));
  // A dummy column can leave each reference unmatched. One additional match
  // outweighs every possible change in total IoU (which is at most n).
  const cost = (row, col) => col >= actual.length ? 0 : overlaps[row][col] >= 0.5 ? -(n + 1 + overlaps[row][col]) : 1;
  const u = Array(n + 1).fill(0), v = Array(columns + 1).fill(0);
  const owner = Array(columns + 1).fill(0), previous = Array(columns + 1).fill(0);
  // Rectangular Hungarian assignment, including unmatched dummy columns.
  for (let row = 1; row <= n; row++) {
    owner[0] = row;
    let col = 0;
    const best = Array(columns + 1).fill(Infinity), used = Array(columns + 1).fill(false);
    do {
      used[col] = true;
      const active = owner[col];
      let delta = Infinity, next = 0;
      for (let candidate = 1; candidate <= columns; candidate++) {
        if (used[candidate]) continue;
        const reduced = cost(active - 1, candidate - 1) - u[active] - v[candidate];
        if (reduced < best[candidate]) { best[candidate] = reduced; previous[candidate] = col; }
        if (best[candidate] < delta) { delta = best[candidate]; next = candidate; }
      }
      for (let candidate = 0; candidate <= columns; candidate++) {
        if (used[candidate]) { u[owner[candidate]] += delta; v[candidate] -= delta; }
        else best[candidate] -= delta;
      }
      col = next;
    } while (owner[col] !== 0);
    do {
      const prior = previous[col]; owner[col] = owner[prior]; col = prior;
    } while (col !== 0);
  }
  const pairs = [];
  for (let col = 1; col <= actual.length; col++) {
    const row = owner[col] - 1;
    if (row >= 0 && overlaps[row][col - 1] >= 0.5) {
      pairs.push({ actualIndex: col - 1, expectedIndex: row });
    }
  }
  return pairs;
}

export function validateCorpus(corpus) {
  requireValue(object(corpus) && corpus.schemaVersion === 1 && id(corpus.datasetId) && Array.isArray(corpus.pages), 'INVALID_CORPUS');
  const identifiers = new Set(), splitsByIdentity = new Map();
  for (const page of corpus.pages) {
    requireValue(object(page) && id(page.id) && !identifiers.has(page.id), 'DUPLICATE_OR_INVALID_PAGE_ID');
    identifiers.add(page.id);
    requireValue(['dev', 'holdout'].includes(page.split) && id(page.workId) && id(page.duplicateGroupId), 'INVALID_SPLIT_IDENTITY');
    requireValue(typeof page.usedForDevelopment === 'boolean' && (page.split !== 'holdout' || page.usedForDevelopment === false), 'HOLDOUT_ALREADY_USED_FOR_DEVELOPMENT');
    requireValue(object(page.source) && id(page.source.path) && sha256(page.source.sha256), 'INVALID_SOURCE');
    for (const identity of ['work:' + page.workId, 'duplicates:' + page.duplicateGroupId, 'bytes:' + page.source.sha256]) {
      requireValue(!splitsByIdentity.has(identity) || splitsByIdentity.get(identity) === page.split, 'SPLIT_LEAKAGE:' + identity);
      splitsByIdentity.set(identity, page.split);
    }
    requireValue(object(page.groundTruth) && ['pending', 'verified'].includes(page.groundTruth.status), 'INVALID_GROUND_TRUTH_STATUS');
    if (page.groundTruth.status === 'verified') {
      requireValue(reviewed(page.groundTruth) && Array.isArray(page.groundTruth.regions), 'HUMAN_GROUND_TRUTH_REVIEW_REQUIRED');
      const regionIds = new Set(), orders = new Set();
      for (const region of page.groundTruth.regions) {
        requireValue(object(region) && id(region.id) && !regionIds.has(region.id) && validBox(region.bbox)
          && typeof region.text === 'string' && region.text.length > 0 && id(region.translation)
          && Number.isSafeInteger(region.order) && region.order > 0 && !orders.has(region.order), 'INVALID_GROUND_TRUTH_REGION');
        regionIds.add(region.id); orders.add(region.order);
      }
    }
  }
  return corpus;
}

async function pinnedAsset(asset, base) {
  requireValue(object(asset) && id(asset.path) && sha256(asset.sha256), 'INVALID_ASSET_PIN');
  const bytes = await readFile(resolve(base, asset.path));
  requireValue(hash(bytes) === asset.sha256, 'ASSET_CHANGED:' + asset.path);
  return bytes;
}

const ratio = (numerator, denominator, reason) => ({ numerator, denominator,
  value: denominator > 0 ? numerator / denominator : null, reason: denominator > 0 ? null : reason });
const unavailable = reason => ratio(null, null, reason);

/** Detection here means final OCR proposals matched by the existing IoU assignment. */
function regionMetrics(truePositives, falsePositives, falseNegatives, unavailableReason = null) {
  const precision = ratio(truePositives, unavailableReason ? null : truePositives + falsePositives, unavailableReason ?? 'NO_PREDICTED_REGIONS');
  const recall = ratio(truePositives, unavailableReason ? null : truePositives + falseNegatives, unavailableReason ?? 'NO_REFERENCE_REGIONS');
  const f1 = ratio(unavailableReason ? null : 2 * truePositives, unavailableReason ? null : 2 * truePositives + falsePositives + falseNegatives, unavailableReason ?? 'NO_REFERENCE_OR_PREDICTED_REGIONS');
  return { truePositives, falsePositives, falseNegatives, precision: precision.value, recall: recall.value, f1: f1.value,
    unmeasuredReasons: { precision: precision.reason, recall: recall.reason, f1: f1.reason } };
}

function summarizeOcr(selected) {
  const measured = selected.filter(row => row.ocr !== null);
  const unavailableReason = selected.length === 0 ? 'NO_PAGES' : measured.length === 0 ? 'NO_EVALUABLE_OCR_PAGES' : null;
  const sum = key => measured.length ? measured.reduce((total, row) => total + row.ocr[key], 0) : null;
  const counts = regionMetrics(sum('truePositives'), sum('falsePositives'), sum('falseNegatives'), unavailableReason);
  const characterErrors = sum('characterErrors'), referenceCharacters = sum('referenceCharacters');
  const cer = ratio(characterErrors, referenceCharacters, unavailableReason ?? 'NO_REFERENCE_CHARACTERS');
  return { measuredPages: measured.length, unmeasuredPages: selected.length - measured.length,
    status: unavailableReason ? 'NOT_MEASURED' : measured.length < selected.length ? 'PARTIAL'
      : sum('referenceRegions') + sum('predictedRegions') === 0 ? 'NO_TARGETS' : 'MEASURED',
    ...counts, characterErrors, referenceCharacters, microCharacterErrorRate: cer.value,
    unmeasuredReasons: { ...counts.unmeasuredReasons, microCharacterErrorRate: cer.reason },
    scope: 'FINAL_OCR_PROPOSALS_NOT_RAW_DETECTOR_ACCURACY' };
}

function executionVerification(kind) {
  return { status: kind === 'not_run' ? 'NOT_RUN' : kind === 'fixture' ? 'FIXTURE' : 'UNVERIFIED',
    productExecutionVerified: false,
    reason: kind === 'not_run' ? 'NO_RUN_EVIDENCE' : kind === 'fixture' ? 'SYNTHETIC_EVIDENCE' : 'RUNTIME_CLAIM_NOT_INDEPENDENTLY_VERIFIED' };
}

/** Reads evidence only. Never invokes providers or writes product/project data. */
export async function evaluateAutomationQuality(corpus, run, baseDirectory) {
  validateCorpus(corpus);
  requireValue(object(run) && run.schemaVersion === 1 && id(run.runId) && sha256(run.corpusSha256)
    && id(run.codeIdentity) && object(run.models) && Array.isArray(run.pages), 'INVALID_RUN');
  requireValue(hash(JSON.stringify(corpus)) === run.corpusSha256, 'CORPUS_NOT_FROZEN_FOR_RUN');
  const byId = new Map();
  for (const page of run.pages) {
    requireValue(object(page) && corpus.pages.some(item => item.id === page.pageId) && !byId.has(page.pageId), 'UNKNOWN_OR_DUPLICATE_RUN_PAGE');
    requireValue(evidenceKinds.includes(page.evidenceKind), 'INVALID_EVIDENCE_KIND');
    requireValue(object(page.stages) && stages.every(stage => ['completed', 'failed', 'review', 'blocked', 'not_run'].includes(page.stages[stage])), 'INVALID_STAGE_STATUS');
    requireValue((page.durationMs === null || (Number.isFinite(page.durationMs) && page.durationMs >= 0))
      && (page.peakWorkingSetBytes === null || (Number.isFinite(page.peakWorkingSetBytes) && page.peakWorkingSetBytes >= 0)), 'INVALID_RESOURCE_MEASUREMENT');
    requireValue(Number.isSafeInteger(page.manualEdits) && page.manualEdits >= 0 && Number.isSafeInteger(page.automaticRetries) && page.automaticRetries >= 0, 'INVALID_INTERVENTION_COUNT');
    byId.set(page.pageId, page);
  }
  const rows = [];
  for (const page of corpus.pages) {
    await pinnedAsset(page.source, baseDirectory);
    const evidence = byId.get(page.id);
    if (!evidence) {
      rows.push({ pageId: page.id, split: page.split, evidenceKind: 'not_run', status: 'NOT_RUN', automaticSuccess: false, ocr: null, quality: 'PENDING', durationMs: null, peakWorkingSetBytes: null,
        ocrMeasurement: { status: 'NOT_MEASURED', reason: 'NO_RUN_EVIDENCE' }, processingStatus: 'NOT_RUN',
        qualityReviewStatus: { status: 'MISSING', reason: 'QUALITY_REVIEW_NOT_SUPPLIED' }, executionVerification: executionVerification('not_run'),
        attestedOutcome: 'NOT_QUALIFIED', resourceMeasurementReasons: { durationMs: 'NO_RUN_EVIDENCE', peakWorkingSetBytes: 'NO_RUN_EVIDENCE' } });
      continue;
    }
    let ocr = null;
    let result;
    if (evidence.ocr) {
      result = JSON.parse((await pinnedAsset(evidence.ocr, baseDirectory)).toString('utf8'));
      requireValue(object(result) && Array.isArray(result.speechBubbles) && result.speechBubbles.every(region => object(region) && validBox(region.bbox) && typeof region.text === 'string' && Number.isSafeInteger(region.readingOrder)), 'INVALID_OCR_EVIDENCE');
      const regionIds = new Set();
      for (const region of result.speechBubbles) {
        // Legacy evidence may omit IDs; never manufacture IDs from geometry or GT.
        if (region.id === undefined) continue;
        requireValue(id(region.id) && !regionIds.has(region.id), 'INVALID_OR_DUPLICATE_OCR_REGION_ID');
        regionIds.add(region.id);
      }
      const provenance = JSON.parse((await pinnedAsset(evidence.ocr.provenance, baseDirectory)).toString('utf8'));
      requireValue(object(provenance) && provenance.runId === run.runId && provenance.sourceSha256 === page.source.sha256
        && provenance.ocrSha256 === evidence.ocr.sha256, 'OCR_PROVENANCE_MISMATCH');
    }
    if (result && reviewed(page.groundTruth) && evidence.evidenceKind !== 'not_run') {
      const pairs = matchRegions(page.groundTruth.regions, result.speechBubbles);
      let errors = 0, characters = 0, orderErrors = 0;
      const matched = new Set();
      for (const pair of pairs) {
        const expected = page.groundTruth.regions[pair.expectedIndex], actual = result.speechBubbles[pair.actualIndex];
        const value = characterErrors(expected.text, actual.text);
        errors += value.errors; characters += value.referenceCharacters;
        if (expected.order !== actual.readingOrder) orderErrors++;
        matched.add(pair.expectedIndex);
      }
      // Missing regions count as deletions; additional regions as insertions.
      page.groundTruth.regions.forEach((region, index) => { if (!matched.has(index)) { const n = [...region.text.normalize('NFKC')].length; errors += n; characters += n; } });
      const matchedActual = new Set(pairs.map(pair => pair.actualIndex));
      result.speechBubbles.forEach((region, index) => { if (!matchedActual.has(index)) errors += [...region.text.normalize('NFKC')].length; });
      const missingRegionIds = page.groundTruth.regions.filter((_, index) => !matched.has(index)).map(region => region.id);
      const extraRegionIndices = result.speechBubbles.flatMap((_, index) => matchedActual.has(index) ? [] : [index]);
      const extraRegionIds = extraRegionIndices.map(index => result.speechBubbles[index].id ?? null);
      const counts = regionMetrics(pairs.length, extraRegionIndices.length, missingRegionIds.length);
      ocr = { matchedRegions: pairs.length, referenceRegions: page.groundTruth.regions.length, predictedRegions: result.speechBubbles.length, characterErrors: errors,
        referenceCharacters: characters, characterErrorRate: characters ? errors / characters : null, readingOrderErrors: orderErrors,
        ...counts, missingRegionIds, extraRegionIds, extraRegionIndices,
        extraRegionIdsReason: extraRegionIds.includes(null) ? 'PREDICTION_IDS_NOT_SUPPLIED' : null,
        unmeasuredReasons: { ...counts.unmeasuredReasons, characterErrorRate: characters ? null : 'NO_REFERENCE_CHARACTERS' },
        scope: 'FINAL_OCR_PROPOSALS_IOU_0.5_NFKC_SPACES_AND_PUNCTUATION_PRESERVED' };
    }
    const human = evidence.qualityReview;
    const reviewMatchesResult = reviewed(human) && human.runId === run.runId && human.sourceSha256 === page.source.sha256
      && object(evidence.finalImage) && human.finalImageSha256 === evidence.finalImage.sha256;
    const quality = reviewMatchesResult && qualityChecks.every(key => ['pass', 'fail'].includes(human[key]))
      ? qualityChecks.every(key => human[key] === 'pass') ? 'PASS' : 'FAIL' : 'PENDING';
    const qualityReviewStatus = !human ? { status: 'MISSING', reason: 'QUALITY_REVIEW_NOT_SUPPLIED' }
      : !reviewed(human) ? { status: 'PENDING', reason: 'QUALITY_REVIEW_NOT_VERIFIED' }
      : !reviewMatchesResult ? { status: 'MISMATCH', reason: 'QUALITY_REVIEW_RESULT_BINDING_MISMATCH' }
      : quality === 'PENDING' ? { status: 'PENDING', reason: 'QUALITY_REVIEW_CHECKS_INCOMPLETE' }
      : { status: quality, reason: quality === 'FAIL' ? 'HUMAN_REPORTED_QUALITY_FAILURE' : null };
    let finalSaved = false;
    if (evidence.finalImage) {
      const bytes = await pinnedAsset(evidence.finalImage, baseDirectory);
      requireValue(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.subarray(12,16).toString('ascii') === 'IHDR'
        && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0, 'FINAL_IMAGE_NOT_PNG');
      finalSaved = evidence.savedAndReopened === true;
    }
    const allStages = stages.every(stage => evidence.stages[stage] === 'completed');
    // Preserve the legacy attestation predicate. This is not proof of execution.
    const acceptedProductAttestation = evidence.evidenceKind === 'actual_product' && result !== undefined && reviewed(page.groundTruth) && allStages && finalSaved && quality === 'PASS';
    const automaticSuccess = acceptedProductAttestation && evidence.manualEdits === 0 && evidence.automaticRetries === 0;
    const attestedOutcome = !acceptedProductAttestation ? 'NOT_QUALIFIED' : evidence.manualEdits > 0 ? 'AFTER_MANUAL_EDITS'
      : evidence.automaticRetries > 0 ? 'AFTER_RETRY' : 'FIRST_ATTEMPT';
    const processingStatus = evidence.evidenceKind === 'not_run' ? 'NOT_RUN' : stages.some(stage => evidence.stages[stage] === 'failed') ? 'FAILED'
      : stages.some(stage => ['review', 'blocked'].includes(evidence.stages[stage])) ? 'NEEDS_REVIEW' : allStages ? 'COMPLETED' : 'NOT_RUN';
    rows.push({ pageId: page.id, split: page.split, evidenceKind: evidence.evidenceKind, automaticSuccess,
      status: automaticSuccess ? 'PASS' : 'NOT_QUALIFIED', stages: evidence.stages, quality, ocr,
      ocrMeasurement: ocr ? { status: ocr.referenceRegions + ocr.predictedRegions ? 'MEASURED' : 'NO_TARGETS', reason: ocr.referenceRegions + ocr.predictedRegions ? null : 'NO_REFERENCE_OR_PREDICTED_REGIONS' }
        : { status: 'NOT_MEASURED', reason: evidence.evidenceKind === 'not_run' ? 'NO_RUN_EVIDENCE' : !result ? 'OCR_EVIDENCE_NOT_SUPPLIED' : 'GROUND_TRUTH_NOT_VERIFIED' },
      processingStatus, qualityReviewStatus, executionVerification: executionVerification(evidence.evidenceKind), attestedOutcome,
      firstNonCompletedStage: stages.find(stage => evidence.stages[stage] !== 'completed') ?? null,
      resourceMeasurementReasons: { durationMs: evidence.durationMs === null ? 'NOT_REPORTED' : null, peakWorkingSetBytes: evidence.peakWorkingSetBytes === null ? 'NOT_REPORTED' : null },
      durationMs: evidence.durationMs, peakWorkingSetBytes: evidence.peakWorkingSetBytes });
  }
  const summarize = selected => ({ pages: selected.length, actualProductRuns: selected.filter(row => row.evidenceKind === 'actual_product').length,
    automaticSuccesses: selected.filter(row => row.automaticSuccess).length,
    automaticSuccessRate: selected.length ? selected.filter(row => row.automaticSuccess).length / selected.length : null,
    automaticSuccessRateReason: selected.length ? null : 'NO_PAGES',
    humanQualityPending: selected.filter(row => row.quality === 'PENDING').length,
    notRun: selected.filter(row => row.evidenceKind === 'not_run').length,
    ocr: summarizeOcr(selected),
    ocrByEvidenceKind: Object.fromEntries(evidenceKinds.filter(kind => selected.some(row => row.evidenceKind === kind))
      .map(kind => [kind, summarizeOcr(selected.filter(row => row.evidenceKind === kind))])),
    attestedSuccesses: { basis: 'SUPPLIED_ATTESTATIONS_ONLY', denominator: selected.length,
      firstAttempt: selected.filter(row => row.attestedOutcome === 'FIRST_ATTEMPT').length,
      afterRetry: selected.filter(row => row.attestedOutcome === 'AFTER_RETRY').length,
      afterManualEdits: selected.filter(row => row.attestedOutcome === 'AFTER_MANUAL_EDITS').length },
    verifiedAutomaticSuccessRate: unavailable(selected.length ? 'INDEPENDENT_RUNTIME_EVIDENCE_NOT_AVAILABLE' : 'NO_PAGES'),
    evaluationDataAvailability: ratio(selected.filter(row => row.ocr !== null && row.quality !== 'PENDING').length, selected.length, 'NO_PAGES'),
    qualityReviewPendingRate: ratio(selected.filter(row => row.quality === 'PENDING').length, selected.length, 'NO_PAGES'),
    delivery: { automaticDeliveryRate: unavailable('DELIVERY_RECORDS_NOT_SUPPLIED'),
      humanAuditErrorRate: unavailable('DELIVERY_AND_HUMAN_AUDIT_RECORDS_NOT_SUPPLIED'), withheldRate: unavailable('DELIVERY_DECISIONS_NOT_SUPPLIED') } });
  return { schemaVersion: 1, datasetId: corpus.datasetId, runId: run.runId, corpusSha256: run.corpusSha256,
    codeIdentity: run.codeIdentity, models: run.models, sourceIntegrityVerified: true,
    groundTruthPending: corpus.pages.filter(page => !reviewed(page.groundTruth)).length,
    summary: { dev: summarize(rows.filter(row => row.split === 'dev')), holdout: summarize(rows.filter(row => row.split === 'holdout')) }, pages: rows,
    ocrSummary: { ...summarizeOcr(rows), aggregationScope: 'DESCRIPTIVE_ALL_SPLITS_AND_EVIDENCE_KINDS_SEE_SPLIT_SUMMARIES' },
    automaticSuccessBasis: 'SUPPLIED_ATTESTATIONS_ONLY_NOT_EXECUTION_PROOF',
    independentAssessments: { semanticErrors: { value: null, reason: 'INDEPENDENT_SEMANTIC_ASSESSMENT_NOT_AVAILABLE' },
      imageSourceResidue: { value: null, reason: 'INDEPENDENT_IMAGE_ASSESSMENT_NOT_AVAILABLE' }, artworkDamage: { value: null, reason: 'INDEPENDENT_IMAGE_ASSESSMENT_NOT_AVAILABLE' } },
    limitation: 'Human review and runtime claims are supplied attestations. This evaluator does not verify reviewer identity, full PNG decoding, model execution, or the absence of undeclared manual edits. No claim of raw detector accuracy is made.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [corpusFile, runFile, output] = process.argv.slice(2);
  if (!corpusFile || !runFile || !output) throw new Error('Usage: node scripts/evaluate-automation-quality.mjs <corpus.json> <run.json> <new-report.json>');
  const corpus = JSON.parse(await readFile(corpusFile, 'utf8')), run = JSON.parse(await readFile(runFile, 'utf8'));
  const report = await evaluateAutomationQuality(corpus, run, dirname(resolve(corpusFile)));
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report.summary));
}
