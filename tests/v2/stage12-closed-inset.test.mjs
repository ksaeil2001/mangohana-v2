import test from 'node:test';import assert from 'node:assert/strict';import {tsImport} from 'tsx/esm/api';
const {inferCandidateBox}=await tsImport('../../packages/ai-engine/vendor/trio/scripts/local-preview/renderer.ts',import.meta.url);
const {findInteriorRectangle,isInsetInteriorRectangle}=await tsImport('../../packages/ai-engine/vendor/trio/src/renderer/candidateTypesettingFit.ts',import.meta.url);

function fixture({open=false,overlap=false,gray=false,hole=false}={}){
 const width=200,height=200,raw=new Uint8ClampedArray(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=(y*width+x)*4,value=open||x>=40&&x<150&&y>=20&&y<180?(gray?180:255):0;raw[at]=raw[at+1]=raw[at+2]=value;raw[at+3]=255;}
 if(hole)for(let y=70;y<110;y++)for(let x=80;x<90;x++){const at=(y*width+x)*4;raw[at]=raw[at+1]=raw[at+2]=0;}
 const bbox={x:39/width,y:30/height,width:112/width,height:145/height};
 const line={id:'dialogue',order:1,pageNumber:1,sourceText:'原文',aiTranslation:'그대로 보존하는 번역',typesetting:{bbox,writingMode:'horizontal-tb'}};
 const boxes=[{id:line.id,bbox}];if(overlap)boxes.push({id:'other',bbox:{x:149/width,y:80/height,width:30/width,height:50/height}});
 const context={getImageData(left,top,w,h){const data=new Uint8ClampedArray(w*h*4);for(let y=0;y<h;y++)data.set(raw.subarray(((top+y)*width+left)*4,((top+y)*width+left+w)*4),y*w*4);return {data};}};
 return {width,height,raw,line,boxes,context};
}
const infer=f=>inferCandidateBox(f.context,f.line,f.boxes,f.width,f.height);
function checkEveryWhitePixel(f,r){const b=r.bbox,left=Math.round(b.x*f.width),top=Math.round(b.y*f.height),right=Math.round((b.x+b.width)*f.width),bottom=Math.round((b.y+b.height)*f.height);for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)assert.equal(f.raw[(y*f.width+x)*4],255,'candidate includes a dark source pixel');}

test('a closed balloon keeps a smaller safe rectangle inside an OCR ROI that includes its border',()=>{
 const f=fixture(),before=structuredClone(f.line),result=infer(f);
 assert.ok(result.interior,'verified white space must not be discarded only because it is smaller than the OCR envelope');
 assert.deepEqual(result.bbox,{x:45/200,y:30/200,width:100/200,height:145/200});assert.equal(result.expanded,false);
 assert.deepEqual(f.line,before);checkEveryWhitePixel(f,result);
 assert.equal(isInsetInteriorRectangle(result.interior.mask,result.interior.width,result.interior.height,{x:45-result.interior.left,y:30-result.interior.top,width:100,height:145}),true);
});

test('bounded white-rectangle search retains padding from the entire component',()=>{
 const width=200,height=200,mask=new Uint8Array(width*height);for(let y=10;y<190;y++)for(let x=10;x<190;x++)mask[y*width+x]=1;
 // Full component: 180px minimum dimension -> ceil(4%) = 8px, even though the permitted ROI is only 30px wide.
 const result=findInteriorRectangle(mask,width,height,{x:25,y:70},{x:10,y:30,width:30,height:80});
 assert.deepEqual(result,{x:18,y:30,width:22,height:80,padding:8});
});

test('bounded search returns no rectangle when the requested ROI is outside the white component',()=>{
 const mask=new Uint8Array(100*100);for(let y=10;y<90;y++)for(let x=10;x<90;x++)mask[y*100+x]=1;
 assert.equal(findInteriorRectangle(mask,100,100,{x:5,y:50},{x:0,y:30,width:8,height:40}),undefined);
});

for(const condition of ['open','gray','overlap'])test('smaller inset remains unverified for '+condition,()=>{
 const f=fixture({[condition]:true}),before=structuredClone(f.line),result=infer(f);assert.equal(result.interior,undefined);assert.deepEqual(result.bbox,before.typesetting.bbox);assert.deepEqual(f.line,before);
});

test('a bounded candidate cannot cover a hole even when some white space remains usable',()=>{
 const f=fixture({hole:true}),result=infer(f);assert.ok(result.interior);checkEveryWhitePixel(f,result);
 assert.ok(result.bbox.x>=f.line.typesetting.bbox.x&&result.bbox.y>=f.line.typesetting.bbox.y);
 assert.ok(result.bbox.x+result.bbox.width<=f.line.typesetting.bbox.x+f.line.typesetting.bbox.width+1e-12);
 assert.ok(result.bbox.y+result.bbox.height<=f.line.typesetting.bbox.y+f.line.typesetting.bbox.height+1e-12);
});

test('the smaller-inset branch leaves user-owned, manual-size and rotated geometry unchanged',()=>{
 for(const patch of [{userTranslation:'사용자 번역'},{ocrUserOwnedFields:['geometry']},{typesetting:{fontSizeRatio:.2}},{typesetting:{rotationDegrees:15}},{typesetting:{writingMode:'vertical-rl'}}]){
  const f=fixture();if(patch.typesetting)Object.assign(f.line.typesetting,patch.typesetting);else Object.assign(f.line,patch);const before=structuredClone(f.line),result=infer(f);
  assert.equal(result.interior,undefined);assert.deepEqual(result.bbox,before.typesetting.bbox);assert.deepEqual(f.line,before);
 }
});
