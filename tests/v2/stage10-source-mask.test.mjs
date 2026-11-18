import test from 'node:test';
import assert from 'node:assert/strict';
import {tsImport} from 'tsx/esm/api';
import {outlinedFixture,rasterStats} from './stage10-mask-fixture.mjs';
const {buildSourceTextMask}=await tsImport('../../packages/ai-engine/vendor/trio/src/shared/sourceTextMask.ts',import.meta.url);
const build=(f,options)=>buildSourceTextMask({width:f.width,height:f.height,pixels:f.source},f.regions,options);

test('bounded outline candidate covers the closed thick white contour and its AA without touching protected ink',()=>{
 const f=outlinedFixture(),before=f.source.slice(),r=build(f,{outlinePolicy:'bounded-component-v1'}),s=rasterStats(f,r.pixels);
 assert.equal(s.core.numerator,s.core.denominator);assert.equal(s.outline.numerator,s.outline.denominator);
 assert.equal(s.antialias.numerator,s.antialias.denominator);assert.equal(s.protectionIntrusion.numerator,0);
 assert.deepEqual(f.source,before);assert.equal(r.maskedPixels,r.pixels.filter(Boolean).length);
});
test('the default stays byte identical to the explicitly selected legacy outline policy',()=>{
 const f=outlinedFixture();assert.deepEqual(build(f),build(f,{outlinePolicy:'legacy'}));
});
test('an unrecognized outline policy cannot silently select an experiment',()=>{
 assert.throws(()=>build(outlinedFixture(),{outlinePolicy:'unknown'}));
});
test('a white balloon interior cannot authorize wholesale removal and an empty selection never reaches LaMa',()=>{
 const f=outlinedFixture({halo:2});for(let i=0;i<f.source.length;i+=4)if(!f.core[i/4]&&!f.protection[i/4])f.source.set([255,255,255,255],i);
 const r=build(f,{outlinePolicy:'bounded-component-v1'});assert.ok(r.maskedPixels<f.width*f.height/4);assert.equal(rasterStats(f,r.pixels).protectionIntrusion.numerator,0);
 assert.throws(()=>buildSourceTextMask({width:f.width,height:f.height,pixels:f.source},[]));
});
test('bounded component includes gray and semitransparent antialias without changing source alpha',()=>{
 const f=outlinedFixture({edgeAlpha:128}),r=build(f,{outlinePolicy:'bounded-component-v1'}),s=rasterStats(f,r.pixels);
 assert.equal(s.antialias.numerator,s.antialias.denominator);assert.equal(s.protectionIntrusion.numerator,0);
});
test('a separate small punctuation component remains removable beside the larger outlined glyph',()=>{
 const f=outlinedFixture();for(let y=74;y<76;y++)for(let x=49;x<51;x++){const at=y*f.width+x;f.source.set([0,0,0,255],at*4);f.core[at]=255;}
 f.regions.push({id:'punctuation',polygonsPx:[[{x:47,y:72},{x:53,y:72},{x:53,y:78},{x:47,y:78}]]});
 const r=build(f,{outlinePolicy:'bounded-component-v1'}),s=rasterStats(f,r.pixels);assert.equal(s.core.numerator,s.core.denominator);assert.equal(s.protectionIntrusion.numerator,0);
});
test('character ink both adjacent to and separated from text remains protected in the synthetic page',()=>{
 const f=outlinedFixture();for(let y=45;y<65;y++){const at=y*f.width+80;f.source.set([0,0,0,255],at*4);f.background.set([0,0,0,255],at*4);f.protection[at]=255;}
 const r=build(f,{outlinePolicy:'bounded-component-v1'});assert.equal(rasterStats(f,r.pixels).protectionIntrusion.numerator,0);
});
