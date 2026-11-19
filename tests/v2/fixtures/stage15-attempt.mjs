// Shared by the test runner and its independent Node processes. All effects live under root.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import checkpoint from '../../../packages/ai-engine/quality/recovery-checkpoint.cjs';

export const { key } = checkpoint;
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const parentRef = node => ({ nodeId: node.id, ...node.artifact });

export function request(suffix = '1', stage = 'TRANSLATE') {
  const sourceSha256 = sha('owned synthetic source');
  const ancestors = [];
  for (const type of ['SOURCE', 'NORMALIZED', 'OCR', ...(stage === 'INPAINT' ? ['MASK'] : [])]) {
    ancestors.push({ id: type.toLowerCase(), stage: type, regionId: null, inputsSha256: key({ type }),
      artifact: { artifactId: type, sha256: type === 'SOURCE' ? sourceSha256 : sha(type) },
      parents: ancestors.length ? [parentRef(ancestors.at(-1))] : [] });
  }
  const inputs = stage === 'TRANSLATE' ? { lines: ['r1', 'r2'].map(id => ({ id, sourceText: '合成', sourceLanguage: 'ja' })) } : {};
  return {
    action: 'EXECUTE_STAGE', requestKey: 'send-' + suffix, lineageId: 'approved-run', runAuthorityId: 'grant-' + suffix,
    provider: { providerId: 'primary', modelId: 'primary-model', modelVersion: 'v1', profileDigest: sha('primary') },
    input: { executionId: 'attempt-' + suffix, regionIds: ['r1', 'r2'], inputs,
      binding: { ownerScope: { kind: 'session', id: 'test-owner' }, projectId: 'book', pageId: 'p1', pageNumber: 1,
        requestId: 'page-request-' + suffix, generation: 1, editRevision: 1, contextRevision: 2, layoutRevision: 3,
        sourceSha256, inputDigest: sha('page-input-' + suffix), mode: 'FULL_IMAGE' },
      node: { id: stage.toLowerCase(), stage, regionId: null, inputsSha256: key(inputs), parents: [parentRef(ancestors.at(-1))] } },
    ancestors,
  };
}

export function alternate(primary, suffix) {
  const cmd = structuredClone(primary);
  Object.assign(cmd, { action: 'RESERVE_FALLBACK', requestKey: 'fallback-' + suffix, previousExecutionId: primary.input.executionId });
  cmd.input.executionId = 'alternate-' + suffix;
  cmd.provider = { providerId: 'alternate', modelId: 'alternate-model', modelVersion: 'v1', profileDigest: sha('alternate') };
  return cmd;
}

export function authority(cmd) {
  return { verified: true, cancelled: false, runAuthorityId: cmd.runAuthorityId, binding: structuredClone(cmd.input.binding),
    executionRequestSha256: key(cmd), softApprovals: [],
    requiredChecks: [{ checkId: cmd.input.node.stage === 'TRANSLATE' ? 'page-translation' : 'stage-inspection', version: 'stage15-inspection-v1' }] };
}

function makeReceipt(req, flavor) {
  const rows = req.regionIds.map(id => ({ id, source_reading: '合成', translation: '합성', uncertain: flavor === 'soft' && id === 'r1' }));
  const content = flavor === 'hard' ? '{' : JSON.stringify({ regions: rows });
  const bytes = Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }));
  const partial = flavor === 'partial';
  const failure = ['failure', 'not-started', 'cleanup-unknown'].includes(flavor);
  return { executionId: req.executionId, requestId: req.requestId, inputDigest: req.inputDigest, inputFingerprint: req.inputFingerprint,
    outcome: failure ? (flavor === 'not-started' ? 'NOT_STARTED' : 'FAILURE') : partial ? 'PARTIAL' : 'SUCCESS',
    evidenceId: req.executionId + '-receipt', providerRef: 'synthetic-ref',
    finishReason: flavor === 'cleanup-unknown' ? 'CLEANUP_FAILED' : failure ? 'UNAVAILABLE' : 'COMPLETED',
    started: flavor !== 'not-started', usageConfirmed: flavor !== 'unsettled', costUsd: flavor === 'unsettled' ? null : '0.10',
    usageEvidenceId: flavor === 'unsettled' ? null : req.executionId + '-charge', confidence: null,
    data: failure ? null : { artifact: { artifactId: 'translation', sha256: sha(bytes) }, bytes,
      regionIds: partial ? ['r1'] : req.regionIds, missingRegionIds: partial ? ['r2'] : [], complete: !partial } };
}

export function calls(root) {
  const file = path.join(root, 'provider-calls.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(row => JSON.parse(row)) : [];
}

export function providers(root, options = {}) {
  return ['primary', 'alternate'].map(providerId => {
    const log = (op, req) => appendFileSync(path.join(root, 'provider-calls.jsonl'),
      JSON.stringify({ op, providerId, id: req.executionId, input: req.inputFingerprint, pid: process.pid }) + '\n');
    const file = req => path.join(root, 'provider-' + sha(req.executionId) + '.json');
    const port = { synthetic: true, async dispatch(req, started) {
      log('dispatch', req);
      if (options.flavor !== 'not-started') await started(req.executionId + '-start');
      writeFileSync(file(req), JSON.stringify({ fingerprint: req.inputFingerprint, flavor: options.flavor ?? 'pass' }), { flag: 'wx' });
      await options.duringDispatch?.(req);
      if (options.loseReply) throw Object.assign(Error('lost response'), { code: 'ETIMEDOUT' });
      return makeReceipt(req, options.flavor);
    } };
    if (options.lookup !== 'unsupported') port.lookup = async (executionId, req) => {
      log('lookup', req);
      if (executionId !== req.executionId || options.lookup === 'error') throw Error('lookup error');
      if (options.lookup === 'missing' || !existsSync(file(req))) return null;
      const saved = JSON.parse(readFileSync(file(req)));
      if (saved.fingerprint !== req.inputFingerprint) throw Error('different provider input');
      return makeReceipt(req, options.lookupFlavor ?? saved.flavor);
    };
    return { providerId, modelId: providerId + '-model', modelVersion: options.modelVersion ?? 'v1',
      profileDigest: sha(providerId), transport: 'SYNTHETIC', stages: ['TRANSLATE', 'INPAINT'],
      supportsLookup: Boolean(port.lookup), supportsPartial: true, confidence: null, port };
  });
}

// A hard exit leaves no finally handlers alive. The external provider fact is already on disk.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createStage15AttemptExecutor } = await import('../../../apps/engine/stage15-attempt-executor.mjs');
  const [root, crash] = process.argv.slice(2);
  const cmd = request();
  const ports = providers(root, { duringDispatch() { if (crash === 'after-dispatch') process.exit(73); } });
  const executor = await createStage15AttemptExecutor({ root, providers: ports, currentAuthority: () => authority(cmd),
    onBoundary: name => { if (name === crash) process.exit(73); } });
  process.send('ready');
  await new Promise(resolve => process.once('message', resolve));
  const result = await executor.execute(cmd);
  process.send(result.status);
  process.disconnect();
}
