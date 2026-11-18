// Append-only single-page authority. A consumed marker is never deleted, reset or retried.
import fs from 'node:fs/promises';import path from 'node:path';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {readBounded} from './translation-review-store.mjs';
export const digest=value=>createHash('sha256').update(Buffer.isBuffer(value)||typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const demand=(ok,code='IMAGE_PERMIT_INVALID',status=409)=>{if(!ok)throw Object.assign(Error('이미지 실행 승인과 현재 페이지 상태를 확인해 주세요.'),{code,status});};
export const exact=(v,keys)=>demand(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)));
export const permitId=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export async function regularDirectory(dir){const s=await fs.lstat(dir);demand(s.isDirectory()&&!s.isSymbolicLink()&&path.resolve(await fs.realpath(dir)).toLowerCase()===path.resolve(dir).toLowerCase(),'IMAGE_PATH_UNSAFE');}
export async function writeExclusive(file,bytes){await regularDirectory(path.dirname(file));const h=await fs.open(file,'wx',0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}}
export async function createImagePermitStore(root){
 demand(path.isAbsolute(root),'IMAGE_PERMIT_CONFIG',503);await fs.mkdir(root,{recursive:true});await regularDirectory(root);
 const keyPath=path.join(root,'image-permit-key.bin');try{await writeExclusive(keyPath,randomBytes(32));}catch(e){if(e.code!=='EEXIST')throw e;}
 const key=await readBounded(keyPath,32);demand(key.length===32,'IMAGE_PERMIT_CORRUPT',503);
 const mac=v=>createHmac('sha256',key).update(JSON.stringify(v)).digest('hex');
 const seal=v=>({...v,signature:mac(v)});
 const verify=v=>{const {signature,...unsigned}=v;demand(/^[a-f0-9]{64}$/.test(signature??'')&&timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(mac(unsigned),'hex')),'IMAGE_PERMIT_CORRUPT',503);return v;};
 const directory=id=>{demand(permitId(id));return path.join(root,id);};
 async function read(id,name,optional=false){await regularDirectory(root);await regularDirectory(directory(id));try{return verify(JSON.parse(await readBounded(path.join(directory(id),name+'.json'))));}catch(e){if(optional&&e.code==='ENOENT')return null;throw e;}}
 async function append(id,name,value){await regularDirectory(root);await regularDirectory(directory(id));const signed=seal(value);await writeExclusive(path.join(directory(id),name+'.json'),JSON.stringify(signed));return signed;}
 async function create(value){await regularDirectory(root);await fs.mkdir(directory(value.permitId));return append(value.permitId,'proposal',value);}
 async function load(owner,documentId,id){
  const p=await read(id,'proposal');demand(p.ownerScope===owner&&p.documentId===documentId,'IMAGE_PERMIT_NOT_FOUND',404);
  const values={};for(const name of ['approval','consumed','cancel','outcome']){const v=await read(id,name,true);if(v)demand(v.permitId===id&&v.proposalSha256===digest(p),'IMAGE_PERMIT_CORRUPT',503);values[name]=v;}
  return {proposal:p,...values};
 }
 return {create,load,read,append,directory};
}
