// Opt-in real AI verification. Do not run until the parent clears the 9B run.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const [authorization,configFile,detectorFile,output]=process.argv.slice(2);
if(authorization!=='--run-real-inference'||![configFile,detectorFile,output].every(value=>value&&path.isAbsolute(value)))throw new Error('Explicit --run-real-inference and absolute config/evidence/output paths required');
const config=JSON.parse(await fs.readFile(configFile,'utf8'));
const detector=JSON.parse(await fs.readFile(detectorFile,'utf8'));
const helper=path.resolve('scripts/v2/vision/experimental/v3_stdio.py');
const model=config.textMaskModel;
if(!model||!path.isAbsolute(model))throw new Error('Server-owned pinned textMaskModel required');
await fs.mkdir(output,{recursive:false});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const helperSha256=sha(await fs.readFile(helper));
const results=[];
for(const page of detector.results.slice(0,3)){
 const input=page.input??path.join(path.dirname(path.dirname(detectorFile)),'inputs-japanese',page.file);
 const bytes=await fs.readFile(input);
 if(sha(bytes)!==page.imageSha256)throw new Error('Current image does not match detector evidence');
 const regions=page.regions.filter(region=>region.kind==='text_bubble').map(({id,bbox})=>({id,bbox}));
 const started=performance.now();
 const execution=await new Promise((resolve,reject)=>{
  const child=spawn(config.python,['-I','-B',helper,'--model',model],{cwd:path.dirname(config.python),windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],
   env:{SystemRoot:process.env.SystemRoot,PATH:path.dirname(config.python),TEMP:output,TMP:output,HF_HUB_OFFLINE:'1'}});
  let stdout='',stderrBytes=0,stopped=false;
  const stop=()=>{stopped=true;child.kill('SIGKILL');};
  const timer=setTimeout(stop,30_000);
  child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>8*1024*1024)stop();});
  child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>65536)stop();});
  child.stdin.on('error',()=>{});child.once('error',reject);
  child.once('close',code=>{clearTimeout(timer);try{if(stopped||code!==0)throw new Error('V3 helper failed or exceeded bounds');resolve({reply:JSON.parse(stdout),stderrBytes});}catch(error){reject(error);}});
  child.stdin.end(JSON.stringify({version:1,imagePngBase64:bytes.toString('base64'),regions})+'\n');
 });
 const {reply}=execution;
 if(reply.version!==1||!reply.ok||reply.imageSha256!==page.imageSha256||reply.width!==page.width||reply.height!==page.height||reply.executionProvider!=='CPUExecutionProvider'||reply.model?.sha256!=='b10356a2a12f4dec4650e563724932e542764dbd3201a7e4cae6573597c5bea1'||reply.algorithm!=='source-ink-radial-halo-v3-experimental'||reply.qualityStatus!=='REQUIRES_REVIEW'||reply.clipPaddingPx!==2)throw new Error('V3 current image/model/algorithm mismatch');
 if(reply.regions.length!==regions.length||reply.regions.some((region,index)=>region.id!==regions[index].id||region.maskPixels<=0||region.pixelsOutsideEnvelope!==0))throw new Error('V3 member identity/nonempty/clip failed');
 const prefix=String(results.length+1).padStart(3,'0');
 for(const [field,hashField,suffix] of [['maskPngBase64','maskSha256','mask-l'],['maskRgbaPngBase64','maskRgbaSha256','mask-rgba']]){
  const png=Buffer.from(reply[field],'base64');if(sha(png)!==reply[hashField])throw new Error('V3 PNG checksum failed');
  await fs.writeFile(path.join(output,prefix+'-'+suffix+'.png'),png,{flag:'wx'});delete reply[field];
 }
 if(sha(await fs.readFile(input))!==page.imageSha256)throw new Error('Source image changed');
 results.push({input,sourceRegions:regions,...reply,processWallMs:performance.now()-started,stderrBytes:execution.stderrBytes,originalPreserved:true});
 console.log(JSON.stringify({page:prefix,regions:regions.length,maskSha256:reply.maskRgbaSha256,measurements:reply.measurements}));
}
if(sha(await fs.readFile(helper))!==helperSha256)throw new Error('Helper changed during verification');
await fs.writeFile(path.join(output,'verification.json'),JSON.stringify({scope:'REAL_V3_MASK_STDIO_ONLY_NOT_PRODUCT_QUALITY_APPROVAL',helperSha256,sourceEvidence:detectorFile,imagesUploaded:false,results},null,2),{flag:'wx'});
console.log('V3_STDIO_OUTPUT='+output);
