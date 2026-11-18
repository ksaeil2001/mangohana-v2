// Pinned public weights only. User images are never sent to the network.
import fs from 'node:fs/promises';
import {createWriteStream,constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Readable,Transform} from 'node:stream';
const commit='16e8a622f91fabc6b5b65c96d32d1183f8843546';
const root='E:/Dev/Models/MangohanaV2-vision/ogkalu-16e8a622';
const files=[
 {name:'detector_int8.onnx',size:43838857,sha256:'b5022ad46416b6fe4f88b0cc082cfd2ff5b1cfc624088c2f19879485493f5913'},
 {name:'detector-v4-s_int8.onnx',size:11120765,sha256:'5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79'},
];
await fs.mkdir(root,{recursive:true});
for(const file of files){
 const target=path.join(root,file.name);const url=`https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/${commit}/${file.name}`;
 try{await fs.access(target);const bytes=await fs.readFile(target);if(bytes.length!==file.size||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('existing weight conflict');console.log('VERIFIED_EXISTING='+target);continue;}catch(error){if(error.code!=='ENOENT')throw error;}
 const response=await fetch(url);if(!response.ok)throw new Error('weight download failed: '+response.status);
 const temporary=target+'.'+randomUUID()+'.partial';let size=0;const digest=createHash('sha256');
 const inspect=new Transform({transform(chunk,encoding,callback){size+=chunk.length;if(size>file.size)return callback(new Error('weight size exceeded'));digest.update(chunk);callback(null,chunk);}});
 await pipeline(Readable.fromWeb(response.body),inspect,createWriteStream(temporary,{flags:'wx'}));
 if(size!==file.size||digest.digest('hex')!==file.sha256)throw new Error('downloaded weight integrity failed');
 await fs.copyFile(temporary,target,constants.COPYFILE_EXCL);await fs.unlink(temporary);
 console.log('VERIFIED_DOWNLOAD='+target);
}
for(const name of ['README.md','config.json','preprocessor_config.json']){
 const url=`https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/${commit}/${name}`;
 const response=await fetch(url);if(!response.ok)throw new Error('metadata download failed');const bytes=Buffer.from(await response.arrayBuffer());
 if(bytes.length>65536)throw new Error('metadata size exceeded');
 const target=path.join(root,name);try{await fs.writeFile(target,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST'||!(await fs.readFile(target)).equals(bytes))throw error;}
}
const provenance=Buffer.from(JSON.stringify({repository:'ogkalu/comic-text-and-bubble-detector',commit,license:'apache-2.0',files},null,2));
try{await fs.writeFile(path.join(root,'provenance.json'),provenance,{flag:'wx'});}
catch(error){if(error.code!=='EEXIST'||!(await fs.readFile(path.join(root,'provenance.json'))).equals(provenance))throw error;}
console.log('MODEL_ROOT='+root);
