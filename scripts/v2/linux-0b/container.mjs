import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir, realpath, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { executeAttempt, hostBlockReasonAfter, hostReadyAfter, stageHostDecision } from './attempt.mjs';
import { createStages, digest } from './pipeline.mjs';

const repo = '/input/repo';
const input = '/input';
const control = '/control';
const work = '/work';
const evidence = path.join(work, 'evidence');
const cgroup = '/sys/fs/cgroup';
const memoryLimit = 6 * 1024 ** 3;
const python = path.join(work, 'ocr-pack/bin/python');
const probe = path.join(repo, 'scripts/v2/linux-0b/probe.py');
const lifecycle = new AbortController();
let lastChildSettledAt = 0;
const parse = text => JSON.parse(text);
const readJson = async name => parse(await readFile(name, 'utf8'));
const bootMilliseconds = async () => Math.round(Number((await readFile('/proc/uptime', 'ascii')).split(' ', 1)[0]) * 1000);

async function store(target, value, flags = 'wx') {
  const file = await open(target, flags, 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); }
  finally { await file.close(); }
}

const journal = (type, fields) => store(path.join(evidence, 'journal.jsonl'), {
  type, at: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString(), ...fields,
}, 'a');

async function readState() {
  const files = ['memory.events', 'memory.max', 'memory.swap.max', 'memory.swap.current', 'cpu.max',
    'pids.max', 'cgroup.procs', 'pids.events', 'memory.peak', 'memory.current', 'memory.stat'];
  const [events, max, swapMax, swap, cpu, pidsMax, procs, pidsEvents, peak, current, memoryStats] = await Promise.all(
    files.map(name => readFile(path.join(cgroup, name), 'utf8')),
  );
  const counters = text => Object.fromEntries(text.trim().split('\n').map(line => {
    const [name, value] = line.trim().split(/\s+/);
    return [name, Number(value)];
  }));
  const memoryEvents = counters(events);
  const pidEvents = counters(pidsEvents);
  const memoryStat = counters(memoryStats);
  assert.ok([memoryEvents.oom, memoryEvents.oom_kill, pidEvents.max, Number(swap)].every(Number.isSafeInteger));
  return { monotonicNs: process.hrtime.bigint().toString(), memoryEvents, pidDenials: pidEvents.max,
    memoryMax: Number(max), swapMax: Number(swapMax), memoryPeak: Number(peak), memoryCurrent: Number(current),
    memoryStat: { anon: memoryStat.anon, file: memoryStat.file, shmem: memoryStat.shmem },
    memorySwapCurrent: Number(swap), cpuMax: cpu.trim(), pidsMax: Number(pidsMax),
    pids: procs.trim().split(/\s+/).filter(Boolean).map(Number) };
}

function limits(state) {
  assert.equal(state.memoryMax, memoryLimit);
  assert.equal(state.swapMax, 0);
  assert.equal(state.memorySwapCurrent, 0);
  assert.equal(state.cpuMax, '400000 100000');
  assert.equal(state.pidsMax, 256);
}

async function traceFor(directory) {
  const target = path.join(directory, 'model-events.jsonl');
  let contents;
  try { contents = await readFile(target, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  // A process killed while writing can leave a trailing partial record.
  const lines = contents.split('\n');
  lines.pop();
  return lines.filter(Boolean).map(parse);
}

function envFor(directory) {
  return {
    HOME: '/work/home', TMP: directory, TEMP: directory, TMPDIR: '/tmp',
    PATH: '/opt/node24/bin:/opt/trio-python/bin:/usr/bin:/bin',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
    ORT_DISABLE_TELEMETRY: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
  };
}

async function runChild(stage, mode, {
  program, args, stdin, keepStdin = false, milliseconds,
}) {
  const directory = path.join(evidence, stage + '-' + mode);
  await mkdir(directory, { mode: 0o700 });
  const before = await readState();
  const started = performance.now();
  if (lifecycle.signal.aborted) {
    return { exitCode: null, cancelled: true, stdout: Buffer.alloc(0), trace: [] };
  }
  const child = spawn(program, args, { env: envFor(directory), cwd: work, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let spawned = false, timedOut = false, cancelled = false, overflow = false, stopTimer, bytes = 0, errorBytes = 0;
  let finishHardStop;
  const forced = new Promise(resolve => { finishHardStop = resolve; });
  const stdout = [];
  const stderr = [];
  const groupSignal = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
  };
  function stop(reason) {
    timedOut ||= reason === 'timeout';
    cancelled ||= reason === 'cancel';
    overflow ||= reason === 'overflow';
    if (stopTimer) return;
    if (keepStdin && !child.stdin.destroyed) child.stdin.end('{"cancel":true}\n');
    else groupSignal('SIGTERM');
    stopTimer = setTimeout(() => {
      groupSignal('SIGKILL');
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finishHardStop({ exitCode: null, signal: 'SIGKILL', closeUnconfirmed: true });
    }, 6000);
  }
  const cancel = () => stop('cancel');
  const timeout = setTimeout(() => stop('timeout'), milliseconds);
  lifecycle.signal.addEventListener('abort', cancel, { once: true });
  if (lifecycle.signal.aborted) cancel();
  child.stdin.on('error', () => {});
  child.once('spawn', () => { spawned = true; });
  child.on('error', () => {});
  child.stdout.on('data', data => {
    bytes += data.length;
    if (bytes <= 8 * 1024 * 1024) stdout.push(data);
    else stop('overflow');
  });
  child.stderr.on('data', data => {
    errorBytes += data.length;
    if (errorBytes <= 64 * 1024) stderr.push(data);
    if (errorBytes > 64 * 1024) stop('overflow');
  });
  const closed = new Promise(resolve => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
  if (!child.stdin.writableEnded) {
    if (keepStdin) child.stdin.write(stdin);
    else child.stdin.end(stdin);
  }
  const terminal = await Promise.race([closed, forced]);
  lifecycle.signal.removeEventListener('abort', cancel);
  clearTimeout(timeout);
  clearTimeout(stopTimer);
  const reapingDeadline = performance.now() + 6000;
  let after = await readState();
  while (after.pids.some(pid => !before.pids.includes(pid)) && performance.now() < reapingDeadline) {
    await delay(125);
    after = await readState();
  }
  lastChildSettledAt = await bootMilliseconds();
  const residualPids = after.pids.filter(pid => !before.pids.includes(pid));
  const outcome = { ...terminal, spawned, timedOut, cancelled, overflow, childPid: child.pid ?? null,
    residualPids, durationMs: Math.round(performance.now() - started), stdoutBytes: bytes, stderrBytes: errorBytes };
  await store(path.join(directory, 'process.json'), { ...outcome, before, after });
  if (errorBytes && ['setup-venv', 'setup-wheels', 'setup-fixture', 'setup-cache'].includes(stage)) {
    // These commands handle only the pinned local runtime and generated input.
    await store(path.join(directory, 'setup-diagnostic.json'), { stderr: Buffer.concat(stderr).toString('utf8') });
  }
  return { ...outcome, stdout: Buffer.concat(stdout), trace: await traceFor(directory),
    ...(residualPids.length || terminal.closeUnconfirmed ? { halt: 'CLEANUP_UNCONFIRMED' } : {}) };
}

async function preparePython() {
  const pack = path.dirname(path.dirname(python));
  const venv = await runChild('setup-venv', 'preflight', {
    program: '/usr/bin/python3', args: ['-m', 'venv', '--copies', '--without-pip', pack], milliseconds: 45_000,
  });
  assert.ok(venv.exitCode === 0 && !venv.halt);
  assert.equal(await realpath(python), python);
  for (const name of ['recognizer', 'sidecar', 'resource-manifest.json']) {
    await symlink(path.join(input, 'ocr', name), path.join(pack, name));
  }
  const wheels = await runChild('setup-wheels', 'preflight', {
    program: python,
    args: ['-I', '-B', '-c', 'import runpy,sys; sys.path.insert(0,sys.argv.pop(1)); runpy.run_module("pip",run_name="__main__")',
      '/input/wheels/pip-25.3-py3-none-any.whl', '--isolated', '--disable-pip-version-check', 'install',
      '--no-cache-dir', '--no-compile', '--no-index', '--only-binary=:all:', '--find-links', '/input/wheels',
      'onnxruntime==1.23.2', 'numpy==2.2.6', 'Pillow==12.1.0', 'opencv-python-headless==4.10.0.84'],
    milliseconds: 120_000,
  });
  assert.ok(wheels.exitCode === 0 && !wheels.halt);
  const fixture = await runChild('setup-fixture', 'preflight', {
    program: python, args: ['-I', '-B', '-X', 'utf8', probe, 'prepare'], milliseconds: 30_000,
  });
  assert.ok(fixture.exitCode === 0 && !fixture.halt);
  const cleared = await runChild('setup-cache', 'preflight', {
    program: '/usr/bin/python3', args: ['-I', '-B', probe, 'release-setup-cache'], milliseconds: 45_000,
  });
  assert.ok(cleared.exitCode === 0 && !cleared.halt);
  await store(path.join(evidence, 'setup-cache.json'), parse(cleared.stdout.toString('utf8')));
  const fixtureInfo = parse(fixture.stdout.toString('utf8'));
  for (const [property, name] of Object.entries({
    originalSha256: 'original.png', normalizedSha256: 'normalized.png', standaloneMaskSha256: 'standalone-mask.png',
  })) {
    fixtureInfo[property] = digest(await readFile(path.join(evidence, name)));
  }
  return fixtureInfo;
}

async function waitForRelease(claim) {
  const file = claim.checkStartup ? 'checked.json' : 'release.json';
  // The host owns the decision at the shared deadline. Allow it time to record and stop the worker.
  while (!lifecycle.signal.aborted && await bootMilliseconds() < claim.startupDeadlineBootMs + 12_000) {
    try {
      const release = await readJson(path.join(control, file));
      assert.equal(release.jobId, claim.jobId);
      const now = await bootMilliseconds();
      if (now < claim.startupDeadlineBootMs && hostReadyAfter(release.gate, release.gate?.readyObservedBootMs, now)) return;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(250);
  }
  throw Object.assign(new Error('host startup decision unavailable'), { code: 'HOST_DECISION_UNAVAILABLE' });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => lifecycle.abort());
}

async function main() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.22.1');
  assert.equal(process.getuid(), 1000);
  assert.equal(process.getgid(), 1000);
  const status = await readFile('/proc/self/status', 'utf8');
  assert.match(status, /^CapEff:\s+0+$/m);
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  assert.match(status, /^Seccomp:\s+2$/m);
  const interfaces = (await readFile('/proc/net/dev', 'utf8')).split('\n').slice(2)
    .filter(line => line.includes(':')).map(line => line.split(':')[0].trim());
  assert.deepEqual(interfaces, ['lo']);
  assert.deepEqual(await readdir(evidence), []);
  const claim = await readJson(path.join(control, 'claim.json'));
  assert.match(claim.jobId, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isSafeInteger(claim.startupDeadlineBootMs));
  const offset = (await readFile('/proc/self/timens_offsets', 'ascii')).split('\n')
    .map(line => line.trim().split(/\s+/)).find(fields => fields[0] === 'boottime');
  if (offset?.length !== 3 || offset[1] !== claim.bootClockOffset?.[0] || offset[2] !== claim.bootClockOffset?.[1]) {
    throw Object.assign(new Error('host and worker boot clock offsets differ'), { code: 'HOST_CLOCK_MISMATCH' });
  }
  assert.equal(typeof claim.checkStartup, 'boolean');
  const baseline = await readState();
  limits(baseline);
  assert.ok(baseline.pids.includes(process.pid));
  const fixture = await preparePython();
  const stages = createStages({ repo, input, evidence, fixture, runChild, readState, approvedJobId: claim.jobId });
  const standalone = await stages.sealStandaloneInputs();
  const ready = path.join(evidence, 'ready.json');
  await store(ready + '.pending', { jobId: claim.jobId, fixture, standalone, baseline });
  await rename(ready + '.pending', ready);
  await waitForRelease(claim);
  if (claim.checkStartup) {
    await store(path.join(evidence, 'startup-checked.json'), { jobId: claim.jobId });
    return;
  }
  const end = performance.now() + 25 * 60_000;

  function stateIssue(state) {
    limits(state);
    if (state.memoryEvents.oom > baseline.memoryEvents.oom || state.memoryEvents.oom_kill > baseline.memoryEvents.oom_kill) return 'CGROUP_OOM';
    if (state.pidDenials > baseline.pidDenials) return 'RESOURCE_EVIDENCE_MISSING';
    if (state.pids.some(pid => !baseline.pids.includes(pid))) return 'CLEANUP_UNCONFIRMED';
    return null;
  }

  const result = await executeAttempt({
    runStage: stages.runStage,
    recordDispatch: async event => {
      await store(path.join(evidence, 'dispatch-' + event.stage + '.json'), { jobId: claim.jobId, ...event });
      await journal('dispatch', event);
    },
    canContinue: async (mode, stage, phase) => {
      if (lifecycle.signal.aborted) return 'CANCELLED';
      if (performance.now() >= end) return 'ATTEMPT_TIMEOUT';
      let issue = stateIssue(await readState());
      if (issue) return issue;
      const waitStartedAt = await bootMilliseconds();
      let host;
      let observedAt;
      do {
        if (lifecycle.signal.aborted) return 'CANCELLED';
        host = await readJson(path.join(control, 'host.json'));
        observedAt = await bootMilliseconds();
        issue = stageHostDecision(host, lastChildSettledAt, waitStartedAt, observedAt);
        if (issue !== 'WAIT') break;
        await delay(250);
      } while (performance.now() < end);
      if (lifecycle.signal.aborted) return 'CANCELLED';
      if (performance.now() >= end) return 'ATTEMPT_TIMEOUT';
      if (issue) return issue;
      const state = await readState();
      const lastIssue = stateIssue(state) ?? hostBlockReasonAfter(host, lastChildSettledAt, await bootMilliseconds());
      if (lastIssue) return lastIssue;
      await journal('stage-ready', { mode, stage, phase, resources: state, hostSampledAtBootMs: host.sampledAtBootMs,
        hostWaitMs: observedAt - waitStartedAt });
      return null;
    },
  });
  await store(path.join(evidence, 'container-outcome.json'), { jobId: claim.jobId, ...result });
  process.exitCode = result.pipeline.status === 'PASS' && !result.halted ? 0 : result.pipeline.status === 'BLOCKED' ? 2 : 1;
}

main().catch(async error => {
  try {
    await store(path.join(evidence, 'container-error.json'), {
      type: error.name, code: error.code ?? 'PREFLIGHT_OR_EVIDENCE_FAILED',
    });
  } finally {
    process.exitCode = 2;
  }
});
