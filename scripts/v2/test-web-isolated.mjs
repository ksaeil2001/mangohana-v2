// Reuse every existing web check in a fresh OS temporary source copy.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {fileURLToPath} from 'node:url';import {execFileSync,spawn} from 'node:child_process';import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),destination=path.resolve(process.argv[2]??'docs/validation/stage14r3-imported-adapter-20261115/evidence');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'imported-web-'));
const names=execFileSync('git',['ls-files','-c','-o','--exclude-standard','-z'],{cwd:root,encoding:'utf8',windowsHide:true}).split('\0');
const files=[...new Set(names.filter(f=>['apps/sites/','apps/engine/','packages/ai-engine/vendor/trio/src/','packages/ai-engine/vendor/trio/scripts/sites-local/','packages/ai-engine/quality/'].some(p=>f.startsWith(p))))];
const sources={};for(const file of files){const bytes=await fs.readFile(path.join(root,file)),dest=path.join(temporary,file);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,bytes);sources[file]=createHash('sha256').update(bytes).digest('hex');}
await fs.symlink(path.join(root,'node_modules'),path.join(temporary,'node_modules'),'junction');await fs.symlink(path.join(root,'apps/sites/node_modules'),path.join(temporary,'apps/sites/node_modules'),'junction');
const tests=(await fs.readdir(path.join(root,'apps/sites/checks'))).filter(n=>n.endsWith('.test.mjs')).sort();
const log=await fs.open(path.join(destination,'web-all.log'),'wx'),chunks=[];let writing=Promise.resolve();
const child=spawn(process.execPath,['--test','--test-concurrency=1',...tests.map(n=>'apps/sites/checks/'+n)],{cwd:temporary,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
for(const s of [child.stdout,child.stderr])s.on('data',b=>{chunks.push(b);writing=writing.then(()=>log.write(b));});
const exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});await writing;await log.close();
const transcript=Buffer.concat(chunks).toString('utf8').replace(/\x1b\[[0-9;]*m/g,''),counts={};for(const label of ['tests','pass','fail','cancelled','skipped','todo']){const rows=[...transcript.matchAll(new RegExp('ℹ '+label+'\\s+(\\d+)','g'))];counts[label]=rows.length?Number(rows.at(-1)[1]):null;}
const changed=[];for(const [file,h]of Object.entries(sources))if(createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex')!==h)changed.push(file);
const result={status:exitCode===0&&counts.fail===0&&counts.skipped===0&&counts.cancelled===0&&!changed.length?'PASS':'FAILED',exitCode,counts,temporary,tests,sources,changed,scope:'EXISTING_WEB_CHECKS_ISOLATED_COPY_NOT_HUMAN_QUALITY'};
await fs.writeFile(path.join(destination,'web-verification.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({...result,sources:undefined}));process.exitCode=result.status==='PASS'?0:1;
