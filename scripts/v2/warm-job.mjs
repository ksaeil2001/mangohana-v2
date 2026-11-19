// Isolated verification controller only. Importing does not start native/model processes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import enginePackage from '../../packages/ai-engine/package.json' with {type:'json'};
const helper=fileURLToPath(new URL('./warm-job.ps1',import.meta.url));
const typesettingWorker=fileURLToPath(new URL('./typesetting-only-worker.cjs',import.meta.url)).toLowerCase();
const engineElectron=fileURLToPath(new URL('../../packages/ai-engine/node_modules/electron/dist/electron.exe',import.meta.url)).toLowerCase();
const prefix='MANGOHANA_WARM_JOB_V1 ';
const fail=code=>Object.assign(new Error(code),{code});
const allowedEnv=new Set(['systemroot','windir','path','pathext','comspec','processor_architecture','number_of_processors','temp','tmp','localappdata','trio_disable_auto_update','hf_hub_offline','transformers_offline','programw6432','programfiles','programdata','allusersprofile']);
async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),ms);})]);}finally{clearTimeout(timer);}}

export function windowsWorkerArguments(executable,args,version=enginePackage.dependencies.electron) {
  if(version!=='42.9.3'||path.normalize(executable).toLowerCase()!==engineElectron||
    path.normalize(args[0]??'').toLowerCase()!==typesettingWorker)return args;
  if(args.some(arg=>arg==='--'||arg==='--js-flags'||arg.startsWith('--js-flags=')))return args;
  // Electron #52956: this V8 page pool can post work after the Windows loop closes.
  return [...args,'--js-flags=--no-memory-pool'];
}

export async function createWarmJob({directory,runId,executable,args=[],cwd,env,cleanupMs=20_000,maxLifetimeMs=30*60_000,onStdout=()=>{},onStderr=()=>{}}){
 if(process.platform!=='win32'||!/^E:[\\/]/i.test(directory)||!/^[-A-Za-z0-9._]{1,128}$/.test(runId)||!path.isAbsolute(executable)||!path.isAbsolute(cwd)||!Array.isArray(args)||args.some(value=>typeof value!=='string'||value.includes('\0'))||!env||Object.keys(env).some(key=>!allowedEnv.has(key.toLowerCase()))||!Number.isInteger(cleanupMs)||cleanupMs<100||cleanupMs>60_000||!Number.isInteger(maxLifetimeMs)||maxLifetimeMs<1000||maxLifetimeMs>3600_000)throw fail('WARM_JOB_OPTIONS');
 directory=path.resolve(directory);if(path.resolve(await fs.realpath(directory)).toLowerCase()!==directory.toLowerCase())throw fail('WARM_JOB_LINK_REJECTED');
 try{await fs.access(path.join(directory,'job-control-receipt.json'));throw fail('WARM_JOB_ALREADY_USED');}catch(error){if(error.code!=='ENOENT')throw error;}
 const supervisor=spawn(path.join(env.SystemRoot??env.SYSTEMROOT??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-ControlRoot',directory],{cwd,env:{...env,TEMP:directory,TMP:directory},windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
 supervisor.stdin.on('error',()=>{});
 let resolveReady,rejectReady,resolveCompletion,readyValue,closed=false,buffer='',failure=null,stdoutBytes=0,stderrBytes=0,lifetimeTimer,forcedSupervisor=false;
 const readyPromise=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const send=command=>{if(!closed&&!supervisor.stdin.destroyed)supervisor.stdin.write(command+':'+runId+'\n');};
 supervisor.stdout.on('data',bytes=>{stdoutBytes+=bytes.length;buffer=(buffer+bytes.toString('utf8')).slice(-262144);let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);if(!line.startsWith(prefix)){onStdout(Buffer.from(line+'\n'));continue;}let event;try{event=JSON.parse(line.slice(prefix.length));}catch{continue;}if(event.phase==='ready'&&!readyValue){if(event.runId!==runId||event.supervisorPid!==supervisor.pid||event.jobAssigned!==true||event.launchMechanism!=='ATOMIC_JOB_LIST_SUSPENDED'||event.inheritedHandles!=='STDOUT_STDERR_ONLY'||!Number.isInteger(event.rootPid)||!/^\d{15,}$/.test(event.rootCreationTime100ns??'')){failure='WARM_JOB_GATE_INVALID';send('STOP');rejectReady(fail(failure));continue;}readyValue=Object.freeze(event);resolveReady(readyValue);}if(event.phase==='failed'||event.phase==='complete'&&!readyValue&&event.failure){failure=event.failure??'WARM_JOB_START_FAILED';rejectReady(fail(failure));}}});
 supervisor.stderr.on('data',bytes=>{stderrBytes+=bytes.length;onStderr(bytes);});
 const completion=new Promise(resolve=>{resolveCompletion=resolve;supervisor.once('error',()=>{failure='WARM_JOB_SUPERVISOR_SPAWN_FAILED';rejectReady(fail(failure));});supervisor.once('close',async(code,signal)=>{closed=true;clearTimeout(startTimer);clearTimeout(lifetimeTimer);if(!readyValue)rejectReady(fail(failure??'WARM_JOB_NO_GATE'));let receipt;try{receipt=JSON.parse(await fs.readFile(path.join(directory,'job-control-receipt.json'),'utf8'));if(receipt.runId!==runId||receipt.supervisorPid!==supervisor.pid||readyValue&&(receipt.rootPid!==readyValue.rootPid||receipt.rootCreationTime100ns!==readyValue.rootCreationTime100ns))throw fail('WARM_JOB_RECEIPT_IDENTITY');}catch{receipt={kernelCleanupConfirmed:false,failure:failure??'WARM_JOB_RECEIPT_MISSING',rootPid:readyValue?.rootPid??null,rootCreationTime100ns:readyValue?.rootCreationTime100ns??null};}resolve({...receipt,kernelCleanupConfirmed:receipt.kernelCleanupConfirmed===true&&!forcedSupervisor,failure:failure??receipt.failure,supervisorExitCode:code,supervisorSignal:signal,supervisorClosed:true,stdoutBytes,stderrBytes});});});
 async function forceClose(code){failure??=code;forcedSupervisor=true;supervisor.stdin.end();if(!closed)supervisor.kill();const result=await bounded(completion,5000);if(result)return result;closed=true;clearTimeout(startTimer);clearTimeout(lifetimeTimer);supervisor.stdout.destroy();supervisor.stderr.destroy();supervisor.stdin.destroy();supervisor.unref();const unknown={kernelCleanupConfirmed:false,failure:'WARM_JOB_SUPERVISOR_EXIT_UNCONFIRMED',rootPid:readyValue?.rootPid??null,rootCreationTime100ns:readyValue?.rootCreationTime100ns??null,supervisorClosed:false,stdoutBytes,stderrBytes};resolveCompletion(unknown);return unknown;}
 // Only this directly spawned supervisor handle is terminated on a failed startup.
 // Atomic Job assignment plus private kill-on-close covers even a suspended native root.
 const startTimer=setTimeout(()=>{failure='WARM_JOB_START_TIMEOUT';void forceClose(failure);rejectReady(fail(failure));},30_000);
 supervisor.stdin.write(JSON.stringify({runId,executable,args:windowsWorkerArguments(executable,args),cwd,cleanupMs,maxLifetimeMs})+'\n');
 let ready;try{ready=await readyPromise;clearTimeout(startTimer);}catch(error){supervisor.stdin.end();if(!await bounded(completion,cleanupMs+1000))await forceClose('WARM_JOB_START_CLEANUP_TIMEOUT');throw error;}
 lifetimeTimer=setTimeout(()=>void forceClose('WARM_JOB_CONTROLLER_LIFETIME_TIMEOUT'),maxLifetimeMs+cleanupMs+5000);
 let resumed=false,stopping;
 return {ready,supervisor,completion,get closed(){return closed;},async resume(){if(closed||stopping)throw fail('WARM_JOB_CLOSED');if(!resumed){resumed=true;send('RESUME');}},stop(){if(!stopping){send('STOP');stopping=(async()=>await bounded(completion,cleanupMs+2000)??await forceClose('WARM_JOB_STOP_TIMEOUT'))();}return stopping;},closeControl(){supervisor.stdin.end();}};
}
