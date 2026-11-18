import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const root='E:/Dev/Outputs/MangohanaV2-20261111';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('prior full-SHA receipts permit identity-bound reuse and reject stale or changed evidence',async t=>{
 const exists=await fs.access(new URL('./asset-receipt.mjs',import.meta.url)).then(()=>true,()=>false);
 assert.equal(exists,true,'asset receipt verifier must exist before model reuse is allowed');
 const {reuseAssetReceipt}=await import('./asset-receipt.mjs');
 const output=await fs.mkdtemp(path.join(root,'semantic-receipt-tests-'));
 async function fixture(name){
  const directory=path.join(output,name);await fs.mkdir(directory);
  const data=Buffer.from('synthetic model fixture only');
  const reference={directory,resource:{id:'fixture',fileName:'fixture.bin',bytes:data.length,sha256:sha(data)}};
  const assetPath=path.resolve(directory,reference.resource.fileName);await fs.writeFile(assetPath,data,{flag:'wx'});
  const info=await fs.lstat(assetPath,{bigint:true});
  const receipt={version:1,kind:'FULL_SHA256_ASSET_RECEIPT',verifiedAt:new Date().toISOString(),method:'ensureResource_verifyOnly_full_sha256',durationMs:1,entries:[{id:'fixture',sha256:sha(data),bytes:data.length,fileIdentity:{path:assetPath,device:info.dev.toString(),fileId:info.ino.toString(),size:info.size.toString(),mtimeNs:info.mtimeNs.toString(),ctimeNs:info.ctimeNs.toString(),birthtimeNs:info.birthtimeNs.toString()}}]};
  const receiptPath=path.join(directory,'receipt.json');
  async function writeReceipt(){const bytes=Buffer.from(JSON.stringify(receipt));await fs.writeFile(receiptPath,bytes);return {path:receiptPath,sha256:sha(bytes)};}
  return {reference,assetPath,receipt,writeReceipt,receiptReference:await writeReceipt(),data,info};
 }
 await t.test('unchanged file uses an explicitly historical full-SHA receipt',async()=>{
  const f=await fixture('unchanged');
  const result=await reuseAssetReceipt([f.reference],f.receiptReference);
  assert.equal(result.kind,'REUSED_PRIOR_FULL_SHA256_RECEIPT_WITH_UNCHANGED_FILE_IDENTITY');
  assert.equal(result.originalVerifiedAt,f.receipt.verifiedAt);
  assert.equal(result.assets[0].path,f.assetPath);
  assert.equal(result.freshFullShaPerformed,false);
 });
 await t.test('changed receipt bytes fail authentication',async()=>{
  const f=await fixture('receipt-tampered');await fs.appendFile(f.receiptReference.path,' ');
  await assert.rejects(reuseAssetReceipt([f.reference],f.receiptReference),/ASSET_RECEIPT_HASH_MISMATCH/);
 });
 await t.test('a different expected model hash cannot reuse the receipt',async()=>{
  const f=await fixture('hash-changed');f.reference.resource.sha256='0'.repeat(64);
  await assert.rejects(reuseAssetReceipt([f.reference],f.receiptReference),/ASSET_RECEIPT_RESOURCE_MISMATCH/);
 });
 await t.test('a same-size modification with changed mtime is rejected',async()=>{
  const f=await fixture('modified');await fs.writeFile(f.assetPath,Buffer.alloc(f.data.length,120));
  const altered=new Date(Date.now()+10_000);await fs.utimes(f.assetPath,altered,altered);
  await assert.rejects(reuseAssetReceipt([f.reference],f.receiptReference),/ASSET_RECEIPT_FILE_CHANGED/);
 });
 await t.test('a replaced file cannot reuse old identity despite restored mtime',async()=>{
  const f=await fixture('replaced');await fs.rename(f.assetPath,f.assetPath+'.preserved');await fs.writeFile(f.assetPath,f.data,{flag:'wx'});
  const originalMtime=Number(f.info.mtimeNs)/1e9;await fs.utimes(f.assetPath,originalMtime,originalMtime);
  await assert.rejects(reuseAssetReceipt([f.reference],f.receiptReference),/ASSET_RECEIPT_FILE_CHANGED/);
 });
 await t.test('an old full-SHA receipt requires fresh validation',async()=>{
  const f=await fixture('stale');f.receipt.verifiedAt=new Date(Date.now()-31*60_000).toISOString();
  await assert.rejects(reuseAssetReceipt([f.reference],await f.writeReceipt()),/ASSET_RECEIPT_EXPIRED/);
 });
 await fs.writeFile(path.join(output,'test-scope.json'),JSON.stringify({scope:'SYNTHETIC_FILE_IDENTITY_TESTS_NO_AI',modelHttpRequests:0,fixtureRoot:output},null,2),{flag:'wx'});
});
