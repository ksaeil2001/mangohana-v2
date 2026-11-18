// Stage11 evidence only. Explicit commands, immutable source receipts, no inference.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [mode,audit,name,...command]=process.argv.slice(2);
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function hash(file){const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const files=()=>[...new Set(git('ls-files','-c','-o','--exclude-standard','-z').split('\0').filter(Boolean))].sort();
const rows=async names=>{const out=[];for(const file of names){const p=path.isAbsolute(file)?file:path.join(root,file),info=await fs.stat(p);out.push({path:file,sha256:await hash(p),bytes:info.size});}return out;};
async function walk(dir){const out=[];for(const d of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,d.name);if(d.isDirectory())out.push(...await walk(p));else if(d.isFile())out.push(p);}return out;}
if(mode==='baseline'){
 await fs.mkdir(audit,{recursive:false});await fs.mkdir(path.join(audit,'evidence'));await fs.mkdir(path.join(audit,'tools'));
 const prior='C:/dev/Projects/_audits/MangoHana_10_20261113_005022';
 const old=JSON.parse(await fs.readFile(path.join(prior,'evidence/baseline.json'),'utf8'));
 const source=await rows(files());
 for(const r of source){const dest=path.join(audit,'evidence/before',r.path);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(path.join(root,r.path),dest);}
 const priorFiles=[];for(const d of await fs.readdir(path.dirname(audit),{withFileTypes:true}))if(d.isDirectory()&&/^MangoHana_(?:0\d|10)_/.test(d.name))priorFiles.push(...await walk(path.join(path.dirname(audit),d.name)));
 const baseline={createdAt:new Date().toISOString(),root,git:{head:git('rev-parse','HEAD'),branch:git('branch','--show-current'),status:git('status','--porcelain=v1','-uall')},files:source,protectedFiles:await rows(old.protectedFiles.map(r=>r.path)),priorFiles:await rows(priorFiles)};
 await fs.writeFile(path.join(audit,'evidence/baseline.json'),JSON.stringify(baseline,null,2),{flag:'wx'});
 console.log(JSON.stringify({audit,source:source.length,protected:baseline.protectedFiles.length,prior:priorFiles.length,head:baseline.git.head}));
}else if(mode==='run'){
 if(!/^[-a-z0-9]+$/.test(name)||!command.length)throw Error('explicit command required');
 const output=path.join(audit,'evidence',name);await fs.mkdir(output,{recursive:false});
 const before=await rows(files()),startedAt=new Date().toISOString(),start=performance.now(),temporary=await fs.mkdtemp(path.join(os.tmpdir(),'mangohana-stage11-'));
 const env={...process.env,TEMP:temporary,TMP:temporary,NO_COLOR:'1'};delete env.FORCE_COLOR;
 const logs=[],child=spawn(command[0],command.slice(1),{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>logs.push(b));child.stderr.on('data',b=>logs.push(b));
 const result=await new Promise(resolve=>{child.once('error',e=>resolve({code:null,error:e.code}));child.once('close',(code,signal)=>resolve({code,signal}));});
 const after=await rows(before.map(r=>r.path)),changed=before.filter((r,i)=>r.sha256!==after[i].sha256).map(r=>r.path),log=Buffer.concat(logs),text=log.toString('utf8').replace(/\x1b\[[0-9;]*m/g,'');
 const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(k=>{const m=[...text.matchAll(new RegExp('(?:ℹ |# )'+k+'\\s+(\\d+)','g'))];return[k,m.length?Number(m.at(-1)[1]):null];}));
 const receipt={name,scope:'STAGE11_EXPLICIT_COMMAND_NOT_HUMAN_APPROVAL',command,cwd:root,node:process.version,startedAt,endedAt:new Date().toISOString(),durationMs:performance.now()-start,exitCode:result.code,signal:result.signal??null,error:result.error??null,sourceUnchanged:!changed.length,changed,sourceBefore:before,sourceAfter:after,counts,logSha256:sha(log),temporary,realModelExecution:false};
 await fs.writeFile(path.join(output,'output.log'),log,{flag:'wx'});await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx'});
 console.log(JSON.stringify({name,exitCode:result.code,counts,changed,tail:text.slice(-2200)}));process.exitCode=result.code===0&&!changed.length?0:1;
}else throw Error('baseline or run required');
