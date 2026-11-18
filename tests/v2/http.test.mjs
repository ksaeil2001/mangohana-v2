// HTTP contract tests use a synthetic store; no AI or model runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { createEngineServer } from '../../apps/engine/server.mjs';

const origin = 'http://127.0.0.1:5173';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLeUAAAAASUVORK5CYII=', 'base64');
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const submissions = [], jobs = new Map();
  const store = { health: async () => ({ ready: true, running: false }),
    async submit(input) { submissions.push(input); const job = { id: 'a1111111-1111-4111-8111-111111111111', status: 'queued', stage: 'queued', progress: 0 }; jobs.set(job.id, { owner: input.owner, job }); return job; },
    async get(owner, id) { const value = jobs.get(id); if (!value || value.owner !== owner) throw Object.assign(Error('Unavailable'), { status: 404, code: 'JOB_NOT_FOUND' }); return value.job; },
    async getResult() { return { blocks: [], clean_image: 'data:image/png;base64,' + png.toString('base64') }; } };
  const server = createEngineServer({ store, allowedOrigin: origin }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const health = await fetch(base + '/health'); const cookie = health.headers.get('set-cookie').split(';')[0]; await health.arrayBuffer();
  return { base, server, store, submissions, jobs, cookie };
}
function form(fields = {}) {
  const result = new FormData(); result.append('file', new Blob([png], { type: 'image/png' }), 'source.png');
  for (const [name, value] of Object.entries({ source_language: 'ja', target_language: 'ko', project_id: 'project-one', page_id: 'page-one', idempotency_key: 'request:1', ...fields })) result.append(name, value);
  return result;
}
test('issues a durable private cookie and submits multipart using only its owner digest', async t => {
  const f = await fixture(t);
  const health = await fetch(f.base + '/health');
  const setCookie = health.headers.get('set-cookie'); await health.arrayBuffer();
  assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /SameSite=Strict/i); assert.match(setCookie, /Max-Age=2592000/);
  const response = await fetch(f.base + '/jobs', { method: 'POST', headers: { origin, cookie: f.cookie }, body: form({ owner: 'attacker-chosen-owner' }) });
  assert.equal(response.status, 202); const job = await response.json();
  assert.equal(job.status, 'queued'); const submitted = f.submissions[0];
  assert.equal(submitted.owner, hash(f.cookie.split('=')[1])); assert.deepEqual(submitted.bytes, png);
  assert.equal(submitted.projectId, 'project-one'); assert.equal(submitted.pageId, 'page-one'); assert.equal(submitted.idempotencyKey, 'request:1');
});
test('another browser cookie cannot read a job or its result', async t => {
  const f = await fixture(t);
  const post = await fetch(f.base + '/jobs', { method: 'POST', headers: { origin, cookie: f.cookie }, body: form() }); const job = await post.json();
  const own = await fetch(f.base + '/jobs/' + job.id, { headers: { cookie: f.cookie } }); assert.equal(own.status, 200); await own.arrayBuffer();
  const other = await fetch(f.base + '/health'); const otherCookie = other.headers.get('set-cookie').split(';')[0]; await other.arrayBuffer();
  for (const suffix of ['', '/result']) {
    const denied = await fetch(f.base + '/jobs/' + job.id + suffix, { headers: { cookie: otherCookie } }); assert.equal(denied.status, 404); await denied.arrayBuffer();
  }
});
test('requires exact origin and a fixed loopback Host before creating jobs', async t => {
  const f = await fixture(t);
  for (const suppliedOrigin of [undefined, 'https://evil.invalid', origin + '.evil.invalid']) {
    const response = await fetch(f.base + '/jobs', { method: 'POST', headers: { ...(suppliedOrigin ? { origin: suppliedOrigin } : {}), cookie: f.cookie }, body: form() });
    assert.equal(response.status, 403); await response.arrayBuffer();
  }
  const status = await new Promise((resolve, reject) => {
    const req = http.get(f.base + '/health', { headers: { host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
  });
  assert.equal(status, 403); assert.equal(f.submissions.length, 0);
  assert.throws(() => createEngineServer({ store: f.store, allowedOrigin: origin }).listen(0, '0.0.0.0'), /127\.0\.0\.1/);
});
test('rejects malformed, duplicate, unsupported and oversized multipart input', async t => {
  const f = await fixture(t);
  const duplicate = form(); duplicate.append('file', new Blob([png]), 'second.png');
  const duplicateKey = form(); duplicateKey.append('idempotency_key', 'ambiguous');
  const overCount = form(); for (let i = 0; i < 200; i++) overCount.append('owner', 'ignored');
  const oversized = form(); oversized.set('file', new Blob([Buffer.alloc(8 * 1024 * 1024 + 1)]), 'huge.png');
  const cases = [[form({ source_language: 'en' }), 422], [form({ target_language: 'en' }), 422],
    [form({ idempotency_key: 'bad/key' }), 422], [duplicate, 422], [duplicateKey, 422], [overCount, 413], [oversized, 413]];
  for (const [body, status] of cases) {
    const response = await fetch(f.base + '/jobs', { method: 'POST', headers: { origin, cookie: f.cookie }, body });
    assert.equal(response.status, status); await response.arrayBuffer();
  }
  const malformed = await fetch(f.base + '/jobs', { method: 'POST', headers: { origin, cookie: f.cookie, 'content-type': 'multipart/form-data; boundary=missing' }, body: 'not multipart' });
  assert.equal(malformed.status, 422); await malformed.arrayBuffer(); assert.equal(f.submissions.length, 0);
});
test('completed polling includes the converted result without revealing local paths', async t => {
  const f = await fixture(t);
  const post = await fetch(f.base + '/jobs', { method: 'POST', headers: { origin, cookie: f.cookie }, body: form() }); const job = await post.json();
  f.jobs.get(job.id).job.status = 'completed';
  const response = await fetch(f.base + '/jobs/' + job.id, { headers: { cookie: f.cookie } }); const data = await response.json();
  assert.equal(data.status, 'completed'); assert.deepEqual(data.result.blocks, []); assert.match(data.result.clean_image, /^data:image\/png;base64,/);
});
