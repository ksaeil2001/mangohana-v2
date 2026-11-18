// Stage14-R2 preservation only. No engine, model, retry or network entry point.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [mode,audit]=process.argv.slice(2);
if(!/^MangoHana_14R2_\d{8}_\d{6}$/.test(path.basename(audit??''))||path.resolve(path.dirname(audit))!==path.resolve('C:/dev/Projects/_audits'))throw Error('Explicit new Stage14-R2 audit required');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const names=()=>[...new Set(git('ls-files','-c','-o','--exclude-standard','-z').split('\0').filter(Boolean))].sort();
const sha=async p=>{const h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);return h.digest('hex');};
async function rows(files){const out=new Array(files.length);let next=0;await Promise.all(Array.from({length:8},async()=>{while(next<files.length){const i=next++,p=files[i];try{const full=path.isAbsolute(p)?p:path.join(root,p);out[i]={path:p,bytes:(await fs.stat(full)).size,sha256:await sha(full)};}catch(e){out[i]={path:p,error:e.code};}}}));return out;}
async function walk(dir){const found=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Protected symlink: '+p);if(e.isDirectory())found.push(...await walk(p));else if(e.isFile())found.push(p);}return found;}
const json=(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2),{flag:'wx'});
if(mode==='baseline'){
 await fs.mkdir(audit);await fs.mkdir(path.join(audit,'evidence'));
 const previous='C:/dev/Projects/_audits/MangoHana_14R_20261113_201850';
 const old=JSON.parse(await fs.readFile(path.join(previous,'evidence/baseline.json'),'utf8'));
 const files=await rows(names());if(files.some(x=>x.error))throw Error('Incomplete source baseline');
 for(const r of files){const dest=path.join(audit,'evidence/before',r.path);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(path.join(root,r.path),dest);}
 console.log('Source snapshots: '+files.length);
 const protectedNames=new Set(old.protectedFiles.map(r=>path.resolve(r.path)));
 for(const base of [previous,'E:/Dev/Outputs/MangohanaV2-20261111'])for(const p of await walk(base))protectedNames.add(path.resolve(p));
 const protectedFiles=await rows([...protectedNames].sort());if(protectedFiles.some(x=>x.error))throw Error('Incomplete protected baseline');
 const index=new Map(protectedFiles.map(x=>[path.resolve(x.path),x.sha256]));
 const inheritedDrift=old.protectedFiles.filter(x=>index.get(path.resolve(x.path))!==x.sha256);
 const b={createdAt:new Date().toISOString(),root,previous,git:{head:git('rev-parse','HEAD'),branch:git('branch','--show-current'),status:git('status','--porcelain=v1','-uall')},files,protectedFiles,inheritedDrift,preBaselineToolCreation:['scripts/v2/stage14r2-evidence.mjs']};
 await json(path.join(audit,'evidence/baseline.json'),b);
 console.log(JSON.stringify({audit,files:files.length,protected:protectedFiles.length,inheritedDrift:inheritedDrift.length}));
}else if(mode==='preserve'){
 const b=JSON.parse(await fs.readFile(path.join(audit,'evidence/baseline.json'),'utf8'));
 const current=await rows(b.protectedFiles.map(x=>x.path));
 const changed=b.protectedFiles.filter((x,i)=>x.sha256!==current[i].sha256||current[i].error);
 const sources=await rows(names()),index=new Map(b.files.map(x=>[x.path,x]));
 const sourceChanges=sources.filter(x=>index.get(x.path)?.sha256!==x.sha256),deleted=b.files.filter(x=>!sources.some(y=>y.path===x.path));
 const result={createdAt:new Date().toISOString(),protectedCount:current.length,protectedUnchanged:!changed.length,changed,sourceChanges,deleted,sources,git:{head:git('rev-parse','HEAD'),branch:git('branch','--show-current'),status:git('status','--porcelain=v1','-uall')}};
 await json(path.join(audit,'evidence/preservation-final.json'),result);
 console.log(JSON.stringify({...result,sources:undefined,git:undefined,sourceChanges:sourceChanges.map(x=>x.path)}));
 process.exitCode=changed.length||deleted.length?1:0;
}else throw Error('baseline or preserve required');
