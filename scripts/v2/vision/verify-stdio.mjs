import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const config=JSON.parse(await fs.readFile('E:/Dev/Outputs/MangohanaV2-20261111/engine-config.json','utf8'));
const output='E:/Dev/Outputs/MangohanaV2-20261111/vision-stdio-'+new Date().toISOString().replaceAll(':','-');
await fs.mkdir(output,{recursive:false});
const inputRoot='E:/Dev/Outputs/MangohanaV2-20261111/inputs-japanese';
const files=(await fs.readdir(inputRoot)).filter(name=>name.endsWith('.png')).sort().slice(0,3);
const results=[];
for(const file of files){
 const bytes=await fs.readFile(path.join(inputRoot,file));
 const request=JSON.stringify({version:1,imagePngBase64:bytes.toString('base64')})+'\n';
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(config.python,['-I','-B','scripts/v2/vision/region_detector.py','--model','E:/Dev/Models/MangohanaV2-vision/ogkalu-16e8a622/detector-v4-s_int8.onnx'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot,PATH:path.dirname(config.python),TEMP:output,TMP:output,HF_HUB_OFFLINE:'1'}});
  let stdout='',stderr=0;const timer=setTimeout(()=>child.kill('SIGKILL'),15_000);
  child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>512*1024)child.kill('SIGKILL');});
  child.stderr.on('data',chunk=>{stderr+=chunk.length;if(stderr>65536)child.kill('SIGKILL');});
  child.once('error',reject);child.once('close',code=>{clearTimeout(timer);try{if(code!==0)throw new Error('detector exit '+code+': '+stdout);resolve(JSON.parse(stdout));}catch(error){reject(error);}});
  child.stdin.end(request);
 });
 const hash=createHash('sha256').update(bytes).digest('hex');
 if(!result.ok||result.imageSha256!==hash||result.executionProvider!=='CPUExecutionProvider')throw new Error('detector source identity failed');
 if(createHash('sha256').update(await fs.readFile(path.join(inputRoot,file))).digest('hex')!==hash)throw new Error('input changed');
 results.push({file,...result,originalPreserved:true});
 console.log(JSON.stringify({file:file.slice(0,3),regions:result.regions.length,textBubbles:result.regions.filter(x=>x.kind==='text_bubble').length,measurements:result.measurements}));
}
await fs.writeFile(path.join(output,'verification.json'),JSON.stringify({scope:'ACTUAL_LOCAL_REGION_DETECTOR_STDIO',imagesUploaded:false,originalsPreserved:true,results},null,2),{flag:'wx'});
console.log('STDIO_OUTPUT='+output);
