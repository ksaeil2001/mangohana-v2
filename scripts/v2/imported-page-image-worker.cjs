'use strict';
// No queue, OCR service, Gemma client or network. Every stage waits for its live server gate.
const electron=require('electron'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const directory=path.resolve(process.argv[2]),input=JSON.parse(fs.readFileSync(path.join(directory,'input.json'))),{app,protocol}=electron;
// The fixed, signed font URL needs the same pre-ready scheme as the Stage12 host.
protocol.registerSchemesAsPrivileged([{scheme:'trio-resource',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.commandLine.appendSwitch('disable-gpu');app.commandLine.appendSwitch('disable-background-networking');
for(const key of ['userData','sessionData','temp','documents','home']){const p=path.join(input.config.profileRoot,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}app.on('window-all-closed',()=>{});
let sequence=0,lastCompletedGate=null;
async function gate(phase){
 const n=++sequence,nonce=randomUUID(),request={permitId:input.permit.permitId,executionGeneration:input.permit.executionGeneration,nonce,phase};
 await require('../../packages/ai-engine/quality/imported-image-diagnostics.cjs').publishGateJson(path.join(directory,'gate-request-'+n+'.json'),request);const expires=Date.now()+30000;
 while(Date.now()<expires){try{const response=await require('../../packages/ai-engine/quality/imported-image-diagnostics.cjs').readGateJson(path.join(directory,'gate-response-'+n+'.json'));if(response!==null){if(response.allowed===true&&['permitId','executionGeneration','nonce','phase'].every(k=>response[k]===request[k])){lastCompletedGate=phase;return;}throw Error('LIVE_PERMIT_GATE_REJECTED');}}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(resolve=>setTimeout(resolve,50));}throw Error('LIVE_PERMIT_GATE_TIMEOUT');
}
const forbidden={network:0,otherProcess:0},deny=kind=>()=>{forbidden[kind]++;throw Error('IMAGE_WORKER_FORBIDDEN_'+kind);};
globalThis.fetch=deny('network');for(const name of ['node:http','node:https'])for(const method of ['get','request'])require(name)[method]=deny('network');require('node:net').Socket.prototype.connect=deny('network');require('node:tls').connect=deny('network');require('node:dgram').createSocket=deny('network');
const cp=require('node:child_process'),spawn=cp.spawn,owned=new Set(),bridge=path.join(input.config.repository,'scripts/sites-local/lama-stdio.py');
cp.spawn=function(exe,args,options){const lama=path.resolve(exe)===path.resolve(input.config.python)&&args[0]==='-I'&&args[1]==='-B'&&path.resolve(args[2])===path.resolve(bridge),kill=path.basename(exe).toLowerCase()==='taskkill.exe'&&args[0]==='/PID'&&owned.has(Number(args[1]));if(!lama&&!kill)return deny('otherProcess')();const child=spawn.call(this,exe,args,options);if(lama)owned.add(child.pid);return child;};
for(const name of ['exec','execSync','execFile','execFileSync','spawnSync','fork'])cp[name]=deny('otherProcess');require('node:module').syncBuiltinESMExports();
async function main(){
 await app.whenReady();await gate('worker-start');
 const {executeImportedImagePipeline,createNativeImagePorts}=require('../../packages/ai-engine/quality/imported-image-pipeline.cjs'),controller=new AbortController();
 const args={...input,outputDirectory:directory,signal:controller.signal,revalidate:gate},ports=await createNativeImagePorts(args),result=await executeImportedImagePipeline(args,ports);
 if(Object.values(forbidden).some(Boolean))throw Error('IMAGE_WORKER_BOUNDARY_FAILED');await gate('before-worker-write');
 await fsp.writeFile(path.join(directory,'candidate.png'),result.pngBytes,{flag:'wx'});
 await fsp.writeFile(path.join(directory,'result.json'),JSON.stringify({permitId:input.permit.permitId,executionGeneration:input.permit.executionGeneration,pngSha256:createHash('sha256').update(result.pngBytes).digest('hex'),report:result.report,cleanupConfirmed:result.cleanupConfirmed,forbidden},null,2),{flag:'wx'});
}
main().catch(async e=>{await require('../../packages/ai-engine/quality/imported-image-diagnostics.cjs').writeWorkerFailure({directory,record:{version:1,permitId:input.permit.permitId,executionGeneration:input.permit.executionGeneration,code:e.code??'IMAGE_WORKER_FAILED',message:e.message,lastCompletedGate,stack:typeof e.stack==='string'?e.stack.slice(0,16384):null,layoutDiagnostics:e.layoutDiagnostics??null,diagnosticArtifacts:e.diagnosticArtifacts??null,diagnosticPersistenceError:e.diagnosticPersistenceError??null,additionalDiagnosticPersistenceError:e.additionalDiagnosticPersistenceError??null,actualCalls:e.actualCalls??null,cleanupConfirmed:e.cleanupConfirmed??null,forbidden}});process.exitCode=1;}).finally(()=>app.exit(process.exitCode??0));
