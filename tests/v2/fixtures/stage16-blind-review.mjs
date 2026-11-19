import { contentSha256 } from '../../../packages/evaluation/dataset-contract.mjs';
import { collectStage16Observations } from '../../../packages/evaluation/stage16-execution-observations.mjs';
import { addHoldoutPage, experiment, freezeDataset, sha } from './stage16-experiment.mjs';
import { receiptFor, scenario } from './stage16-observations.mjs';

export const readerIds = ['fixture-reader-one', 'fixture-reader-two'];
export const fixtureSeed = sha('reproducible synthetic assignment only');

export function reviewScenario({ seed = fixtureSeed, overlapPageCount = 1, editRoster, editProtocol, editJobs, editReceipts } = {}) {
  const input = experiment();
  addHoldoutPage(input, 'work-other', 'page-other');
  for (const reviewerId of readerIds) {
    input.manifest.reviewers.push({ reviewerId, kind: 'human', languages: ['ja', 'ko'],
      independenceGroup: 'group-' + reviewerId,
      qualificationEvidence: { path: reviewerId + '.unavailable', sha256: sha('qualified-' + reviewerId) } });
  }
  editRoster?.(input.manifest.reviewers);
  freezeDataset(input.manifest);
  input.preregistration.holdout_freeze.manifestSha256 = contentSha256(input.manifest);
  const protocol = { schemaVersion: 1, reviewerIds: [...readerIds], overlapPageCount, seedSha256: contentSha256(seed) };
  editProtocol?.(protocol);
  input.preregistration.blind_randomized_human_review = contentSha256(protocol);
  const { plan, anchors } = scenario({ input });
  editJobs?.(plan.jobs);
  anchors.jobsSha256 = contentSha256(plan.jobs);
  const receipts = plan.jobs.map(job => receiptFor(plan, job));
  editReceipts?.(receipts);
  const observations = collectStage16Observations(plan, receipts, anchors);
  return { input: { lock: plan.lock, matrices: plan.matrices, manifest: input.manifest,
    preregistration: input.preregistration, protocol, observations },
    anchors: { ...anchors, observationsSha256: contentSha256(observations) }, seed };
}
