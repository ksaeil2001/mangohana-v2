import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createWarmJob,windowsWorkerArguments} from '../../../scripts/v2/warm-job.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url)),out=fileURLToPath(new URL('.',import.meta.url));
const parent=fs.mkdtempSync('E:/Dev/Outputs/MangohanaV2-20261111/tests/stage17-v8-');
const executable=path.join(repo,'packages/ai-engine/node_modules/electron/dist/electron.exe');
const original=fs.readFileSync(path.join(path.dirname(executable),'version'),'utf8').trim();
if(original!=='42.9.3')throw Error('Expected restored runtime');
const rows=[];
for(const mode of ['default','scoped']){
  const directory=path.join(parent,mode),runId=randomUUID();
  fs.mkdirSync(directory);
  const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','ProgramW6432','ProgramFiles','ProgramData','ALLUSERSPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  Object.assign(env,{TEMP:directory,TMP:directory,LOCALAPPDATA:directory,TRIO_DISABLE_AUTO_UPDATE:'true'});
  const args=[path.join(repo,'scripts/v2/typesetting-only-worker.cjs'),directory,'--disable-gpu'];
  const selected=mode==='scoped'?windowsWorkerArguments(executable,args,original):[...args];
  const probe=[path.join(out,'v8-option-worker.cjs'),...selected.slice(1)];
  const job=await createWarmJob({directory,runId,executable,cwd:repo,args:probe,env,maxLifetimeMs:90000});
  try {
    await job.resume();const completion=await job.completion;
    if(completion.rootExitCode!==0||!completion.kernelCleanupConfirmed||completion.activeProcessesAfter!==0)throw Error('Unconfirmed diagnostic process');
    rows.push({mode,runId,rootPid:completion.rootPid,rootExitCode:completion.rootExitCode,kernelCleanupConfirmed:completion.kernelCleanupConfirmed,
      observed:JSON.parse(fs.readFileSync(path.join(directory,'observed.json')))});
  }finally{if(!job.closed)await job.stop()}
}
const [a,b]=rows.map(r=>r.observed);
const pass=a.electron===original&&b.electron===original&&a.v8===b.v8&&a.jsFlags===''&&b.jsFlags==='--no-memory-pool'&&a.cacheTag!==b.cacheTag;
console.log(JSON.stringify({pass,rows}));process.exitCode=pass?0:1;
