import { readFileSync } from 'node:fs';
import { createConditionMatrix } from '../../packages/evaluation/stage16-condition-matrix.mjs';
import { requireValue } from '../../packages/evaluation/offline/contract.mjs';

try {
  requireValue(process.argv.length === 2, 'INVALID_ARGUMENTS');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  console.log(JSON.stringify(createConditionMatrix(input)));
} catch (error) {
  const code = error instanceof SyntaxError ? 'INVALID_JSON' : error.code ?? 'STAGE16_MATRIX_ERROR';
  console.error(JSON.stringify({ code }));
  process.exitCode = 1;
}
