import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const old=fileURLToPath(new URL('../stage17-18-20261119/',import.meta.url));
const base='E:/Dev/Outputs/MangohanaV2-20261111/tests';
const json=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const iso=value=>new Date(value).toISOString();
const filetime=value=>value&&BigInt(value)>0n?iso(Number((BigInt(value)-116444736000000000n)/10000n)):null;
const names=dir=>fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()).map(e=>e.name);
const time=(f,kind='mtime')=>fs.existsSync(f)?fs.statSync(f)[kind].toISOString():null;
function control(dir,file){
  const filename=path.join(dir,file);
  if(!fs.existsSync(filename))return null;
  const data=json(filename),r=data.result??data;
  return {file,sha256:sha(filename),runId:r.runId,supervisorPid:r.supervisorPid,rootPid:r.rootPid,
    rootCreatedUtc:filetime(r.rootCreationTime100ns),exactExitUtc:filetime(r.rootExitTime100ns),receiptWrittenUtc:time(filename),
    nativeElapsedMs:r.elapsedMs,rootExitCode:r.rootExitCode,reason:r.reason,failure:r.failure,
    ready:r.ready,resumed:r.resumed,terminated:r.terminationRequested,clean:r.kernelCleanupConfirmed,active:r.activeProcessesAfter,
    events:data.events?.map(e=>({phase:e.phase,code:e.code,stage:e.bootstrapStage}))};
}
function readEntry(dir){
  return names(dir).filter(n=>/^(missing-plan|invalid-args|bootstrap-positive)-[a-f0-9]{6}$/.test(n)).map(n=>{
    const d=path.join(dir,n), proof=control(d,'entry-proof.json')??control(d,'bootstrap-job-proof.json');
    const kernel=control(d,'job-control-receipt.json');
    return {directory:n,directoryCreatedUtc:time(d,'birthtime'),kernel,proof,
      identityMatch:proof&&kernel?proof.runId===kernel.runId&&proof.rootPid===kernel.rootPid&&proof.rootCreatedUtc===kernel.rootCreatedUtc:null};
  });
}
function readTypeset(dir){
  return names(dir).filter(n=>/^typesetting-native-[a-zA-Z0-9]{6}$/.test(n)).map(n=>{
    const d=path.join(dir,n),work=path.join(d,'work'),file=path.join(d,'runtime.log');
    const gates=fs.existsSync(work)?fs.readdirSync(work).filter(f=>/^gate-(request|response)-\d+\.json$/.test(f)).map(f=>{
      const p=path.join(work,f);return {file:f,phase:json(p).phase,at:time(p)};
    }).sort((a,b)=>a.at.localeCompare(b.at)):[];
    const out=control(d,'controller.json');
    const supervisorDir=out?path.join(base,'typesetting-synthetic-'+out.runId):null;
    const kernel=supervisorDir&&fs.existsSync(supervisorDir)?control(supervisorDir,'job-control-receipt.json'):null;
    const resultFile=path.join(work,'result.json'),candidate=path.join(work,'candidate.png');
    const result=fs.existsSync(resultFile)?json(resultFile):null;
    return {directory:n,directoryCreatedUtc:time(d,'birthtime'),out,kernel,gates,
      resultWrittenUtc:time(resultFile),resultBound:result&&out?result.executionGeneration===out.runId:null,
      candidateSha256:fs.existsSync(candidate)?sha(candidate):null,reportedSha256:result?.pngSha256??null,hasWorkerFailure:fs.existsSync(path.join(work,'failure.json')),
      winHandleError:fs.existsSync(file)?fs.readFileSync(file,'utf8').includes('PostQueuedCompletionStatus'):null};
  });
}
const labels=['v2-engine-volume','v2-current','native-current','entry-witness'];
const candidates=names(base).filter(n=>/^electron-entry-\d{13}-[a-f0-9]{6}$/.test(n));
const runs=labels.map(label=>{
  const receipt=json(path.join(old,label+'.json')),log=fs.readFileSync(path.join(old,label+'.log'),'utf8');
  if(sha(path.join(old,label+'.log'))!==receipt.logSha256)throw Error('Unexpected previous log');
  const desc=JSON.parse(log.split(/\r?\n/)[0].replace(/^\S+ /,''));
  const candidatesForRun=candidates.filter(n=>{const stamp=Number(n.split('-')[2]);return stamp>=Date.parse(receipt.started)&&stamp<=Date.parse(receipt.finished);});
  const entryRoots=label==='entry-witness'?[path.basename(desc.temp)]:candidatesForRun;
  return {label,started:receipt.started,finished:receipt.finished,counts:receipt.counts,sandboxRoot:path.basename(desc.temp),
    matchingRoots:entryRoots,entry:entryRoots.map(n=>({root:n,rows:readEntry(path.join(base,n))})),typesetting:readTypeset(desc.temp)};
});
const output=fileURLToPath(new URL('historical-timeline-v2.json',import.meta.url));
fs.writeFileSync(output,JSON.stringify({notes:'Directory creation bounds launch preparation. Historical exact root exit time was not saved. Receipt mtime is an upper bound. Electron timestamp-matched roots are labeled explicitly.',runs},null,2)+'\n',{flag:'wx'});
for(const r of runs)console.log(JSON.stringify({label:r.label,matching:r.matchingRoots,entry:r.entry.flatMap(g=>g.rows).map(x=>[x.directory,x.kernel?.reason,x.kernel?.rootExitCode,x.kernel?Date.parse(x.kernel.rootCreatedUtc)-Date.parse(x.directoryCreatedUtc):null,x.kernel?.nativeElapsedMs,x.proof?.events?.[0]?.stage]),typesetting:r.typesetting.map(x=>[x.directory,x.out?.rootExitCode,x.out?.nativeElapsedMs,x.gates.at(-1)?.phase,x.winHandleError])}));
