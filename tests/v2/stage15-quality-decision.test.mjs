import assert from 'node:assert/strict';
import test from 'node:test';
import policy from '../../packages/ai-engine/quality/stage15-quality-decision.cjs';

const { assessStage } = policy;

function assessment() {
  const binding = {
    ownerScope: { kind: 'session', id: 'session-1' },
    projectId: 'project-1', pageId: 'page-1', pageNumber: 1, requestId: 'request-1',
    generation: 2, editRevision: 1, contextRevision: 0, layoutRevision: 14,
    sourceSha256: 'a'.repeat(64), inputDigest: 'b'.repeat(64), mode: 'TYPESETTING_ONLY',
  };
  const artifact = { artifactId: 'image-1', sha256: 'c'.repeat(64) };
  return {
    binding,
    observed: {
      binding: structuredClone(binding), stage: 'TYPESET', attemptId: 'attempt-1',
      state: 'CONFIRMED_SUCCESS', phase: 'DISPATCHED', started: true,
      evidenceRefs: ['execution-evidence-1'], usageConfirmed: true, costUsd: '0.00',
      errorCode: null, artifact: { ...artifact },
      checks: [{
        checkId: 'raster', version: 'v1', status: 'passed', evidenceId: 'measurement-1',
        identity: structuredClone(binding), subjectArtifactId: artifact.artifactId,
        subjectSha256: artifact.sha256,
      }],
    },
    findings: [],
    authority: {
      verified: true, binding: structuredClone(binding), stage: 'TYPESET', artifact: { ...artifact },
      requiredChecks: [{ checkId: 'raster', version: 'v1' }], softApprovals: [],
    },
  };
}

function withApprovedWarning() {
  const input = assessment();
  input.findings.push({
    id: 'warning-1', severity: 'SOFT', code: 'S-02', scope: 'READABILITY', regionId: 'region-1',
    checkId: 'raster', evidenceId: 'measurement-1',
  });
  input.authority.softApprovals.push({
    findingId: 'warning-1', code: 'S-02', scope: 'READABILITY', regionId: 'region-1',
    checkId: 'raster', checkVersion: 'v1', checkEvidenceId: 'measurement-1',
    actor: 'human', evidenceId: 'user-review-1', stage: 'TYPESET',
    identity: structuredClone(input.binding), subjectArtifactId: 'image-1',
    subjectSha256: 'c'.repeat(64),
  });
  return input;
}

function dispatchedTimeout() {
  const input = assessment();
  Object.assign(input.observed, {
    state: 'RESULT_UNKNOWN', phase: 'DISPATCHED', started: true,
    errorCode: 'TYPESET_TIMEOUT', usageConfirmed: false, costUsd: null,
    artifact: null, checks: [], evidenceRefs: ['dispatch-ack-1', 'timeout-1'],
  });
  input.authority.artifact = null;
  return input;
}

function freezeData(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeData);
    Object.freeze(value);
  }
  return value;
}

test('a current, completed stage with a bound passed measurement gives a data-only PASS', () => {
  const input = assessment();
  const before = structuredClone(input);
  const decision = assessStage(freezeData(input));
  assert.equal(decision.kind, 'PASS');
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.countsAsDispatch, false);
  assert.deepEqual(input, before);
  assert.notStrictEqual(decision.execution.evidenceRefs, input.observed.evidenceRefs);
});

test('an unapproved translation meaning warning requires manual review', () => {
  const input = withApprovedWarning();
  input.findings[0].scope = 'TRANSLATION_SEMANTICS';
  input.findings[0].code = 'SEMANTIC_REVIEW_REQUIRED';
  input.authority.softApprovals = [];
  const decision = assessStage(input);
  assert.equal(decision.kind, 'MANUAL_REVIEW');
  assert.ok(decision.reasons.includes('SOFT_REVIEW_REQUIRED'));
  assert.deepEqual(decision.findingIds, ['warning-1']);
});

test('a human SOFT approval applies to exactly the measured warning and keeps its record', () => {
  const input = withApprovedWarning();
  const decision = assessStage(freezeData(input));
  assert.equal(decision.kind, 'PASS');
  assert.deepEqual(decision.findingIds, ['warning-1']);
  assert.deepEqual(decision.acceptedSoftFindingIds, ['warning-1']);
  assert.equal(input.findings[0].severity, 'SOFT');
});

test('validly shaped approvals for a different identity, warning, measurement, or review scope require review', () => {
  for (const [label, change] of [
    ['revision', a => { a.identity.layoutRevision = 13; }],
    ['owner', a => { a.identity.ownerScope.id = 'session-2'; }],
    ['input', a => { a.identity.inputDigest = 'd'.repeat(64); }],
    ['artifact ID', a => { a.subjectArtifactId = 'other-image'; }],
    ['artifact SHA', a => { a.subjectSha256 = 'd'.repeat(64); }],
    ['finding ID', a => { a.findingId = 'warning-2'; }],
    ['code', a => { a.code = 'S-03'; }],
    ['region', a => { a.regionId = 'region-2'; }],
    ['stage', a => { a.stage = 'TRANSLATE'; }],
    ['check', a => { a.checkId = 'other-check'; }],
    ['check version', a => { a.checkVersion = 'v2'; }],
    ['check evidence', a => { a.checkEvidenceId = 'old-measurement'; }],
    ['review scope', a => { a.scope = 'TRANSLATION_SEMANTICS'; }],
    ['review actor', a => { a.actor = 'ai'; }],
  ]) {
    const input = withApprovedWarning();
    change(input.authority.softApprovals[0]);
    const decision = assessStage(input);
    assert.equal(decision.kind, 'MANUAL_REVIEW', label);
    assert.ok(decision.reasons.includes('SOFT_REVIEW_REQUIRED'), label);
    assert.deepEqual(decision.acceptedSoftFindingIds, [], label);
  }
});

test('even an otherwise exact SOFT approval cannot accept a HARD violation', () => {
  const input = withApprovedWarning();
  input.findings[0].severity = 'HARD';
  const decision = assessStage(input);
  assert.equal(decision.kind, 'BLOCKED');
  assert.ok(decision.reasons.includes('HARD_VIOLATION'));
  assert.deepEqual(decision.findingIds, ['warning-1']);
  assert.deepEqual(decision.acceptedSoftFindingIds, []);
});

test('a separate HARD violation blocks without clearing an approved SOFT warning', () => {
  const input = withApprovedWarning();
  input.findings.push({ ...input.findings[0], id: 'hard-1', code: 'H-01', severity: 'HARD' });
  const decision = assessStage(input);
  assert.equal(decision.kind, 'BLOCKED');
  assert.deepEqual(decision.findingIds, ['warning-1', 'hard-1']);
  assert.deepEqual(decision.acceptedSoftFindingIds, ['warning-1']);
});

test('a valid stage still needs a nonempty required check set and completed evidence for each check', () => {
  for (const [label, change] of [
    ['missing measurement', i => { i.observed.checks = []; }],
    ['no required checks', i => { i.authority.requiredChecks = []; }],
    ['incomplete coverage', i => { i.authority.requiredChecks.push({ checkId: 'glyphs', version: 'v1' }); }],
    ['unmeasured', i => {
      Object.assign(i.observed.checks[0], {
        status: 'not_measured', evidenceId: null, identity: null, subjectArtifactId: null, subjectSha256: null,
      });
    }],
  ]) {
    const input = assessment();
    change(input);
    const decision = assessStage(input);
    assert.equal(decision.kind, 'MANUAL_REVIEW', label);
    assert.ok(decision.reasons.includes('QUALITY_EVIDENCE_MISSING'), label);
  }
});

test('failed measurements and unverified findings hold the stage for review', () => {
  const failed = assessment();
  failed.observed.checks[0].status = 'failed';
  assert.deepEqual(assessStage(failed).reasons, ['CHECK_FAILED']);
  assert.equal(assessStage(failed).kind, 'MANUAL_REVIEW');

  const unverified = withApprovedWarning();
  unverified.findings[0].severity = 'UNVERIFIED';
  const decision = assessStage(unverified);
  assert.equal(decision.kind, 'MANUAL_REVIEW');
  assert.ok(decision.reasons.includes('QUALITY_EVIDENCE_MISSING'));
  assert.deepEqual(decision.acceptedSoftFindingIds, []);
});

test('malformed bindings, observations, and evidence claims are blocked with a contract error', () => {
  assert.equal(assessStage(null).kind, 'BLOCKED');
  for (const [label, change] of [
    ['owner', i => { delete i.binding.ownerScope; }],
    ['revision', i => { i.binding.contextRevision = null; }],
    ['digest', i => { i.binding.inputDigest = 'invalid'; }],
    ['mode', i => { i.binding.mode = 'AUTOMATIC'; }],
    ['observed binding', i => { delete i.observed.binding; }],
    ['attempt', i => { delete i.observed.attemptId; }],
    ['dispatch fields', i => { delete i.observed.started; }],
    ['unrecognized state', i => { i.observed.state = 'OK'; }],
    ['unrecognized check state', i => { i.observed.checks[0].status = 'OK'; }],
    ['missing artifact on success', i => { i.observed.artifact = null; }],
    ['authority verification field', i => { delete i.authority.verified; }],
    ['missing findings array', i => { delete i.findings; }],
    ['passed claim without evidence ID', i => { i.observed.checks[0].evidenceId = null; }],
    ['duplicate check', i => { i.observed.checks.push(i.observed.checks[0]); }],
    ['dangling warning evidence', i => { i.findings[0].evidenceId = 'old-measurement'; }],
  ]) {
    const input = withApprovedWarning();
    change(input);
    const decision = assessStage(input);
    assert.equal(decision.kind, 'BLOCKED', label);
    assert.ok(decision.reasons.includes('COMMON_CONTRACT_INVALID'), label);
  }
});

for (const [label, change] of [
  ['dispatch with an explicit no-start report', observed => { observed.started = false; }],
  ['an explicit failure code', observed => { observed.errorCode = 'ENGINE_FAILED'; }],
]) {
  test(`a success claim conflicting with ${label} is malformed`, () => {
    const input = assessment();
    change(input.observed);
    const decision = assessStage(input);
    assert.equal(decision.kind, 'BLOCKED');
    assert.ok(decision.reasons.includes('COMMON_CONTRACT_INVALID'));
  });
}

test('known incomplete executions and success claims without execution evidence cannot pass', () => {
  for (const state of ['PARTIAL', 'CANCELLED', 'CONFIRMED_NOT_STARTED', 'CONFIRMED_FAILURE']) {
    const input = assessment();
    input.observed.state = state;
    if (state === 'CONFIRMED_NOT_STARTED') input.observed.started = false;
    const decision = assessStage(input);
    assert.equal(decision.kind, 'MANUAL_REVIEW', state);
    assert.ok(decision.reasons.includes('STAGE_INCOMPLETE'), state);
    assert.equal(decision.execution.state, state);
  }
  const input = assessment();
  input.observed.evidenceRefs = [];
  const decision = assessStage(input);
  assert.equal(decision.kind, 'MANUAL_REVIEW');
  assert.ok(decision.reasons.includes('OBSERVATION_EVIDENCE_MISSING'));
});

test('mismatched current identity and source block an otherwise valid stage', () => {
  for (const [label, change] of [
    ['layout revision', b => { b.layoutRevision--; }],
    ['owner', b => { b.ownerScope.id = 'session-2'; }],
    ['owner kind', b => { b.ownerScope.kind = 'owner'; }],
    ['page', b => { b.pageId = 'page-2'; }],
    ['source', b => { b.sourceSha256 = 'd'.repeat(64); }],
    ['input', b => { b.inputDigest = 'd'.repeat(64); }],
    ['generation', b => { b.generation++; }],
  ]) {
    const input = assessment();
    change(input.authority.binding);
    const decision = assessStage(input);
    assert.equal(decision.kind, 'BLOCKED', label);
    assert.ok(decision.reasons.includes('COMMON_CONTRACT_STALE'), label);
  }
  const late = assessment();
  late.observed.binding.editRevision--;
  assert.ok(assessStage(late).reasons.includes('COMMON_CONTRACT_STALE'));
});

test('supplied permit provenance must be complete and match the observed and current binding', () => {
  const input = assessment();
  const permit = {
    permitId: 'permit-1', proposalSha256: 'd'.repeat(64), approvalEventSha256: 'e'.repeat(64),
  };
  for (const binding of [input.binding, input.observed.binding, input.authority.binding, input.observed.checks[0].identity]) {
    Object.assign(binding, permit);
  }
  assert.equal(assessStage(input).kind, 'PASS');
  input.authority.binding.approvalEventSha256 = 'f'.repeat(64);
  assert.deepEqual(assessStage(input).reasons, ['COMMON_CONTRACT_STALE']);
  delete input.authority.binding.proposalSha256;
  assert.ok(assessStage(input).reasons.includes('COMMON_CONTRACT_INVALID'));
});

test('stage authority must be current and respect the existing typesetting-only scope', () => {
  const denied = assessment();
  denied.authority.verified = false;
  assert.deepEqual(assessStage(denied).reasons, ['AUTHORITY_MISMATCH']);
  const wrongStage = assessment();
  wrongStage.authority.stage = 'VERIFY_FINAL';
  assert.deepEqual(assessStage(wrongStage).reasons, ['AUTHORITY_MISMATCH']);
  wrongStage.authority.stage = wrongStage.observed.stage = 'OCR';
  assert.equal(assessStage(wrongStage).kind, 'BLOCKED');
  assert.ok(assessStage(wrongStage).reasons.includes('AUTHORITY_MISMATCH'));
});

test('dispatch timeout and unconfirmed usage retain the attempt, actual start, and unknown amount', () => {
  const input = dispatchedTimeout();
  const decision = assessStage(input);
  assert.equal(decision.kind, 'RESULT_UNKNOWN');
  assert.deepEqual(decision.reasons, ['RESULT_UNKNOWN']);
  assert.deepEqual(decision.execution, {
    stage: 'TYPESET', attemptId: 'attempt-1', state: 'RESULT_UNKNOWN', phase: 'DISPATCHED', started: true,
    usageConfirmed: false, costUsd: null, evidenceRefs: ['dispatch-ack-1', 'timeout-1'],
    errorCode: 'TYPESET_TIMEOUT', failure: { code: 'TYPESET_TIMEOUT', type: 'transient_execution' },
    resultUnknown: true,
  });
  assert.equal(decision.countsAsDispatch, false);
});

test('a post-dispatch timeout is uncertain even when a transport failure label was supplied', () => {
  const input = dispatchedTimeout();
  input.observed.state = 'CONFIRMED_FAILURE';
  input.observed.usageConfirmed = true;
  input.observed.costUsd = '0.50';
  const decision = assessStage(input);
  assert.equal(decision.kind, 'RESULT_UNKNOWN');
  assert.equal(decision.execution.state, 'CONFIRMED_FAILURE');
  assert.equal(decision.execution.resultUnknown, true);
  assert.equal(decision.execution.costUsd, '0.50');
});

test('unconfirmed settlement alone holds a completed dispatch without converting null to zero', () => {
  const input = assessment();
  Object.assign(input.observed, { usageConfirmed: false, costUsd: null });
  const decision = assessStage(input);
  assert.equal(decision.kind, 'RESULT_UNKNOWN');
  assert.equal(decision.execution.state, 'CONFIRMED_SUCCESS');
  assert.equal(decision.execution.costUsd, null);
});

test('stale or unauthorized dispatches block while preserving the separate unknown result', () => {
  for (const [change, reason] of [
    [i => { i.authority.binding.layoutRevision++; }, 'COMMON_CONTRACT_STALE'],
    [i => { i.authority.verified = false; }, 'AUTHORITY_MISMATCH'],
  ]) {
    const input = dispatchedTimeout();
    change(input);
    const decision = assessStage(input);
    assert.equal(decision.kind, 'BLOCKED');
    assert.deepEqual(decision.reasons, [reason, 'RESULT_UNKNOWN']);
    assert.equal(decision.execution.resultUnknown, true);
    assert.equal(decision.execution.started, true);
    assert.equal(decision.execution.usageConfirmed, false);
    assert.equal(decision.execution.costUsd, null);
    assert.equal(decision.execution.attemptId, 'attempt-1');
    assert.deepEqual(decision.execution.evidenceRefs, ['dispatch-ack-1', 'timeout-1']);
    assert.equal(decision.countsAsDispatch, false);
  }
});

test('only the outdated check on the same artifact is returned for revalidation, without invoking anything', () => {
  const input = withApprovedWarning();
  Object.assign(input.observed, { phase: 'BEFORE_DISPATCH', started: false, usageConfirmed: false, costUsd: null });
  input.authority.requiredChecks[0].version = 'v2';
  const unused = () => assert.fail('decision policy called a capability');
  Object.assign(input, { dispatch: unused, issuePermit: unused, createPng: unused, runCheck: unused });
  const decision = assessStage(freezeData(input));
  assert.equal(decision.kind, 'REVALIDATE_STAGE');
  assert.deepEqual(decision.reasons, ['CHECK_VERSION_CHANGED']);
  assert.deepEqual(decision.revalidateCheckIds, ['raster']);
  assert.deepEqual(decision.acceptedSoftFindingIds, ['warning-1']);
  assert.equal(decision.countsAsDispatch, false);
});

test('different artifacts or stale measurements block even when a check version changed', () => {
  for (const change of [
    i => { i.authority.artifact.artifactId = 'different-image'; },
    i => { i.authority.artifact.sha256 = 'd'.repeat(64); },
    i => { i.observed.checks[0].subjectSha256 = 'd'.repeat(64); },
    i => { i.observed.checks[0].identity.layoutRevision--; },
  ]) {
    const input = assessment();
    input.authority.requiredChecks[0].version = 'v2';
    change(input);
    const decision = assessStage(input);
    assert.equal(decision.kind, 'BLOCKED');
    assert.ok(decision.reasons.includes('SOURCE_INTEGRITY_FAILED'));
    assert.deepEqual(decision.revalidateCheckIds, []);
  }
});
