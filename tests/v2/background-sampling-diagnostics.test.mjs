import test from'node:test';import assert from'node:assert/strict';import {createRequire}from'node:module';
const require=createRequire(import.meta.url),{createBackgroundScene}=require('../../packages/ai-engine/quality/background-layout.cjs');
test('uniformity rejection distinguishes candidate pixels from the surrounding sampling margin',()=>{
 const width=150,height=150,source=new Uint8Array(width*height*4),mask=new Uint8Array(source.length);for(let i=0;i<source.length;i+=4){source.set([180,180,180,255],i);mask.set([255,255,255,255],i);}source.set([0,0,0,255],(70*width+49)*4);
 const scene=createBackgroundScene({sourcePixels:source,maskPixels:mask,width,height,sourceSha256:'a'.repeat(64),maskSha256:'b'.repeat(64)}),r=scene.inspectUniform({id:'region',bbox:{x:50/150,y:50/150,width:50/150,height:50/150}});
 assert.deepEqual(r.reasonCodes,['BACKGROUND_NOT_UNIFORM']);assert.deepEqual(r.evidence.sampling.inside.range,[0,0,0]);assert.deepEqual(r.evidence.sampling.margin.range,[180,180,180]);assert.equal(r.evidence.sampling.inside.count,2500);
});
