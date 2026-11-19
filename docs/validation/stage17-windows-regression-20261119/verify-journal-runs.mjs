import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const series = process.argv[2] ?? 'journal';
if (!['journal','quiet'].includes(series)) throw Error('Unrecognized regression series');
const root = path.resolve(here, '../../..');
const read = file => JSON.parse(fs.readFileSync(path.join(here, file), 'utf8').replace(/^\uFEFF/, ''));
const sha = input => createHash('sha256').update(input).digest('hex');
const fileSha = file => sha(fs.readFileSync(file));
const baseline = read('plain-full/sources.json');
const sourceKeys = Object.keys(baseline).filter(file => /^(apps|packages|scripts|tests)[\\/]/.test(file));
const fixture = 'tests/v2/fixtures/owned-engine-runtime.mjs';
const fixtureHash = '1971c6915cf1852c4fbda01bb7a28f62da7e6b20606c0650de4c6ebfc0516cd6';
const originalHash = 'd612c3d056ba6e40259758c5d59bfde663bdbe69e791766654a5f88038bed213';
const actualFixture = fs.readFileSync(path.join(root, fixture), 'utf8');
const originalFixture = actualFixture
  .replace(" // Keep test-only file opens out of the server's authenticated readiness request.\n const journal=await fs.open(diary,'ax');\n t.after(()=>journal.close());\n", '')
  .replace('fs.appendFileSync(1,', 'fs.appendFileSync(process.env.SYNTHETIC_DIARY,')
  .replace("stdio:['ignore',journal.fd,'ignore'],", '');
const fixtureVerified = sha(actualFixture) === fixtureHash && sha(originalFixture) === originalHash && baseline[fixture] === originalHash;
const sameSources = pins => sourceKeys.every(file => pins[file] === (file === fixture ? fixtureHash : baseline[file]));
const current = Object.fromEntries(sourceKeys.map(file => [file, fileSha(path.join(root, file))]));
const expectedOutputs = {
  normal: 'ce0111bb5e7711a4f25d8577b8fed5bddc87009184cb0640557c7c89b832cea3',
  expanded: '2f48756a4a5cc4ed18f175d4dd8d0b384584be1a1c3614865c4e68bee7bc92bb',
};
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const reference = 'verified-five/trace';
const fileTests = Object.fromEntries(fs.readdirSync(path.join(here, reference)).map(file => [
  file.replace(/\.\d+\.json$/, ''), read(reference + '/' + file).filter(e => e.event === 'test_start').map(e => e.test),
]));
function summarize(label, expectedCount) {
  const r = read(label + '/result.json');
  const timing = read(label + '/launch-phases.json');
  const log = fs.readFileSync(path.join(here, label, 'tap.log'), 'utf8');
  const original = read(label.replace(/^(journal|quiet)-/, 'plain-') + '/command.json');
  const hashesMatch = r.logSha256 === sha(log) && r.sourcesSha256 === fileSha(path.join(here, label, 'sources.json'));
  const commandsMatch = equal(r.args, original.args) && r.executableSha256 === original.executableSha256 && r.traceFlag === 'normal';
  const testResults = new Map([...log.matchAll(/^(ok|not ok) \d+ - (.+)\r?$/gm)].map(m => [m[2].trimEnd(), m[1]]));
  const selectedFiles = Object.entries(fileTests).map(([name, tests]) => {
    const present = tests.filter(n => testResults.has(n));
    return {name, tests: present.length, passed: present.filter(n => testResults.get(n) === 'ok').length};
  }).filter(file => file.tests);
  const kinds = timing.rows.filter(row => row.kind === 'typesetting');
  const successful = kinds.filter(row => row.rootExitCode === 0 && row.reason === 'root_exit' && row.witness?.outputBound);
  const rejected = kinds.filter(row => row.rootExitCode === 1 && row.reason === 'root_exit' && row.witness?.failureBound &&
    row.witness.failureCode === 'MANUAL_LAYOUT_REQUIRED' && row.witness.candidateSha256 === null);
  const expected = r.mode === 'entry' ? [] : r.mode === 'exit' ? [expectedOutputs.normal] : Object.values(expectedOutputs).sort();
  const expectedRejections = ['full','five'].includes(r.mode) ? 1 : 0;
  const outputBound = equal(successful.map(row => row.witness.candidateSha256).sort(), expected) &&
    rejected.length === expectedRejections && kinds.length === expected.length + expectedRejections;
  const missing = timing.rows.find(row => row.kind === 'missing-plan');
  const missingPlan = r.mode === 'exit' || (missing?.rootExitCode === 1 && missing.reason === 'root_exit' &&
    missing.witness?.actualAiCalls === 0 && missing.witness.events.some(e => e.phase === 'startup_failed' &&
      e.bootstrapStage === 'plan_read' && e.primaryFailureCode === 'ENOENT' && e.code === 'WARM_STARTUP_FAILED'));
  const inputsUnchanged = !r.changed.length && sameSources(read(label + '/sources.json'));
  const passingTap = r.code === 0 && !r.signal && r.counts.tests === expectedCount && r.counts.pass === expectedCount &&
    ['fail', 'cancelled', 'skipped', 'todo'].every(k => r.counts[k] === 0);
  return {label, counts:r.counts, code:r.code, started:r.started, finished:r.finished, failures:r.failures, selectedFiles,
    logSha256:r.logSha256, hashesMatch, commandsMatch, inputsUnchanged, workerReceipts:timing.measured, receiptsMatch:timing.pass,
    outputBound, missingPlan, missingPlanWorker:missing && {supervisor:missing.supervisorCreatedUtc, start:missing.rootCreatedUtc,
      exit:missing.rootExitedUtc, ms:missing.workerMs, exitCode:missing.rootExitCode, clean:missing.clean, active:missing.activeAfter},
    pass:Boolean(passingTap && hashesMatch && commandsMatch && inputsUnchanged && timing.pass && outputBound && missingPlan)};
}
const stage16 = read((series === 'quiet' ? 'stage16-quiet' : 'stage16-final') + '/result.json');
const originalProtected = read('protected-readback.json'), protectedNow = read(series === 'quiet' ? 'quiet-protected-final.json' : 'protected-final.json');
const protection = protectedNow.files.length === 18 && protectedNow.files.every(f => f.matches) &&
  equal(protectedNow.files, originalProtected.files) && equal(protectedNow.signedResult, originalProtected.signedResult) &&
  protectedNow.signedResult.matches && protectedNow.permitIds.length === 7 && equal(protectedNow.permitIds, originalProtected.permitIds);
const result = Object.entries({five:40, full:1340, missing:1, native:1}).map(([name, n]) => summarize(series + '-' + name, n));
const complete = result.every(r => r.pass) && fixtureVerified && sameSources(current) && stage16.pass && protection;
console.log(JSON.stringify({pass:complete, originalFixtureHash:originalHash, revisedFixtureHash:fixtureHash, fixtureVerified,
  sourceKeysCompared:sourceKeys.length, currentSourcesVerified:sameSources(current), outputHashes:expectedOutputs, runs:result,
  stage16:{pass:stage16.pass, executions:stage16.executions, distinctNames:stage16.distinctTestNames}, protection}, null, 2));
process.exitCode = complete ? 0 : 1;
