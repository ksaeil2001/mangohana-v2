'use strict';
// Administrator preflight. No upload listener, job store, model process or job execution.
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

async function main(app, configFile) {
  if (!path.isAbsolute(configFile ?? '')) throw Error('관리자 설정의 절대 경로를 지정하세요.');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/,''));
  if (!path.isAbsolute(config.onnxModelsRoot ?? '')) throw Error('한 페이지 검증용 ONNX 설정이 필요합니다.');
  const directory = fs.mkdtempSync(path.join(config.runRoot, 'web-engine-readiness-'));
  const profileRoot = path.join(directory, 'profile');
  for (const key of ['userData','sessionData','temp','documents','home']) {
    const location = path.join(profileRoot,key);
    fs.mkdirSync(location,{recursive:true});
    app.setPath(key,location);
  }
  let engine, deniedStarts=0;
  const spawn = childProcess.spawn;
  childProcess.spawn = () => { deniedStarts++; throw Error('사전점검에서 모델 프로세스 생성을 중지했습니다.'); };
  let health;
  try {
    await app.whenReady();
    const {createEngine} = require(path.join(config.repository,'scripts/sites-local/engine.cjs'));
    engine = await createEngine({...config,profileRoot});
    health = engine.health();
  } finally {
    try { await engine?.close(); } finally { childProcess.spawn=spawn; }
  }
  const result = {scope:'ELECTRON_STARTUP_ONLY',electron:process.versions.electron,configFile,
    health,deniedStarts,jobSubmissions:0,closed:true,actualModelLoads:0};
  const file=path.join(directory,'readiness.json');
  fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({file,...result}));
  return health?.ready===true && health.providerProfile==='onnx-cpu' && deniedStarts===0 ? 0 : 1;
}

if (require.main===module || (process.versions.electron&&path.resolve(process.argv[1]??'')===__filename)) {
  if (!process.versions.electron) throw Error('프로젝트의 Electron 실행기로 시작하세요.');
  const {app}=require('electron');
  main(app,process.argv[2]).then(code=>app.exit(code),error=>{console.error(error.message);app.exit(1);});
}
