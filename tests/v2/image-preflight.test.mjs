import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';import sharp from 'sharp';
const require=createRequire(import.meta.url);let core={};try{core=require('../../packages/ai-engine/quality/imported-image-contract.cjs');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
test('resource policy refuses unknown or insufficient RAM, VRAM, space, conflicting processes and unsafe recovery',()=>{
 assert.equal(typeof core.assertExecutionEnvironment,'function','missing resource policy');
 const good={ramFreeMiB:512,vramFreeMiB:128,diskFreeBytes:512*1048576,outputWritable:true,otherEngineProcesses:[],repositoryLocked:false,recoveryAvailable:true};core.assertExecutionEnvironment(good);
 for(const change of [{ramFreeMiB:511},{vramFreeMiB:127},{vramFreeMiB:null},{diskFreeBytes:0},{outputWritable:false},{otherEngineProcesses:[{pid:123}]},{repositoryLocked:true},{recoveryAvailable:false}])assert.throws(()=>core.assertExecutionEnvironment({...good,...change}));
});
const sha=b=>createHash('sha256').update(b).digest('hex');
async function maskFixture(t,kind){
 const sourceDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'image-mask-')),width=32,height=32,original=await sharp({create:{width,height,channels:4,background:'#ffffff'}}).png().toBuffer(),mask=Buffer.alloc(width*height*4,255),gray=Buffer.alloc(width*height*4,255);
 for(let i=0;i<width*height;i++){gray[i*4]=gray[i*4+1]=gray[i*4+2]=0;}
 const at=(16*width+16)*4;mask[at+3]=kind==='alpha'?128:0;gray[at]=gray[at+1]=gray[at+2]=255;
 const bytes=await sharp(mask,{raw:{width,height,channels:4}}).png().toBuffer(),grayBytes=await sharp(gray,{raw:{width,height,channels:4}}).png().toBuffer(),bbox={x:0,y:0,width:1,height:1};
 const lines=Array.from({length:13},(_,i)=>({id:'r'+i,sourceText:'原文',bbox})),extraction={pageNumber:1,speechBubbles:lines.map(l=>({...l,text:l.sourceText})),nonSpeechText:[],warnings:[]},selection={decisions:lines.map(l=>({id:l.id,action:'translate',detectorRegionId:'roi'}))};
 const regions=[{id:'roi',kind:'text_bubble',confidence:1,bbox:kind==='roi'?{x:2,y:0,width:1,height:1}:bbox}];
 if(kind==='empty-region'){regions.push({id:'empty',kind:'text_bubble',confidence:1,bbox:{x:0,y:0,width:.1,height:.1}});selection.decisions[0].detectorRegionId='empty';}
 const payload={extraction,preSelectionExtraction:{...extraction,nonSpeechText:kind==='protected'?[{id:'protected',bbox}]:[]},regionSelection:selection,regionDetection:{width,height,regions}},cp={jobId:'source-job',payload},cpBytes=Buffer.from(JSON.stringify(cp));
 const identity={version:1,jobId:'source-job',pageNumber:1,sourceImageSha256:sha(original),ocrSha256:sha(JSON.stringify(extraction)),coordinateSpace:'normalized-page-pixels',width,height};
 const reply={version:1,ok:true,algorithm:'dual-context-consensus-v1',haloRadius:2,width:kind==='frame'?33:width,height,imageSha256:sha(original),model:{sha256:'b10356a2a12f4dec4650e563724932e542764dbd3201a7e4cae6573597c5bea1'},executionProvider:'CPUExecutionProvider',maskKind:'LEARNED_PIXEL_MASK',qualityStatus:'REQUIRES_REVIEW',maskRgbaSha256:sha(bytes),maskSha256:sha(grayBytes),regions:regions.map(r=>({id:r.id,maskPixels:1,sourceDialogueIds:selection.decisions.filter(d=>d.detectorRegionId===r.id).map(d=>d.id)}))};
 const evidence={identity,maskSha256:sha(bytes),maskedPixels:1};if(kind==='identity')evidence.identity={...identity,jobId:'other-source'};
 for(const [name,b]of Object.entries({'source.png':original,'normalized.png':original,'removal-mask.png':bytes,'removal-mask-learned-gray.png':grayBytes,'checkpoint-ocr.json':cpBytes,'learned-mask-evidence.json':JSON.stringify(reply),'source-mask-evidence.json':JSON.stringify(evidence)}))await fs.writeFile(path.join(sourceDirectory,name),b);
 const inputs={status:'IMPORTED_PAGE_INPUTS_READY',lines,current:{sourceSha256:sha(original),normalizedSha256:sha(original)},source:{checkpointSha256:sha(cpBytes),payloadSha256:sha(JSON.stringify(payload)),processingGeneration:2}};
 if(kind==='image')await fs.appendFile(path.join(sourceDirectory,'source.png'),'tamper');if(kind==='mapping')inputs.lines[0]={...inputs.lines[0],sourceText:'other OCR'};
 return {sourceDirectory,inputs,expectedAlgorithm:'dual-context-consensus-v1'};
}
test('existing mask is decoded and pixel-verified without inference or image rewrite',async t=>{assert.equal(typeof core.verifyImportedMask,'function');const args=await maskFixture(t),before=await fs.readFile(path.join(args.sourceDirectory,'removal-mask.png')),out=await core.verifyImportedMask(args);assert.equal(out.protection.maskedPixels,1);assert.equal(out.sourceGeneration,2);assert.equal(out.maskModelCalls,0);assert.deepEqual(await fs.readFile(path.join(args.sourceDirectory,'removal-mask.png')),before);});
for(const kind of ['frame','alpha','empty-region','roi','protected','identity','image','mapping'])test('pixel mask check rejects '+kind+' uncertainty before execution',async t=>{await assert.rejects(core.verifyImportedMask(await maskFixture(t,kind)));});
test('font audit refuses unavailable font bytes instead of substituting an OS font',()=>{
 assert.equal(typeof core.inspectFontGlyphs,'function','missing glyph policy');assert.throws(()=>core.inspectFontGlyphs(Buffer.from('not a font'),'한글'));
});
test('Stage12 layout validation requires complete selected text, glyphs, line separation and measured safe bounds',()=>{
 assert.equal(typeof core.verifyImportedLayout,'function','missing Stage12 output guard');
 const line={id:'r1',userTranslation:'사용자 선택'},layout={id:'r1',productionFontLoaded:true,glyphFontLoaded:true,fitStatus:'FIT_VERIFIED',fontSizePx:14,
  glyphEvidence:{missingGlyphOccurrences:0},textEvidence:{complete:true},measuredFit:{completeText:true,fitsBox:true,linesSeparated:true,inkBounds:[{left:10,right:100,top:10,bottom:30}]},raster:{paintedPixels:10,outsideInteriorPixels:0,clippedPixels:0,canvasEdgePixels:0,otherRegionCollisionPixels:0,overlappingInkPixels:0},actualLayout:{lines:[{text:'사용자 선택'}]},safeAreaEvidence:{basis:'CLOSED_WHITE_COMPONENT_INSET_RECTANGLE'}};
 core.verifyImportedLayout([layout],[line]);
 for(const change of [{fitStatus:'FIT_WARNING'},{glyphEvidence:{missingGlyphOccurrences:1}},{textEvidence:{complete:false}},{measuredFit:{completeText:true,fitsBox:false,linesSeparated:true}},{actualLayout:{lines:[{text:'원AI'}]}},{raster:{...layout.raster,clippedPixels:1}},{safeAreaEvidence:{basis:'UNVERIFIED_ROI_OR_MANUAL_GEOMETRY'}}])assert.throws(()=>core.verifyImportedLayout([{...layout,...change}],[line]));
});
