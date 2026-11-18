import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),api=require('../../packages/ai-engine/quality/imported-layout-background.cjs'),{inferCandidateBox}=require('../../packages/ai-engine/.build/layout-source-geometry.cjs');
const hex=c=>c.repeat(64),width=680,height=220,box=(x,y,w,h)=>({x:x/width,y:y/height,width:w/width,height:h/height});
function fixture(){
 const sourcePixels=Buffer.alloc(width*height*4,255),maskPixels=Buffer.alloc(sourcePixels.length,255),lines=Array.from({length:13},(_,i)=>({id:'synthetic-'+i,order:i+1,bbox:box(16+i*50,65,28,80),userTranslation:i===11?'아싸~!':'안녕 친구.'}));
 // Closed white balloons with dark outer boundaries. A conservative source bbox
 // can include its border; the production geometry must find the real interior.
 for(let i=0;i<13;i++)for(let y=40;y<175;y++)for(let x=10+i*50;x<50+i*50;x++)if(x===10+i*50||x===49+i*50||y===40||y===174){const at=(y*width+x)*4;sourcePixels[at]=sourcePixels[at+1]=sourcePixels[at+2]=0;}
 const manualOrders=[2,4,5,6,7,8,11,12],manualEntries=lines.filter(l=>manualOrders.includes(l.order)).map(l=>({id:l.id,bbox:l.bbox,fontSizePx:20,lineHeight:1.4,text:l.userTranslation}));
 return {inputs:{current:{normalizedSha256:hex('a')},lines,layoutReview:{planSha256:hex('d')}},maskEvidence:{width,height,maskSha256:hex('b'),layoutRegions:lines.map(l=>({...l,allowedBbox:box(11+(l.order-1)*50,41,38,133)})),extraction:{nonSpeechText:[]}},manualEntries,sourcePixels,cleanedPixels:Buffer.from(sourcePixels),maskPixels,cleanedSha256:hex('c'),inferCandidateBox};
}
test('production cleaned inspection collects thirteen backgrounds with eight manual/five automatic and no final-image claim',()=>{
 assert.equal(typeof api.inspectCleanedBackgrounds,'function');const f=fixture(),before=JSON.stringify(f.manualEntries),r=api.inspectCleanedBackgrounds(f);assert.equal(r.version,4);assert.equal(r.regions.length,13);assert.equal(r.blocked,0);assert.equal(r.regions.filter(x=>x.manualApproved).length,8);assert.equal(r.regions.filter(x=>!x.manualApproved).length,5);assert.deepEqual(r.inspectionOrder.slice(0,2),[2,4]);assert.ok(r.regions.every(x=>x.textFitStatus==='PENDING'&&x.finalRasterStatus==='PENDING'));assert.equal(JSON.stringify(f.manualEntries),before);assert.equal(f.manualEntries.find(x=>x.text==='아싸~!').text.split('\n').length,1);
});
test('mixed bbox/margin sampling does not override a verified closed-white interior',()=>{
 const f=fixture();f.inputs.lines[0].bbox=box(10,40,40,135);f.maskEvidence.layoutRegions[0].allowedBbox=f.inputs.lines[0].bbox;const r=api.inspectCleanedBackgrounds(f),one=r.regions[0];assert.equal(one.backgroundStatus,'SAFE_PIXELS_VERIFIED');assert.equal(one.basis,'CLOSED_WHITE_COMPONENT_INSET_RECTANGLE');assert.equal(one.uniformFallback.status,'MANUAL_LAYOUT_REQUIRED');assert.ok(one.uniformFallback.evidence.sampling.cleanedInside.range.includes(255));
});
test('one rejected actual background retains independent diagnostics for the other twelve',()=>{
 const f=fixture();f.manualEntries=f.manualEntries.filter(e=>e.id!==f.inputs.lines[3].id);const b=f.inputs.lines[3].bbox;for(let y=50;y<165;y++)for(let x=11+3*50;x<49+3*50;x++){const at=(y*width+x)*4,v=(x+y)%2?50:200;f.sourcePixels[at]=f.sourcePixels[at+1]=f.sourcePixels[at+2]=v;f.cleanedPixels[at]=f.cleanedPixels[at+1]=f.cleanedPixels[at+2]=v;}
 const r=api.inspectCleanedBackgrounds(f);assert.equal(r.regions.length,13);assert.ok(r.blocked>=1);assert.equal(r.regions[3].backgroundStatus,'MANUAL_LAYOUT_REQUIRED');assert.ok(r.regions[3].reasonCodes.includes('BACKGROUND_NOT_UNIFORM'));assert.equal(r.regions[12].backgroundStatus,'SAFE_PIXELS_VERIFIED');assert.deepEqual(f.inputs.lines[3].bbox,b);
});
test('uniform gray and colored backgrounds keep existing contrast and protection contracts',()=>{
 for(const color of [[190,190,190],[100,160,220]]){const f=fixture(),l=f.inputs.lines[0];for(let y=45;y<170;y++)for(let x=11;x<49;x++){const at=(y*width+x)*4;for(let k=0;k<3;k++)f.sourcePixels[at+k]=f.cleanedPixels[at+k]=color[k];}const r=api.inspectCleanedBackgrounds(f);assert.equal(r.regions[0].backgroundStatus,'SAFE_PIXELS_VERIFIED');assert.equal(r.regions[0].basis,'UNIFORM_BACKGROUND_INSET_RECTANGLE');assert.ok(r.regions[0].background.minimumContrast>=4.5);assert.equal(l.id,'synthetic-0');}
});
test('mask-outside changes fail closed and never report thirteen safe regions',()=>{
 const f=fixture();f.cleanedPixels[0]=0;assert.throws(()=>api.inspectCleanedBackgrounds(f),{code:'BACKGROUND_PROTECTED_PIXEL_CHANGED'});
});
test('shared closed balloon preserves separate IDs and prevents expansion into neighboring text',()=>{
 const f=fixture();f.manualEntries=f.manualEntries.filter(e=>![f.inputs.lines[4].id,f.inputs.lines[5].id].includes(e.id));
 // Join two existing white interiors by removing their internal border only.
 for(let y=41;y<174;y++)for(let x=249;x<=260;x++){const at=(y*width+x)*4;f.sourcePixels[at]=f.sourcePixels[at+1]=f.sourcePixels[at+2]=255;f.cleanedPixels[at]=f.cleanedPixels[at+1]=f.cleanedPixels[at+2]=255;}
 const r=api.inspectCleanedBackgrounds(f);for(const n of [4,5]){assert.equal(r.regions[n].id,f.inputs.lines[n].id);assert.equal(r.regions[n].backgroundStatus,'SAFE_PIXELS_VERIFIED');assert.deepEqual(r.regions[n].candidateBbox,f.inputs.lines[n].bbox);assert.equal(r.regions[n].whiteSearch.expanded,false);}assert.equal(r.regions.length,13);
});
test('another OCR or protected artwork bbox cannot be hidden by closed-white acceptance',()=>{
 const f=fixture();f.maskEvidence.extraction.nonSpeechText.push({bbox:{...f.inputs.lines[0].bbox}});const r=api.inspectCleanedBackgrounds(f);assert.equal(r.regions[0].backgroundStatus,'MANUAL_LAYOUT_REQUIRED');assert.deepEqual(r.regions[0].reasonCodes,['ROI_OR_OTHER_REGION_CONFLICT']);assert.equal(r.regions[12].backgroundStatus,'SAFE_PIXELS_VERIFIED');
});
