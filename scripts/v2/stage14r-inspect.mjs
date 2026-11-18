// Read-only installed GGUF metadata and Stage14 envelopes; never loads a model.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const audit=process.argv[2],old='E:/Dev/Outputs/MangohanaV2-20261111/tests/MangoHana_14_20261113_172552/single-page-b4de0581';
const config=JSON.parse(await fs.readFile(path.join(old,'config.json'),'utf8'));
const handle=await fs.open(config.gemmaModel,'r'),buffer=Buffer.alloc(32*1024*1024);
const {bytesRead}=await handle.read(buffer,0,buffer.length,0);await handle.close();
let offset=4;
const u32=()=>{const v=buffer.readUInt32LE(offset);offset+=4;return v;};
const u64=()=>{const v=Number(buffer.readBigUInt64LE(offset));offset+=8;if(!Number.isSafeInteger(v))throw Error('UNSAFE_METADATA_LENGTH');return v;};
const string=()=>{const n=u64();if(offset+n>bytesRead)throw Error('METADATA_LIMIT');const s=buffer.toString('utf8',offset,offset+n);offset+=n;return s;};
function value(type,keep=false){
 if(type===8)return string();
 if(type===9){const t=u32(),n=u64();for(let i=0;i<n;i++)value(t,false);return {elementType:t,length:n};}
 const widths={0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8};
 const width=widths[type];if(!width)throw Error('UNSUPPORTED_GGUF_TYPE');
 const start=offset;offset+=width;if(offset>bytesRead)throw Error('METADATA_LIMIT');
 return keep?(type===7?buffer[start]!==0:type===4?buffer.readUInt32LE(start):type===5?buffer.readInt32LE(start):buffer.subarray(start,offset).toString('hex')):null;
}
if(buffer.toString('ascii',0,4)!=='GGUF')throw Error('GGUF_REQUIRED');
const version=u32(),tensorCount=u64(),count=u64(),metadata={};
for(let i=0;i<count;i++){const key=string(),type=u32(),keep=/chat_template|general\.(architecture|name|file_type)|context_length|tokenizer\.ggml\.(bos_token_id|eos_token_id)/.test(key);const v=value(type,keep);if(keep)metadata[key]=v;}
const template=metadata['tokenizer.chat_template'];if(typeof template!=='string')throw Error('CHAT_TEMPLATE_REQUIRED');
const envelopePath='C:/dev/Projects/_audits/MangoHana_14_20261113_172552/evidence/runtime-snapshots/C-translation-response-page.json';
const envelope=JSON.parse(await fs.readFile(envelopePath,'utf8')),r=envelope.response,c=r.choices[0];
const result={scope:'NO_INFERENCE_INSTALLED_METADATA_AND_SAVED_RESPONSE',model:config.gemmaModel,version,tensorCount,metadataCount:count,metadataBytes:offset,metadata,templateSha256:createHash('sha256').update(template).digest('hex'),oldConfig:config,response:{model:r.model,finishReason:c.finish_reason,contentBytes:Buffer.byteLength(c.message.content??''),reasoningBytes:Buffer.byteLength(c.message.reasoning_content??''),usage:r.usage},additionalModelCalls:0};
await fs.writeFile(path.join(audit,'evidence/installed-template.json'),JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({...result,metadata:undefined,oldConfig:undefined,templateRelevantLines:template.split('\n').map((text,i)=>({line:i+1,text})).filter(x=>/enable_thinking|thinking|channel|generation_prompt|model\\n/.test(x.text))},null,2));
