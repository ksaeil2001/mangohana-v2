// Actual verifier/preflight source and temporary files; synthetic CMS boundary,
// no installed model packs, Python processes, inference or .build changes.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = new URL('../../packages/ai-engine/vendor/trio/src/main/', import.meta.url);
const installerURL = new URL('resourcePackInstaller.ts', sourceRoot).href;
const stateKey = '__mangohanaPackFixture_' + randomUUID().replaceAll('-', '');
const dataURL = source => 'data:text/javascript,' + encodeURIComponent(source);
const cmsURL = dataURL(`
  export {normalizeCmsPublisherAllowlist} from ${JSON.stringify(new URL('cmsSignatureVerifier.ts', sourceRoot).href)};
  export async function verifyDetachedCmsSignature(...args) { return globalThis[${JSON.stringify(stateKey)}].verifySignature(...args); }
`);
const filesURL = dataURL(`
  import * as fs from 'node:fs/promises';
  export const {lstat,mkdir,readdir,realpath,rename,rm}=fs;
  export async function open(...args) {
    const handle=await fs.open(...args);
    return globalThis[${JSON.stringify(stateKey)}].wrapHandle(handle,args[0]);
  }
`);
// Node 24 erases TypeScript directly. Only the installer's slow/external
// signature boundary and FileHandle timing are replaced; path/schema/stat/hash
// implementations and resourcePreflight remain the production source.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === installerURL && specifier === './cmsSignatureVerifier.js') return { url: cmsURL, shortCircuit: true };
  if (context.parentURL === installerURL && specifier === 'node:fs/promises') return { url: filesURL, shortCircuit: true };
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(new URL('../', sourceRoot).href)) {
    const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(target))) return { url: target.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
after(() => { hooks.deregister(); delete globalThis[stateKey]; });
const { verifyInstalledResourcePack } = await import(installerURL);
const { preflightPipelineResources } = await import(new URL('resourcePreflight.ts', sourceRoot));
const sha = value => createHash('sha256').update(value).digest('hex');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(read, expected, milliseconds = 1000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (expected(read())) return; await sleep(2); }
  assert.fail('The synthetic verifier did not reach the required boundary.');
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mangohana-pack-check-'));
  const packRoot = path.join(root, 'pack'); await fs.mkdir(packRoot);
  const payloads = new Map([['000-license.txt', Buffer.from('synthetic license')],
    ...Array.from({ length: options.count ?? 11 }, (_, index) => [String(index + 1).padStart(3, '0') + '.bin', Buffer.alloc(options.sizes?.[index] ?? 17 + index, index)])]);
  for (const [name, bytes] of payloads) await fs.writeFile(path.join(packRoot, name), bytes, { flag: 'wx' });
  const manifest = { schemaVersion: 1, resourceId: 'synthetic-pack', role: 'ocr_production', version: '1.0.0', compatiblePipelineVersions: ['1.0.0'],
    files: [...payloads].map(([relativePath, bytes]) => ({ relativePath, byteSize: bytes.length, sha256: sha(bytes) })), licenseFiles: ['000-license.txt'] };
  options.mutateManifest?.(manifest);
  const manifestBytes = Buffer.from(JSON.stringify(manifest)), signatureBytes = Buffer.from('SYNTHETIC_CMS_FIXTURE_NOT_A_REAL_SIGNATURE');
  await fs.writeFile(path.join(packRoot, 'resource-manifest.json'), manifestBytes);
  await fs.writeFile(path.join(packRoot, 'resource-manifest.p7s'), signatureBytes);
  const entry = { role: 'ocr_production', resourceId: 'synthetic-pack', version: '1.0.0', manifestSha256: sha(manifestBytes), distribution: 'bundled', requiredFor: ['ocr'] };
  const state = { active: 0, maximum: 0, opened: [], closed: [], reads: [], signatureCalls: 0,
    async verifySignature(actualManifest, actualSignature, allowlist) {
      state.signatureCalls++; assert.deepEqual(actualManifest, manifestBytes); assert.deepEqual(actualSignature, signatureBytes);
      assert.equal(allowlist.current, 'A'.repeat(64));
      if (options.badSignature) throw Error('Synthetic signature rejection');
      return { signerThumbprint: allowlist.current, matchedPublisher: 'current' };
    },
    wrapHandle(handle, absolutePath) {
      const name = path.basename(absolutePath); if (!payloads.has(name)) return handle;
      state.active++; state.maximum = Math.max(state.maximum, state.active); state.opened.push(name);
      return new Proxy(handle, { get(target, key) {
        if (key === 'read') return async (buffer, offset, length, position) => {
          state.reads.push({ name, bufferBytes: buffer.length, length, position });
          await options.beforeRead?.(name, position, state);
          const result = await target.read(buffer, offset, length, position);
          await options.afterRead?.(name, position, state); return result;
        };
        if (key === 'close') return async () => { try { await target.close(); } finally { state.active--; state.closed.push(name); } };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
  globalThis[stateKey] = state;
  t.after(async () => {
    assert.equal(state.active, 0, 'Every verifier handle must close before test cleanup.');
    assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.match(path.basename(root), /^mangohana-pack-check-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const verifyOptions = { packRoot, entry, pipelineVersion: '1.0.0', publisherAllowlist: { current: 'a'.repeat(64) } };
  const preflight = probe => preflightPipelineResources({ lock: { schemaVersion: 1, appVersion: 'synthetic-fixture', pipelineVersion: '1.0.0', resources: [entry] },
    requiredRoles: ['ocr_production'], trustedRoots: { userDataRoot: root, bundledResourceRoot: root, bundledLocations: { ocr_production: 'pack' } },
    publisherAllowlist: verifyOptions.publisherAllowlist, probes: { ocr_production: probe } });
  return { root, packRoot, payloads, manifest, state, verifyOptions, preflight, verify: () => verifyInstalledResourcePack(verifyOptions) };
}

test('verifies every declared file with exactly four bounded concurrent handles', async t => {
  const f = await fixture(t, { beforeRead: (_name, position) => position === 0 ? sleep(20) : undefined });
  const result = await f.verify();
  assert.equal(result.absolutePath, f.packRoot); assert.equal(f.state.maximum, 4);
  assert.deepEqual([...f.state.opened].sort(), [...f.payloads.keys()].sort());
  assert.deepEqual([...f.state.closed].sort(), [...f.payloads.keys()].sort()); assert.equal(f.state.signatureCalls, 1);
});

test('sizes hash buffers to each small file while retaining the 1MiB streaming bound', async t => {
  const f = await fixture(t, { count: 4, sizes: [3, 0, 1024 * 1024 + 7, 31] }); await f.verify();
  for (const [name, bytes] of f.payloads) {
    const reads = f.state.reads.filter(read => read.name === name && read.position < bytes.length);
    for (const read of reads) assert.equal(read.bufferBytes, Math.min(1024 * 1024, bytes.length));
    assert.equal(reads.reduce((sum, read) => sum + read.length, 0), bytes.length);
  }
});

test('stops new file admission on failure and drains all in-flight reads before rejecting', async t => {
  const failGate = deferred(), restGate = deferred();
  const f = await fixture(t, { beforeRead: async (name, position) => {
    if (position !== 0) return;
    if (name === '000-license.txt') { await failGate.promise; throw Error('Synthetic read failure'); }
    await restGate.promise;
  } });
  let settled = false; const outcome = f.verify().then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  try {
    await until(() => f.state.opened.length, value => value === 4);
    failGate.resolve(); await until(() => f.state.closed.includes('000-license.txt'), Boolean); await sleep(10);
    assert.equal(settled, false); assert.equal(f.state.opened.length, 4);
    restGate.resolve(); const result = await outcome;
    assert.equal(result.error.code, 'RESOURCE_CORRUPT'); assert.equal(f.state.active, 0); assert.equal(f.state.closed.length, 4);
  } finally { failGate.resolve(); restGate.resolve(); await outcome; }
});

test('preflight cannot probe any runtime until every verified file handle has closed', async t => {
  const gate = deferred(); const f = await fixture(t, { beforeRead: () => gate.promise }); let probes = 0;
  const operation = f.preflight(async () => { probes++; assert.equal(f.state.active, 0); assert.equal(f.state.closed.length, f.payloads.size); });
  try { await until(() => f.state.active, value => value > 0); await sleep(10); assert.equal(probes, 0); }
  finally { gate.resolve(); }
  await operation; assert.equal(probes, 1);
});

for (const defect of ['signature', 'manifest digest', 'file digest', 'file size', 'extra file', 'missing file', 'path traversal', 'file growth']) {
  test(`keeps ${defect} rejection and never probes an unverified pack`, async t => {
    let grown = false, target;
    const f = await fixture(t, { badSignature: defect === 'signature',
      mutateManifest(manifest) {
        if (defect === 'file digest') manifest.files[1].sha256 = '0'.repeat(64);
        if (defect === 'file size') manifest.files[1].byteSize++;
        if (defect === 'path traversal') manifest.files[1].relativePath = '../outside.bin';
      },
      afterRead: async (name, position) => {
        if (defect === 'file growth' && name === '001.bin' && position === 0 && !grown) { grown = true; await fs.appendFile(target, Buffer.from('changed')); }
      } });
    target = path.join(f.packRoot, '001.bin');
    if (defect === 'manifest digest') f.verifyOptions.entry.manifestSha256 = '0'.repeat(64);
    if (defect === 'extra file') await fs.writeFile(path.join(f.packRoot, 'unregistered.bin'), 'extra');
    if (defect === 'missing file') await fs.rm(target);
    let probes = 0;
    await assert.rejects(f.preflight(async () => { probes++; }), { code: defect === 'missing file' ? 'RESOURCE_MISSING' : 'RESOURCE_CORRUPT' });
    assert.equal(probes, 0); assert.equal(f.state.active, 0);
    if (['signature', 'manifest digest', 'path traversal', 'extra file', 'missing file'].includes(defect)) assert.equal(f.state.opened.length, 0);
  });
}
