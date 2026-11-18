// Stage14 audit helper. Explicit commands only; never invokes a model by default.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [mode,audit,name,...command]=process.argv.slice(2);
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const names=()=>[...new Set(git('ls-files','-c','-o','--exclude-standard','-z').split('\0').filter(Boolean))].sort();
async function hash(file){const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
async function rows(files){const result=new Array(files.length);let index=0;await Promise.all(Array.from({length:8},async()=>{while(index<files.length){const i=index++,file=files[i];try{const absolute=path.isAbsolute(file)?file:path.join(root,file);result[i]={path:file,bytes:(await fs.stat(absolute)).size,sha256:await hash(absolute)};}catch(e){result[i]={path:file,error:e.code};}}}));return result;}
async function walk(dir){const found=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Protected link: '+f);if(e.isDirectory())found.push(...await walk(f));else if(e.isFile())found.push(f);}return found;}
const json=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2),{flag:'wx'});
if(!audit||!/^MangoHana_14_\d{8}_\d{6}$/.test(path.basename(audit))||path.resolve(path.dirname(audit))!==path.resolve('C:/dev/Projects/_audits'))throw Error('Explicit Stage14 audit required');
if(mode==='baseline'){
 await fs.mkdir(audit);await fs.mkdir(path.join(audit,'evidence'));
 const previous='C:/dev/Projects/_audits/MangoHana_13_20261113_154254';
 const old=JSON.parse(await fs.readFile(path.join(previous,'evidence/baseline.json'),'utf8'));
 const source=await rows(names());if(source.some(r=>r.error))throw Error('Incomplete source baseline');
 for(const r of source){const target=path.join(audit,'evidence/before',r.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(root,r.path),target);}
 console.log('Source snapshots: '+source.length);
 const protectedNames=new Set(old.protectedFiles.map(r=>path.resolve(r.path)));
 for(const f of await walk(previous))protectedNames.add(path.resolve(f));
 for(const f of await walk('E:/Dev/Outputs/MangohanaV2-20261111'))protectedNames.add(path.resolve(f));
 const protectedFiles=await rows([...protectedNames].sort());if(protectedFiles.some(r=>r.error))throw Error('Incomplete protected baseline');
 const protectedIndex=new Map(protectedFiles.map(r=>[path.resolve(r.path),r.sha256]));
 const inheritedDrift=old.protectedFiles.filter(r=>protectedIndex.get(path.resolve(r.path))!==r.sha256);
 const runRoot=path.join('E:/Dev/Outputs/MangohanaV2-20261111/tests',path.basename(audit));
 await fs.mkdir(runRoot);await fs.writeFile(path.join(runRoot,'stage14-write-probe.txt'),'Stage14 isolated output; no existing files overwritten.\n',{flag:'wx'});
 const b={createdAt:new Date().toISOString(),root,runRoot,git:{head:git('rev-parse','HEAD'),branch:git('branch','--show-current'),status:git('status','--porcelain=v1','-uall')},files:source,protectedFiles,inheritedStage13ProtectedDrift:inheritedDrift,preBaselineToolCreation:['scripts/v2/stage14-evidence.mjs']};
 await json(path.join(audit,'evidence/baseline.json'),b);console.log(JSON.stringify({audit,runRoot,sources:source.length,protected:protectedFiles.length,inheritedDrift:inheritedDrift.length,head:b.git.head}));
}else if(mode==='run'){
 if(!/^[-a-z0-9]+$/.test(name)||!command.length)throw Error('Explicit command required');
 const dest=path.join(audit,'evidence',name);await fs.mkdir(dest);const before=await rows(names()),startedAt=new Date().toISOString(),start=performance.now();
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'mangohana-stage14-'));
 const env={...process.env,TEMP:temporary,TMP:temporary,NO_COLOR:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'};delete env.FORCE_COLOR;
 const chunks=[],file=await fs.open(path.join(dest,'output.log'),'wx');let writes=Promise.resolve();
 const child=spawn(command[0],command.slice(1),{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const record=b=>{chunks.push(b);writes=writes.then(()=>file.write(b));};child.stdout.on('data',record);child.stderr.on('data',record);
 const result=await new Promise(resolve=>{child.once('error',e=>resolve({code:null,error:e.code}));child.once('close',(code,signal)=>resolve({code,signal}));});await writes;await file.close();
 const after=await rows(before.map(r=>r.path)),changed=before.filter((r,i)=>r.sha256!==after[i].sha256||after[i].error).map(r=>r.path),log=Buffer.concat(chunks),output=log.toString('utf8').replace(/\x1b\[[0-9;]*m/g,'');
 const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(k=>{const matches=[...output.matchAll(new RegExp('(?:ℹ |# )'+k+'\\s+(\\d+)','g'))];return [k,matches.length?+matches.at(-1)[1]:null];}));
 const receipt={name,command,cwd:root,node:process.version,startedAt,endedAt:new Date().toISOString(),durationMs:performance.now()-start,exitCode:result.code,signal:result.signal??null,error:result.error??null,counts,sourceUnchanged:!changed.length,changed,sourceBefore:before,sourceAfter:after,temporary,evidenceLevel:'COMMAND_RECEIPT_ONLY_MODEL_ACTIVITY_REQUIRES_RUNTIME_EVIDENCE',logSha256:await hash(path.join(dest,'output.log'))};
 await json(path.join(dest,'receipt.json'),receipt);console.log(JSON.stringify({name,exitCode:result.code,counts,changed,tail:output.slice(-2500)}));process.exitCode=result.code===0&&!changed.length?0:1;
}else if(mode==='preserve'){
 const b=JSON.parse(await fs.readFile(path.join(audit,'evidence/baseline.json'),'utf8')),current=await rows(b.protectedFiles.map(r=>r.path));
 const changed=b.protectedFiles.filter((r,i)=>r.sha256!==current[i].sha256||current[i].error),source=await rows(names());
 const sourceChanges=source.filter(r=>b.files.find(p=>p.path===r.path)?.sha256!==r.sha256),deleted=b.files.filter(r=>!source.some(n=>n.path===r.path));
 const result={createdAt:new Date().toISOString(),protectedCount:current.length,protectedUnchanged:!changed.length,changed,sourceChanges,deleted,sources:source,git:{head:git('rev-parse','HEAD'),branch:git('branch','--show-current'),status:git('status','--porcelain=v1','-uall')}};
 await json(path.join(audit,'evidence',name||'preservation-final.json'),result);console.log(JSON.stringify({protectedCount:current.length,protectedUnchanged:!changed.length,changed,sourceChanges:sourceChanges.map(r=>r.path),deleted}));process.exitCode=changed.length||deleted.length?1:0;
}else throw Error('baseline, run, preserve required');
