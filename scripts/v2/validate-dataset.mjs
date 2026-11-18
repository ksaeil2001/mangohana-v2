import fs from 'node:fs/promises';
import { verifyDatasetFiles } from '../../packages/evaluation/dataset-contract.mjs';

const args = process.argv.slice(2);
const manifest = args[0];
const includeHoldout = args.includes('--include-holdout');
const outputIndex = args.indexOf('--output');
const output = outputIndex < 0 ? null : args[outputIndex + 1];
try {
  if (!manifest || manifest.startsWith('--') || (outputIndex >= 0 && !output)
    || args.slice(1).some((arg, i) => arg !== '--include-holdout' && arg !== '--output' && args[i] !== '--output')) throw Object.assign(new Error('Usage: node scripts/v2/validate-dataset.mjs MANIFEST [--output NEW_JSON] [--include-holdout]'), { code: 'INVALID_ARGUMENTS' });
  const result = { validation: 'passed', scope: 'OFFLINE_DATASET_ONLY_NOT_PRODUCT_OR_HUMAN_QUALITY', ...await verifyDatasetFiles(manifest, { includeHoldout }) };
  if (output) await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(JSON.stringify({ validation: 'failed', code: e.code ?? 'DATASET_VALIDATION_ERROR', reason: e.message }));
  process.exitCode = 1;
}
