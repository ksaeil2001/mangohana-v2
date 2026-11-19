import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const guard = new URL('../stage16-03-20261119/metadata-only.mjs', import.meta.url);
const baseline = new URL('red-baseline.mjs', import.meta.url);
const stage = 'stage16-final-acceptance';
const red = [
  'a saved lock cannot start without current unused work evidence',
  'a locked four condition plan cannot start without scoped execution approval',
  'a report with one missing assigned receipt cannot reach final acceptance',
  'a report with only one returning reviewer cannot reach final acceptance',
];
const integrity = [
  'a missing or replaced pre-execution start commitment blocks final reconciliation',
  'subsequent approval cannot retroactively replace the one recorded at start',
  'approval facts absent from its pinned content cannot open the gate',
];
const overlap = 'an axis with no assessable independent overlap cannot be accepted on returned forms alone';
const previous = 'the S16-05 handoff report replays exactly and cannot substitute for a start receipt';
const reopen = 'all five saved JSON artifacts reopen against the index and the independent synthetic replay';
const failedAttempt = 'a later success and a billing reference cannot hide a failed attempt without an execution receipt';
const absent = 'empty actual evidence and a complete synthetic dossier both leave actual gates blocked';
const focused = [...red, ...integrity,
  'start can precede every post-run artifact and its synthetic record is scoped',
  'exposed tuned and unauthorized works cannot reuse a previously valid start',
  'an approval with foreign jobs foreign lock refusal or missing route evidence blocks start',
  'changed model scope or an unassigned fourth cell blocks even a newly pinned job list',
  'the five official artifacts reproduce the same locked cohort receipts returns and cost rows',
  'unfavorable tied and uncertain outcomes survive reconciliation without a winner requirement',
  'a missing stage or attempt receipt keeps every planned cell and its original reason',
  'an unsettled fee blocks final cost acceptance and preserves the confirmed subtotal',
  failedAttempt,
  'every scheduled ballot needs both axes even if another overlap is fully answered',
  'two independent submitted judgments can disagree or explicitly abstain',
  overlap,
  'a replayed receipt counts once and a receipt for a foreign job blocks the dossier',
  'substituted downstream pins or an edited effect or cost report cannot be accepted',
  'receipt and ballot evidence kinds cannot be mixed into a synthetic reconciliation',
  absent,
  'self-labelled human submissions still need two independent authenticated return records',
  previous,
];
const regression = {
  'stage16-condition-matrix': [
    'the work, page, every shared pin and each axis pin bind the matrix identity',
    'explicitly planning the full path has a distinct identity from fixed intermediate input',
  ],
  'stage16-experiment-lock': [
    'different works and leakage groups cannot reuse a candidate-selection context SHA',
    'an unknown candidate-selection history cannot issue a lock for an independent work',
    'independent evidence and frozen criteria issue a reproducible lock for the exact cohort',
    'tuning after opening demotes the work and its group, preserves history and requires a fresh holdout',
    'a previously valid but truncated history cannot replay the pre-tuning lock against the current evidence',
    'foreign work, source, or sealed ground truth cannot be substituted even with a valid matrix fingerprint',
  ],
  'stage16-execution-observations': [
    'a receipt for the wrong cell is refused before it contributes a completion',
    'replaying a receipt counts one job and one charge',
    'a partial stage cannot complete a page that reports success',
    'an unsettled charge is unknown even when the confirmed subtotal is zero',
    'four assigned cells retain recovered, partial, successful and missing jobs and their exact subtotal',
    'the intermediate pin and first executed stage fence the path and preserve cold and warm timings',
    'a copied zero without matching provider settlement evidence cannot enter the confirmed total',
  ],
  'stage16-blind-review': [
    'one reviewer cannot supply both independent assignments',
    'opposite fidelity and naturalness choices are recovered separately',
    'every planned assignment survives a completely empty return',
    'old lock, observation, manifest, protocol, job and secret commitments reject substitutions',
    'an overlap requires two qualified bilingual people in distinct Stage05 groups',
    'unavailable and ambiguous cell results keep their planned slots and cannot be rated',
  ],
  'stage16-paired-report': [
    'the missing fifth pair stays in the denominator of confirmed improvement',
    'a tied blind preference counts as a tie and earns no win',
    'exact zero event upper limits distinguish 298 and 299 independent observations',
    'three pages from a single work can show worsening but supply no between work interval',
    'an unsettled fee on a completed winning cell keeps the full cost unknown',
    'one abstention or unreturned overlap ballot leaves the pair unresolved',
    'substituting any independently retained pin or the registered policy blocks the report',
  ],
  'offline-evaluation': [
    'zero pages yields null rates and reason',
    'partial cost observations keep the total null and exclude Codex usage',
  ],
  'quality-policy': [
    'zero denominator, absent GT, and partial observation remain explicit unknown states',
    'synthetic or historical claims cannot certify real product delivery',
  ],
};
const suites = { red: { [stage]: red }, integrity: { [stage]: integrity }, overlap: { [stage]: [overlap] },
  receipt: { [stage]: [failedAttempt] }, absent: { [stage]: [absent] }, focused: { [stage]: focused },
  capture: { [stage]: focused }, regression, evidence: { [stage]: [reopen] } };
const name = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(suites, name)) throw Error('Unknown S16-06 suite');
const files = { experimentLock: 'experiment-lock.json', conditionTable: 'condition-table.json', humanAudit: 'human-audit.json',
  uncertaintyPairedReport: 'uncertainty-paired-report.json', costAdjustedSuccess: 'cost-adjusted-success.json' };
function saveSample({ result, pins, actualWithoutEvidence }) {
  const outputs = Object.entries(files).map(([key, file]) => [file, result.artifacts[key]]);
  outputs.push(['synthetic-index.json', { scope: result.scope, status: result.status, blockers: result.blockers,
    start: result.start.record, pins, files, artifactSha256: result.artifactSha256, actualWithoutEvidence }]);
  for (const [file, value] of outputs) {
    const target = new URL(file, import.meta.url);
    const json = JSON.stringify(value, null, 2) + '\n';
    if (existsSync(target)) {
      if (readFileSync(target, 'utf8') !== json) throw Error('Existing evidence differs: ' + file);
    } else writeFileSync(target, json, { flag: 'wx' });
  }
}
const sources = [
  ...['condition-matrix','experiment-lock','execution-observations','blind-review','paired-report','final-acceptance']
    .map(s => 'packages/evaluation/stage16-' + s + '.mjs'),
  ...['experiment','observations','blind-review','paired','acceptance'].map(s => 'tests/v2/fixtures/stage16-' + s + '.mjs'),
  'packages/evaluation/dataset-contract.mjs', 'packages/evaluation/image-fingerprint.mjs',
  'packages/evaluation/dataset-v1.schema.json', 'packages/evaluation/annotation-v1.schema.json',
  'packages/evaluation/policy/policy.mjs', 'packages/evaluation/policy/stage08-v1.1.json',
  ...['contract','evaluator','evidence','ocr','operations','quality','report','v2-adapter'].map(s => 'packages/evaluation/offline/' + s + '.mjs'),
  'packages/contracts/src/v2-common-contract.mjs', 'packages/contracts/schemas/v2-common-contract-v1.schema.json',
  'apps/desktop/scripts/evaluate-automation-quality.mjs', 'apps/engine/stage15-provider-adapter.mjs',
  'apps/engine/stage15-batch-accounting.mjs', 'apps/engine/store.mjs', 'apps/engine/result.mjs',
  ...['human-translation-review','recovery-checkpoint','recovery-policy','stage15-quality-decision','stage15-stage-graph']
    .map(s => 'packages/ai-engine/quality/' + s + '.cjs'),
  ...['ajv','ajv-formats','fast-deep-equal','fast-uri','json-schema-traverse','require-from-string','decimal.js']
    .map(s => 'node_modules/' + s),
  'package.json', fileURLToPath(guard),
];
for (const [stem, names] of Object.entries(suites[name])) {
  const entry = 'tests/v2/' + stem + '.test.mjs';
  const read = [...sources, entry];
  if (stem === 'offline-evaluation') read.push('tests/v2/offline-evaluation-fixture.mjs');
  if (names.includes(previous)) read.push('docs/validation/stage16-05-20261119/synthetic-report.json');
  if (names.includes(reopen)) read.push(...['synthetic-index.json', ...Object.values(files)]
    .map(file => fileURLToPath(new URL(file, import.meta.url))));
  const preloads = [guard];
  if (name === 'red') { read.push(fileURLToPath(baseline)); preloads.push(baseline); }
  const args = ['--permission', ...read.map(f => '--allow-fs-read=' + path.resolve(root, f)),
    ...preloads.flatMap(url => ['--import', url.href]), '--test-reporter=tap',
    '--test-name-pattern=^(?:' + names.map(n => Array.from(n, c => /[\w ,]/.test(c) ? c : '\\' + c).join('')).join('|') + ')$', entry];
  const run = spawnSync(process.execPath, args, { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { SystemRoot: process.env.SystemRoot, NODE_OPTIONS: '', NODE_DISABLE_COMPILE_CACHE: '1', NODE_DISABLE_COLORS: '1',
      S16_TEST_NAMES: JSON.stringify(names), S16_CAPTURE_FINAL: name === 'capture' ? '1' : '0' } });
  if (run.error) throw run.error;
  const marker = /^# S16_FINAL_SAMPLE (.*)$/m;
  process.stdout.write(run.stdout.replace(marker, '# Five synthetic artifacts captured by the allowlisted runner'));
  process.stderr.write(run.stderr);
  const ran = [...run.stdout.matchAll(/^(?:not )?ok \d+ - ([^\r\n]+)$/gm)].map(m => m[1]);
  if (run.signal || /S16_FORBIDDEN_OPERATION|ERR_ACCESS_DENIED/.test(run.stdout + run.stderr) ||
      ran.length !== names.length || names.some(n => !ran.includes(n)) || /# (?:skipped|todo|cancelled) [1-9]/i.test(run.stdout)) {
    process.stderr.write('Guard or allowlist verification failed for ' + stem + '\n');
    process.exit(2);
  }
  if (run.status !== 0) process.exit(run.status ?? 2);
  if (name === 'capture') {
    const sample = run.stdout.match(marker);
    if (!sample) throw Error('Expected the verified synthetic sample');
    saveSample(JSON.parse(sample[1]));
  }
}
