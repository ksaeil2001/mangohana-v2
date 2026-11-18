// Read-only hardware monitor diagnosis; never starts a model.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {ProcessOwner,secretlessEnvironment,waitBounded}=require('../../../packages/ai-engine/vendor/trio/scripts/sites-local/engine-boundaries.cjs');
const output='E:/Dev/Outputs/MangohanaV2-20261111/semantic-gpu-env-'+new Date().toISOString().replaceAll(':','-');await fs.mkdir(output,{recursive:false});
const systemRoot=process.env.SystemRoot??'C:/Windows',executable=path.join(systemRoot,'System32','nvidia-smi.exe');
const systemPath=[path.join(systemRoot,'System32'),path.join(systemRoot,'System32/Wbem'),path.join(systemRoot,'System32/WindowsPowerShell/v1.0')].join(path.delimiter);
const windowsKeys=['SystemDrive','ALLUSERSPROFILE','ProgramData','ProgramFiles','ProgramW6432','CommonProgramFiles','CommonProgramW6432'];
const profileKeys=['USERPROFILE','LOCALAPPDATA','APPDATA'];
const sessionKeys=['USERNAME','USERDOMAIN','USERDOMAIN_ROAMINGPROFILE','SESSIONNAME','LOGONSERVER'];
const groups=[{name:'minimal',keys:[]},{name:'system_path',keys:[],systemPath:true},{name:'windows_directories',keys:windowsKeys,systemPath:true},{name:'profile_directories',keys:[...windowsKeys,...profileKeys],systemPath:true},{name:'session_identity',keys:[...windowsKeys,...profileKeys,...sessionKeys],systemPath:true}];
const results=[];
for(const group of groups){
 const owner=new ProcessOwner(),env=secretlessEnvironment(executable,output);if(group.systemPath)env.PATH=systemPath;
 for(const key of group.keys)if(process.env[key])env[key]=process.env[key];
 const record=owner.spawn(executable,['--query-gpu=memory.total,memory.used,memory.free','--format=csv,noheader,nounits'],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env});
 let stdout='',stderr='',spawnError;
 record.child.stdout.on('data',chunk=>{stdout=(stdout+chunk.toString('utf8')).slice(-8192);});record.child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-8192);});record.child.once('error',error=>{spawnError=error.code;});
 try{await waitBounded(record.done,5000,'GPU_PROBE_TIMEOUT');}finally{await owner.cleanup();}
 const result={group:group.name,extraKeys:group.keys.filter(key=>process.env[key]),exitCode:record.code,spawnError,stdout,stderr,cleanupConfirmed:record.closed};results.push(result);console.log(JSON.stringify(result));
 if(record.code===0)break;
}
await fs.writeFile(path.join(output,'verification.json'),JSON.stringify({scope:'GPU_MONITOR_ENVIRONMENT_DIAGNOSIS_NO_MODEL',executable,modelsStarted:0,results},null,2),{flag:'wx'});console.log(JSON.stringify({output}));
