'use strict';
// Real installed Electron + current createEngine input inspector. Never engine.run.
const electron=require('electron'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),Module=require('node:module');
const {app}=electron,directory=process.argv[2],run=JSON.parse(fs.readFileSync(path.join(directory,'preflight-config.json'),'utf8'));
app.commandLine.appendSwitch('disable-gpu');app.commandLine.appendSwitch('disable-background-networking');
for(const key of ['userData','sessionData','temp','documents','home']){const dest=path.join(run.config.profileRoot,key);fs.mkdirSync(dest,{recursive:true});app.setPath(key,dest);}
app.on('window-all-closed',()=>{});
const forbidden=[],calls={processSpawn:0,network:0,renderer:0,imageWrite:0};
function forbid(kind){return (...args)=>{calls[kind]++;forbidden.push({kind,firstArgument:typeof args[0]==='string'?args[0].slice(0,250):null});throw Error('PREFLIGHT_FORBIDDEN_'+kind);};}
const cp=require('node:child_process');for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[key]=forbid('processSpawn');
globalThis.fetch=forbid('network');for(const protocol of ['node:http','node:https']){const api=require(protocol);api.request=forbid('network');api.get=forbid('network');}
const originalLoad=Module._load;Module._load=function(request,parent,isMain){if(request==='electron')return new Proxy(electron,{get(target,key){return key==='BrowserWindow'?class{constructor(){forbid('renderer')();}}:Reflect.get(target,key);}});return originalLoad.apply(this,arguments);};
const originalWrite=fsp.writeFile.bind(fsp);fsp.writeFile=async(file,...args)=>{if(/\.(?:png|trio|ctp)$/i.test(String(file)))forbid('imageWrite')(String(file));return originalWrite(file,...args);};
let engine,timer;const started=Date.now();
async function main(){
 await app.whenReady();
 const {createEngine}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs');
 engine=await createEngine(run.config);const health=engine.health();if(!health.ready)throw Error('ENGINE_NOT_READY: '+health.message);
 timer=setInterval(()=>console.log(JSON.stringify({phase:'READ_ONLY_FINGERPRINT_VALIDATION',elapsedMs:Date.now()-started,forbiddenCalls:calls})),20000);
 const packet=JSON.parse(await fsp.readFile(run.packetPath,'utf8')),submission=JSON.parse(await fsp.readFile(run.submissionPath,'utf8'));
 const state=JSON.parse(await fsp.readFile(path.join(run.sourceDirectory,'state.json'),'utf8'));
 const result=await engine.inspectInputReadiness({inputPath:path.join(run.sourceDirectory,'source.png'),sourceLanguage:state.sourceLanguage,ownerScope:state.owner,projectId:state.projectId,pageId:state.pageId,pageNumber:state.pageNumber,
  resumeFrom:{directory:run.sourceDirectory,jobId:state.id,checkpoints:state.checkpoints},resolveOcrCompatibility:async()=>({...run.sourceEvidence,expectedGeneration:state.sequence}),reviewDraft:{packet,submission}});
 if(forbidden.length||!result.ocrReusable||result.reviewDraft?.completed!==0||result.approvedTranslationsUsable)throw Error('READINESS_BOUNDARY_FAILED');
 const receipt={scope:'REAL_CURRENT_ENGINE_READ_ONLY_INPUT_INSPECTION_NOT_IMAGE_EXECUTION',...result,health,calls,forbidden,elapsedMs:Date.now()-started,engineRunInvoked:false,actualUserApprovalApplied:false,independentGroundTruthVerified:false};
 await originalWrite(run.outputFile,JSON.stringify(receipt,null,2),{flag:'wx'});console.log(JSON.stringify({status:receipt.status,ocrReusable:receipt.ocrReusable,ocrRegions:receipt.ocrRegions,review:receipt.reviewDraft,calls,outputFile:run.outputFile}));
}
main().catch(async error=>{await originalWrite(run.failureFile,JSON.stringify({status:'FAILED',code:error.code??null,message:error.message,reason:error.reason??null,stack:error.stack,calls,forbidden,elapsedMs:Date.now()-started},null,2),{flag:'wx'}).catch(()=>{});console.error(error);process.exitCode=1;}).finally(async()=>{clearInterval(timer);try{await engine?.close();}catch(error){console.error(error);process.exitCode=1;}app.exit(process.exitCode??0);});
