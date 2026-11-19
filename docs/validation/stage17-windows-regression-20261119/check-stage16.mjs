import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const reportDir=process.argv[2]??'stage16';
if(!['stage16','stage16-final','stage16-quiet'].includes(reportDir))throw Error('Expected a Stage16 report name');
const output=fileURLToPath(new URL('./'+reportDir+'/',import.meta.url));
const validation=path.join(root,'docs/validation');
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stages=['03','04','05','06'];
const paths=stages.map(s=>path.join(validation,'stage16-'+s+'-20261119'));
const protectedFiles=paths.flatMap(dir=>fs.readdirSync(dir)
  .filter(name=>name.endsWith('.mjs')||name.endsWith('.json'))
  .map(name=>path.join(dir,name)));
for(const name of ['experiment-lock.json','condition-table.json','human-audit.json','uncertainty-paired-report.json','cost-adjusted-success.json','synthetic-index.json']){
  if(!fs.existsSync(path.join(paths.at(-1),name)))throw Error('Expected existing Stage16 evidence: '+name);
}
protectedFiles.push(...fs.readdirSync(path.join(root,'tests/v2')).filter(n=>/^stage16-.*\.test\.mjs$/.test(n)).map(n=>path.join(root,'tests/v2',n)));
const pins=()=>Object.fromEntries(protectedFiles.map(f=>[path.relative(root,f),digest(f)]));
const before=pins(),summaries=[],unique=new Set();
fs.mkdirSync(output);
for(const stage of stages){
  const runner=path.join(validation,'stage16-'+stage+'-20261119','run-allowed.mjs');
  for(const suite of stage==='06'?['focused','regression','evidence']:['focused','regression']){
    const args=[path.relative(root,runner),suite],started=new Date().toISOString();
    const run=spawnSync(process.execPath,args,{cwd:root,windowsHide:true,encoding:'utf8',maxBuffer:24*1024*1024});
    if(run.error)throw run.error;
    const log=path.join(output,stage+'-'+suite+'.tap'),raw=run.stdout+run.stderr;
    fs.writeFileSync(log,raw,{flag:'wx'});
    const counts={};
    for(const key of ['tests','pass','fail','cancelled','skipped','todo']){
      const found=[...raw.matchAll(new RegExp('^# '+key+' (\\d+)\\s*$','gm'))];
      counts[key]=found.length?found.reduce((a,m)=>a+Number(m[1]),0):null;
    }
    for(const m of raw.matchAll(/^ok \d+ - ([^\r\n]+)$/gm))unique.add(m[1]);
    summaries.push({stage,suite,started,finished:new Date().toISOString(),args,exitCode:run.status,signal:run.signal,
      counts,logSha256:digest(log),pass:run.status===0&&counts.tests>0&&counts.tests===counts.pass&&[counts.fail,counts.cancelled,counts.skipped,counts.todo].every(n=>n===0)});
  }
}
const after=pins(),changed=Object.keys(before).filter(k=>before[k]!==after[k]);
const pass=!changed.length&&summaries.every(s=>s.pass);
const result={scope:'Original metadata-only runners, file and test-name grants, and image guards',node:process.version,
  executable:process.execPath,inputs:before,changed,pass,summaries,executions:summaries.reduce((n,s)=>n+s.counts.tests,0),distinctTestNames:unique.size};
fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({pass,changed,executions:result.executions,distinctTestNames:unique.size,suites:summaries.map(s=>[s.stage,s.suite,s.counts.pass])}));
process.exitCode=pass?0:1;
