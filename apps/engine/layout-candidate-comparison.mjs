import {createHash}from'node:crypto';import {createRequire}from'node:module';import path from'node:path';
import {readBounded}from'./translation-review-store.mjs';import {measureLayoutText}from'./layout-text-measurement.mjs';import {getAllSourcePreflight}from'./layout-source-preflight.mjs';
const require=createRequire(import.meta.url),{planLayoutComparison,evaluateLayoutComparison,refinementPlan,selectComparisonCandidates,scoreComparisonCandidates}=require('../../packages/ai-engine/quality/layout-candidate-comparison.cjs'),{normalizeManualEntries,footprintFits}=require('../../packages/ai-engine/quality/background-layout.cjs'),{evaluateKoreanTypesetting}=require('../../packages/ai-engine/quality/korean-typesetting-standard.cjs'),cache=new WeakMap();
const sha=v=>createHash('sha256').update(v).digest('hex'),fail=code=>Object.assign(Error(code),{code,status:409});
export async function compareLayoutCandidates({context,layout,regionId,sourcePreflight,signal,referenceEntry},{measureText=measureLayoutText}={}){
 const region=context.regions.find(r=>r.id===regionId);if(!region)throw fail('LAYOUT_REGION_MISMATCH');
 const bundle=await readBounded(path.resolve('packages/ai-engine/.build/layout-measurement.js')),key=sha(JSON.stringify({source:context.sourceReviewFingerprint,layout,regionId,bundle:sha(bundle),referenceEntry}));
 let records=cache.get(context);if(!records){records=new Map();cache.set(context,records);}if(records.has(key))return records.get(key);
 const promise=(async()=>{
  signal?.throwIfAborted();const source=sourcePreflight??await getAllSourcePreflight(context,layout,{measureText,signal}),automatic=source?.regions.find(r=>r.id===regionId);
  if(!automatic)throw fail('COMPARISON_SOURCE_UNAVAILABLE');
  const sourcePlan=context.planSourceLayouts?.(layout.state==='APPROVED_SOURCE_LAYOUT_CLEANED_PENDING'?layout.entries:[]),logicalWhiteInterior=sourcePlan?.plans.find(p=>p.region.id===regionId)?.interior;
  const componentMembers=logicalWhiteInterior?context.regions.filter(r=>{const x=Math.floor((r.bbox.x+r.bbox.width/2)*context.width)-logicalWhiteInterior.left,y=Math.floor((r.bbox.y+r.bbox.height/2)*context.height)-logicalWhiteInterior.top;return x>=0&&y>=0&&x<logicalWhiteInterior.width&&y<logicalWhiteInterior.height&&logicalWhiteInterior.mask[y*logicalWhiteInterior.width+x]===1;}).map(r=>r.id):[];
  const sceneReferences=source.regions.filter(r=>r.id!==regionId&&componentMembers.includes(r.id)&&Math.min(r.allowedBbox?.width??r.sourceBbox.width,region.allowedBbox.width)/Math.max(r.allowedBbox?.width??r.sourceBbox.width,region.allowedBbox.width)>.7).map(r=>({id:r.id,fontSizePx:r.reviewCandidate?.entry.fontSizePx??r.fontSizePx,basis:'SHARED_LOGICAL_COMPONENT_SIMILAR_ALLOWED_WIDTH'}));
  const plan=planLayoutComparison(context,region,{manualEntries:layout.entries,logicalWhiteInterior,requireWhiteComponent:automatic.background==='CLOSED_WHITE_LOGICAL_UPPER_BOUND',sceneReferences}),wire=entries=>entries.map(({geometryIndex,...e})=>e);
  const measured=plan.entries.length?await measureText(wire(plan.entries),context,{signal}):{entries:[]},evaluated=evaluateLayoutComparison(plan,measured),refined=refinementPlan(plan,evaluated);
  const refinedMeasured=refined.entries.length?await measureText(wire(refined.entries),context,{signal}):null;
  const second=refinedMeasured?evaluateLayoutComparison(refined,refinedMeasured):{accepted:[],rejections:{},tested:0};
  signal?.throwIfAborted();const merged={accepted:[...evaluated.accepted,...second.accepted],rejections:{...evaluated.rejections},tested:evaluated.tested+second.tested};
  for(const[k,v]of Object.entries(second.rejections))merged.rejections[k]=(merged.rejections[k]??0)+v;
  scoreComparisonCandidates(plan,merged.accepted);
  const candidates=selectComparisonCandidates(plan,merged,automatic.reviewCandidate),full=region.bbox,autoLines=automatic.measurement?.layout?.lines;
  let referenceMeasured=null;
  if(referenceEntry){
   if(referenceEntry.id!==regionId)throw fail('LAYOUT_REGION_MISMATCH');
   const normalized=normalizeManualEntries([referenceEntry,...layout.entries.filter(e=>e.id!==regionId)],context.regions,context.width,context.height)[0];
   referenceMeasured=await measureText([normalized],context,{signal});const m=referenceMeasured.entries.find(m=>m.id===regionId),proof=context.inspectEntry(normalized),footprint=!!m&&proof.sourceReviewable&&footprintFits(proof.previewInterior,m.inkBounds),white=logicalWhiteInterior?footprintFits(logicalWhiteInterior,m?.inkBounds):null;
   const standard=evaluateKoreanTypesetting({text:region.text,lines:m?.layout?.lines?.map(l=>l.text),stage:'SOURCE_METRICS',fontSizePx:m?.fontSizePx,lineHeight:normalized.lineHeight,shape:'rectangle',measurement:m,
    safety:{safeAreaVerified:footprint&&(!plan.requireWhiteComponent||white===true),otherRegionCollision:false,protectedArtworkCollision:false},glyphs:context.fontGlyphsVerified?{supported:true,missingGlyphOccurrences:0}:{},mapping:{expectedId:regionId,actualId:m?.id,expectedOrder:region.order??0,actualOrder:region.order??0}});
   candidates.unshift({kind:'reference',label:'비교 기준 · 미승인 후보',entry:normalized,measurement:m,standard,sourceFootprintVerified:footprint,logicalWhiteComponentFootprint:white,saved:false,approved:false,actualCleanedVerified:false});
  }
  const autoLineHeight=autoLines?.length>1?(autoLines[1].relativeY-autoLines[0].relativeY)*automatic.candidateBbox.height*context.height/automatic.fontSizePx:null;
  return{version:1,kind:'SOURCE_ONLY_LAYOUT_CANDIDATE_COMPARISON',regionId,order:region.order,text:region.text,sourceBbox:full,allowedBbox:region.allowedBbox,
   layoutRevision:layout.layoutRevision,sourceReviewFingerprint:context.sourceReviewFingerprint,fontSha256:context.source.fontSha256,measurementBundleSha256:sha(bundle),
   automatic:{entry:{id:regionId,bbox:automatic.candidateBbox,fontSizePx:automatic.fontSizePx,lineHeight:Number.isFinite(autoLineHeight)?autoLineHeight:1.5,text:region.text},lineHeightMeasured:Number.isFinite(autoLineHeight),measurement:automatic.measurement,standard:automatic.standard,reasonCodes:automatic.reasonCodes,sourceOnly:true,approved:false},
   logicalWhiteComponent:{memberIds:componentMembers,actualCleanedVerified:false},
   nativeMeasurements:[measured,refinedMeasured,referenceMeasured].filter(Boolean).map(m=>({entries:m.entries.length,fontLoaded:m.fontLoaded??null,paintCalls:m.paintCalls??null,encodeCalls:m.encodeCalls??null,forbiddenCalls:m.forbiddenCalls??null,cleanupConfirmed:m.cleanupConfirmed??null})),
   candidates,tested:merged.tested,accepted:merged.accepted.length,rejections:merged.rejections,
   status:candidates.some(c=>c.kind==='recommended')?'SOURCE_CANDIDATES_READY':'MANUAL_LAYOUT_REQUIRED',saved:false,approved:false,actualCleanedVerified:false,actualImageExecution:false};
 })();
 records.set(key,promise);while(records.size>32)records.delete(records.keys().next().value);
 try{return await promise;}catch(e){if(records.get(key)===promise)records.delete(key);throw e;}
}
