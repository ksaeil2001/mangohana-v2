import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { modelVerdicts, reviewMemory } from './attempt.mjs';

async function optional(file, fallback, decode = JSON.parse) {
  try { return decode(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function lines(contents) {
  const records = contents.split('\n');
  records.pop(); // A killed writer can leave an incomplete final record.
  return records.filter(Boolean).map(line => JSON.parse(line));
}

export async function reviewRecord(directory) {
  const work = path.join(directory, 'work');
  const [result, parentResources, host] = await Promise.all([
    optional(path.join(directory, 'result.json'), {}),
    optional(path.join(directory, 'resources.jsonl'), [], lines),
    optional(path.join(directory, 'host.jsonl'), [], lines),
  ]);
  let stageDirectories = [];
  try { stageDirectories = await readdir(work, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const activities = await Promise.all(stageDirectories.filter(entry => entry.isDirectory()).map(async entry => {
    const [trace, terminal] = await Promise.all([
      optional(path.join(work, entry.name, 'model-events.jsonl'), [], lines),
      optional(path.join(work, entry.name, 'process.json'), {}),
    ]);
    return { name: entry.name, trace, terminal };
  }));
  const resources = [...parentResources, ...activities.flatMap(stage => [stage.terminal.before, stage.terminal.after].filter(Boolean))];
  resources.sort((left, right) => (
    BigInt(left.monotonicNs ?? 0) < BigInt(right.monotonicNs ?? 0) ? -1 :
      BigInt(left.monotonicNs ?? 0) > BigInt(right.monotonicNs ?? 0) ? 1 : 0
  ));
  const trace = activities.flatMap(stage => stage.trace);
  const memory = reviewMemory({ trace, resources, docker: result.container, host,
    attempt: { pipeline: result.worker?.stages?.find(stage => stage.stage === 'qwen' && stage.reason) ??
      (result.supervision ? { reason: result.supervision } : {}) } });
  const models = {};
  for (const stage of ['ocr', 'qwen', 'lama']) {
    const attempt = result.dispatches?.[stage];
    const selected = activities.find(activity => activity.name === stage + '-' + attempt?.mode);
    const terminal = result.worker?.stages?.find(item => item.stage === stage && item.mode === attempt?.mode);
    Object.assign(models, terminal?.models ?? modelVerdicts(stage, selected?.trace ?? [], {
      status: attempt ? 'FAIL' : 'BLOCKED',
      reason: attempt ? (result.supervision ?? 'RESULT_UNKNOWN') : (result.worker?.halted ?? 'NOT_DISPATCHED'),
    }));
  }
  return {
    scope: 'RECORDED_0B_EVIDENCE_ONLY',
    pipeline: result.pipeline ?? { status: 'BLOCKED', reason: 'TERMINAL_RECEIPT_MISSING' },
    models, memory,
    followUp: memory.missingEvidence.length ? 'CAPTURE_MISSING_RESOURCE_SIGNALS_BEFORE_ANY_NEW_ATTEMPT' : 'REVIEW_RECORDED_LOAD_AND_COMPUTE_PHASES',
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) {
    console.error('Usage: node review.mjs RUN_EVIDENCE_DIRECTORY');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await reviewRecord(path.resolve(process.argv[2])), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 2; }
  }
}
