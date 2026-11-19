'use strict';
// A fixed detector response and a known clean frame exercise the installed painter without inference.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {app,protocol,nativeImage}=require('electron');
const {extractionFromOnnx}=require('../../../packages/ai-engine/quality/product-onnx.cjs');
const {createRenderer,rendererCall,validateRendered}=require('../../../packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs');
const sha=value=>createHash('sha256').update(value).digest('hex');
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const root=fs.mkdtempSync(path.join(config.runRoot,'tests','web-canvas-'));
for(const key of ['userData','sessionData','temp','documents','home']){
  const folder=path.join(root,key);fs.mkdirSync(folder);app.setPath(key,folder);
}
protocol.registerSchemesAsPrivileged([{scheme:'trio-resource',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.on('window-all-closed',()=>{});

async function verify(){
  const width=320,height=240,jobId='synthetic-canvas',pageNumber=1;
  const tight=process.argv[3]==='--tight';
  const box=tight?{left:132,top:90,right:156,bottom:126}:{left:100,top:64,right:214,bottom:176};
  const source=Buffer.alloc(width*height*4),cleaned=Buffer.alloc(source.length);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const background=x>=40&&x<280&&y>=20&&y<220?255:0;
    const inBox=x>=box.left&&x<box.right&&y>=box.top&&y<box.bottom;
    const stroke=inBox&&(x<box.left+3||x>=box.right-3||y<box.top+3||y>=box.bottom-3||(y>=106&&y<109));
    const at=(y*width+x)*4,color=stroke?0:background;
    source.set([color,color,color,255],at);cleaned.set([background,background,background,255],at);
  }
  const png=pixels=>nativeImage.createFromBitmap(pixels,{width,height}).toPNG();
  const sourcePng=png(source),cleanedPng=png(cleaned),sourceSha256=sha(sourcePng);
  const bbox={x:box.left/width,y:box.top/height,width:(box.right-box.left)/width,height:(box.bottom-box.top)/height};
  const region={id:'detected-17',kind:'text_bubble',bbox,confidence:.98};
  const {extraction}=extractionFromOnnx({page:jobId,sourceSha256,width,height,detections:[region],lines:[{...region,source:'日'}],uncoveredBubbles:[]},
    {jobId,pageNumber,sourceSha256,width,height});
  const {initializeProductionTypesetFontResource}=await import(pathToFileURL(path.join(config.buildRoot,'src/main/productionTypesetFontResource.js')).href);
  const font=await initializeProductionTypesetFontResource(config.resourcesPath,{warn(){}});
  assert.equal(font.enabled,true);
  const signal=AbortSignal.timeout(30000),window=await createRenderer(font,fs.readFileSync(config.rendererBundle,'utf8'),signal);
  try{
    const maskIdentity={version:1,jobId,pageNumber,sourceImageSha256:sourceSha256,ocrSha256:sha(JSON.stringify(extraction)),
      coordinateSpace:'normalized-page-pixels',width,height};
    const prepared=await rendererCall(window,'prepare',{jobId,ocr:extraction,width,height,sourceLanguage:'ja',sourcePngBase64:sourcePng.toString('base64'),maskIdentity},signal);
    assert.ok(prepared.mask.maskedPixels>0);assert.deepEqual(prepared.lines.map(line=>line.id),[region.id]);
    const lines=prepared.lines.map(line=>({...line,aiTranslation:'해'}));
    const identity={...maskIdentity,contract:'stage12-input-v1',sourceSha256,cleanedImageSha256:sha(cleanedPng),
      maskSha256:sha(Buffer.from(prepared.mask.maskPngBase64,'base64')),translationInputFingerprint:sha('fixed synthetic response'),
      mode:'unreviewed_candidate',maskReview:'candidate_validated_not_human_approved'};
    const render=()=>rendererCall(window,'render',{jobId,lines,cleanedPngBase64:cleanedPng.toString('base64'),typesettingIdentity:identity,returnStructuredFailure:true},signal);
    if(tight){
      const response=await render();assert.equal(response.jobId,jobId);assert.equal(response.failure.code,'MANUAL_LAYOUT_REQUIRED');
      assert.equal(response.failure.layoutDiagnostics.rejectedRegion,region.id);
      const file=path.join(root,'receipt.json');
      const receipt={scope:'SYNTHETIC_REAL_CANVAS_TIGHT_REGION',regionId:region.id,expectedRefusal:'MANUAL_LAYOUT_REQUIRED',candidatePublished:false,actualModelCalls:0};
      fs.writeFileSync(file,JSON.stringify(receipt,null,2),{flag:'wx'});console.log(JSON.stringify({file,...receipt}));return;
    }
    const rendered=await render();
    validateRendered(rendered,jobId,lines,{width,height},identity);
    const layout=rendered.layoutReport[0],candidate=Buffer.from(rendered.pngBase64,'base64');
    assert.equal(layout.id,region.id);assert.equal(layout.textEvidence.sourceText,'해');assert.equal(layout.textEvidence.complete,true);
    assert.equal(layout.glyphEvidence.missingGlyphOccurrences,0);assert.ok(layout.raster.paintedPixels>0);
    assert.equal(layout.raster.clippedPixels,0);assert.notEqual(sha(candidate),sha(cleanedPng));
    const receipt={scope:'SYNTHETIC_REAL_ELECTRON_MASK_AND_CANVAS',actualModelCalls:0,originalPages:0,regionId:region.id,
      original:sourceSha256,cleaned:sha(cleanedPng),candidate:sha(candidate),maskedPixels:prepared.mask.maskedPixels,
      paintedPixels:layout.raster.paintedPixels,clippedPixels:layout.raster.clippedPixels,missingGlyphs:layout.glyphEvidence.missingGlyphOccurrences};
    const file=path.join(root,'receipt.json');fs.writeFileSync(file,JSON.stringify(receipt,null,2),{flag:'wx'});
    console.log(JSON.stringify({file,...receipt}));
  }finally{window.destroy();}
}
app.whenReady().then(verify).then(()=>app.exit(0),error=>{console.error(error.stack);app.exit(1);});
