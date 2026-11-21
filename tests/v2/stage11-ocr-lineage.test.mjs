import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {tsImport} from 'tsx/esm/api';
const require=createRequire(import.meta.url),{applyOcrRefinement}=require('../../packages/ai-engine/quality/ocr-refinement.cjs'),{selectDialogueRegions}=require('../../packages/ai-engine/quality/region-selection.cjs'),{buildTranslationInput}=require('../../packages/ai-engine/quality/translation-contract.cjs');
const {extractionFromOnnx}=require('../../packages/ai-engine/quality/product-onnx.cjs');
const {draftLines}=await tsImport('../../packages/ai-engine/vendor/trio/scripts/local-preview/renderer.ts',import.meta.url);
const dir=new URL('./fixtures/stage09/',import.meta.url),read=p=>JSON.parse(fs.readFileSync(new URL(p,dir),'utf8'));
test('real renderer draft adapter retains the absolute page number rather than silently defaulting to page one',()=>{
 const ocr=read('raw-ocr.json');ocr.pageNumber=2;const lines=draftLines(ocr);assert.ok(lines.length);assert.ok(lines.every(l=>l.pageNumber===2));
});
test('the real renderer draft keeps the ONNX source line through the same translation contract',()=>{
 const identity={jobId:'lineage-page',pageNumber:2,sourceSha256:'a'.repeat(64),width:160,height:240};
 const row={id:'onnx-one',kind:'text_bubble',source:'日',confidence:.98,bbox:{x:.25,y:.25,width:.3,height:.4}};
 const ocr=extractionFromOnnx({page:identity.jobId,...identity,lines:[row],detections:[row],uncoveredBubbles:[]},identity);
 const {extraction,selection}=selectDialogueRegions(ocr.extraction,ocr.detection);
 const lines=draftLines(extraction);
 assert.deepEqual(lines.map(line=>line.sourceLineIds),[[row.id]]);
 const input=buildTranslationInput({lines,extraction,selection});
 assert.deepEqual(input.regions.map(region=>region.sourceLineIds),[[row.id]]);
});
test('source reading order may have preserve gaps while remaining exact and increasing',()=>{
 const ocr=read('raw-ocr.json');ocr.speechBubbles=ocr.speechBubbles.slice(0,2);ocr.speechBubbles[0].readingOrder=2;ocr.speechBubbles[1].readingOrder=5;
 const lines=draftLines(ocr);for(const l of lines)l.sourceLineIds=ocr.speechBubbles.find(g=>g.id===l.id).productionOcrProvenance.sourceDetectionIds;
 assert.deepEqual(buildTranslationInput({lines,extraction:ocr}).regions.map(r=>r.order),[2,5]);
});
test('Stage09 actual saved crop mapping reaches translation with three ROIs and five original line IDs unchanged',()=>{
 const extraction=read('raw-ocr.json'),bound=read('ocr-refinement/bound-crops.json'),detection=read('region-detection.json');
 const cropResults=bound.crops.map((c,i)=>({...c,sourceSha256:bound.plan.sourceSha256,sourceImageSha256:bound.plan.sourceImageSha256,result:read(`ocr-refinement/crop-00${i+1}.raw-ocr.json`)}));
 const before=structuredClone(extraction),out=applyOcrRefinement({extraction,plan:bound,cropResults}),replacements=new Map(out.replacements.map(r=>[r.parentId,r.children]));
 const speechBubbles=[...extraction.speechBubbles].sort((a,b)=>a.readingOrder-b.readingOrder).flatMap(g=>structuredClone(replacements.get(g.id)??[g]));speechBubbles.forEach((g,i)=>g.readingOrder=i+1);
 const selected=selectDialogueRegions({...structuredClone(extraction),speechBubbles},detection),lines=draftLines(selected.extraction);
 for(const l of lines){const g=selected.extraction.speechBubbles.find(g=>g.id===l.id);l.sourceLineIds=g.ocrRefinement?.sourceDetectionIds??g.productionOcrProvenance?.sourceDetectionIds??[];}
 const input=buildTranslationInput({lines,extraction:selected.extraction,selection:selected.selection}),children=input.regions.filter(r=>out.replacements.some(v=>v.children.some(g=>g.id===r.id)));
 assert.equal(children.length,3);assert.equal(new Set(children.map(r=>r.roiId)).size,3);assert.equal(children.flatMap(r=>r.sourceLineIds).length,5);assert.deepEqual(extraction,before);
});
