import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { regularDirectory, writeExclusive } from '../../apps/engine/image-permit-store.mjs';
import { readBounded } from '../../apps/engine/translation-review-store.mjs';
import { atomicState, JOB_LIMITS } from '../../apps/engine/store.mjs';
import reviewState from '../../packages/ai-engine/quality/page-review-state.cjs';
import { contentSha256 } from '../../packages/evaluation/dataset-contract.mjs';
import { matchesFirstImagePng } from '../../packages/evaluation/first-image-blind-review.mjs';
import { summarizeFirstImagePairs } from '../../packages/evaluation/first-image-paired-report.mjs';
import { digest, hash, identifier, keys, requireValue } from '../../packages/evaluation/offline/contract.mjs';

const versions = ['baseline', 'improved'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const invalid = 'FIRST_IMAGE_CAPTURE_INPUT_INVALID';
const batchMismatch = 'FIRST_IMAGE_CAPTURE_BATCH_MISMATCH';
const jobMismatch = 'FIRST_IMAGE_CAPTURE_JOB_MISMATCH';
const isAbsolute = value => typeof value === 'string' && path.isAbsolute(value);
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const keyOf = ({ pageId, version }) => JSON.stringify([pageId, version]);

function inside(root, file) {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

async function emitAsset(root, sha256, bytes) {
  const file = path.join(root, `${sha256}.png`);
  try { await writeExclusive(file, bytes); }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readBounded(file, JOB_LIMITS.outputBytes)).equals(bytes)) throw error;
  }
}

async function readRecord(directory, limit) {
  await regularDirectory(directory);
  const file = path.join(directory, 'state.json');
  const bytes = await readBounded(file, limit);
  return { file, limit, sha256: hash(bytes), state: JSON.parse(bytes) };
}

async function verifyRecord(record) {
  requireValue(hash(await readBounded(record.file, record.limit)) === record.sha256, 'FIRST_IMAGE_CAPTURE_STATE_CHANGED');
}

async function completedPng(directory, job) {
  const receipt = job.resultReceipt, code = 'FIRST_IMAGE_CAPTURE_RECEIPT_MISMATCH';
  requireValue(receipt?.revision === 1 && receipt.jobId === job.id && receipt.processingGeneration === job.sequence &&
    receipt.sourceSha256 === job.sourceSha256 && digest(receipt.candidateSha256) && digest(receipt.reportSha256) &&
    receipt.reportSha256 === job.reportSha256, code);
  const reportBytes = await readBounded(path.join(directory, 'report.json'), JOB_LIMITS.reportBytes);
  requireValue(hash(reportBytes) === receipt.reportSha256, code);
  const report = JSON.parse(reportBytes);
  requireValue(report?.version === 1 && report.evidenceKind === 'LOCAL_ENGINE_CANDIDATE' && report.jobId === job.id &&
    report.originalPreserved === true && report.userApproved === false && report.humanTranslationReview == null &&
    (report.manualCorrections === undefined || report.manualCorrections === 0) &&
    Array.isArray(report.lines) && report.lines.length > 0 && report.lines.every(line => line.userTranslation == null) &&
    report.hashes?.original === job.sourceSha256 && report.hashes.candidate === receipt.candidateSha256 &&
    report.image?.width === job.width && report.image.height === job.height, code);
  const png = await readBounded(path.join(directory, 'candidate.png'), JOB_LIMITS.outputBytes);
  requireValue(matchesFirstImagePng(png, receipt.candidateSha256) && png.readUInt32BE(16) === job.width &&
    png.readUInt32BE(20) === job.height, 'FIRST_IMAGE_CAPTURE_PNG_MISMATCH');
  return { png, receipt };
}

async function observeJob({ storeRoot, batchRecord, member, page, version, assetsRoot }) {
  const batch = batchRecord.state;
  requireValue(uuid.test(member.jobId ?? ''), batchMismatch);
  const directory = path.join(storeRoot, member.jobId);
  const jobRecord = await readRecord(directory, 128 * 1024), job = jobRecord.state;
  requireValue(job?.version === 1 && job.id === member.jobId && job.batchId === batch.id && job.retryOf == null &&
    job.owner === batch.owner && job.projectId === batch.projectId && job.pageId === member.pageId &&
    job.pageNumber === member.pageNumber && job.sourceSha256 === page.sourceSha256 && job.mime === 'image/png' &&
    Number.isSafeInteger(job.sequence) && job.sequence > 0 &&
    ['queued', 'running', 'completed', 'failed', 'cancelled', 'result_unknown'].includes(job.status), jobMismatch);
  const source = await readBounded(path.join(directory, 'source.png'), JOB_LIMITS.inputBytes);
  requireValue(matchesFirstImagePng(source, job.sourceSha256), 'FIRST_IMAGE_CAPTURE_SOURCE_MISMATCH');
  const unconfirmed = job.recovery?.type === 'cleanup_unknown' || job.errorCode === 'RETRY_COMMIT_UNKNOWN';
  const view = unconfirmed ? 'RESULT_UNKNOWN' : reviewState.pageReviewState(job);
  const done = view === 'CANDIDATE_READY' ? await completedPng(directory, job) : null;
  await verifyRecord(jobRecord);
  await emitAsset(assetsRoot, page.sourceSha256, source);
  if (done) await emitAsset(assetsRoot, done.receipt.candidateSha256, done.png);
  const reason = done ? null : identifier(job.errorCode) ? job.errorCode : view === 'RESULT_UNKNOWN' ? 'RESULT_UNKNOWN' : `FIRST_JOB_${job.status.toUpperCase()}`;
  const proof = { pageId: page.pageId, version, sourceSha256: page.sourceSha256, batchId: batch.id, batchSha256: batchRecord.sha256,
    jobId: job.id, generation: job.sequence, jobStateSha256: jobRecord.sha256, jobStatus: job.status, reviewState: view, reason,
    engineReceipt: done?.receipt ?? null };
  const status = done ? 'completed' : job.status === 'failed' && view !== 'RESULT_UNKNOWN'
    ? ['NEEDS_REVIEW', 'PARTIAL'].includes(view) ? 'held' : 'failed' : null;
  const firstRun = status && { pageId: page.pageId, version, sourceSha256: page.sourceSha256, status, attempt: 1,
    receiptSha256: contentSha256(proof), pngSha256: done?.receipt.candidateSha256 ?? null, reason };
  return { proof, firstRun };
}

/** Capture from a coordinator's two isolated stores. The batch file contains the job originally admitted for each page. */
export async function captureFirstImageRuns({ cohort, pins, stores, notRun = [], outputDirectory }) {
  const { cohortSha256 } = pins ?? {};
  summarizeFirstImagePairs({ cohort, firstRuns: [], reviews: [] }, { cohortSha256, firstRunsSha256: contentSha256([]) });
  requireValue(Array.isArray(stores) && stores.length === 2 && Array.isArray(notRun) && isAbsolute(outputDirectory), invalid);
  const pagesBySource = new Map(cohort.pages.map(page => [page.sourceSha256, page]));
  const pagesById = new Map(cohort.pages.map(page => [page.pageId, page]));
  const root = path.resolve(outputDirectory);
  const storeRoots = new Set(), seenVersions = new Set();
  for (const store of stores) {
    keys(store, ['version', 'storeRoot', 'batches'], invalid);
    const { version, storeRoot, batches } = store;
    requireValue(versions.includes(version) && !seenVersions.has(version) && isAbsolute(storeRoot) && Array.isArray(batches), invalid);
    const canonical = path.resolve(storeRoot);
    await regularDirectory(canonical);
    requireValue(!inside(canonical, root) && !storeRoots.has(pathKey(canonical)), invalid);
    storeRoots.add(pathKey(canonical));
    seenVersions.add(version);
  }
  await regularDirectory(path.dirname(root));
  await mkdir(root, { mode: 0o700 });
  const assetsRoot = path.join(root, 'assets');
  await mkdir(assetsRoot, { mode: 0o700 });
  const observations = new Map(), firstRuns = [];
  for (const { version, storeRoot, batches } of stores) {
    const directory = path.join(storeRoot, 'batches');
    for (const binding of batches) {
      keys(binding, ['batchId', 'batchSha256', 'workId'], invalid);
      const { batchId, batchSha256, workId } = binding;
      requireValue(uuid.test(batchId ?? '') && digest(batchSha256) && identifier(workId), invalid);
      await regularDirectory(directory);
      const batchRecord = await readRecord(path.join(directory, batchId), 256 * 1024), batch = batchRecord.state;
      requireValue(batchRecord.sha256 === batchSha256 && batch?.id === batchId && batch.version === 1 &&
        batch.status === 'accepted' && digest(batch.owner) && identifier(batch.projectId) &&
        Array.isArray(batch.pages) && batch.pages.length > 0, batchMismatch);
      for (const member of batch.pages) {
        const page = pagesBySource.get(member?.sourceSha256);
        requireValue(page?.workId === workId && identifier(member.pageId) && Number.isSafeInteger(member.pageNumber) && member.pageNumber > 0, batchMismatch);
        if (page.kind !== 'typeset') continue;
        const key = keyOf({ pageId: page.pageId, version });
        requireValue(!observations.has(key), batchMismatch);
        const { proof, firstRun } = await observeJob({ storeRoot, batchRecord, member, page, version, assetsRoot });
        observations.set(key, proof);
        if (firstRun) firstRuns.push(firstRun);
      }
      await verifyRecord(batchRecord);
    }
  }
  const plannedNotRun = new Set();
  for (const declaration of notRun) {
    keys(declaration, ['pageId', 'version', 'reason'], invalid);
    const { pageId, version, reason } = declaration, page = pagesById.get(pageId), key = keyOf(declaration);
    requireValue(page?.kind === 'typeset' && versions.includes(version) && identifier(reason), invalid);
    requireValue(!observations.has(key) && !plannedNotRun.has(key), 'FIRST_IMAGE_CAPTURE_NOT_RUN_CONFLICT');
    plannedNotRun.add(key);
    firstRuns.push({ pageId, version, sourceSha256: page.sourceSha256, status: 'not_run', attempt: null,
      receiptSha256: null, pngSha256: null, reason });
  }
  const result = { schemaVersion: 1, kind: 'first-image-capture', assetsRoot, cohortSha256, firstRunsSha256: contentSha256(firstRuns),
    firstRuns, observations: [...observations.values()] };
  await atomicState(root, result, 'first-runs.json');
  return result;
}
