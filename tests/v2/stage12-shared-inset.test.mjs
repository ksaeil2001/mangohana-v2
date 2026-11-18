import test from 'node:test';import assert from 'node:assert/strict';import {tsImport} from 'tsx/esm/api';
const {inferCandidateBox}=await tsImport('../../packages/ai-engine/vendor/trio/scripts/local-preview/renderer.ts',import.meta.url);
const {isInsetInteriorRectangle}=await tsImport('../../packages/ai-engine/vendor/trio/src/renderer/candidateTypesettingFit.ts',import.meta.url);
function fixture({open=false,hole=false,overlap=false}={}){
 const width=240,height=200,raw=new Uint8ClampedArray(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=(y*width+x)*4,v=open||x>=40&&x<210&&y>=20&&y<180?255:0;raw.set([v,v,v,255],at);}
 if(hole)for(let y=60;y<65;y++)for(let x=60;x<65;x++)raw.set([0,0,0,255],(y*width+x)*4);
 const bbox={x:39/width,y:40/height,width:72/width,height:100/height},other={id:'neighbor',bbox:{x:(overlap?100:130)/width,y:40/height,width:50/width,height:100/height}};
 const line={id:'first',pageNumber:1,order:1,sourceText:'原文',aiTranslation:'공유 말풍선',typesetting:{bbox,writingMode:'horizontal-tb'}};
 const context={getImageData(left,top,w,h){const data=new Uint8ClampedArray(w*h*4);for(let y=0;y<h;y++)data.set(raw.subarray(((top+y)*width+left)*4,((top+y)*width+left+w)*4),y*w*4);return{data};}};
 return{width,height,raw,line,boxes:[{id:line.id,bbox},other],context};
}
function check(f,r){assert.ok(r.interior);assert.equal(r.expanded,false);const b=r.bbox,s=f.line.typesetting.bbox;assert.ok(b.x>=s.x&&b.y>=s.y&&b.x+b.width<=s.x+s.width+1e-12&&b.y+b.height<=s.y+s.height+1e-12);
 const box={x:Math.round(b.x*f.width)-r.interior.left,y:Math.round(b.y*f.height)-r.interior.top,width:Math.round(b.width*f.width),height:Math.round(b.height*f.height)};
 assert.equal(isInsetInteriorRectangle(r.interior.mask,r.interior.width,r.interior.height,box),true);
 for(let y=0;y<box.height;y++)for(let x=0;x<box.width;x++)assert.equal(f.raw[((box.y+r.interior.top+y)*f.width+box.x+r.interior.left+x)*4],255);
}
test('a shared closed balloon searches a fully padded smaller rectangle when the OCR envelope includes its border',()=>{
 const f=fixture(),before=structuredClone(f.line),r=inferCandidateBox(f.context,f.line,f.boxes,f.width,f.height);check(f,r);
 assert.deepEqual(r.bbox,{x:47/240,y:40/200,width:64/240,height:100/200});assert.deepEqual(f.line,before);
});
test('shared inset search excludes an interior drawing hole and keeps the full component margin',()=>{
 const f=fixture({hole:true}),r=inferCandidateBox(f.context,f.line,f.boxes,f.width,f.height);check(f,r);
});
for(const flag of ['open','overlap'])test('shared inset stays unverified for '+flag,()=>{
 const f=fixture({[flag]:true}),r=inferCandidateBox(f.context,f.line,f.boxes,f.width,f.height);assert.equal(r.interior,undefined);assert.deepEqual(r.bbox,f.line.typesetting.bbox);
});
