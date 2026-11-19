import assert from 'node:assert/strict';
import test from 'node:test';
import { contentSha256 } from '../../packages/evaluation/dataset-contract.mjs';
import { prepareStage16BlindReview, stage16ReviewerPacket, collectStage16BlindReturns } from '../../packages/evaluation/stage16-blind-review.mjs';
import { readerIds, reviewScenario } from './fixtures/stage16-blind-review.mjs';
import { sha } from './fixtures/stage16-experiment.mjs';

function prepare(fixture = reviewScenario()) {
  return prepareStage16BlindReview(fixture.input, fixture.anchors, fixture.seed);
}
function packet({ seal, sealSha256 }, id = readerIds[0]) {
  return stage16ReviewerPacket(seal, sealSha256, id);
}
function collect({ seal, sealSha256 }, returns) {
  return collectStage16BlindReturns(seal, sealSha256, returns);
}
function reply(a, answers) {
  return { reviewerId: a.reviewerId, evidenceKind: 'synthetic',
    responses: [{ assignmentId: a.assignmentId, sourceRef: a.sourceRef, contextRef: a.contextRef,
      A: a.A.ref, B: a.B.ref, ...answers }] };
}
const rows = report => report.pairs.flatMap(pair => pair.assignments);
const leakCases = [
  ['model identities stay out of reviewer material', /modelId|modelSha256|providerId|model-[AB]|provider-[AB]/],
  ['version identifiers stay out of reviewer material', /modelVersion|synthetic-v1|profileDigest/],
  ['processing conditions stay out of reviewer material', /processing|baseline|improved/],
];
for (const [name, marker] of leakCases) test(name, () => {
  const form = packet(prepare());
  assert.ok(form.items.length > 0);
  assert.equal(marker.test(JSON.stringify(form)), false, 'reviewer packet contains ' + marker.source);
});

test('A does not always show the baseline to the same reviewer', () => {
  const assignments = rows(prepare().seal).filter(a => a.reviewerId === readerIds[0]);
  assert.deepEqual([...new Set(assignments.map(a => a.A.processing))].sort(), ['baseline', 'improved']);
});

test('one reviewer cannot supply both independent assignments', () => {
  const scenario = reviewScenario({ editProtocol: p => { p.reviewerIds[1] = p.reviewerIds[0]; } });
  assert.throws(() => prepare(scenario), { code: 'STAGE16_REVIEWERS_NOT_INDEPENDENT' });
});

test('opposite fidelity and naturalness choices are recovered separately', () => {
  const book = prepare(), a = rows(book.seal)[0];
  const result = rows(collect(book, [reply(a, { semanticFidelity: 'A', naturalness: 'B' })]))
    .find(row => row.assignmentId === a.assignmentId);
  assert.deepEqual([result.semanticFidelity.preference, result.naturalness.preference], [a.A.processing, a.B.processing]);
});

test('every planned assignment survives a completely empty return', () => {
  const audit = collect(prepare(), []);
  assert.equal(rows(audit).length, 6);
  assert.ok(rows(audit).every(row => row.status === 'unanswered' && row.semanticFidelity.preference === null &&
    row.naturalness.preference === null && row.semanticFidelity.reason === 'NO_RESPONSE'));
});

test('both packets contain only the two questions and unique opaque tickets bound to frozen sources and final results', () => {
  const fixture = reviewScenario(), book = prepare(fixture);
  const tokens = new Set();
  for (const id of readerIds) {
    const form = packet(book, id);
    assert.deepEqual(Object.keys(form).sort(), ['choices', 'items', 'questions']);
    assert.deepEqual(Object.keys(form.questions).sort(), ['naturalness', 'semanticFidelity']);
    assert.deepEqual(form.choices, ['A', 'B', 'tie', 'cannot_assess']);
    for (const item of form.items) {
      assert.deepEqual(Object.keys(item).sort(), ['A', 'B', 'assignmentId', 'contextRef', 'sourceRef']);
      for (const token of Object.values(item)) {
        assert.match(token, /^[a-f0-9]{64}$/);
        assert.ok(!tokens.has(token));
        tokens.add(token);
      }
      const pair = book.seal.pairs.find(p => p.assignments.some(a => a.assignmentId === item.assignmentId));
      const a = pair.assignments.find(a => a.assignmentId === item.assignmentId);
      const sample = fixture.input.lock.record.samples.find(s => s.pageId === pair.pageId);
      assert.deepEqual([pair.workId, pair.sourceSha256, pair.contextSnapshotSha256, pair.matrixSha256],
        [sample.workId, sample.sourceSha256, sample.contextSnapshotSha256, sample.matrixSha256]);
      assert.deepEqual([a.reviewerId, a.sourceRef, a.contextRef], [id, item.sourceRef, item.contextRef]);
      for (const side of ['A', 'B']) {
        const cell = fixture.input.observations.cells.find(c => c.pageId === pair.pageId &&
          c.condition.model === pair.model && c.condition.processing === a[side].processing);
        assert.equal(pair.results[a[side].processing].resultSha256, cell.jobs[0].resultSha256);
        assert.equal(item[side], a[side].ref);
      }
    }
  }
  assert.equal(tokens.size, 6 * 5);
  const internalPins = JSON.stringify([fixture.input.lock, fixture.input.preregistration, fixture.input.observations, fixture.seed]);
  assert.ok([...tokens].every(id => !internalPins.includes(id)));
  assert.throws(() => packet(book, 'unregistered-reader'), { code: 'STAGE16_UNKNOWN_REVIEWER' });
});

test('the same secret replays the sealed schedule and different committed secrets change actual A/B positions', () => {
  const fixture = reviewScenario(), firstBook = prepare(fixture);
  const { seal, sealSha256 } = JSON.parse(JSON.stringify(firstBook));
  assert.deepEqual(prepare(fixture), firstBook);
  assert.deepEqual(stage16ReviewerPacket(seal, sealSha256, readerIds[1]), packet(firstBook, readerIds[1]));
  assert.ok(!JSON.stringify(seal).includes(fixture.seed));
  const orders = new Map(), overlapPages = new Set();
  for (let i = 0; i < 8; i++) {
    const draw = prepare(reviewScenario({ seed: sha('synthetic draw ' + i) }));
    const overlap = draw.seal.pairs.filter(p => p.assignments.length === 2);
    assert.equal(overlap.length, 2);
    assert.equal(overlap[0].pageId, overlap[1].pageId);
    overlapPages.add(overlap[0].pageId);
    for (const id of readerIds) {
      const assigned = rows(draw.seal).filter(a => a.reviewerId === id);
      const n = assigned.filter(a => a.A.processing === 'baseline').length;
      assert.ok(Math.abs(n - (assigned.length - n)) <= 1);
    }
    for (const a of draw.seal.pairs.find(p => p.pageId === 'page-final' && p.model === 'A').assignments) {
      if (!orders.has(a.reviewerId)) orders.set(a.reviewerId, new Set());
      orders.get(a.reviewerId).add(a.A.processing);
    }
  }
  assert.equal(overlapPages.size, 2);
  assert.ok([...orders.values()].some(positions => positions.size === 2));
});

test('old lock, observation, manifest, protocol, job and secret commitments reject substitutions', () => {
  const fixture = reviewScenario();
  for (const [edit, code] of [
    [f => { f.input.lock.record.samples.reverse(); }, 'STAGE16_REVIEW_LOCK_MISMATCH'],
    [f => { f.anchors.lockId = sha('other lock'); }, 'STAGE16_REVIEW_LOCK_MISMATCH'],
    [f => { f.input.manifest.reviewers.at(-1).independenceGroup = 'other'; }, 'STAGE16_REVIEW_LOCK_MISMATCH'],
    [f => { f.input.preregistration.noninferiority_margins.naturalness = 9; }, 'STAGE16_REVIEW_LOCK_MISMATCH'],
    [f => { f.input.protocol.overlapPageCount = 2; }, 'STAGE16_REVIEW_PROTOCOL_MISMATCH'],
    [f => { f.seed = sha('replacement'); }, 'STAGE16_REVIEW_PROTOCOL_MISMATCH'],
    [f => { f.input.observations.cells[0].jobs[0].resultSha256 = sha('replacement'); }, 'STAGE16_REVIEW_OBSERVATION_MISMATCH'],
    [f => { f.anchors.jobsSha256 = sha('other register'); }, 'STAGE16_REVIEW_OBSERVATION_MISMATCH'],
  ]) {
    const changed = structuredClone(fixture);
    edit(changed);
    assert.throws(() => prepare(changed), { code });
  }
});

test('foreign observations, missing cells and duplicate model conditions cannot replace frozen pairs', () => {
  const fixture = reviewScenario();
  for (const edit of [
    o => { o.lockId = sha('another experiment'); },
    o => { o.cells.pop(); },
    o => { o.cells[3] = o.cells[2]; },
    o => { o.cells[0].workId = 'foreign'; },
    o => { o.cells[0].matrixSha256 = sha('different matrix'); },
    o => { o.cells[0].condition.modelSha256 = o.cells[2].condition.modelSha256; },
    o => { o.cells[0].condition.processingSha256 = o.cells[1].condition.processingSha256; },
    o => { o.cells[0].jobs[0].resultSha256 = sha('wrong final typeset result'); },
  ]) {
    const changed = structuredClone(fixture);
    edit(changed.input.observations);
    changed.anchors.observationsSha256 = contentSha256(changed.input.observations);
    assert.throws(() => prepare(changed), { code: 'STAGE16_REVIEW_OBSERVATION_MISMATCH' });
  }
});

test('an overlap requires two qualified bilingual people in distinct Stage05 groups', () => {
  for (const edit of [
    r => { r[2].independenceGroup = r[1].independenceGroup; },
    r => { r[2].kind = 'ai'; },
    r => { r[2].languages = ['ko']; },
    r => { r[2].qualificationEvidence = null; },
  ]) {
    assert.throws(() => prepare(reviewScenario({ editRoster: edit })), { code: 'STAGE16_REVIEWERS_NOT_INDEPENDENT' });
  }
  for (const overlapPageCount of [0, 1.5, 3]) {
    assert.throws(() => prepare(reviewScenario({ overlapPageCount })), { code: 'STAGE16_REVIEW_PROTOCOL_MISMATCH' });
  }
});

test('unavailable and ambiguous cell results keep their planned slots and cannot be rated', () => {
  const fixture = reviewScenario({
    editJobs: jobs => {
      const replicate = structuredClone(jobs[0]);
      replicate.binding.requestId += ':replicate';
      jobs.push(replicate);
    },
    editReceipts: receipts => { receipts.splice(3, 1); },
  });
  const book = prepare(fixture), audit = collect(book, []);
  const [a, b] = audit.pairs.filter(p => p.pageId === 'page-final');
  assert.equal(a.results.baseline.reason, 'MULTIPLE_FINAL_RESULTS');
  assert.equal(a.results.baseline.jobs.length, 2);
  assert.equal(b.results.improved.jobs[0].reason, 'JOB_RECEIPT_MISSING');
  for (const pair of [a, b]) {
    for (const slot of pair.assignments) {
      assert.equal(slot.status, 'unavailable');
      assert.equal(slot.naturalness.reason, 'RESULT_PAIR_UNAVAILABLE');
      assert.ok(!packet(book, slot.reviewerId).items.some(i => i.assignmentId === slot.assignmentId));
      const unissued = rows(book.seal).find(a => a.assignmentId === slot.assignmentId);
      assert.throws(() => collect(book, [reply(unissued, { semanticFidelity: 'A' })]), { code: 'STAGE16_REVIEW_RETURN_MISMATCH' });
    }
  }
});

test('neither stale seals nor foreign reviewer tickets can supply a return', () => {
  const book = prepare(), a = rows(book.seal)[0];
  const old = structuredClone(book);
  const swapped = rows(old.seal)[0];
  [swapped.A, swapped.B] = [swapped.B, swapped.A];
  assert.throws(() => packet(old), { code: 'STAGE16_REVIEW_SEAL_MISMATCH' });
  assert.throws(() => collect(old, []), { code: 'STAGE16_REVIEW_SEAL_MISMATCH' });
  const returns = reply(a, { naturalness: 'tie' });
  returns.reviewerId = readerIds.find(id => id !== a.reviewerId);
  assert.throws(() => collect(book, [returns]), { code: 'STAGE16_REVIEW_RETURN_MISMATCH' });
  const changed = prepare(reviewScenario({ editReceipts: receipts => { receipts.pop(); } }));
  assert.throws(() => collect(changed, [reply(a, { naturalness: 'A' })]), { code: 'STAGE16_REVIEW_RETURN_MISMATCH' });
});

test('partial answers merge once while conflicting choices, combined scores and provenance switches are refused', () => {
  const book = prepare(), a = rows(book.seal)[0];
  const first = reply(a, { semanticFidelity: 'cannot_assess' }), next = reply(a, { naturalness: 'tie' });
  const audit = collect(book, [first, next, structuredClone(first)]);
  assert.deepEqual(audit, collect(book, [next, first]));
  const saved = rows(audit).find(row => row.assignmentId === a.assignmentId);
  assert.equal(saved.status, 'answered');
  assert.equal(saved.evidenceKind, 'synthetic');
  assert.deepEqual(saved.semanticFidelity, { choice: 'cannot_assess', preference: null, reason: 'REVIEWER_CANNOT_ASSESS' });
  assert.deepEqual(saved.naturalness, { choice: 'tie', preference: 'tie', reason: null });
  assert.throws(() => collect(book, [first, reply(a, { semanticFidelity: 'A' })]), { code: 'STAGE16_REVIEW_RETURN_CONFLICT' });
  assert.throws(() => collect(book, [first, { ...next, evidenceKind: 'human_submission' }]), { code: 'STAGE16_REVIEW_RETURN_CONFLICT' });
  for (const answers of [{ overall: 'A' }, { semanticFidelity: 'baseline' }, { naturalness: '' },
    { semanticFidelity: 'B', reviewerId: readerIds[0] }]) {
    assert.throws(() => collect(book, [reply(a, answers)]), { code: 'STAGE16_REVIEW_RETURN_MISMATCH' });
  }
});

test('the hand-counted overlap retains disagreement, tie, partial, unanswered and unavailable assignments', t => {
  const initial = prepare();
  const singlePage = initial.seal.pairs.find(p => p.assignments.length === 1).pageId;
  const fixture = reviewScenario({ editReceipts: receipts => {
    receipts.splice(receipts.findIndex(r => r.page.pageId === singlePage && r.condition.model === 'B' &&
      r.condition.processing === 'improved'), 1);
  } });
  const book = prepare(fixture);
  const schedule = seal => seal.pairs.map(p => [p.pageId, p.model, p.assignments.map(a => [a.reviewerId, a.A.processing, a.queueKey])]);
  assert.deepEqual(schedule(book.seal), schedule(initial.seal));
  const [one, two] = book.seal.pairs.filter(p => p.assignments.length === 2);
  const oldFirst = one.assignments.find(a => a.A.processing === 'baseline');
  const newFirst = one.assignments.find(a => a.A.processing === 'improved');
  assert.ok(oldFirst && newFirst);
  const first = reply(oldFirst, { semanticFidelity: 'A', naturalness: 'B' });
  const second = reply(newFirst, { semanticFidelity: 'A', naturalness: 'A' });
  const partial = reply(two.assignments[0], { semanticFidelity: 'tie' });
  const envelopes = [first, second, partial, structuredClone(first)];
  const audit = collect(book, envelopes);
  assert.deepEqual(audit.summary, { plannedPairs: 4, overlapPairs: 2, plannedAssignments: 6,
    issuedAssignments: 5, answered: 2, partial: 1, unanswered: 2, unavailable: 1 });
  const [both, incomplete] = audit.pairs.filter(p => p.assignments.length === 2);
  assert.deepEqual(both.comparison, { semanticFidelity: 'open_disagreement', naturalness: 'agree' });
  assert.deepEqual(incomplete.comparison, { semanticFidelity: 'not_comparable', naturalness: 'not_comparable' });
  const reasons = axis => rows(audit).map(a => a[axis].reason ?? 'ANSWERED').sort();
  assert.deepEqual(reasons('semanticFidelity'), ['ANSWERED', 'ANSWERED', 'ANSWERED', 'NO_RESPONSE', 'NO_RESPONSE', 'RESULT_PAIR_UNAVAILABLE']);
  assert.deepEqual(reasons('naturalness'), ['ANSWERED', 'ANSWERED', 'AXIS_UNANSWERED', 'NO_RESPONSE', 'NO_RESPONSE', 'RESULT_PAIR_UNAVAILABLE']);
  const sample = { sealSha256: book.sealSha256, summary: audit.summary,
    pairs: audit.pairs.map(p => ({ pageId: p.pageId, model: p.model, comparison: p.comparison,
      slots: p.assignments.map(a => ({ assignmentId: a.assignmentId, status: a.status, evidenceKind: a.evidenceKind,
        semanticFidelity: a.semanticFidelity, naturalness: a.naturalness })) })) };
  t.diagnostic('S16_BLIND_SAMPLE ' + JSON.stringify(sample));
  if (process.env.S16_CAPTURE_BLIND_SAMPLE === '1') {
    t.diagnostic('S16_BLIND_OPERATOR ' + JSON.stringify({ ...book, envelopes }));
    for (const [i, id] of readerIds.entries()) t.diagnostic('S16_BLIND_PACKET_' + (i + 1) + ' ' + JSON.stringify(packet(book, id)));
  }
});

test('a reviewer can return the displayed item and a swapped or foreign reference cannot be decoded', () => {
  const book = prepare(), form = packet(book);
  const [item, other] = form.items;
  const envelope = shown => ({ reviewerId: readerIds[0], evidenceKind: 'synthetic',
    responses: [{ ...shown, semanticFidelity: 'A', naturalness: 'B' }] });
  const saved = rows(collect(book, [envelope(item)])).find(a => a.assignmentId === item.assignmentId);
  assert.equal(saved.status, 'answered');
  for (const wrong of [
    { ...item, A: item.B, B: item.A }, { ...item, B: other.B }, { ...item, sourceRef: other.sourceRef },
    { ...item, contextRef: other.contextRef }, { assignmentId: item.assignmentId },
  ]) assert.throws(() => collect(book, [envelope(wrong)]), { code: 'STAGE16_REVIEW_RETURN_MISMATCH' });
});

test('an explicitly blank returned form and an omitted axis remain unscored when other forms are answered', () => {
  const book = prepare(), [blank, partial, filled] = packet(book).items;
  const envelope = { reviewerId: readerIds[0], evidenceKind: 'synthetic', responses: [
    { ...blank, semanticFidelity: null, naturalness: null },
    { ...partial, semanticFidelity: null, naturalness: 'tie' },
    { ...filled, semanticFidelity: 'A', naturalness: 'B' },
    { ...filled }, // Returning a second empty copy must not erase either choice.
  ] };
  const audit = collect(book, [envelope]);
  const byId = new Map(rows(audit).map(a => [a.assignmentId, a]));
  assert.deepEqual([audit.summary.answered, audit.summary.partial, audit.summary.unanswered], [1, 1, 4]);
  assert.deepEqual([byId.get(blank.assignmentId).status, byId.get(blank.assignmentId).naturalness.reason],
    ['unanswered', 'BLANK_RETURN']);
  assert.deepEqual([byId.get(partial.assignmentId).semanticFidelity.reason, byId.get(partial.assignmentId).naturalness.preference],
    ['AXIS_UNANSWERED', 'tie']);
  assert.equal(rows(audit).filter(a => a.naturalness.reason === 'NO_RESPONSE').length, 3);
});

test('an unattributed envelope cannot borrow its reviewer or evidence kind through a prototype', () => {
  const book = prepare(), a = rows(book.seal)[0];
  const original = reply(a, { naturalness: 'tie' });
  for (const key of ['reviewerId', 'evidenceKind', 'responses']) {
    const envelope = Object.assign(Object.create({ [key]: original[key] }), original);
    delete envelope[key];
    assert.throws(() => collect(book, [envelope]), { code: 'STAGE16_REVIEW_RETURN_MISMATCH' });
  }
});

test('equal finished bytes keep separate blinded alternatives and equal repeated jobs do not add ballots', () => {
  const fixture = reviewScenario({
    editJobs: jobs => {
      const extra = structuredClone(jobs[0]);
      extra.binding.requestId += ':repeat';
      jobs.push(extra);
    },
    editReceipts: receipts => {
      const first = receipts[0], finalPin = first.page.typesetting.subjectSha256;
      for (const r of [receipts[1], receipts.at(-1)]) {
        r.page.typesetting.subjectSha256 = finalPin;
        const last = r.stages.at(-1).attempts[0].observations[0];
        last.observed.artifact.sha256 = finalPin;
        last.output.artifact.sha256 = finalPin;
      }
    },
  });
  const book = prepare(fixture), p = book.seal.pairs[0];
  assert.equal(p.results.baseline.jobs.length, 2);
  assert.ok(p.results.baseline.resultSha256);
  assert.equal(p.results.baseline.resultSha256, p.results.improved.resultSha256);
  for (const a of p.assignments) {
    const item = packet(book, a.reviewerId).items.find(i => i.assignmentId === a.assignmentId);
    assert.notEqual(item.A, item.B);
  }
  assert.equal(collect(book, []).summary.issuedAssignments, 6);
});

test('a cohort without any execution receipts still has four planned pairs and no issued forms', () => {
  const book = prepare(reviewScenario({ editReceipts: receipts => { receipts.length = 0; } }));
  for (const id of readerIds) assert.deepEqual(packet(book, id).items, []);
  assert.deepEqual(collect(book, []).summary, { plannedPairs: 4, overlapPairs: 2, plannedAssignments: 6,
    issuedAssignments: 0, answered: 0, partial: 0, unanswered: 0, unavailable: 6 });
});
