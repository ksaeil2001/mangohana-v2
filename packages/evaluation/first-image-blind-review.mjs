import { createHmac } from 'node:crypto';
import { contentSha256 } from './dataset-contract.mjs';
import { digest, hash, keys, requireValue, SEVERITIES } from './offline/contract.mjs';
import { FIRST_IMAGE_DEFECT_TYPES, FIRST_IMAGE_REVIEW_QUESTIONS, summarizeFirstImagePairs } from './first-image-paired-report.mjs';

const sealMismatch = 'FIRST_IMAGE_REVIEW_SEAL_MISMATCH';
const invalidReturn = 'FIRST_IMAGE_REVIEW_RETURN_INVALID';
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const slots = ['A', 'B'];

export function matchesFirstImagePng(bytes, sha256) {
  return Buffer.isBuffer(bytes) && bytes.length >= 33 && bytes.length <= 32 * 1024 * 1024 &&
    bytes.subarray(0, 8).equals(pngSignature) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' &&
    bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 && hash(bytes) === sha256;
}

function checkSeal(seal, expectedSha256) {
  requireValue(seal?.kind === 'first-image-blind-review' && seal.schemaVersion === 1 &&
    digest(expectedSha256) && contentSha256(seal) === expectedSha256, sealMismatch);
}

function ranked(items, rank) {
  return items.map(item => ({ item, key: rank(item) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(({ item }) => item);
}

/** Coordinator only. Eligibility, receipt provenance and reviewer independence are verified before the cohort is sealed. */
export function prepareFirstImageBlindReview({ cohort, firstRuns }, pins, seed) {
  const { cohortSha256, firstRunsSha256, seedSha256 } = pins ?? {};
  requireValue(digest(seed) && digest(seedSha256) && contentSha256(seed) === seedSha256, 'FIRST_IMAGE_REVIEW_SEED_MISMATCH');
  const { pages } = summarizeFirstImagePairs({ cohort, firstRuns, reviews: [] }, pins);
  const assignedReviewers = new Map(cohort.pages.filter(page => page.kind === 'typeset').map(page => [page.pageId, page.reviewerIds]));
  if (cohort.evidenceKind === 'human_submission') {
    requireValue([...assignedReviewers.values()].every(ids => ids.length === 2), 'FIRST_IMAGE_REVIEW_NEEDS_TWO_REVIEWERS');
  }
  const reviewerIds = [...new Set([...assignedReviewers.values()].flat())];
  const key = Buffer.from(seed, 'hex');
  const draw = (...parts) => createHmac('sha256', key)
    .update(JSON.stringify([cohortSha256, firstRunsSha256, ...parts])).digest('hex');
  const available = pages.map(({ pageId, sourceSha256, baseline, improved }) => ({ pageId, sourceSha256,
    images: [baseline, improved].filter(result => result.status === 'completed').map(result => result.run) }))
    .filter(page => page.images.length > 0);
  const assignments = [];
  for (const reviewerId of reviewerIds) {
    const mine = available.filter(page => assignedReviewers.get(page.pageId).includes(reviewerId));
    const order = ranked(mine, page => draw('side-order', reviewerId, page.pageId));
    const pairs = mine.filter(page => page.images.length === 2).length;
    const oddSide = parseInt(draw('odd-side', reviewerId).slice(0, 1), 16) % 2;
    const baselineFirst = Math.floor((pairs + oddSide) / 2);
    let pairPosition = 0;
    for (const { pageId, sourceSha256, images } of order) {
      const assignmentId = draw('assignment', reviewerId, pageId);
      const reverse = images.length === 2 && pairPosition >= baselineFirst;
      if (images.length === 2) pairPosition++;
      const results = reverse ? [...images].reverse() : images;
      const ref = slot => draw('image', assignmentId, slot);
      assignments.push({ reviewerId, assignmentId, pageId, sourceSha256, sourceRef: ref('source'),
        queueKey: draw('queue', assignmentId), images: results.map(({ version, pngSha256 }, i) => ({
          slot: slots[i], ref: ref(slots[i]), version, pngSha256,
        })) });
    }
  }
  const seal = { kind: 'first-image-blind-review', schemaVersion: 1, cohortSha256, firstRunsSha256, seedSha256, reviewerIds, assignments };
  return { seal, sealSha256: contentSha256(seal) };
}

/** Only opaque references and questions are sent to the reviewer. */
export function firstImageReviewerPacket(seal, sealSha256, reviewerId) {
  checkSeal(seal, sealSha256);
  requireValue(seal.reviewerIds.includes(reviewerId), 'FIRST_IMAGE_REVIEWER_UNKNOWN');
  const mine = seal.assignments.filter(row => row.reviewerId === reviewerId);
  return { reviewerId, questions: { ...FIRST_IMAGE_REVIEW_QUESTIONS }, choices: ['pass', 'fail', 'cannot_assess'],
    defectTypes: structuredClone(FIRST_IMAGE_DEFECT_TYPES), severities: [...SEVERITIES],
    items: ranked(mine, row => row.queueKey).map(({ assignmentId, sourceRef, images }) => ({
      assignmentId, sourceRef, images: images.map(({ slot, ref }) => ({ slot, ref })),
    })) };
}

/** Resolve a reference through the private seal and check the copy before it is shared. */
export async function readFirstImageReviewPng(seal, sealSha256, reviewerId, ref, readByDigest) {
  checkSeal(seal, sealSha256);
  requireValue(digest(ref), 'FIRST_IMAGE_REVIEW_REFERENCE_INVALID');
  let pngSha256;
  for (const assignment of seal.assignments) {
    if (assignment.reviewerId !== reviewerId) continue;
    pngSha256 = ref === assignment.sourceRef ? assignment.sourceSha256 : assignment.images.find(image => image.ref === ref)?.pngSha256;
    if (pngSha256) break;
  }
  requireValue(digest(pngSha256), 'FIRST_IMAGE_REVIEW_REFERENCE_INVALID');
  const bytes = await readByDigest(pngSha256);
  requireValue(matchesFirstImagePng(bytes, pngSha256), 'FIRST_IMAGE_REVIEW_PNG_MISMATCH');
  return bytes;
}

/** Returns are attributed by the local coordinator. They do not authenticate the reviewers. */
export function collectFirstImageBlindReturns({ cohort, firstRuns, seal, returns }, pins) {
  const { cohortSha256, firstRunsSha256, seedSha256, sealSha256 } = pins ?? {};
  checkSeal(seal, sealSha256);
  requireValue(seal.cohortSha256 === cohortSha256 && seal.firstRunsSha256 === firstRunsSha256 &&
    seal.seedSha256 === seedSha256, sealMismatch);
  const assignments = new Map(seal.assignments.map(row => [row.assignmentId, row]));
  const seen = new Set(), reviews = [];
  requireValue(Array.isArray(returns), invalidReturn);
  for (const envelope of returns) {
    keys(envelope, ['reviewerId', 'responses'], invalidReturn);
    const { reviewerId, responses } = envelope;
    requireValue(Object.keys(envelope).length === 2 && seal.reviewerIds.includes(reviewerId) && Array.isArray(responses), invalidReturn);
    for (const response of responses) {
      keys(response, ['assignmentId', 'imageRef', 'ratings', 'defects'], invalidReturn);
      requireValue(['assignmentId', 'imageRef', 'ratings'].every(field => Object.hasOwn(response, field)), invalidReturn);
      const { assignmentId, imageRef, ratings } = response;
      const defects = Object.hasOwn(response, 'defects') ? response.defects : null;
      const assignment = assignments.get(assignmentId);
      const image = assignment?.images.find(item => item.ref === imageRef);
      requireValue(assignment?.reviewerId === reviewerId && image && !seen.has(imageRef), invalidReturn);
      seen.add(imageRef);
      reviews.push({ pageId: assignment.pageId, version: image.version, reviewerId, pngSha256: image.pngSha256,
        evidenceKind: cohort.evidenceKind, ratings, defects });
    }
  }
  return { ...summarizeFirstImagePairs({ cohort, firstRuns, reviews }, pins), reviewSealSha256: sealSha256,
    reviewerAuthentication: 'unverified_offline_submission' };
}
