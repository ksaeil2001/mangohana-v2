import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {verifyLearnedMask,protectedOcrRegions}=require('../../packages/ai-engine/quality/mask-evidence.cjs');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

// Decoded pixels are synthetic. Actual PNG decoding is also required by the engine.
function fixture(){
 const width=20,height=20,bytes=Buffer.alloc(24),grayBytes=Buffer.alloc(24);
 for(const data of [bytes,grayBytes]){Buffer.from('89504e470d0a1a0a','hex').copy(data);data.writeUInt32BE(width,16);data.writeUInt32BE(height,20);}
 const bitmap=Buffer.alloc(width*height*4,255);bitmap[(10*width+10)*4+3]=0;
 const grayBitmap=Buffer.alloc(width*height*4,0);
 for(let pixel=0;pixel<width*height;pixel++)grayBitmap[pixel*4+3]=255;
 for(let channel=0;channel<3;channel++)grayBitmap[(10*width+10)*4+channel]=255;
 const request={imageSha256:'a'.repeat(64),width,height,regions:[{id:'bubble',bbox:{x:.4,y:.4,width:.2,height:.2}}]};
 const reply={version:1,ok:true,imageSha256:request.imageSha256,width,height,model:{sha256:'b10356a2a12f4dec4650e563724932e542764dbd3201a7e4cae6573597c5bea1'},executionProvider:'CPUExecutionProvider',
 maskKind:'LEARNED_PIXEL_MASK',algorithm:'dual-context-consensus-v1',qualityStatus:'REQUIRES_REVIEW',haloRadius:2,maskRgbaSha256:sha(bytes),maskSha256:sha(grayBytes),regions:[{id:'bubble',maskPixels:1}]};
 return {reply,request,bytes,grayBytes,bitmap,grayBitmap,protectedRegions:[]};
}
test('only authorizes binary erasure pixels within the chosen learned text boxes',()=>{
 const f=fixture(),r=verifyLearnedMask(f);
 assert.equal(r.maskedPixels,1);assert.equal(r.outsideSelectedRegions,0);assert.equal(r.protectedRegionPixels,0);
 assert.equal(r.qualityStatus,'REQUIRES_REVIEW');
});
test('rejects stale image/model/hash/region identity evidence before inpainting',()=>{
 for(const mutate of [f=>f.reply.imageSha256='b'.repeat(64),f=>f.reply.model.sha256='0'.repeat(64),
 f=>f.reply.regions[0].id='other',f=>f.reply.regions.push({...f.reply.regions[0]}),
 f=>f.bytes[23]^=1,f=>f.grayBytes[23]^=1,f=>f.reply.algorithm='rectangular-fill',
 f=>f.reply.qualityStatus='PASSED',f=>f.reply.haloRadius=20]){
  const f=fixture();mutate(f);assert.throws(()=>verifyLearnedMask(f),{code:'TEXT_MASK_INVALID'});
 }
});
test('cannot erase pixels outside selected text or inside preserved original regions',()=>{
 const outside=fixture();outside.bitmap[3]=0;
 assert.throws(()=>verifyLearnedMask(outside),{code:'TEXT_MASK_INVALID'});
 const preserved=fixture();preserved.protectedRegions=[{id:'effect',bbox:{x:.5,y:.5,width:.1,height:.1}}];
 assert.throws(()=>verifyLearnedMask(preserved),{code:'TEXT_MASK_INVALID'});
});
test('an empty mask, partially opaque erasure, or empty member is not success',()=>{
 for(const mutate of [f=>f.bitmap.fill(255),f=>f.bitmap[(10*20+10)*4+3]=128,f=>f.reply.regions[0].maskPixels=0]){
  const f=fixture();mutate(f);assert.throws(()=>verifyLearnedMask(f),{code:'TEXT_MASK_INVALID'});
 }
});
test('the gray evidence must be the decoded inverse of the actual erasure alpha',()=>{
 for(const mutate of [f=>f.grayBitmap[0]=255,f=>f.grayBitmap[3]=0,f=>f.grayBitmap[(10*20+10)*4]=128]){
  const f=fixture();mutate(f);assert.throws(()=>verifyLearnedMask(f),{code:'TEXT_MASK_INVALID'});
 }
});
test('a claimed nonempty member cannot be empty in the decoded union mask',()=>{
 const f=fixture();f.request.regions.push({id:'empty',bbox:{x:.05,y:.05,width:.1,height:.1}});
 f.reply.regions.push({id:'empty',maskPixels:1});
 assert.throws(()=>verifyLearnedMask(f),{code:'TEXT_MASK_INVALID'});
});
test('pre-existing non-speech source text is protected even when it overlaps a learned dialogue box',()=>{
 const f=fixture(),speech={id:'bubble',bbox:f.request.regions[0].bbox},effect={type:'sound_effect',text:'ドン',bbox:{x:.5,y:.5,width:.1,height:.1}};
 f.protectedRegions=protectedOcrRegions({speechBubbles:[speech],nonSpeechText:[effect]},{decisions:[{id:'bubble',action:'translate'}]});
 assert.throws(()=>verifyLearnedMask(f),{code:'TEXT_MASK_INVALID'});
});

test('review-required source regions retain protection and reject intersecting erasure pixels',()=>{
 const f=fixture(),review={id:'uncertain',bbox:{x:.5,y:.5,width:.1,height:.1}};
 f.protectedRegions=protectedOcrRegions({speechBubbles:[review],nonSpeechText:[]},{decisions:[{id:'uncertain',action:'needs_review'}]});
 assert.equal(f.protectedRegions[0].id,'uncertain');assert.throws(()=>verifyLearnedMask(f),{code:'TEXT_MASK_INVALID'});
});

const v1='dual-context-consensus-v1',v3='source-ink-radial-halo-v3-experimental';
function v3Fixture(){
 const f=fixture();delete f.reply.haloRadius;
 Object.assign(f.reply,{algorithm:v3,maskAlgorithm:v3,clipPaddingPx:2,adaptiveHalo:true,baselineAlgorithm:v1,baselineHaloRadius:2,
  baselineSourceSha256:'9e3a662322e0d5dcf72e26d00c8a493161d390bbabf47843e94165f4d1777b9b',
  postprocessSourceSha256:'d45e3a504852c1054139ed485576c588778ea729857c7b6d30b15c3657181da7'});
 return f;
}
test('v3 requires explicit server-owned algorithm selection and keeps v1 as the default',()=>{
 const f=v3Fixture();
 assert.throws(()=>verifyLearnedMask(f),{code:'TEXT_MASK_INVALID'});
 f.reply.expectedAlgorithm=v3;
 assert.throws(()=>verifyLearnedMask(f),{code:'TEXT_MASK_INVALID'});
 const actual=verifyLearnedMask({...f,expectedAlgorithm:v3});
 assert.equal(actual.maskedPixels,1);assert.equal(actual.qualityStatus,'REQUIRES_REVIEW');
 assert.equal(verifyLearnedMask(fixture()).maskedPixels,1);
 assert.equal(verifyLearnedMask({...fixture(),expectedAlgorithm:v1}).maskedPixels,1);
});
test('unknown or mismatched server algorithms and contradictory response aliases fail closed',()=>{
 for(const expectedAlgorithm of [null,'','unknown',true,'source-ink-radial-halo-v4']){
  assert.throws(()=>verifyLearnedMask({...fixture(),expectedAlgorithm}),{code:'TEXT_MASK_INVALID'});
 }
 assert.throws(()=>verifyLearnedMask({...fixture(),expectedAlgorithm:v3}),{code:'TEXT_MASK_INVALID'});
 assert.throws(()=>verifyLearnedMask({...v3Fixture(),expectedAlgorithm:v1}),{code:'TEXT_MASK_INVALID'});
 const a=fixture();a.reply.maskAlgorithm=v3;assert.throws(()=>verifyLearnedMask(a),{code:'TEXT_MASK_INVALID'});
 const b=v3Fixture();b.reply.maskAlgorithm=v1;assert.throws(()=>verifyLearnedMask({...b,expectedAlgorithm:v3}),{code:'TEXT_MASK_INVALID'});
});
test('v3 requires both exact baseline helper and postprocessor source pins',()=>{
 for(const field of ['baselineSourceSha256','postprocessSourceSha256'])for(const value of [undefined,'0'.repeat(64)]){
  const f=v3Fixture();f.reply[field]=value;
  assert.throws(()=>verifyLearnedMask({...f,expectedAlgorithm:v3}),{code:'TEXT_MASK_INVALID'});
 }
});
test('v3 cannot report a false fixed halo or change the baseline and clipping contract',()=>{
 for(const mutate of [f=>f.reply.haloRadius=2,f=>f.reply.haloRadius=null,f=>f.reply.clipPaddingPx=3,
 f=>f.reply.clipPaddingPx=undefined,f=>f.reply.adaptiveHalo=false,f=>f.reply.adaptiveHalo='true',
 f=>f.reply.baselineAlgorithm=v3,f=>f.reply.baselineHaloRadius=3]){
  const f=v3Fixture();mutate(f);assert.throws(()=>verifyLearnedMask({...f,expectedAlgorithm:v3}),{code:'TEXT_MASK_INVALID'});
 }
});
test('explicit v3 selection cannot bypass SHA identity, binary inverse, decoded nonempty or source protection',()=>{
 for(const mutate of [f=>f.reply.imageSha256='b'.repeat(64),f=>f.reply.model.sha256='0'.repeat(64),
 f=>f.reply.executionProvider='CUDAExecutionProvider',f=>f.reply.regions[0].id='other',f=>f.bytes[23]^=1,
 f=>f.grayBytes[23]^=1,f=>f.grayBitmap[0]=255,f=>f.bitmap[(10*20+10)*4+3]=128,
 f=>f.reply.regions[0].maskPixels=0,f=>f.protectedRegions=[{id:'effect',bbox:{x:.5,y:.5,width:.1,height:.1}}]]){
  const f=v3Fixture();mutate(f);assert.throws(()=>verifyLearnedMask({...f,expectedAlgorithm:v3}),{code:'TEXT_MASK_INVALID'});
 }
 const f=v3Fixture();f.request.regions.push({id:'empty',bbox:{x:.05,y:.05,width:.1,height:.1}});f.reply.regions.push({id:'empty',maskPixels:1});
 assert.throws(()=>verifyLearnedMask({...f,expectedAlgorithm:v3}),{code:'TEXT_MASK_INVALID'});
});
