'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {createReadStream}=require('node:fs'),{createHash}=require('node:crypto');
const VERSION='stage13-checkpoint-v1',stages=new Set(['ocr','translation','cleaned']),hex=/^[a-f0-9]{64}$/;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>[k,canonical(x[k])])):x;
const key=x=>digest(JSON.stringify(canonical(x)));
async function fileHash(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
/** Content fingerprints, including transitive local JS imports; never just filenames or mtimes. */
async function fingerprintFiles(files,{excludeFonts=false,capture}={}){
 const seen=new Map(),directories=capture?new Map():null,sources=capture?new Map():null,anchors=capture?new Map():null;
 async function visit(file){
  file=path.resolve(file);if(seen.has(file))return;
  let stat;try{stat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT'){seen.set(file,null);anchors?.set(file,{missing:true});return;}throw error;}
  if(stat.isSymbolicLink())throw Object.assign(Error('Checkpoint dependency is a link'),{code:'CHECKPOINT_INVALID'});
  anchors?.set(file,{ino:stat.ino,dev:stat.dev,size:stat.size,mtimeMs:stat.mtimeMs,directory:stat.isDirectory()});
  if(stat.isDirectory()){const entries=(await fs.readdir(file)).sort().filter(entry=>!excludeFonts||!/^font/i.test(entry));directories?.set(file,entries);for(const entry of entries)await visit(path.join(file,entry));return;}
  if(!stat.isFile())throw Error('Checkpoint dependency must be a file');
  const hash=await fileHash(file),after=await fs.lstat(file);
  if(after.isSymbolicLink()||after.ino!==stat.ino||after.dev!==stat.dev||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Object.assign(Error('Checkpoint dependency changed during hashing'),{code:'CHECKPOINT_INVALID'});
  seen.set(file,hash);
  if(/\.[cm]?js$/.test(file)&&stat.size<=4*1024*1024){const source=await fs.readFile(file,'utf8');sources?.set(file,source);for(const match of source.matchAll(/(?:from\s*|require\(\s*|import\(\s*)['"](\.[^'"]+)['"]/g)){
   let dependency=path.resolve(path.dirname(file),match[1]);if(!path.extname(dependency))dependency+='.js';await visit(dependency);
  }}
 }
 for(const file of files.filter(Boolean))await visit(file);
 const rows=[...seen.entries()].sort(([a],[b])=>a.localeCompare(b));
 if(capture)capture(structuredClone({rows,directories:[...directories],sources:[...sources],anchors:[...anchors]}));
 return key(rows);
}
async function bounded(file,limit){
 const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size<=0||info.size>limit||path.resolve(await fs.realpath(file))!==path.resolve(file))throw Error('Invalid checkpoint file');
 const handle=await fs.open(file,'r');try{const opened=await handle.stat(),bytes=await handle.readFile(),after=await handle.stat(),named=await fs.lstat(file);
  if(opened.ino!==info.ino||opened.dev!==info.dev||bytes.length!==info.size||after.mtimeMs!==opened.mtimeMs||after.size!==info.size||named.isSymbolicLink()||named.ino!==opened.ino||named.dev!==opened.dev)throw Error('Changed checkpoint file');return bytes;
 }finally{await handle.close();}
}
/** resumeFrom is supplied by the owned store, never by the HTTP request body. */
function createCheckpointSession({directory,jobId,scope,resumeFrom,onCheckpoint,signal,now=Date.now}){
 const reusedStages=[],misses=[];
 const active=()=>signal?.throwIfAborted();
 const validScope=scope&&hex.test(scope.ownerScope??'')&&typeof scope.projectId==='string'&&typeof scope.pageId==='string'&&hex.test(scope.sourceSha256??'')&&hex.test(scope.normalizedSha256??'');
 async function load(stage,identity){
  active();if(!validScope||!resumeFrom?.checkpoints?.[stage])return null;
  try{
   if(!stages.has(stage)||!path.isAbsolute(resumeFrom.directory))throw Error('Invalid checkpoint source');
   const dir=await fs.lstat(resumeFrom.directory);if(!dir.isDirectory()||dir.isSymbolicLink()||path.resolve(await fs.realpath(resumeFrom.directory))!==path.resolve(resumeFrom.directory))throw Error('Invalid checkpoint directory');
   const receipt=resumeFrom.checkpoints[stage],bytes=await bounded(path.join(resumeFrom.directory,'checkpoint-'+stage+'.json'),16*1024*1024);
   if(receipt.stage!==stage||!hex.test(receipt.sha256)||digest(bytes)!==receipt.sha256)throw Error('Checkpoint receipt mismatch');
   const saved=JSON.parse(bytes.toString('utf8'));
   if(saved.version!==VERSION||saved.stage!==stage||saved.jobId!==resumeFrom.jobId||saved.key!==key({scope,identity})||key(saved.scope)!==key(scope)||key(saved.identity)!==key(identity)||!Number.isFinite(saved.createdAt)||saved.createdAt>now()+60_000)throw Error('Checkpoint identity mismatch');
   const assets={};for(const [name,sha256]of Object.entries(saved.assets??{})){
    if(!/^[a-z][a-z0-9-]*\.(?:png|json)$/.test(name)||!hex.test(sha256))throw Error('Invalid checkpoint asset');
    const data=await bounded(path.join(resumeFrom.directory,name),32*1024*1024);if(digest(data)!==sha256)throw Error('Checkpoint asset hash mismatch');assets[name]=data;
   }
   active();reusedStages.push(stage);return {payload:structuredClone(saved.payload),assets};
  }catch(error){active();misses.push({stage,reason:'CHECKPOINT_IDENTITY_OR_INTEGRITY_MISMATCH'});return null;}
 }
 async function save(stage,identity,payload,assets=[]){
  active();if(!validScope||typeof onCheckpoint!=='function')return;
  if(!stages.has(stage))throw Error('Invalid checkpoint stage');
  const hashes={};for(const name of assets){if(!/^[a-z][a-z0-9-]*\.(?:png|json)$/.test(name))throw Error('Invalid checkpoint asset');hashes[name]=digest(await bounded(path.join(directory,name),32*1024*1024));}
  const saved={version:VERSION,stage,jobId,scope,identity,key:key({scope,identity}),createdAt:now(),payload,assets:hashes},bytes=Buffer.from(JSON.stringify(saved));
  if(bytes.length>16*1024*1024)throw Object.assign(Error('Checkpoint too large'),{code:'CHECKPOINT_INVALID'});
  const handle=await fs.open(path.join(directory,'checkpoint-'+stage+'.json'),'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  active();await onCheckpoint({stage,sha256:digest(bytes),version:VERSION});active();
 }
 return Object.freeze({load,save,evidence:()=>({version:VERSION,fromJobId:resumeFrom?.jobId??null,reusedStages:[...reusedStages],misses:[...misses]})});
}
module.exports={createCheckpointSession,fingerprintFiles,key,VERSION};
