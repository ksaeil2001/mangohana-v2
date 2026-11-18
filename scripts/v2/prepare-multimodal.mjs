import fs from 'node:fs/promises';
import {ensureResource} from './resources.mjs';
const catalog=JSON.parse(await fs.readFile(new URL('./multimodal-resources.json',import.meta.url),'utf8'));
let last=-1;
const filterIndex=process.argv.indexOf('--id-prefix');
const selected=filterIndex<0?catalog.resources:catalog.resources.filter(resource=>resource.id.startsWith(process.argv[filterIndex+1]??'___'));
if(!selected.length)throw new Error('Unknown resource prefix');
for(const resource of selected){
 const result=await ensureResource(resource,{directory:'E:/Dev/Models',onProgress(update){
  const bucket=Math.floor((update.receivedBytes??0)/100_000_000);
  if(bucket!==last){last=bucket;console.log(JSON.stringify({id:resource.id,event:update.event,receivedBytes:update.receivedBytes,totalBytes:resource.bytes}));}
 }});
 console.log(JSON.stringify(result));
}
