'use strict';
// Run the production worker bootstrap with a font-only pipeline double.
// No valid image Permit, page bytes, OCR, prepare/render, Python or image encoder is supplied.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),{pathToFileURL}=require('node:url'),Module=require('node:module');
const directory=path.resolve(process.argv[2]),input=JSON.parse(fs.readFileSync(path.join(directory,'input.json'))),originalLoad=Module._load;
const calls={ocr:0,gemma:0,lama:0,prepare:0,typeset:0,image:0};
Module._load=function(specifier,parent,...rest){
 if(specifier==='../../packages/ai-engine/quality/imported-image-pipeline.cjs'&&parent?.filename.endsWith('imported-page-image-worker.cjs'))return {
  createNativeImagePorts:async()=>({}),
  executeImportedImagePipeline:async args=>{
   if(input.layoutDiagnosticProbe){
    await args.revalidate('after-typeset');
    await fsp.writeFile(path.join(directory,'font-only-probe.json'),JSON.stringify({observed:{loaded:null,checked:null},requests:[],calls,signedFont:null,pipelineDouble:true,originalPageSupplied:false}),{flag:'wx'});
    const {verifyImportedLayout}=require('../../../packages/ai-engine/quality/imported-image-contract.cjs');
    verifyImportedLayout([{id:'synthetic-region',productionFontLoaded:true,glyphFontLoaded:true,glyphEvidence:{missingGlyphOccurrences:0},textEvidence:{complete:true},fitStatus:'FIT_WARNING',fontSizePx:12,measuredFit:{completeText:true,fitsBox:true,linesSeparated:true},safeAreaEvidence:{basis:'UNVERIFIED_ROI_OR_MANUAL_GEOMETRY'}}],[{id:'synthetic-region',userTranslation:'SYNTHETIC_PRIVATE_TEXT'}]);throw Error('MUST_REJECT_UNSAFE_LAYOUT');
   }
   await args.revalidate('font-only-probe');
   const {initializeProductionTypesetFontResource}=await import(pathToFileURL(path.join(input.config.buildRoot,'src/main/productionTypesetFontResource.js')).href);
   const font=await initializeProductionTypesetFontResource(input.config.resourcesPath,{warn:()=>{}});if(!font.enabled)throw Error('SIGNED_FONT_UNAVAILABLE');
   const {createRenderer}=require('../../../packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs');
   const requests=[],resource={...font,handleProtocolRequest:r=>{requests.push(r.url);return input.fontProbeFault?new Response(null,{status:403}):font.handleProtocolRequest(r);}};
   const window=await createRenderer(resource,await fsp.readFile(input.config.rendererBundle,'utf8'),new AbortController().signal);
   let observed;
   try{
    observed=await window.webContents.executeJavaScript(`(async()=>{HTMLCanvasElement.prototype.toDataURL=()=>{throw Error('IMAGE_ENCODING_FORBIDDEN')};try{const face=new FontFace('TrioFontOnlyProbe','url(trio-resource://font/pretendard-variable.ttf)');await face.load();document.fonts.add(face);return {loaded:face.status==='loaded',checked:document.fonts.check('16px TrioFontOnlyProbe','한')};}catch(e){return {loaded:false,checked:false,name:e.name,message:e.message,stack:e.stack??null};}})()`,true);
   }finally{if(!window.isDestroyed())window.destroy();}
   await fsp.writeFile(path.join(directory,'font-only-probe.json'),JSON.stringify({observed,requests,calls,signedFont:true,pipelineDouble:true,originalPageSupplied:false},null,2),{flag:'wx'});
   throw Object.assign(Error(observed.loaded?'Font-only probe complete; stopped before any image pipeline.':'Font-only probe load failed: '+observed.message),{code:observed.loaded?'FONT_ONLY_PROBE_COMPLETE':'FONT_ONLY_PROBE_BLOCKED'});
  }
 };
 return originalLoad.call(this,specifier,parent,...rest);
};
require('../../../scripts/v2/imported-page-image-worker.cjs');
