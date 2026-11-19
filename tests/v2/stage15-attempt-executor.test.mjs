import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createStage15AttemptExecutor } from '../../apps/engine/stage15-attempt-executor.mjs';
import { createStage15ProviderAdapter } from '../../apps/engine/stage15-provider-adapter.mjs';
import { alternate, authority, calls, key, providers, request, sha } from './fixtures/stage15-attempt.mjs';

const childFixture = new URL('./fixtures/stage15-attempt.mjs', import.meta.url);
async function setup(t, options = {}, cmd = request()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 's15-attempt-'));
  const grants = new Map([[cmd.input.executionId, authority(cmd)]]);
  const open = (extra = {}) => createStage15AttemptExecutor({ root, providers: providers(root, options),
    currentAuthority: id => grants.get(id) ?? null, ...extra });
  t.after(async () => {
    const facts = calls(root);
    t.diagnostic('synthetic ' + JSON.stringify({ dispatch: facts.filter(c => c.op === 'dispatch').length,
      lookup: facts.filter(c => c.op === 'lookup').length }));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, cmd, id: cmd.input.executionId, grant: grants.get(cmd.input.executionId), grants, open,
    calls: () => calls(root), add(c) { grants.set(c.input.executionId, authority(c)); }, executor: await open() };
}

function barrier(phase) {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  return { entered: entered.promise, release: release.resolve, onBoundary: async name => {
    if (phase === name) { entered.resolve(); await release.promise; }
  } };
}

async function worker(t, root, crash = 'none') {
  const proc = fork(childFixture, [root, crash], { execPath: process.execPath, execArgv: [], silent: true, windowsHide: true });
  let err = '';
  proc.stderr.on('data', chunk => { err += chunk; });
  t.after(() => { if (proc.exitCode === null) proc.kill(); });
  const exit = once(proc, 'exit').then(([code]) => code);
  const ready = once(proc, 'message').then(([value]) => value);
  assert.equal(await Promise.race([ready, exit.then(code => 'exit ' + code + ' ' + err)]), 'ready');
  return { go: () => proc.send('go'), exit };
}

test('preflight pin uses the same S15-03 fingerprint as the actual port without triggering it', async t => {
  const f = await setup(t);
  const adapter = createStage15ProviderAdapter({ providers: providers(f.root) });
  assert.equal(typeof adapter.describe, 'function');
  const pin = adapter.describe('primary', f.cmd.input);
  assert.deepEqual(pin.provider, f.cmd.provider);
  assert.deepEqual(f.calls(), []);
  await f.executor.execute(f.cmd);
  assert.equal(pin.inputFingerprint, f.calls()[0].input);
});

test('two independent executors consume one reservation and publish one checked result across restart', async t => {
  const f = await setup(t), other = await f.open();
  await Promise.all([f.executor.execute(f.cmd), other.execute(structuredClone(f.cmd))]);
  const restarted = await f.open();
  const done = await restarted.execute(f.cmd);
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.decision.kind, 'PASS');
  assert.equal(done.checks[0].checkId, 'page-translation');
  assert.equal(done.checks[0].status, 'passed');
  assert.equal(done.graph.certainty, 'NO_CONFIRMED_DEFECT');
  assert.equal(done.publication.artifact.sha256, sha(await fs.readFile(path.join(f.root, done.candidate.file))));
  assert.equal(done.execution.started, true);
  assert.equal(done.execution.costUsd, '0.10');
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch']);
});

test('changed request payload, reused execution ID and a second primary slot cannot buy another dispatch', async t => {
  const f = await setup(t);
  await f.executor.execute(f.cmd);
  for (const change of [
    cmd => { cmd.input.binding.editRevision++; },
    cmd => { cmd.runAuthorityId = 'new-grant'; },
    cmd => { cmd.provider.modelVersion = 'v2'; },
    cmd => { cmd.input.executionId += '-other'; },
    cmd => { cmd.requestKey += '-other'; },
    cmd => { cmd.requestKey += '-other'; cmd.input.executionId += '-other'; cmd.input.binding.requestId += '-other'; },
  ]) {
    const changed = structuredClone(f.cmd);
    change(changed); f.add(changed);
    await assert.rejects((await f.open()).execute(changed), { code: /CONFLICT|CONSUMED|MISMATCH/ });
  }
  assert.equal(f.calls().length, 1);
});

test('separate Node processes race the same disk reservation with exactly one provider dispatch', async t => {
  const f = await setup(t);
  const children = await Promise.all([worker(t, f.root), worker(t, f.root)]);
  children.forEach(c => c.go());
  assert.deepEqual(await Promise.all(children.map(c => c.exit)), [0, 0]);
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch']);
  assert.notEqual(f.calls()[0].pid, process.pid);
  assert.equal((await f.executor.get(f.id)).status, 'SUCCEEDED');
});

test('a flat version-one epoch keeps its consumed attempt when a new executor appends another page', async t => {
  const f = await setup(t);
  const adapter = createStage15ProviderAdapter({ providers: providers(f.root) });
  const attempts = [{ request: f.cmd, requestSha256: key(f.cmd), pin: adapter.describe('primary', f.cmd.input),
    dispatchIntent: true, cancelled: false, startEvidenceIds: [], observations: [], publications: [] }];
  const original = JSON.stringify({ version: 1, sequence: 1, attempts, sha256: key(attempts) });
  const legacyFile = path.join(f.root, 'attempt-epoch-000000000001.json');
  await fs.writeFile(legacyFile, original, { flag: 'wx' });
  const executor = await f.open();
  assert.equal((await executor.execute(f.cmd)).status, 'RESULT_UNKNOWN');
  const otherPage = request('2');
  otherPage.input.binding.pageId = 'p2';
  otherPage.input.binding.pageNumber = 2;
  f.add(otherPage);
  assert.equal((await executor.execute(otherPage)).status, 'SUCCEEDED');
  const restarted = await f.open();
  assert.equal((await restarted.execute(f.cmd)).status, 'RESULT_UNKNOWN');
  assert.deepEqual(f.calls().map(c => [c.op, c.id]), [['dispatch', otherPage.input.executionId]]);
  assert.equal(await fs.readFile(legacyFile, 'utf8'), original);
});

for (const [point, expectedCalls] of [['after-reserve', 0], ['after-dispatch', 1], ['after-response', 1]]) {
  test('hard exit ' + point + ' recovers only the reserved execution and provider input', async t => {
    const f = await setup(t);
    const child = await worker(t, f.root, point);
    child.go();
    assert.equal(await child.exit, 73);
    assert.equal(f.calls().length, expectedCalls);
    const state = await (await f.open()).recover(f.id);
    assert.equal(state.status, expectedCalls ? 'SUCCEEDED' : 'RESULT_UNKNOWN');
    assert.equal(state.lookupStatus, expectedCalls ? 'RETURNED' : 'NOT_FOUND');
    assert.equal(Boolean(state.publication), Boolean(expectedCalls));
    const logged = f.calls();
    assert.equal(logged.at(-1).op, 'lookup');
    assert.equal(logged.filter(c => c.op === 'dispatch').length, expectedCalls);
    assert.equal(new Set(logged.map(c => key([c.id, c.providerId, c.input]))).size, 1);
    assert.equal(logged.at(-1).id, f.id);
  });
}

for (const [lookup, status] of [['missing', 'NOT_FOUND'], ['unsupported', 'UNSUPPORTED'], ['error', 'ERROR']]) {
  test('inconclusive ' + status + ' lookup preserves prior start and blocks redispatch and fallback', async t => {
    const f = await setup(t, { loseReply: true, lookup });
    assert.equal((await f.executor.execute(f.cmd)).status, 'RESULT_UNKNOWN');
    const restarted = await f.open(), state = await restarted.recover(f.id);
    assert.equal(state.lookupStatus, status);
    assert.equal(state.execution.started, true);
    assert.ok(state.execution.evidenceRefs.includes(f.id + '-start'));
    assert.equal(state.execution.costUsd, null);
    assert.equal(state.status, 'RESULT_UNKNOWN');
    assert.equal(state.publication, null);
    const fallback = alternate(f.cmd, 'one');
    f.add(fallback);
    await assert.rejects(restarted.execute(fallback), { code: 'FALLBACK_INELIGIBLE' });
    await restarted.execute(f.cmd);
    assert.equal(f.calls().filter(c => c.op === 'dispatch').length, 1);
  });
}

test('a pinned registry mismatch prevents recovery from probing a new model version', async t => {
  const f = await setup(t, { loseReply: true });
  await f.executor.execute(f.cmd);
  const changed = await f.open({ providers: providers(f.root, { modelVersion: 'updated' }) });
  const result = await changed.recover(f.id);
  assert.equal(result.status, 'RESULT_UNKNOWN');
  assert.ok(result.blockedReasons.includes('PROVIDER_PIN_MISMATCH'));
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch']);
});

test('PASS alone, wrong owner, stale revision, unapproved payload and forbidden mode cannot dispatch', async t => {
  const f = await setup(t);
  await assert.rejects(f.executor.execute({ kind: 'PASS' }));
  for (const mutate of [a => { a.verified = false; }, a => { a.binding.ownerScope.id = 'other'; },
    a => { a.binding.editRevision++; }, a => { a.executionRequestSha256 = sha('other'); }, a => { a.cancelled = true; }]) {
    const current = authority(f.cmd);
    mutate(current); f.grants.set(f.id, current);
    await assert.rejects(f.executor.execute(f.cmd));
  }
  const wrongMode = structuredClone(f.cmd);
  wrongMode.input.binding.mode = 'TYPESETTING_ONLY';
  f.add(wrongMode);
  await assert.rejects(f.executor.execute(wrongMode));
  assert.deepEqual(f.calls(), []);
});

test('cancellation after reservation and before dispatch consumes the slot without calling the provider', { timeout: 10000 }, async t => {
  const f = await setup(t), gate = barrier('after-reserve'), active = await f.open({ onBoundary: gate.onBoundary });
  const run = active.execute(f.cmd);
  await gate.entered;
  try { await f.executor.cancel(f.id); } finally { gate.release(); }
  const result = await run;
  assert.equal(result.status, 'CANCELLED');
  assert.equal(result.execution.started, false);
  assert.equal(result.execution.costUsd, null);
  await (await f.open()).recover(f.id);
  assert.deepEqual(f.calls(), []);
});

test('late provider success after cancellation keeps the actual start and charge, with publication blocked', async t => {
  const gate = barrier('provider'), f = await setup(t, { duringDispatch: () => gate.onBoundary('provider') });
  const active = f.executor.execute(f.cmd);
  await gate.entered;
  try {
    const pending = await (await f.open()).cancel(f.id);
    assert.equal(pending.status, 'RESULT_UNKNOWN');
    assert.equal(pending.execution.started, true);
    assert.ok(pending.execution.evidenceRefs.includes(f.id + '-start'));
    assert.equal(pending.execution.costUsd, null);
  } finally { gate.release(); }
  const done = await active;
  assert.equal(done.cancelled, true);
  assert.equal(done.status, 'CANCELLED');
  assert.equal(done.publication, null);
  assert.equal(done.execution.state, 'CONFIRMED_SUCCESS');
  assert.equal(done.execution.costUsd, '0.10');
});

for (const change of ['owner', 'revision', 'revoked', 'cancelled']) {
  test('publication rechecks current ' + change + ' after successful QA', async t => {
    const f = await setup(t);
    const active = await f.open({ onBoundary(name) {
      if (name !== 'before-publish') return;
      if (change === 'owner') f.grant.binding.ownerScope.id = 'different';
      if (change === 'revision') f.grant.binding.layoutRevision++;
      if (change === 'revoked') f.grant.verified = false;
      if (change === 'cancelled') f.grant.cancelled = true;
    } });
    const result = await active.execute(f.cmd);
    assert.equal(result.publication, null);
    assert.ok(result.blockedReasons.length > 0);
    assert.equal(result.execution.state, 'CONFIRMED_SUCCESS');
    assert.equal(result.execution.costUsd, '0.10');
    assert.equal((await f.executor.get(f.id)).publication, null);
  });
}

test('authority mismatch and unknown provider effects survive together on restart', async t => {
  const f = await setup(t, { loseReply: true });
  await f.executor.execute(f.cmd);
  f.grant.binding.ownerScope.id = 'revoked-owner';
  const state = await (await f.open()).recover(f.id);
  assert.ok(state.blockedReasons.includes('AUTHORITY_MISMATCH'));
  assert.equal(state.execution.resultUnknown, true);
  assert.equal(state.execution.started, true);
  assert.equal(state.execution.costUsd, null);
  assert.equal(state.publication, null);
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch']);
});

for (const [flavor, code] of [['hard', 'PAGE_TRANSLATION_INVALID'], ['partial', 'STAGE_INCOMPLETE'],
  ['unimplemented', 'CHECK_NOT_IMPLEMENTED'], ['missing-check', 'QUALITY_EVIDENCE_MISSING'], ['unsettled', 'RESULT_UNKNOWN']]) {
  test(flavor + ' candidate never becomes a successful publication', async t => {
    const f = await setup(t, { flavor }, request('1', flavor === 'unimplemented' ? 'INPAINT' : 'TRANSLATE'));
    if (flavor === 'missing-check') f.grant.requiredChecks.push({ checkId: 'extra-required', version: 'v1' });
    const result = await f.executor.execute(f.cmd);
    assert.ok(result.candidate);
    assert.equal(result.publication, null);
    assert.ok([...result.decision.reasons, ...result.findings.map(f => f.code)].includes(code));
    if (flavor === 'hard') assert.equal(result.graph.firstBadStage, 'TRANSLATE');
    if (flavor === 'partial') assert.deepEqual(result.candidate.missingRegionIds, ['r2']);
  });
}

test('only an exactly bound human SOFT approval can publish saved bytes and the original warning', async t => {
  const f = await setup(t, { flavor: 'soft' });
  const first = await f.executor.execute(f.cmd);
  assert.equal(first.status, 'MANUAL_REVIEW');
  const warn = first.findings.find(f => f.code === 'MODEL_UNCERTAIN');
  assert.ok(warn);
  const check = first.checks[0], artifact = first.candidate.artifact;
  const approval = { actor: 'human', stage: 'TRANSLATE', identity: f.cmd.input.binding, subjectArtifactId: artifact.artifactId,
    subjectSha256: artifact.sha256, evidenceId: 'synthetic-review', findingId: warn.id, code: warn.code, scope: warn.scope,
    regionId: warn.regionId, checkId: check.checkId, checkVersion: check.version, checkEvidenceId: check.evidenceId };
  f.grant.softApprovals = [{ ...approval, regionId: 'r2' }];
  assert.equal((await f.executor.recover(f.id)).status, 'MANUAL_REVIEW');
  f.grant.softApprovals = [{ ...approval, evidenceId: 'wrong-region-review', regionId: 'r2' }, approval];
  const accepted = await (await f.open()).recover(f.id);
  assert.equal(accepted.status, 'SUCCEEDED');
  assert.deepEqual(accepted.decision.acceptedSoftFindingIds, [warn.id]);
  assert.deepEqual(accepted.publication.findings, first.findings);
  assert.deepEqual(accepted.publication.reviewEvidenceIds, ['synthetic-review']);
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch']);
});

test('fallback is a reservation only and stays spent across competing stages, authority renewal and restart', async t => {
  const f = await setup(t, { flavor: 'failure' });
  const second = request('2', 'INPAINT');
  f.add(second);
  assert.equal((await f.executor.execute(f.cmd)).execution.state, 'CONFIRMED_FAILURE');
  await f.executor.execute(second);
  const a = alternate(f.cmd, 'a'), b = alternate(second, 'b');
  f.add(a); f.add(b);
  const results = await Promise.allSettled([f.executor.execute(a), (await f.open()).execute(b)]);
  const winner = results.findIndex(r => r.status === 'fulfilled');
  assert.notEqual(winner, -1);
  assert.equal(results[winner].value.status, 'FALLBACK_RESERVED');
  assert.equal(results[1 - winner].reason.code, 'FALLBACK_CONSUMED');
  const won = [a, b][winner], lost = [a, b][1 - winner], restarted = await f.open();
  assert.equal((await restarted.recover(won.input.executionId)).status, 'FALLBACK_RESERVED');
  lost.runAuthorityId = 'renewed';
  f.add(lost);
  await assert.rejects(restarted.execute(lost), { code: 'FALLBACK_CONSUMED' });
  assert.deepEqual(f.calls().map(c => [c.providerId, c.op]), [['primary', 'dispatch'], ['primary', 'dispatch']]);
});

test('actual final receipt write failure preserves the previous publication, candidate and consumption', async t => {
  const f = await setup(t), first = await f.executor.execute(f.cmd), prior = await fs.readFile(path.join(f.root, first.candidate.file));
  const next = request('2');
  f.add(next);
  const broken = await f.open({ onBoundary: async (phase, info) => {
    // Force a real filesystem error at the staged atomic-state rename.
    if (phase === 'before-commit' && info.transition === 'publish') await fs.mkdir(path.join(info.stagingDirectory, 'state.json'));
  } });
  const outcome = await broken.execute(next);
  assert.equal(outcome.status, 'RESULT_UNKNOWN');
  assert.equal(outcome.publication, null);
  assert.ok(outcome.blockedReasons.includes('COMMIT_UNKNOWN'));
  const restarted = await f.open();
  assert.deepEqual((await restarted.get(f.id)).publication, first.publication);
  assert.deepEqual(await fs.readFile(path.join(f.root, first.candidate.file)), prior);
  assert.equal((await restarted.execute(next)).publication, null);
  assert.equal((await restarted.recover(next.input.executionId)).status, 'SUCCEEDED');
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch', 'dispatch']);
});

test('a hard exit with a durable candidate has no success marker and revalidates it without dispatch', async t => {
  const f = await setup(t), child = await worker(t, f.root, 'before-publish');
  child.go(); assert.equal(await child.exit, 73);
  const pending = await f.executor.get(f.id);
  assert.ok(pending.candidate);
  assert.equal(pending.publication, null);
  assert.notEqual(pending.status, 'SUCCEEDED');
  assert.equal((await f.executor.recover(f.id)).status, 'SUCCEEDED');
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch']);
});

test('a corrupt candidate after commit can no longer be presented as successful', async t => {
  const f = await setup(t), done = await f.executor.execute(f.cmd);
  await fs.writeFile(path.join(f.root, done.candidate.file), 'changed');
  const restarted = await f.open(), result = await restarted.recover(f.id);
  assert.equal(result.status, 'RESULT_UNKNOWN');
  assert.equal(result.publication, null);
  assert.ok(result.blockedReasons.includes('CANDIDATE_INTEGRITY_FAILED'));
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch']);
});

test('a positively bound lookup can confirm not-started, but a reserved fallback never starts', async t => {
  const f = await setup(t, { flavor: 'not-started', loseReply: true });
  assert.equal((await f.executor.execute(f.cmd)).status, 'RESULT_UNKNOWN');
  const reconciled = await (await f.open()).recover(f.id);
  assert.equal(reconciled.status, 'NOT_STARTED');
  assert.equal(reconciled.execution.started, false);
  assert.equal(reconciled.execution.costUsd, '0.10');
  const alt = alternate(f.cmd, 'one');
  f.add(alt);
  const hold = await f.executor.execute(alt);
  assert.equal(hold.status, 'FALLBACK_RESERVED');
  assert.equal(hold.execution.started, false);
  assert.equal(hold.execution.costUsd, null);
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch', 'lookup']);
});

test('expiry and renewal of a grant cannot reset a consumed primary slot', async t => {
  const f = await setup(t, { loseReply: true, lookup: 'missing' });
  let now = 18;
  f.grant.expiresAt = 19;
  await (await f.open({ clock: () => now })).execute(f.cmd);
  now = 20;
  const restarted = await f.open({ clock: () => now });
  const expired = await restarted.recover(f.id);
  assert.ok(expired.blockedReasons.includes('AUTHORITY_EXPIRED'));
  assert.equal(expired.execution.resultUnknown, true);
  f.grant.expiresAt = 40;
  await restarted.execute(f.cmd);
  const next = structuredClone(f.cmd);
  next.input.executionId = 'new-attempt'; next.requestKey = 'new-key'; next.runAuthorityId = 'new-grant';
  f.add(next);
  await assert.rejects(restarted.execute(next), { code: 'PRIMARY_CONSUMED' });
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch']);
});

test('persisting provider facts can fail before publication and recover the original attempt without replay', async t => {
  const f = await setup(t), first = await f.executor.execute(f.cmd);
  const next = request('2');
  f.add(next);
  const failing = await f.open({ onBoundary: async (name, info) => {
    if (name === 'before-commit' && info.transition === 'observation') await fs.mkdir(path.join(info.stagingDirectory, 'state.json'));
  } });
  const uncertain = await failing.execute(next);
  assert.equal(uncertain.status, 'RESULT_UNKNOWN');
  assert.equal(uncertain.publication, null);
  assert.equal(uncertain.execution.started, true);
  assert.equal(uncertain.execution.costUsd, '0.10');
  assert.ok(uncertain.blockedReasons.includes('OBSERVATION_COMMIT_UNKNOWN'));
  const restart = await f.open();
  assert.deepEqual((await restart.get(f.id)).publication, first.publication);
  assert.equal((await restart.execute(next)).status, 'RESULT_UNKNOWN');
  assert.equal((await restart.recover(next.input.executionId)).status, 'SUCCEEDED');
  const last = f.calls().slice(1);
  assert.deepEqual(last.map(c => c.op), ['dispatch', 'lookup']);
  assert.equal(last[0].input, last[1].input);
});

test('unreadable candidate storage keeps the positive receipt and charge visible until lookup repairs missing bytes', async t => {
  const f = await setup(t), first = await f.executor.execute(f.cmd), next = request('2');
  f.add(next);
  let obstruction;
  const failing = await f.open({ onBoundary: async (name, info) => {
    if (name === 'before-candidate') {
      obstruction = path.join(f.root, info.file);
      await fs.mkdir(obstruction);
    }
  } });
  const state = await failing.execute(next);
  assert.equal(state.status, 'RESULT_UNKNOWN');
  assert.equal(state.execution.state, 'CONFIRMED_SUCCESS');
  assert.equal(state.execution.costUsd, '0.10');
  assert.equal(state.publication, null);
  await fs.rmdir(obstruction);
  const restart = await f.open();
  assert.deepEqual((await restart.get(f.id)).publication, first.publication);
  assert.equal((await restart.recover(next.input.executionId)).status, 'SUCCEEDED');
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch', 'dispatch', 'lookup']);
});

test('a failed concurrent lookup write keeps the publication already committed for the same receipt', async t => {
  const f = await setup(t, { loseReply: true });
  assert.equal((await f.executor.execute(f.cmd)).status, 'RESULT_UNKNOWN');
  const gate = barrier('before-candidate');
  const losing = await f.open({ onBoundary: async (stage, info) => {
    if (stage !== 'before-candidate') return;
    await gate.onBoundary(stage);
    await fs.mkdir(path.join(f.root, info.file));
  } });
  const pending = losing.recover(f.id);
  let published;
  try {
    await gate.entered;
    published = await f.executor.recover(f.id);
    assert.equal(published.status, 'SUCCEEDED');
  } finally { gate.release(); }
  const later = await pending;
  assert.equal(later.status, 'RESULT_UNKNOWN');
  assert.equal(later.publication, null);
  const reopened = await (await f.open()).get(f.id);
  assert.deepEqual(reopened.publication, published.publication);
  assert.equal(reopened.execution.costUsd, '0.10');
  assert.equal(reopened.status, 'SUCCEEDED');
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch', 'lookup', 'lookup']);
});

test('an approved command with invalid parent lineage is rejected before dispatch', async t => {
  const f = await setup(t);
  f.cmd.input.node.parents[0].sha256 = sha('wrong parent content');
  f.add(f.cmd);
  await assert.rejects(f.executor.execute(f.cmd), { code: 'STAGE15_GRAPH_STALE' });
  assert.deepEqual(f.calls(), []);
});

test('a replacement command key cannot change payload for the same page-stage request ID', async t => {
  const f = await setup(t);
  await f.executor.execute(f.cmd);
  const changed = request('replacement');
  changed.input.binding.requestId = f.cmd.input.binding.requestId;
  f.add(changed);
  await assert.rejects((await f.open()).execute(changed), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch']);
});

test('confirmed billing with unconfirmed termination cannot reserve a fallback', async t => {
  const f = await setup(t, { flavor: 'cleanup-unknown' });
  const current = await f.executor.execute(f.cmd);
  assert.equal(current.status, 'RESULT_UNKNOWN');
  assert.equal(current.execution.costUsd, '0.10');
  const alt = alternate(f.cmd, 'one');
  f.add(alt);
  await assert.rejects((await f.open()).execute(alt), { code: 'FALLBACK_INELIGIBLE' });
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch']);
});

test('cancel accepted while a lookup and the dispatch reply are both in flight stays blocked', async t => {
  const delayed = barrier('provider'), f = await setup(t, { duringDispatch: () => delayed.onBoundary('provider') });
  const running = f.executor.execute(f.cmd);
  await delayed.entered;
  const commit = barrier('before-publish');
  const lookup = (await f.open({ onBoundary: commit.onBoundary })).recover(f.id);
  await commit.entered;
  try { await (await f.open()).cancel(f.id); } finally { commit.release(); delayed.release(); }
  for (const state of await Promise.all([running, lookup])) {
    assert.equal(state.publication, null);
    assert.equal(state.cancelled, true);
    assert.equal(state.execution.costUsd, '0.10');
  }
  const restored = await (await f.open()).get(f.id);
  assert.equal(restored.execution.started, true);
  assert.ok(restored.execution.evidenceRefs.includes(f.id + '-start'));
  assert.equal(restored.publication, null);
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch', 'lookup']);
});

test('an acknowledged start survives hard process exit even when the same-provider lookup misses', async t => {
  const f = await setup(t, { lookup: 'missing' }), child = await worker(t, f.root, 'after-dispatch');
  child.go(); assert.equal(await child.exit, 73);
  const recovered = await f.executor.recover(f.id);
  assert.equal(recovered.lookupStatus, 'NOT_FOUND');
  assert.equal(recovered.execution.started, true);
  assert.ok(recovered.execution.evidenceRefs.includes(f.id + '-start'));
  assert.equal(recovered.execution.costUsd, null);
  assert.equal(recovered.status, 'RESULT_UNKNOWN');
  assert.equal(recovered.publication, null);
  assert.deepEqual(f.calls().map(c => c.op), ['dispatch', 'lookup']);
});
