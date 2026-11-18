// Real disk and image decoding with a synthetic inference boundary; no AI runs.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {createJobStore} from '../../apps/engine/store.mjs';

export const testRoot=path.resolve('E:/Dev/Outputs/MangohanaV2-20261111/tests/batch-queue-'+process.pid+'-'+Date.now());
await mkdir(testRoot,{recursive:true});
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const alice=hash('batch-synthetic-alice'),bob=hash('batch-synthetic-bob');
export const png=await sharp({create:{width:4,height:4,channels:4,background:'#e8e8e8'}}).png().toBuffer();
export function deferred(){let resolve;const promise=new Promise(accept=>{resolve=accept;});return {promise,resolve};}
export async function until(read,predicate=value=>['completed','failed','partial'].includes(value.status)){
 const deadline=Date.now()+30000;
 while(Date.now()<deadline){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.fail('Synthetic batch did not reach the expected state');
}
export async function fixture(t,options={}){
 const directory=await mkdtemp(path.join(testRoot,'store-'));
 const runs=[],started=deferred();let active=0,maximum=0,store;
 const engine={
  health:()=>({ready:true}),
  async inspectImage(bytes){const {info}=await sharp(bytes,{limitInputPixels:12_000_000}).ensureAlpha().raw().toBuffer({resolveWithObject:true});return {width:info.width,height:info.height};},
  async run(input){
   runs.push(input);active++;maximum=Math.max(maximum,active);started.resolve(input);
   try{
    await options.onRun?.(input,runs.length);
    if(options.gate&&runs.length===1)await Promise.race([options.gate.promise,new Promise((_,reject)=>{if(input.signal.aborted)reject(new Error('fixture interrupted'));else input.signal.addEventListener('abort',()=>reject(new Error('fixture interrupted')),{once:true});})]);
    if(options.fail?.(input,runs.length))throw new Error('SYNTHETIC_PROCESS_FAILURE');
    const original=await readFile(input.inputPath),normalized=await sharp(original).ensureAlpha().png().toBuffer();
    const size=await engine.inspectImage(normalized);
    for(const name of ['normalized.png','cleaned.png','removal-mask.png'])await writeFile(path.join(input.outputDirectory,name),normalized,{flag:'wx'});
    const report={version:1,jobId:input.jobId,evidenceKind:'LOCAL_ENGINE_CANDIDATE',originalPreserved:true,userApproved:false,sourceLanguage:input.sourceLanguage,
     image:{...size,originalMime:original[0]===255?'image/jpeg':original.toString('ascii',0,4)==='RIFF'?'image/webp':'image/png'},
     hashes:{original:hash(original),normalized:hash(normalized),cleaned:hash(normalized),candidate:hash(normalized),mask:hash(normalized)},
     warnings:['SYNTHETIC_FIXTURE_NOT_AI'],ocr:{speechBubbles:[{id:'region'}]},
     lines:[{id:'region',order:1,sourceText:'合成',aiTranslation:'합성'}],
     translations:[{id:'region',engine:'local_ai',usedExactTm:false,modelHttpRequests:1,durationMs:18,qaReport:{issues:[]}}],
     typesetting:{layoutReport:[{id:'region',bbox:{x:0,y:0,width:1,height:1},fontSizePx:14,fontFamily:'Synthetic',productionFontLoaded:true,glyphFontLoaded:true}]},measurements:{elapsedMs:25}};
    if(input.translationContext&&options.echoContext)report.translationContext={snapshotSha256:input.translationContext.snapshotSha256,consumed:false,glossaryRevision:input.translationContext.glossaryRevision};
    await writeFile(path.join(input.outputDirectory,'engine-report.json'),JSON.stringify(report),{flag:'wx'});
    return {pngBytes:normalized,report};
   }finally{active--;}
  },async close(){},
 };
 store=await createJobStore({root:directory,engine,contextStore:options.contextStore});
 t.after(async()=>{await store.close();assert.equal(path.dirname(directory),testRoot);await rm(directory,{recursive:true,force:true});});
 const submitBatch=overrides=>store.submitBatch({owner:alice,idempotencyKey:'batch-one',projectId:'project-one',sourceLanguage:'ja',
  pages:[1,2,3].map(number=>({key:'file:'+number,name:number+'.png',bytes:png,pageId:'page-'+number,pageNumber:number})),...overrides});
 return {root:directory,get store(){return store;},set store(value){store=value;},engine,runs,started,submitBatch,maximum:()=>maximum};
}
