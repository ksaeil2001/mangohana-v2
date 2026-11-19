// Invoke with the Node executable recorded in test-runs.json and one of the named suites below.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const guard = new URL('../stage16-03-20261119/metadata-only.mjs', import.meta.url);
const baseline = new URL('red-baseline.mjs', import.meta.url);
const focusFile = 'stage16-blind-review';
const first = [
  'model identities stay out of reviewer material',
  'version identifiers stay out of reviewer material',
  'processing conditions stay out of reviewer material',
  'A does not always show the baseline to the same reviewer',
  'one reviewer cannot supply both independent assignments',
  'opposite fidelity and naturalness choices are recovered separately',
  'every planned assignment survives a completely empty return',
];
const returnContract = [
  'a reviewer can return the displayed item and a swapped or foreign reference cannot be decoded',
  'an explicitly blank returned form and an omitted axis remain unscored when other forms are answered',
  'an unattributed envelope cannot borrow its reviewer or evidence kind through a prototype',
];
const focused = [...first,
  'both packets contain only the two questions and unique opaque tickets bound to frozen sources and final results',
  'the same secret replays the sealed schedule and different committed secrets change actual A/B positions',
  'old lock, observation, manifest, protocol, job and secret commitments reject substitutions',
  'foreign observations, missing cells and duplicate model conditions cannot replace frozen pairs',
  'an overlap requires two qualified bilingual people in distinct Stage05 groups',
  'unavailable and ambiguous cell results keep their planned slots and cannot be rated',
  'neither stale seals nor foreign reviewer tickets can supply a return',
  'partial answers merge once while conflicting choices, combined scores and provenance switches are refused',
  'the hand-counted overlap retains disagreement, tie, partial, unanswered and unavailable assignments',
  ...returnContract,
  'equal finished bytes keep separate blinded alternatives and equal repeated jobs do not add ballots',
  'a cohort without any execution receipts still has four planned pairs and no issued forms',
];
const regression = {
  'stage16-condition-matrix': [
    'reordering equivalent JSON does not change its matrix fingerprint',
    'the work, page, every shared pin and each axis pin bind the matrix identity',
    'explicitly planning the full path has a distinct identity from fixed intermediate input',
  ],
  'stage16-experiment-lock': [
    'independent evidence and frozen criteria issue a reproducible lock for the exact cohort',
    'a conflict on the second sample blocks the whole experiment',
    'one comparison cannot mix processing or shared settings between pages',
    'foreign work, source, or sealed ground truth cannot be substituted even with a valid matrix fingerprint',
  ],
  'stage16-execution-observations': [
    'four assigned cells retain recovered, partial, successful and missing jobs and their exact subtotal',
    'all locked pages keep four cells and repeated jobs stay separate under the same cell',
    'the saved lock, canonical matrix and independent job register must all match',
    'missing stages and missing measurements retain specific reasons and an unknown charge',
    'page failure and missing or foreign final artifact evidence override apparent stage success',
    'distinct model slots cannot use one identical provider version pin, while independently equal results remain separate',
    'moving both journal labels to another registered cell cannot move the saved execution fingerprint',
  ],
  'evaluation-dataset': [
    'AI reviewers cannot satisfy the human review requirement',
    'human approval requires independent bilingual reviewers, evidence and timestamp',
    'reviewed content changes invalidate the existing approval hashes',
    'open disagreements prohibit verified GT even with two approvals',
    'qualifying synthetic human submissions are distinct from actual obtained GT',
    'approved disagreement history cannot be deleted while retaining the old human approval',
  ],
  'quality-policy': [
    'self QA or AI review cannot attest the current human semantic requirement',
    'one-person partial review cannot satisfy Stage05 human_verified',
    'zero denominator, absent GT, and partial observation remain explicit unknown states',
  ],
};

const suites = { red: { [focusFile]: first }, returns: { [focusFile]: returnContract }, focused: { [focusFile]: focused }, regression };
const suite = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(suites, suite)) throw Error('Expected red, returns, focused or regression');
const commonSources = [
  'tests/v2/fixtures/stage16-blind-review.mjs', 'tests/v2/fixtures/stage16-experiment.mjs',
  'tests/v2/fixtures/stage16-observations.mjs', 'packages/evaluation/stage16-blind-review.mjs',
  'packages/evaluation/stage16-condition-matrix.mjs', 'packages/evaluation/stage16-experiment-lock.mjs',
  'packages/evaluation/stage16-execution-observations.mjs', 'packages/evaluation/dataset-contract.mjs',
  'packages/evaluation/image-fingerprint.mjs', 'packages/evaluation/dataset-v1.schema.json',
  'packages/evaluation/annotation-v1.schema.json', 'packages/evaluation/policy/policy.mjs',
  'packages/evaluation/policy/stage08-v1.1.json', 'packages/evaluation/offline/*.mjs',
  'packages/contracts/src/v2-common-contract.mjs', 'packages/contracts/schemas/v2-common-contract-v1.schema.json',
  'apps/desktop/scripts/evaluate-automation-quality.mjs', 'apps/engine/stage15-provider-adapter.mjs',
  'apps/engine/stage15-batch-accounting.mjs', 'apps/engine/store.mjs', 'apps/engine/result.mjs',
  ...['human-translation-review','recovery-checkpoint','recovery-policy','stage15-quality-decision','stage15-stage-graph']
    .map(stem => 'packages/ai-engine/quality/' + stem + '.cjs'),
  'node_modules', 'package.json', fileURLToPath(guard),
];
for (const [stem, names] of Object.entries(suites[suite])) {
  const file = path.resolve(root, 'tests/v2/' + stem + '.test.mjs');
  const sources = [...commonSources, file];
  const imports = [guard];
  if (suite === 'red') { imports.push(baseline); sources.push(fileURLToPath(baseline)); }
  const pattern = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const args = ['--permission', ...sources.map(f => '--allow-fs-read=' + path.resolve(root, f)),
    ...imports.flatMap(url => ['--import', pathToFileURL(fileURLToPath(url)).href]), '--test-reporter=tap',
    '--test-name-pattern=^(?:' + pattern + ')$', file];
  const result = spawnSync(process.execPath, args, { cwd: root, windowsHide: true, encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', NODE_DISABLE_COMPILE_CACHE: '1', NODE_DISABLE_COLORS: '1',
      S16_TEST_NAMES: JSON.stringify(names), S16_CAPTURE_BLIND_SAMPLE: suite === 'focused' ? '1' : '0' } });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const ran = [...result.stdout.matchAll(/^(?:not )?ok \d+ - ([^\r\n]+)$/gm)].map(match => match[1]);
  if (result.signal || /S16_FORBIDDEN_OPERATION|ERR_ACCESS_DENIED/.test(result.stdout + result.stderr) ||
      ran.length !== names.length || names.some(name => !ran.includes(name)) || /# (?:skip|todo|cancelled) [1-9]/i.test(result.stdout)) {
    process.stderr.write('Guard or allowlist verification failed for ' + stem + '\n');
    process.exit(2);
  }
  if (result.status !== 0) process.exit(result.status ?? 2);
}
