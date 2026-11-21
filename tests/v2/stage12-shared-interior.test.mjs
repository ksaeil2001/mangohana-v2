import test from 'node:test';import assert from 'node:assert/strict';import {tsImport} from 'tsx/esm/api';
const {inferCandidateBox}=await tsImport('../../packages/ai-engine/vendor/trio/scripts/local-preview/renderer.ts',import.meta.url);
const {isInsetInteriorRectangle}=await tsImport('../../packages/ai-engine/vendor/trio/src/renderer/candidateTypesettingFit.ts',import.meta.url);
const width=240,height=200;
function fixture({hole=false,edge=false,open=false,overlap=false}={}){
 const raw=new Uint8ClampedArray(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=(y*width+x)*4,white=open||x>=40&&x<170&&y>=20&&y<180;raw[at]=raw[at+1]=raw[at+2]=white?255:0;raw[at+3]=255;}
 if(hole){const at=(70*width+65)*4;raw[at]=raw[at+1]=raw[at+2]=0;}
 const bbox={x:(edge?41:50)/width,y:50/height,width:45/width,height:80/height};
 const other={id:'b',bbox:{x:(overlap?80:110)/width,y:50/height,width:45/width,height:80/height}};
 const line={id:'a',order:1,pageNumber:1,sourceText:'原文',aiTranslation:'짧은 한국어',typesetting:{bbox,writingMode:'horizontal-tb'}};
 const context={getImageData(left,top,w,h){const data=new Uint8ClampedArray(w*h*4);for(let y=0;y<h;y++)data.set(raw.subarray(((top+y)*width+left)*4,((top+y)*width+left+w)*4),y*w*4);return {data};}};
 return {line,boxes:[{id:'a',bbox},other],context};
}
function infer(f){return inferCandidateBox(f.context,f.line,f.boxes,width,height);}
test('two independent OCR boxes in one closed balloon can retain their own fully inset box',()=>{
 const f=fixture(),before=structuredClone(f.line),r=infer(f);
 assert.ok(r.interior,'a shared component must be verified without expanding into the other source');
 assert.equal(r.expanded,false);assert.deepEqual(r.bbox,f.line.typesetting.bbox);assert.deepEqual(f.line,before);
 const other=structuredClone(f.line);other.id='b';other.typesetting.bbox=structuredClone(f.boxes[1].bbox);
 const second=inferCandidateBox(f.context,other,f.boxes,width,height);assert.ok(second.interior);assert.deepEqual(second.bbox,other.typesetting.bbox);assert.equal(second.expanded,false);
});
for(const option of ['edge','open','overlap'])test('shared safe area remains unverified for '+option,()=>{
 const f=fixture({[option]:true}),r=infer(f);assert.equal(r.interior,undefined);assert.equal(r.expanded,false);assert.deepEqual(r.bbox,f.line.typesetting.bbox);
});
for(const option of ['hole'])test('shared safe inset excludes '+option+' without expanding the original ROI',()=>{
 const f=fixture({[option]:true}),r=infer(f);assert.ok(r.interior);assert.equal(r.expanded,false);
 const b=r.bbox,s=f.line.typesetting.bbox;assert.ok(b.x>=s.x&&b.y>=s.y&&b.x+b.width<=s.x+s.width+1e-12&&b.y+b.height<=s.y+s.height+1e-12);
 assert.equal(isInsetInteriorRectangle(r.interior.mask,r.interior.width,r.interior.height,{x:Math.round(b.x*width)-r.interior.left,y:Math.round(b.y*height)-r.interior.top,width:Math.round(b.width*width),height:Math.round(b.height*height)}),true);
});
test('a retained box must avoid every other original ROI even if its center is not in the component',()=>{
 const f=fixture();f.boxes.push({id:'c',bbox:{x:0,y:0,width:65/width,height:70/height}});
 assert.equal(infer(f).interior,undefined);
});
test('the shared branch preserves all user owned and unsupported layouts',()=>{
 for(const patch of [{userTranslation:'사용자 번역'},{ocrUserOwnedFields:['geometry']},{typesetting:{fontSizeRatio:.2}},{typesetting:{rotationDegrees:15}},{typesetting:{writingMode:'vertical-rl'}}]){
  const f=fixture();if(patch.typesetting)Object.assign(f.line.typesetting,patch.typesetting);else Object.assign(f.line,patch);const before=structuredClone(f.line);
  assert.equal(infer(f).interior,undefined);assert.deepEqual(f.line,before);
 }
});
test('a unique closed balloon keeps the existing inferred expansion path',()=>{
 const f=fixture();f.boxes=f.boxes.slice(0,1);const r=infer(f);assert.ok(r.interior);assert.equal(r.expanded,true);
 assert.ok(r.bbox.width*r.bbox.height>=f.line.typesetting.bbox.width*f.line.typesetting.bbox.height);
});
test('fixed inset proof rejects invalid, fractional, tiny or out-of-frame rectangles',()=>{
 const mask=new Uint8Array(100*100).fill(1),box={x:20,y:20,width:30,height:30};assert.equal(isInsetInteriorRectangle(mask,100,100,box),true);
 for(const bad of [{...box,x:NaN},{...box,x:20.5},{...box,width:9},{...box,x:-1},{...box,x:95}])assert.equal(isInsetInteriorRectangle(mask,100,100,bad),false);
 assert.equal(isInsetInteriorRectangle(new Uint8Array(1),100,100,box),false);
});
test('a dark pixel in the retained margin rejects the proof even outside the text box',()=>{
 const mask=new Uint8Array(100*100).fill(1),box={x:20,y:20,width:30,height:30};mask[30*100+18]=0;
 assert.equal(isInsetInteriorRectangle(mask,100,100,box),false);
});

test('first automatic layout can consider wider, disjoint rectangles inside a shared white balloon', () => {
 const f = fixture();
 const options = { protectedBoxes: [] };
 const first = inferCandidateBox(f.context, f.line, f.boxes, width, height, undefined, options);
 const other = { ...f.line, id: 'b', typesetting: { ...f.line.typesetting, bbox: f.boxes[1].bbox } };
 const second = inferCandidateBox(f.context, other, f.boxes, width, height, undefined, options);
 assert.deepEqual(first.bbox, f.line.typesetting.bbox);
 assert.deepEqual(second.bbox, other.typesetting.bbox);
 assert.ok(first.widerSharedBox?.width > f.line.typesetting.bbox.width * width);
 assert.ok(second.widerSharedBox?.width > other.typesetting.bbox.width * width);
 assert.ok(first.widerSharedBox.left + first.widerSharedBox.width < second.widerSharedBox.left);
 for (const layout of [first, second]) {
   const box = layout.widerSharedBox;
   const interior = layout.interior;
   assert.equal(isInsetInteriorRectangle(interior.mask, interior.width, interior.height, {
     x: box.left - interior.left, y: box.top - interior.top, width: box.width, height: box.height,
   }), true);
 }
});

test('a protected neighbor, an explicit allowed box, or diagonal ownership leaves the original arrangement', () => {
 const f = fixture();
 const options = { protectedBoxes: [{ x: 46 / width, y: 41 / height, width: 3 / width, height: 30 / height }] };
 const blocked = inferCandidateBox(f.context, f.line, f.boxes, width, height, undefined, options);
 assert.equal(blocked.widerSharedBox, undefined);
 assert.deepEqual(blocked.bbox, f.line.typesetting.bbox);
 const bounded = inferCandidateBox(f.context, f.line, f.boxes, width, height, f.line.typesetting.bbox, { protectedBoxes: [] });
 assert.equal(bounded.widerSharedBox, undefined);
 f.boxes[1].bbox = { ...f.boxes[1].bbox, y: 142 / height, height: 22 / height };
 const diagonal = inferCandidateBox(f.context, f.line, f.boxes, width, height, undefined, { protectedBoxes: [] });
 assert.ok(diagonal.interior);
 assert.equal(diagonal.widerSharedBox, undefined);
});
