import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {ProcessOwner}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const base=process.env.MANGOHANA_WARM_JOB_TEST_DIR??'E:/Dev/Outputs/MangohanaV2-20261111/tests/warm-job-'+Date.now()+'-'+randomUUID().slice(0,8);
const safeEnv=directory=>Object.assign(Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE'].filter(key=>process.env[key]).map(key=>[key,process.env[key]])),{TEMP:directory,TMP:directory});
async function eventually(read,predicate,ms=6000){const until=Date.now()+ms;let value;while(Date.now()<until){try{value=await read();if(predicate(value))return value;}catch{}await sleep(40);}throw new Error('TEST_OBSERVATION_TIMEOUT');}
async function readJson(file){return JSON.parse(await fs.readFile(file,'utf8'));}
async function fixture(name,mode='crash',detached=true){
 const directory=path.join(base,name+'-'+randomUUID().slice(0,6));await fs.mkdir(directory,{recursive:true});
 const heartbeat=path.join(directory,'heartbeat.cjs'),root=path.join(directory,'parent.cjs');
 await fs.writeFile(heartbeat,`const fs=require('node:fs'),p=require('node:path');const [d,role]=process.argv.slice(2);const started=Date.now();function save(name,value){const file=p.join(d,role+'-'+name+'.json');fs.writeFileSync(file+'.tmp',JSON.stringify(value));fs.renameSync(file+'.tmp',file);}save('ready',{pid:process.pid,parentPid:process.ppid,startedAt:started});function tick(){save('beat',{pid:process.pid,at:Date.now()});if(fs.existsSync(p.join(d,'STOP-'+role))||Date.now()-started>12000)process.exit(0);}process.on('exit',()=>{try{save('exit',{pid:process.pid,at:Date.now()});}catch{}});setInterval(tick,50);tick();`);
 await fs.writeFile(root,`const fs=require('node:fs'),p=require('node:path'),{spawn}=require('node:child_process');const [d,mode,...extra]=process.argv.slice(2);fs.writeFileSync(p.join(d,'root-started.json'),JSON.stringify({pid:process.pid,parentPid:process.ppid,extra,temp:process.env.TEMP}));const child=spawn(process.execPath,[p.join(d,'heartbeat.cjs'),d,'grandchild'],{windowsHide:true,detached:${detached},stdio:'ignore'});child.unref();const start=Date.now();let seen=0;setInterval(()=>{if(fs.existsSync(p.join(d,'grandchild-ready.json'))&&!seen)seen=Date.now();if(mode==='crash'&&seen&&Date.now()-seen>600)process.exit(29);if(Date.now()-start>10000)process.exit(0);},30);`);
 const sentinel=spawn(process.execPath,[heartbeat,directory,'sentinel'],{windowsHide:true,stdio:'ignore',env:safeEnv(directory)});const sentinelReady=await eventually(()=>readJson(path.join(directory,'sentinel-ready.json')),Boolean);
 const finish=async()=>{await Promise.all(['sentinel','grandchild'].map(role=>fs.writeFile(path.join(directory,'STOP-'+role),'own fixture stop')));await eventually(()=>readJson(path.join(directory,'sentinel-exit.json')),Boolean).catch(()=>{});await eventually(()=>readJson(path.join(directory,'grandchild-exit.json')),Boolean,500).catch(()=>{});if(sentinel.exitCode===null)await new Promise(resolve=>{sentinel.once('exit',resolve);setTimeout(resolve,500).unref();});};
 return {directory,root,mode,sentinel,sentinelReady,finish};
}
async function launch(f,extra=[]){
 if(process.env.MANGOHANA_WARM_JOB_BASELINE==='1'){
  const owner=new ProcessOwner(),record=owner.spawn(process.execPath,[f.root,f.directory,f.mode,...extra],{windowsHide:true,stdio:['ignore','ignore','ignore'],env:safeEnv(f.directory)});
  return {ready:{rootPid:record.child.pid},resume:async()=>{},stop:async()=>owner.cleanup(),completion:(async()=>{await eventually(()=>record.closed,Boolean);await owner.cleanup();return {kernelCleanupConfirmed:false,legacyRootClosed:record.closed,rootExitCode:record.code};})()};
 }
 const {createWarmJob}=await import('../../scripts/v2/warm-job.mjs');
 return createWarmJob({directory:f.directory,runId:randomUUID(),executable:process.execPath,args:[f.root,f.directory,f.mode,...extra],cwd:f.directory,env:safeEnv(f.directory),cleanupMs:4000,maxLifetimeMs:12000});
}

test('a crashed owned parent cannot leave its grandchild alive or touch an unrelated sentinel',{skip:process.platform!=='win32',timeout:25000},async()=>{
 const f=await fixture('parent-crash');let job;try{
  job=await launch(f);await job.resume();const child=await eventually(()=>readJson(path.join(f.directory,'grandchild-ready.json')),Boolean);const result=await job.completion;
  const before=await readJson(path.join(f.directory,'grandchild-beat.json'));await sleep(250);const after=await readJson(path.join(f.directory,'grandchild-beat.json'));
  const sentinel=await readJson(path.join(f.directory,'sentinel-beat.json'));const evidence={scope:'ACTUAL_SMALL_NODE_NO_AI',baseline:process.env.MANGOHANA_WARM_JOB_BASELINE==='1',rootPid:job.ready.rootPid,grandchild:child,grandchildHeartbeatAdvanced:after.at>before.at,sentinelPidUnchanged:sentinel.pid===f.sentinelReady.pid,sentinelStillAlive:f.sentinel.exitCode===null,result};await fs.writeFile(path.join(f.directory,'ownership-evidence.json'),JSON.stringify(evidence,null,2));
  assert.equal(evidence.grandchildHeartbeatAdvanced,false,'crashed main left the owned grandchild running');assert.equal(result.kernelCleanupConfirmed,true);assert.equal(result.rootExitCode,29);assert.equal(result.activeProcessesAfter,0);assert.equal(evidence.sentinelPidUnchanged,true);assert.equal(evidence.sentinelStillAlive,true);assert.ok(result.members.some(member=>member.pid===child.pid&&member.creationTime100ns&&member.exited===true));
 }finally{if(job&&!process.env.MANGOHANA_WARM_JOB_BASELINE)await job.stop().catch(()=>{});await f.finish();}
});

test('ordinary Node spawn is a separate negative control and does not reproduce the detached fixture',{skip:process.platform!=='win32'||process.env.MANGOHANA_WARM_JOB_BASELINE==='1',timeout:15000},async()=>{
 const f=await fixture('ordinary-negative-control','crash',false),owner=new ProcessOwner();try{const record=owner.spawn(process.execPath,[f.root,f.directory,f.mode],{windowsHide:true,stdio:'ignore',env:safeEnv(f.directory)});await eventually(()=>readJson(path.join(f.directory,'grandchild-ready.json')),Boolean);await eventually(()=>record.closed,Boolean);await owner.cleanup();const a=await readJson(path.join(f.directory,'grandchild-beat.json'));await sleep(250);const b=await readJson(path.join(f.directory,'grandchild-beat.json'));const observed={scope:'ORDINARY_NODE_LIBUV_NEGATIVE_CONTROL_NOT_PROVIDER_AI_EVIDENCE',rootExitCode:record.code,childHeartbeatAdvanced:b.at>a.at,sentinelStillAlive:f.sentinel.exitCode===null};await fs.writeFile(path.join(f.directory,'ordinary-evidence.json'),JSON.stringify(observed,null,2));assert.equal(observed.childHeartbeatAdvanced,false);assert.equal(observed.sentinelStillAlive,true);}finally{await f.finish();}
});

test('suspended root has no execution before explicit gate, preserves Unicode arguments and restricted environment',{skip:process.platform!=='win32'||process.env.MANGOHANA_WARM_JOB_BASELINE==='1',timeout:25000},async()=>{
 const f=await fixture('gate-한글','live');let job;try{
  const args=['space value','quote"value','trailing\\','slashes\\\"quoted','한글 漫画',''];job=await launch(f,args);
  await assert.rejects(fs.access(path.join(f.directory,'root-started.json')));assert.equal(job.ready.jobAssigned,true);assert.equal(job.ready.inheritedHandles,'STDOUT_STDERR_ONLY');assert.equal(job.ready.launchMechanism,'ATOMIC_JOB_LIST_SUSPENDED');assert.match(job.ready.rootCreationTime100ns,/^\d{15,}$/);
  await job.resume();const started=await eventually(()=>readJson(path.join(f.directory,'root-started.json')),Boolean);assert.deepEqual(started.extra,args);assert.equal(path.resolve(started.temp).toLowerCase(),path.resolve(f.directory).toLowerCase());
  await eventually(()=>readJson(path.join(f.directory,'grandchild-ready.json')),Boolean);const result=await job.stop();assert.equal(result.kernelCleanupConfirmed,true);assert.equal(result.reason,'controller_stop');assert.equal(result.activeProcessesAfter,0);assert.equal(f.sentinel.exitCode,null);
 }finally{await job?.stop().catch(()=>{});await f.finish();}
});

test('controller EOF kills its private tree without relying on the crashed main process',{skip:process.platform!=='win32'||process.env.MANGOHANA_WARM_JOB_BASELINE==='1',timeout:25000},async()=>{
 const f=await fixture('controller-eof','live');let job;try{job=await launch(f);await job.resume();await eventually(()=>readJson(path.join(f.directory,'grandchild-ready.json')),Boolean);job.closeControl();const result=await job.completion;assert.equal(result.reason,'controller_eof');assert.equal(result.kernelCleanupConfirmed,true);assert.equal(result.activeProcessesAfter,0);assert.equal(f.sentinel.exitCode,null);}finally{await job?.stop().catch(()=>{});await f.finish();}
});

test('supervisor process death closes the only Job handle and kills its members',{skip:process.platform!=='win32'||process.env.MANGOHANA_WARM_JOB_BASELINE==='1',timeout:25000},async()=>{
 const f=await fixture('supervisor-death','live');let job;try{job=await launch(f);await job.resume();await eventually(()=>readJson(path.join(f.directory,'grandchild-ready.json')),Boolean);await eventually(()=>readJson(path.join(f.directory,'grandchild-beat.json')),Boolean);assert.equal(job.ready.supervisorPid,job.supervisor.pid);job.supervisor.kill();const result=await job.completion;assert.equal(result.kernelCleanupConfirmed,false,'missing supervisor receipt must remain unconfirmed');await sleep(300);const a=await readJson(path.join(f.directory,'grandchild-beat.json'));await sleep(250);const b=await readJson(path.join(f.directory,'grandchild-beat.json'));assert.equal(a.at,b.at,'last Job handle was inherited or leaked');assert.equal(f.sentinel.exitCode,null);}finally{await job?.stop().catch(()=>{});await f.finish();}
});

test('STOP before resume disposes a suspended root without executing application code',{skip:process.platform!=='win32'||process.env.MANGOHANA_WARM_JOB_BASELINE==='1',timeout:15000},async()=>{
 const f=await fixture('stop-before-resume','live');let job;try{job=await launch(f);const result=await job.stop();assert.equal(result.resumed,false);assert.equal(result.kernelCleanupConfirmed,true);assert.equal(result.activeProcessesAfter,0);await assert.rejects(fs.access(path.join(f.directory,'root-started.json')));assert.equal(f.sentinel.exitCode,null);}finally{await job?.stop().catch(()=>{});await f.finish();}
});

test('environment secrets are rejected before a supervisor is created',{skip:process.platform!=='win32'||process.env.MANGOHANA_WARM_JOB_BASELINE==='1'},async()=>{
 const {createWarmJob}=await import('../../scripts/v2/warm-job.mjs');await assert.rejects(createWarmJob({directory:base,runId:randomUUID(),executable:process.execPath,args:[],cwd:base,env:{...safeEnv(base),PRIVATE_TOKEN:'not-a-real-secret'}}),/WARM_JOB_OPTIONS/);
});

test('a finite lifetime closes an unresumed owned root without executing its code',{skip:process.platform!=='win32'||process.env.MANGOHANA_WARM_JOB_BASELINE==='1',timeout:12000},async()=>{
 const {createWarmJob}=await import('../../scripts/v2/warm-job.mjs'),f=await fixture('finite-lifetime','live');let job;try{job=await createWarmJob({directory:f.directory,runId:randomUUID(),executable:process.execPath,args:[f.root,f.directory,f.mode],cwd:f.directory,env:safeEnv(f.directory),cleanupMs:2000,maxLifetimeMs:1000});const before=Date.now(),result=await job.completion;assert.equal(result.reason,'lifetime_timeout');assert.equal(result.kernelCleanupConfirmed,true);assert.ok(Date.now()-before<6000);await assert.rejects(fs.access(path.join(f.directory,'root-started.json')));assert.equal(f.sentinel.exitCode,null);}finally{await job?.stop().catch(()=>{});await f.finish();}
});
