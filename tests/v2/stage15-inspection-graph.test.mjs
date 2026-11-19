import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import checkpoint from '../../packages/ai-engine/quality/recovery-checkpoint.cjs';
import inspector from '../../packages/ai-engine/quality/stage15-quality-inspection.cjs';
import graphPolicy from '../../packages/ai-engine/quality/stage15-stage-graph.cjs';
import decisionPolicy from '../../packages/ai-engine/quality/stage15-quality-decision.cjs';

const { inspectStage } = inspector;
const { analyzeStageGraph } = graphPolicy;
const { assessStage } = decisionPolicy;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = data => Buffer.from(JSON.stringify(data));
const box = { x: 0, y: 0, width: 0.5, height: 1 };

function binding(mode = 'FULL_IMAGE') {
  return {
    ownerScope: { kind: 'session', id: 'synthetic-session' }, projectId: 'project', pageId: 'page-1',
    pageNumber: 1, requestId: 'request-1', generation: 3, editRevision: 1, contextRevision: 0,
    layoutRevision: 2, sourceSha256: sha('source'), inputDigest: 'b'.repeat(64), mode,
  };
}

function node(id, stage, regionId, parents = [], artifact = { artifactId: `${id}-artifact`, sha256: sha(id) }, inputs = {}) {
  return {
    id, stage, regionId, artifact, inputsSha256: checkpoint.key(inputs),
    parents: parents.map(parent => ({ nodeId: parent.id, ...parent.artifact })),
  };
}

function inspection(stage, bytes, inputs, { regionId = 'r1', mode = 'FULL_IMAGE', id = `${stage}-r1`, pixels } = {}) {
  const current = binding(mode);
  const artifact = { artifactId: `${id}-artifact`, sha256: sha(bytes) };
  return {
    binding: current, node: node(id, stage, regionId, [], artifact, inputs), inputs, bytes, pixels,
    observed: {
      binding: structuredClone(current), stage, artifact: { ...artifact }, attemptId: 'attempt-1',
      state: 'CONFIRMED_SUCCESS', phase: 'BEFORE_DISPATCH', started: false, evidenceRefs: ['attempt-evidence'],
      errorCode: null, costUsd: null, usageConfirmed: false, parentsSha256: checkpoint.key([]),
    },
    authority: { verified: true, binding: structuredClone(current), stage, artifact: { ...artifact }, softApprovals: [] },
  };
}

function ocr(regions = ['r1'], options = {}) {
  const expected = regions.map((id, i) => ({ id, readingOrder: i + 1, sourceLineIds: [`source-${id}`] }));
  const extraction = {
    pageNumber: 1, warnings: [],
    speechBubbles: expected.map(({ id, readingOrder, sourceLineIds }) => ({
      id, readingOrder, text: '合成', bbox: { ...box }, productionOcrProvenance: { sourceDetectionIds: sourceLineIds },
    })),
  };
  return { extraction, input: () => inspection('OCR', json(extraction), { regions: expected }, options) };
}

function translation({ bad = false, uncertain = false, regionId = 'r1' } = {}) {
  const lines = [{ id: regionId, sourceText: '合成', sourceLanguage: 'ja', order: 1 }];
  const content = JSON.stringify({ regions: [{ id: regionId, source_reading: '合成', translation: '합성', uncertain }] });
  const bytes = json({ choices: [{ finish_reason: 'stop', message: {
    role: 'assistant', content: bad ? '{' : content, reasoning_content: content,
  } }] });
  return inspection('TRANSLATE', bytes, { lines }, { regionId, id: `TRANSLATE-${regionId}` });
}

function mask(tamper = false) {
  const bytes = Buffer.alloc(4 * 2 * 4, 255);
  bytes[3] = 0;
  if (tamper) bytes[2 * 4 + 3] = 0;
  return inspection('MASK', bytes, {
    width: 4, height: 2,
    allowedRegions: [{ id: 'r1', bbox: { ...box } }],
    protectedRegions: [{ id: 'protected', bbox: { x: 0.5, y: 0, width: 0.5, height: 1 } }],
  });
}

function typeset({ outside = false, missingGlyph = false } = {}) {
  const width = 8, height = 4;
  const source = Buffer.alloc(width * height * 4, 255);
  const mask = Buffer.from(source);
  mask[3] = 0;
  const cleaned = Buffer.from(source);
  const final = Buffer.from(cleaned);
  final[0] = 0;
  if (outside) final[5 * 4] = 0;
  const line = { id: 'r1', userTranslation: '합성 대사', bbox: { ...box } };
  const layout = {
    id: line.id, bbox: { ...box }, sourceBbox: { ...box },
    productionFontLoaded: true, glyphFontLoaded: true, glyphEvidence: { missingGlyphOccurrences: missingGlyph ? 1 : 0 },
    textEvidence: { complete: true }, fitStatus: 'FIT_VERIFIED', fontSizePx: 32, lineHeight: 1.3,
    measuredFit: { completeText: true, fitsBox: true, linesSeparated: true, inkBounds: [{ left: 0, right: 3, top: 0, bottom: 3 }] },
    safeAreaEvidence: { basis: 'CLOSED_WHITE_COMPONENT_INSET_RECTANGLE' },
    raster: { paintedPixels: 1, outsideInteriorPixels: 0, clippedPixels: 0, canvasEdgePixels: 0, otherRegionCollisionPixels: 0, overlappingInkPixels: 0 },
    actualLayout: { lines: [{ text: line.userTranslation }] },
  };
  const bytes = json({ layouts: [layout], rasterSha256: sha(final) });
  return inspection('TYPESET', bytes, {
    width, height, lines: [line], layoutRegions: [{ id: 'r1', bbox: { ...box }, allowedBbox: { ...box } }],
    sourceRgbaSha256: sha(source), maskRgbaSha256: sha(mask), cleanedRgbaSha256: sha(cleaned),
  }, { mode: 'TYPESETTING_ONLY', pixels: { source, mask, cleaned, final } });
}

function pipeline({ badOcr, badTranslation, translationDefinesMask = false } = {}) {
  const source = node('source', 'SOURCE', null);
  const normal = node('normal', 'NORMALIZED', null, [source]);
  const branches = ['r1', 'r2'].map(region => {
    const o = region === 'r1' && badOcr ? { ...badOcr.node, parents: [normal].map(parent => ({ nodeId: parent.id, ...parent.artifact })) }
      : node(`OCR-${region}`, 'OCR', region, [normal]);
    const t = region === 'r1' && badTranslation ? { ...badTranslation.node, parents: [{ nodeId: o.id, ...o.artifact }] }
      : node(`TRANSLATE-${region}`, 'TRANSLATE', region, [o]);
    const m = node(`MASK-${region}`, 'MASK', region, translationDefinesMask ? [o, t] : [o]);
    const i = node(`inpaint-${region}`, 'INPAINT', region, [m]);
    const s = node(`typeset-${region}`, 'TYPESET', region, [i, t]);
    const v = node(`verify-${region}`, 'VERIFY_FINAL', region, [s]);
    return [o, t, m, i, s, v];
  });
  const publish = node('publish', 'PUBLISH', null, branches.map(items => items.at(-1)));
  return { binding: binding(), nodes: [source, normal, ...branches.flat(), publish] };
}

function inspectNode(input, graph) {
  const current = graph.nodes.find(node => node.id === input.node.id);
  const pins = [...current.parents].sort((left, right) => left.nodeId < right.nodeId ? -1 : 1);
  return inspectStage({ ...input, node: current, observed: { ...input.observed, parentsSha256: checkpoint.key(pins) } });
}

test('bound OCR evidence feeds the unchanged S15-01 policy and keeps inputs intact', () => {
  const input = ocr().input();
  const original = structuredClone(input.observed);
  const { assessment } = inspectStage(input);
  assert.deepEqual(input.observed, original);
  const check = assessment.observed.checks[0];
  assert.equal(check.status, 'passed');
  assert.equal(check.subjectArtifactId, input.node.artifact.artifactId);
  assert.equal(check.subjectSha256, sha(input.bytes));
  assert.deepEqual(check.identity, input.binding);
  assert.equal(assessment.authority.requiredChecks[0].version, check.version);
  assert.equal(assessStage(assessment).kind, 'PASS');
});

test('prior evidence is rejected when the revision, owner, stage input, or node artifact changes', () => {
  for (const [label, mutate] of [
    ['layout', i => { i.observed.binding.layoutRevision--; }],
    ['owner kind', i => { i.observed.binding.ownerScope.kind = 'owner'; }],
    ['scope input', i => { i.inputs.regions[0].sourceLineIds = ['foreign-source']; }],
    ['artifact identity', i => { i.node.artifact.artifactId = 'different-artifact'; }],
  ]) {
    const input = ocr().input();
    mutate(input);
    assert.throws(() => inspectStage(input), { code: 'STAGE15_INSPECTION_STALE' }, label);
  }
  const overwritten = ocr().input();
  overwritten.bytes[0] ^= 1;
  assert.throws(() => inspectStage(overwritten), { code: 'SOURCE_INTEGRITY_FAILED' });
});

for (const [code, mutate, regionId] of [
  ['OCR_REGION_DUPLICATE', e => { e.speechBubbles.push(e.speechBubbles[0]); }, 'r1'],
  ['OCR_REGION_MISSING', e => { e.speechBubbles.pop(); }, 'r2'],
  ['OCR_LINEAGE_MISMATCH', e => { e.speechBubbles[1].productionOcrProvenance.sourceDetectionIds = ['source-r1']; }, 'r2'],
  ['OCR_READING_ORDER_INVALID', e => { e.speechBubbles[1].readingOrder = 1; }, 'r2'],
]) {
  test(`${code} is HARD with measured OCR provenance at the affected region`, () => {
    const fixture = ocr(['r1', 'r2'], { regionId: null });
    mutate(fixture.extraction);
    const { assessment } = inspectStage(fixture.input());
    const check = assessment.observed.checks[0];
    assert.equal(check.status, 'failed');
    assert.ok(assessment.findings.some(f => f.code === code && f.regionId === regionId &&
      f.severity === 'HARD' && f.evidenceId === check.evidenceId));
    assert.equal(assessStage(assessment).kind, 'BLOCKED');
  });
}

test('a valid translation in reasoning cannot rescue broken final content', () => {
  const { assessment } = inspectStage(translation({ bad: true }));
  assert.equal(assessStage(assessment).kind, 'BLOCKED');
  assert.equal(assessment.findings[0].code, 'PAGE_TRANSLATION_INVALID');
});

test('a meaning risk stays a scoped SOFT warning while the final content check passes', () => {
  const { assessment } = inspectStage(translation({ uncertain: true }));
  assert.equal(assessment.observed.checks[0].status, 'passed');
  assert.ok(assessment.findings.some(f => f.code === 'MODEL_UNCERTAIN' && f.severity === 'SOFT' &&
    f.scope === 'TRANSLATION_SEMANTICS' && f.regionId === 'r1'));
  assert.equal(assessStage(assessment).kind, 'MANUAL_REVIEW');
});

test('one changed protected mask pixel is detected even when the resulting bytes have a current hash', () => {
  const good = mask();
  const damaged = mask(true);
  assert.equal(good.bytes.reduce((count, value, i) => count + Number(value !== damaged.bytes[i]), 0), 1);
  assert.equal(assessStage(inspectStage(good).assessment).kind, 'PASS');
  const { assessment } = inspectStage(damaged);
  assert.equal(assessStage(assessment).kind, 'BLOCKED');
  assert.equal(assessment.findings[0].code, 'MASK_PROTECTED_PIXEL_CHANGED');
});

test('layout and verified pixel scope pass with the bound report and all four raw rasters', () => {
  const { assessment } = inspectStage(typeset());
  assert.equal(assessStage(assessment).kind, 'PASS');
});

test('typesetting reports a HARD glyph violation and a separate out-of-scope actual pixel change', () => {
  for (const [options, code] of [
    [{ missingGlyph: true }, 'FONT_OR_GLYPH_ERROR'],
    [{ outside: true }, 'TYPESET_PROTECTED_PIXEL_CHANGED'],
  ]) {
    const { assessment } = inspectStage(typeset(options));
    assert.equal(assessStage(assessment).kind, 'BLOCKED', code);
    assert.ok(assessment.findings.some(f => f.code === code && f.severity === 'HARD'), code);
  }
});

test('missing raster or observation evidence cannot be used as a passed inspection', () => {
  const missing = typeset();
  delete missing.pixels;
  const unknown = ocr().input();
  unknown.observed.evidenceRefs = [];
  for (const input of [missing, unknown]) {
    const { assessment } = inspectStage(input);
    assert.equal(assessment.observed.checks[0].status, 'not_measured');
    assert.equal(assessment.observed.checks[0].evidenceId, null);
    assert.equal(assessStage(assessment).kind, 'MANUAL_REVIEW');
  }
  const replaced = typeset();
  replaced.pixels.final[0] ^= 1;
  assert.throws(() => inspectStage(replaced), { code: 'SOURCE_INTEGRITY_FAILED' });
});

test('earliest confirmed defect precedes a dependent symptom and affects only its explicit descendants', () => {
  const fixture = ocr();
  fixture.extraction.speechBubbles[0].productionOcrProvenance.sourceDetectionIds = ['foreign'];
  const badOcr = fixture.input(), badTranslation = translation({ bad: true });
  const graph = pipeline({ badOcr, badTranslation });
  const before = structuredClone(graph);
  const reports = [inspectNode(badTranslation, graph), inspectNode(badOcr, graph)];
  const result = analyzeStageGraph({ binding: binding(), graph, inspections: reports });
  assert.equal(result.firstBadStage, 'OCR');
  assert.equal(result.firstBadNodeId, 'OCR-r1');
  assert.equal(result.rootCauses[0].pageId, 'page-1');
  assert.equal(result.rootCauses[0].regionId, 'r1');
  assert.deepEqual(new Set(result.affectedNodes.map(n => n.nodeId)), new Set([
    'OCR-r1', 'TRANSLATE-r1', 'MASK-r1', 'inpaint-r1', 'typeset-r1', 'verify-r1', 'publish',
  ]));
  assert.equal(result.countsAsDispatch, false);
  assert.deepEqual(graph, before);
  assert.deepEqual(analyzeStageGraph({ binding: binding(), graph: { ...graph, nodes: [...graph.nodes].reverse() }, inspections: reports.reverse() }), result);
});

test('translation affects the mask branch only if the graph records that dependency', () => {
  const badTranslation = translation({ bad: true });
  for (const enabled of [false, true]) {
    const graph = pipeline({ badTranslation, translationDefinesMask: enabled });
    const result = analyzeStageGraph({ binding: binding(), graph, inspections: [inspectNode(badTranslation, graph)] });
    assert.equal(result.firstBadStage, 'TRANSLATE');
    assert.equal(result.affectedStages.includes('MASK'), enabled);
    assert.equal(result.affectedStages.includes('INPAINT'), enabled);
  }
});

test('a SOFT warning without a confirmed failure has no root or retry scope', () => {
  const warning = translation({ uncertain: true });
  const graph = pipeline({ badTranslation: warning });
  const result = analyzeStageGraph({ binding: binding(), graph, inspections: [inspectNode(warning, graph)] });
  assert.equal(result.firstBadStage, null);
  assert.deepEqual(result.affectedNodes, []);
  assert.deepEqual(result.reviewNodeIds, ['TRANSLATE-r1']);
});

test('independent confirmed failures are reported without guessing the first root', () => {
  const a = translation({ bad: true }), b = translation({ bad: true, regionId: 'r2' });
  const graph = pipeline({ badTranslation: a });
  const target = graph.nodes.find(n => n.id === b.node.id);
  Object.assign(target, { artifact: b.node.artifact, inputsSha256: b.node.inputsSha256 });
  const typeset = graph.nodes.find(n => n.id === 'typeset-r2');
  Object.assign(typeset.parents.find(p => p.nodeId === target.id), target.artifact);
  const result = analyzeStageGraph({ binding: binding(), graph, inspections: [inspectNode(a, graph), inspectNode(b, graph)] });
  assert.equal(result.firstBadNodeId, null);
  assert.equal(result.certainty, 'AMBIGUOUS');
  assert.deepEqual(result.rootCauses.map(n => n.regionId), ['r1', 'r2']);
});

test('cycles, stale graph binding, parents, and inspection scope fail closed', () => {
  const badTranslation = translation({ bad: true });
  const create = () => {
    const graph = pipeline({ badTranslation });
    return { binding: binding(), graph, inspections: [inspectNode(badTranslation, graph)] };
  };
  const cycle = create();
  const source = cycle.graph.nodes.find(n => n.id === 'source'), publish = cycle.graph.nodes.find(n => n.id === 'publish');
  source.parents.push({ nodeId: publish.id, ...publish.artifact });
  assert.throws(() => analyzeStageGraph(cycle), { code: 'STAGE15_GRAPH_CYCLE' });
  for (const mutate of [
    i => { i.graph.binding.layoutRevision--; },
    i => { i.graph.nodes.find(n => n.id === 'normal').parents[0].sha256 = 'd'.repeat(64); },
    i => { i.inspections[0].inputsSha256 = 'e'.repeat(64); },
    i => { i.inspections[0].assessment.observed.checks[0].identity.layoutRevision--; },
    i => { i.inspections[0].regionId = 'r2'; },
  ]) {
    const input = create();
    mutate(input);
    assert.throws(() => analyzeStageGraph(input), { code: 'STAGE15_GRAPH_STALE' });
  }
});

test('a consistently rewired source still has to match the current original digest', () => {
  const graph = pipeline();
  const sha256 = sha('different-source');
  graph.nodes.find(n => n.id === 'source').artifact.sha256 = sha256;
  graph.nodes.find(n => n.id === 'normal').parents[0].sha256 = sha256;
  assert.throws(() => analyzeStageGraph({ binding: binding(), graph }), { code: 'STAGE15_GRAPH_STALE' });
});

test('rebinding a parent edge does not carry the old child inspection forward', () => {
  const badTranslation = translation({ bad: true });
  const graph = pipeline({ badTranslation });
  const report = inspectNode(badTranslation, graph);
  const sha256 = sha('replaced-ocr-artifact');
  graph.nodes.find(n => n.id === 'OCR-r1').artifact.sha256 = sha256;
  for (const node of graph.nodes) {
    const prior = node.parents.find(p => p.nodeId === 'OCR-r1');
    if (prior) prior.sha256 = sha256;
  }
  const analyze = inspections => analyzeStageGraph({ binding: binding(), graph, inspections });
  assert.throws(() => analyze([report]), { code: 'STAGE15_GRAPH_STALE' });
  const current = inspectNode(badTranslation, graph);
  assert.throws(() => analyze([{ ...report, parentsSha256: current.parentsSha256 }]), { code: 'STAGE15_GRAPH_STALE' });
  assert.equal(analyze([current]).firstBadStage, 'TRANSLATE');
});

test('the inspector rejects an observation whose reported parent set differs from the current node', () => {
  const input = translation({ bad: true });
  const graph = pipeline({ badTranslation: input });
  const current = graph.nodes.find(node => node.id === input.node.id);
  assert.throws(() => inspectStage({ ...input, node: current }), { code: 'STAGE15_INSPECTION_STALE' });
});

test('explicitly unverified upstream evidence leaves the first cause unresolved', () => {
  const pendingOcr = ocr().input();
  pendingOcr.observed.evidenceRefs = [];
  const badTranslation = translation({ bad: true });
  const graph = pipeline({ badOcr: pendingOcr, badTranslation });
  const result = analyzeStageGraph({
    binding: binding(), graph, inspections: [inspectNode(badTranslation, graph), inspectNode(pendingOcr, graph)],
  });
  assert.equal(result.firstBadStage, null);
  assert.equal(result.certainty, 'UNVERIFIED');
  assert.deepEqual(result.reviewNodeIds, ['OCR-r1']);
  assert.equal(result.affectedStages.includes('OCR'), false);
  assert.equal(result.affectedStages.includes('TRANSLATE'), true);
});

test('typesetting-only graph uses approved read-only inputs and has no model stage', () => {
  const typesetting = typeset({ missingGlyph: true });
  const cleaned = node('cleaned', 'VERIFIED_CLEANED_INPUT', null);
  const translation = node('selected-text', 'APPROVED_TRANSLATION_INPUT', null);
  const layout = node('approved-layout', 'APPROVED_LAYOUT_INPUT', null);
  const render = { ...typesetting.node, parents: [cleaned, translation, layout].map(parent => ({ nodeId: parent.id, ...parent.artifact })) };
  const verify = node('verify', 'VERIFY_FINAL', null, [render]);
  const publish = node('publish', 'PUBLISH', null, [verify]);
  const current = binding('TYPESETTING_ONLY');
  const graph = { binding: structuredClone(current), nodes: [publish, cleaned, verify, render, translation, layout] };
  const input = { binding: current, graph, inspections: [inspectNode(typesetting, graph)] };
  const result = analyzeStageGraph(input);
  assert.deepEqual(result.affectedStages, ['TYPESET', 'VERIFY_FINAL', 'PUBLISH']);
  assert.equal(result.countsAsDispatch, false);
  input.graph.nodes.push(node('no-ocr', 'OCR', 'r2'));
  assert.throws(() => analyzeStageGraph(input), { code: 'STAGE15_GRAPH_INVALID' });
});
