// Deterministic replay of saved observations through real product functions.
// No OCR, translation, LaMa, network, or human transcription is performed.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const output=option('--output');if(!output)throw new Error('--output is required; use a fresh evidence directory');
const codeRoot=path.resolve(option('--code-root')??repo),fixtureRoot=path.resolve(option('--fixture-root')??path.join(repo,'tests/v2/fixtures/stage09'));
const require=createRequire(import.meta.url),api=require(path.join(codeRoot,'packages/ai-engine/quality/ocr-refinement.cjs'));
const {selectDialogueRegions}=require(path.join(codeRoot,'packages/ai-engine/quality/region-selection.cjs'));
const sha=b=>createHash('sha256').update(b).digest('hex'),pins=[];
async function read(file,json=true){const bytes=await fs.readFile(path.join(fixtureRoot,file));pins.push({path:file,sha256:sha(bytes),bytes:bytes.length});return json?JSON.parse(bytes):bytes;}
await fs.mkdir(output,{recursive:false});
const write=(name,value)=>fs.writeFile(path.join(output,name),JSON.stringify(value,null,2),{flag:'wx'});
const extraction=await read('raw-ocr.json'),plan=await read('ocr-refinement/plan.json'),bound=await read('ocr-refinement/bound-crops.json'),detection=await read('region-detection.json');
const cropResults=[],crops=[];
for(let i=0;i<bound.crops.length;i++){
 const ticket=bound.crops[i],stem=`ocr-refinement/crop-00${i+1}`;
 const pngBytes=await read(stem+'.png',false);if(sha(pngBytes)!==ticket.cropSha256)throw new Error('CROP_HASH_MISMATCH');
 crops.push({cropId:ticket.cropId,pngBytes});cropResults.push({...ticket,sourceSha256:plan.sourceSha256,sourceImageSha256:plan.sourceImageSha256,result:await read(stem+'.raw-ocr.json')});
}
const rebound=api.bindOcrRefinementCrops({plan,sourceImageSha256:plan.sourceImageSha256,crops});
if(JSON.stringify(rebound.crops)!==JSON.stringify(bound.crops))throw new Error('BOUND_CROPS_MISMATCH');
const original=JSON.stringify(extraction),parentId=plan.groups[0].parentId;
let refinement;
try{
 const applied=api.applyOcrRefinement({extraction,plan:bound,cropResults});await write('applied.json',applied);
 const replacements=new Map(applied.replacements.map(g=>[g.parentId,g.children]));
 const speechBubbles=[...extraction.speechBubbles].sort((a,b)=>a.readingOrder-b.readingOrder).flatMap(g=>structuredClone(replacements.get(g.id)??[g]));speechBubbles.forEach((g,i)=>g.readingOrder=i+1);
 const projected={...structuredClone(extraction),speechBubbles};await write('projected-ocr.json',projected);
 const selected=selectDialogueRegions(projected,detection);await write('region-selection.json',{detection,selection:selected.selection});
 refinement={status:'candidate_returned',parentId,children:applied.replacements.flatMap(g=>g.children).map(c=>({id:c.id,roiId:c.ocrRefinement.roiId,sourceDetectionIds:c.ocrRefinement.sourceDetectionIds,sourceQuadCoverage:c.ocrRefinement.sourceQuadCoverage,lineCorrespondence:c.ocrRefinement.lineCorrespondence,validation:c.ocrRefinement.validation,text:c.text})),selection:selected.selection};
}catch(e){refinement={status:'rejected',code:e.code??e.name,stack:e.stack};}
const connected=await read('connected-raw-ocr.json'),pastSelection=await read('connected-region-selection.json');
const selection=selectDialogueRegions(connected,pastSelection.detection);await write('connected-selection.json',selection);
if(JSON.stringify(extraction)!==original)throw new Error('RAW_MUTATED');
const summary={scope:'SAVED_REAL_INPUT_PRODUCT_FUNCTION_REPLAY_NO_INFERENCE',createdAt:new Date().toISOString(),codeRoot,fixtureRoot,cropCount:cropResults.length,rawUnchanged:true,actualModelCalls:0,humanGroundTruth:'HUMAN_GT_PENDING',realSinglePageE2e:'NOT_RUN',refinement,connected:selection.selection.decisions.find(x=>x.id===parentId),pins};
await write('summary.json',summary);console.log(JSON.stringify({output,refinement:refinement.status,code:refinement.code??null,children:refinement.children?.length??0,connected:summary.connected?.action,selected:refinement.selection?.translatedRegions??null}));
