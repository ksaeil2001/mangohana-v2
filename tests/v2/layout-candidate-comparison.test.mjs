import test from'node:test';import assert from'node:assert/strict';import {createRequire}from'node:module';
const require=createRequire(import.meta.url),{createBackgroundScene,inside,overlaps}=require('../../packages/ai-engine/quality/background-layout.cjs');let api={};try{api=require('../../packages/ai-engine/quality/layout-candidate-comparison.cjs');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
function fixture(){const width=240,height=240,source=new Uint8Array(width*height*4),mask=new Uint8Array(source.length);for(let i=0;i<source.length;i+=4){source.set([180,180,180,255],i);mask.set([255,255,255,255],i);}const region={id:'one',order:1,text:'한글 문장',sourceText:'source',bbox:{x:.3,y:.2,width:.2,height:.5},allowedBbox:{x:.2,y:.15,width:.45,height:.65}},other={id:'neighbor',text:'다른 대사',bbox:{x:.75,y:.2,width:.15,height:.5}};
 const scene=createBackgroundScene({sourcePixels:source,maskPixels:mask,width,height,sourceSha256:'a'.repeat(64),maskSha256:'b'.repeat(64)}),context={width,height,regions:[region,other],sourceReviewFingerprint:'c'.repeat(64),source:{fontSha256:'d'.repeat(64)},inspectEntry:entry=>scene.inspectManual({id:entry.id,bbox:entry.bbox,allowedBbox:region.allowedBbox,otherBoxes:[region,other]})};
 return{context,region,other};
}
const metrics=entries=>entries.map(e=>({id:e.id,fontSizePx:e.fontSizePx,completeText:true,fitsBox:true,linesSeparated:true,strokeWidthPx:1,layout:{lines:[{text:e.text,relativeY:.5}]},inkBounds:[{left:90,right:105,top:90,bottom:110}]}));
test('comparison search widens only inside allowed ROI while retaining source text and adjacent OCR',()=>{
 assert.equal(typeof api.planLayoutComparison,'function');const f=fixture(),before=structuredClone(f.region),p=api.planLayoutComparison(f.context,f.region);
 assert.ok(p.entries.length>50&&p.entries.length<=160);assert.ok(p.entries.some(e=>e.bbox.width>f.region.bbox.width));for(const e of p.entries){assert.equal(e.text,f.region.text);assert.ok(e.fontSizePx>12);assert.ok(inside(e.bbox,f.region.allowedBbox));assert.equal(overlaps(e.bbox,f.other.bbox),false);}assert.deepEqual(f.region,before);
});
test('word splitting or an unsafe footprint can never be recommended despite a nominal fit claim',()=>{
 const f=fixture(),p=api.planLayoutComparison(f.context,f.region),m=metrics(p.entries).map((r,i)=>({...r,layout:{lines:i%2?[{text:'한'},{text:'글 문장'}]:[{text:f.region.text}]},inkBounds:i%2?r.inkBounds:[{left:0,right:10,top:0,bottom:10}]})),r=api.evaluateLayoutComparison(p,{entries:m});
 assert.equal(r.accepted.length,0);assert.ok(r.rejections.WORD_SPLIT>0);assert.ok(r.rejections.SOURCE_FOOTPRINT_UNVERIFIED>0);
});
test('missing, duplicate or foreign measurement IDs stay an explicit unknown',()=>{
 const f=fixture(),p=api.planLayoutComparison(f.context,f.region);for(const m of[[],metrics(p.entries).slice(1),metrics(p.entries).map(()=>metrics(p.entries)[0])])assert.throws(()=>api.evaluateLayoutComparison(p,{entries:m}),/COMPARISON_MEASUREMENT_MISMATCH/);
});
test('comparison candidates are always unsaved and cleaned-pending, preserving measured line text',()=>{
 const f=fixture(),p=api.planLayoutComparison(f.context,f.region),r=api.evaluateLayoutComparison(p,{entries:metrics(p.entries)});assert.ok(r.accepted.length>0);for(const c of r.accepted){assert.equal(c.saved,false);assert.equal(c.approved,false);assert.equal(c.actualCleanedVerified,false);assert.equal(c.actualRasterVerified,false);assert.deepEqual(c.measurement.layout.lines.map(l=>l.text),[f.region.text]);}
});
test('a claimed white-component route cannot recommend ink outside its logical component even if a manual ROI is reviewable',()=>{
 const f=fixture(),logicalWhiteInterior={mask:new Uint8Array(240*240),left:0,top:0,width:240,height:240},p=api.planLayoutComparison(f.context,f.region,{logicalWhiteInterior,requireWhiteComponent:true}),r=api.evaluateLayoutComparison(p,{entries:metrics(p.entries)});
 assert.equal(r.accepted.length,0);assert.ok(r.rejections.LOGICAL_WHITE_COMPONENT_FOOTPRINT_UNVERIFIED>0);
});
