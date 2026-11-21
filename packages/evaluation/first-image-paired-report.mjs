import { contentSha256 } from './dataset-contract.mjs';
import { digest, identifier, keys, requireValue, ratio, SEMANTIC_ERRORS, IMAGE_ERRORS, TYPESETTING_ERRORS, SEVERITIES } from './offline/contract.mjs';

const versions = ['baseline', 'improved'];
export const FIRST_IMAGE_REVIEW_QUESTIONS = Object.freeze({
  coverageAndOrder: '대사와 내레이션이 빠짐없이 올바른 순서로 읽히나요?',
  translationMeaning: '인물 관계와 문장의 뜻이 원문과 문맥에 맞나요?',
  artworkAndRemoval: '그림, 테두리와 보존 대상 글이 유지되고 읽기를 방해하는 원문 잔상이 없나요?',
  typesettingLegibility: '일반 독서 크기와 모바일 폭에서 글자를 고치거나 확대하지 않고 읽을 수 있나요?',
});
export const FIRST_IMAGE_DEFECT_TYPES = Object.freeze({
  coverageAndOrder: Object.freeze(['omission', 'reading_order', 'duplicate_text', 'extra_text', 'ocr_unreadable']),
  translationMeaning: Object.freeze([...SEMANTIC_ERRORS]),
  artworkAndRemoval: Object.freeze([...IMAGE_ERRORS]),
  typesettingLegibility: Object.freeze([...TYPESETTING_ERRORS]),
});
const axes = Object.keys(FIRST_IMAGE_REVIEW_QUESTIONS);
const statuses = ['completed', 'held', 'failed', 'not_run'];
const choices = ['pass', 'fail', 'cannot_assess'];
const excludedKinds = ['no_text', 'annotation_only'];
const pairKey = (...parts) => JSON.stringify(parts);

function plannedPages(cohort) {
  const code = 'INVALID_FIRST_IMAGE_COHORT';
  keys(cohort, ['evidenceKind', 'pages'], code);
  requireValue(['human_submission', 'synthetic'].includes(cohort.evidenceKind) && Array.isArray(cohort.pages), code);
  const pages = new Map();
  const sourceDigests = new Set();
  for (const page of cohort.pages) {
    keys(page, ['pageId', 'workId', 'sourceSha256', 'annotationSha256', 'kind', 'reviewerIds'], code);
    const { pageId, workId, sourceSha256, annotationSha256, kind, reviewerIds } = page;
    requireValue(identifier(pageId) && identifier(workId) && !pages.has(pageId) &&
      digest(sourceSha256) && digest(annotationSha256) && !sourceDigests.has(sourceSha256) &&
      ['typeset', ...excludedKinds].includes(kind) && Array.isArray(reviewerIds) && reviewerIds.every(identifier) &&
      new Set(reviewerIds).size === reviewerIds.length && (kind !== 'typeset' || reviewerIds.length > 0), code);
    pages.set(pageId, page);
    sourceDigests.add(sourceSha256);
  }
  return pages;
}

function runsByPage(firstRuns, pages) {
  const code = 'INVALID_FIRST_IMAGE_RUN';
  const runs = new Map();
  for (const run of firstRuns) {
    keys(run, ['pageId', 'version', 'status', 'sourceSha256', 'attempt', 'receiptSha256', 'pngSha256', 'reason'], code);
    const { pageId, version, status, sourceSha256, attempt, receiptSha256, pngSha256, reason } = run;
    const key = pairKey(pageId, version);
    const page = pages.get(pageId);
    requireValue(page?.kind === 'typeset' && sourceSha256 === page.sourceSha256 && versions.includes(version) &&
      statuses.includes(status) && !runs.has(key), code);
    if (status === 'not_run') requireValue(attempt === null && receiptSha256 === null, code);
    else requireValue(attempt === 1 && digest(receiptSha256), code);
    if (status === 'completed') requireValue(digest(pngSha256) && reason === null, code);
    else requireValue(pngSha256 === null && identifier(reason), code);
    runs.set(key, { ...run });
  }
  return runs;
}

function reviewsByPage(reviews, pages, runs, expectedKind) {
  const code = 'INVALID_FIRST_IMAGE_REVIEW';
  const entries = new Map();
  requireValue(Array.isArray(reviews), code);
  for (const review of reviews) {
    keys(review, ['pageId', 'version', 'reviewerId', 'pngSha256', 'evidenceKind', 'ratings', 'defects'], code);
    const { pageId, version, reviewerId, pngSha256, evidenceKind, ratings, defects = null } = review;
    const key = pairKey(pageId, version, reviewerId);
    const run = runs.get(pairKey(pageId, version));
    keys(ratings, axes, code);
    requireValue(run?.status === 'completed' && pngSha256 === run.pngSha256 &&
      pages.get(pageId).reviewerIds.includes(reviewerId) && evidenceKind === expectedKind &&
      Object.values(ratings).every(choice => choice === null || choices.includes(choice)) && !entries.has(key), code);
    requireValue(defects === null || Array.isArray(defects), code);
    for (const defect of defects ?? []) {
      keys(defect, ['axis', 'type', 'severity', 'location'], code);
      const { axis, type, severity, location } = defect;
      requireValue(Object.keys(defect).length === 4 && axes.includes(axis) && FIRST_IMAGE_DEFECT_TYPES[axis].includes(type) && SEVERITIES.includes(severity) &&
        typeof location === 'string' && location.trim().length > 0 && location.length <= 240 && !/[\u0000-\u001f\u007f]/.test(location), code);
    }
    entries.set(key, { ratings: { ...ratings }, defects: structuredClone(defects) });
  }
  return entries;
}

function axisVerdict(assigned, axis) {
  const ratings = assigned.map(entry => entry.ratings?.[axis] ?? null);
  if (ratings.includes('pass') && ratings.includes('fail')) return { value: null, reason: 'REVIEWER_DISAGREEMENT' };
  if (ratings.includes('cannot_assess')) return { value: null, reason: 'REVIEWER_CANNOT_ASSESS' };
  if (ratings.includes(null)) return { value: null, reason: 'REVIEW_MISSING' };
  return { value: ratings[0], reason: null };
}

function pageVerdict(page, version, run, reviews) {
  if (!run) return { run: null, status: 'missing', axes: null, passes: null };
  if (run.status !== 'completed') return { run, status: run.status, axes: null, passes: false };
  const assigned = page.reviewerIds.map(reviewerId => ({
    reviewerId, ...(reviews.get(pairKey(page.pageId, version, reviewerId)) ?? { ratings: null, defects: null }),
  }));
  const grades = Object.fromEntries(axes.map(axis => [axis, axisVerdict(assigned, axis)]));
  const values = Object.values(grades).map(grade => grade.value);
  let passes = null;
  if (values.includes('fail')) passes = false;
  else if (values.every(value => value === 'pass')) passes = true;
  return { run, status: run.status, assigned, axes: grades, passes };
}

function summarizeDefects(pages, version) {
  let fullyTypedPages = 0, unmeasuredPages = 0;
  const counts = new Map();
  for (const { [version]: result } of pages) {
    if (result.status !== 'completed') continue;
    const fullyTyped = result.assigned.every(({ ratings, defects }) => defects !== null && axes.every(axis =>
      ratings[axis] === 'pass' || (ratings[axis] === 'fail' && defects.some(defect => defect.axis === axis))));
    if (fullyTyped) fullyTypedPages++;
    else unmeasuredPages++;
    const pageTypes = new Set();
    for (const { defects } of result.assigned) {
      const reviewerTypes = new Set();
      for (const { axis, type } of defects ?? []) {
        const key = pairKey(axis, type);
        // The same type can be described at several positions on this page.
        if (reviewerTypes.has(key)) continue;
        const count = counts.get(key) ?? { axis, type, pages: 0, reviewerPageReports: 0 };
        count.pages += Number(!pageTypes.has(key));
        count.reviewerPageReports++;
        counts.set(key, count);
        reviewerTypes.add(key);
        pageTypes.add(key);
      }
    }
  }
  const byType = [...counts.values()].sort((a, b) => b.pages - a.pages || b.reviewerPageReports - a.reviewerPageReports ||
    a.axis.localeCompare(b.axis) || a.type.localeCompare(b.type));
  return { fullyTypedPages, unmeasuredPages, byType };
}

function versionSummary(pages, version) {
  const statusCounts = Object.fromEntries([...statuses, 'missing'].map(status => [status, 0]));
  const grades = Object.fromEntries(axes.map(axis => [axis, { pass: 0, fail: 0, unresolved: 0 }]));
  let passed = 0;
  let unresolved = 0;
  for (const page of pages) {
    const result = page[version];
    statusCounts[result.status]++;
    passed += Number(result.passes === true);
    unresolved += Number(result.passes === null);
    if (result.axes) {
      for (const axis of axes) grades[axis][result.axes[axis].value ?? 'unresolved']++;
    }
  }
  const noEditRate = ratio(passed, pages.length);
  if (unresolved || pages.length > 0 && statusCounts.not_run === pages.length) {
    noEditRate.value = null;
    noEditRate.reason = unresolved ? 'UNRESOLVED_PAGES' : 'NO_FIRST_RUNS';
  }
  return { statusCounts, axes: grades, noEditRate, defects: summarizeDefects(pages, version) };
}

function transition({ baseline, improved }) {
  if (baseline.passes === null || improved.passes === null) return 'unresolved';
  if (baseline.passes !== improved.passes) return improved.passes ? 'gained' : 'lost';
  return baseline.passes ? 'bothPass' : 'neitherPass';
}

function compare(pages) {
  const baseline = versionSummary(pages, 'baseline');
  const improved = versionSummary(pages, 'improved');
  const transitions = { bothPass: 0, gained: 0, lost: 0, neitherPass: 0, unresolved: 0 };
  for (const page of pages) transitions[transition(page)]++;
  const deltaPercentagePoints = baseline.noEditRate.value !== null && improved.noEditRate.value !== null
    ? 100 * (improved.noEditRate.numerator - baseline.noEditRate.numerator) / pages.length : null;
  return { baseline, improved, transitions, deltaPercentagePoints };
}

/** Consumes a coordinator's frozen cohort and first-run manifest, plus mapped blind returns.
 * The coordinator verifies eligibility, receipt and PNG bytes, and reviewer attribution before collection.
 */
export function summarizeFirstImagePairs({ cohort, firstRuns, reviews }, pins) {
  const { cohortSha256, firstRunsSha256 } = pins ?? {};
  requireValue(cohort && digest(cohortSha256) && contentSha256(cohort) === cohortSha256, 'FIRST_IMAGE_COHORT_MISMATCH');
  requireValue(Array.isArray(firstRuns) && digest(firstRunsSha256) &&
    contentSha256(firstRuns) === firstRunsSha256, 'FIRST_IMAGE_RUNS_MISMATCH');
  const planned = plannedPages(cohort);
  const runs = runsByPage(firstRuns, planned);
  const returns = reviewsByPage(reviews, planned, runs, cohort.evidenceKind);
  const pages = [];
  const byWork = new Map();
  const excludedPages = Object.fromEntries(excludedKinds.map(kind => [kind, 0]));
  for (const page of planned.values()) {
    const { workId, pageId, sourceSha256, annotationSha256, kind } = page;
    if (kind !== 'typeset') {
      excludedPages[kind]++;
      continue;
    }
    const row = { workId, pageId, sourceSha256, annotationSha256 };
    for (const version of versions) row[version] = pageVerdict(page, version, runs.get(pairKey(pageId, version)), returns);
    if (!byWork.has(workId)) byWork.set(workId, []);
    byWork.get(workId).push(row);
    pages.push(row);
  }
  const works = Array.from(byWork, ([workId, workPages]) => ({ workId, result: compare(workPages) }));
  return { schemaVersion: 1, kind: 'first-image-paired-report', evidenceKind: cohort.evidenceKind,
    cohortSha256, firstRunsSha256, excludedPages, pages, total: compare(pages), works };
}
