import fs from 'node:fs/promises';
import {createWriteStream,constants} from 'node:fs';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
const repository='TareHimself/comic-text-mask',revision='ebd37f1a9ae9298519678fb96a796573fb602977';
const root='E:/Dev/Models/MangohanaV2-vision/text-mask-ebd37f1a';
await fs.mkdir(root,{recursive:true});
const binary={name:'model.safetensors',size:57377484,sha256:'ab28dd8450462c4f87ddfd05d13601813bb90414f26bea5590bf6a0a7540f988'};
const manifest=[];
for(const item of [binary,...['config.json','tm_meta.json','README.md'].map(name=>({name}))]){
 const url=`https://huggingface.co/${repository}/resolve/${revision}/${item.name}`;
 const target=path.join(root,item.name);
 let bytes;try{bytes=await fs.readFile(target);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!bytes){
  const response=await fetch(url);if(!response.ok)throw new Error('public model download failed');
  const temporary=target+'.'+randomUUID()+'.partial';let size=0;
  const bounded=new Transform({transform(chunk,encoding,callback){size+=chunk.length;if(size>(item.size??65536))return callback(new Error('model size exceeded'));callback(null,chunk);}});
  await pipeline(Readable.fromWeb(response.body),bounded,createWriteStream(temporary,{flags:'wx'}));
  bytes=await fs.readFile(temporary);const digest=createHash('sha256').update(bytes).digest('hex');
  if(item.size&&(bytes.length!==item.size||digest!==item.sha256))throw new Error('model integrity failed');
  await fs.copyFile(temporary,target,constants.COPYFILE_EXCL);await fs.unlink(temporary);
 }
 const digest=createHash('sha256').update(bytes).digest('hex');
 if(item.size&&(bytes.length!==item.size||digest!==item.sha256))throw new Error('existing model integrity failed');
 manifest.push({name:item.name,bytes:bytes.length,sha256:digest,url});
}
const data=Buffer.from(JSON.stringify({repository,revision,license:'mit',remotePythonCodeExecuted:false,torchScriptExecuted:false,files:manifest},null,2));
try{await fs.writeFile(path.join(root,'provenance.json'),data,{flag:'wx'});}catch(error){if(error.code!=='EEXIST'||!(await fs.readFile(path.join(root,'provenance.json'))).equals(data))throw error;}
console.log(JSON.stringify({modelRoot:root,files:manifest}));
