import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{verifyImportedLayout}=require('../../packages/ai-engine/quality/imported-image-contract.cjs');
const selected='사람이 승인한 비공개 번역',rendered='다른 비공개 문장';
const line={id:'r1',userTranslation:selected};
const valid=()=>({id:'r1',productionFontLoaded:true,glyphFontLoaded:true,glyphEvidence:{missingGlyphOccurrences:0},textEvidence:{complete:true},fitStatus:'FIT_VERIFIED',fontSizePx:14,measuredFit:{completeText:true,fitsBox:true,linesSeparated:true,inkBounds:[{left:10,right:100,top:10,bottom:25},{left:10,right:100,top:30,bottom:45}]},safeAreaEvidence:{basis:'CLOSED_WHITE_COMPONENT_INSET_RECTANGLE'},raster:{paintedPixels:10,outsideInteriorPixels:0,clippedPixels:0,canvasEdgePixels:0,otherRegionCollisionPixels:0,overlappingInkPixels:0},actualLayout:{lines:[{text:'사람이 승인한'},{text:'비공개 번역'}]}});
test('valid layout still passes every existing output guard',()=>assert.equal(verifyImportedLayout([valid()],[line]).status,'PASS'));
for(const [name,change,reason,value]of [
 ['small font',{fontSizePx:12},'FONT_SIZE_NOT_SAFE',12],['unknown font',{fontSizePx:undefined},'FONT_SIZE_NOT_SAFE',null],['warning',{fitStatus:'FIT_WARNING'},'FIT_STATUS_NOT_VERIFIED','FIT_WARNING'],
 ['unknown safe area',{safeAreaEvidence:{basis:'UNVERIFIED_ROI_OR_MANUAL_GEOMETRY'}},'SAFE_AREA_NOT_VERIFIED','UNVERIFIED_ROI_OR_MANUAL_GEOMETRY'],
 ['overlapping lines',{measuredFit:{completeText:true,fitsBox:true,linesSeparated:false}},'LINE_SEPARATION_NOT_VERIFIED',false],['missing measurements',{measuredFit:undefined},'COMPLETE_TEXT_NOT_VERIFIED',null]
])test('rejected '+name+' preserves the failed region and exact measurement without weakening guard',()=>{
 const layout={...valid(),...change};let error;try{verifyImportedLayout([layout],[line]);}catch(e){error=e;}assert.equal(error?.code,'MANUAL_LAYOUT_REQUIRED');assert.ok(error.layoutDiagnostics,'missing failure measurements');
 const region=error.layoutDiagnostics.regions[0];assert.equal(region.id,'r1');assert.ok(region.failures.includes(reason));
 const actual=name.includes('font')?region.fontSizePx:name==='warning'?region.fitStatus:name==='unknown safe area'?region.safeAreaBasis:name==='overlapping lines'?region.measuredFit.linesSeparated:region.measuredFit.completeText;
 assert.equal(actual,value);assert.ok(!JSON.stringify(error.layoutDiagnostics).includes(selected));
});
test('diagnostics retain overflow and text mismatch failures without copying translated text',()=>{
 for(const [change,code]of [[{raster:{...valid().raster,clippedPixels:1}},'TYPESET_OVERFLOW'],[{actualLayout:{lines:[{text:rendered}]}},'TYPESET_TEXT_MISMATCH']]){
  let error;try{verifyImportedLayout([{...valid(),...change}],[line]);}catch(e){error=e;}assert.equal(error.code,code);assert.ok(error.layoutDiagnostics);const json=JSON.stringify(error.layoutDiagnostics);assert.ok(!json.includes(selected)&&!json.includes(rendered));
 }
});
test('missing region diagnostics keep unknown measurements null and report count mismatch',()=>{
 let error;try{verifyImportedLayout([],[line]);}catch(e){error=e;}assert.equal(error.code,'TYPESET_RESULT');assert.ok(error.layoutDiagnostics);assert.equal(error.layoutDiagnostics.expectedRegions,1);assert.equal(error.layoutDiagnostics.observedRegions,0);
});
