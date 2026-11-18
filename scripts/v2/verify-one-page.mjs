import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {exportOnePage} from './export-one-page.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
async function main(){
const args=process.argv.slice(2);
if(!((args.length===2&&['--input','--resume'].includes(args[0]))||(args.length===4&&args[0]==='--input'&&args[2]==='--config')))
  throw Object.assign(new Error('사용법: node scripts/v2/verify-one-page.mjs --input <원본 PNG/JPG/WebP 절대 경로> [--config <로컬 엔진 설정 JSON>] 또는 --resume <검증 실행 폴더>'),{code:'EXPORT_USAGE'});
if(args[0]==='--resume'){
  console.log(JSON.stringify(await exportOnePage(path.resolve(args[1]))));return;
}
const input=path.resolve(args[1]);
const sourceConfigPath=path.resolve(args.length===4?args[3]:'E:/Dev/Outputs/MangohanaV2-20261111/engine-config.json');
const base=JSON.parse(await fs.readFile(sourceConfigPath,'utf8'));
const runRoot=path.join('E:/Dev/Outputs/MangohanaV2-20261111','one-page-'+new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));
await fs.mkdir(runRoot,{recursive:false});
const resourcesPath=path.join(root,'packages/ai-engine/.build/resources');
const config={...base,resourcesPath,runRoot,profileRoot:path.join(runRoot,'profile'),dataRoot:path.join(runRoot,'jobs')};
const configPath=path.join(runRoot,'engine-config.json');
await fs.writeFile(configPath,JSON.stringify(config,null,2),{flag:'wx'});
await fs.writeFile(path.join(runRoot,'input.json'),JSON.stringify({path:input,sourceConfigPath,manualCorrections:0,scope:'LOCAL_SOURCE_EXECUTION',browserFlowVerified:false},null,2),{flag:'wx'});
console.log('ACTUAL_RUN_ROOT='+runRoot);
const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
Object.assign(env,{TEMP:path.join(config.profileRoot,'temp'),TMP:path.join(config.profileRoot,'temp'),LOCALAPPDATA:config.installedLocalAppData,TRIO_DISABLE_AUTO_UPDATE:'true'});
const exit=await new Promise((resolve,reject)=>{
  const child=spawn(path.join(root,'packages/ai-engine/node_modules/electron/dist/electron.exe'),[path.join(root,'apps/engine/verify-one.cjs'),configPath,input],{cwd:root,env,windowsHide:true,stdio:'inherit'});
  child.once('error',reject);child.once('exit',code=>resolve(code??1));
}).catch(async error=>{await fs.writeFile(path.join(runRoot,'verification-failure.json'),JSON.stringify({status:'failed',code:error.code??'RUNTIME_START_FAILED',scope:'LOCAL_SOURCE_EXECUTION',browserFlowVerified:false},null,2),{flag:'wx'});throw error;});
if(exit!==0){process.exitCode=exit;throw new Error('실제 엔진 검증이 실패했습니다. '+runRoot);}

console.log(JSON.stringify(await exportOnePage(runRoot)));
}
main().catch(error=>{console.error(JSON.stringify({status:'failed',code:error.code??'VERIFICATION_FAILED',message:error.message}));process.exitCode||=1;});
