import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
import {readBounded} from './translation-review-store.mjs';import {loadStage14ImageProfile} from './imported-page-preflight.mjs';
const require=createRequire(import.meta.url),sharp=require('sharp'),{createBackgroundScene,bounds,POLICY}=require('../../packages/ai-engine/quality/background-layout.cjs'),{verifyImportedMask,inspectFontGlyphs}=require('../../packages/ai-engine/quality/imported-image-contract.cjs');
const sha=b=>createHash('sha256').update(typeof b==='string'||Buffer.isBuffer(b)?b:JSON.stringify(b)).digest('hex'),must=(v,code)=>{if(!v)throw Object.assign(Error(code),{code,status:409});};
const envelope=(a,b)=>{if(!b)return {...a};const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y);return {x,y,width:Math.min(1,Math.max(a.x+a.width,b.x+b.width))-x,height:Math.min(1,Math.max(a.y+a.height,b.y+b.height))-y};};
export function createLayoutSourceLoader({profileLoader=loadStage14ImageProfile}={}){
 let cached;
 return async binding=>{
  const {source,config}=await profileLoader(),dir=source.directory,cpBytes=await readBounded(path.join(dir,'checkpoint-ocr.json'));
  must(sha(cpBytes)===binding.sourceProvenance.originalCheckpointSha256&&source.expectedCheckpointSha256===sha(cpBytes)&&source.expectedGeneration===binding.sourceProcessingGeneration,'LAYOUT_SOURCE_STALE');
  const cp=JSON.parse(cpBytes),payload=cp.payload,e=payload.extraction;
  const lines=e.speechBubbles.map(g=>{const r=binding.regions.find(v=>v.regionId===g.id);must(r&&JSON.stringify(r.bbox)===JSON.stringify(g.bbox)&&(g.text===r.rawOcr||g.text===r.sourceText),'LAYOUT_OCR_SOURCE_MISMATCH');return {id:g.id,sourceText:g.text,bbox:g.bbox};});
  must(lines.length===binding.regions.length&&new Set(lines.map(l=>l.id)).size===lines.length,'LAYOUT_OCR_SOURCE_MISMATCH');
  const inputs={status:'IMPORTED_PAGE_INPUTS_READY',current:binding.current,source:{checkpointSha256:sha(cpBytes),payloadSha256:sha(payload),processingGeneration:binding.sourceProcessingGeneration},lines};
  const verified=await verifyImportedMask({sourceDirectory:dir,inputs,expectedAlgorithm:config.textMaskAlgorithm,read:readBounded});
  const normalized=await readBounded(path.join(dir,'normalized.png')),mask=await readBounded(path.join(dir,'removal-mask.png'));
  const {initializeProductionTypesetFontResource}=await import(pathToFileURL(path.join(config.buildRoot,'src/main/productionTypesetFontResource.js')).href),font=await initializeProductionTypesetFontResource(config.resourcesPath,{warn:()=>{}});must(font.enabled,'LAYOUT_FONT_UNAVAILABLE');
  const fontResponse=await font.handleProtocolRequest({url:'trio-resource://font/pretendard-variable.ttf'});must(fontResponse.ok,'LAYOUT_FONT_UNAVAILABLE');const fontBytes=Buffer.from(await fontResponse.arrayBuffer());const fontGlyphEvidence=inspectFontGlyphs(fontBytes,binding.regions.map(r=>r.selectedUserTranslation).join('\n'));
  const identity={sourceSha256:binding.current.sourceSha256,normalizedSha256:sha(normalized),checkpointSha256:sha(cpBytes),maskSha256:sha(mask),fontSha256:sha(fontBytes),width:verified.width,height:verified.height};
  const cacheKey=sha({identity,documentSha256:binding.documentSha256,owner:binding.current.ownerScope,selectedSetSha256:binding.receipt.selectedSetSha256,policy:POLICY});if(cached?.cacheKey===cacheKey)return cached.context;
  must(identity.normalizedSha256===binding.current.normalizedSha256&&identity.maskSha256===verified.maskSha256,'LAYOUT_SOURCE_STALE');
  const pixels=await sharp(normalized).ensureAlpha().raw().toBuffer(),maskPixels=await sharp(mask).ensureAlpha().raw().toBuffer(),{width,height}=verified;
  const scene=createBackgroundScene({sourcePixels:pixels,maskPixels,width,height,sourceSha256:identity.normalizedSha256,maskSha256:identity.maskSha256});
  const regions=e.speechBubbles.map(g=>{const r=binding.regions.find(r=>r.regionId===g.id),decision=payload.regionSelection.decisions.find(d=>d.id===g.id&&d.action==='translate'),roi=payload.regionDetection.regions.find(r=>r.id===decision?.detectorRegionId);must(roi,'LAYOUT_ROI_SOURCE_MISMATCH');
   return {id:g.id,order:g.readingOrder,text:r.selectedUserTranslation,sourceText:g.text,originalAiTranslation:r.originalAiTranslation,selectionOrigin:r.selectionOrigin,bbox:{...g.bbox},allowedBbox:envelope(g.bbox,roi.bbox),sourceLineIds:[...r.sourceLineIds],riskSignals:structuredClone(r.riskSignals),detectorRegionId:roi.id};});
  const otherBoxes=[...regions.map(r=>({id:r.id,bbox:r.bbox})),...e.nonSpeechText.map((r,i)=>({id:'protected-'+i,bbox:r.bbox}))];
  const inspectEntry=entry=>scene.inspectManual({id:entry.id,bbox:entry.bbox,allowedBbox:regions.find(r=>r.id===entry.id).allowedBbox,otherBoxes});
  const automaticSourceChecks=regions.map(r=>{const uniform=scene.inspectUniform({id:r.id,bbox:r.bbox,allowedBbox:r.bbox,otherBoxes}),white=scene.whiteUpperBound({bbox:r.bbox});return {id:r.id,uniformBackground:uniform.evidence,uniformSourceReviewable:uniform.sourceReviewable,whiteUpperBound:white,requiresManualReview:!uniform.sourceReviewable&&!white.possible,cleanedVerified:false};});
  const context={width,height,config,source:identity,regions,scene,otherBoxes,inspectEntry,fontGlyphsVerified:true,fontGlyphEvidence,sourceReviewFingerprint:sha({policy:POLICY,identity,regions:regions.map(r=>({id:r.id,bbox:r.bbox,allowedBbox:r.allowedBbox,text:r.text,sourceLineIds:r.sourceLineIds}))}),
   automaticSourceChecks,preview:{originalImage:'data:image/png;base64,'+normalized.toString('base64'),removalMaskImage:'data:image/png;base64,'+mask.toString('base64'),fontData:'data:font/ttf;base64,'+fontBytes.toString('base64'),fontIdentity:'Pretendard Std Variable@1.3.9',removalPixels:verified.protection.maskedPixels,cleanedImageAvailable:false},
   protectionRuns(entry){const r=inspectEntry(entry),i=r.previewInterior;if(!i)return {runs:[],truncated:false};const runs=[];let count=0;for(let y=0;y<i.height;y++){let start=-1;for(let x=0;x<=i.width;x++){const blocked=x<i.width&&!i.mask[y*i.width+x];if(blocked&&start<0)start=x;if(!blocked&&start>=0){count++;if(runs.length<3000)runs.push([i.left+start,i.top+y,x-start]);start=-1;}}}return {runs,truncated:count>runs.length,totalRuns:count};}};
  context.planSourceLayouts=(entries,{reviewedWarnings}={})=>{
   const {planSourceLayouts}=require('../../packages/ai-engine/quality/source-layout-preflight.cjs'),{inferCandidateBox}=require('../../packages/ai-engine/.build/layout-source-geometry.cjs');
   return planSourceLayouts({sourcePixels:pixels,maskPixels,width,height,sourceSha256:identity.normalizedSha256,maskSha256:identity.maskSha256,regions,manualEntries:entries,
    protectedBoxes:e.nonSpeechText.map(r=>r.bbox),inferCandidateBox,fontGlyphsVerified:true,reviewedWarnings});
  };
  cached={cacheKey,context};return context;
 };
}
