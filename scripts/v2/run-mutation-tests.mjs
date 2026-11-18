import path from 'node:path';
import { runMutationCampaign } from '../../packages/evaluation/mutation/runner.mjs';
const [outputDir,...extra]=process.argv.slice(2);
if(!outputDir || extra.length) {process.stderr.write('Usage: node scripts/v2/run-mutation-tests.mjs NEW_OUTPUT_DIRECTORY\n');process.exitCode=2;}
else {
  const r=await runMutationCampaign({outputDir:path.resolve(outputDir)});
  process.stdout.write(JSON.stringify({cases:r.results.length,byLane:r.summary.byLane,mismatches:r.expectedBehaviorMismatches})+'\n');
}
