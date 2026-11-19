import { createHmac } from 'node:crypto';
import { contentSha256, isBilingualHumanReviewer } from './dataset-contract.mjs';
import { digest, equal, identifier, keys, object, requireValue } from './offline/contract.mjs';
import { verifiedMatrix } from './stage16-experiment-lock.mjs';

const lockMismatch = 'STAGE16_REVIEW_LOCK_MISMATCH';
const protocolMismatch = 'STAGE16_REVIEW_PROTOCOL_MISMATCH';
const observationMismatch = 'STAGE16_REVIEW_OBSERVATION_MISMATCH';
const invalidReviewers = 'STAGE16_REVIEWERS_NOT_INDEPENDENT';
const invalidReturn = 'STAGE16_REVIEW_RETURN_MISMATCH';
const conflict = 'STAGE16_REVIEW_RETURN_CONFLICT';
const questions = {
  semanticFidelity: '어느 쪽이 원문과 문맥의 의미를 더 충실하게 전달하나요?',
  naturalness: '어느 쪽의 한국어가 더 자연스럽게 읽히나요?',
};
const axes = Object.keys(questions);
const choices = ['A', 'B', 'tie', 'cannot_assess'];

function checkPin(value, expected, code) {
  requireValue(object(value) && digest(expected) && contentSha256(value) === expected, code);
}

function checkRegistration({ lock, preregistration, manifest, protocol }, anchors, seed) {
  requireValue(lock?.status === 'locked' && lock.lockId === anchors?.lockId, lockMismatch);
  checkPin(lock.record, anchors?.lockId, lockMismatch);
  const record = lock.record;
  requireValue(record.kind === 'stage16-experiment-lock' && record.schemaVersion === 1 &&
    Array.isArray(record.samples) && record.samples.length > 0, lockMismatch);
  checkPin(preregistration, record.preregistrationSha256, lockMismatch);
  checkPin(manifest, record.manifestSha256, lockMismatch);
  checkPin(protocol, preregistration.blind_randomized_human_review, protocolMismatch);
  const fields = ['schemaVersion', 'reviewerIds', 'overlapPageCount', 'seedSha256'];
  keys(protocol, fields, protocolMismatch);
  requireValue(fields.every(key => Object.hasOwn(protocol, key)) && protocol.schemaVersion === 1 &&
    Number.isSafeInteger(protocol.overlapPageCount) && protocol.overlapPageCount > 0 &&
    protocol.overlapPageCount <= record.samples.length && digest(seed) && contentSha256(seed) === protocol.seedSha256,
  protocolMismatch);

  const ids = protocol.reviewerIds;
  requireValue(Array.isArray(ids) && ids.length === 2 && ids.every(identifier) && ids[0] !== ids[1], invalidReviewers);
  const reviewers = ids.map(id => manifest.reviewers.find(r => r.reviewerId === id));
  requireValue(reviewers.every(isBilingualHumanReviewer) && reviewers[0].independenceGroup !== reviewers[1].independenceGroup,
    invalidReviewers);
  return reviewers.map(({ reviewerId, independenceGroup }) => ({ reviewerId, independenceGroup }));
}

function cellResult(cell, sample, condition) {
  requireValue(cell?.workId === sample.workId && cell.matrixSha256 === sample.matrixSha256 &&
    equal(cell.condition, condition) && Array.isArray(cell.jobs) && cell.jobs.length > 0, observationMismatch);
  const jobs = cell.jobs.map(job => {
    requireValue(identifier(job?.jobId), observationMismatch);
    if (job.status === 'succeeded') {
      const last = job.stages?.at(-1);
      requireValue(digest(job.resultSha256) && last?.stage === 'TYPESET' && last.status === 'succeeded' &&
        last.resultSha256 === job.resultSha256 && digest(job.receiptSha256), observationMismatch);
    } else {
      requireValue(job.resultSha256 === null && identifier(job.reason), observationMismatch);
    }
    const { jobId, receiptSha256, evidenceKind, status, reason, resultSha256 } = job;
    return { jobId, receiptSha256, evidenceKind, status, reason, resultSha256 };
  });
  requireValue(cell.completed === jobs.every(j => j.status === 'succeeded'), observationMismatch);
  const pins = new Set(jobs.map(j => j.resultSha256));
  // The frozen comparison cannot select the most favorable of several different finished outputs.
  const reason = !cell.completed ? 'INCOMPLETE_CELL' : pins.size > 1 ? 'MULTIPLE_FINAL_RESULTS' : null;
  return { resultSha256: reason === null ? jobs[0].resultSha256 : null, reason, jobs };
}

function frozenPairs({ lock, matrices, observations }, anchors) {
  checkPin(observations, anchors.observationsSha256, observationMismatch);
  const samples = lock.record.samples;
  requireValue(observations.kind === 'stage16-execution-observations' && observations.schemaVersion === 1 &&
    observations.lockId === lock.lockId && digest(anchors.jobsSha256) && observations.jobsSha256 === anchors.jobsSha256 &&
    Array.isArray(matrices) && matrices.length === samples.length &&
    Array.isArray(observations.cells) && observations.cells.length === 4 * samples.length, observationMismatch);
  const byPage = new Map(matrices.map(verifiedMatrix).map(m => [m.shared.pageId, m]));
  const cellKey = (pageId, c) => JSON.stringify([pageId, c.model, c.processing]);
  const cells = new Map(observations.cells.map(cell => [cellKey(cell.pageId, cell.condition), cell]));
  const pairs = [];
  for (const sample of samples) {
    const { workId, pageId, matrixSha256, sourceSha256, contextSnapshotSha256 } = sample;
    const matrix = byPage.get(pageId);
    requireValue(matrix?.matrixSha256 === matrixSha256 && matrix.shared.workId === workId &&
      matrix.shared.sourceSha256 === sourceSha256 && matrix.shared.contextSnapshotSha256 === contextSnapshotSha256, observationMismatch);
    byPage.delete(pageId);
    for (const model of ['A', 'B']) {
      const results = {};
      for (const condition of matrix.conditions.filter(c => c.model === model)) {
        const key = cellKey(pageId, condition);
        results[condition.processing] = cellResult(cells.get(key), sample, condition);
        cells.delete(key);
      }
      pairs.push({ workId, pageId, model, matrixSha256, sourceSha256, contextSnapshotSha256, results, assignments: [] });
    }
  }
  requireValue(cells.size === 0 && byPage.size === 0, observationMismatch);
  return pairs;
}

function ranked(items, rank) {
  return items.map(item => ({ item, key: rank(item) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(row => row.item);
}

/** Coordinator only. The committed 32-byte secret determines the draw before any result is known. */
export function prepareStage16BlindReview(input, anchors, seed) {
  const reviewers = checkRegistration(input, anchors, seed);
  const pairs = frozenPairs(input, anchors);
  const { lockId, observationsSha256 } = anchors;
  const key = Buffer.from(seed, 'hex');
  const draw = (...parts) => createHmac('sha256', key).update(JSON.stringify([lockId, ...parts])).digest('hex');
  const bit = (...parts) => parseInt(draw(...parts).slice(0, 2), 16) % 2;
  const pages = input.lock.record.samples.map(s => s.pageId);
  const overlap = new Set(ranked(pages, page => draw('overlap', page)).slice(0, input.protocol.overlapPageCount));
  const singles = ranked(pairs.filter(p => !overlap.has(p.pageId)), p => draw('owner', p.pageId, p.model));
  const offset = bit('first-owner');
  const owners = new Map(singles.map((p, i) => [p, reviewers[(i + offset) % 2].reviewerId]));

  for (const { reviewerId } of reviewers) {
    const assigned = pairs.filter(p => overlap.has(p.pageId) || owners.get(p) === reviewerId);
    // Randomized, balanced positions per reader. Queue order uses an independent draw.
    const order = ranked(assigned, p => draw('position', reviewerId, p.pageId, p.model));
    const baselineFirst = Math.floor((order.length + bit('odd-position', reviewerId)) / 2);
    for (const [i, pair] of order.entries()) {
      // A ticket from another observation snapshot cannot be returned against a changed result.
      const id = draw('ticket', observationsSha256, reviewerId, pair.pageId, pair.model);
      const ref = role => draw('reference', id, role);
      pair.assignments.push({ reviewerId, assignmentId: id, queueKey: draw('queue', reviewerId, pair.pageId, pair.model),
        sourceRef: ref('source'), contextRef: ref('context'),
        A: { ref: ref('A'), processing: i < baselineFirst ? 'baseline' : 'improved' },
        B: { ref: ref('B'), processing: i < baselineFirst ? 'improved' : 'baseline' } });
    }
  }
  const seal = { schemaVersion: 1, kind: 'stage16-blind-assignment', lockId, observationsSha256,
    protocolSha256: input.preregistration.blind_randomized_human_review, reviewers, pairs };
  return { seal, sealSha256: contentSha256(seal) };
}

function checkSeal(seal, expected) {
  checkPin(seal, expected, 'STAGE16_REVIEW_SEAL_MISMATCH');
  requireValue(seal.kind === 'stage16-blind-assignment' && seal.schemaVersion === 1, 'STAGE16_REVIEW_SEAL_MISMATCH');
}
const available = pair => pair.results.baseline.resultSha256 !== null && pair.results.improved.resultSha256 !== null;

function reviewerItem(a) {
  return { assignmentId: a.assignmentId, sourceRef: a.sourceRef, contextRef: a.contextRef, A: a.A.ref, B: a.B.ref };
}

/** The only reviewer-facing projection. Each reference resolves through the coordinator's private seal. */
export function stage16ReviewerPacket(seal, expectedSealSha256, reviewerId) {
  checkSeal(seal, expectedSealSha256);
  requireValue(seal.reviewers.some(r => r.reviewerId === reviewerId), 'STAGE16_UNKNOWN_REVIEWER');
  const mine = seal.pairs.filter(available).flatMap(p => p.assignments.filter(a => a.reviewerId === reviewerId));
  const items = ranked(mine, a => a.queueKey).map(reviewerItem);
  return { questions: { ...questions }, choices: [...choices], items };
}

function returnedAnswers(seal, envelopes) {
  requireValue(Array.isArray(envelopes), invalidReturn);
  const tickets = new Map(seal.pairs.filter(available).flatMap(p => p.assignments.map(a => [a.assignmentId, a])));
  const answers = new Map();
  for (const envelope of envelopes) {
    keys(envelope, ['reviewerId', 'evidenceKind', 'responses'], invalidReturn);
    const { reviewerId, evidenceKind, responses } = envelope;
    requireValue(Object.keys(envelope).length === 3 && seal.reviewers.some(r => r.reviewerId === reviewerId) &&
      ['synthetic', 'human_submission'].includes(evidenceKind) && Array.isArray(responses), invalidReturn);
    for (const response of responses) {
      const id = response?.assignmentId, ticket = tickets.get(id);
      requireValue(ticket?.reviewerId === reviewerId, invalidReturn);
      const shown = reviewerItem(ticket);
      keys(response, [...Object.keys(shown), ...axes], invalidReturn);
      requireValue(Object.entries(shown).every(([k, v]) => Object.hasOwn(response, k) && response[k] === v), invalidReturn);
      const submitted = axes.filter(axis => Object.hasOwn(response, axis) && response[axis] !== null);
      const saved = answers.get(id) ?? { evidenceKind };
      requireValue(saved.evidenceKind === evidenceKind, conflict);
      for (const axis of submitted) {
        requireValue(choices.includes(response[axis]), invalidReturn);
        requireValue(!Object.hasOwn(saved, axis) || saved[axis] === response[axis], conflict);
        saved[axis] = response[axis];
      }
      answers.set(id, saved);
    }
  }
  return answers;
}

function readAssignment(a, issued, response) {
  const answered = axes.filter(axis => response && Object.hasOwn(response, axis)).length;
  const missing = !issued ? 'RESULT_PAIR_UNAVAILABLE' : !response ? 'NO_RESPONSE' : answered ? 'AXIS_UNANSWERED' : 'BLANK_RETURN';
  const readAxis = axis => {
    const choice = response?.[axis] ?? null;
    if (choice === null) return { choice, preference: null, reason: missing };
    if (choice === 'cannot_assess') return { choice, preference: null, reason: 'REVIEWER_CANNOT_ASSESS' };
    return { choice, preference: choice === 'tie' ? 'tie' : a[choice].processing, reason: null };
  };
  const status = !issued ? 'unavailable' : ['unanswered', 'partial', 'answered'][answered];
  return { assignmentId: a.assignmentId, reviewerId: a.reviewerId, status, evidenceKind: response?.evidenceKind ?? null,
    semanticFidelity: readAxis('semanticFidelity'), naturalness: readAxis('naturalness') };
}

function compare(assigned, axis) {
  if (assigned.length === 1) return 'not_overlapped';
  const [first, second] = assigned.map(a => a[axis].preference);
  if (first === null || second === null) return 'not_comparable';
  return first === second ? 'agree' : 'open_disagreement';
}

/** Private audit. Envelopes carry the collector's reviewer attribution; no human identity is authenticated here. */
export function collectStage16BlindReturns(seal, expectedSealSha256, envelopes) {
  checkSeal(seal, expectedSealSha256);
  const answers = returnedAnswers(seal, envelopes);
  const summary = { plannedPairs: seal.pairs.length, overlapPairs: 0, plannedAssignments: 0,
    issuedAssignments: 0, answered: 0, partial: 0, unanswered: 0, unavailable: 0 };
  const pairs = seal.pairs.map(pair => {
    const issued = available(pair);
    const assignments = pair.assignments.map(a => readAssignment(a, issued, answers.get(a.assignmentId)));
    summary.overlapPairs += Number(assignments.length === 2);
    summary.plannedAssignments += assignments.length;
    if (issued) summary.issuedAssignments += assignments.length;
    for (const a of assignments) summary[a.status]++;
    return { workId: pair.workId, pageId: pair.pageId, model: pair.model, results: structuredClone(pair.results), assignments,
      comparison: { semanticFidelity: compare(assignments, 'semanticFidelity'), naturalness: compare(assignments, 'naturalness') } };
  });
  return { schemaVersion: 1, kind: 'stage16-blind-returns', lockId: seal.lockId, sealSha256: expectedSealSha256,
    observationsSha256: seal.observationsSha256, reviewerAuthentication: 'unverified_offline_submission', pairs, summary };
}
