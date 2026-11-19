const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function createEngineHost(config, {createEngine = require(path.join(config.repository, 'scripts/sites-local/engine.cjs')).createEngine, stage15} = {}) {
  const {createJobStore, createTranslationReviewStore, loadStage14ReviewCatalog} = await import('./store.mjs');
  const {createEngineServer} = await import('./server.mjs');
  const {createContextStore} = await import('./context.mjs');
  let engine, store, contextStore, reviewStore, server, closing;
  function close() {
    return closing ??= (async () => {
      const failures = [];
      for (const release of [
        () => server?.listening && new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve())),
        () => reviewStore?.close(), () => store ? store.close() : engine?.close(), () => contextStore?.close(),
      ]) {
        try { await release(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, '작업 서버 종료를 확인하지 못했습니다.');
    })();
  }
  try {
    let registry;
    const attemptRoot = path.join(config.dataRoot,'stage15-attempts');
    if (stage15) {
      const {createStage15HostRegistry} = await import('./stage15-host-registry.mjs');
      registry = await createStage15HostRegistry(attemptRoot,stage15);
    }
    engine = await createEngine(config);
    contextStore = await createContextStore({root: path.join(config.dataRoot, 'contexts')});
    store = await createJobStore({root: config.dataRoot, engine, contextStore, stage15:registry,
      readBatchUsage:async (batch,pages) => (await import('./stage15-attempt-executor.mjs')).readStage15BatchUsage(attemptRoot,batch,pages)});
    reviewStore = await createTranslationReviewStore({root: path.join(config.dataRoot, 'translation-reviews'), loadCatalog: loadStage14ReviewCatalog,
      contextRevision: async (owner, project) => (await contextStore.snapshot(owner, project)).revision,
      withContextRevision: (owner, project, revision, commit) => contextStore.withRevision(owner, project, revision, commit)});
    server = createEngineServer({store, contextStore, reviewStore, allowedOrigin: config.siteOrigin});
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
    return {server, engine, close};
  } catch (error) {
    await close();
    throw error;
  }
}

function launchElectronHost() {
  const { app, protocol } = require('electron');
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const runId=process.argv[3]??randomUUID();
  if(!/^[0-9a-f-]{36}$/.test(runId))throw new Error('잘못된 실행 ID입니다.');
  for (const key of ['userData','sessionData','temp','documents','home']) {
    const directory=path.join(config.profileRoot,key);
    fs.mkdirSync(directory,{recursive:true});app.setPath(key,directory);
  }
  // Acquire the OS-backed Electron singleton before opening the durable store.
  const primary=app.requestSingleInstanceLock();
  if(!primary){console.error('Mangohana AI 서버가 이미 실행 중입니다.');app.exit(73);}
  protocol.registerSchemesAsPrivileged([{scheme:'trio-resource',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
  let host, starting, timer, stopping=false;
  function runtime(value){fs.writeFileSync(path.join(config.runRoot,'runtime.json'),JSON.stringify(value,null,2));}
  async function stop(){
    if(stopping)return;stopping=true;clearInterval(timer);
    try{
      await (host ?? await starting)?.close();
      runtime({status:'stopped',pid:process.pid,runId});app.exit(0);
    }catch{runtime({status:'shutdown_failed',pid:process.pid});app.exit(1);}
  }
  app.on('window-all-closed',()=>{});
  app.on('before-quit',event=>{if(!stopping){event.preventDefault();void stop();}});
  process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
  async function main(){
    await app.whenReady();
    const sharedStop=path.join(config.runRoot,'STOP');
    if(fs.existsSync(sharedStop))fs.renameSync(sharedStop,sharedStop+'.previous.'+Date.now());
    starting=createEngineHost(config);
    host=await starting;
    if(stopping)return;
    const state={status:'listening',origin:`http://127.0.0.1:${host.server.address().port}`,pid:process.pid,runId,engine:host.engine.health(),qualityStatus:'unreviewed',deployment:'NOT_RUN'};
    runtime(state);console.log(JSON.stringify(state));
    timer=setInterval(()=>{if(fs.existsSync(path.join(config.runRoot,'STOP'))||fs.existsSync(path.join(config.runRoot,'STOP-'+runId)))void stop();},500);
  }
  if(primary)main().catch(async error=>{
    await host?.close();
    runtime({status:'startup_failed',code:error.code??'STARTUP_FAILED',message:error.message});
    console.error('AI 서버 시작 실패:',error.code??error.message);app.exit(1);
  });
}

module.exports = {createEngineHost};
if (require.main === module || (process.versions.electron && path.resolve(process.argv[1] ?? '') === __filename)) launchElectronHost();
