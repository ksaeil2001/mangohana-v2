'use strict';

const childProcess = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const { syncBuiltinESMExports } = require('node:module');
const { dirname, join } = require('node:path');
const { applyOcrSpawnEnvironment } = require('../../../../quality/ocr-environment.cjs');

const LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024, outputBytes: 32 * 1024 * 1024,
  pixels: 12_000_000, side: 8000, llmResponseBytes: 1024 * 1024,
  ocrMs: 600_000, translationMs: 600_000, translationItemMs: 90_000,
  // First CUDA DLL initialization on the restored E: runtime exceeded 10 seconds.
  llamaHelpMs: 90_000,
  lamaMs: 90_000, renderMs: 30_000, cleanupMs: 6000,
});

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertActive(signal) {
  if (signal?.aborted) throw failure('CANCELLED', '작업이 취소되었습니다.');
}

function assertDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > LIMITS.side || height > LIMITS.side || width * height > LIMITS.pixels) {
    throw failure('IMAGE_LIMIT', '이미지는 한 변 8000픽셀, 전체 1200만 픽셀 이하여야 합니다.');
  }
  return { width, height };
}

/** 디코더를 호출하기 전에 크기와 단일 프레임 형식을 검사한다. */
function imageHeader(bytes, mime, maxBytes = LIMITS.inputBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > maxBytes) {
    throw failure('IMAGE_BYTES', '이미지 파일 크기가 허용 범위를 벗어났습니다.');
  }
  let width, height, actual;
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    actual = 'image/png';
    let position = 8, ended = false, data = false;
    while (position + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(position), kind = bytes.toString('ascii', position + 4, position + 8);
      if (size > bytes.length - position - 12 || (position === 8 && (kind !== 'IHDR' || size !== 13))) {
        throw failure('INVALID_IMAGE', 'PNG 파일이 손상되었습니다.');
      }
      if (position === 8) { width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
      if (kind === 'acTL') throw failure('ANIMATED_IMAGE', '움직이는 이미지는 지원하지 않습니다.');
      if (kind === 'IDAT') data = true;
      position += size + 12;
      if (kind === 'IEND') { ended = size === 0 && position === bytes.length; break; }
    }
    if (!ended || !data) throw failure('INVALID_IMAGE', 'PNG 파일이 끝까지 저장되지 않았습니다.');
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    actual = 'image/jpeg';
    if (bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw failure('INVALID_IMAGE', 'JPEG 파일이 끝까지 저장되지 않았습니다.');
    let position = 2;
    while (position + 3 < bytes.length) {
      if (bytes[position++] !== 255) break;
      while (bytes[position] === 255) position++;
      const marker = bytes[position++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (position + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(position);
      if (length < 2 || position + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(position + 3); width = bytes.readUInt16BE(position + 5); break;
      }
      position += length;
    }
  } else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    actual = 'image/webp';
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw failure('INVALID_IMAGE', 'WebP 파일이 손상되었습니다.');
    let position = 12;
    while (position + 8 <= bytes.length) {
      const kind = bytes.toString('ascii', position, position + 4), size = bytes.readUInt32LE(position + 4);
      const start = position + 8;
      if (size > bytes.length - start) throw failure('INVALID_IMAGE', 'WebP 블록이 손상되었습니다.');
      if (kind === 'ANIM' || kind === 'ANMF' || (kind === 'VP8X' && size >= 10 && (bytes[start] & 2))) {
        throw failure('ANIMATED_IMAGE', '움직이는 이미지는 지원하지 않습니다.');
      }
      if (kind === 'VP8X' && size >= 10) {
        width = 1 + bytes.readUIntLE(start + 4, 3); height = 1 + bytes.readUIntLE(start + 7, 3);
      } else if (width === undefined && kind === 'VP8 ' && size >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
        width = bytes.readUInt16LE(start + 6) & 0x3fff; height = bytes.readUInt16LE(start + 8) & 0x3fff;
      } else if (width === undefined && kind === 'VP8L' && size >= 5 && bytes[start] === 0x2f) {
        const bits = bytes.readUInt32LE(start + 1);
        width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
      }
      position = start + size + (size & 1);
    }
    if (position !== bytes.length) throw failure('INVALID_IMAGE', 'WebP 블록 경계가 올바르지 않습니다.');
  } else {
    throw failure('IMAGE_FORMAT', 'PNG, JPEG, WebP 단일 이미지만 지원합니다.');
  }
  if (mime && mime !== actual) throw failure('IMAGE_MIME', '이미지 내용과 형식이 일치하지 않습니다.');
  return { ...assertDimensions(width, height), mime: actual };
}

function secretlessEnvironment(executable, temporaryDirectory) {
  const env = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    PATH: dirname(executable), TEMP: temporaryDirectory, TMP: temporaryDirectory,
    PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
  });
  return env;
}

const scopeStorage = new AsyncLocalStorage();
let hookUsers = 0, priorSpawn, priorFetch, spawnHook, fetchHook;

function assertSpawnAllowed() {
  for (let context = scopeStorage.getStore(); context; context = context.parent) {
    if (context.spawnPolicy?.allowSpawn === false) {
      context.spawnPolicy.onSpawnDenied?.();
      throw failure('PROCESS_RESTART_REQUIRED', '보유한 런타임의 새 프로세스 생성은 다음 작업의 전체 검증이 필요합니다.');
    }
  }
}

/** 기존 ESM OCR spawn과 번역 fetch에만 비동기 문맥별 경계를 적용한다. */
function acquireHooks() {
  if (hookUsers++ === 0) {
    priorSpawn = childProcess.spawn;
    priorFetch = globalThis.fetch;
    spawnHook = function (...args) {
      assertActive(scopeStorage.getStore()?.signal);
      assertSpawnAllowed();
      let forwarded = args;
      for (let context = scopeStorage.getStore(); context; context = context.parent) {
        if (context.environmentPolicy !== undefined) {
          if (Array.isArray(args[1]) && args.length >= 3) {
            const options = applyOcrSpawnEnvironment(args[0], args[2], context.environmentPolicy);
            if (options !== args[2]) { forwarded = [...args]; forwarded[2] = options; }
          }
          break;
        }
      }
      const child = priorSpawn.apply(childProcess, forwarded);
      scopeStorage.getStore()?.owner?.track(child);
      return child;
    };
    fetchHook = async function (input, init) {
      const context = scopeStorage.getStore();
      assertActive(context?.signal);
      const auth = context?.auth;
      if (!auth) return priorFetch.call(globalThis, input, init);
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.origin !== auth.origin || url.pathname !== '/v1/chat/completions' || url.search || url.hash ||
          url.username || url.password || method !== 'POST') {
        throw failure('LLM_ENDPOINT', '전용 로컬 번역 요청 경계가 일치하지 않습니다.');
      }
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set('Authorization', `Bearer ${auth.secret}`);
      auth.onRequest?.();
      const response = await priorFetch.call(globalThis, input, { ...init, headers, redirect: 'error' });
      return await boundedResponse(response, LIMITS.llmResponseBytes);
    };
    childProcess.spawn = spawnHook;
    globalThis.fetch = fetchHook;
    syncBuiltinESMExports();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--hookUsers === 0) {
      if (childProcess.spawn === spawnHook) childProcess.spawn = priorSpawn;
      if (globalThis.fetch === fetchHook) globalThis.fetch = priorFetch;
      syncBuiltinESMExports();
    }
  };
}

async function boundedResponse(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return response;
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw failure('LLM_RESPONSE_LIMIT', '로컬 번역 응답이 허용 크기를 초과했습니다.');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function deadline(signal, milliseconds, code, operation) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, milliseconds);
  let work, rejectAbort;
  const onAbort = () => rejectAbort(failure('CANCELLED', '작업이 취소되었습니다.'));
  const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
  try {
    assertActive(controller.signal);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    work = Promise.resolve().then(() => { assertActive(controller.signal); return operation(controller.signal); });
    const value = await Promise.race([work, cancelled]);
    assertActive(controller.signal);
    return value;
  } catch (error) {
    if (error?.code === 'CLEANUP_FAILED') throw error;
    if (controller.signal.aborted && work) {
      // 취소를 알렸다는 이유만으로 실행 슬롯을 반환하지 않는다.
      const settled = await waitBounded(work.then(() => ({}), (error) => ({ error })), LIMITS.cleanupMs);
      if (settled.error?.code === 'CLEANUP_FAILED') throw settled.error;
    }
    if (timedOut) throw failure(code, '단계별 실행 제한 시간이 초과되었습니다.');
    assertActive(signal);
    throw error;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    signal?.removeEventListener('abort', abort);
  }
}

function waitBounded(promise, milliseconds, code = 'CLEANUP_FAILED') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(failure(code, '생성한 작업의 종료를 확인하지 못했습니다.')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

class ProcessOwner {
  constructor() { this.children = new Map(); }
  track(child) {
    if (this.children.has(child)) return this.children.get(child);
    const record = { child, closed: false, error: false };
    record.done = new Promise((resolve) => {
      child.once('error', () => { record.error = true; });
      child.once('close', (code, signal) => { record.closed = true; record.code = code; record.signal = signal; resolve(record); });
    });
    this.children.set(child, record);
    return record;
  }
  run(operation, auth, signal, spawnPolicy, environmentPolicy) { return scopeStorage.run({ owner: this, auth, signal, spawnPolicy, environmentPolicy, parent: scopeStorage.getStore() }, operation); }
  spawn(executable, args, options) { assertSpawnAllowed(); return this.track(childProcess.spawn(executable, args, options)); }
  async terminate(record, tree = false) {
    if (record.closed) return;
    if (tree && process.platform === 'win32' && record.child.pid) {
      const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      const killer = this.spawn(executable, ['/PID', String(record.child.pid), '/T', '/F'], {
        windowsHide: true, shell: false, stdio: 'ignore', env: secretlessEnvironment(executable, process.env.TEMP || dirname(executable)),
      });
      const result = await waitBounded(killer.done, LIMITS.cleanupMs);
      if (result.code !== 0 && !record.closed) throw failure('CLEANUP_FAILED', '생성한 Python 작업 트리를 종료하지 못했습니다.');
    } else {
      record.child.kill('SIGKILL');
    }
    await waitBounded(record.done, LIMITS.cleanupMs);
  }
  async cleanup() {
    const results = await Promise.allSettled([...this.children.values()].map((record) => this.terminate(record)));
    if (results.some((result) => result.status === 'rejected') || [...this.children.values()].some((record) => !record.closed)) {
      throw failure('CLEANUP_FAILED', '생성한 프로세스의 종료 확인에 실패했습니다. 다음 작업을 차단합니다.');
    }
  }
}

function collectProcess(record, { stdoutLimit, stderrLimit = 64 * 1024, includeStderr = false, onOverflow }) {
  const chunks = [];
  let size = 0, stderrSize = 0, overflow = false;
  const stop = () => {
    if (overflow) return;
    overflow = true;
    if (onOverflow) onOverflow(); else record.child.kill('SIGKILL');
  };
  record.child.stdout?.on('data', (chunk) => {
    size += chunk.length;
    if (size <= stdoutLimit) chunks.push(Buffer.from(chunk)); else stop();
  });
  record.child.stderr?.on('data', (chunk) => {
    stderrSize += chunk.length; // 원문은 키 또는 프로젝트 내용을 포함할 수 있어 저장하지 않는다.
    if (includeStderr && stderrSize <= stderrLimit) chunks.push(Buffer.from(chunk));
    if (stderrSize > stderrLimit) stop();
  });
  record.child.stdin?.on('error', () => {}); // EPIPE는 종료 코드·취소 상태로 처리한다.
  return async () => {
    const result = await record.done;
    if (overflow) throw failure('PROCESS_OUTPUT_LIMIT', '모델 작업의 출력 상한을 초과했습니다.');
    if (result.error || result.code !== 0) throw failure('PROCESS_FAILED', '로컬 모델 작업이 실패했습니다.');
    return Buffer.concat(chunks);
  };
}

function authEnvironmentName(help) {
  const name = help.match(/\b(LLAMA_ARG_API_KEY|LLAMA_API_KEY)\b/)?.[1];
  if (!name || !/--api-key\b/.test(help)) throw failure('LLM_AUTH_UNSUPPORTED', '이 llama-server의 환경변수 인증 지원을 확인하지 못했습니다.');
  return name;
}

/** 종료 코드 0이어도 내부 worker의 wait 실패는 취소보다 우선한다. */
function parseLamaResponse(raw, signal) {
  let result;
  try { result = JSON.parse(raw.toString('utf8')); } catch { throw failure('INPAINT_RESPONSE', 'LaMa 응답이 손상되었습니다.'); }
  if (result?.cleanupConfirmed === false || result?.verification?.cleanupConfirmed === false ||
      result?.error === 'worker_cleanup_failed') {
    throw failure('CLEANUP_FAILED', 'LaMa worker의 실제 종료를 확인하지 못했습니다. 다음 작업을 차단합니다.');
  }
  assertActive(signal);
  return result;
}

module.exports = { LIMITS, failure, assertActive, assertDimensions, imageHeader, secretlessEnvironment,
  acquireHooks, deadline, waitBounded, ProcessOwner, collectProcess, authEnvironmentName, boundedResponse, parseLamaResponse };
