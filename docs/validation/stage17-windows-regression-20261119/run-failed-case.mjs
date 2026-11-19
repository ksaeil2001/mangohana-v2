import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here=fileURLToPath(new URL('.',import.meta.url)),repo=path.resolve(here,'../../..');
const full=JSON.parse(fs.readFileSync(path.join(here,'journal-full/result.json')));
const pins=JSON.parse(fs.readFileSync(path.join(here,'journal-full/sources.json')));
const cases={
  'bootstrap-single':{number:1329,file:'tests/v2/warm-electron-entry.test.mjs'},
  'bootstrap-resume':{number:1329,file:'tests/v2/warm-electron-entry.test.mjs',observe:true},
  'context-single':{number:152,file:'tests/v2/engine-runtime-reuse.test.mjs'},
};
const label=process.argv[2];
if(!Object.hasOwn(cases,label))throw Error('Expected a measured failing case');
const ref=cases[label],prefix='not ok '+ref.number+' - ';
const title=full.failures.find(s=>s.startsWith(prefix))?.slice(prefix.length);
if(!title)throw Error('The specified full run did not record this failure');
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const files=Object.keys(pins).filter(f=>/^(packages|scripts|apps|tests)[\\/]/.test(f));
const same=()=>files.every(f=>sha(path.join(repo,f))===pins[f]);
if(!same())throw Error('Reproduction inputs changed since the full run');
const dir=path.join(here,label);fs.mkdirSync(dir);
const tmp=fs.mkdtempSync('E:/Dev/Outputs/MangohanaV2-20261111/tests/stage17-windows-'+label+'-');
const env={...process.env,TEMP:tmp,TMP:tmp,NO_COLOR:'1'};
for(const [key,sub] of Object.entries({MANGOHANA_OWNED_RUNTIME_TEST_DIR:'owned',MANGOHANA_LEASE_TEST_DIR:'lease',MANGOHANA_ENTRY_TEST_DIR:'entry'})){
  env[key]=path.join(tmp,sub);fs.mkdirSync(env[key]);
}
const literal=title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const args=['--test','--test-reporter=tap','--test-concurrency=1'];
if(ref.observe){
  env.STAGE17_TEST_TRACE=path.join(dir,'trace');fs.mkdirSync(env.STAGE17_TEST_TRACE);
  args.push('--require',path.join(here,'trace.cjs'));
}
args.push('--test-name-pattern','^'+literal+'$',ref.file);
const config={mode:label,started:new Date().toISOString(),tmp,exe:process.execPath,args,sourceCount:files.length};
fs.writeFileSync(path.join(dir,'command.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx'});
const log=fs.openSync(path.join(dir,'tap.log'),'wx');
const run=spawnSync(process.execPath,args,{cwd:repo,env,windowsHide:true,stdio:['ignore',log,log]});
fs.closeSync(log);if(run.error)throw run.error;
const tap=fs.readFileSync(path.join(dir,'tap.log'),'utf8');
const counts=Object.fromEntries(['tests','pass','fail','skipped','cancelled','todo'].map(key=>[key,Number(tap.match(new RegExp('^# '+key+' (\\d+)\\s*$','m'))?.[1]??NaN)]));
const pass=run.status===0&&counts.tests===1&&counts.pass===1&&['fail','skipped','cancelled','todo'].every(k=>counts[k]===0)&&same();
const result={...config,finished:new Date().toISOString(),exit:run.status,signal:run.signal,counts,pass,logSha256:sha(path.join(dir,'tap.log'))};
fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({label,counts,pass}));process.exitCode=pass?0:1;
