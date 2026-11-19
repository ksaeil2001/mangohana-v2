import test from 'node:test';
import assert from 'node:assert/strict';
import {contentSha256 as hash} from '../../packages/evaluation/dataset-contract.mjs';
const api=await import('../../packages/evaluation/stage18-operations.mjs').catch(error=>{
  if(error.code!=='ERR_MODULE_NOT_FOUND'||!error.message.includes('stage18-operations.mjs'))throw error;
  return {};
});
const baseline=hash('last accepted'),candidate=hash('edited version');
function change(){
  const record={scope:'synthetic',goal:{outcome:'preserve text',stopWhen:'one candidate assessed'},
    baselineSha256:baseline,candidateSha256:candidate,sourceWork:{id:'work-1',sha256:hash('original'),regionIds:['r1']},
    observation:'text missing',firstWrongStage:'OCR',hypothesis:'mapping lost a line',fixedStage:'OCR',
    files:[{path:'mapping.mjs',beforeSha256:hash('old'),afterSha256:hash('new')}],beforeImageSha256:null,afterImageSha256:null,
    checks:['red','targeted','newWork','regression'].map((id,index)=>({id,command:id+' command',logSha256:hash(id),
      candidateSha256:index?candidate:baseline,status:index?'PASS':'FAIL',exitCode:index?0:1,scope:'synthetic',
      ...(id==='newWork'?{workId:'work-2',sourceSha256:hash('unseen')}:{} )})),
    axes:{source:'PASS',actualAI:'NOT_RUN',browser:'NOT_RUN',human:'NOT_RUN'},
    priorCandidates:[],newKnowledge:true,budgetState:'within',review:'settled',unverified:['original artwork'],
    problem:{id:'line',severity:'P0',attempts:[],previousEscalations:0},handoff:{question:'Check the first missing line',diff:'mapping diff',evidence:['test log']}};
  return record;
}
const assess=r=>api.reviewChange(r,{baselineSha256:baseline,recordSha256:hash(r)});
test('a single pinned synthetic change rehearses adoption in order and reports the independent evidence axes',()=>{
  const r=change(),before=structuredClone(r),out=assess(r);
  assert.equal(out.decision,'REHEARSAL_ADOPT');assert.equal(out.retainedSha256,baseline);
  assert.deepEqual(out.axes,r.axes);assert.deepEqual(r,before);
  assert.deepEqual(out.handoff,r.handoff);assert.equal(out.actualSavingsUsd,null);
});
test('missing or unsuitable new work, stale versions, reordered checks and a missing stop condition keep the best version',()=>{
  for(const mutate of [r=>r.checks.splice(2,1),r=>r.checks[2].workId='work-1',r=>r.checks[2].sourceSha256=r.sourceWork.sha256,
    r=>r.checks.reverse(),r=>r.goal.stopWhen='',r=>r.checks[1].candidateSha256=baseline,r=>r.files=[],
    r=>r.checks[0].exitCode=0,r=>r.checks[1].exitCode=1,r=>r.scope='actual']){
    const r=change();mutate(r);const out=assess(r);assert.equal(out.decision,'HOLD');assert.equal(out.retainedSha256,baseline);
  }
  const r=change();assert.equal(api.reviewChange(r,{baselineSha256:baseline,recordSha256:hash('other')}).decision,'HOLD');
});
test('a known failed candidate rolls back, and bounded stop reasons keep the last accepted reference',()=>{
  const failed=change();Object.assign(failed.checks[3],{status:'FAIL',exitCode:1});
  assert.equal(assess(failed).decision,'ROLLBACK');
  for(const [key,value] of [['newKnowledge',false],['budgetState','exhausted'],['budgetState','unknown'],['review','uncertain'],['priorCandidates',[candidate]]]){
    const r=change();r[key]=value;assert.equal(assess(r).decision,'HOLD');assert.equal(assess(r).retainedSha256,baseline);
  }
});
test('only distinct evidenced failures of the same P0 suggest one escalation and no call is started',()=>{
  const r=change(),failure=id=>({problemId:'line',candidateSha256:hash(id),outcome:'FAIL',evidenceSha256:hash(id+' log')});
  r.problem.attempts=[failure('a'),failure('a')];assert.equal(assess(r).escalationEligible,false);
  r.problem.attempts[1]=failure('b');assert.equal(assess(r).escalationEligible,true);
  r.problem.previousEscalations=1;assert.equal(assess(r).escalationEligible,false);
});
function arm(version,suffix){
  return {scope:'synthetic',kind:'agent',experimentId:'x',workloadSha256:hash('fixed inputs and protocol'),candidateSha256:version,
    planned:[{unitId:'page-1',id:'one'+suffix},{unitId:'page-2',id:'two'+suffix}],
    receipts:[{id:'one'+suffix,model:'A',role:'main',tokens:20,elapsedMs:12,currency:'USD',amount:'0.1',sha256:hash('one'+suffix)},
      {id:'two'+suffix,model:'A',role:'verifier',tokens:5,elapsedMs:6,currency:'USD',amount:'0.2',sha256:hash('two'+suffix)}]};
}
test('one measured population has separate model and role breakdowns without double counting or float drift',()=>{
  const a=arm(baseline,'-a');a.receipts.push({...a.receipts[0]});
  const out=api.summarizeUsage(a);
  assert.equal(out.total.tokens,25);assert.equal(out.total.elapsedMs,18);assert.equal(out.total.amountUsd,'0.3');
  assert.equal(out.byModel.A.tokens,25);assert.equal(out.byRole.main.tokens,20);assert.equal(out.byRole.verifier.tokens,5);
  assert.equal(out.total.receipts,2);
});
test('partial, conflicting and foreign receipts retain known subtotals and never imply a free missing run',()=>{
  const a=arm(baseline,'-a');a.receipts[1].amount=null;a.receipts[1].tokens=null;
  let r=api.summarizeUsage(a);assert.equal(r.total.amountUsd,null);assert.equal(r.total.confirmedSubtotalUsd,'0.1');
  assert.equal(r.total.tokens,null);assert.deepEqual(r.unsettledIds,['two-a']);
  a.receipts.pop();r=api.summarizeUsage(a);assert.equal(r.total.amountUsd,null);assert.deepEqual(r.missingIds,['two-a']);
  a.receipts.push({...a.receipts[0],amount:'9'});assert.throws(()=>api.summarizeUsage(a),/conflict/i);
  a.receipts.pop();a.receipts.push({...a.receipts[0],id:'foreign'});assert.throws(()=>api.summarizeUsage(a),/unplanned/i);
});
test('paired savings require the same experiment and work, complete receipts and distinct executions',()=>{
  const a=arm(baseline,'-a'),b=arm(candidate,'-b');b.receipts[0].amount='0.03';b.receipts[1].amount='0.22';
  let r=api.compareUsage(a,b);assert.equal(r.savingsUsd,'0.05');assert.equal(r.actualSavingsUsd,null);assert.equal(r.tokenDifference,0);
  b.receipts[1].amount='0.32';assert.equal(api.compareUsage(a,b).savingsUsd,'-0.05');
  b.receipts[1].currency='EUR';assert.equal(api.compareUsage(a,b).savingsUsd,null);
  for(const mutate of [x=>x.experimentId='y',x=>x.workloadSha256=hash('different work'),x=>x.planned[0].unitId='page-3',x=>x.kind='product',x=>x.scope='actual',
    x=>{x.planned[0].id=a.planned[0].id;x.receipts[0].id=a.planned[0].id;}]){
    const x=arm(candidate,'-b');mutate(x);assert.equal(api.compareUsage(a,x).comparable,false);
  }
});
test('weekly usage selects the same seven-day population for both views and preserves missing work',()=>{
  const a=arm(baseline,'-a'),start='2026-11-16T00:00:00+09:00';
  a.planned[0].at=start;a.planned[1].at='2026-11-23T00:00:00+09:00';
  a.receipts.forEach((r,i)=>r.at=a.planned[i].at);
  const r=api.weeklyUsage(a,start);assert.equal(r.total.tokens,20);assert.equal(r.byModel.A.tokens,20);
  assert.equal(r.byRole.verifier,undefined);
  a.receipts.shift();const missing=api.weeklyUsage(a,start);assert.equal(missing.total.amountUsd,null);assert.deepEqual(missing.missingIds,['one-a']);
  delete a.planned[0].at;assert.throws(()=>api.weeklyUsage(a,start),/time/i);
});
test('actual savings need separate operator pins for both arms and equal successful completion',()=>{
  const a=arm(baseline,'-a'),b=arm(candidate,'-b');a.scope=b.scope='actual';
  for(const r of [...a.receipts,...b.receipts])r.outcome='succeeded';b.receipts[1].amount='0.05';
  const pins={baselineSha256:hash(a),candidateSha256:hash(b)};
  assert.equal(api.compareUsage(a,b).actualSavingsUsd,null);
  assert.equal(api.compareUsage(a,b,pins).actualSavingsUsd,'0.15');
  b.receipts[0].outcome='failed';pins.candidateSha256=hash(b);assert.equal(api.compareUsage(a,b,pins).actualSavingsUsd,null);
});
test('the same provider receipt cannot be re-labelled as two measured executions or both arms',()=>{
  const a=arm(baseline,'-a'),b=arm(candidate,'-b');
  b.receipts[1].sha256=b.receipts[0].sha256;assert.throws(()=>api.summarizeUsage(b),/receipt/i);
  b.receipts[1].sha256=hash('two-b');b.receipts[0].sha256=a.receipts[0].sha256;
  assert.equal(api.compareUsage(a,b).comparable,false);
});
test('a change records measured zero separately from missing measurements and requires independent new-work evidence for actual adoption',()=>{
  const r=change();r.measurements={before:{elapsedMs:20,tokens:0,amountUsd:null},after:{elapsedMs:12,tokens:null,amountUsd:'0'}};
  assert.deepEqual(assess(r).measurements,r.measurements);
  r.scope='actual';r.checks[2].scope='actual';assert.equal(assess(r).decision,'HOLD');
  r.checks[2].independenceEvidenceSha256=hash('separate work history');assert.equal(assess(r).decision,'ADOPT');
  r.measurements.before.tokens=-4;assert.equal(assess(r).decision,'HOLD');
});
test('a partially settled job keeps its confirmed subtotal and an inconsistent final receipt is rejected',()=>{
  const a=arm(baseline,'-a');Object.assign(a.receipts[1],{amount:null,confirmedSubtotalUsd:'0.04'});
  const r=api.summarizeUsage(a);assert.equal(r.total.confirmedSubtotalUsd,'0.14');assert.equal(r.total.amountUsd,null);
  a.receipts[1].amount='0.2';assert.throws(()=>api.summarizeUsage(a),/subtotal/i);
});
