import assert from 'node:assert/strict';
import { ratio } from '../offline/contract.mjs';

export function classifyMutation({ truth, decision }) {
  assert.ok(['normal','defect','unknown'].includes(truth), 'Unknown oracle truth');
  assert.ok(['error','pass','review','unmeasured','unsupported'].includes(decision), 'Unknown detector decision');
  if (decision === 'review') return 'NEEDS_REVIEW';
  if (decision === 'unmeasured' || truth === 'unknown') return 'NOT_MEASURABLE';
  if (decision === 'unsupported') return 'UNSUPPORTED_DETECTOR';
  return truth === 'defect' ? decision === 'error' ? 'DETECTED' : 'MISSED'
    : decision === 'error' ? 'FALSE_ALARM' : 'CORRECT_PASS';
}

/** Only independent synthetic oracles with binary detector decisions enter TP/FP/FN/TN. */
export function summarizeMutations(rows) {
  const oracle = rows.filter(r => r.independentOracle && ['normal','defect'].includes(r.truth));
  const binaryRows = oracle.filter(r => ['error','pass'].includes(r.decision));
  const n = (truth, decision) => binaryRows.filter(r => r.truth === truth && r.decision === decision).length;
  const TP=n('defect','error'), FP=n('normal','error'), FN=n('defect','pass'), TN=n('normal','pass');
  const defects=oracle.filter(r=>r.truth==='defect');
  const rate=(a,b)=>ratio(a,b,'NO_APPLICABLE_DENOMINATOR');
  return { totalCases:rows.length, independentOracleCases:oracle.length,
    classifications:rows.reduce((m,r)=>{const c=classifyMutation(r);m[c]=(m[c]??0)+1;return m;},{}),
    binary:{TP,FP,FN,TN,cases:binaryRows.length}, excludedFromBinary:rows.filter(r=>!binaryRows.includes(r)).map(r=>({mutationId:r.mutationId??null,decision:r.decision,reason:r.reason??'NO_BINARY_INDEPENDENT_ORACLE'})),
    recall:rate(TP,TP+FN), precision:rate(TP,TP+FP), falsePositiveRate:rate(FP,FP+TN),
    falseAcceptRate:rate(FN,FN+TN), defectEscapeRate:rate(FN,TP+FN),
    reviewHoldRate:rate(rows.filter(r=>r.decision==='review').length,rows.length),
    measurableCaseRate:rate(binaryRows.length,rows.length),
    allOracleDefectDetectionCoverage:rate(defects.filter(r=>r.decision==='error').length,defects.length),
    scope:'ISOLATED_SYNTHETIC_CASES_ONLY_NOT_REAL_MANGA_GENERALIZATION' };
}

export function summarizeByLane(rows) {
  return Object.fromEntries([...new Set(rows.map(r=>r.lane))].sort().map(lane=>[lane,summarizeMutations(rows.filter(r=>r.lane===lane))]));
}
