import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createStage15AttemptExecutor } from '../../../apps/engine/stage15-attempt-executor.mjs';
import { createStage15ProviderAdapter } from '../../../apps/engine/stage15-provider-adapter.mjs';
import { alternate, authority, calls, key, providers, request, sha } from '../../../tests/v2/fixtures/stage15-attempt.mjs';

const childFixture = new URL('../../../tests/v2/fixtures/stage15-attempt.mjs', import.meta.url);
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
