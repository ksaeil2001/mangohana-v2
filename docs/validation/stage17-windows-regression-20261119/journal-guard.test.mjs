import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import {fixture} from '../../../tests/v2/fixtures/owned-engine-runtime.mjs';

const base = await fs.mkdtemp('E:/Dev/Outputs/MangohanaV2-20261111/tests/stage17-journal-guard-');
const preload = fileURLToPath(new URL('./journal-delay.cjs', import.meta.url));
async function withDelayedOperation(t, kind) {
  const spawn = childProcess.spawn;
  let server;
  let children = 0;
  childProcess.spawn = function (executable, args, options) {
    if (executable !== process.execPath || args[0] !== server) return spawn.call(this, executable, args, options);
    children++;
    return spawn.call(this, executable, ['--require', preload, ...args], {
      ...options, env: {...options.env, STAGE17_DELAY_KIND: kind},
    });
  };
  try {
    const f = await fixture(t, false, {}, {base});
    server = path.join(f.root, 'synthetic-server.cjs');
    return f;
  } finally {
    t.after(() => {childProcess.spawn = spawn; syncBuiltinESMExports(); assert.equal(children, 1);});
  }
}

test('the synthetic journal records every real request without reopening its path in model readiness', {timeout: 20_000}, async t => {
  const f = await withDelayedOperation(t, 'journal-open');
  await f.run(1);
  const rows = (await fs.readFile(f.diary, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(r => r.path === '/v1/models' && r.authorized));
  assert.ok(rows.some(r => r.path === '/v1/models' && !r.authorized));
  const posts = rows.filter(r => r.path === '/v1/chat/completions');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].authorized, true);
  assert.deepEqual(posts[0].body.response_format.json_schema.schema.properties.regions.items.properties.id.enum, ['line-1']);
  assert.ok(rows.every(r => r.pid === f.state.modelRecords[0].child.pid));
});

test('a slow model still expires at the original readiness deadline before any translation', {timeout: 20_000}, async t => {
  const f = await withDelayedOperation(t, 'model-listen');
  await assert.rejects(f.run(1), {code: 'LLM_START_TIMEOUT'});
  const rows = await fs.readFile(f.diary, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  assert.equal(rows, '');
  assert.equal(f.state.modelRecords[0].closed, true);
});
