import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(import.meta.url);
const now=()=>performance.now();
if(process.argv[2]==='--measure'){
  const file=process.argv[3];
  if(!path.isAbsolute(file)||path.basename(file)!=='synthetic-http.jsonl'||
      !/^arm-\d+$/.test(path.basename(path.dirname(file)))||
      !/^stage17-file-latency-[A-Za-z0-9]{6}$/.test(path.basename(path.dirname(path.dirname(file)))))throw Error('Expected a dedicated fixture');
  const start=now(),utc=new Date().toISOString();
  const fd=fs.openSync(file,'a'),opened=now();
  fs.writeSync(fd,'{"path":"/v1/models","authorized":true}\n');
  const written=now();fs.closeSync(fd);const closed=now();
  console.log(JSON.stringify({utc,openMs:opened-start,writeMs:written-opened,closeMs:closed-written,totalMs:closed-start}));
}else{
  const roots={E:fs.mkdtempSync('E:/Dev/Outputs/MangohanaV2-20261111/tests/stage17-file-latency-'),
    C:fs.mkdtempSync(path.join(os.tmpdir(),'stage17-file-latency-'))};
  if(path.parse(roots.C).root.toUpperCase()!=='C:\\')throw Error('Expected the separate local OS temp volume');
  const first=['E-new','C-existing','C-new','E-existing'];
  const order=[...first,...first.toReversed(),...first.slice(2),...first.slice(0,2),
    ...first.slice(1),first[0],...first.toReversed(),...first];
  const rows=[];
  for(const [index,arm] of order.entries()){
    const [volume,state]=arm.split('-'),dir=path.join(roots[volume],'arm-'+index);
    fs.mkdirSync(dir);const file=path.join(dir,'synthetic-http.jsonl');
    const setup=now();
    if(state==='existing')fs.closeSync(fs.openSync(file,'wx'));
    const prepared=now(),requested=new Date().toISOString();
    const result=spawnSync(process.execPath,[script,'--measure',file],{cwd:path.dirname(process.execPath),
      windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:8192,
      env:{SystemRoot:process.env.SystemRoot,PATH:path.dirname(process.execPath),TEMP:dir,TMP:dir}});
    const elapsed=now()-prepared;
    const entry=result.status===0?JSON.parse(result.stdout):null;
    const confirmed=entry!==null&&fs.readFileSync(file,'utf8')==='{"path":"/v1/models","authorized":true}\n';
    rows.push({index,arm,setupMs:prepared-setup,requested,childPid:result.pid,elapsedMs:elapsed,code:result.status,
      signal:result.signal,error:result.error?.code,entry,confirmed,overFiveSeconds:elapsed>5000});
  }
  const target=path.join(path.dirname(script),'file-latency.json');
  fs.writeFileSync(target,JSON.stringify({scope:'Independent first-file observation only',roots,rows},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({count:rows.length,confirmed:rows.filter(r=>r.confirmed).length,
    overFiveSeconds:rows.filter(r=>r.overFiveSeconds).map(r=>[r.arm,r.elapsedMs,r.entry]),
    largest:rows.toSorted((a,b)=>(b.entry?.totalMs??0)-(a.entry?.totalMs??0)).slice(0,3).map(r=>[r.arm,r.entry])}));
}
