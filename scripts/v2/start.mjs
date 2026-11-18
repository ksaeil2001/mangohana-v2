import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ownedStopPath, ownsRuntime } from '../../apps/engine/lifecycle.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const runRoot='E:/Dev/Outputs/MangohanaV2-20261111';
const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--config'&&path.isAbsolute(args[1])))throw new Error('사용법: node scripts/v2/start.mjs [--config <관리자 설정 JSON 절대 경로>]');
const configPath=args.length?path.resolve(args[1]):path.join(runRoot,'engine-config.json');
const config=JSON.parse(await fs.readFile(configPath,'utf8'));
// Runtime ownership/stop files stay in the existing app directory even when a
// separate model candidate configuration is chosen. Never overwrite the base.
if(typeof config.runRoot!=='string'||path.resolve(config.runRoot).toLowerCase()!==path.resolve(runRoot).toLowerCase())throw new Error('관리자 설정의 runRoot가 이 로컬 앱 출력 폴더와 다릅니다.');
const runId=randomUUID();
const environment=Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
let stopping=false,frontend;
const launch=(executable,args,env,cwd=root)=>spawn(executable,args,{cwd,env,windowsHide:true,stdio:'inherit'});
const engine=launch(path.join(root,'packages/ai-engine/node_modules/electron/dist/electron.exe'),[path.join(root,'apps/engine/host.cjs'),configPath,runId],{...environment,TEMP:path.join(config.profileRoot,'temp'),TMP:path.join(config.profileRoot,'temp'),LOCALAPPDATA:config.installedLocalAppData,TRIO_DISABLE_AUTO_UPDATE:'true'});
async function stop(){
  if(stopping)return;stopping=true;
  if(engine.exitCode===null)await fs.writeFile(ownedStopPath(runRoot,runId),'requested');
  if(frontend&&!frontend.killed)frontend.kill();
}
engine.once('error',error=>{console.error(error.message);process.exitCode=1;void stop();});
engine.once('exit',code=>{if(!stopping){stopping=true;process.exitCode=code??1;if(frontend&&!frontend.killed)frontend.kill();}});
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
try{
  const deadline=Date.now()+30_000;let ready=false;
  while(Date.now()<deadline&&!stopping){
    try{if(ownsRuntime(JSON.parse(await fs.readFile(path.join(runRoot,'runtime.json'),'utf8')),engine.pid,runId)){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!ready){if(!stopping){process.exitCode=1;await stop();}throw new Error('AI 서버를 시작하지 못했습니다. 이미 실행 중인지 또는 runtime.json을 확인하세요.');}
  // The visitor sees only Sites, after this launch owns a listening engine.
  frontend=launch(process.execPath,[path.join(root,'apps/sites/scripts/run-framework.mjs'),'dev'],{...environment,MANGOHANA_ENGINE_URL:`http://127.0.0.1:${config.port}`},path.join(root,'apps/sites'));
  frontend.once('error',error=>{console.error(error.message);process.exitCode=1;void stop();});
  frontend.once('exit',code=>{if(!stopping){process.exitCode=code??1;void stop();}});
}catch(error){console.error(error.message);}
