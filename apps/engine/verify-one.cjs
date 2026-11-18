// Local administrator verification harness. No HTTP upload or browser control.
const {app,protocol}=require('electron');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {createHash,randomUUID}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const input=process.argv[3];
const output=config.runRoot;
for(const key of ['userData','sessionData','temp','documents','home']){
  const directory=path.join(config.profileRoot,key);fs.mkdirSync(directory,{recursive:true});app.setPath(key,directory);
}
protocol.registerSchemesAsPrivileged([{scheme:'trio-resource',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.on('window-all-closed',()=>{});
let store,engine;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function main(){
  await app.whenReady();
  const {createEngine}=require(path.join(config.repository,'scripts/sites-local/engine.cjs'));
  const {createJobStore}=await import(pathToFileURL(path.join(__dirname,'store.mjs')).href);
  const original=await fsp.readFile(input),originalHash=sha(original);
  const actualEngine=await createEngine(config);
  engine={...actualEngine,async run(args){
    try{return await actualEngine.run(args);}
    catch(error){
      // Administrator evidence contains only a fixed code, never model response text or credentials.
      await fsp.writeFile(path.join(args.outputDirectory,'execution-failure.json'),JSON.stringify({
        code:typeof error.code==='string'&&/^[A-Z_]{1,80}$/.test(error.code)?error.code:'ENGINE_FAILED',
        at:new Date().toISOString(),
      },null,2),{flag:'wx'});
      throw error;
    }
  }};
  const health=engine.health();if(!health.ready)throw Object.assign(new Error(health.message),{code:'ENGINE_NOT_READY'});
  store=await createJobStore({root:config.dataRoot,engine});
  const owner=sha(randomUUID()),started=performance.now();
  const created=await store.submit({owner,idempotencyKey:randomUUID(),bytes:original,name:path.basename(input),sourceLanguage:'ja',projectId:'local-source-verification',pageId:randomUUID()});
  console.log(JSON.stringify({runRoot:output,jobId:created.id,scope:'LOCAL_SOURCE_EXECUTION',browserFlowVerified:false}));
  let last='',job;
  const deadline=Date.now()+30*60_000;
  while(Date.now()<deadline){
    job=await store.get(owner,created.id);
    const marker=job.status+':'+job.stage+':'+job.progress;
    if(marker!==last){last=marker;console.log(JSON.stringify({status:job.status,stage:job.stage,progress:job.progress,elapsedMs:Math.round(performance.now()-started)}));}
    if(job.status==='completed'||job.status==='failed')break;
    if(fs.existsSync(path.join(output,'STOP')))throw Object.assign(new Error('사용자가 검증을 중지했습니다.'),{code:'INTERRUPTED'});
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  if(job?.status!=='completed')throw Object.assign(new Error(job?.error??'실제 처리 시간이 제한을 넘었습니다.'),{code:job?.errorCode??'INFERENCE_TIMEOUT',jobId:created.id});
  const result=await store.getResult(owner,created.id);
  await fsp.writeFile(path.join(output,'studio-result.json'),JSON.stringify(result),{flag:'wx'});
  const preserved=sha(await fsp.readFile(input))===originalHash;
  if(!preserved)throw new Error('검증 입력이 변경되었습니다.');
  const evidence={status:'completed',scope:'LOCAL_SOURCE_EXECUTION',browserFlowVerified:false,jobId:created.id,
    sourceSha256:originalHash,originalPreserved:preserved,regions:result.blocks.length,
    elapsedProcessingMs:Math.round(performance.now()-started),qualityStatus:'pending',manualCorrections:0,
    jobDirectory:path.join(config.dataRoot,created.id)};
  await fsp.writeFile(path.join(output,'verification-engine.json'),JSON.stringify(evidence,null,2),{flag:'wx'});
  await store.close();console.log(JSON.stringify(evidence));app.exit(0);
}
main().catch(async error=>{
  await Promise.allSettled([Promise.resolve().then(()=>store?.close()),Promise.resolve().then(()=>engine?.close())]);
  fs.writeFileSync(path.join(output,'verification-failure.json'),JSON.stringify({status:'failed',code:error.code??'VERIFICATION_FAILED',message:error.message,jobId:error.jobId??null,browserFlowVerified:false},null,2));
  console.error(JSON.stringify({status:'failed',code:error.code??'VERIFICATION_FAILED',message:error.message}));app.exit(1);
});
