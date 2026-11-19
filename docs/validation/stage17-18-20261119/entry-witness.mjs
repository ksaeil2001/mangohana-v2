import {createHash} from 'node:crypto';
import {readFileSync,existsSync,readdirSync,mkdtempSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url)),dir=fileURLToPath(new URL('.',import.meta.url));
const readJSON=file=>JSON.parse(readFileSync(file));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const file='tests/v2/warm-electron-entry.test.mjs',testName='real Electron CLI with a deliberately missing plan emits startup_failed and exits 1 promptly';
const previous=readJSON(path.join(dir,'v2-current.json'));
if(sha(readFileSync(path.join(root,file)))!==readJSON(path.join(dir,previous.sources))[file])throw Error('Entry test changed');
const temp=mkdtempSync('E:/Dev/Outputs/MangohanaV2-20261111/tests/mangohana-release-entry-witness-');
const args=['--test','--test-reporter=tap','--test-name-pattern','^'+testName+'$',file];
console.log('ENTRY_WITNESS '+JSON.stringify({temp,args,sourceSha256:sha(readFileSync(path.join(root,file)))}));
const child=spawnSync(process.execPath,args,{cwd:root,env:{...process.env,MANGOHANA_ENTRY_TEST_DIR:temp,TEMP:temp,TMP:temp},windowsHide:true,stdio:'inherit'});
if(child.error)throw child.error;
const observed=[];
for(const entry of readdirSync(temp,{withFileTypes:true})){
  if(!entry.isDirectory()||!/^missing-plan-[a-f0-9]{6}$/.test(entry.name))continue;
  const summary={directory:entry.name};
  for(const name of ['entry-proof.json','job-control-receipt.json']){
    const target=path.join(temp,entry.name,name);
    if(!existsSync(target)){summary[name]=null;continue;}
    const evidence=readJSON(target),job=evidence.result??evidence;
    summary[name]={sha256:sha(readFileSync(target)),rootExitCode:job.rootExitCode,reason:job.reason,failure:job.failure,
      kernelCleanupConfirmed:job.kernelCleanupConfirmed,terminated:job.terminated,supervisorExitCode:job.supervisorExitCode,
      events:evidence.events?.map(x=>({phase:x.phase,primaryFailureCode:x.primaryFailureCode,bootstrapStage:x.bootstrapStage})),
      actualAiCalls:evidence.actualAiCalls};
  }
  observed.push(summary);
}
console.log('ENTRY_RECEIPTS '+JSON.stringify(observed));
process.exitCode=child.status??2;
