// Pinned public 9B evaluation model/projector; no inference or product config edit.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ensureResource} from '../resources.mjs';
const repo='unsloth/Qwen3.5-9B-GGUF',revision='3885219b6810b007914f3a7950a8d1b469d598a5';
const baseRepo='Qwen/Qwen3.5-9B',baseRevision='c202236235762e1c871ad0ccb60c8ee5ba337b9a';
const directory='E:/Dev/Models/MangohanaV2-semantic/qwen35-9b-3885219b';
const output='E:/Dev/Outputs/MangohanaV2-20261111/semantic-qwen9b-prepare-'+new Date().toISOString().replaceAll(':','-');
await fs.mkdir(output,{recursive:false});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function metadata(url){const response=await fetch(url,{signal:AbortSignal.timeout(30_000)});if(!response.ok)throw new Error('METADATA_HTTP_'+response.status);const bytes=Buffer.from(await response.arrayBuffer());if(!bytes.length||bytes.length>2*1024*1024)throw new Error('METADATA_LIMIT');return bytes;}
const quantBytes=await metadata('https://huggingface.co/api/models/'+repo+'/revision/'+revision+'?blobs=true');
const baseBytes=await metadata('https://huggingface.co/api/models/'+baseRepo+'/revision/'+baseRevision+'?blobs=true');
const quant=JSON.parse(quantBytes),base=JSON.parse(baseBytes);
for(const [value,expected]of [[quant,revision],[base,baseRevision]])if(value.sha!==expected||value.gated!==false||value.cardData?.license!=='apache-2.0')throw new Error('MODEL_ACCESS_OR_LICENSE_CHANGED');
await fs.writeFile(path.join(output,'quant-metadata.json'),quantBytes,{flag:'wx'});await fs.writeFile(path.join(output,'base-metadata.json'),baseBytes,{flag:'wx'});
const documents=[];
for(const name of ['LICENSE','README.md','config.json','preprocessor_config.json','chat_template.jinja']){
 const entry=base.siblings.find(file=>file.rfilename===name);if(!entry?.blobId||entry.size>256*1024)throw new Error('DOCUMENT_METADATA_INVALID');
 const url='https://huggingface.co/'+baseRepo+'/resolve/'+baseRevision+'/'+name,bytes=await metadata(url);
 const gitSha=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
 if(bytes.length!==entry.size||gitSha!==entry.blobId)throw new Error('DOCUMENT_IDENTITY_INVALID');
 if(name==='LICENSE'&&!/Apache License\s+Version 2\.0/.test(bytes.toString('utf8')))throw new Error('LICENSE_REVIEW_REQUIRED');
 await fs.writeFile(path.join(output,'base-'+name),bytes,{flag:'wx'});documents.push({name,url,bytes:bytes.length,sha256:sha(bytes),gitBlobSha1:gitSha});
}
const resources=[
 {id:'qwen35-9b-q4-k-m',fileName:'Qwen3.5-9B-Q4_K_M-3885219b.gguf',remoteName:'Qwen3.5-9B-Q4_K_M.gguf',bytes:5680522464,sha256:'03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8'},
 {id:'qwen35-9b-mmproj-f16',fileName:'mmproj-Qwen3.5-9B-F16-3885219b.gguf',remoteName:'mmproj-F16.gguf',bytes:918166080,sha256:'f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f'},
].map(resource=>({...resource,url:'https://huggingface.co/'+repo+'/resolve/'+revision+'/'+resource.remoteName}));
for(const resource of resources){const upstream=quant.siblings.find(file=>file.rfilename===resource.remoteName);if(upstream?.size!==resource.bytes||upstream.lfs?.sha256!==resource.sha256)throw new Error('MODEL_IDENTITY_INVALID');}
console.log(JSON.stringify({output,directory,revision,license:'Apache-2.0',gated:false}));
const results=[];
for(const resource of resources){let lastBucket=-1;
 const result=await ensureResource(resource,{directory,signal:AbortSignal.timeout(30*60_000),onProgress(update){const bucket=Math.floor((update.receivedBytes??0)/100_000_000);if(bucket!==lastBucket){lastBucket=bucket;console.log(JSON.stringify({id:resource.id,event:update.event,receivedBytes:update.receivedBytes,totalBytes:resource.bytes}));}}});
 results.push(result);console.log(JSON.stringify(result));
}
await fs.writeFile(path.join(output,'verification.json'),JSON.stringify({scope:'PUBLIC_PINNED_9B_MODEL_PREPARATION_NO_INFERENCE',repo,revision,baseRepo,baseRevision,license:'Apache-2.0',gated:false,documents,resources,results},null,2),{flag:'wx'});
console.log(JSON.stringify({output,status:'prepared',modelsStarted:0}));
