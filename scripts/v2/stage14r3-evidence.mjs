// Stage14-R3 evidence only; no provider or inference entry point.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [mode,audit,name,...command]=process.argv.slice(2);
if(!/^MangoHana_14R3_\d{8}_\d{6}$/.test(path.basename(audit??''))||path.resolve(path.dirname(audit))!==path.resolve('C:/dev/Projects/_audits'))throw Error('Explicit Stage14-R3 audit required');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const names=()=>[...new Set(git('ls-files','-c','-o','--exclude-standard','-z').split('\0').filter(Boolean))].sort();
async function sha(p){const h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);return h.digest('hex');}
async function rows(files){const out=new Array(files.length);let next=0;await Promise.all(Array.from({length:8},async()=>{while(next<files.length){const i=next++,p=files[i];try{const full=path.isAbsolute(p)?p:path.join(root,p);out[i]={path:p,bytes:(await fs.stat(full)).size,sha256:await sha(full)};}catch(e){out[i]={path:p,error:e.code};}}}));return out;}
async function walk(dir){const found=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Protected symlink');if(e.isDirectory())found.push(...await walk(p));else if(e.isFile())found.push(p);}return found;}
const json=(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2),{flag:'wx'});
if(mode==='baseline'){
 await fs.mkdir(audit);await fs.mkdir(path.join(audit,'evidence'));
 const previous='C:/dev/Projects/_audits/MangoHana_14R2_20261113_215800',old=JSON.parse(await fs.readFile(path.join(previous,'evidence/baseline.json'),'utf8'));
 const files=await rows(names());if(files.some(x=>x.error))throw Error('Incomplete baseline');
 for(const r of files){const p=path.join(audit,'evidence/before',r.path);await fs.mkdir(path.dirname(p),{recursive:true});await fs.copyFile(path.join(root,r.path),p);}
 const protectedFiles=await rows([...new Set([...old.protectedFiles.map(r=>path.resolve(r.path)),...await walk(previous)])].sort());if(protectedFiles.some(x=>x.error))throw Error('Incomplete protection census');
 const index=new Map(protectedFiles.map(x=>[path.resolve(x.path),x.sha256]));
 const inheritedDrift=old.protectedFiles.filter(x=>index.get(path.resolve(x.path))!==x.sha256);
 await json(path.join(audit,'evidence/baseline.json'),{createdAt:new Date().toISOString(),root,previous,files,protectedFiles,inheritedDrift,preBaselineToolCreation:['scripts/v2/stage14r3-evidence.mjs'],git:{head:git('rev-parse','HEAD'),branch:git('branch','--show-current'),status:git('status','--porcelain=v1','-uall')}});
 console.log(JSON.stringify({audit,files:files.length,protected:protectedFiles.length,inheritedDrift:inheritedDrift.length}));
}else if(mode==='run'){
 if(!/^[-a-z0-9]+$/.test(name)||!command.length)throw Error('Named command required');
 const dest=path.join(audit,'evidence',name);await fs.mkdir(dest);const before=await rows(names()),startedAt=new Date().toISOString(),start=performance.now(),temporary=await fs.mkdtemp(path.join(os.tmpdir(),'mangohana-14r3-'));
 // Existing private OCR policy requires an E: profile. Keep that guard and
 // allocate new synthetic roots; TEMP itself remains the OS temporary folder.
 const ownedBase=path.join('E:/Dev/Outputs/MangohanaV2-20261111/tests',path.basename(audit),name);
 const env={...process.env,TEMP:temporary,TMP:temporary,NO_COLOR:'1',MANGOHANA_OWNED_RUNTIME_TEST_DIR:path.join(ownedBase,'owned'),MANGOHANA_LEASE_TEST_DIR:path.join(ownedBase,'lease')};delete env.FORCE_COLOR;
 await fs.mkdir(env.MANGOHANA_OWNED_RUNTIME_TEST_DIR,{recursive:true});await fs.mkdir(env.MANGOHANA_LEASE_TEST_DIR,{recursive:true});
 const chunks=[],log=await fs.open(path.join(dest,'output.log'),'wx');let writes=Promise.resolve();
 const child=spawn(command[0],command.slice(1),{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const record=b=>{chunks.push(b);writes=writes.then(()=>log.write(b));};child.stdout.on('data',record);child.stderr.on('data',record);
 const result=await new Promise(resolve=>{child.once('error',e=>resolve({code:null,error:e.code}));child.once('close',(code,signal)=>resolve({code,signal}));});await writes;await log.close();
 const after=await rows(before.map(r=>r.path)),changed=before.filter((r,i)=>r.sha256!==after[i].sha256||after[i].error).map(r=>r.path),text=Buffer.concat(chunks).toString('utf8').replace(/\x1b\[[0-9;]*m/g,'');
 const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(k=>{const m=[...text.matchAll(new RegExp('(?:ℹ |# )'+k+'\\s+(\\d+)','g'))];return[k,m.length?+m.at(-1)[1]:null];}));
 await json(path.join(dest,'receipt.json'),{name,command,cwd:root,node:process.version,startedAt,endedAt:new Date().toISOString(),durationMs:performance.now()-start,exitCode:result.code,signal:result.signal??null,error:result.error??null,counts,sourceUnchanged:!changed.length,changed,sourceBefore:before,sourceAfter:after,temporary,realModelExecution:false,logSha256:await sha(path.join(dest,'output.log'))});
 console.log(JSON.stringify({name,exitCode:result.code,counts,changed,tail:text.slice(-3500)}));process.exitCode=result.code===0&&!changed.length?0:1;
}else if(mode==='preserve'){
 const b=JSON.parse(await fs.readFile(path.join(audit,'evidence/baseline.json'),'utf8')),current=await rows(b.protectedFiles.map(x=>x.path)),changed=b.protectedFiles.filter((x,i)=>x.sha256!==current[i].sha256||current[i].error),sources=await rows(names()),index=new Map(b.files.map(x=>[x.path,x]));
 const sourceChanges=sources.filter(x=>index.get(x.path)?.sha256!==x.sha256),deleted=b.files.filter(x=>!sources.some(y=>y.path===x.path));
 await json(path.join(audit,'evidence/preservation-final.json'),{createdAt:new Date().toISOString(),protectedCount:current.length,protectedUnchanged:!changed.length,changed,sourceChanges,deleted,sources,git:{head:git('rev-parse','HEAD'),branch:git('branch','--show-current'),status:git('status','--porcelain=v1','-uall')}});
 console.log(JSON.stringify({protectedCount:current.length,protectedUnchanged:!changed.length,changed,deleted,sourceChanges:sourceChanges.map(x=>x.path)}));process.exitCode=changed.length||deleted.length?1:0;
}else throw Error('baseline, run or preserve required');
