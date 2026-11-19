'use strict';

const { key } = require('./recovery-checkpoint.cjs');
const { assessStage } = require('./stage15-quality-decision.cjs');

const prerequisites = {
  FULL_IMAGE: {
    SOURCE: [], NORMALIZED: ['SOURCE'], OCR: ['NORMALIZED'], TRANSLATE: ['OCR'], MASK: ['OCR'],
    INPAINT: ['MASK'], TYPESET: ['TRANSLATE', 'INPAINT'], VERIFY_FINAL: ['TYPESET'], PUBLISH: ['VERIFY_FINAL'],
  },
  TYPESETTING_ONLY: {
    VERIFIED_CLEANED_INPUT: [], APPROVED_TRANSLATION_INPUT: [], APPROVED_LAYOUT_INPUT: [],
    TYPESET: ['VERIFIED_CLEANED_INPUT', 'APPROVED_TRANSLATION_INPUT', 'APPROVED_LAYOUT_INPUT'],
    VERIFY_FINAL: ['TYPESET'], PUBLISH: ['VERIFY_FINAL'],
  },
};
const optionalParents = { MASK: ['TRANSLATE'], INPAINT: ['NORMALIZED'] };
const unverifiedReasons = new Set(['STAGE_INCOMPLETE', 'OBSERVATION_EVIDENCE_MISSING', 'QUALITY_EVIDENCE_MISSING', 'CHECK_FAILED']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const artifact = value => record(value) && id(value.artifactId) && hex(value.sha256);
const sameArtifact = (a, b) => a && b && a.artifactId === b.artifactId && a.sha256 === b.sha256;
const sameBinding = (a, b) => record(a) && record(b) && key(a) === key(b);

function requireValue(ok, code = 'STAGE15_GRAPH_INVALID') {
  if (!ok) throw Object.assign(new Error(code), { code });
}

function stageParentsSha256(parents) {
  if (!Array.isArray(parents)) return null;
  const refs = new Map();
  for (const ref of parents) {
    if (!artifact(ref) || !id(ref.nodeId) || refs.has(ref.nodeId)) return null;
    const { nodeId, artifactId, sha256 } = ref;
    refs.set(nodeId, { nodeId, artifactId, sha256 });
  }
  return key([...refs.keys()].sort().map(nodeId => refs.get(nodeId)));
}

function stageCheckEvidenceId(binding, node, parentsSha256, check) {
  const { artifactId, sha256 } = node.artifact;
  return key({
    binding, nodeId: node.id, stage: node.stage, regionId: node.regionId, artifactId, sha256,
    inputsSha256: node.inputsSha256, parentsSha256, checkId: check.checkId, version: check.version, status: check.status,
  });
}

function validBinding(binding) {
  const permitFields = ['permitId', 'proposalSha256', 'approvalEventSha256'];
  return record(binding) && Object.hasOwn(prerequisites, binding.mode) &&
    ['owner', 'session'].includes(binding.ownerScope?.kind) && id(binding.ownerScope?.id) &&
    ['projectId', 'pageId', 'requestId'].every(field => id(binding[field])) &&
    Number.isSafeInteger(binding.pageNumber) && binding.pageNumber > 0 &&
    (revision(binding.generation) || id(binding.generation)) &&
    ['editRevision', 'contextRevision', 'layoutRevision'].every(field => revision(binding[field])) &&
    hex(binding.sourceSha256) && hex(binding.inputDigest) &&
    (permitFields.every(field => !Object.hasOwn(binding, field)) ||
      id(binding.permitId) && hex(binding.proposalSha256) && hex(binding.approvalEventSha256));
}

function validateTopology(binding, graph, pendingNode = null) {
  requireValue(validBinding(binding) && record(graph) && Array.isArray(graph.nodes) && graph.nodes.length > 0);
  requireValue(sameBinding(binding, graph.binding), 'STAGE15_GRAPH_STALE');
  const stages = prerequisites[binding.mode];
  const scopes = new Set();
  const nodes = new Map();
  for (const node of graph.nodes) {
    requireValue(record(node) && id(node.id) && id(node.stage) && Object.hasOwn(stages, node.stage) &&
      (node.regionId === null || id(node.regionId)) && (node === pendingNode ? node.artifact == null : artifact(node.artifact)) &&
      hex(node.inputsSha256) && Array.isArray(node.parents));
    if (node.stage === 'SOURCE') {
      requireValue(node.regionId === null);
      requireValue(node.artifact?.sha256 === binding.sourceSha256, 'STAGE15_GRAPH_STALE');
    }
    const scope = JSON.stringify([node.stage, node.regionId]);
    requireValue(!nodes.has(node.id) && !scopes.has(scope));
    scopes.add(scope);
    nodes.set(node.id, node);
  }
  const ids = [...nodes.keys()].sort();
  const children = new Map(ids.map(id => [id, []]));
  const remaining = new Map();
  for (const id of ids) {
    const node = nodes.get(id);
    const parents = new Set();
    for (const ref of node.parents) {
      requireValue(artifact(ref) && nodes.has(ref.nodeId) && !parents.has(ref.nodeId));
      const parent = nodes.get(ref.nodeId);
      requireValue(sameArtifact(ref, parent.artifact), 'STAGE15_GRAPH_STALE');
      parents.add(ref.nodeId);
      children.get(ref.nodeId).push(id);
    }
    remaining.set(id, parents.size);
  }
  const order = ids.filter(id => remaining.get(id) === 0);
  for (let index = 0; index < order.length; index++) {
    for (const child of children.get(order[index])) {
      const count = remaining.get(child) - 1;
      remaining.set(child, count);
      if (count === 0) order.push(child);
    }
  }
  requireValue(order.length === nodes.size, 'STAGE15_GRAPH_CYCLE');
  for (const node of nodes.values()) {
    const parentStages = new Set();
    const required = stages[node.stage];
    const allowed = [...required, ...(optionalParents[node.stage] ?? [])];
    for (const ref of node.parents) {
      const parent = nodes.get(ref.nodeId);
      requireValue(allowed.includes(parent.stage) &&
        (node.regionId === null || parent.regionId === null || node.regionId === parent.regionId));
      parentStages.add(parent.stage);
    }
    requireValue(required.every(stage => parentStages.has(stage)));
  }
  return { nodes, order };
}

function inspectNodes(inspections, binding, nodes) {
  requireValue(Array.isArray(inspections));
  const reports = new Map();
  for (const inspection of inspections) {
    const node = nodes.get(inspection?.nodeId);
    requireValue(node && !reports.has(node.id));
    const { assessment, regionId, inputsSha256 } = inspection;
    const parentsSha256 = stageParentsSha256(node.parents);
    requireValue(regionId === node.regionId && inputsSha256 === node.inputsSha256 && sameBinding(binding, assessment?.binding) &&
      assessment?.observed?.stage === node.stage && sameArtifact(node.artifact, assessment?.authority?.artifact) &&
      (assessment.observed.artifact === null || sameArtifact(node.artifact, assessment.observed.artifact)) &&
      inspection.parentsSha256 === parentsSha256 && assessment.observed.parentsSha256 === parentsSha256, 'STAGE15_GRAPH_STALE');
    const decision = assessStage(assessment);
    requireValue(!decision.reasons.includes('COMMON_CONTRACT_INVALID'));
    if (decision.kind === 'BLOCKED') {
      requireValue(decision.reasons.every(reason => reason === 'HARD_VIOLATION' || reason === 'RESULT_UNKNOWN'), 'STAGE15_GRAPH_STALE');
    }
    requireValue(node.regionId === null || assessment.findings.every(f => f.regionId === node.regionId || f.regionId === null));
    for (const check of assessment.observed.checks) {
      if (check.status === 'passed' || check.status === 'failed') {
        requireValue(check.evidenceId === stageCheckEvidenceId(binding, node, parentsSha256, check), 'STAGE15_GRAPH_STALE');
      }
    }
    const failed = new Set(assessment.observed.checks.filter(check => check.status === 'failed').map(check => check.checkId));
    const confirmed = decision.execution?.state === 'CONFIRMED_SUCCESS' && !decision.execution.resultUnknown &&
      assessment.observed.evidenceRefs.length > 0;
    const hard = confirmed ? assessment.findings.filter(f => f.severity === 'HARD' && failed.has(f.checkId)) : [];
    const review = decision.kind !== 'PASS' && hard.length === 0;
    const unverified = review && (!confirmed || decision.kind === 'REVALIDATE_STAGE' || decision.reasons.some(reason => unverifiedReasons.has(reason)));
    reports.set(node.id, { hard, review, unverified });
  }
  return reports;
}

/** A stage/scope DAG from the owning boundary. Edges pin the current parent artifact ID and digest. */
function analyzeStageGraph({ binding, graph, inspections = [] } = {}) {
  const { nodes, order } = validateTopology(binding, graph);
  const reports = inspectNodes(inspections, binding, nodes);
  const affected = new Set();
  const unverified = new Set();
  const rootCauses = [];
  const affectedNodes = [];
  const reviewNodeIds = [];
  for (const nodeId of order) {
    const node = nodes.get(nodeId);
    const report = reports.get(nodeId);
    const scope = { nodeId, stage: node.stage, pageId: binding.pageId, regionId: node.regionId };
    const dependencyAffected = node.parents.some(parent => affected.has(parent.nodeId));
    const upstreamUnverified = node.parents.some(parent => unverified.has(parent.nodeId));
    if (upstreamUnverified || report?.unverified) unverified.add(nodeId);
    const hard = report?.hard ?? [];
    if (hard.length > 0 && !dependencyAffected) {
      rootCauses.push({ ...scope, upstreamUnverified, findingIds: hard.map(f => f.id), findingRegionIds: [...new Set(hard.map(f => f.regionId))] });
    }
    if (hard.length > 0 || dependencyAffected) {
      affected.add(nodeId);
      affectedNodes.push(scope);
    }
    if (report?.review) reviewNodeIds.push(nodeId);
  }
  const first = rootCauses.length === 1 && !rootCauses[0].upstreamUnverified ? rootCauses[0] : null;
  const certainty = first ? 'CONFIRMED' : rootCauses.length > 1 ? 'AMBIGUOUS'
    : reviewNodeIds.length > 0 || reports.size === 0 ? 'UNVERIFIED' : 'NO_CONFIRMED_DEFECT';
  return {
    firstBadStage: first?.stage ?? null, firstBadNodeId: first?.nodeId ?? null,
    rootCauses, affectedNodes, affectedStages: [...new Set(affectedNodes.map(node => node.stage))], reviewNodeIds, certainty,
    retryEligibility: 'UNDETERMINED', countsAsDispatch: false,
  };
}

// A requested leaf does not have output bytes yet; its existing parents must already match.
function validateStageInputs(binding, ancestors, node) {
  requireValue(Array.isArray(ancestors) && record(node));
  validateTopology(binding, { binding, nodes: [...ancestors, node] }, node);
}

module.exports = { analyzeStageGraph, validateStageInputs, stageParentsSha256, stageCheckEvidenceId };
