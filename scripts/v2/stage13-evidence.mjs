// Stage13 evidence: explicit local commands, streaming hashes, no inference.
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
export async function hash(file){const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
export async function rows(files){const result=new Array(files.length);let index=0;await Promise.all(Array.from({length:8},async()=>{while(index<files.length){const i=index++,file=files[i],absolute=path.isAbsolute(file)?file:path.join(root,file);try{result[i]={path:file,bytes:(await fs.stat(absolute)).size,sha256:await hash(absolute)};}catch(e){result[i]={path:file,error:e.code};}}}));return result;}
async function walk(dir){const found=[];for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Unexpected link in protected evidence: '+file);if(entry.isDirectory())found.push(...await walk(file));else if(entry.isFile())found.push(file);}return found;}
if(mode==='baseline'){
 if(!/^MangoHana_13_\d{8}_\d{6}$/.test(path.basename(audit))||path.resolve(path.dirname(audit))!==path.resolve('C:/dev/Projects/_audits'))throw Error('Explicit Stage13 audit required');
 await fs.mkdir(audit);await fs.mkdir(path.join(audit,'evidence'));
 const old=JSON.parse(await fs.readFile('C:/dev/Projects/_audits/MangoHana_12_20261113_131536/evidence/baseline.json','utf8'));
 const source=await rows(names());if(source.some(r=>r.error))throw Error('Source baseline incomplete');
 for(const r of source){const target=path.join(audit,'evidence/before',r.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(root,r.path),target);}
 console.log('Source snapshots: '+source.length);
 const protectedNames=new Set(old.protectedFiles.map(r=>r.path));
 for(const entry of await fs.readdir(path.dirname(audit),{withFileTypes:true}))if(entry.isDirectory()&&/^MangoHana_(?:0\d|1[012])_/.test(entry.name))for(const f of await walk(path.join(path.dirname(audit),entry.name)))protectedNames.add(f);
 for(const f of await walk('E:/Dev/Outputs/MangohanaV2-20261111'))protectedNames.add(f);
 const protectedFiles=await rows([...protectedNames].sort());if(protectedFiles.some(r=>r.error))throw Error('Protected baseline incomplete');
 const b={createdAt:new Date().toISOString(),root,git:{head:git('rev-parse','HEAD'),branch:git('branch','--show-current'),status:git('status','--porcelain=v1','-uall')},files:source,protectedFiles,preBaselineToolCreation:['scripts/v2/stage13-evidence.mjs']};
 await fs.writeFile(path.join(audit,'evidence/baseline.json'),JSON.stringify(b,null,2),{flag:'wx'});console.log(JSON.stringify({audit,sources:source.length,protected:protectedFiles.length,head:b.git.head}));
}else if(mode==='run'){
 if(!/^[-a-z0-9]+$/.test(name)||!command.length)throw Error('Explicit command required');
 const dest=path.join(audit,'evidence',name);await fs.mkdir(dest);const before=await rows(names()),startedAt=new Date().toISOString(),start=performance.now();
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'mangohana-stage13-'));
 const env={...process.env,TEMP:temporary,TMP:temporary,NO_COLOR:'1'};delete env.FORCE_COLOR;
 const chunks=[],logFile=await fs.open(path.join(dest,'output.log'),'wx');let writing=Promise.resolve();
 const child=spawn(command[0],command.slice(1),{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const record=b=>{chunks.push(b);writing=writing.then(()=>logFile.write(b));};
 child.stdout.on('data',record);child.stderr.on('data',record);
 const result=await new Promise(resolve=>{child.once('error',e=>resolve({code:null,error:e.code}));child.once('close',(code,signal)=>resolve({code,signal}));});
 await writing;await logFile.close();
 const after=await rows(before.map(r=>r.path)),changed=before.filter((r,i)=>r.sha256!==after[i].sha256||after[i].error).map(r=>r.path),log=Buffer.concat(chunks),text=log.toString('utf8').replace(/\x1b\[[0-9;]*m/g,'');
 const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(k=>{const m=[...text.matchAll(new RegExp('(?:ℹ |# )'+k+'\\s+(\\d+)','g'))];return [k,m.length?+m.at(-1)[1]:null];}));
 const receipt={name,command,cwd:root,node:process.version,startedAt,endedAt:new Date().toISOString(),durationMs:performance.now()-start,exitCode:result.code,signal:result.signal??null,error:result.error??null,counts,sourceUnchanged:!changed.length,changed,sourceBefore:before,sourceAfter:after,temporary,realModelExecution:false,logSha256:createHash('sha256').update(log).digest('hex')};
 await fs.writeFile(path.join(dest,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx'});
 console.log(JSON.stringify({name,exitCode:result.code,counts,changed,tail:text.slice(-3000)}));process.exitCode=result.code===0&&!changed.length?0:1;
}else if(mode==='preserve'){
 const baseline=JSON.parse(await fs.readFile(path.join(audit,'evidence/baseline.json'),'utf8')),current=await rows(baseline.protectedFiles.map(r=>r.path));
 const changed=baseline.protectedFiles.filter((r,i)=>r.sha256!==current[i].sha256||current[i].error);
 const sources=await rows(names()),report={createdAt:new Date().toISOString(),protectedCount:current.length,protectedUnchanged:!changed.length,changed,gitHead:git('rev-parse','HEAD'),gitBranch:git('branch','--show-current'),gitStatus:git('status','--porcelain=v1','-uall'),sources};
 await fs.writeFile(path.join(audit,'evidence',name||'preservation-final.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({protectedCount:current.length,protectedUnchanged:!changed.length,changed}));process.exitCode=changed.length?1:0;
}else throw Error('baseline, run, or preserve required');
