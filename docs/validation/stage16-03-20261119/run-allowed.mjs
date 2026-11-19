// Usage: use the pinned Node executable from test-runs.json, then this file and a suite below.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const folder = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(folder, '../../..');
const guard = path.join(folder, 'metadata-only.mjs');
const focusFile = 'stage16-execution-observations';
const first = [
  'a receipt for the wrong cell is refused before it contributes a completion',
  'replaying a receipt counts one job and one charge',
  'a partial stage cannot complete a page that reports success',
  'an unsettled charge is unknown even when the confirmed subtotal is zero',
];
const focused = [...first,
  'four assigned cells retain recovered, partial, successful and missing jobs and their exact subtotal',
  'the intermediate pin and first executed stage fence the path and preserve cold and warm timings',
  'all locked pages keep four cells and repeated jobs stay separate under the same cell',
  'the saved lock, canonical matrix and independent job register must all match',
  'receipt identities, native provider bindings and evidence cannot move between jobs or stages',
  'missing stages and missing measurements retain specific reasons and an unknown charge',
  'a retry preserves the original failure, while unresolved results or region-only evidence cannot finish a stage',
  'page failure and missing or foreign final artifact evidence override apparent stage success',
  'known zero and exact tiny decimals reconcile with the native Stage15 batch ledger',
  'the four pipeline stages accept bundled restoration and keep the native engine timing scope',
  'a provider timeout, its resolving lookup and uncovered regions remain visible in the history',
  'another request scope or a smaller retry cannot finish the original stage',
  'contradictory evidence cannot certify completion or manufacture a free pre-dispatch cancellation',
  'a confirmed pre-dispatch reservation is free and ambiguous repeated lookups never inflate usage',
  'a copied zero without matching provider settlement evidence cannot enter the confirmed total',
  'distinct model slots cannot use one identical provider version pin, while independently equal results remain separate',
  'moving both journal labels to another registered cell cannot move the saved execution fingerprint',
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
  'offline-evaluation': [
    'shared translation request is counted once and unknown costs stay null',
    'conflicting shared request receipts cannot be silently deduplicated',
    'all withheld yields delivery 0 but unaudited error rate null; retries separate',
    'shared page request proof sums distributed call flags once, without multiplying duration',
    'partial cost observations keep the total null and exclude Codex usage',
  ],
  'stage15-provider-contract': [
    'registry and current input reject non-synthetic, stale, malformed or unsupported values before a call',
    'partial output accounts for all requested regions and stays incomplete',
    'provider success and unconfirmed settlement remain separate from a justified zero',
    'primary and alternate sum exact costs and wall time once per execution, including a replayed receipt',
    'a confirmed subtotal does not erase one unknown execution or an absent duration',
    'an explicit lookup can add cost evidence for the same attempt without re-counting the execution',
    'duplicate evidence identifiers with different facts or attempts cannot be summed',
    'usage totals are confined to one current stage input, even across distinct providers',
    'a changed provider model version alters the pinned evidence input even with the same profile digest',
  ],
};
const suites = { red: { [focusFile]: first }, focused: { [focusFile]: focused }, regression };
const suite = process.argv[2];
if (!Object.hasOwn(suites, suite) || process.argv.length !== 3) throw Error('Expected red, focused or regression');
const escape = name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const [stem, names] of Object.entries(suites[suite])) {
  const file = 'tests/v2/' + stem + '.test.mjs';
  // Only source/installed dependencies and the four required schemas are readable. No write/child/addon grants.
  const sources = [file, 'tests/v2/fixtures/stage16-*.mjs', 'tests/v2/offline-evaluation-fixture.mjs',
    'packages/evaluation/*.mjs', 'packages/evaluation/offline/*.mjs', 'packages/evaluation/policy/*.mjs',
    'packages/evaluation/policy/stage08-v1.1.json', 'packages/evaluation/dataset-v1.schema.json',
    'packages/evaluation/annotation-v1.schema.json', 'packages/contracts/schemas/v2-common-contract-v1.schema.json',
    'packages/contracts/src/*.mjs', 'packages/ai-engine/quality/*.cjs', 'apps/engine/*.mjs',
    'apps/desktop/scripts/evaluate-automation-quality.mjs', 'node_modules', 'package.json', guard];
  const args = ['--permission', ...sources.map(f => '--allow-fs-read=' + path.resolve(root, f)),
    '--import', pathToFileURL(guard).href, '--test-reporter=tap', '--test-name-pattern=^(?:' + names.map(escape).join('|') + ')$',
    path.resolve(root, file)];
  const env = { ...process.env, NODE_OPTIONS: '', NODE_DISABLE_COLORS: '1', NODE_DISABLE_COMPILE_CACHE: '1',
    S16_TEST_NAMES: JSON.stringify(names) };
  const run = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
  if (run.error) throw run.error;
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  const ran = [...run.stdout.matchAll(/^(?:not )?ok \d+ - ([^\r\n]+)$/gm)].map(m => m[1]);
  if (run.status === 91 || /S16_FORBIDDEN_OPERATION/.test(run.stdout + run.stderr) ||
      ran.length !== names.length || names.some(name => !ran.includes(name))) {
    process.stderr.write('Allowlist or guard verification failed for ' + file + '\n');
    process.exit(2);
  }
  if (run.status !== 0) process.exit(run.status ?? 2);
}
