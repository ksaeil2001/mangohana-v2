import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readHostingConfig } from '../scripts/execution-profile.mjs';

test('portable builds need no hosting account and managed builds retain their exact configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mangohana-hosting-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(JSON.parse(readHostingConfig(root).toString('utf8')), { d1: null, r2: null });

  const profile = join(root, '.sites-runtime');
  await mkdir(profile);
  await writeFile(join(profile, 'execution-profile.json'), JSON.stringify({ executionProfile: 'managed-linux' }));
  assert.throws(() => readHostingConfig(root), { code: 'ENOENT' });

  const settings = Buffer.from('{"d1":"DB","r2":"BUCKET","project_id":"test-project"}\r\n');
  await mkdir(join(root, '.openai'));
  await writeFile(join(root, '.openai', 'hosting.json'), settings);
  assert.deepEqual(readHostingConfig(root), settings);
});
