import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { contentSha256 } from '../../packages/evaluation/dataset-contract.mjs';
import { prepareFirstImageBlindReview, firstImageReviewerPacket, readFirstImageReviewPng,
  collectFirstImageBlindReturns } from '../../packages/evaluation/first-image-blind-review.mjs';

const seed = 'b'.repeat(64);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const allPass = { coverageAndOrder: 'pass', translationMeaning: 'pass', artworkAndRemoval: 'pass', typesettingLegibility: 'pass' };

async function fixture() {
  const input = { cohort: { evidenceKind: 'synthetic', pages: [] }, firstRuns: [] };
  const assets = new Map();
  async function makePng(red) {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: red, g: 247, b: 165 } } }).png().toBuffer();
    const digest = sha(bytes);
    assets.set(digest, bytes);
    return digest;
  }
  for (let i = 0; i < 4; i++) {
    const pageId = 'example-page-' + i, sourceSha256 = await makePng(i * 30);
    input.cohort.pages.push({ pageId, workId: 'example-work-' + i % 2, sourceSha256, kind: 'typeset',
      annotationSha256: contentSha256({ pageId, sourceSha256 }), reviewerIds: ['reader-a', 'reader-b'] });
    for (const version of ['baseline', 'improved']) {
      const status = i === 3 ? 'not_run' : i === 2 && version === 'baseline' ? 'held' : 'completed';
      input.firstRuns.push({ pageId, version, sourceSha256, status, attempt: status === 'not_run' ? null : 1,
        receiptSha256: status === 'not_run' ? null : contentSha256({ pageId, version }),
        pngSha256: status === 'completed' ? await makePng(i * 30 + (version === 'baseline' ? 5 : 10)) : null,
        reason: status === 'completed' ? null : status === 'held' ? 'LAYOUT_REVIEW_REQUIRED' : 'TEST_CAPACITY' });
    }
  }
  const pins = { cohortSha256: contentSha256(input.cohort), firstRunsSha256: contentSha256(input.firstRuns), seedSha256: contentSha256(seed) };
  return { input, pins, assets };
}

test('issues opaque, balanced version positions from frozen pages and retains the sole available result', async () => {
  const { input, pins } = await fixture();
  const { seal, sealSha256 } = prepareFirstImageBlindReview(input, pins, seed);
  assert.deepEqual(prepareFirstImageBlindReview(input, pins, seed), { seal, sealSha256 });
  const packet = firstImageReviewerPacket(seal, sealSha256, 'reader-a');
  assert.equal(packet.items.length, 3);
  assert.deepEqual(packet.items.map(item => item.images.length).sort(), [1, 2, 2]);
  assert.deepEqual(Object.keys(packet.questions).sort(), Object.keys(allPass).sort());
  const serialized = JSON.stringify(packet);
  for (const value of ['baseline', 'improved', 'example-page-', 'example-work-', 'reader-b', ...input.firstRuns.map(row => row.pngSha256).filter(Boolean)]) {
    assert.ok(!serialized.includes(value));
  }
  const other = firstImageReviewerPacket(seal, sealSha256, 'reader-b');
  assert.ok(packet.items.every(item => !other.items.some(row => row.assignmentId === item.assignmentId || row.sourceRef === item.sourceRef)));
  const positions = seal.assignments.filter(row => row.reviewerId === 'reader-a' && row.images.length === 2).map(row => row.images[0].version).sort();
  assert.deepEqual(positions, ['baseline', 'improved']);
  assert.throws(() => prepareFirstImageBlindReview(input, pins, 'a'.repeat(64)), { code: 'FIRST_IMAGE_REVIEW_SEED_MISMATCH' });
});

test('returns only the committed PNG bytes for the assigned reviewer and reference', async () => {
  const { input, pins, assets } = await fixture();
  const { seal, sealSha256 } = prepareFirstImageBlindReview(input, pins, seed);
  const item = firstImageReviewerPacket(seal, sealSha256, 'reader-a').items.find(row => row.images.length === 2);
  const privateItem = seal.assignments.find(row => row.assignmentId === item.assignmentId);
  for (const [ref, digest] of [[item.sourceRef, privateItem.sourceSha256], ...privateItem.images.map(row => [row.ref, row.pngSha256])]) {
    const bytes = await readFirstImageReviewPng(seal, sealSha256, 'reader-a', ref, async sha256 => assets.get(sha256));
    assert.equal(sha(bytes), digest);
  }
  await assert.rejects(readFirstImageReviewPng(seal, sealSha256, 'reader-b', item.sourceRef, async () => null),
    { code: 'FIRST_IMAGE_REVIEW_REFERENCE_INVALID' });
  const wrong = assets.get(privateItem.images[1].pngSha256);
  await assert.rejects(readFirstImageReviewPng(seal, sealSha256, 'reader-a', item.images[0].ref, async () => wrong),
    { code: 'FIRST_IMAGE_REVIEW_PNG_MISMATCH' });
});

test('maps blind answers to the exact first run while held and unrun pages remain in both denominators', async () => {
  const { input, pins } = await fixture();
  const { seal, sealSha256 } = prepareFirstImageBlindReview(input, pins, seed);
  const returns = ['reader-a', 'reader-b'].map(reviewerId => ({ reviewerId, responses: seal.assignments.filter(row => row.reviewerId === reviewerId)
    .flatMap(item => item.images.map(image => {
      const omission = item.pageId === 'example-page-0' && image.version === 'baseline';
      return { assignmentId: item.assignmentId, imageRef: image.ref,
        ratings: { ...allPass, coverageAndOrder: omission ? 'fail' : 'pass' },
        defects: omission ? [{ axis: 'coverageAndOrder', type: 'omission', severity: 'major', location: '오른쪽 첫 말풍선' }] : [] };
    })) }));
  const report = collectFirstImageBlindReturns({ ...input, seal, returns }, { ...pins, sealSha256 });
  assert.equal(report.reviewerAuthentication, 'unverified_offline_submission');
  assert.equal(report.evidenceKind, 'synthetic');
  assert.deepEqual(report.total.baseline.noEditRate, { numerator: 1, denominator: 4, value: .25, reason: null });
  assert.deepEqual(report.total.improved.noEditRate, { numerator: 3, denominator: 4, value: .75, reason: null });
  assert.deepEqual(report.total.baseline.defects.byType, [{ axis: 'coverageAndOrder', type: 'omission', pages: 1, reviewerPageReports: 2 }]);
  assert.deepEqual(report.total.improved.defects.byType, []);
});

test('rejects changed seals, runs, other reviewers’ references and duplicate PNG answers', async () => {
  const { input, pins } = await fixture();
  const { seal, sealSha256 } = prepareFirstImageBlindReview(input, pins, seed);
  const { items: [item] } = firstImageReviewerPacket(seal, sealSha256, 'reader-a');
  const { items: [other] } = firstImageReviewerPacket(seal, sealSha256, 'reader-b');
  const response = { assignmentId: item.assignmentId, imageRef: item.images[0].ref, ratings: allPass };
  const payload = { ...input, seal, returns: [{ reviewerId: 'reader-a', responses: [response] }] };
  const frozen = { ...pins, sealSha256 };
  const editedSeal = structuredClone(seal);
  editedSeal.assignments[0].images[0].version = 'later';
  assert.throws(() => collectFirstImageBlindReturns({ ...payload, seal: editedSeal }, frozen), { code: 'FIRST_IMAGE_REVIEW_SEAL_MISMATCH' });
  response.imageRef = other.images[0].ref;
  assert.throws(() => collectFirstImageBlindReturns(payload, frozen), { code: 'FIRST_IMAGE_REVIEW_RETURN_INVALID' });
  response.imageRef = item.images[0].ref;
  payload.returns[0].responses.push({ ...response });
  assert.throws(() => collectFirstImageBlindReturns(payload, frozen), { code: 'FIRST_IMAGE_REVIEW_RETURN_INVALID' });
  payload.returns[0].responses.pop();
  payload.firstRuns = structuredClone(input.firstRuns);
  payload.firstRuns[0].receiptSha256 = 'd'.repeat(64);
  const foreignPins = { ...frozen, firstRunsSha256: contentSha256(payload.firstRuns) };
  assert.throws(() => collectFirstImageBlindReturns(payload, foreignPins), { code: 'FIRST_IMAGE_REVIEW_SEAL_MISMATCH' });

  const inherited = Object.assign(Object.create({ reviewerId: 'reader-a' }), { responses: [response] });
  assert.throws(() => collectFirstImageBlindReturns({ ...input, seal, returns: [inherited] }, frozen),
    { code: 'FIRST_IMAGE_REVIEW_RETURN_INVALID' });
});
