import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),api=require('../../packages/ai-engine/quality/mask-evidence.cjs');
function fixture(){
 const width=12,height=12,bytes=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);
 const bitmap=Buffer.alloc(width*height*4,255);bitmap[(5*width+5)*4+3]=0;
 const expectedIdentity={version:1,jobId:'owned-job',pageNumber:1,sourceImageSha256:'a'.repeat(64),ocrSha256:'b'.repeat(64),coordinateSpace:'normalized-page-pixels',width,height};
 return {bytes,bitmap,expectedIdentity,identity:{...expectedIdentity},expectedPixels:1,allowedRegions:[{id:'selected',bbox:{x:.25,y:.25,width:.5,height:.5},paddingPx:0}],protectedRegions:[{id:'sfx',bbox:{x:0,y:0,width:.1,height:.1}}]};
}
const verify=f=>{assert.equal(typeof api.verifySourceTextMask,'function');return api.verifySourceTextMask(f);};
test('the product validator verifies decoded inverse alpha, selected bounds, exact counts and bound identity',()=>{
 const f=fixture(),r=verify(f);assert.equal(r.maskedPixels,1);assert.equal(r.protectedRegionPixels,0);assert.equal(r.qualityStatus,'REQUIRES_REVIEW');
});
for(const [label,mutate]of [
 ['alpha inversion',f=>{for(let i=3;i<f.bitmap.length;i+=4)f.bitmap[i]=255-f.bitmap[i];}],
 ['nonbinary alpha',f=>f.bitmap[3]=128],['size mismatch',f=>f.bytes.writeUInt32BE(11,16)],
 ['other page',f=>f.identity.pageNumber=2],['wrong source hash',f=>f.identity.sourceImageSha256='c'.repeat(64)],
 ['crop coordinate space',f=>f.identity.coordinateSpace='crop-local-pixels'],['other job revision',f=>f.identity.jobId='old-job'],
 ['stale OCR generation',f=>f.identity.ocrSha256='d'.repeat(64)],['empty removal',f=>f.bitmap.fill(255)],
 ['whole page erasure',f=>{for(let i=3;i<f.bitmap.length;i+=4)f.bitmap[i]=0;f.expectedPixels=144;f.allowedRegions=[{id:'all',bbox:{x:0,y:0,width:1,height:1},paddingPx:0}];f.protectedRegions=[];}],
 ['protection collision',f=>f.protectedRegions.push({id:'art',bbox:{x:5/12,y:5/12,width:1/12,height:1/12}})],
 ['outside selection',f=>{f.bitmap[3]=0;f.expectedPixels=2;}],['partial result count',f=>f.expectedPixels=2],
 ['preserved RGB not white',f=>f.bitmap[0]=0],['missing identity',f=>delete f.identity],
 ['malformed explicit protection',f=>f.protectionPixels=new Uint8Array(2)]
])test('rejects '+label+' before applying or invoking LaMa',()=>{
 const f=fixture();mutate(f);assert.equal(typeof api.verifySourceTextMask,'function');assert.throws(()=>verify(f),{code:'TEXT_MASK_INVALID'});
});
test('exact protection pixels prevent artwork loss inside an otherwise legal text envelope',()=>{
 const f=fixture();f.protectionPixels=new Uint8Array(144);f.protectionPixels[65]=255;
 assert.equal(typeof api.verifySourceTextMask,'function');assert.throws(()=>verify(f),{code:'TEXT_MASK_INVALID'});
});
