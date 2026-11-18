import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const catalogPath = fileURLToPath(new URL('./resources.json', import.meta.url));
const executeFile = promisify(execFile);
const failure = (code, message, facts = {}) => Object.assign(new Error(message), { code, ...facts });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function validateResource(resource) {
  if (!resource || !/^[a-z0-9-]+$/.test(resource.id) ||
      typeof resource.fileName !== 'string' || !/^[A-Za-z0-9._-]+$/.test(resource.fileName) ||
      resource.fileName === '.' || resource.fileName === '..' ||
      !Number.isSafeInteger(resource.bytes) || resource.bytes < 1 ||
      typeof resource.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(resource.sha256)) {
    throw failure('CATALOG_INVALID', '고정 자산의 이름·크기·SHA-256이 올바르지 않습니다.');
  }
  const url = new URL(resource.url);
  // HTTP is useful for a local integrity check; catalog files require HTTPS below.
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' && url.hostname !== '127.0.0.1')) {
    throw failure('CATALOG_INVALID', 'HTTPS 고정 다운로드 주소가 필요합니다.');
  }
}

export async function loadCatalog() {
  const bytes = await readFile(catalogPath);
  const catalog = JSON.parse(bytes.toString('utf8'));
  if (catalog.version !== 1 || !catalog.roots || !Array.isArray(catalog.resources) || !catalog.resources.length) {
    throw failure('CATALOG_INVALID', '자산 목록 형식이 올바르지 않습니다.');
  }
  for (const key of ['models', 'downloads', 'cache', 'outputs']) {
    if (typeof catalog.roots[key] !== 'string' || !path.isAbsolute(catalog.roots[key])) {
      throw failure('CATALOG_INVALID', '모델·다운로드·캐시·결과의 절대 경로가 필요합니다.');
    }
  }
  const ids = new Set(), targets = new Set();
  for (const resource of catalog.resources) {
    validateResource(resource);
    if (!['models', 'downloads'].includes(resource.root) || !resource.url.startsWith('https://')) {
      throw failure('CATALOG_INVALID', '목록의 자산은 지정 폴더와 HTTPS 주소만 사용해야 합니다.');
    }
    const target = path.resolve(catalog.roots[resource.root], resource.fileName).toLowerCase();
    if (ids.has(resource.id) || targets.has(target)) throw failure('CATALOG_INVALID', '자산 ID 또는 파일 경로가 중복됐습니다.');
    ids.add(resource.id); targets.add(target);
  }
  return { ...catalog, catalogSha256: sha256(bytes) };
}

async function inspectExisting(target, resource, signal, onProgress) {
  let before;
  try { before = await lstat(target); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.size !== resource.bytes) {
    throw failure('EXISTING_RESOURCE_MISMATCH', '기존 파일이 고정 크기와 다릅니다. 원본을 보존하고 중단했습니다.', { target });
  }
  const hash = createHash('sha256'); let receivedBytes = 0;
  for await (const chunk of createReadStream(target, { signal })) {
    receivedBytes += chunk.length; hash.update(chunk);
    await onProgress?.({ id: resource.id, event: 'verifying', receivedBytes, totalBytes: resource.bytes });
  }
  const digest = hash.digest('hex'), after = await lstat(target);
  if (receivedBytes !== resource.bytes || digest !== resource.sha256 || !after.isFile() || after.isSymbolicLink() ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
    throw failure('EXISTING_RESOURCE_MISMATCH', '기존 파일의 SHA-256 또는 읽는 동안의 상태가 다릅니다. 덮어쓰지 않았습니다.', { target });
  }
  return { id: resource.id, status: 'reused', path: target, bytes: receivedBytes, sha256: digest };
}

async function publishVerified(stagedPath, target) {
  try {
    if (process.platform === 'win32') {
      // File.Move's two-argument overload refuses an existing target. Node's
      // rename replaces it, while Windows volumes do not all support hardlinks.
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:/Windows';
      const powershell = path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const script = "$ErrorActionPreference='Stop'; [System.IO.File]::Move($env:MANGOHANA_RESOURCE_SOURCE, $env:MANGOHANA_RESOURCE_TARGET)";
      const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
      env.MANGOHANA_RESOURCE_SOURCE = stagedPath; env.MANGOHANA_RESOURCE_TARGET = target;
      await executeFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, env, timeout: 30_000, maxBuffer: 64 * 1024 });
    } else {
      await link(stagedPath, target); await unlink(stagedPath);
    }
  } catch (error) {
    let targetExists = false;
    try { await lstat(target); targetExists = true; } catch (lookupError) { if (lookupError.code !== 'ENOENT') throw lookupError; }
    if (targetExists) throw failure('TARGET_EXISTS', '다운로드 중 같은 경로에 파일이 생겼습니다. 기존 파일을 보존했습니다.', { target });
    throw failure('PUBLISH_FAILED', '검증된 파일을 최종 경로로 옮기지 못했습니다. 임시 파일은 보존했습니다.', { systemCode: error.code });
  }
}

/** Stream one pinned asset. Existing targets are never overwritten or removed. */
export async function ensureResource(resource, options = {}) {
  validateResource(resource);
  if (!options.directory || !path.isAbsolute(options.directory)) throw failure('DIRECTORY_INVALID', '자산 폴더의 절대 경로가 필요합니다.');
  const directory = path.resolve(options.directory), target = path.join(directory, resource.fileName);
  await mkdir(directory, { recursive: true });
  const existing = await inspectExisting(target, resource, options.signal, options.onProgress);
  if (existing) return existing;
  if (options.verifyOnly) throw failure('RESOURCE_MISSING', '아직 내려받지 않은 자산입니다.', { target });
  const prefix = `.${resource.fileName}.`;
  const stages = (await readdir(directory)).filter(name => name.startsWith(prefix) && name.endsWith('.verified') &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name.slice(prefix.length, -'.verified'.length))).sort();
  for (const name of stages) {
    const verifiedPath = path.join(directory, name);
    const verified = await inspectExisting(verifiedPath, resource, options.signal, options.onProgress);
    if (!verified) continue;
    options.signal?.throwIfAborted();
    try { await publishVerified(verifiedPath, target); } catch (error) { throw Object.assign(error, { stagedPath: verifiedPath }); }
    return { ...verified, status: 'recovered', path: target, recoveredFrom: verifiedPath };
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 45 * 60_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let stagedPath, file, response, receivedBytes = 0;
  try {
    signal.throwIfAborted();
    await options.onProgress?.({ id: resource.id, event: 'requesting', receivedBytes, totalBytes: resource.bytes });
    response = await fetch(resource.url, {
      redirect: 'follow', signal,
      headers: { 'user-agent': 'MangohanaV2-resource-preparer/1.0', 'accept-encoding': 'identity' },
    });
    if (!response.ok || !response.body) throw failure('DOWNLOAD_HTTP', `다운로드 서버가 HTTP ${response.status}로 응답했습니다.`, { httpStatus: response.status });
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== resource.bytes)) {
      throw failure('DOWNLOAD_SIZE_MISMATCH', '응답 크기가 고정 자산 크기와 다릅니다.', { expectedBytes: resource.bytes, responseBytes: length });
    }
    stagedPath = path.join(directory, `.${resource.fileName}.${randomUUID()}.partial`);
    file = await open(stagedPath, 'wx');
    const hash = createHash('sha256');
    for await (const chunk of response.body) {
      signal.throwIfAborted(); receivedBytes += chunk.length;
      if (receivedBytes > resource.bytes) throw failure('DOWNLOAD_SIZE_MISMATCH', '다운로드가 고정 자산 크기를 초과했습니다.');
      await file.writeFile(chunk); hash.update(chunk);
      await options.onProgress?.({ id: resource.id, event: 'downloading', receivedBytes, totalBytes: resource.bytes });
    }
    signal.throwIfAborted();
    if (receivedBytes !== resource.bytes) throw failure('DOWNLOAD_SIZE_MISMATCH', '다운로드가 고정 자산 크기에 미달했습니다.');
    const digest = hash.digest('hex');
    if (digest !== resource.sha256) throw failure('DOWNLOAD_HASH_MISMATCH', '다운로드 SHA-256이 고정값과 다릅니다.');
    await file.sync(); await file.close(); file = undefined;
    // Rename only after verification, then publish without replacing a target.
    const verifiedPath = `${stagedPath.slice(0, -'.partial'.length)}.verified`;
    await rename(stagedPath, verifiedPath); stagedPath = verifiedPath;
    signal.throwIfAborted();
    await publishVerified(stagedPath, target); stagedPath = undefined;
    await options.onProgress?.({ id: resource.id, event: 'verified', receivedBytes, totalBytes: resource.bytes });
    return { id: resource.id, status: 'downloaded', path: target, bytes: receivedBytes, sha256: digest };
  } catch (error) {
    if (file) await file.close().catch(() => {});
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    const failed = signal.aborted
      ? failure(timeout.aborted ? 'DOWNLOAD_TIMEOUT' : 'DOWNLOAD_ABORTED', timeout.aborted ? '다운로드 제한 시간이 지났습니다.' : '다운로드를 중단했습니다.')
      : error;
    throw Object.assign(failed, { receivedBytes, ...(stagedPath ? { stagedPath } : {}) });
  }
}

function parseArguments(args) {
  const options = { verifyOnly: false, listOnly: false, only: undefined };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--verify') options.verifyOnly = true;
    else if (args[index] === '--list') options.listOnly = true;
    else if (args[index] === '--only' && args[index + 1]) options.only = args[++index].split(',');
    else throw failure('ARGUMENT_INVALID', '사용법: node scripts/v2/resources.mjs [--verify | --list] [--only id,id]');
  }
  return options;
}

export async function runResources(options = {}) {
  const catalog = await loadCatalog();
  const selected = catalog.resources.filter(resource => !options.only || options.only.includes(resource.id));
  if (!selected.length || options.only?.some(id => !catalog.resources.some(resource => resource.id === id))) {
    throw failure('RESOURCE_UNKNOWN', '알 수 없는 자산 ID입니다. --list로 고정 목록을 확인해 주세요.');
  }
  if (options.listOnly) {
    const list = selected.map(resource => ({ ...resource, path: path.join(catalog.roots[resource.root], resource.fileName) }));
    console.log(JSON.stringify({ catalogSha256: catalog.catalogSha256, resources: list }, null, 2)); return { resources: list };
  }
  await mkdir(catalog.roots.cache, { recursive: true });
  const startedAt = new Date().toISOString();
  const reportDirectory = path.join(catalog.roots.outputs, `resources-${startedAt.replace(/[:.]/g, '-')}-${randomUUID()}`);
  await mkdir(reportDirectory, { recursive: true });
  const progressPath = path.join(reportDirectory, 'progress.jsonl');
  const progress = await open(progressPath, 'wx');
  const results = [];
  const record = async event => {
    const value = { time: new Date().toISOString(), ...event };
    await progress.writeFile(`${JSON.stringify(value)}\n`); console.log(JSON.stringify(value));
  };
  let lastProgress = 0;
  try {
    await record({ event: 'started', reportDirectory, verifyOnly: !!options.verifyOnly, catalogSha256: catalog.catalogSha256, totalBytes: selected.reduce((sum, item) => sum + item.bytes, 0) });
    for (const resource of selected) {
      await record({ event: 'resource-started', id: resource.id, path: path.join(catalog.roots[resource.root], resource.fileName) });
      try {
        const result = await ensureResource(resource, {
          directory: catalog.roots[resource.root], verifyOnly: !!options.verifyOnly, signal: options.signal,
          onProgress: async event => {
            if (event.event === 'requesting' || event.event === 'verified' || Date.now() - lastProgress >= 5000) {
              lastProgress = Date.now(); await record(event);
            }
          },
        });
        results.push(result); await record({ event: 'resource-completed', ...result });
      } catch (error) {
        const result = { id: resource.id, status: 'failed', path: path.join(catalog.roots[resource.root], resource.fileName),
          error: { code: error.code ?? error.cause?.code ?? 'RESOURCE_FAILED', message: error.message,
            ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
            ...(error.stagedPath ? { stagedPath: error.stagedPath } : {}),
            ...(Number.isSafeInteger(error.receivedBytes) ? { receivedBytes: error.receivedBytes } : {}) } };
        results.push(result); await record({ event: 'resource-failed', ...result });
        if (options.signal?.aborted) break;
      }
    }
    const success = results.length === selected.length && results.every(result => result.status !== 'failed');
    const result = { version: 1, status: success ? 'completed' : 'failed', startedAt, endedAt: new Date().toISOString(),
      verifyOnly: !!options.verifyOnly, catalogSha256: catalog.catalogSha256, toolSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
      nodeVersion: process.version, progressPath, resources: results,
      scope: 'Downloaded bytes and SHA-256 only; OCR CMS installation, extraction, inference and image quality are separate.' };
    const resultPath = path.join(reportDirectory, 'result.json');
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    await record({ event: 'finished', status: result.status, resultPath });
    return { ...result, resultPath };
  } finally { await progress.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
  try {
    const result = await runResources({ ...parseArguments(process.argv.slice(2)), signal: controller.signal });
    if (result.status === 'failed') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ error: { code: error.code ?? 'RESOURCE_FAILED', message: error.message } })); process.exitCode = 1;
  }
}
