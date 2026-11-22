const modelStages = ['ocr', 'qwen', 'lama'];
const pipelineStages = ['ocr', 'mask', 'qwen', 'lama', 'render'];
const hostSampleMaxAgeMs = 12_000;
const hostRecoveryWaitMs = 30_000;
const stopReasons = new Set([
  'CGROUP_OOM', 'MEMORY_ALLOCATION_FAILED', 'CLEANUP_UNCONFIRMED', 'RESOURCE_EVIDENCE_MISSING',
  'HOST_MEMORY_UNAVAILABLE', 'ATTEMPT_TIMEOUT', 'CANCELLED', 'DISPATCH_UNCONFIRMED', 'STAGE_EVIDENCE_MISSING',
  'HOST_SAMPLE_UNAVAILABLE', 'HOST_MEMORY_PRESSURE', 'HOST_COMMIT_PRESSURE',
]);

const graphsByStage = {
  ocr: { rtdetr: ['rtdetr'], ppocrv4: ['ppocrv4'], baberu: ['baberu_vision', 'baberu_prefill', 'baberu_step'] },
  qwen: { qwen: ['qwen'] },
  lama: { lama: ['lama'] },
};

export function hostBlockReasonAfter(sample, notBefore, now) {
  const { windowsQueryStartedBootMs: start, windowsSampledBootMs: end, sampledAtBootMs: readAt } = sample ?? {};
  const fresh = [notBefore, start, end, readAt, now].every(Number.isSafeInteger) &&
    notBefore <= start && start <= end && end <= readAt && readAt <= now && now - start <= hostSampleMaxAgeMs;
  if (!fresh) return 'HOST_SAMPLE_UNAVAILABLE';
  if (sample.runtimeIssue) return sample.runtimeIssue;
  return sample.ready === true ? null : 'HOST_MEMORY_UNAVAILABLE';
}

export const hostReadyAfter = (sample, notBefore, now) => hostBlockReasonAfter(sample, notBefore, now) === null;

export function stageHostDecision(sample, notBefore, waitStartedAt, now) {
  const issue = hostBlockReasonAfter(sample, notBefore, now);
  const waited = now - waitStartedAt;
  if (!Number.isSafeInteger(waited) || waited < 0) return 'HOST_SAMPLE_UNAVAILABLE';
  if (issue === null) return waited < hostRecoveryWaitMs ? null : 'HOST_MEMORY_UNAVAILABLE';
  if (issue === 'HOST_MEMORY_UNAVAILABLE' && waited < hostRecoveryWaitMs) return 'WAIT';
  if (issue === 'HOST_SAMPLE_UNAVAILABLE' && waited < hostSampleMaxAgeMs) return 'WAIT';
  return issue;
}

export function classifyFailure({
  oomEventDelta = 0, dockerOomKilled = false, trace = [], timedOut = false, cancelled = false,
  exitCode, signal, invalidOutput = false,
} = {}) {
  if (oomEventDelta > 0 || dockerOomKilled) return 'CGROUP_OOM';
  if (trace.some(event => event.failure === 'MEMORY_ALLOCATION_FAILED')) return 'MEMORY_ALLOCATION_FAILED';
  if (timedOut) return 'STAGE_TIMEOUT';
  if (cancelled) return 'CANCELLED';
  const diagnostic = trace.find(event => [
    'MODEL_COMPATIBILITY', 'ARTIFACT_CHECK_FAILED', 'RUNTIME_DEPENDENCY', 'QWEN_TOKEN_LIMIT',
  ].includes(event.failure));
  if (diagnostic) return diagnostic.failure;
  if (exitCode === 137 || signal === 'SIGKILL') return 'KILL_CAUSE_UNCONFIRMED';
  if (exitCode === 0 && invalidOutput) return 'INVALID_OUTPUT';
  return 'RESULT_UNKNOWN';
}

export async function executeAttempt({ runStage, canContinue, recordDispatch }) {
  // These counters reserve permission before spawn. A lost reply never frees a slot.
  const calls = Object.fromEntries(modelStages.map(stage => [stage, 0]));
  const stages = [];
  let halted = null;

  async function step(stage, mode) {
    async function gate(phase) {
      try { return await canContinue(mode, stage, phase); }
      catch { return 'RESOURCE_EVIDENCE_MISSING'; }
    }
    halted = await gate('stage');
    if (halted) return { status: 'BLOCKED', reason: halted };

    const dispatch = async inputSha256 => {
      const issue = await gate('dispatch');
      halted ??= issue;
      if (halted) throw new Error(halted);
      if (!modelStages.includes(stage) || calls[stage] || !/^[a-f0-9]{64}$/.test(inputSha256)) {
        halted = 'DISPATCH_UNCONFIRMED';
        throw new Error(halted);
      }
      calls[stage] = 1;
      try { await recordDispatch({ stage, mode, inputSha256 }); }
      catch (error) {
        halted = 'DISPATCH_UNCONFIRMED';
        throw error;
      }
    };

    let result;
    try { result = await runStage(stage, { mode, dispatch }); }
    catch { result = { status: 'FAIL', reason: halted ?? 'STAGE_EVIDENCE_MISSING' }; }
    if (result?.status === 'PASS' && modelStages.includes(stage) && calls[stage] !== 1) {
      result = { status: 'FAIL', reason: 'DISPATCH_UNCONFIRMED' };
    }
    if (!['PASS', 'FAIL', 'BLOCKED'].includes(result?.status)) {
      result = { status: 'FAIL', reason: 'STAGE_EVIDENCE_MISSING' };
    }
    stages.push({ ...result, stage, mode });
    halted ??= result.halt ?? (stopReasons.has(result.reason) ? result.reason : null);
    return result;
  }

  let pipeline = { status: 'PASS' };
  for (const stage of pipelineStages) {
    const result = await step(stage, 'pipeline');
    if (result.status === 'PASS' && !halted) continue;
    const started = modelStages.some(name => calls[name] > 0);
    pipeline = { status: started ? 'FAIL' : 'BLOCKED', stage, reason: result.reason ?? halted };
    break;
  }

  if (pipeline.status === 'FAIL') {
    for (const stage of ['lama', 'qwen']) {
      if (halted) break;
      if (!calls[stage]) await step(stage, 'standalone');
    }
  }
  const models = Object.assign({}, ...modelStages.map(stage => (
    stages.findLast(item => item.stage === stage && item.models)?.models ??
      modelVerdicts(stage, [], { status: 'BLOCKED', reason: halted ?? 'NOT_DISPATCHED' })
  )));
  return { calls, pipeline, stages, models, halted };
}

const verdict = (status, reason) => ({ status, ...(reason ? { reason } : {}) });

export function modelVerdicts(stage, trace, result) {
  return Object.fromEntries(Object.entries(graphsByStage[stage] ?? {}).map(([model, graphs]) => {
    const saw = (phase, graph) => trace.some(event => event.phase === phase && event.graph === graph && (
      phase !== 'load_ok' || event.provider === 'CPUExecutionProvider'
    ));
    const modelEvent = phase => trace.some(event => event.phase === phase && event.model === model);
    const loaded = graphs.every(graph => saw('load_ok', graph));
    const loadStarted = graphs.some(graph => saw('load_start', graph));
    const firstCompute = graphs.some(graph => saw('compute_ok', graph));
    const allGraphsRan = graphs.every(graph => saw('compute_ok', graph));
    const computeStarted = graphs.some(graph => saw('compute_start', graph));
    const computed = allGraphsRan && modelEvent('model_complete');
    const reason = result.reason ?? 'MODEL_EVIDENCE_MISSING';
    const load = loaded ? verdict('PASS') : loadStarted ? verdict('FAIL', reason) : verdict('BLOCKED', reason);
    const compute = computed ? verdict('PASS') : computeStarted ? verdict('FAIL', reason) : verdict('BLOCKED', reason);
    let output = verdict('BLOCKED', reason);
    if (modelEvent('output_ok') && computed) output = verdict('PASS');
    else if (modelEvent('output_invalid') || computed && (result.invalidOutput || reason === 'INVALID_OUTPUT') && stage !== 'ocr') output = verdict('FAIL', reason);
    else if (computed && result.status === 'PASS') output = verdict('PASS');
    return [model, { load, compute, output, firstComputeReturned: firstCompute }];
  }));
}

export function reviewMemory({ trace = [], resources = [], docker = {}, host = [], attempt = {} } = {}) {
  const samples = resources.filter(sample => Number.isSafeInteger(sample.memoryPeak));
  const peak = samples.reduce((highest, sample) => (
    !highest || sample.memoryPeak > highest.memoryPeak ? sample : highest
  ), null);
  const eventDelta = key => {
    const values = samples.map(sample => sample.memoryEvents?.[key]).filter(Number.isSafeInteger);
    return values.length >= 2 ? Math.max(0, values.at(-1) - values[0]) : null;
  };
  const lastQwen = trace.findLast(event => event.model === 'qwen' || event.graph === 'qwen');
  const oomDelta = eventDelta('oom'), oomKillDelta = eventDelta('oom_kill');
  const reason = classifyFailure({
    oomEventDelta: Math.max(oomDelta ?? 0, oomKillDelta ?? 0), dockerOomKilled: docker.OOMKilled,
    trace, exitCode: docker.ExitCode,
  });
  const swap = samples.map(sample => sample.memorySwapCurrent).filter(Number.isSafeInteger);
  const hostMin = key => {
    const values = host.map(sample => sample[key]).filter(Number.isFinite);
    return values.length ? Math.min(...values) : null;
  };
  return {
    cause: reason === 'RESULT_UNKNOWN' ? attempt.pipeline?.reason ?? null : reason,
    attribution: oomDelta > 0 ? 'MEMORY_CONTROLLER_OOM' : oomKillDelta > 0 || docker.OOMKilled ? 'OOM_SCOPE_UNCONFIRMED' : null,
    lastQwenPhase: lastQwen?.phase ?? null, peakBytes: peak?.memoryPeak ?? null,
    limitBytes: peak?.memoryMax ?? null, sampledBreakdownAtPeak: peak?.memoryStat ?? null,
    swapPeakBytes: swap.length ? Math.max(...swap) : null, oomDelta, oomKillDelta,
    windowsAvailableMinMiB: hostMin('windowsAvailableMiB'), wslAvailableMinMiB: hostMin('wslAvailableMiB'),
    minimumRequiredMemoryBytes: null,
    missingEvidence: [
      ...(!peak || oomDelta === null || oomKillDelta === null ? ['cgroupBaselineAndTerminalCounters'] : []),
      ...(!peak?.memoryStat ? ['sampledMemoryBreakdown'] : []),
      ...(!host.some(sample => Number.isFinite(sample.windowsAvailableMiB)) ? ['windowsMemory'] : []),
      ...(!host.some(sample => Number.isFinite(sample.wslAvailableMiB)) ? ['wslMemory'] : []),
      ...(!lastQwen ? ['qwenPhase'] : []),
    ],
  };
}
