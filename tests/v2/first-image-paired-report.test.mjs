import assert from 'node:assert/strict';
import test from 'node:test';
import { contentSha256 } from '../../packages/evaluation/dataset-contract.mjs';
import { summarizeFirstImagePairs } from '../../packages/evaluation/first-image-paired-report.mjs';

const allPass = {
  coverageAndOrder: 'pass', translationMeaning: 'pass', artworkAndRemoval: 'pass', typesettingLegibility: 'pass',
};

function fixture(count, evidenceKind = 'synthetic') {
  return {
    cohort: {
      evidenceKind,
      pages: Array.from({ length: count }, (_, index) => ({
        workId: index % 2 ? 'work-b' : 'work-a', pageId: `page-${index}`,
        sourceSha256: contentSha256(['source', index]), annotationSha256: contentSha256(['annotation', index]),
        kind: 'typeset', reviewerIds: ['reader-a'],
      })),
    },
    firstRuns: [],
    reviews: [],
  };
}

function run(input, index, version, status = 'completed') {
  const { pageId, sourceSha256 } = input.cohort.pages[index];
  const record = {
    pageId, version, status, sourceSha256,
    attempt: status === 'not_run' ? null : 1,
    receiptSha256: status === 'not_run' ? null : contentSha256(['receipt', pageId, version]),
    pngSha256: status === 'completed' ? contentSha256(['png', pageId, version]) : null,
    reason: status === 'completed' ? null : 'FIXTURE_REASON',
  };
  input.firstRuns.push(record);
  return record;
}

function review(input, { pageId, version, pngSha256 }, ratings = allPass, reviewerId = 'reader-a') {
  const record = { pageId, version, pngSha256, reviewerId, evidenceKind: input.cohort.evidenceKind, ratings: { ...ratings } };
  input.reviews.push(record);
  return record;
}

function pins(input) {
  return { cohortSha256: contentSha256(input.cohort), firstRunsSha256: contentSha256(input.firstRuns) };
}

const summarize = input => summarizeFirstImagePairs(input, pins(input));

test('compares the same twenty planned pages, retaining held, failed and not-run cases', () => {
  const input = fixture(20);
  for (const [version, successful, held, failed] of [['baseline', 12, 4, 3], ['improved', 14, 3, 2]]) {
    for (let index = 0; index < 20; index++) {
      if (index < successful) review(input, run(input, index, version));
      else if (index < successful + held) run(input, index, version, 'held');
      else run(input, index, version, index < successful + held + failed ? 'failed' : 'not_run');
    }
  }

  const { evidenceKind, total, works } = summarize(input);
  assert.equal(evidenceKind, 'synthetic');
  assert.deepEqual(total.baseline.noEditRate, { numerator: 12, denominator: 20, value: 0.6, reason: null });
  assert.deepEqual(total.improved.noEditRate, { numerator: 14, denominator: 20, value: 0.7, reason: null });
  assert.deepEqual(total.baseline.statusCounts, { completed: 12, held: 4, failed: 3, not_run: 1, missing: 0 });
  assert.deepEqual(total.improved.statusCounts, { completed: 14, held: 3, failed: 2, not_run: 1, missing: 0 });
  assert.equal(total.deltaPercentagePoints, 10);
  assert.deepEqual(total.transitions, { bothPass: 12, gained: 2, lost: 0, neitherPass: 6, unresolved: 0 });
  assert.deepEqual(works.map(({ workId, result }) => [workId, result.deltaPercentagePoints]), [['work-a', 10], ['work-b', 10]]);
});

test('counts a grade failure separately from operational holds and records reversed transitions', () => {
  const input = fixture(2);
  review(input, run(input, 0, 'baseline'));
  review(input, run(input, 0, 'improved'), { ...allPass, artworkAndRemoval: 'fail' });
  run(input, 1, 'baseline', 'held');
  review(input, run(input, 1, 'improved'));

  const { total, pages } = summarize(input);
  assert.equal(total.deltaPercentagePoints, 0);
  assert.deepEqual(total.transitions, { bothPass: 0, gained: 1, lost: 1, neitherPass: 0, unresolved: 0 });
  assert.deepEqual(total.improved.axes.artworkAndRemoval, { pass: 1, fail: 1, unresolved: 0 });
  assert.equal(pages[0].improved.passes, false);
  assert.equal(pages[1].baseline.passes, false);
});

test('keeps disagreement, cannot-assess and missing input visible without a final rate', () => {
  const input = fixture(3);
  input.cohort.pages[0].reviewerIds.push('reader-b');
  const disputed = run(input, 0, 'baseline');
  review(input, disputed, { ...allPass, translationMeaning: 'fail' });
  review(input, disputed, allPass, 'reader-b');
  review(input, run(input, 1, 'baseline'), { ...allPass, typesettingLegibility: 'cannot_assess' });
  const partial = review(input, run(input, 2, 'baseline'));
  delete partial.ratings.coverageAndOrder;

  const { total, pages } = summarize(input);
  assert.equal(total.baseline.noEditRate.value, null);
  assert.equal(total.baseline.noEditRate.reason, 'UNRESOLVED_PAGES');
  assert.equal(total.baseline.noEditRate.denominator, 3);
  assert.equal(total.improved.statusCounts.missing, 3);
  assert.equal(total.deltaPercentagePoints, null);
  assert.equal(total.transitions.unresolved, 3);
  assert.equal(pages[0].baseline.axes.translationMeaning.reason, 'REVIEWER_DISAGREEMENT');
  assert.equal(pages[1].baseline.axes.typesettingLegibility.reason, 'REVIEWER_CANNOT_ASSESS');
  assert.equal(pages[2].baseline.axes.coverageAndOrder.reason, 'REVIEW_MISSING');
});

test('records an explicit not-run page and keeps unmeasured or non-typeset pages out of the rate', () => {
  const input = fixture(3, 'human_submission');
  input.cohort.pages[1].kind = 'no_text';
  input.cohort.pages[2].kind = 'annotation_only';
  run(input, 0, 'baseline', 'not_run');
  run(input, 0, 'improved', 'not_run');

  const { total, excludedPages } = summarize(input);
  assert.deepEqual(excludedPages, { no_text: 1, annotation_only: 1 });
  assert.deepEqual(total.baseline.noEditRate, { numerator: 0, denominator: 1, value: null, reason: 'NO_FIRST_RUNS' });
  assert.equal(total.deltaPercentagePoints, null);
  assert.equal(summarize(fixture(0)).total.improved.noEditRate.reason, 'EMPTY_DENOMINATOR');
});

test('rejects changes to the frozen roster and observations including a later capture of the attempt', () => {
  const input = fixture(1);
  const frozen = pins(input);
  input.cohort.pages[0].kind = 'no_text';
  assert.throws(() => summarizeFirstImagePairs(input, frozen), { code: 'FIRST_IMAGE_COHORT_MISMATCH' });
  input.cohort.pages[0].kind = 'typeset';
  const completed = run(input, 0, 'baseline');
  assert.throws(() => summarizeFirstImagePairs(input, frozen), { code: 'FIRST_IMAGE_RUNS_MISMATCH' });
  completed.attempt = 2;
  assert.throws(() => summarize(input), { code: 'INVALID_FIRST_IMAGE_RUN' });
  completed.attempt = 1;
  input.firstRuns.push({ ...completed });
  assert.throws(() => summarize(input), { code: 'INVALID_FIRST_IMAGE_RUN' });
  input.firstRuns.pop();
  completed.sourceSha256 = 'f'.repeat(64);
  assert.throws(() => summarize(input), { code: 'INVALID_FIRST_IMAGE_RUN' });
});

test('binds ratings to the first PNG, assigned reviewer and declared evidence kind', () => {
  const input = fixture(1, 'human_submission');
  const completed = run(input, 0, 'improved');
  const returned = review(input, completed);
  returned.pngSha256 = 'f'.repeat(64);
  assert.throws(() => summarize(input), { code: 'INVALID_FIRST_IMAGE_REVIEW' });
  returned.pngSha256 = completed.pngSha256;
  returned.reviewerId = 'reader-b';
  assert.throws(() => summarize(input), { code: 'INVALID_FIRST_IMAGE_REVIEW' });
  returned.reviewerId = 'reader-a';
  returned.evidenceKind = 'synthetic';
  assert.throws(() => summarize(input), { code: 'INVALID_FIRST_IMAGE_REVIEW' });
  returned.evidenceKind = 'human_submission';
  input.reviews.push({ ...returned });
  assert.throws(() => summarize(input), { code: 'INVALID_FIRST_IMAGE_REVIEW' });
});

test('keeps synthetic attribution and captured values when the input objects change', () => {
  const input = fixture(1);
  const completed = run(input, 0, 'baseline');
  const returned = review(input, completed);
  const report = summarizeFirstImagePairs(input, { ...pins(input), evidenceKind: 'human_submission', schemaVersion: 99 });
  completed.pngSha256 = 'f'.repeat(64);
  returned.ratings.coverageAndOrder = 'fail';

  assert.equal(report.evidenceKind, 'synthetic');
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.pages[0].baseline.run.pngSha256, returned.pngSha256);
  assert.equal(report.pages[0].baseline.assigned[0].ratings.coverageAndOrder, 'pass');
});

test('counts a reported defect once per page and preserves the individual locations and severities', () => {
  const input = fixture(2);
  input.cohort.pages[0].reviewerIds.push('reader-b');
  const baseline = run(input, 0, 'baseline');
  const fail = { ...allPass, coverageAndOrder: 'fail' };
  const omitted = { axis: 'coverageAndOrder', type: 'omission', severity: 'major', location: '오른쪽 컷 첫 말풍선' };
  const returned = review(input, baseline, fail);
  returned.defects = [omitted, { ...omitted, location: '오른쪽 컷 두 번째 말풍선' }];
  review(input, baseline, fail, 'reader-b').defects = [omitted, {
    axis: 'coverageAndOrder', type: 'reading_order', severity: 'minor', location: '아래 두 컷',
  }];
  review(input, run(input, 1, 'baseline'), { ...allPass, typesettingLegibility: 'fail' }).defects = [];
  const report = summarize(input);
  assert.deepEqual(report.total.baseline.defects, { fullyTypedPages: 1, unmeasuredPages: 1, byType: [
    { axis: 'coverageAndOrder', type: 'omission', pages: 1, reviewerPageReports: 2 },
    { axis: 'coverageAndOrder', type: 'reading_order', pages: 1, reviewerPageReports: 1 },
  ] });
  omitted.location = 'edited after collection';
  assert.equal(report.pages[0].baseline.assigned[0].defects[0].location, '오른쪽 컷 첫 말풍선');
});

test('validates typed defects and keeps missing detail distinct from an explicit clean review', () => {
  const input = fixture(2);
  review(input, run(input, 0, 'improved')).defects = [];
  const missingDetail = review(input, run(input, 1, 'improved'));
  assert.deepEqual(summarize(input).total.improved.defects, { fullyTypedPages: 1, unmeasuredPages: 1, byType: [] });
  const defect = { axis: 'typesettingLegibility', type: 'inside_artwork_damage', severity: 'critical', location: '첫 말풍선' };
  missingDetail.defects = [defect];
  assert.throws(() => summarize(input), { code: 'INVALID_FIRST_IMAGE_REVIEW' });
  defect.type = 'clipping';
  delete defect.location;
  assert.throws(() => summarize(input), { code: 'INVALID_FIRST_IMAGE_REVIEW' });
});
