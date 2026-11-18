'use strict';
// Owned Electron main. Every inference, network, renderer and image creation boundary throws.
const electron=require('electron'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),Module=require('node:module');
const {app}=electron,directory=path.resolve(process.argv[2]),run=JSON.parse(fs.readFileSync(path.join(directory,'input.json')));
app.commandLine.appendSwitch('disable-gpu');app.commandLine.appendSwitch('disable-background-networking');
for(const key of ['userData','sessionData','temp','documents','home']){const dest=path.join(run.config.profileRoot,key);fs.mkdirSync(dest,{recursive:true});app.setPath(key,dest);}
app.on('window-all-closed',()=>{});
const calls={processSpawn:0,network:0,renderer:0,imageCreation:0,imageWrite:0,externalWrite:0},forbidden=[];
const deny=kind=>(..._args)=>{calls[kind]++;forbidden.push({kind});throw Error('IMPORTED_INPUT_FORBIDDEN_'+kind);};
for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[k]=deny('processSpawn');
globalThis.fetch=deny('network');for(const name of ['node:http','node:https'])for(const k of ['get','request'])require(name)[k]=deny('network');
require('node:net').Socket.prototype.connect=deny('network');require('node:tls').connect=deny('network');require('node:dgram').createSocket=deny('network');
const originalLoad=Module._load;Module._load=function(request){if(request==='electron')return new Proxy(electron,{get(target,k){if(k==='BrowserWindow')return class{constructor(){deny('renderer')();}};if(k==='nativeImage')return new Proxy(target.nativeImage,{get(_t,name){return String(name).startsWith('create')?deny('imageCreation'):Reflect.get(_t,name);}});if(k==='net')return {request:deny('network'),fetch:deny('network')};return Reflect.get(target,k);}});return originalLoad.apply(this,arguments);};
const permitted=file=>{const p=path.resolve(String(file));if(/\.(png|trio|ctp)$/i.test(p))deny('imageWrite')();if(p!==directory&&!p.startsWith(directory+path.sep))deny('externalWrite')();};
for(const name of ['writeFile','appendFile']){const original=fsp[name].bind(fsp);fsp[name]=async(file,...args)=>{permitted(file);return original(file,...args);};}
for(const name of ['writeFileSync','appendFileSync','createWriteStream']){const original=fs[name].bind(fs);fs[name]=(file,...args)=>{permitted(file);return original(file,...args);};}
const originalOpen=fsp.open.bind(fsp);fsp.open=async(file,flags,...args)=>{if(typeof flags==='number'||/[wa+]/.test(flags))permitted(file);return originalOpen(file,flags,...args);};
Module.syncBuiltinESMExports();
let engine,timer;const started=Date.now();
async function main(){
 await app.whenReady();
 const {createEngine}=require('../../packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs');engine=await createEngine(run.config);const health=engine.health();if(!health.ready)throw Error('ENGINE_NOT_READY: '+health.message);
 timer=setInterval(()=>console.log(JSON.stringify({phase:'IMPORTED_PAGE_INPUT_INSPECTION',elapsedMs:Date.now()-started,calls})),20000);
 const result=await engine.inspectImportedPageReadiness({binding:run.binding,source:run.source});
 if(result.ocrRegions!==13||result.userTranslationsUsable!==13||result.executionAuthorized!==false||Object.values(calls).some(Boolean))throw Error('IMPORTED_PAGE_INPUT_CONTRACT_FAILED');
 await fsp.writeFile(path.join(directory,'result.json'),JSON.stringify({...result,health,calls,forbidden,elapsedMs:Date.now()-started,engineRunInvoked:false},null,2),{flag:'wx'});
 console.log('OCR_REUSED=13/13\nUSER_TRANSLATIONS_USABLE=13/13\nIMAGE_EXECUTION_AUTHORIZED=false');
}
main().catch(async error=>{await fsp.writeFile(path.join(directory,'failure.json'),JSON.stringify({code:error.code??null,reason:error.reason??null,message:error.message,stack:error.stack,calls,forbidden},null,2),{flag:'wx'}).catch(()=>{});console.error(error);process.exitCode=1;}).finally(async()=>{clearInterval(timer);try{await engine?.close();}catch(error){console.error(error);process.exitCode=1;}app.exit(process.exitCode??0);});
