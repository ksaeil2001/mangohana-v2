'use strict';

const { classifyFailure } = require('./recovery-policy.cjs');

const modes = new Set(['FULL_IMAGE', 'TYPESETTING_ONLY']);
const typesettingStages = new Set(['TYPESET', 'VERIFY_FINAL', 'PUBLISH']);
const states = new Set([
  'CONFIRMED_SUCCESS', 'CONFIRMED_NOT_STARTED', 'CONFIRMED_FAILURE', 'PARTIAL', 'CANCELLED', 'RESULT_UNKNOWN',
]);
const phases = new Set(['BEFORE_DISPATCH', 'DISPATCHED', 'PUBLISHING']);
const checkStatuses = new Set(['unknown', 'not_measured', 'pending', 'passed', 'failed']);
const severities = new Set(['HARD', 'SOFT', 'UNVERIFIED']);
const reviewActors = new Set(['rule', 'ai', 'human']);
const uncertainErrors = new Set(['TIMEOUT', 'TRANSPORT', 'TRANSPORT_UNCONFIRMED', 'RETRY_COMMIT_UNKNOWN']);
const idFields = ['projectId', 'pageId', 'requestId'];
const revisions = ['editRevision', 'contextRevision', 'layoutRevision'];
const permitFields = ['permitId', 'proposalSha256', 'approvalEventSha256'];
const bindingFields = [...idFields, ...revisions, ...permitFields, 'pageNumber', 'generation', 'sourceSha256', 'inputDigest', 'mode'];

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const cost = value => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
const artifactRef = value => record(value) && id(value.artifactId) && sha256(value.sha256);
const measured = check => check?.status === 'passed' || check?.status === 'failed';

function validBinding(binding) {
  if (!record(binding)) return false;
  const owner = binding.ownerScope;
  return record(owner) && ['owner', 'session'].includes(owner.kind) && id(owner.id) &&
    idFields.every(key => id(binding[key])) && revisions.every(key => revision(binding[key])) &&
    Number.isSafeInteger(binding.pageNumber) && binding.pageNumber > 0 &&
    (revision(binding.generation) || id(binding.generation)) &&
    sha256(binding.sourceSha256) && sha256(binding.inputDigest) && modes.has(binding.mode) &&
    (permitFields.every(key => !Object.hasOwn(binding, key)) ||
      id(binding.permitId) && sha256(binding.proposalSha256) && sha256(binding.approvalEventSha256));
}

function sameBinding(left, right) {
  return left.ownerScope.kind === right.ownerScope.kind && left.ownerScope.id === right.ownerScope.id &&
    bindingFields.every(key => left[key] === right[key]);
}

function sameArtifact(left, right) {
  return right !== null && left.artifactId === right.artifactId && left.sha256 === right.sha256;
}

// Stage04 review provenance binds a measured claim to a materialized subject and its identity.
function validSubject(evidence) {
  return id(evidence.evidenceId) && validBinding(evidence.identity) &&
    id(evidence.subjectArtifactId) && sha256(evidence.subjectSha256);
}

function sameSubject(evidence, observed) {
  return observed.artifact !== null && sameBinding(evidence.identity, observed.binding) &&
    evidence.subjectArtifactId === observed.artifact.artifactId && evidence.subjectSha256 === observed.artifact.sha256;
}

function validRequiredCheck(check) {
  return record(check) && id(check.checkId) && id(check.version);
}

function validCheck(check) {
  return validRequiredCheck(check) && checkStatuses.has(check.status) && (measured(check)
    ? validSubject(check)
    : check.evidenceId === null && check.identity === null && check.subjectArtifactId === null && check.subjectSha256 === null);
}

function validWarningScope(value) {
  return id(value.code) && id(value.scope) && (value.regionId === null || id(value.regionId)) && id(value.checkId);
}

function validFinding(finding, checks) {
  if (!record(finding) || !id(finding.id) || !severities.has(finding.severity) || !validWarningScope(finding)) return false;
  const check = checks.get(finding.checkId);
  return check !== undefined && finding.evidenceId === check.evidenceId &&
    (finding.severity === 'UNVERIFIED' || measured(check));
}

function validApproval(approval) {
  return record(approval) && validSubject(approval) && validWarningScope(approval) &&
    reviewActors.has(approval.actor) && id(approval.stage) && id(approval.findingId) &&
    id(approval.checkVersion) && id(approval.checkEvidenceId);
}

function acceptsWarning(approval, finding, check, observed) {
  return approval.actor === 'human' && approval.stage === observed.stage && sameSubject(approval, observed) &&
    approval.findingId === finding.id && approval.code === finding.code && approval.scope === finding.scope &&
    approval.regionId === finding.regionId && approval.checkId === finding.checkId &&
    approval.checkVersion === check.version && approval.checkEvidenceId === finding.evidenceId;
}

function validObservation(observed) {
  if (!record(observed) || !validBinding(observed.binding) || !id(observed.stage) || !id(observed.attemptId) ||
      !states.has(observed.state) || !phases.has(observed.phase) || ![true, false, null].includes(observed.started) ||
      !Array.isArray(observed.evidenceRefs) || !Array.from(observed.evidenceRefs).every(id) ||
      !(observed.costUsd === null || cost(observed.costUsd)) || observed.usageConfirmed !== (observed.costUsd !== null) ||
      !(observed.errorCode === null || id(observed.errorCode)) ||
      !(observed.artifact === null || artifactRef(observed.artifact))) return false;
  if (observed.state === 'CONFIRMED_SUCCESS' && (observed.artifact === null || observed.errorCode !== null ||
      (observed.phase === 'DISPATCHED' && observed.started === false))) return false;
  if (observed.phase === 'BEFORE_DISPATCH' || observed.state === 'CONFIRMED_NOT_STARTED') return observed.started === false;
  return true;
}

function validAuthority(authority) {
  return record(authority) && typeof authority.verified === 'boolean' && validBinding(authority.binding) &&
    id(authority.stage) && (authority.artifact === null || artifactRef(authority.artifact)) &&
    Array.isArray(authority.softApprovals) && Array.from(authority.softApprovals).every(validApproval);
}

function indexRecords(items, key, valid) {
  if (!Array.isArray(items)) return null;
  const indexed = new Map();
  for (const item of items) {
    if (!valid(item) || indexed.has(item[key])) return null;
    indexed.set(item[key], item);
  }
  return indexed;
}

// Keep the execution observation independent of the decision about its current usability.
function describeExecution(observed) {
  if (!record(observed)) return null;
  const { state, phase } = observed;
  const started = typeof observed.started === 'boolean' ? observed.started : null;
  const usageConfirmed = typeof observed.usageConfirmed === 'boolean' ? observed.usageConfirmed : null;
  const costUsd = cost(observed.costUsd) ? observed.costUsd : null;
  const errorCode = id(observed.errorCode) ? observed.errorCode : null;
  const failure = errorCode ? classifyFailure({ code: errorCode }) : null;
  const dispatched = phase === 'DISPATCHED' || phase === 'PUBLISHING' || started === true;
  const uncertainError = uncertainErrors.has(errorCode) || errorCode?.endsWith('_TIMEOUT') || failure?.type === 'cleanup_unknown';
  const resultUnknown = state === 'RESULT_UNKNOWN' || (dispatched &&
    (uncertainError || started === null || usageConfirmed !== true || costUsd === null));
  return {
    stage: id(observed.stage) ? observed.stage : null,
    attemptId: id(observed.attemptId) ? observed.attemptId : null,
    state: states.has(state) ? state : null,
    phase: phases.has(phase) ? phase : null,
    started, usageConfirmed, costUsd,
    evidenceRefs: Array.isArray(observed.evidenceRefs) ? observed.evidenceRefs.filter(id) : [],
    errorCode, failure: failure ? { code: failure.code, type: failure.type } : null,
    resultUnknown,
  };
}

function blocked(info, reasons) {
  return {
    ...info, kind: 'BLOCKED', reasons: info.execution?.resultUnknown ? [...reasons, 'RESULT_UNKNOWN'] : reasons,
  };
}

/**
 * Pure, internal policy for normalized data from the owning boundaries.
 *
 * binding pins ownerScope { kind, id }, project/page/ordinal/request, generation,
 * edit/context/layout revisions, source SHA-256, input digest and execution mode.
 * The optional permit ID, proposal SHA and approval-event SHA travel together.
 * observed carries the attempt/binding/stage, execution and settlement evidence,
 * artifact { artifactId, sha256 } or null, and checks keyed by checkId/version.
 * Measured checks carry a Stage04-style identity and subject plus evidenceId.
 * Each finding refers to a check's evidence and names a code, scope and region.
 * authority carries the owning boundary's verification result, current binding,
 * stage and artifact, required check versions and any evidence-bound user approvals.
 *
 * Precedence: block contract, scope, integrity or HARD failures, then retain
 * uncertain execution, hold for missing evidence/review, revalidate changed check
 * versions on the same artifact, or pass the supplied stage checks. Every result
 * is a finding about these inputs. Execution and publication have their own gates.
 */
function assessStage(input) {
  const { binding, observed, findings, authority } = record(input) ? input : {};
  const info = {
    findingIds: [], acceptedSoftFindingIds: [], revalidateCheckIds: [],
    execution: describeExecution(observed), countsAsDispatch: false,
  };
  if (!validBinding(binding) || !validObservation(observed) || !validAuthority(authority)) {
    return blocked(info, ['COMMON_CONTRACT_INVALID']);
  }
  const checks = indexRecords(observed.checks, 'checkId', validCheck);
  const requiredChecks = indexRecords(authority.requiredChecks, 'checkId', validRequiredCheck);
  const findingsById = checks && indexRecords(findings, 'id', finding => validFinding(finding, checks));
  if (!requiredChecks || !findingsById) return blocked(info, ['COMMON_CONTRACT_INVALID']);
  info.findingIds = [...findingsById.keys()];

  const reasons = [];
  if (!authority.verified || authority.stage !== observed.stage ||
      (binding.mode === 'TYPESETTING_ONLY' && !typesettingStages.has(observed.stage))) reasons.push('AUTHORITY_MISMATCH');
  if (!sameBinding(binding, authority.binding) || !sameBinding(binding, observed.binding)) reasons.push('COMMON_CONTRACT_STALE');
  if ((observed.artifact !== null && !sameArtifact(observed.artifact, authority.artifact)) ||
      [...checks.values()].some(check => measured(check) && !sameSubject(check, observed))) reasons.push('SOURCE_INTEGRITY_FAILED');

  const softFindings = findings.filter(finding => finding.severity === 'SOFT');
  if (reasons.length === 0) {
    info.acceptedSoftFindingIds = softFindings.filter(finding => authority.softApprovals.some(approval =>
      acceptsWarning(approval, finding, checks.get(finding.checkId), observed))).map(finding => finding.id);
  }
  if (findings.some(finding => finding.severity === 'HARD')) reasons.push('HARD_VIOLATION');
  if (reasons.length > 0) return blocked(info, reasons);
  if (info.execution.resultUnknown) return { ...info, kind: 'RESULT_UNKNOWN', reasons: ['RESULT_UNKNOWN'] };

  if (observed.state !== 'CONFIRMED_SUCCESS') reasons.push('STAGE_INCOMPLETE');
  if (observed.evidenceRefs.length === 0) reasons.push('OBSERVATION_EVIDENCE_MISSING');
  if (requiredChecks.size === 0 || [...requiredChecks.keys()].some(checkId => !measured(checks.get(checkId))) ||
      findings.some(finding => finding.severity === 'UNVERIFIED')) reasons.push('QUALITY_EVIDENCE_MISSING');
  if ([...checks.values()].some(check => check.status === 'failed')) reasons.push('CHECK_FAILED');
  if (info.acceptedSoftFindingIds.length !== softFindings.length) reasons.push('SOFT_REVIEW_REQUIRED');
  if (reasons.length > 0) return { ...info, kind: 'MANUAL_REVIEW', reasons };

  const revalidateCheckIds = [...requiredChecks.values()]
    .filter(check => check.version !== checks.get(check.checkId).version).map(check => check.checkId);
  if (revalidateCheckIds.length > 0) {
    return { ...info, kind: 'REVALIDATE_STAGE', reasons: ['CHECK_VERSION_CHANGED'], revalidateCheckIds };
  }
  return { ...info, kind: 'PASS', reasons };
}

module.exports = { assessStage };
