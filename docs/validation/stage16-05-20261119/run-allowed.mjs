import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const guard = new URL('../stage16-03-20261119/metadata-only.mjs', import.meta.url);
const redBaseline = new URL('red-baseline.mjs', import.meta.url);
const file = 'stage16-paired-report';
const red = [
  'five pages in three works supply three units for model A uncertainty',
  'the missing fifth pair stays in the denominator of confirmed improvement',
  'a tied blind preference counts as a tie and earns no win',
];
const cancellation = 'exactly cancelling fractional work effects cannot win through floating point rounding';
const handoff = 'the previous handoff sealed synthetic returns feed the report with their original missing slots';
const focused = [...red, cancellation,
  'equal work weights reverse the sign of model B page pooling and preserve raw paired scores',
  'missing votes bound the full work effect without becoming ties or losses',
  'each axis compares one resolved blind preference to its automatic direction per pair',
  'exact zero event upper limits distinguish 298 and 299 independent observations',
  'work uncertainty uses three bounded work means and counts a work with any mismatch once',
  'known dependence across works withholds independent work limits',
  'three pages from a single work can show worsening but supply no between work interval',
  'cost counts every assigned charge and only a resolved fidelity win earns credit',
  'zero charge and zero wins have distinct undefined inverse rates',
  'a charged repeat with a different final result costs money without earning a second pair',
  'an all tie primary with a frozen zero minimum never supports improvement',
  'registered minimum effect and naturalness margin govern distinct observations',
  'twelve independent synthetic works can clear a minimum only through the work interval',
  'an unsettled fee on a completed winning cell keeps the full cost unknown',
  'empty scores and empty ballots keep every planned comparison with null rates',
  'one abstention or unreturned overlap ballot leaves the pair unresolved',
  'substituting any independently retained pin or the registered policy blocks the report',
  'duplicate missing foreign or cross model ledger rows cannot shrink or reassign the frozen cohort',
  'a scored cell must match the frozen evaluator final bytes and numeric axis',
  'report records the evidence kinds and replays the saved synthetic example',
  handoff,
];
const regression = {
  'stage16-condition-matrix': [
    'the work, page, every shared pin and each axis pin bind the matrix identity',
    'explicitly planning the full path has a distinct identity from fixed intermediate input',
  ],
  'stage16-experiment-lock': [
    'independent evidence and frozen criteria issue a reproducible lock for the exact cohort',
    'one comparison cannot mix processing or shared settings between pages',
    'foreign work, source, or sealed ground truth cannot be substituted even with a valid matrix fingerprint',
  ],
  'stage16-execution-observations': [
    'replaying a receipt counts one job and one charge',
    'an unsettled charge is unknown even when the confirmed subtotal is zero',
    'four assigned cells retain recovered, partial, successful and missing jobs and their exact subtotal',
    'all locked pages keep four cells and repeated jobs stay separate under the same cell',
    'known zero and exact tiny decimals reconcile with the native Stage15 batch ledger',
  ],
  'stage16-blind-review': [
    'opposite fidelity and naturalness choices are recovered separately',
    'every planned assignment survives a completely empty return',
    'old lock, observation, manifest, protocol, job and secret commitments reject substitutions',
    'unavailable and ambiguous cell results keep their planned slots and cannot be rated',
    'the hand-counted overlap retains disagreement, tie, partial, unanswered and unavailable assignments',
    'an explicitly blank returned form and an omitted axis remain unscored when other forms are answered',
    'equal finished bytes keep separate blinded alternatives and equal repeated jobs do not add ballots',
    'a cohort without any execution receipts still has four planned pairs and no issued forms',
  ],
  'offline-evaluation': [
    'shared translation request is counted once and unknown costs stay null',
    'zero pages yields null rates and reason',
    'partial cost observations keep the total null and exclude Codex usage',
  ],
  'quality-policy': [
    'zero denominator, absent GT, and partial observation remain explicit unknown states',
    'first try, retry success, audit errors and data availability never share a convenient denominator',
    'synthetic or historical claims cannot certify real product delivery',
  ],
};
const suites = { red: { [file]: red }, cancellation: { [file]: [cancellation] }, focused: { [file]: focused }, regression };
const suite = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(suites, suite)) throw Error('Expected red, cancellation, focused or regression');
const stages = ['condition-matrix', 'experiment-lock', 'execution-observations', 'blind-review', 'paired-report'];
const sources = [
  ...stages.map(s => 'packages/evaluation/stage16-' + s + '.mjs'),
  ...['experiment', 'observations', 'blind-review', 'paired'].map(s => 'tests/v2/fixtures/stage16-' + s + '.mjs'),
  'packages/evaluation/dataset-contract.mjs', 'packages/evaluation/image-fingerprint.mjs',
  'packages/evaluation/dataset-v1.schema.json', 'packages/evaluation/annotation-v1.schema.json',
  'packages/evaluation/policy/policy.mjs', 'packages/evaluation/policy/stage08-v1.1.json',
  ...['contract','evaluator','evidence','ocr','operations','quality','report','v2-adapter'].map(s => 'packages/evaluation/offline/' + s + '.mjs'),
  'packages/contracts/src/v2-common-contract.mjs', 'packages/contracts/schemas/v2-common-contract-v1.schema.json',
  'apps/desktop/scripts/evaluate-automation-quality.mjs', 'apps/engine/stage15-provider-adapter.mjs',
  'apps/engine/stage15-batch-accounting.mjs', 'apps/engine/store.mjs', 'apps/engine/result.mjs',
  ...['human-translation-review','recovery-checkpoint','recovery-policy','stage15-quality-decision','stage15-stage-graph']
    .map(s => 'packages/ai-engine/quality/' + s + '.cjs'),
  'node_modules', 'package.json', fileURLToPath(guard),
];
for (const [stem, names] of Object.entries(suites[suite])) {
  const entry = 'tests/v2/' + stem + '.test.mjs';
  const read = [...sources, entry];
  const preloads = [guard];
  if (names.includes(handoff)) read.push(...['synthetic-coordinator.json', 'synthetic-recovery.json']
    .map(name => 'docs/validation/stage16-04-20261119/' + name));
  if (stem === 'offline-evaluation') read.push('tests/v2/offline-evaluation-fixture.mjs');
  if (suite === 'red') { read.push(fileURLToPath(redBaseline)); preloads.push(redBaseline); }
  const escaped = names.map(name => Array.from(name, c => /[\w ,]/.test(c) ? c : '\\' + c).join(''));
  const args = ['--permission', ...read.map(f => '--allow-fs-read=' + path.resolve(root, f)),
    ...preloads.flatMap(url => ['--import', url.href]), '--test-reporter=tap',
    '--test-name-pattern=^(?:' + escaped.join('|') + ')$', entry];
  const res = spawnSync(process.execPath, args, { cwd: root, windowsHide: true, encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', NODE_DISABLE_COMPILE_CACHE: '1', NODE_DISABLE_COLORS: '1',
      S16_TEST_NAMES: JSON.stringify(names), S16_CAPTURE_BLIND_SAMPLE: '0', S16_CAPTURE_PAIRED_SAMPLE: suite === 'focused' ? '1' : '0' } });
  if (res.error) throw res.error;
  process.stdout.write(res.stdout);
  process.stderr.write(res.stderr);
  const ran = [...res.stdout.matchAll(/^(?:not )?ok \d+ - ([^\r\n]+)$/gm)].map(m => m[1]);
  if (res.signal || /S16_FORBIDDEN_OPERATION|ERR_ACCESS_DENIED/.test(res.stdout + res.stderr) ||
      ran.length !== names.length || names.some(n => !ran.includes(n)) || /# (?:skip|todo|cancelled) [1-9]/i.test(res.stdout)) {
    process.stderr.write('Guard or allowlist verification failed for ' + stem + '\n');
    process.exit(2);
  }
  if (res.status !== 0) process.exit(res.status ?? 2);
}
