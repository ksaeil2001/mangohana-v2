import {contentSha256} from './dataset-contract.mjs';
import {digest} from './offline/contract.mjs';
import {formatUsd,usdUnits} from '../../apps/engine/stage15-batch-accounting.mjs';

const text=v=>typeof v==='string'&&v.trim().length>0;
const scopeOk=v=>v==='actual'||v==='synthetic';
const axes=['source','actualAI','browser','human'];
const statuses=new Set(['PASS','FAIL','NEEDS_REVIEW','NOT_RUN']);
const steps=['red','targeted','newWork','regression'];
const knownNumber=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
function readMeasurements(input) {
  const missing={elapsedMs:null,tokens:null,amountUsd:null};
  const result={};
  for(const side of ['before','after']){
    const value=input?.[side]??missing;
    if(!(value.elapsedMs===null||knownNumber(value.elapsedMs))||
      !(value.tokens===null||Number.isSafeInteger(value.tokens)&&value.tokens>=0)||
      !(value.amountUsd===null||typeof value.amountUsd==='string'&&/^(0|[1-9]\d{0,15})(\.\d{1,12})?$/.test(value.amountUsd)))return null;
    result[side]={elapsedMs:value.elapsedMs,tokens:value.tokens,amountUsd:value.amountUsd};
  }
  return result;
}

function escalationEligible(problem) {
  if(!text(problem?.id)||problem.previousEscalations!==0)return false;
  if(['structural','data_loss','security','conflicting_causes'].includes(problem.reason)&&digest(problem.evidenceSha256))return true;
  if(problem.severity!=='P0'||!Array.isArray(problem.attempts))return false;
  const failures=problem.attempts.filter(a=>a?.problemId===problem.id&&a.outcome==='FAIL'&&digest(a.candidateSha256)&&digest(a.evidenceSha256));
  return new Set(failures.map(a=>a.candidateSha256)).size>=2&&new Set(failures.map(a=>a.evidenceSha256)).size>=2;
}

/** Decide what to retain. This offline review performs no retry, delegation, deployment or file replacement. */
export function reviewChange(record={},pins={}) {
  const reasons=[],baseline=digest(pins.baselineSha256)?pins.baselineSha256:null;
  const bound=baseline!==null&&record.baselineSha256===baseline&&digest(record.candidateSha256)&&
    record.candidateSha256!==baseline&&contentSha256(record)===pins.recordSha256;
  if(!bound)reasons.push('UNBOUND_CHANGE');
  if(!scopeOk(record.scope)||!text(record.goal?.outcome)||!text(record.goal?.stopWhen)||
    ![record.observation,record.firstWrongStage,record.hypothesis,record.fixedStage].every(text))reasons.push('DIAGNOSIS_OR_GOAL_REQUIRED');
  if(!text(record.sourceWork?.id)||!digest(record.sourceWork.sha256)||!Array.isArray(record.sourceWork.regionIds)||
    !record.sourceWork.regionIds.every(text)||!Array.isArray(record.files)||!record.files.length||
    !record.files.every(f=>text(f?.path)&&(f.beforeSha256===null||digest(f.beforeSha256))&&(f.afterSha256===null||digest(f.afterSha256))&&f.beforeSha256!==f.afterSha256))reasons.push('CHANGE_EVIDENCE_REQUIRED');
  if(!['beforeImageSha256','afterImageSha256'].every(k=>record[k]===null||digest(record[k]))||!Array.isArray(record.unverified))reasons.push('EVIDENCE_LIMITS_REQUIRED');
  const measurements=readMeasurements(record.measurements);
  if(!measurements)reasons.push('INVALID_MEASUREMENTS');
  const reportedAxes=Object.fromEntries(axes.map(k=>[k,statuses.has(record.axes?.[k])?record.axes[k]:'NOT_RUN']));
  if(axes.some(k=>!statuses.has(record.axes?.[k]))||reportedAxes.source!=='PASS'||
    Object.values(reportedAxes).some(s=>s==='FAIL'||s==='NEEDS_REVIEW'))reasons.push('EVIDENCE_AXIS_UNRESOLVED');
  if(record.newKnowledge!==true)reasons.push('NO_NEW_KNOWLEDGE');
  if(record.budgetState!=='within')reasons.push('BUDGET_UNAVAILABLE');
  if(record.review!=='settled')reasons.push('REVIEW_UNCERTAIN');
  if(!Array.isArray(record.priorCandidates)||record.priorCandidates.includes(record.candidateSha256))reasons.push('CANDIDATE_HISTORY_UNRESOLVED');
  const checks=Array.isArray(record.checks)?record.checks:[];
  let failed=false;
  if(checks.length!==steps.length)reasons.push('INCOMPLETE_CHECK_SEQUENCE');
  for(const [i,id] of steps.entries()){
    const c=checks[i],reference=i===0?baseline:record.candidateSha256;
    if(c?.id!==id||!scopeOk(c.scope)||c.candidateSha256!==reference||!text(c.command)||!digest(c.logSha256)){
      reasons.push('MISSING_OR_STALE_'+id.toUpperCase());continue;
    }
    if(id==='newWork'&&(!text(c.workId)||c.workId===record.sourceWork?.id||!digest(c.sourceSha256)||
      c.sourceSha256===record.sourceWork?.sha256||c.scope!==record.scope||
      (record.scope==='actual'&&!digest(c.independenceEvidenceSha256)))){
      reasons.push('NEW_WORK_REQUIRED');continue;
    }
    const observedFailure=c.status==='FAIL'&&Number.isSafeInteger(c.exitCode)&&c.exitCode>0;
    if(i===0?!observedFailure:c.status!=='PASS'||c.exitCode!==0)reasons.push('EXPECTED_RESULT_MISSING_'+id.toUpperCase());
    if(i>0&&observedFailure)failed=true;
  }
  const handoff=record.handoff;
  const compact=handoff&&text(handoff.question)&&text(handoff.diff)&&Array.isArray(handoff.evidence)&&handoff.evidence.length&&handoff.evidence.every(text)
    ?{question:handoff.question,diff:handoff.diff,evidence:[...handoff.evidence],...(text(handoff.crop)?{crop:handoff.crop}:{})}:null;
  if(!compact)reasons.push('HANDOFF_REQUIRED');
  const decision=bound&&failed?'ROLLBACK':reasons.length?'HOLD':record.scope==='synthetic'?'REHEARSAL_ADOPT':'ADOPT';
  return {scope:record.scope??null,decision,reasons,retainedSha256:decision==='ADOPT'?record.candidateSha256:baseline,
    axes:reportedAxes,unverified:record.unverified??null,escalationEligible:bound&&escalationEligible(record.problem),
    handoff:compact,measurements,actualSavingsUsd:null};
}

function validatePlan(arm) {
  if(!scopeOk(arm?.scope)||!['agent','product'].includes(arm.kind)||!text(arm.experimentId)||!digest(arm.workloadSha256)||
    !digest(arm.candidateSha256)||!Array.isArray(arm.planned)||!arm.planned.length||!Array.isArray(arm.receipts))throw Error('A scoped planned population is required');
  const ids=new Set(),units=new Set();
  for(const p of arm.planned){
    if(!text(p?.id)||!text(p.unitId)||ids.has(p.id)||units.has(p.unitId))throw Error('Missing or duplicate planned unit');
    ids.add(p.id);units.add(p.unitId);
  }
  return ids;
}
function ledger(arm) {
  const ids=validatePlan(arm), rows=new Map(), byReceipt=new Map();
  for(const r of arm.receipts){
    if(!ids.has(r?.id))throw Error('Unplanned receipt');
    if(!digest(r.sha256)||!text(r.model)||!text(r.role)||!(r.tokens==null||Number.isSafeInteger(r.tokens)&&r.tokens>=0)||
      !(r.elapsedMs==null||knownNumber(r.elapsedMs))||!(r.amount==null||text(r.currency)&&text(r.amount)))throw Error('Invalid measured receipt');
    if(r.currency==='USD'&&r.amount!=null)usdUnits(r.amount);
    if(r.confirmedSubtotalUsd!=null&&(r.currency!=='USD'||(r.amount!=null&&usdUnits(r.amount)!==usdUnits(r.confirmedSubtotalUsd))))throw Error('Invalid confirmed subtotal');
    if(r.confirmedSubtotalUsd!=null)usdUnits(r.confirmedSubtotalUsd);
    if(rows.has(r.id)&&contentSha256(rows.get(r.id))!==contentSha256(r))throw Error('Conflicting receipt for '+r.id);
    if(byReceipt.has(r.sha256)&&byReceipt.get(r.sha256)!==r.id)throw Error('Receipt already belongs to another execution');
    byReceipt.set(r.sha256,r.id);
    rows.set(r.id,r);
  }
  return rows;
}
const settled=r=>r?.currency==='USD'&&r.amount!=null;
function summarize(rows) {
  let units=0n,tokens=0n,elapsed=0;
  for(const row of rows){
    if(settled(row))units+=usdUnits(row.amount);
    else if(row?.confirmedSubtotalUsd!=null)units+=usdUnits(row.confirmedSubtotalUsd);
    if(row?.tokens!=null)tokens+=BigInt(row.tokens);
    if(row?.elapsedMs!=null)elapsed+=row.elapsedMs;
  }
  const covered=rows.length>0, subtotal=formatUsd(units);
  return {planned:rows.length,receipts:rows.filter(Boolean).length,confirmedSubtotalUsd:subtotal,
    amountUsd:covered&&rows.every(settled)?subtotal:null,
    tokens:covered&&rows.every(r=>r?.tokens!=null)&&tokens<=BigInt(Number.MAX_SAFE_INTEGER)?Number(tokens):null,
    elapsedMs:covered&&rows.every(r=>r?.elapsedMs!=null)&&Number.isFinite(elapsed)?elapsed:null};
}
function group(rows,field) {
  const groups=new Map();
  for(const row of rows){
    if(!row)continue;
    const key=row[field];if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
  }
  return Object.fromEntries([...groups].map(([k,v])=>[k,summarize(v)]));
}
function population(arm,rows) {
  const all=arm.planned.map(p=>rows.get(p.id));
  return {scope:arm.scope,kind:arm.kind,total:summarize(all),byModel:group(all,'model'),byRole:group(all,'role'),
    missingIds:arm.planned.filter(p=>!rows.has(p.id)).map(p=>p.id),
    unsettledIds:arm.planned.filter(p=>!settled(rows.get(p.id))).map(p=>p.id)};
}
export function summarizeUsage(arm) {return population(arm,ledger(arm));}

function instant(value) {
  if(!text(value)||!/(Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error('An explicit timestamp with time zone is required');
  return Date.parse(value);
}
export function weeklyUsage(arm,start) {
  const rows=ledger(arm),from=instant(start),until=from+7*86400000;
  const planned=arm.planned.filter(p=>{
    const at=instant(p.at),r=rows.get(p.id);
    if(r&&instant(r.at)!==at)throw Error('Receipt time differs from its planned population');
    return at>=from&&at<until;
  });
  return {from:new Date(from).toISOString(),until:new Date(until).toISOString(),...population({...arm,planned},rows)};
}
const signedUsd=n=>n<0n?'-'+formatUsd(-n):formatUsd(n);
export function compareUsage(before,after,pins={}) {
  const a=ledger(before),b=ledger(after),baseline=population(before,a),candidate=population(after,b);
  const units=arm=>arm.planned.map(p=>p.unitId).sort();
  const ids=new Set(before.planned.map(p=>p.id));
  const priorReceipts=new Set([...a.values()].map(r=>r.sha256));
  const comparable=before.scope===after.scope&&before.kind===after.kind&&before.experimentId===after.experimentId&&
    before.workloadSha256===after.workloadSha256&&before.candidateSha256!==after.candidateSha256&&
    contentSha256(units(before))===contentSha256(units(after))&&after.planned.every(p=>!ids.has(p.id))&&
    [...b.values()].every(r=>!priorReceipts.has(r.sha256));
  const x=baseline.total,y=candidate.total;
  const amount=rows=>[...rows.values()].reduce((sum,r)=>sum+usdUnits(r.amount),0n);
  const savingsUsd=comparable&&x.amountUsd!==null&&y.amountUsd!==null?signedUsd(amount(a)-amount(b)):null;
  const verified=before.scope==='actual'&&contentSha256(before)===pins.baselineSha256&&contentSha256(after)===pins.candidateSha256&&
    [...a.values(),...b.values()].every(r=>r.outcome==='succeeded');
  return {comparable,scope:before.scope,baseline,candidate,savingsUsd,actualSavingsUsd:verified?savingsUsd:null,
    tokenDifference:comparable&&x.tokens!==null&&y.tokens!==null?x.tokens-y.tokens:null,
    elapsedDifferenceMs:comparable&&x.elapsedMs!==null&&y.elapsedMs!==null?x.elapsedMs-y.elapsedMs:null};
}
