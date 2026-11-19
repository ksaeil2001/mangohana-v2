import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=fileURLToPath(new URL('.',import.meta.url)), label=process.argv[2];
if(!/^[a-z][a-z0-9-]+$/.test(label))throw Error('Expected a run label');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const cfg=read(path.join(here,label,'command.json'));
const base=path.resolve('E:/Dev/Outputs/MangohanaV2-20261111/tests');
const root=path.resolve(cfg.tmp);
if(path.dirname(root)!==base||!path.basename(root).startsWith('stage17-windows-'+label+'-'))throw Error('Expected isolated fixture root');
const dirs=dir=>fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()).map(e=>e.name);
const optional=file=>fs.existsSync(file)?read(file):null;
const cases=[];
for(const leaf of dirs(root)){
  const dir=path.join(root,leaf);
  if(/^font-bootstrap-[a-z0-9]{6}$/i.test(leaf)){
    const id=read(path.join(dir,'input.json')).permit.executionGeneration;
    if(!/^font-only-[0-9a-f-]{36}$/.test(id))throw Error('Unbound font probe');
    cases.push({kind:'font',id,dir:path.join(base,id),proof:optional(path.join(dir,'probe-summary.json'))?.receipt});
  }
  if(/^typesetting-native-[a-z0-9]{6}$/i.test(leaf)){
    const work=path.join(dir,'work'),{permit}=read(path.join(work,'input.json')),id=permit.executionGeneration;
    if(!/^[0-9a-f-]{36}$/.test(id)||permit.executionMode!=='TYPESETTING_ONLY')throw Error('Unbound typesetting probe');
    const candidate=path.join(work,'candidate.png'),result=optional(path.join(work,'result.json')),failure=optional(path.join(work,'failure.json'));
    const sha=fs.existsSync(candidate)?createHash('sha256').update(fs.readFileSync(candidate)).digest('hex'):null;
    const witness={candidateSha256:sha,outputBound:result?result.permitId===permit.permitId&&result.executionGeneration===id&&result.pngSha256===sha:null,
      failureCode:failure?.code,failureBound:failure?failure.permitId===permit.permitId&&failure.executionGeneration===id:null};
    cases.push({kind:'typesetting',id,dir:path.join(base,'typesetting-synthetic-'+id),proof:optional(path.join(dir,'controller.json')),witness});
  }
}
for(const leaf of dirs(path.join(root,'entry'))){
  if(!/^(bootstrap-positive|invalid-args|missing-plan)-[0-9a-f]{6}$/.test(leaf))throw Error('Unexpected entry leaf');
  const dir=path.join(root,'entry',leaf);
  const entry=optional(path.join(dir,'entry-proof.json'));
  const proof=entry?.result??optional(path.join(dir,'bootstrap-job-proof.json'));
  cases.push({kind:leaf.slice(0,-7),id:proof?.runId,dir,proof,witness:entry?{events:entry.events,actualAiCalls:entry.actualAiCalls}:undefined});
}
const iso=raw=>raw&&BigInt(raw)>0n?new Date(Number((BigInt(raw)-116444736000000000n)/10000n)).toISOString():null;
const elapsed=(begin,end)=>begin&&end?Date.parse(end)-Date.parse(begin):null;
const rows=cases.map(({kind,id,dir,proof,witness})=>{
  const r=optional(path.join(dir,'job-control-receipt.json'));
  if(!r)return {kind,id,measured:false,reason:'missing_receipt'};
  const supervisor=iso(r.supervisorCreationTime100ns),compileStart=iso(r.helperCompileStartTime100ns),compileEnd=iso(r.helperCompileEndTime100ns);
  const worker=iso(r.rootCreationTime100ns),exit=iso(r.rootExitTime100ns);
  const sameIdentity=!!proof&&id===r.runId&&proof.supervisorPid===r.supervisorPid&&proof.rootPid===r.rootPid&&
    proof.rootCreationTime100ns===r.rootCreationTime100ns&&proof.rootExitCode===r.rootExitCode&&proof.rootExitTime100ns===r.rootExitTime100ns;
  const ordered=supervisor&&compileStart&&compileEnd&&worker&&exit&&Date.parse(supervisor)<=Date.parse(compileStart)&&
    Date.parse(compileStart)<=Date.parse(compileEnd)&&Date.parse(compileEnd)<=Date.parse(worker)&&Date.parse(worker)<=Date.parse(exit);
  return {kind,runId:r.runId,supervisorPid:r.supervisorPid,rootPid:r.rootPid,sameIdentity,measured:!!ordered,
    supervisorCreatedUtc:supervisor,compileStartedUtc:compileStart,compileCompletedUtc:compileEnd,
    rootCreatedUtc:worker,rootExitedUtc:exit,beforeCompileMs:elapsed(supervisor,compileStart),
    compileMs:elapsed(compileStart,compileEnd),afterCompileUntilRootMs:elapsed(compileEnd,worker),
    workerMs:elapsed(worker,exit),rootExitCode:r.rootExitCode,reason:r.reason,clean:r.kernelCleanupConfirmed,activeAfter:r.activeProcessesAfter,witness};
});
const expected=['full','five'].includes(cfg.mode)?10:1;
const pass=rows.length===expected&&rows.every(r=>r.measured&&r.sameIdentity&&r.clean&&r.activeAfter===0);
console.log(JSON.stringify({pass,expected,measured:rows.filter(r=>r.measured).length,rows},null,2));
process.exitCode=pass?0:1;
