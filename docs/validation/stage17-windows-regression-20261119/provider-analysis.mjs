import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const label=process.argv[2];
if(!/^provider-[a-z0-9-]+$/.test(label))throw Error('Expected a provider witness');
const dir=fileURLToPath(new URL(label+'/',import.meta.url));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const {temp}=read(path.join(dir,'result.json'));
if(!/^E:[\\/]Dev[\\/]Outputs[\\/]MangohanaV2-20261111[\\/]tests[\\/]stage17-provider-[A-Za-z0-9]{6}$/.test(temp))throw Error('Expected an isolated run');
const childRows=read(path.join(dir,'children.json'));
const parentFile=fs.readdirSync(path.join(dir,'trace')).filter(n=>/^engine-runtime-reuse\.test\.mjs\.\d+\.json$/.test(n));
if(parentFile.length!==1)throw Error('Expected one original test process');
const parents=read(path.join(dir,'trace',parentFile[0]));
const outputs=[];
for(const child of childRows){
  if(!/^engine-(reuse|default)-[A-Za-z0-9]{6}$/.test(child.leaf))throw Error('Unexpected provider root');
  const root=path.join(temp,'owned',child.leaf),scope=read(path.join(root,'SYNTHETIC_PROVIDERS_ONLY.json'));
  if(scope.actualAiCalls!==0||scope.actualModelsLoaded!==0||scope.userImagesUsed!==0)throw Error('Synthetic scope required');
  const start=Date.parse(child.requested),end=Date.parse(child.exit);
  const spawn=parents.find(e=>e.event==='spawn_returned'&&e.pid===child.pid&&e.fixtureLeaf===child.leaf&&Date.parse(e.utc)>=start-25&&Date.parse(e.utc)<=end);
  const folders=fs.readdirSync(root).filter(n=>/^page-\d+$/.test(n)).map(n=>path.join(root,n));
  const jobs=path.join(root,'owned-jobs');
  if(fs.existsSync(jobs))folders.push(...fs.readdirSync(jobs).filter(n=>/^[0-9a-f-]{36}$/.test(n)).map(n=>path.join(jobs,n)));
  const failures=folders.flatMap(folder=>{
    const file=path.join(folder,'runtime-events.jsonl');
    if(!fs.existsSync(file))return [];
    return fs.readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(e=>
      e.phase==='llama_load_failed'&&Date.parse(e.at)>=start&&Date.parse(e.at)<=end+20);
  }).map(e=>({at:e.at,code:e.code}));
  const deadline=failures.find(e=>e.code==='LLM_START_TIMEOUT')?.at;
  const events=child.events;
  const phases=events.map(e=>e.phase);
  const lastBeforeTimeout=deadline?events.filter(e=>e.utc<=deadline).at(-1):null;
  const nextAfterTimeout=deadline?events.find(e=>e.utc>deadline):null;
  const transport=parents.filter(e=>e.test===spawn?.test&&e.event.startsWith('models_')&&Date.parse(e.utc)>=start&&Date.parse(e.utc)<=end);
  const waits=events.map((ev,i)=>({from:i?events[i-1].phase:'parent_spawn',to:ev.phase,
    ms:Date.parse(ev.utc)-(i?Date.parse(events[i-1].utc):start)}));
  const diary=events.filter(e=>e.phase==='diary_end').map(e=>Math.round(e.elapsedMs));
  outputs.push({test:spawn?.test,leaf:child.leaf,pid:child.pid,identity:!!spawn,requested:child.requested,exit:child.exit,
    firstJs:events[0]?.utc,listen:events.find(e=>e.phase==='listening')?.utc,
    firstServerRequest:events.find(e=>e.phase==='server_request_start')?.utc,
    requests:phases.filter(p=>p==='server_request_start').length,responses:phases.filter(p=>p==='response_finished').length,
    maxCompletedDiaryMs:diary.length?Math.max(...diary):null,
    parentStatuses:transport.filter(e=>e.event==='models_headers').map(e=>e.status),parentErrors:transport.filter(e=>e.event==='models_error').map(e=>e.code),
    longestObservedGap:waits.sort((a,b)=>b.ms-a.ms)[0],failures,lastBeforeTimeout,nextAfterTimeout});
}
console.log(JSON.stringify({children:outputs.length,identities:outputs.filter(c=>c.identity).length,timeouts:outputs.filter(c=>c.failures.some(f=>f.code==='LLM_START_TIMEOUT')).length,outputs},null,2));
