import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {createRunMetrics}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/run-metrics.cjs');

test('records measured stage time rather than the configured deadline',()=>{
  let elapsed=100;
  const metrics=createRunMetrics({clock:()=>elapsed,wallClock:()=>0});
  elapsed=110;metrics.enter('ocr');
  elapsed=130;metrics.enter('translate');
  elapsed=145;
  const result=metrics.snapshot();
  assert.equal(result.elapsedMs,45);
  assert.deepEqual(result.stages.map(({stage,durationMs})=>({stage,durationMs})),[
    {stage:'prepare',durationMs:10},{stage:'ocr',durationMs:20},{stage:'translate',durationMs:15},
  ]);
  assert.equal(result.startedAt,'1970-01-01T00:00:00.000Z');
});
test('repeated progress does not restart a stage or mutate earlier snapshots',()=>{
  let elapsed=0;const metrics=createRunMetrics({clock:()=>elapsed,wallClock:()=>0});
  elapsed=5;metrics.enter('ocr');elapsed=10;const before=metrics.snapshot();
  elapsed=20;metrics.enter('ocr');elapsed=30;const after=metrics.snapshot();
  assert.equal(before.stages.at(-1).durationMs,5);
  assert.equal(after.stages.at(-1).durationMs,25);
});
