'use strict';
// A fixed detector response and a known clean frame exercise the installed painter without inference.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {app,protocol,nativeImage}=require('electron');
const {extractionFromOnnx}=require('../../../packages/ai-engine/quality/product-onnx.cjs');
const {selectDialogueRegions}=require('../../../packages/ai-engine/quality/region-selection.cjs');
const {buildTranslationInput}=require('../../../packages/ai-engine/quality/translation-contract.cjs');
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
  const gray=['--flat-gray','--flat-gray-before','--textured-gray','--gray-center-inset'].includes(process.argv[3]);
  const grayBefore=process.argv[3]==='--flat-gray-before';
  const texturedGray=process.argv[3]==='--textured-gray';
  const centeredGray=process.argv[3]==='--gray-center-inset';
  const centeredBefore=centeredGray&&process.argv[4]==='--expect-hold';
  const openWhite=process.argv[3]==='--open-white';
  const width=320,height=gray?480:240,jobId='synthetic-canvas',pageNumber=1;
  const confirmedSpelling={ '--confirmed-name-inline':'アリス의 설명', '--confirmed-name-only':'アリス' }[process.argv[3]];
  const translation=confirmedSpelling??(gray?'아싸~!':'해');
  const tight=process.argv[3]==='--tight';
  const shallow=['--shallow','--shallow-before'].includes(process.argv[3]);
  const protectedNote=['--protected-note','--protected-note-away','--protected-note-clear'].includes(process.argv[3]);
  const noteAway=process.argv[3]==='--protected-note-away';
  const noteClear=process.argv[3]==='--protected-note-clear';
  const expectRefusal=grayBefore||texturedGray||centeredBefore||openWhite||tight||process.argv[3]==='--shallow-before';
  const box=gray?{left:122,top:49,right:198,bottom:388}:protectedNote?{left:54,top:80,right:136,bottom:152}:
    shallow?{left:118,top:105,right:202,bottom:130}:
    tight?{left:132,top:90,right:156,bottom:126}:{left:100,top:64,right:214,bottom:176};
  const noteBox=noteAway?{left:189,top:160,right:224,bottom:192}:
    noteClear?{left:139,top:85,right:141,bottom:87}:{left:139,top:106,right:175,bottom:144};
  const within=(x,y,b)=>x>=b.left&&x<b.right&&y>=b.top&&y<b.bottom;
  const source=Buffer.alloc(width*height*4),cleaned=Buffer.alloc(source.length);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const bubble=openWhite||(gray?x>=40&&x<280&&y>=20&&y<460:protectedNote?x>=32&&x<248&&y>=20&&y<220:
      shallow?x>=90&&x<230&&y>=103&&y<132:x>=40&&x<280&&y>=20&&y<220);
    const noteInk=protectedNote&&within(x,y,noteBox)&&(x%7<2||y%9<2);
    const texture=(texturedGray&&within(x,y,box)&&x%7<2) || (centeredGray&&y>=282&&y<296);
    const background=bubble?(gray?(texture?120:180):noteInk?245:255):0;
    const inBox=within(x,y,box);
    const stroke=gray?(x>=158&&x<162&&y>=202&&y<226)||(x>=149&&x<171&&y>=211&&y<215):
      inBox&&(x<box.left+3||x>=box.right-3||y<box.top+3||y>=box.bottom-3||(y>=106&&y<109));
    const at=(y*width+x)*4,color=stroke?0:background;
    source.set([color,color,color,255],at);cleaned.set([background,background,background,255],at);
  }
  const png=pixels=>nativeImage.createFromBitmap(pixels,{width,height}).toPNG();
  const sourcePng=png(source),cleanedPng=png(cleaned),sourceSha256=sha(sourcePng);
  const bboxOf=b=>({x:b.left/width,y:b.top/height,width:(b.right-b.left)/width,height:(b.bottom-b.top)/height});
  const bbox=bboxOf(box);
  const region={id:'detected-17',kind:'text_bubble',bbox,confidence:.98};
  const note={id:'detected-25',kind:'text_free',bbox:bboxOf(noteBox),confidence:.98};
  const detections=protectedNote?[region,note]:[region];
  const recognized=extractionFromOnnx({page:jobId,sourceSha256,width,height,detections,lines:detections.map(row=>({...row,source:row===note?'案内':'日'})),uncoveredBubbles:[]},
    {jobId,pageNumber,sourceSha256,width,height});
  const {extraction,selection}=selectDialogueRegions(recognized.extraction,recognized.detection);
  if(protectedNote)assert.deepEqual(extraction.nonSpeechText.map(row=>row.id),[note.id]);
  const {initializeProductionTypesetFontResource}=await import(pathToFileURL(path.join(config.buildRoot,'src/main/productionTypesetFontResource.js')).href);
  const font=await initializeProductionTypesetFontResource(config.resourcesPath,{warn(){}});
  assert.equal(font.enabled,true);
  const signal=AbortSignal.timeout(30000),window=await createRenderer(font,fs.readFileSync(config.rendererBundle,'utf8'),signal);
  try{
    const maskIdentity={version:1,jobId,pageNumber,sourceImageSha256:sourceSha256,ocrSha256:sha(JSON.stringify(extraction)),
      coordinateSpace:'normalized-page-pixels',width,height};
    const prepared=await rendererCall(window,'prepare',{jobId,ocr:extraction,width,height,sourceLanguage:'ja',sourcePngBase64:sourcePng.toString('base64'),maskIdentity},signal);
    assert.ok(prepared.mask.maskedPixels>0);assert.deepEqual(prepared.lines.map(line=>line.id),[region.id]);
    const sourceLineIds=prepared.lines[0].sourceLineIds;
    assert.deepEqual(sourceLineIds,[region.id]);
    const translationInput=buildTranslationInput({lines:prepared.lines,extraction,selection,scope:{pageNumber,sourceSha256}});
    const lines=prepared.lines.map(line=>({...line,aiTranslation:translation}));
    const identity={...maskIdentity,contract:'stage12-input-v1',sourceSha256,cleanedImageSha256:sha(cleanedPng),
      maskSha256:sha(Buffer.from(prepared.mask.maskPngBase64,'base64')),translationInputFingerprint:translationInput.fingerprint,
      mode:'unreviewed_candidate',maskReview:'candidate_validated_not_human_approved'};
    const backgroundContext=grayBefore?undefined:{sourcePngBase64:sourcePng.toString('base64'),maskPngBase64:prepared.mask.maskPngBase64,
      sourceSha256,maskSha256:identity.maskSha256,cleanedSha256:identity.cleanedImageSha256,allowedBoxes:[],nonWhiteFallback:true};
    const render=()=>rendererCall(window,'render',{jobId,lines,cleanedPngBase64:cleanedPng.toString('base64'),typesettingIdentity:identity,backgroundContext,returnStructuredFailure:true},signal);
    if(expectRefusal){
      const response=await render();assert.equal(response.jobId,jobId);assert.equal(response.failure.code,'MANUAL_LAYOUT_REQUIRED');
      assert.equal(response.failure.layoutDiagnostics.rejectedRegion,region.id);
      if(texturedGray||centeredBefore)assert.ok(response.failure.layoutDiagnostics.reasonCodes.includes('BACKGROUND_NOT_UNIFORM'));
      const file=path.join(root,'receipt.json');
      const receipt={scope:grayBefore?'SYNTHETIC_FLAT_GRAY_WITHOUT_BACKGROUND_EVIDENCE':centeredBefore?'SYNTHETIC_GRAY_CENTER_BEFORE':texturedGray?'SYNTHETIC_TEXTURED_GRAY_REFUSED':
        openWhite?'SYNTHETIC_OPEN_WHITE_REFUSED':shallow?'SYNTHETIC_REAL_CANVAS_SHALLOW_BEFORE':'SYNTHETIC_REAL_CANVAS_TIGHT_REGION',
        original:sourceSha256,cleaned:sha(cleanedPng),mask:identity.maskSha256,regionId:region.id,sourceLineIds,
        expectedRefusal:'MANUAL_LAYOUT_REQUIRED',candidatePublished:false,actualModelCalls:0};
      fs.writeFileSync(file,JSON.stringify(receipt,null,2),{flag:'wx'});console.log(JSON.stringify({file,...receipt}));return;
    }
    const rendered=await render();
    if(protectedNote&&rendered.failure){
      const diagnostic=rendered.failure.layoutDiagnostics?.regions?.find(row=>row.id===region.id);
      console.log(JSON.stringify({original:sourceSha256,cleaned:sha(cleanedPng),failure:rendered.failure.code,
        stage:rendered.failure.layoutDiagnostics?.stage,otherRegionCollisionPixels:diagnostic?.raster?.otherRegionCollisionPixels,
        protectedRegion:note.id}));
    }
    validateRendered(rendered,jobId,lines,{width,height},identity);
    const layout=rendered.layoutReport[0],candidate=Buffer.from(rendered.pngBase64,'base64');
    assert.equal(layout.id,region.id);assert.equal(layout.textEvidence.sourceText,translation);assert.equal(layout.textEvidence.complete,true);
    assert.equal(layout.glyphEvidence.missingGlyphOccurrences,0);assert.ok(layout.raster.paintedPixels>0);
    assert.equal(layout.raster.clippedPixels,0);assert.notEqual(sha(candidate),sha(cleanedPng));
    if(shallow)assert.equal(layout.fontSizePx,13);
    if(gray){
      assert.equal(layout.safeAreaEvidence.basis,'UNIFORM_BACKGROUND_INSET_RECTANGLE');
      assert.ok(layout.safeAreaEvidence.background.minimumContrast>=4.5);
      assert.equal(layout.raster.outsideInteriorPixels,0);
      assert.equal(layout.raster.otherRegionCollisionPixels,0);
      const proof=layout.safeAreaEvidence.background.sampling.bboxPixels;
      if(centeredGray){
        assert.ok(proof.left>=box.left&&proof.top>=box.top&&proof.left+proof.width<=box.right&&proof.top+proof.height<282);
        const centerY=(box.top+box.bottom)/2;
        assert.ok(proof.top<=centerY&&proof.top+proof.height>centerY);
      }
      const resultPixels=nativeImage.createFromBuffer(candidate).toBitmap();
      const checked={left:proof.left,top:proof.top,right:proof.left+proof.width,bottom:proof.top+proof.height};
      for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(!within(x,y,checked)){
        const at=(y*width+x)*4;
        assert.equal(resultPixels.readUInt32LE(at),cleaned.readUInt32LE(at));
      }
    }
    if(protectedNote){
      assert.equal(layout.bboxInferred,noteAway||noteClear);
      assert.equal(layout.raster.otherRegionCollisionPixels,0);
      const resultPixels=nativeImage.createFromBuffer(candidate).toBitmap();
      for(let y=noteBox.top;y<noteBox.bottom;y++){
        const left=(y*width+noteBox.left)*4,right=(y*width+noteBox.right)*4;
        assert.deepEqual(resultPixels.subarray(left,right),cleaned.subarray(left,right));
      }
    }
    const receipt={scope:confirmedSpelling?'SYNTHETIC_CONFIRMED_NAME_CANVAS':centeredGray?'SYNTHETIC_GRAY_CENTER_AFTER':gray?'SYNTHETIC_FLAT_GRAY_WITH_BACKGROUND_EVIDENCE':protectedNote?'SYNTHETIC_PROTECTED_NOTE_CANVAS':shallow?'SYNTHETIC_REAL_CANVAS_SHALLOW_AFTER':'SYNTHETIC_REAL_ELECTRON_MASK_AND_CANVAS',
      fontSizePx:layout.fontSizePx,actualModelCalls:0,originalPages:0,regionId:region.id,sourceLineIds,
      original:sourceSha256,cleaned:sha(cleanedPng),mask:identity.maskSha256,candidate:sha(candidate),maskedPixels:prepared.mask.maskedPixels,
      paintedPixels:layout.raster.paintedPixels,clippedPixels:layout.raster.clippedPixels,missingGlyphs:layout.glyphEvidence.missingGlyphOccurrences,
      ...(gray?{minimumContrast:layout.safeAreaEvidence.background.minimumContrast,outsideInteriorPixels:layout.raster.outsideInteriorPixels,
        proof:layout.safeAreaEvidence.background.sampling.bboxPixels}:{}),
      ...(protectedNote?{noteAway,noteClear,protectedRegion:note.id,otherRegionCollisionPixels:layout.raster.otherRegionCollisionPixels}: {})};
    const file=path.join(root,'receipt.json');fs.writeFileSync(file,JSON.stringify(receipt,null,2),{flag:'wx'});
    console.log(JSON.stringify({file,...receipt}));
  }finally{window.destroy();}
}
app.whenReady().then(verify).then(()=>app.exit(0),error=>{console.error(error.stack);app.exit(1);});
