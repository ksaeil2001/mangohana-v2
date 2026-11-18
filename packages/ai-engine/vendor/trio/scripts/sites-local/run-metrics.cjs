'use strict';
const {performance}=require('node:perf_hooks');
function createRunMetrics({clock=()=>performance.now(),wallClock=()=>Date.now()}={}){
  const started=clock(),startedAt=new Date(wallClock()).toISOString();
  const stages=[];let current={stage:'prepare',startElapsedMs:0};
  const elapsed=()=>Math.max(0,clock()-started);
  return Object.freeze({
    enter(stage){
      if(typeof stage!=='string'||!/^[a-z_]+$/.test(stage))throw new Error('INVALID_MEASUREMENT_STAGE');
      if(stage===current.stage)return;
      const end=elapsed();stages.push({...current,endElapsedMs:end,durationMs:end-current.startElapsedMs});
      current={stage,startElapsedMs:end};
    },
    snapshot(){
      const end=elapsed();return {startedAt,elapsedMs:end,scope:'engine_through_candidate_validation_before_cleanup',
        stages:[...stages.map(stage=>({...stage})),{...current,endElapsedMs:end,durationMs:end-current.startElapsedMs}]};
    },
  });
}
module.exports={createRunMetrics};
