import {createHash}from'node:crypto';
import {createRequire}from'node:module';
import path from'node:path';
import {readBounded}from'./translation-review-store.mjs';
import {measureLayoutText}from'./layout-text-measurement.mjs';
const require=createRequire(import.meta.url),{finishSourcePreflight}=require('../../packages/ai-engine/quality/source-layout-preflight.cjs'),{footprintFits}=require('../../packages/ai-engine/quality/background-layout.cjs'),cache=new WeakMap();
const sha=v=>createHash('sha256').update(v).digest('hex');
export async function getAllSourcePreflight(context,layout,{measureText=measureLayoutText,signal}={}){
 if(typeof context.planSourceLayouts!=='function')return null;
 const bundle=await readBounded(path.resolve('packages/ai-engine/.build/layout-measurement.js'));
 const key=sha(JSON.stringify({source:context.sourceReviewFingerprint,layout,bundle:sha(bundle)}));
 if(cache.get(context)?.key===key)return cache.get(context).promise;
 const promise=(async()=>{
  const plan=context.planSourceLayouts(layout.state==='APPROVED_SOURCE_LAYOUT_CLEANED_PENDING'?layout.entries:[],{reviewedWarnings:layout.approval?.typesettingStandard}),measurement=await measureText(plan.measurementEntries,context,{signal});
  signal?.throwIfAborted();
  const result=finishSourcePreflight(plan,measurement);
  // Suggestions stay unsaved. Existing approved entries never enter this path.
  if(typeof context.inspectEntry==='function'){
   const candidates=[],proofs=new Map();
   for(const row of result.regions.filter(r=>r.requiresManualReview&&!r.manualApproved)){
    const region=context.regions.find(r=>r.id===row.id),proof=context.inspectEntry({id:row.id,bbox:region.bbox});
    if(!proof.sourceReviewable||!proof.previewInterior)continue;
    proofs.set(row.id,proof);
    for(const px of [32,29,28,26,24,22,20,18,17,16,15,14,13])candidates.push({id:'source-candidate-'+candidates.length,bbox:{...region.bbox},text:region.text,fontSizePx:px,lineHeight:1.5,regionId:row.id});
   }
   if(candidates.length){
    const m=await measureText(candidates.map(({regionId,...e})=>e),context,{signal});
    for(const row of result.regions){
     const options=candidates.filter(c=>c.regionId===row.id).map(c=>({c,m:m.entries.find(e=>e.id===c.id)})).filter(({c,m})=>{
      if(!m||!m.completeText||!m.fitsBox||!m.linesSeparated||m.fontSizePx<=12||!footprintFits(proofs.get(row.id).previewInterior,m.inkBounds))return false;
      let cursor=0;for(let i=0;i<m.layout.lines.length;i++){while(/\s/u.test(c.text[cursor]??'\0'))cursor++;cursor+=m.layout.lines[i].text.length;if(i+1<m.layout.lines.length&&c.text[cursor]&&!/\s/u.test(c.text[cursor]))return false;}return true;
     });
     if(options.length){const {c,m}=options[0];row.reviewCandidate={status:'UNSAVED_SOURCE_CANDIDATE_CLEANED_PENDING',entry:{id:row.id,bbox:c.bbox,fontSizePx:c.fontSizePx,lineHeight:c.lineHeight,text:c.text},measurement:m,sourceFootprintVerified:true,saved:false,approved:false,actualCleanedVerified:false};}
    }
   }
  }
  return{...result,layoutRevision:layout.layoutRevision,planSha256:layout.planSha256,sourceReviewFingerprint:context.sourceReviewFingerprint,
   fontSha256:context.source.fontSha256,measurementBundleSha256:sha(bundle)};
 })();
 cache.set(context,{key,promise});
 try{return await promise;}catch(e){if(cache.get(context)?.promise===promise)cache.delete(context);throw e;}
}
