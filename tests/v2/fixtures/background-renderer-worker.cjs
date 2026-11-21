'use strict';
// Synthetic fixture only. No real page, execution Permit, OCR/Gemma/LaMa port.
const fs=require('node:fs/promises'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {app,protocol,nativeImage}=require('electron');protocol.registerSchemesAsPrivileged([{scheme:'trio-resource',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
const directory=path.resolve(process.argv[2]);app.setPath('userData',path.join(directory,'profile'));app.setPath('sessionData',path.join(directory,'session'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{let window;try{
 const input=JSON.parse(await fs.readFile(path.join(directory,'input.json')));if(input.kind!=='SYNTHETIC_BACKGROUND_RENDERER_TEST'||input.permit||input.actualPage)throw Error('SYNTHETIC_ONLY');
 const {initializeProductionTypesetFontResource}=await import(pathToFileURL(path.join(input.config.buildRoot,'src/main/productionTypesetFontResource.js')).href),font=await initializeProductionTypesetFontResource(input.config.resourcesPath,{warn:()=>{}});if(!font.enabled)throw Error('SIGNED_FONT');
 const {createRenderer}=require('../../../packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs'),{verifyRenderedBackgrounds}=require('../../../packages/ai-engine/quality/imported-layout-background.cjs'),{verifyImportedLayout}=require('../../../packages/ai-engine/quality/imported-image-contract.cjs');
 window=await createRenderer(font,await fs.readFile(input.productionBundle,'utf8')+'\n'+await fs.readFile(input.bundle,'utf8')+'\nvoid 0;',new AbortController().signal);
 const rgba=base64=>{const b=Buffer.from(nativeImage.createFromBuffer(Buffer.from(base64,'base64')).toBitmap());for(let i=0;i<b.length;i+=4){const r=b[i];b[i]=b[i+2];b[i+2]=r;}return b;},results=[];
 for(const item of input.cases){
  try{
   const expression=`SyntheticBackground.renderCandidate(${JSON.stringify('data:image/png;base64,'+item.cleaned)},${JSON.stringify(item.lines)},${JSON.stringify(item.options)})`;
   const {rendered,failure}=await window.webContents.executeJavaScript(`${expression}.then(rendered=>({rendered}),error=>({failure:{message:error.message,code:error.code,layoutDiagnostics:error.layoutDiagnostics}}))`,true);
   if(failure)throw Object.assign(new Error(failure.message),failure);
   if (item.options.backgroundContext.nonWhiteFallback) {
    const source = rgba(item.cleaned), final = rgba(rendered.pngBase64);
    const regions = rendered.layoutReport.map(row => ({ id: row.id, bbox: row.bbox, text: row.textEvidence.sourceText,
      complete: row.textEvidence.complete, fontSizePx: row.fontSizePx, lineCount: row.actualLayout.lines.length,
      lines: row.actualLayout.lines.map(line => line.text),
      basis: row.safeAreaEvidence.basis,
      missingGlyphs: row.glyphEvidence.missingGlyphOccurrences,
      safe: row.raster.paintedPixels > 0 && [row.raster.outsideInteriorPixels, row.raster.clippedPixels,
        row.raster.overlappingInkPixels, row.raster.otherRegionCollisionPixels].every(value => value === 0) }));
    let changedOutsideBoxes = 0;
    for (let at = 0; at < source.length; at += 4) {
      if (source.readUInt32LE(at) === final.readUInt32LE(at)) continue;
      const x = (at / 4 % input.width + 0.5) / input.width;
      const y = (Math.floor(at / (4 * input.width)) + 0.5) / input.height;
      if (!regions.some(({ bbox }) => x >= bbox.x && x < bbox.x + bbox.width && y >= bbox.y && y < bbox.y + bbox.height)) changedOutsideBoxes++;
    }
    results.push({ name: item.name, ok: true, changedOutsideBoxes, regions });
    continue;
   }
   const m=item.options.backgroundContext,maskEvidence={width:input.width,height:input.height,maskSha256:m.maskSha256,layoutRegions:item.lines.map(l=>({id:l.id,bbox:l.typesetting.bbox,allowedBbox:m.allowedBoxes.find(r=>r.id===l.id).bbox})),extraction:{nonSpeechText:item.options.protectedBoxes??[]}},inputs={current:{normalizedSha256:m.sourceSha256},lines:item.lines.map(l=>({id:l.id,bbox:l.typesetting.bbox,userTranslation:l.aiTranslation})),...(m.manualEntries.length?{layoutReview:{planSha256:m.manualApprovalSha256}}:{})};
   const validation=verifyRenderedBackgrounds({layouts:rendered.layoutReport,inputs,maskEvidence,manualEntries:m.manualEntries,sourcePixels:rgba(m.sourcePngBase64),cleanedPixels:rgba(item.cleaned),maskPixels:rgba(m.maskPngBase64),finalPixels:rgba(rendered.pngBase64),cleanedSha256:m.cleanedSha256});
   verifyImportedLayout(rendered.layoutReport,inputs.lines,validation);results.push({name:item.name,ok:true,basis:rendered.layoutReport[0].safeAreaEvidence.basis,color:rendered.layoutReport[0].paint.color,independentPixels:validation.independentPixels,manualFont:rendered.layoutReport[0].fontSizePx,bbox:rendered.layoutReport[0].bbox});
  }catch(e){results.push({name:item.name,ok:false,message:e.message,code:e.code??(e.message.startsWith('MANUAL_LAYOUT_REQUIRED:')?'MANUAL_LAYOUT_REQUIRED':null),
    ...(item.name.startsWith('shared-auto-')?{measurements:(e.layoutDiagnostics?.regions??[]).map(({id,bbox,fontSizePx})=>({id,bbox,fontSizePx}))}:{})});}
 }
 const item=input.cases.find(c=>c.name==='texture'),bbox=item.lines[0].typesetting.bbox,polygon=[{x:bbox.x,y:bbox.y},{x:bbox.x+bbox.width,y:bbox.y},{x:bbox.x+bbox.width,y:bbox.y+bbox.height},{x:bbox.x,y:bbox.y+bbox.height}],jobId='synthetic-structured-failure';
 const ocr={pageNumber:1,warnings:[],nonSpeechText:[],speechBubbles:[{id:item.lines[0].id,readingOrder:1,bbox,polygon,text:item.lines[0].sourceText,language:'ja',confidence:1,type:'speech_bubble'}]},sha=b=>require('node:crypto').createHash('sha256').update(b).digest('hex');
 const maskIdentity={version:1,jobId,pageNumber:1,sourceImageSha256:item.options.backgroundContext.sourceSha256,ocrSha256:sha(JSON.stringify(ocr)),coordinateSpace:'normalized-page-pixels',width:input.width,height:input.height};
 const prepared={lines:item.lines};
 await window.webContents.executeJavaScript(`SyntheticBackground.Sites.seedSyntheticPrepared(${JSON.stringify({jobId,identity:maskIdentity,lines:prepared.lines})})`,true);
 const typesettingIdentity={...maskIdentity,contract:'stage12-input-v1',sourceSha256:maskIdentity.sourceImageSha256,cleanedImageSha256:item.options.backgroundContext.cleanedSha256,maskSha256:item.options.backgroundContext.maskSha256,translationInputFingerprint:'e'.repeat(64),mode:'unreviewed_candidate',maskReview:'candidate_validated_not_human_approved'};
 const structuredFailure=await window.webContents.executeJavaScript(`SitesCandidate.render(${JSON.stringify({jobId,lines:prepared.lines,cleanedPngBase64:item.cleaned,typesettingIdentity,backgroundContext:item.options.backgroundContext,returnStructuredFailure:true})})`,true);
 const second={id:'synthetic-second',order:2,pageNumber:1,sourceText:'other',aiTranslation:'합성',ocrEditStatus:'ai_proposed',typesetting:{bbox:{x:.02,y:.02,width:.2,height:.2},writingMode:'horizontal-tb'}};
 const multiOptions=structuredClone(item.options);multiOptions.backgroundContext.allowedBoxes.push({id:second.id,bbox:second.typesetting.bbox});
 const aggregateFailure=await window.webContents.executeJavaScript(`SyntheticBackground.renderCandidate(${JSON.stringify('data:image/png;base64,'+item.cleaned)},${JSON.stringify([...item.lines,second])},${JSON.stringify(multiOptions)}).then(()=>null).catch(e=>e.layoutDiagnostics??null)`,true);
 await fs.writeFile(path.join(directory,'result.json'),JSON.stringify({kind:input.kind,results,structuredFailure,aggregateFailure,preparedStateSeededForSyntheticTest:true,maskPreparationInvoked:false,actualModels:0,actualPage:false,officialPermitOperations:0,pngFilesWritten:0}),{flag:'wx'});window.destroy();app.exit(0);
 }catch(e){if(window&&!window.isDestroyed())window.destroy();await fs.writeFile(path.join(directory,'failure.json'),JSON.stringify({message:e.message,stack:e.stack}),{flag:'wx'});app.exit(1);}});
