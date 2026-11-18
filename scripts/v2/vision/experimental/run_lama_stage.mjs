// Isolated LaMa-only candidate evaluation. Never publishes a product job.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const [configFile,sourceFile,maskFile,output]=process.argv.slice(2);
if(![configFile,sourceFile,maskFile,output].every(value=>value&&path.isAbsolute(value)))throw new Error('absolute args required');
await fs.mkdir(output,{recursive:false});
const config=JSON.parse(await fs.readFile(configFile,'utf8'));
const bridge=path.resolve('packages/ai-engine/vendor/trio/scripts/sites-local/lama-stdio.py');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=await fs.readFile(sourceFile),mask=await fs.readFile(maskFile);
if(source.length>32*1024*1024||mask.length>32*1024*1024)throw new Error('input limit');
const sourceHash=sha(source),maskHash=sha(mask);
const pinnedFiles=[bridge,config.lamaWorker,config.lamaTileWrapper,config.lamaModel];
const pins=await Promise.all(pinnedFiles.map(async file=>({file,sha256:sha(await fs.readFile(file))})));
const started=performance.now();
const execution=await new Promise((resolve,reject)=>{
 const child=spawn(config.python,['-I','-B',bridge,'--python',config.python,'--worker',config.lamaWorker,'--model',config.lamaModel,'--tile-wrapper',config.lamaTileWrapper,'--log-dir',output],
  {cwd:path.dirname(config.python),windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot,PATH:path.dirname(config.python),TEMP:output,TMP:output,HF_HUB_OFFLINE:'1'}});
 let stdout='',stderrBytes=0,cancelled=false,forceTimer;
 const cancel=()=>{if(cancelled)return;cancelled=true;child.stdin.end('{"cancel":true}\n');forceTimer=setTimeout(()=>{
  if(process.platform==='win32'&&child.pid)spawn(path.join(process.env.SystemRoot,'System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
  else child.kill('SIGKILL');
 },5000);};
 const timer=setTimeout(cancel,120_000);
 child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>48*1024*1024)cancel();});
 child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>65536)cancel();});
 child.stdin.on('error',()=>{});
 child.once('error',reject);
 child.once('close',code=>{clearTimeout(timer);clearTimeout(forceTimer);try{resolve({code,reply:JSON.parse(stdout),stderrBytes,cancelled,childPid:child.pid});}catch(error){reject(error);}});
 child.stdin.write(JSON.stringify({image:source.toString('base64'),mask:mask.toString('base64')})+'\n');
});
const elapsedMs=performance.now()-started;
const {reply}=execution;
const {imagePngBase64,...evidence}=reply;
await fs.writeFile(path.join(output,'stage-result.json'),JSON.stringify({scope:'LAMA_STAGE_ONLY_NOT_PRODUCT_COMPLETION',sourceFile,maskFile,sourceSha256:sourceHash,maskSha256:maskHash,pins,
 elapsedMs,childPid:execution.childPid,exitCode:execution.code,stderrBytes:execution.stderrBytes,cancelled:execution.cancelled,result:evidence},null,2),{flag:'wx'});
if(execution.code!==0||execution.cancelled||!reply.ok||reply.verification?.cleanupConfirmed!==true||reply.verification.normalizedImageSha256!==sourceHash||reply.verification.maskSha256!==maskHash)throw new Error('LaMa stage evidence failed');
const png=Buffer.from(imagePngBase64,'base64');
if(sha(png)!==reply.verification.cleanedSha256)throw new Error('cleaned digest mismatch');
if(sha(await fs.readFile(sourceFile))!==sourceHash||sha(await fs.readFile(maskFile))!==maskHash)throw new Error('source/mask changed');
await fs.writeFile(path.join(output,'stage-cleaned.png'),png,{flag:'wx'});
console.log(JSON.stringify({scope:'LAMA_STAGE_ONLY',output,elapsedMs,verification:reply.verification}));
