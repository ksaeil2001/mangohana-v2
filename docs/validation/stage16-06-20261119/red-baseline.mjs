// Reproduce exactly what is available before S16-06: the S16-02 lock and
// the S16-05 report produced by the original modules in the synthetic fixture.
// Neither output is an execution approval or a final acceptance decision.
import { registerHooks } from 'node:module';

const entry = new URL('../../../tests/v2/stage16-final-acceptance.test.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === entry && specifier === '../../packages/evaluation/stage16-final-acceptance.mjs') {
    return { shortCircuit: true, url: import.meta.url };
  }
  return next(specifier, context);
} });

export const assessStage16Start = input => ({ status: input.lock.status });
export const assessStage16Acceptance = input => ({ status: input.pairedReport.kind });
