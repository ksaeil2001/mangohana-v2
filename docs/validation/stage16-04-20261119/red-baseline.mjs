// Validation-only reproduction: hand a rater the S16-03 rows in matrix order,
// then copy a single preference into both columns and keep only returned forms.
// Only the guarded RED suite redirects the test's import to this module.
import { registerHooks } from 'node:module';
import { contentSha256 } from '../../../packages/evaluation/dataset-contract.mjs';

const focus = new URL('../../../tests/v2/stage16-blind-review.test.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === focus && specifier === '../../packages/evaluation/stage16-blind-review.mjs') {
    return { shortCircuit: true, url: import.meta.url };
  }
  return next(specifier, context);
} });

export function prepareStage16BlindReview({ observations, protocol }) {
  const pairs = [];
  for (let i = 0; i < observations.cells.length; i += 2) {
    const [first, second] = observations.cells.slice(i, i + 2);
    const show = cell => ({ ...cell.condition, ...cell.jobs[0].stages[0].attempts[0].provider,
      ref: cell.jobs[0].resultSha256 });
    pairs.push({ pageId: first.pageId, model: first.condition.model,
      assignments: protocol.reviewerIds.map(reviewerId => ({
        reviewerId, assignmentId: reviewerId + ':' + i, A: show(first), B: show(second),
      })) });
  }
  const seal = { pairs };
  return { seal, sealSha256: contentSha256(seal) };
}

export function stage16ReviewerPacket(seal, _anchor, reviewerId) {
  return { items: seal.pairs.flatMap(p => p.assignments).filter(a => a.reviewerId === reviewerId) };
}

export function collectStage16BlindReturns(seal, _anchor, envelopes) {
  const submissions = envelopes.flatMap(e => e.responses);
  return { pairs: seal.pairs.map(p => ({ assignments: p.assignments.flatMap(a => {
    const response = submissions.find(r => r.assignmentId === a.assignmentId);
    if (!response) return [];
    const preference = a[response.semanticFidelity].processing;
    return [{ assignmentId: a.assignmentId, semanticFidelity: { preference }, naturalness: { preference } }];
  }) })) };
}
