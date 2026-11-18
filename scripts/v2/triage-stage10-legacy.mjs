// Replays only the 13 failed Legacy files in two byte-pinned, isolated snapshots.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [audit]=process.argv.slice(2),prior='C:/dev/Projects/_audits/MangoHana_09_20261112_235913';
if(!audit)throw Error('Audit directory required');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),sha=b=>createHash('sha256').update(b).digest('hex');
const old=await read(path.join(prior,'evidence/baseline.json')),current=await read(path.join(audit,'evidence/baseline.json')),failures=await read(path.join(prior,'evidence/legacy-failures.json'));
const base=await fs.mkdtemp(path.join(os.tmpdir(),'mangohana-stage10-legacy-'));
const results=[];
for(const [name,manifest,saved] of [['pre09',old,path.join(prior,'evidence/before')],['post09',current,path.join(audit,'evidence/before')]]){
 const snapshot=path.join(base,name),output=path.resolve(audit,'evidence','legacy-'+name);await fs.mkdir(snapshot);await fs.mkdir(output);
 const source={};
 for(const row of manifest.files){
  let bytes;try{bytes=await fs.readFile(path.join(saved,row.path));}catch{bytes=await fs.readFile(path.join(root,row.path));}
  if(sha(bytes)!==row.sha256)throw Error('SNAPSHOT_INPUT_CHANGED: '+row.path);
  const dest=path.join(snapshot,row.path);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,bytes,{flag:'wx'});source[row.path]=row.sha256;
 }
 await fs.symlink(path.join(root,'node_modules'),path.join(snapshot,'node_modules'),'junction');
 const temporary=path.join(base,name+'-temp');await fs.mkdir(temporary);
 const report=path.join(output,'vitest.json'),command=[process.execPath,path.join(root,'node_modules/vitest/vitest.mjs'),'run',...failures.files,'--reporter=json','--outputFile='+report];
 const env={...process.env,TEMP:temporary,TMP:temporary,NO_COLOR:'1'};delete env.FORCE_COLOR;
 const originalBefore=await Promise.all(current.files.map(async row=>[row.path,sha(await fs.readFile(path.join(root,row.path)))]));
 const chunks=[],startedAt=new Date().toISOString(),start=performance.now();
 const child=spawn(command[0],command.slice(1),{cwd:snapshot,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>chunks.push(b));child.stderr.on('data',b=>chunks.push(b));
 const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 const changed=[];for(const [p,expected]of Object.entries(source))if(sha(await fs.readFile(path.join(snapshot,p)))!==expected)changed.push(p);
 const originalChanged=[];for(const [p,expected]of originalBefore)if(sha(await fs.readFile(path.join(root,p)))!==expected)originalChanged.push(p);
 const log=Buffer.concat(chunks);await fs.writeFile(path.join(output,'output.log'),log,{flag:'wx'});
 const json=await read(report),receipt={name,command,cwd:snapshot,startedAt,endedAt:new Date().toISOString(),durationMs:performance.now()-start,node:process.version,exitCode:result.code,signal:result.signal,sourceUnchanged:changed.length===0&&originalChanged.length===0,changed,originalChanged,sourceHashes:source,logSha256:sha(log),reportSha256:sha(await fs.readFile(report)),counts:{tests:json.numTotalTests,passed:json.numPassedTests,failed:json.numFailedTests,pending:json.numPendingTests,suitesFailed:json.numFailedTestSuites},scope:'13_FAILED_LEGACY_FILES_ONLY_SNAPSHOT_NOT_FULL_SUITE',realModelCalls:0};
 await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx'});results.push({name,output,counts:receipt.counts,sourceUnchanged:receipt.sourceUnchanged,durationMs:receipt.durationMs});console.log(JSON.stringify(results.at(-1)));
}
await fs.writeFile(path.resolve(audit,'evidence/legacy-replay-summary.json'),JSON.stringify({base,results},null,2),{flag:'wx'});
