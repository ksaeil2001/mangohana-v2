// Record the exact wheels used by the isolated one-off export environment.
import fs from 'node:fs/promises';
import path from 'node:path';
const cache='E:/Dev/Cache/MangohanaV2-vision';
const normalized=name=>name.toLowerCase().replaceAll('_','-').replaceAll('.','-');
const installed=new Map();
for(const reportName of ['torch-install-report.json','text-mask-packages-report.json']){
 const report=JSON.parse(await fs.readFile(path.join(cache,reportName),'utf8'));
 for(const item of report.install){
  const url=new URL(item.download_info.url);
  if(url.username||url.password||/token|auth|secret/i.test(url.search))throw new Error('credentials must not enter the lock');
  const sha256=item.download_info.archive_info?.hashes?.sha256;
  if(!/^[a-f0-9]{64}$/.test(sha256??''))throw new Error('wheel hash missing');
  installed.set(normalized(item.metadata.name),{name:item.metadata.name,version:item.metadata.version,url:url.href,sha256});
 }
}
const frozen=(await fs.readFile(path.join(cache,'text-mask-runtime-freeze.txt'),'utf8')).replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(line=>{const [name,version]=line.split('==');return {name,version};});
const wheels=[];
for(const item of frozen){
 if(normalized(item.name)==='pip')continue; // Bootstrapped by the recorded Python 3.12.14 venv.
 const wheel=installed.get(normalized(item.name));
 if(!wheel||wheel.version!==item.version)throw new Error('freeze/report mismatch: '+item.name);
 wheels.push(wheel);
}
wheels.sort((a,b)=>normalized(a.name).localeCompare(normalized(b.name)));
const lock={scope:'ISOLATED_CPU_MODEL_EXPORT_ONLY',python:'3.12.14',bootstrapPip:'25.0.1',environmentRoot:'E:/Dev/Models/Runtimes/text-mask-export-py312-20261111',wheels};
await fs.writeFile(path.join(cache,'text-mask-runtime-wheel-lock.json'),JSON.stringify(lock,null,2),{flag:'wx'});
await fs.writeFile(path.join(cache,'text-mask-runtime-hashed-requirements.txt'),wheels.map(item=>`${item.name} @ ${item.url} --hash=sha256:${item.sha256}`).join('\n')+'\n',{flag:'wx'});
console.log(JSON.stringify({wheels:wheels.length,root:lock.environmentRoot,sourceReports:'public wheel URLs and hashes',signedOcrRuntimeModified:false}));
