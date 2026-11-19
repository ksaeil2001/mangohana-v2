import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const out=fileURLToPath(new URL('.',import.meta.url)),[label]=process.argv.slice(2);
if(!/^[a-z][\w-]*$/.test(label))throw Error('Invalid label');
const dir=path.join(out,label),cfg=JSON.parse(fs.readFileSync(path.join(dir,'command.json'))),owned=cfg.fixtureRoots.owned;
if(!/^E:[\\/]Dev[\\/]Outputs[\\/]MangohanaV2-20261111[\\/]tests[\\/]stage17-windows-/.test(owned))throw Error('Unexpected test root');
const j=f=>fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):null;
const lines=f=>fs.existsSync(f)?fs.readFileSync(f,'utf8').split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s)):[];
const directories=root=>fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()).map(e=>e.name);
const runtime=[];
const traced=fs.existsSync(path.join(dir,'trace'))?fs.readdirSync(path.join(dir,'trace')).flatMap(f=>{
  const rows=j(path.join(dir,'trace',f));return rows.map(e=>({...e,source:f}));
}):[];
for(const leaf of directories(owned).filter(n=>/^engine-(reuse|default)-[a-zA-Z0-9]{6}$/.test(n))){
  const root=path.join(owned,leaf);
  const marker=j(path.join(root,'SYNTHETIC_PROVIDERS_ONLY.json'));
  if(marker?.actualAiCalls!==0||marker?.userImagesUsed!==0)throw Error('Unrecognized fixture');
  const ownership=j(path.join(root,'owned-child-exit.json'));
  const pids=new Set([...(ownership?.children??[]),...(ownership?.ocrChildren??[])].map(c=>c.pid));
  const stages=[],readStages=(p,name)=>lines(path.join(p,'runtime-events.jsonl')).forEach(e=>{
    if(e.phase.startsWith('llama_')||e.code)stages.push({page:name,phase:e.phase,at:e.at,durationMs:e.durationMs,code:e.code,exitCode:e.exitCode});
  });
  for(const page of directories(root).filter(n=>/^page-\d+$/.test(n)))readStages(path.join(root,page),page);
  const jobs=path.join(root,'owned-jobs');
  if(fs.existsSync(jobs)){
    for(const id of directories(jobs).filter(n=>/^[a-f0-9-]{36}$/.test(n)))readStages(path.join(jobs,id),id);
  }
  const requests=lines(path.join(root,'synthetic-http.jsonl')).map(x=>({pid:x.pid,route:x.path,authorized:x.authorized}));
  const periods=traced.filter(e=>e.event==='test_start').map(e=>({test:e.test,source:e.source,start:e.utc,end:traced.find(p=>p.source===e.source&&p.event==='test_body_finished'&&p.test===e.test)?.utc}));
  const linked=traced.filter(e=>e.event==='spawn_returned'&&pids.has(e.pid)&&(e.fixtureLeaf?e.fixtureLeaf===leaf:
    periods.some(p=>p.source===e.source&&p.test===e.test&&stages.some(s=>s.at>=p.start&&s.at<=p.end))));
  runtime.push({leaf,pids:[...pids],tests:[...new Set(linked.map(e=>e.test))],
    hooksReleased:ownership?.hooksReleased,forced:ownership?.forcedOwnerRecovery,
    allChildHandlesClosed:ownership?.children?.every(c=>c.closed),stages,requests});
}
const supervisors=[];
for(const spawn of traced.filter(e=>e.event==='spawn_requested'&&e.role==='job_supervisor'&&e.control)){
  const events=traced.filter(e=>e.source===spawn.source&&e.serial===spawn.serial);
  const k=j(path.join(spawn.control,'job-control-receipt.json'));
  const ready=events.find(e=>e.event==='supervisor_ready'),resumed=events.find(e=>e.event==='supervisor_resumed'),complete=events.find(e=>e.event==='supervisor_complete'),close=events.find(e=>e.event==='process_exit');
  const kernelUTC=v=>v&&BigInt(v)>0n?new Date(Number((BigInt(v)-116444736000000000n)/10000n)).toISOString():null;
  supervisors.push({test:spawn.test,runId:k?.runId,rootPid:k?.rootPid||null,supervisorPid:k?.supervisorPid,requestedUtc:spawn.utc,
    rootCreatedUtc:kernelUTC(k?.rootCreationTime100ns),readyObservedUtc:ready?.utc,resumedObservedUtc:resumed?.utc,
    rootExitUtc:kernelUTC(k?.rootExitTime100ns),completionObservedUtc:complete?.utc,supervisorExitedUtc:close?.utc,
    reason:k?.reason,failure:k?.failure,rootExitCode:k?.rootPid?k.rootExitCode:null,clean:k?.kernelCleanupConfirmed,activeAfter:k?.activeProcessesAfter,
    sameIdentity:!!k&&k.supervisorPid===close?.pid&&k.runId===ready?.runId&&k.runId===complete?.runId&&
      k.rootPid===ready?.rootPid&&k.rootPid===complete?.rootPid&&k.rootCreationTime100ns===ready?.creation&&k.rootCreationTime100ns===complete?.creation,
    supervisorWaitMs:ready?Math.round(ready.monoMs-spawn.monoMs):null,nativeElapsedMs:k?.elapsedMs});
}
const typesetting=[];
for(const leaf of directories(cfg.tmp).filter(n=>/^typesetting-native-[a-zA-Z0-9]{6}$/.test(n))){
  const work=path.join(cfg.tmp,leaf,'work'),input=j(path.join(work,'input.json')),controller=j(path.join(cfg.tmp,leaf,'controller.json'));
  if(!input||input.permit?.executionMode!=='TYPESETTING_ONLY')throw Error('Unbound native test input');
  if(!controller){
    const kernel=supervisors.find(s=>s.runId===input.permit.executionGeneration);
    typesetting.push({leaf,runId:input.permit.executionGeneration,controllerReceipt:false,kernelFailure:kernel?.failure??null,
      rootPid:kernel?.rootPid??null,rootExitCode:kernel?.rootExitCode??null});
    continue;
  }
  if(controller.runId!==input.permit.executionGeneration)throw Error('Unbound native test evidence');
  const k=supervisors.find(s=>s.runId===controller.runId&&s.rootPid===controller.rootPid);
  const result=j(path.join(work,'result.json')),failure=j(path.join(work,'failure.json')),candidate=path.join(work,'candidate.png');
  const sha=fs.existsSync(candidate)?createHash('sha256').update(fs.readFileSync(candidate)).digest('hex'):null;
  typesetting.push({leaf,runId:controller.runId,test:k?.test,rootPid:controller.rootPid,
    identityConfirmed:k?.sameIdentity===true&&controller.supervisorPid===k.supervisorPid&&controller.rootExitCode===k.rootExitCode,
    rootExitCode:controller.rootExitCode,reason:controller.reason,kernelCleanupConfirmed:controller.kernelCleanupConfirmed,
    activeAfter:controller.activeProcessesAfter,terminationRequested:controller.terminationRequested,
    resultBound:result?result.permitId===input.permit.permitId&&result.executionGeneration===controller.runId:null,
    resultMatchesPng:result?typeof sha==='string'&&sha===result.pngSha256:null,candidateSha256:sha,
    failureCode:failure?.code??null});
}
const file=process.argv[3]??'joined.json';
if(!/^joined(?:-v\d+)?\.json$/.test(file))throw Error('Unexpected evidence name');
fs.writeFileSync(path.join(dir,file),JSON.stringify({runtime,supervisors,typesetting},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({runtime:runtime.length,failed:runtime.flatMap(r=>r.stages.filter(s=>s.phase==='llama_load_failed').map(s=>({test:r.tests,page:s.page,code:s.code,requests:r.requests.length,stages:r.stages.filter(t=>t.page===s.page)}))).slice(0,4),supervisors:supervisors.length,missingSupervisorReceipt:supervisors.filter(r=>!r.runId).length}));
