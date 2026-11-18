import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const root='E:/Dev/Outputs/MangohanaV2-20261111';
const config=JSON.parse(await fs.readFile(root+'/engine-config.json','utf8'));
const evidence=JSON.parse(await fs.readFile(root+'/vision-stdio-2026-11-10T20-18-06.261Z/verification.json','utf8'));
const output=root+'/vision-text-mask-stdio-'+new Date().toISOString().replaceAll(':','-');
await fs.mkdir(output,{recursive:false});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const results=[];
for(const page of evidence.results){
 const input=path.join(root,'inputs-japanese',page.file);
 const bytes=await fs.readFile(input);
 if(sha(bytes)!==page.imageSha256)throw new Error('source identity changed');
 const regions=page.regions.filter(region=>region.kind==='text_bubble').map(({id,bbox})=>({id,bbox}));
 const request=JSON.stringify({version:1,imagePngBase64:bytes.toString('base64'),regions})+'\n';
 const wallStart=performance.now();
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(config.python,['-I','-B','scripts/v2/vision/text_mask.py','--model','E:/Dev/Models/MangohanaV2-vision/text-mask-onnx-20261110T203802715Z/comic-text-mask-unet-resnet18-384.onnx'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot,PATH:path.dirname(config.python),TEMP:output,TMP:output,HF_HUB_OFFLINE:'1'}});
  let stdout='',stderrBytes=0;const timer=setTimeout(()=>child.kill('SIGKILL'),30_000);
  child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>10*1024*1024)child.kill('SIGKILL');});
  child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>65536)child.kill('SIGKILL');});
  child.once('error',reject);
  child.once('close',code=>{clearTimeout(timer);try{if(code!==0)throw new Error('mask helper exit '+code);resolve(JSON.parse(stdout));}catch(error){reject(error);}});
  child.stdin.end(request);
 });
 const processWallMs=performance.now()-wallStart;
 if(!result.ok||result.imageSha256!==page.imageSha256||result.executionProvider!=='CPUExecutionProvider'||result.maskKind!=='LEARNED_PIXEL_MASK'||result.algorithm!=='dual-context-consensus-v1'||result.qualityStatus!=='REQUIRES_REVIEW')throw new Error('result identity failed');
 if(result.regions.length!==regions.length||result.regions.some((region,index)=>region.id!==regions[index].id||region.maskPixels<=0||region.pixelsOutsideEnvelope!==0))throw new Error('result region identity failed');
 const prefix=page.file.slice(0,3);
 for(const [field,hashField,suffix] of [['maskPngBase64','maskSha256','mask-l'],['maskRgbaPngBase64','maskRgbaSha256','mask-rgba']]){
  const png=Buffer.from(result[field],'base64');
  if(sha(png)!==result[hashField])throw new Error('mask digest mismatch');
  await fs.writeFile(path.join(output,prefix+'-'+suffix+'.png'),png,{flag:'wx'});
  delete result[field];
 }
 if(sha(await fs.readFile(input))!==page.imageSha256)throw new Error('input changed');
 results.push({input,sourceRegions:regions,...result,processWallMs,originalPreserved:true});
 console.log(JSON.stringify({page:prefix,regions:regions.length,contextDisagreementPixels:result.regions.reduce((sum,region)=>sum+region.contextDisagreementPixels,0),measurements:result.measurements,processWallMs}));
}
await fs.writeFile(path.join(output,'verification.json'),JSON.stringify({scope:'REAL_LEARNED_PIXEL_MASK_STDIO_NOT_INPAINTING',imagesUploaded:false,originalsPreserved:true,results},null,2),{flag:'wx'});
console.log('TEXT_MASK_STDIO_OUTPUT='+output);
