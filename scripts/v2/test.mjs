import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const output=path.join('E:/Dev/Outputs/MangohanaV2-20261111/tests','v2-regression-'+Date.now()+'-'+randomUUID().slice(0,8));
await fs.mkdir(output,{recursive:true});
const temporary=path.join(output,'temp'),owned=path.join(output,'owned-runtime'),lease=path.join(output,'lease');
await Promise.all([fs.mkdir(temporary),fs.mkdir(owned),fs.mkdir(lease)]);
const tests=(await fs.readdir(path.join(root,'tests/v2'))).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tests/v2/'+name);
const sources=[...tests,'tests/v2/batch-fixture.mjs','scripts/v2/test.mjs','apps/engine/host.cjs','apps/engine/store.mjs','apps/engine/server.mjs','apps/engine/result.mjs','apps/engine/context.mjs',
 'packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs','packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs',
 'packages/ai-engine/vendor/trio/scripts/sites-local/translation-launch.cjs','scripts/v2/verify-warm-pages.mjs','apps/engine/verify-warm.cjs',
 'scripts/v2/warm-job.mjs','scripts/v2/warm-job.ps1',
 'scripts/v2/export-one-page.mjs','scripts/v2/export-warm-pages.mjs',
 'packages/ai-engine/quality/runtime-lease.cjs','packages/ai-engine/quality/owned-runtime.cjs','packages/ai-engine/quality/ocr-diagnostic.cjs','packages/ai-engine/quality/ocr-environment.cjs',
 'packages/ai-engine/quality/mask-evidence.cjs','packages/ai-engine/quality/page-translation.cjs','packages/ai-engine/quality/region-selection.cjs','packages/ai-engine/quality/ocr-refinement.cjs'];
const fingerprint=async()=>Object.fromEntries(await Promise.all(sources.map(async file=>[file,createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex')])));
const before=await fingerprint(),started=performance.now();
const env={...process.env,TEMP:temporary,TMP:temporary,MANGOHANA_OWNED_RUNTIME_TEST_DIR:owned,MANGOHANA_LEASE_TEST_DIR:lease,NO_COLOR:'1'};
delete env.FORCE_COLOR;
const log=await fs.open(path.join(output,'tests.log'),'wx');
const chunks=[];
console.log('V2_TEST_OUTPUT='+output);
let result;
try{
 const child=spawn(process.execPath,['--test','--test-reporter=spec','--test-concurrency=1',...tests],{cwd:root,env,windowsHide:true,stdio:['inherit','pipe','pipe']});
 // Stream writes preserve both channels in one local log without PowerShell's
 // native stderr conversion or printing any inherited environment variables.
 let writing=Promise.resolve(),writeError;
 const forward=(stream,chunk)=>{chunks.push(chunk);writing=writing.then(()=>log.write(chunk)).catch(error=>{writeError??=error;});stream.write(chunk);};
 child.stdout.on('data',chunk=>forward(process.stdout,chunk));child.stderr.on('data',chunk=>forward(process.stderr,chunk));
 result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 await writing;
 if(writeError)throw writeError;
}finally{await log.close();}
const transcript=Buffer.concat(chunks).toString('utf8');
const after=await fingerprint(),sourceUnchanged=JSON.stringify(before)===JSON.stringify(after);
const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(label=>{
 const matches=[...transcript.replace(/\x1b\[[0-9;]*m/g,'').matchAll(new RegExp('ℹ '+label+'\\s+(\\d+)','g'))];
 return [label,matches.length?Number(matches.at(-1)[1]):null];
}));
const passed=result.code===0&&sourceUnchanged&&counts.fail===0&&counts.skipped===0&&counts.cancelled===0&&counts.todo===0;
const verification={scope:'SYNTHETIC_CONTRACT_AND_OWNED_PROCESS_TESTS_NOT_AI_QUALITY',status:passed?'passed':'failed',actualAiRequests:0,
 node:process.version,exitCode:result.code,signal:result.signal,durationMs:performance.now()-started,counts,sourceUnchanged,
 ownedRuntimeTestsEnabled:true,sources:before,sourceAfter:sourceUnchanged?undefined:after,output};
await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(verification,null,2),{flag:'wx'});
console.log(JSON.stringify(verification));
process.exitCode=passed?0:1;
