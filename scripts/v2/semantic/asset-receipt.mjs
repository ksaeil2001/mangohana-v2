// Administrator-only diagnostic resume. This never claims a new content hash.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function snapshotAsset(reference){
 const name=path.resolve(reference.directory,reference.resource.fileName),info=await fs.lstat(name,{bigint:true});
 if(!info.isFile()||info.isSymbolicLink()||info.size!==BigInt(reference.resource.bytes)||info.ino===0n)throw new Error('ASSET_FILE_INVALID');
 return {path:name,device:info.dev.toString(),fileId:info.ino.toString(),size:info.size.toString(),mtimeNs:info.mtimeNs.toString(),ctimeNs:info.ctimeNs.toString(),birthtimeNs:info.birthtimeNs.toString()};
}

export async function reuseAssetReceipt(references,reference){
 if(!Array.isArray(references)||references.length===0||new Set(references.map(item=>item.resource.id)).size!==references.length)throw new Error('ASSET_RECEIPT_RESOURCE_MISMATCH');
 const bytes=await fs.readFile(reference.path);
 if(sha(bytes)!==reference.sha256)throw new Error('ASSET_RECEIPT_HASH_MISMATCH');
 const receipt=JSON.parse(bytes);
 if(receipt.version!==1||receipt.kind!=='FULL_SHA256_ASSET_RECEIPT'||receipt.method!=='ensureResource_verifyOnly_full_sha256'||!Array.isArray(receipt.entries)||receipt.entries.length!==references.length)throw new Error('ASSET_RECEIPT_INVALID');
 const age=Date.now()-Date.parse(receipt.verifiedAt);
 if(!Number.isFinite(age)||age< -60_000||age>30*60_000)throw new Error('ASSET_RECEIPT_EXPIRED');
 const identities=[];
 for(const item of references){
  const entries=receipt.entries.filter(entry=>entry.id===item.resource.id);
  if(entries.length!==1||entries[0].bytes!==item.resource.bytes||entries[0].sha256!==item.resource.sha256)throw new Error('ASSET_RECEIPT_RESOURCE_MISMATCH');
  const identity=await snapshotAsset(item);
  if(JSON.stringify(identity)!==JSON.stringify(entries[0].fileIdentity))throw new Error('ASSET_RECEIPT_FILE_CHANGED');
  identities.push(identity);
 }
 const after=await Promise.all(references.map(snapshotAsset));
 if(JSON.stringify(after)!==JSON.stringify(identities))throw new Error('ASSET_RECEIPT_FILE_CHANGED');
 return {kind:'REUSED_PRIOR_FULL_SHA256_RECEIPT_WITH_UNCHANGED_FILE_IDENTITY',freshFullShaPerformed:false,originalVerifiedAt:receipt.verifiedAt,
  receiptPath:path.resolve(reference.path),receiptSha256:reference.sha256,
  assets:references.map((item,index)=>({id:item.resource.id,status:'reused-prior-integrity',path:identities[index].path,bytes:item.resource.bytes,sha256:item.resource.sha256,sha256Source:'prior-full-sha256-receipt',fileIdentity:identities[index]}))};
}
