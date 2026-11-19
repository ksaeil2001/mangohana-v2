// Counterexample used only by the RED runner. Represents the three naive reductions
// on real S16-04-shaped synthetic returns. It is never a fallback in the report.
import { registerHooks } from 'node:module';

const test = new URL('../../../tests/v2/stage16-paired-report.test.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === test && specifier === '../../packages/evaluation/stage16-paired-report.mjs') {
    return { shortCircuit: true, url: import.meta.url };
  }
  return next(specifier, context);
} });

export function buildStage16PairedReport({ review }) {
  const models = {};
  for (const model of ['A', 'B']) {
    const pairs = review.pairs.filter(p => p.model === model);
    const observed = pairs.map(p => p.assignments[0].semanticFidelity.preference).filter(p => p !== null);
    const improved = observed.filter(p => p === 'improved').length;
    models[model] = { axes: { semanticFidelity: {
      uncertainty: { workCount: pairs.length },
      confirmedImprovedShare: { numerator: improved, denominator: observed.length, value: improved / observed.length },
      counts: { tie: 0, improved: observed.filter(p => p !== 'baseline').length },
    } } };
  }
  return { models };
}
