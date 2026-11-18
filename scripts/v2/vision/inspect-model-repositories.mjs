// Read public metadata only. No inference or user image transmission.
import fs from 'node:fs/promises';
import path from 'node:path';
const output='E:/Dev/Outputs/MangohanaV2-20261111/vision-model-research-'+new Date().toISOString().replaceAll(':','-');
await fs.mkdir(output,{recursive:false});
for(const id of ['ogkalu/comic-text-and-bubble-detector','TareHimself/comic-text-mask']){
 const response=await fetch('https://huggingface.co/api/models/'+id+'?blobs=true');
 if(!response.ok)throw new Error('public metadata failed: '+response.status);
 const metadata=await response.json();
 await fs.writeFile(path.join(output,id.replace('/','--')+'.json'),JSON.stringify(metadata,null,2),{flag:'wx'});
 console.log(JSON.stringify({id,sha:metadata.sha,license:metadata.cardData?.license,files:metadata.siblings.map(file=>({name:file.rfilename,size:file.size,lfs:file.lfs}))}));
}
console.log('RESEARCH_OUTPUT='+output);
