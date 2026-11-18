import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {readBaseline} from './baseline.mjs';
import {runModel} from './runtime.mjs';
import {structuredRequest,parseStructured} from './protocol.mjs';
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--job'||args[2]!=='--scene-file')throw new Error('ORACLE_ARGUMENTS_REQUIRED');
const baseline=await readBaseline(args[1]),sceneBytes=await fs.readFile(path.resolve(args[3]));
if(sceneBytes.length>8192)throw new Error('SCENE_LIMIT');
const scene=JSON.parse(sceneBytes);
if(scene.kind!=='ORACLE_SCENE_CONTEXT_ABLATION'||scene.sceneManuallyProvided!==true||typeof scene.sceneFacts!=='string'||!scene.sceneFacts.trim()||scene.sceneFacts.length>2000||Object.keys(scene).sort().join(',')!=='kind,sceneFacts,sceneManuallyProvided')throw new Error('ORACLE_SCENE_INVALID');
const output='E:/Dev/Outputs/MangohanaV2-20261111/semantic-oracle-scene-'+new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8);
await fs.mkdir(output,{recursive:false});await fs.writeFile(path.join(output,'manual-scene-input.json'),sceneBytes,{flag:'wx'});
const resource={id:'hy-mt2-18b-q8-0',fileName:'Hy-MT2-1.8B-Q8_0-a0c709d9.gguf',url:'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/a0c709d9fac510f2c807aa3af52872340dc37a4a/Hy-MT2-1.8B-Q8_0.gguf',bytes:1908528192,sha256:'5c3fe0b1408a5ceb0143184ef247b11b579c525f4b02b060e6c851bb76fef1a4'};
const parameters={temperature:.7,top_p:.6,top_k:20,repeat_penalty:1.05,seed:42,cache_prompt:false,max_tokens:2048};
console.log(JSON.stringify({output,kind:scene.kind,sceneManuallyProvided:true}));
const result=await runModel({output,resource,directory:'E:/Dev/Models/MangohanaV2-semantic/hy-mt2-1.8b-a0c709d9',alias:'hy-mt2-18b-semantic',async evaluate(request){
 const body=structuredRequest(baseline.lines);
 body.messages[0].content='[Visual Scene Context — Manually Provided for Diagnostic Ablation]\n'+JSON.stringify(scene.sceneFacts)+'\n'+body.messages[0].content;
 const response=await request('oracle-scene-page',{...parameters,...body});
 return {regions:parseStructured(response.content,baseline.lines),responseIdentity:'validated_page_json_ids',requestId:response.requestId};
}});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const evidence={kind:scene.kind,sceneManuallyProvided:true,automaticProductResult:false,sourceTextManuallyCorrected:false,
 sourceJob:baseline.job,sourceImageSha256:baseline.imageSha256,sourceReportSha256:baseline.reportSha256,sceneSha256:sha(sceneBytes),sceneFacts:scene.sceneFacts,
 imagesSentToModel:false,pageTextContextConsumed:true,parameters,...result,
 sourceCodeHashes:Object.fromEntries(await Promise.all(['probe-oracle-scene.mjs','baseline.mjs','runtime.mjs','protocol.mjs'].map(async name=>[name,sha(await fs.readFile(new URL(name,import.meta.url)))])))};
await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(evidence,null,2),{flag:'wx'});
console.log(JSON.stringify({output,...evidence}));if(result.failure)process.exitCode=1;
