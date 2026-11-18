// Metadata and one public, pinned model only. Does not perform inference.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ensureResource} from '../resources.mjs';

const repo='tencent/Hy-MT2-1.8B-GGUF',revision='a0c709d9fac510f2c807aa3af52872340dc37a4a';
const directory='E:/Dev/Models/MangohanaV2-semantic/hy-mt2-1.8b-a0c709d9';
const output='E:/Dev/Outputs/MangohanaV2-20261111/semantic-prepare-'+new Date().toISOString().replaceAll(':','-');
await fs.mkdir(output,{recursive:false});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function downloadMetadata(url,limit=2*1024*1024){
 const response=await fetch(url,{signal:AbortSignal.timeout(30_000)});
 if(!response.ok)throw new Error('METADATA_HTTP_'+response.status);
 const bytes=Buffer.from(await response.arrayBuffer());
 if(!bytes.length||bytes.length>limit)throw new Error('METADATA_LIMIT');
 return bytes;
}
const api='https://huggingface.co/api/models/'+repo+'/revision/'+revision+'?blobs=true';
const metadataBytes=await downloadMetadata(api),metadata=JSON.parse(metadataBytes);
if(metadata.sha!==revision||metadata.gated!==false||metadata.cardData?.license!=='apache-2.0')throw new Error('MODEL_ACCESS_OR_LICENSE_CHANGED');
await fs.writeFile(path.join(output,'upstream-metadata.json'),metadataBytes,{flag:'wx'});
const documents=[];
for(const name of ['README.md','LICENSE.txt']){
 const entry=metadata.siblings.find(file=>file.rfilename===name);
 if(!entry?.blobId||entry.size>64*1024)throw new Error('DOCUMENT_METADATA_INVALID');
 const url='https://huggingface.co/'+repo+'/resolve/'+revision+'/'+name;
 const bytes=await downloadMetadata(url,64*1024);
 const gitSha=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
 if(bytes.length!==entry.size||gitSha!==entry.blobId)throw new Error('DOCUMENT_IDENTITY_INVALID');
 await fs.writeFile(path.join(output,name),bytes,{flag:'wx'});
 if(name==='LICENSE.txt'&&(!/Apache License\s+Version 2\.0/.test(bytes.toString('utf8'))||/THIS LICENSE AGREEMENT DOES NOT APPLY|excluding[^\n]*South Korea/i.test(bytes.toString('utf8'))))throw new Error('LICENSE_REVIEW_REQUIRED');
 documents.push({name,url,bytes:bytes.length,sha256:sha(bytes),gitBlobSha1:gitSha});
}
const resource={id:'hy-mt2-18b-q8-0',fileName:'Hy-MT2-1.8B-Q8_0-a0c709d9.gguf',
 url:'https://huggingface.co/'+repo+'/resolve/'+revision+'/Hy-MT2-1.8B-Q8_0.gguf',
 bytes:1908528192,sha256:'5c3fe0b1408a5ceb0143184ef247b11b579c525f4b02b060e6c851bb76fef1a4'};
const upstream=metadata.siblings.find(file=>file.rfilename==='Hy-MT2-1.8B-Q8_0.gguf');
if(upstream?.size!==resource.bytes||upstream.lfs?.sha256!==resource.sha256)throw new Error('MODEL_IDENTITY_INVALID');
console.log(JSON.stringify({output,directory,repo,revision,license:metadata.cardData.license,gated:metadata.gated}));
let lastBucket=-1;
const result=await ensureResource(resource,{directory,signal:AbortSignal.timeout(30*60_000),onProgress(update){
 const bucket=Math.floor((update.receivedBytes??0)/100_000_000);
 if(bucket!==lastBucket){lastBucket=bucket;console.log(JSON.stringify({event:update.event,receivedBytes:update.receivedBytes,totalBytes:resource.bytes}));}
}});
await fs.writeFile(path.join(output,'verification.json'),JSON.stringify({scope:'PUBLIC_PINNED_MODEL_PREPARATION_NO_INFERENCE',repo,revision,license:'Apache-2.0',gated:false,documents,resource,result},null,2),{flag:'wx'});
console.log(JSON.stringify({output,...result}));
