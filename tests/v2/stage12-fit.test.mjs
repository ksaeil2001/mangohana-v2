import test from 'node:test';
import assert from 'node:assert/strict';
import {tsImport} from 'tsx/esm/api';
const fit=await tsImport('../../packages/ai-engine/vendor/trio/src/renderer/candidateTypesettingFit.ts',import.meta.url);
const {renderTypesettingToCanvas}=await tsImport('../../packages/ai-engine/vendor/trio/src/renderer/imageBurnInRenderer.ts',import.meta.url);
const style={bbox:{x:.1,y:.1,width:.7,height:.6},writingMode:'horizontal-tb',shape:'rectangle',fontSizeRatio:.1,lineHeight:2};
function context(){const calls=[];return {calls,font:'',save(){},restore(){},translate(){},rotate(){},fillText(t,x,y){calls.push({t,x,y,font:this.font});},strokeText(){},measureText(t){const size=+(this.font.match(/([\d.]+)px/)?.[1]??12);return {width:[...t].length*size*.7,actualBoundingBoxLeft:0,actualBoundingBoxRight:[...t].length*size*.7,actualBoundingBoxAscent:size*.45,actualBoundingBoxDescent:size*.45};}};}
test('the default actual painter honors a manual lineHeight instead of silently reverting to 1.25',()=>{
 const c=context();renderTypesettingToCanvas(c,[{userTranslation:'첫째\n둘째',typesetting:style}],500,500);
 assert.equal(c.calls.length,2);assert.ok(Math.abs(c.calls[1].y-c.calls[0].y-60)<1e-9);
});
test('invalid candidate coordinates or dimensions fail before measurement',()=>{
 for(const bad of [{...style,bbox:{...style.bbox,width:NaN}},{...style,bbox:{...style.bbox,x:-1}},{...style,lineHeight:NaN}])assert.throws(()=>fit.measureCandidateFit(context(),'한글',bad,500,500));
 assert.throws(()=>fit.measureCandidateFit(context(),'한글',style,0,500));
});
test('manual 5px type is preserved and reported for layout review rather than silently enlarged',()=>{
 const r=fit.measureCandidateFit(context(),'한글',{...style,fontSizeRatio:.01},500,500);assert.equal(r.fontSizePx,3);assert.equal(r.status,'MANUAL_LAYOUT_REQUIRED');
});
test('raster inspection validates the interior coordinate frame instead of assuming ROI is a mask',()=>{
 assert.throws(()=>fit.inspectCandidateInk(new Uint8ClampedArray(4*4*4),4,4,{mask:new Uint8Array(1),left:0,top:0,width:4,height:4}));
});
test('pixel evidence distinguishes empty ink, canvas-edge contact and unmeasured interior',()=>{
 const a=new Uint8ClampedArray(4*4*4);let r=fit.inspectCandidateInk(a,4,4);assert.equal(r.hasInk,false);assert.equal(r.outsideInteriorPixels,null);
 a[3]=255;r=fit.inspectCandidateInk(a,4,4);assert.equal(r.canvasEdgePixels,1);assert.equal(r.hasInk,true);
});
test('text completeness detects deletion, duplication, changed spacing and misplaced hard breaks',()=>{
 assert.equal(typeof fit.inspectTypesettingText,'function');
 for(const [s,l] of [['한글',['한']],['한글',['한글글']],['둘  사이',['둘 사이']],['첫째\n둘째',['첫째둘째']]])assert.equal(fit.inspectTypesettingText(s,l).complete,false);
 assert.equal(fit.inspectTypesettingText('둘  사이\n\n문장',['둘','사이','','문장']).complete,true);
});
test('manual style values are not mutated by measurement',()=>{const before=structuredClone(style);fit.measureCandidateFit(context(),'안녕!',style,500,500);assert.deepEqual(style,before);});
test('automatic font candidate prefers intact Korean words over slightly larger fragmented text',()=>{
 const r=fit.measureCandidateFit(context(),'이 말풍선의 대사야.',{bbox:{x:.1,y:.1,width:.35,height:.5},writingMode:'horizontal-tb',shape:'rectangle'},500,500);
 assert.ok(r.layout.lines.some(l=>l.text.includes('말풍선의')));assert.ok(r.fontSizePx>=10);assert.ok(r.selection.candidatesMeasured>0);
});
test('default Canvas layout measures the actual selected font instead of a character-width heuristic',()=>{
 const c=context(),measured=[],original=c.measureText;c.measureText=function(t){measured.push(this.font);return original.call(this,t);};
 renderTypesettingToCanvas(c,[{userTranslation:'WWW 한글 혼합 문자열',typesetting:{...style,fontSizeRatio:undefined}}],500,500);
 assert.ok(measured.length>0);assert.ok(measured.every(f=>f.includes('Pretendard')));assert.ok(c.calls.every(v=>v.font.includes('Pretendard')));
});
