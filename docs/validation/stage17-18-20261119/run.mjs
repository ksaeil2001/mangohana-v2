import {createHash} from 'node:crypto';
import {spawnSync, execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, existsSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../../../',import.meta.url)), out=fileURLToPath(new URL('.',import.meta.url));
const [label,...args]=process.argv.slice(2);
if (!/^[a-z][a-z\d-]+$/.test(label) || !args.length || existsSync(path.join(out,label+'.json'))) throw Error('Supply a new run label and node arguments');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sources=new Set();
for(const directory of ['apps/sites/lib','apps/sites/components','apps/sites/hooks','apps/engine','apps/sites/checks','packages/evaluation','packages/ai-engine/quality','tests/v2','scripts/v2']){
  for(const file of readdirSync(path.join(root,directory),{withFileTypes:true})){
    if(file.isFile() && /\.(?:[cm]?[jt]sx?|json)$/.test(file.name)) sources.add(directory+'/'+file.name);
  }
}
for(const directory of ['tests/v2/fixtures','packages/evaluation/offline','packages/evaluation/policy']){
  for(const file of readdirSync(path.join(root,directory),{withFileTypes:true})) if(file.isFile())sources.add(directory+'/'+file.name);
}
for(const f of ['apps/sites/app/globals.css','apps/sites/app/page.tsx','apps/sites/app/api/engine/[...path]/route.ts','apps/sites/tsconfig.json','tsconfig.json','package.json','apps/sites/package.json','docs/validation/stage16-06-20261119/run-allowed.mjs','docs/validation/stage16-03-20261119/metadata-only.mjs','docs/validation/stage17-18-20261119/run.mjs',...args.filter(s=>s.includes('/')&&!s.startsWith('-') && existsSync(path.resolve(root,s)))]) sources.add(f);
const capture=()=>Object.fromEntries([...sources].sort().map(f=>[f,sha(readFileSync(path.resolve(root,f)))]));
const before=capture(), started=new Date().toISOString();
const result=spawnSync(process.execPath,args,{cwd:root,windowsHide:true,encoding:'utf8',maxBuffer:48*1024*1024,env:{...process.env,NO_COLOR:'1'}});
const log=(result.stdout??'')+(result.stderr??'')+(result.error?'\n'+result.error.message:'');
writeFileSync(path.join(out,label+'.log'),log,{flag:'wx'});
const counts=Object.fromEntries(['tests','pass','fail','skipped','cancelled','todo'].map(k=>{
  const values=[...log.matchAll(new RegExp('^# '+k+' (\\d+)\\s*$','gm'))];
  return [k,values.length?values.reduce((sum,m)=>sum+Number(m[1]),0):null];
}));
const after=capture(), changed=Object.keys(before).filter(k=>before[k]!==after[k]);
const manifest=JSON.stringify(before,null,2)+'\n', manifestName=label+'-sources.json';
writeFileSync(path.join(out,manifestName),manifest,{flag:'wx'});
const record={executable:process.execPath,node:process.version,executableSha256:sha(readFileSync(process.execPath)),
  args,cwd:root,head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),started,finished:new Date().toISOString(),
  exitCode:result.status,signal:result.signal,counts,sources:manifestName,changedDuringRun:changed,logSha256:sha(log)};
writeFileSync(path.join(out,label+'.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({label,exit:result.status,counts,changed,diagnostics:result.status===0?'':log.split('\n').filter(l=>/not ok|error TS|error:|Cannot find|Denied|Error:/.test(l)).slice(0,14)}));
process.exitCode=result.status??2;
