import { characterErrors } from '../../../apps/desktop/scripts/evaluate-automation-quality.mjs';
import { annotationContentSha256, contentSha256 } from '../dataset-contract.mjs';
import { identifier, requireValue, ratio } from './contract.mjs';

function indexLines(lines, code) {
  requireValue(Array.isArray(lines), code);
  const indexed = new Map();
  for (const line of lines) {
    requireValue(identifier(line?.lineId) && !indexed.has(line.lineId), code);
    indexed.set(line.lineId, line);
  }
  return indexed;
}

function readParts(parts, output, usedSpans, code) {
  requireValue(Array.isArray(parts), code);
  return parts.map(part => {
    const line = output.get(part?.outputLineId);
    requireValue(line !== undefined, code);
    const chars = [...line.source];
    const explicit = part.start !== undefined || part.end !== undefined;
    const start = explicit ? part.start : 0, end = explicit ? part.end : chars.length;
    requireValue(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 &&
      start <= end && end <= chars.length && (!explicit || start < end), code);
    const used = usedSpans.get(line.lineId) ?? [];
    requireValue(!used.some(span => span.whole || !explicit || start < span.end && end > span.start), code);
    usedSpans.set(line.lineId, [...used, { start, end, whole: !explicit }]);
    return { text: chars.slice(start, end).join(''), start, order: line.readingOrder };
  });
}

/** Compare a verified source annotation and a separately pinned, reviewed output correspondence. */
export function summarizeTextCoverage({ annotation, inventory, comparison, stage02Page }) {
  const regionOcr = stage02Page?.ocr ?? null;
  const unmeasured = reason => ({ status: 'NOT_MEASURED', reason, regionOcr, byRole: null, byTag: null,
    detection: ratio(null, null, reason), nonblankRecognition: ratio(null, null, reason),
    completeReadablePage: null, completeCorrectPage: null, missingLineIds: null, blankLineIds: null,
    incorrectLineIds: null, duplicateLineIds: null, extraOutputLineIds: null, orderErrorLineIds: null });
  if (annotation?.status !== 'human_verified' || annotation.coverage?.ocr !== 'complete' ||
      annotation.coverage?.regions !== 'complete') return unmeasured('VERIFIED_TEXT_ANNOTATION_REQUIRED');
  if (!inventory || !comparison) return unmeasured('TEXT_COVERAGE_EVIDENCE_REQUIRED');

  const code = 'TEXT_COVERAGE_COMPARISON_INVALID';
  requireValue(annotation.pageId === inventory.pageId && annotation.sourceSha256 === inventory.sourceSha256 &&
    comparison.annotationSha256 === annotationContentSha256(annotation) &&
    comparison.inventorySha256 === contentSha256(inventory), code);
  const expected = indexLines(annotation.lines, code);
  const output = indexLines(inventory.lines, code);
  const matches = indexLines(comparison.matches, code);
  requireValue(expected.size === matches.size && [...output.values()].every(line => typeof line.source === 'string'), code);

  const byRole = new Map(), byTag = new Map(), usedSpans = new Map(), duplicates = new Set();
  const missingLineIds = [], blankLineIds = [], incorrectLineIds = [], duplicateLineIds = [], orders = [];
  let readable = 0, nonblank = 0, errors = 0, characters = 0;
  function countIn(groups, key, outcome) {
    requireValue(identifier(key), code);
    const counts = groups.get(key) ?? { expected: 0, detected: 0, missing: 0, blank: 0, incorrect: 0, duplicate: 0 };
    counts.expected++;
    for (const name of ['detected', 'missing', 'blank', 'incorrect', 'duplicate']) counts[name] += Number(outcome[name]);
    groups.set(key, counts);
  }

  for (const [lineId, line] of expected) {
    const match = matches.get(lineId);
    requireValue(match !== undefined, code);
    const parts = readParts(match.parts, output, usedSpans, code);
    const duplicateIds = match.duplicateOutputLineIds ?? [];
    requireValue(Array.isArray(duplicateIds), code);
    for (const id of duplicateIds) {
      requireValue(output.has(id) && !duplicates.has(id), code);
      duplicates.add(id);
    }
    const source = parts.map(part => part.text).join('');
    const detected = parts.length > 0, blank = detected && !source.trim();
    let incorrect = false;
    if (line.transcription?.status === 'readable') {
      requireValue(typeof line.transcription.text === 'string' && line.transcription.text.length > 0, code);
      readable++;
      if (detected && !blank) nonblank++;
      const difference = characterErrors(line.transcription.text, source);
      errors += difference.errors;
      characters += difference.referenceCharacters;
      incorrect = detected && !blank && difference.errors > 0;
    }
    if (!detected) missingLineIds.push(lineId);
    if (blank) blankLineIds.push(lineId);
    if (incorrect) incorrectLineIds.push(lineId);
    if (duplicateIds.length) duplicateLineIds.push(lineId);
    const outcome = { detected, missing: !detected, blank, incorrect, duplicate: duplicateIds.length > 0 };
    countIn(byRole, line.role, outcome);
    const tags = match.tags ?? [];
    requireValue(Array.isArray(tags) && new Set(tags).size === tags.length, code);
    for (const tag of tags) countIn(byTag, tag, outcome);
    if (detected && line.readingOrder?.status === 'verified' && Number.isSafeInteger(line.readingOrder.value) &&
        parts.every(part => Number.isSafeInteger(part.order))) {
      orders.push({ lineId, expected: line.readingOrder.value, actual: parts[0].order, start: parts[0].start });
    }
  }
  requireValue([...duplicates].every(id => !usedSpans.has(id)), code);
  const extraOutputLineIds = [...output.keys()].filter(id => !usedSpans.has(id) && !duplicates.has(id));
  const chronological = [...orders].sort((a, b) => a.actual - b.actual || a.start - b.start);
  orders.sort((a, b) => a.expected - b.expected);
  const orderErrorLineIds = orders.length ? orders.filter((line, index) => line !== chronological[index]).map(line => line.lineId) : null;
  return { status: 'MEASURED', reason: null, regionOcr, byRole: Object.fromEntries(byRole), byTag: Object.fromEntries(byTag),
    detection: ratio(expected.size - missingLineIds.length, expected.size), nonblankRecognition: ratio(nonblank, readable),
    characterErrorRate: ratio(errors, characters, 'NO_REFERENCE_CHARACTERS'), orderErrorLineIds,
    completeReadablePage: readable > 0 ? nonblank === readable : null,
    completeCorrectPage: readable > 0 ? nonblank === readable && incorrectLineIds.length === 0 : null,
    missingLineIds, blankLineIds, incorrectLineIds, duplicateLineIds, extraOutputLineIds };
}
