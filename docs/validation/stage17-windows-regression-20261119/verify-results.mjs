import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const directory=fileURLToPath(new URL('.',import.meta.url)),repo=path.resolve(directory,'../../..');
const data=p=>JSON.parse(fs.readFileSync(path.join(directory,p),'utf8').replace(/^\uFEFF/,''));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const tracedBaseline=data('verified-full/sources.json'),baseline=data('plain-full/sources.json');
const previousTypesetting=data('final-five/joined-v2.json').typesetting;
const keys=Object.keys(baseline).filter(p=>/^(apps|packages|tests|scripts)[\\/]/.test(p));
const unchanged=keys.every(p=>sha(path.join(repo,p))===baseline[p]);
const recordingChange=keys.filter(p=>tracedBaseline[p]!==baseline[p]);
function fileResults(label,reference=label) {
  const trace=path.join(directory,reference,'trace');
  const reported=new Map();
  for(const line of fs.readFileSync(path.join(directory,label,'tap.log'),'utf8').split(/\r?\n/)){
    const match=/^(ok|not ok) \d+ - (.+)$/.exec(line);
    if(match)reported.set(match[2],match[1]);
  }
  return fs.readdirSync(trace).sort().map(file=>{
    const names=data(reference+'/trace/'+file).filter(event=>event.event==='test_start').map(event=>event.test);
    return {file:file.replace(/\.\d+\.json$/,''),tests:names.length,pass:names.filter(n=>reported.get(n)==='ok').length,
      unsuccessful:names.filter(n=>reported.get(n)!=='ok')};
  });
}
const rows=[];
for(const [label,count] of [['verified-full',1340],['verified-five',40],['verified-missing',1],['verified-native',1]]){
  const r=data(label+'/result.json'),sources=data(label+'/sources.json');
  const timing=data(label+'/exit-time.json'),{supervisors,typesetting}=data(label+'/joined.json');
  const entry=supervisors.find(s=>s.test.includes('deliberately missing plan'));
  const nativeOnly=label==='verified-native',entryOnly=label==='verified-missing';
  const typesetExpected=entryOnly?0:nativeOnly?1:3;
  const nativeMatches=typesetting.length===typesetExpected&&typesetting.every(s=>{
    const old=previousTypesetting.find(p=>p.test===s.test);
    if(!old||!s.identityConfirmed||!s.kernelCleanupConfirmed||s.activeAfter!==0||s.reason!=='root_exit')return false;
    if(old.failureCode==='MANUAL_LAYOUT_REQUIRED')return s.rootExitCode===1&&s.failureCode===old.failureCode&&s.resultBound===null;
    return s.rootExitCode===0&&s.resultBound&&s.resultMatchesPng&&s.candidateSha256===old.candidateSha256;
  });
  const sameSources=keys.every(p=>sources[p]===tracedBaseline[p]);
  const pass=r.code===0&&!r.signal&&r.counts.tests===count&&r.counts.pass===count&&
    [r.counts.fail,r.counts.cancelled,r.counts.skipped,r.counts.todo].every(n=>n===0)&&
    r.changed.length===0&&sameSources&&r.logSha256===sha(path.join(directory,label,'tap.log'))&&
    r.sourcesSha256===sha(path.join(directory,label,'sources.json'))&&timing.pass&&
    nativeMatches&&(nativeOnly||entry?.reason==='root_exit'&&entry.rootExitCode===1&&entry.clean&&entry.activeAfter===0);
  rows.push({label,pass,counts:r.counts,exitCode:r.code,started:r.started,finished:r.finished,logSha256:r.logSha256,
    sameSources,nativeWorkersMeasured:timing.measured,typesetAndRefusalMatch:nativeMatches,
    selectedFileResults:fileResults(label),missingPlan:entry});
}
const plain=[];
const expectedPngs=previousTypesetting.map(r=>r.candidateSha256).filter(Boolean).sort();
for(const [label,count] of [['plain-full',1340],['plain-five',40],['plain-missing',1],['plain-native',1]]){
  const result=data(label+'/result.json'),sources=data(label+'/sources.json'),timing=data(label+'/launch-phases.json');
  const sameSources=keys.every(p=>sources[p]===baseline[p]);
  const unchangedRunner=result.traceFlag==='normal'&&!result.args.includes('--require')&&result.args.includes('--test-concurrency=1');
  const nativeOnly=label==='plain-native',entryOnly=label==='plain-missing';
  const native=timing.rows.filter(r=>r.kind==='typesetting');
  const pngs=native.filter(r=>r.rootExitCode===0&&r.witness?.outputBound&&r.reason==='root_exit')
    .map(r=>r.witness.candidateSha256).sort();
  const expected=entryOnly?[]:nativeOnly?[previousTypesetting.find(r=>r.test.endsWith('before publication')).candidateSha256]:expectedPngs;
  const refusals=native.filter(r=>r.rootExitCode===1&&r.witness?.failureBound&&r.witness.failureCode==='MANUAL_LAYOUT_REQUIRED'&&r.witness.candidateSha256===null);
  const outputMatches=JSON.stringify(pngs)===JSON.stringify(expected)&&
    refusals.length===(entryOnly||nativeOnly?0:1)&&native.length===expected.length+refusals.length;
  const missing=timing.rows.find(r=>r.kind==='missing-plan');
  const missingPlanMatches=nativeOnly||missing?.reason==='root_exit'&&missing.rootExitCode===1&&missing.witness?.actualAiCalls===0&&
    missing.witness.events.some(e=>e.phase==='startup_failed'&&e.code==='WARM_STARTUP_FAILED'&&e.primaryFailureCode==='ENOENT'&&e.bootstrapStage==='plan_read');
  const hashes=result.logSha256===sha(path.join(directory,label,'tap.log'))&&result.sourcesSha256===sha(path.join(directory,label,'sources.json'));
  const pass=result.code===0&&!result.signal&&result.counts.tests===count&&result.counts.pass===count&&
    ['fail','cancelled','skipped','todo'].every(k=>result.counts[k]===0)&&hashes&&sameSources&&result.changed.length===0&&
    timing.pass&&outputMatches&&missingPlanMatches&&unchangedRunner;
  plain.push({label,pass,counts:result.counts,code:result.code,started:result.started,finished:result.finished,logSha256:result.logSha256,
    sameSources,unchangedRunner,nativeWorkersMeasured:timing.measured,outputMatches,missingPlanMatches,missingPlan:missing,
    selectedFileResults:fileResults(label,label.replace('plain-','verified-')),failures:result.failures});
}
const stage16=data('stage16/result.json'),readback=data('protected-readback.json');
const previous=data('../stage17-18-20261119/protected-final.json');
const protectedMatch=readback.files.length===18&&readback.files.every(f=>f.matches)&&readback.signedResult.matches&&
  readback.files.every(f=>previous.files.some(p=>p.kind===f.kind&&p.sha256===f.sha256))&&
  previous.signedResult.sha256===readback.signedResult.sha256&&readback.permitIds.length===7&&
  JSON.stringify(previous.permitIds)===JSON.stringify(readback.permitIds);
const v8=data('v8-option.json'),restored=data('electron-restored.json');
const spansOnly=recordingChange.length===1&&recordingChange[0].replaceAll('\\','/')==='scripts/v2/warm-job.ps1';
const pass=unchanged&&spansOnly&&plain.every(r=>r.pass)&&stage16.pass&&protectedMatch&&v8.pass&&restored.pass;
console.log(JSON.stringify({scope:'Stage17 Windows V2 synthetic regression, original uninstrumented Node test command on final sources',pass,unchanged,
  productAndTestPinsCompared:keys.length,rows:plain,previousWithNodeObservers:{allPassed:rows.every(r=>r.pass),recordingChange,rows},
  workerOptionMeasured:v8.pass,restoredBinaryVerified:restored.pass,
  stage16:{pass:stage16.pass,executions:stage16.executions,distinctTestNames:stage16.distinctTestNames},
  protected:{match:protectedMatch,files:readback.files.length,signed:readback.signedResult.matches,permitRecords:readback.permitIds.length}},null,2));
process.exitCode=pass?0:1;
