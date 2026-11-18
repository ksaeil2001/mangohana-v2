'use strict';
// Source-only candidate geometry and measurement evaluation. No IO or rendering.
const {normalizeManualEntries,footprintFits,layoutTextMatches}=require('./background-layout.cjs');
const {requiresSingleUtteranceLine}=require('./korean-utterance.cjs');
const {evaluateKoreanTypesetting}=require('./korean-typesetting-standard.cjs');
const {assessDisplayReadability}=require('./layout-readability.cjs');
const FONTS=[13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,34,36,38,40,42,44,46,48,50,52,54,56,58,60,62,64];
const must=(v,code)=>{if(!v)throw Object.assign(Error(code),{code});};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sizeRank=(a,b)=>b.entry.fontSizePx-a.entry.fontSizePx||Math.abs(a.entry.lineHeight-1.5)-Math.abs(b.entry.lineHeight-1.5)||a.geometryDrift-b.geometryDrift;
const rank=(a,b)=>Math.round(b.standard?.readability?.score??-100000)-Math.round(a.standard?.readability?.score??-100000)||(a.standard?.softWarnings?.length??0)-(b.standard?.softWarnings?.length??0)||sizeRank(a,b);
function wordSplits(source,lines){let cursor=0,count=0;for(let i=0;i<lines.length;i++){while(/\s/u.test(source[cursor]??'\0'))cursor++;cursor+=lines[i].text.length;if(i+1<lines.length&&source[cursor]&&!/\s/u.test(source[cursor]))count++;}return count;}
function planLayoutComparison(context,region,{manualEntries=[],logicalWhiteInterior,requireWhiteComponent=false,sceneReferences=[]}={}){
 const {width:W,height:H}=context,a=region.allowedBbox,s=region.bbox;
 must(a&&s&&typeof context.inspectEntry==='function','COMPARISON_SOURCE_UNAVAILABLE');
 const left=Math.ceil(a.x*W),top=Math.ceil(a.y*H),right=Math.floor((a.x+a.width)*W),bottom=Math.floor((a.y+a.height)*H),cx=(s.x+s.width/2)*W,cy=(s.y+s.height/2)*H;
 const clamp=(v,min,max)=>Math.max(min,Math.min(max,v)),centered=(w,h)=>({x:clamp(Math.round(cx-w/2),left,right-w)/W,y:clamp(Math.round(cy-h/2),top,bottom-h)/H,width:w/W,height:h/H});
 const full={x:left/W,y:top/H,width:(right-left)/W,height:(bottom-top)/H};
 const boxes=[{...s},full,centered(right-left,Math.min(Math.round(s.height*H),bottom-top)),centered(Math.floor((right-left)*.85),Math.min(Math.round(s.height*H),bottom-top))].filter((b,i,list)=>list.findIndex(v=>same(v,b))===i);
 const geometries=[],entries=[],rejections={};
 for(const bbox of boxes){
  const probe={id:region.id,bbox,fontSizePx:13,lineHeight:1.5,text:region.text};
  try{normalizeManualEntries([probe,...manualEntries.filter(e=>e.id!==region.id)],context.regions,W,H);}catch(e){rejections[e.code??'LAYOUT_GEOMETRY_UNSAFE']=(rejections[e.code??'LAYOUT_GEOMETRY_UNSAFE']??0)+1;continue;}
  const proof=context.inspectEntry(probe);if(!proof.sourceReviewable||!proof.previewInterior){rejections.SOURCE_BACKGROUND_UNREVIEWABLE=(rejections.SOURCE_BACKGROUND_UNREVIEWABLE??0)+1;continue;}
  const geometryIndex=geometries.length;geometries.push({bbox,proof});
  for(const fontSizePx of FONTS)entries.push({id:'comparison-'+entries.length,bbox:{...bbox},fontSizePx,lineHeight:1.5,text:region.text,geometryIndex});
 }
 must(entries.length<=160,'COMPARISON_LIMIT');
 return{version:1,region,width:W,height:H,geometries,entries,rejections,logicalWhiteInterior,requireWhiteComponent,sceneReferences,fontGlyphsVerified:context.fontGlyphsVerified===true};
}
function assessCandidate(plan,c,referenceFontSizePx){return evaluateKoreanTypesetting({text:plan.region.text,lines:c.measurement.layout.lines.map(l=>l.text),stage:'SOURCE_METRICS',fontSizePx:c.entry.fontSizePx,lineHeight:c.entry.lineHeight,shape:'rectangle',referenceFontSizePx,sceneReferences:plan.sceneReferences,
 measurement:c.measurement,safety:{safeAreaVerified:c.sourceFootprintVerified&&(!plan.requireWhiteComponent||c.logicalWhiteComponentFootprint===true),otherRegionCollision:false,protectedArtworkCollision:false},
 glyphs:{...(plan.fontGlyphsVerified?{supported:true,missingGlyphOccurrences:0}:{})},mapping:{expectedId:plan.region.id,actualId:c.entry.id,expectedOrder:plan.region.order??0,actualOrder:plan.region.order??0}});}
function scoreComparisonCandidates(plan,accepted){const reference=Math.max(13,...accepted.map(c=>c.entry.fontSizePx));for(const c of accepted){c.standard=assessCandidate(plan,c,reference);
 const rectangles=c.measurement?.inkBounds??[],left=Math.min(...rectangles.map(r=>r.left)),top=Math.min(...rectangles.map(r=>r.top)),right=Math.max(...rectangles.map(r=>r.right)),bottom=Math.max(...rectangles.map(r=>r.bottom));
 c.displayReadability=assessDisplayReadability({fontSizePx:c.entry.fontSizePx,lineHeight:c.entry.lineHeight,bbox:c.entry.bbox,lines:c.measurement.layout.lines.map(l=>l.text),inkBounds:rectangles.length?{x:left,y:top,width:right-left,height:bottom-top}:null},{width:plan.width,height:plan.height,peerFontSizes:(plan.sceneReferences??[]).map(r=>r.fontSizePx),availableArea:plan.readabilityContext?.availableArea});
 }accepted.sort(rank);return accepted;}
function evaluateLayoutComparison(plan,result){
 const measured=result?.entries;
 must(Array.isArray(measured)&&measured.length===plan.entries.length&&new Set(measured.map(m=>m.id)).size===measured.length&&measured.every(m=>plan.entries.some(e=>e.id===m.id)),'COMPARISON_MEASUREMENT_MISMATCH');
 const accepted=[],rejections={...plan.rejections};
 for(const e of plan.entries){
  const m=measured.find(m=>m.id===e.id),proof=plan.geometries[e.geometryIndex].proof,lines=m.layout?.lines,reasons=[];
  if(!Array.isArray(lines)||!lines.length||!lines.every(l=>typeof l.text==='string')||!layoutTextMatches(e.text,lines.map(l=>l.text).join('\n'))||m.completeText!==true)reasons.push('TEXT_NOT_PRESERVED');
  if(m.fontSizePx!==e.fontSizePx||m.fontSizePx<=12||m.fitsBox!==true||m.linesSeparated!==true)reasons.push('FONT_OR_FIT_UNSAFE');
  const splits=Array.isArray(lines)&&lines.every(l=>typeof l.text==='string')?wordSplits(e.text,lines):null;
  if(splits!==0||requiresSingleUtteranceLine(e.text)&&lines?.length!==1)reasons.push('WORD_SPLIT');
  if(!footprintFits(proof.previewInterior,m.inkBounds))reasons.push('SOURCE_FOOTPRINT_UNVERIFIED');
  const whiteFootprint=plan.logicalWhiteInterior?footprintFits(plan.logicalWhiteInterior,m.inkBounds):null;
  if(plan.requireWhiteComponent&&whiteFootprint!==true)reasons.push('LOGICAL_WHITE_COMPONENT_FOOTPRINT_UNVERIFIED');
  if(reasons.length){for(const reason of reasons)rejections[reason]=(rejections[reason]??0)+1;continue;}
  const s=plan.region.bbox,b=e.bbox,drift=Math.abs((s.x+s.width/2)-(b.x+b.width/2))*plan.width+Math.abs((s.y+s.height/2)-(b.y+b.height/2))*plan.height+Math.abs(s.height-b.height)*plan.height;
  const candidate={entry:{id:plan.region.id,bbox:{...b},fontSizePx:e.fontSizePx,lineHeight:e.lineHeight,text:e.text},measurement:m,geometryIndex:e.geometryIndex,geometryDrift:drift,
   sourceEvidence:proof.evidence,paint:proof.paint,sourceFootprintVerified:true,logicalWhiteComponentFootprint: whiteFootprint,intraWordBreaks:0,otherRoiConflict:false,status:'UNSAVED_SOURCE_CANDIDATE_CLEANED_PENDING',saved:false,approved:false,actualCleanedVerified:false,actualRasterVerified:false};
  const standard=assessCandidate(plan,candidate);if(standard.status==='BLOCKED'){for(const v of standard.hardViolations)rejections[v.rule+':'+v.code]=(rejections[v.rule+':'+v.code]??0)+1;continue;}candidate.standard=standard;accepted.push(candidate);
 }
 scoreComparisonCandidates(plan,accepted);
 return{accepted,rejections,tested:plan.entries.length};
}
function refinementPlan(plan,evaluated){
 const entries=[];for(let i=0;i<plan.geometries.length;i++){
  const options=evaluated.accepted.filter(c=>c.geometryIndex===i),best=options[0],largest=[...options].sort(sizeRank)[0];if(!best)continue;
  const sizes=[...new Set([best,largest].flatMap(c=>[c.entry.fontSizePx,Math.max(13,c.entry.fontSizePx-2)]))];
  for(const px of sizes)for(const lineHeight of[1.25,1.3,1.4,1.75])entries.push({id:'refined-'+entries.length,bbox:plan.geometries[i].bbox,fontSizePx:px,lineHeight,text:plan.region.text,geometryIndex:i});
 }
 return{...plan,entries,rejections:{}};
}
function selectComparisonCandidates(plan,evaluated,current){
 const accepted=[...evaluated.accepted].sort(rank),recommended=accepted[0]??null,previous=[...accepted].sort(sizeRank)[0];
 const exactCurrent=accepted.find(c=>current&&same(c.entry,current.entry))??current??null;
 const candidates=[];if(exactCurrent)candidates.push({...exactCurrent,kind:'current',label:'기존 제안'});
 if(previous)candidates.push({...previous,kind:'previous',label:'크기 우선 비교안'});
 if(recommended)candidates.push({...recommended,kind:'recommended',label:'추천 · 가독성 균형'});
 if(recommended){
  const baseSize=exactCurrent?.entry.fontSizePx??13;
  const oneLine=accepted.find(c=>c.measurement.layout.lines.length===1&&c.entry.fontSizePx>=baseSize&&!same(c.entry,recommended.entry));
  const compact=accepted.find(c=>c.entry.bbox.width<recommended.entry.bbox.width-1e-12&&c.entry.fontSizePx>baseSize);
  const relaxed=accepted.find(c=>c.entry.fontSizePx<=recommended.entry.fontSizePx-2&&c.entry.lineHeight===1.75);
  const alternative=oneLine??compact??relaxed;
  if(alternative)candidates.push({...alternative,kind:'alternative',label:oneLine?'대안 · 문장 한 줄':compact?'대안 · 폭을 덜 넓힘':'대안 · 여유 있는 줄 간격'});
  const seen=new Set(candidates.map(c=>same(c.entry,recommended.entry)?JSON.stringify(recommended.entry):JSON.stringify(c.entry)));
  for(const count of[3,4]){const c=accepted.find(c=>c.measurement.layout.lines.length===count&&!seen.has(JSON.stringify(c.entry)));if(c){candidates.push({...c,kind:'lines_'+count,label:'대안 · '+count+'줄'});seen.add(JSON.stringify(c.entry));}}
 }
 return candidates;
}
module.exports={planLayoutComparison,evaluateLayoutComparison,refinementPlan,selectComparisonCandidates,scoreComparisonCandidates,wordSplits};
