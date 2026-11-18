'use strict';
// MangoHana Korean Comic Typesetting Standard v1.0. Pure checks and bounded
// candidate search. No model, font loading, file access, painting or approval.
const VERSION='MANGOHANA_KO_TYPESETTING_1.0';
const HANGUL=/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;
const graphemes=s=>[...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(s)].length;
const clean=s=>s.replace(/\r\n?/g,'\n');
function isGeneralKorean({text,writingMode='horizontal-tb',shape='rectangle',dialogueType='speech',rotationDegrees=0,profile}={}){
 return typeof text==='string'&&HANGUL.test(text)&&writingMode==='horizontal-tb'&&['rectangle','ellipse','rounded_rectangle'].includes(shape)&&['speech','thought'].includes(dialogueType)&&rotationDegrees===0&&(!profile||profile==='KO_GENERAL_HORIZONTAL_V1');
}
function inspectKoreanText(source,lines){
 if(typeof source!=='string'||!Array.isArray(lines)||!lines.every(s=>typeof s==='string'))return{complete:false,intraWordBreaks:null,punctuationOnlyLines:[],leadingDetachedPunctuation:[],missingCharacters:null,extraCharacters:null};
 const paragraphs=clean(source).split('\n');let paragraph=0,offset=0,complete=true,intraWordBreaks=0;
 for(let i=0;i<lines.length;i++){
  const line=lines[i],expected=paragraphs[paragraph];
  if(expected===undefined||/[\r\n]/u.test(line)){complete=false;break;}
  if(offset)while(/[ \t]/u.test(expected[offset]??'\0'))offset++;
  if(!expected.startsWith(line,offset)){complete=false;break;}
  offset+=line.length;
  if(!expected.slice(offset).trim()){paragraph++;offset=0;}
  else if(i+1<lines.length&&!/\s/u.test(expected[offset]??'\0'))intraWordBreaks++;
 }
 complete&&=paragraph===paragraphs.length&&offset===0;
 const a=[...source.replace(/\s/gu,'')],b=[...lines.join('').replace(/\s/gu,'')];complete&&=a.join('')===b.join('');
 return{complete,intraWordBreaks,punctuationOnlyLines:lines.flatMap((s,i)=>s.trim()&&/^[\p{P}\p{S}]+$/u.test(s.trim())?[i]:[]),
  leadingDetachedPunctuation:lines.flatMap((s,i)=>i>0&&/^[!?~….,、。！？～〜:;\)\]】」』”’]/u.test(s.trimStart())?[i]:[]),
  missingCharacters:Math.max(0,a.length-b.length),extraCharacters:Math.max(0,b.length-a.length)};
}
function scoreKoreanReadability({text,lines,shape='rectangle',lineHeight=1.3,align='center',fontSizePx,referenceFontSizePx,sceneReferences=[]}={}){
 const values=(Array.isArray(lines)?lines:[]).filter(s=>typeof s==='string'&&s.trim()),counts=values.map(s=>graphemes(s.replace(/\s/gu,''))),total=counts.reduce((a,b)=>a+b,0),warnings=[];let penalty=0;
 const warn=(rule,code,message,weight,details)=>{warnings.push({rule,code,message,...(details?{details}:{})});penalty+=weight;};
 const modifiers=/^(?:좀|더|정말|아주|매우|함께|다시)$/u;
 const weak=values.slice(0,-1).filter(s=>{const words=s.trim().split(/\s+/u),last=words.at(-1);return words.every(w=>modifiers.test(w))||/의$/u.test(last);});
 if(weak.length)warn('S-01','BREATH_BOUNDARY_REVIEW','수식어 뒤의 호흡 연결을 직접 확인해 주세요.',weak.length*4);
 const long=counts.filter(n=>n>10),short=counts.filter(n=>n<5);
 if(long.length||short.length&&(total>=10||values.length>=3))warn('S-02','RECOMMENDED_LINE_LENGTH','5~10자는 권장 목표입니다. 실제 폭과 크기를 함께 비교해 주세요.',long.reduce((a,n)=>a+(n-10)*.5,0)+(short.reduce((a,n)=>a+5-n,0)/Math.max(1,counts.length))*2,{counts});
 if(values.length>=4)warn('S-03','FOUR_OR_MORE_LINES','일반 대사 4줄 이상이므로 더 적은 줄과 가독 크기를 비교해 주세요.',(values.length-3)*8,{lineCount:values.length});
 if(values.length>1&&counts.at(-1)<=2&&total>Math.max(4,counts.at(-1)*2))warn('S-04','SHORT_LAST_LINE','마지막 한두 글자가 고립되는지 확인해 주세요.',14,{lastLineCharacters:counts.at(-1)});
 if(counts.length>=3){
  const max=Math.max(...counts),min=Math.min(...counts),middle=counts.slice(1,-1);
  if(shape==='ellipse'&&Math.max(counts[0],counts.at(-1))>Math.max(...middle)*1.4||shape!=='ellipse'&&min/max<.4)warn('S-05','TEXT_BLOCK_BALANCE','말풍선 모양에 맞는 글자 덩어리의 균형을 비교해 주세요.',3);
 }
 // Normalized glyph coordinates can round-trip 1.4 as 1.4000000000000004.
 // Ignore machine noise only; real spacing changes and every HARD gate remain.
 const spacingTolerance=16*Number.EPSILON;
 if(values.length>1&&(lineHeight<1.2-spacingTolerance||lineHeight>1.4+spacingTolerance)||align!=='center')warn('S-06','STYLE_RECOMMENDATION','행간·정렬 권장 범위를 벗어나지만 필수 실패는 아닙니다.',Math.max(0,lineHeight-1.4)*2+(align!=='center'?1:0));
 const references=sceneReferences.filter(r=>Number.isFinite(r.fontSizePx)&&r.fontSizePx>0);
 if(Number.isFinite(fontSizePx)&&references.some(r=>Math.max(r.fontSizePx/fontSizePx,fontSizePx/r.fontSizePx)>1.3))warn('S-06','RELATIVE_SCENE_SIZE','같은 높이대·비슷한 폭의 대사와 상대적 글자 크기를 비교해 주세요.',12,{referenceSizes:references.map(r=>r.fontSizePx),basis:'SPATIAL_HEURISTIC_NOT_CONFIRMED_PANEL'});
 const sizePenalty=Number.isFinite(referenceFontSizePx)&&referenceFontSizePx>0&&Number.isFinite(fontSizePx)?Math.max(0,1-fontSizePx/referenceFontSizePx)*40:0;
 return{warnings,penalty,score:100-penalty-sizePenalty,sizePenalty,characterCounts:counts,lineCount:values.length,semanticEvidence:'PUNCTUATION_AND_MODIFIER_HEURISTICS_NOT_HUMAN_OR_MODEL',recommendationsAreExperimental:true};
}
function evaluateKoreanTypesetting(input){
 const {text,lines,stage='FINAL_RASTER',fontSizePx,minFontSizePx=13,measurement:m={},safety={},glyphs={},mapping={},raster}=input??{};
 if(!isGeneralKorean(input))return{version:VERSION,profile:'OUT_OF_GENERAL_PROFILE',status:'NOT_APPLICABLE',hardViolations:[],softWarnings:[],pendingFinalChecks:['SPECIAL_PROFILE_REQUIRED'],finalRasterVerified:false,automaticApprovalAllowed:false};
 const textEvidence=inspectKoreanText(text,lines),hardViolations=[],checks={};
 const check=(rule,passed,code)=>{checks[rule]=passed===null?'PENDING':passed?'PASS':'FAIL';if(passed===false)hardViolations.push({rule,code});};
 const final=stage==='FINAL_RASTER',actual=Array.isArray(lines)?lines:[],bounds=m.inkBounds;
 check('H-01',textEvidence.complete,'APPROVED_TEXT_CHANGED');
 check('H-02',textEvidence.intraWordBreaks===0,'EOJEOL_OR_ATTACHED_MARK_SPLIT');
 check('H-03',textEvidence.punctuationOnlyLines.length===0&&textEvidence.leadingDetachedPunctuation.length===0,'ORPHAN_PUNCTUATION');
 const zero=(names)=>!!raster&&names.every(k=>raster[k]===0),measuredFit=m.fitsBox===true;
 check('H-04',!measuredFit||safety.safeAreaVerified===false?false:final?!!safety.safeAreaVerified&&raster?.paintedPixels>0&&zero(['outsideInteriorPixels','clippedPixels','canvasEdgePixels']):safety.safeAreaVerified===true?true:null,'SAFE_AREA_NOT_VERIFIED');
 const separated=m.linesSeparated===true&&Array.isArray(bounds)&&bounds.length===actual.filter(s=>s.trim()).length&&bounds.every((b,i)=>
  b&&['left','right','top','bottom'].every(k=>Number.isFinite(b[k]))&&b.right>b.left&&b.bottom>b.top&&(!i||b.top>=bounds[i-1].bottom));
 check('H-05',!separated||safety.otherRegionCollision===true||safety.protectedArtworkCollision===true?false:final?zero(['otherRegionCollisionPixels','overlappingInkPixels']):true,'LINE_OR_PROTECTED_TARGET_COLLISION');
 const badGlyph=glyphs.supported===false||Number.isFinite(glyphs.missingGlyphOccurrences)&&glyphs.missingGlyphOccurrences!==0||glyphs.unexpectedSubstitution===true||actual.some(s=>/[\uFFFD\u25A1]/u.test(s)&&![...s].filter(c=>/[\uFFFD\u25A1]/u.test(c)).every(c=>text.includes(c)));
 check('H-06',badGlyph?false:glyphs.supported===true&&glyphs.missingGlyphOccurrences===0?true:final?false:null,'GLYPH_NOT_VERIFIED');
 check('H-07',Number.isFinite(fontSizePx)&&fontSizePx>=minFontSizePx&&m.completeText===true,'MINIMUM_SIZE_OR_COMPLETENESS');
 const idKnown=typeof mapping.expectedId==='string'&&typeof mapping.actualId==='string',orderKnown=mapping.expectedOrder!==undefined&&mapping.actualOrder!==undefined;
 const mappingBad=idKnown&&mapping.expectedId!==mapping.actualId||orderKnown&&mapping.expectedOrder!==mapping.actualOrder||mapping.expectedSpeaker!==undefined&&mapping.expectedSpeaker!==mapping.actualSpeaker;
 check('H-08',mappingBad?false:idKnown&&orderKnown?true:final?false:null,'IDENTITY_SPEAKER_OR_ORDER_CHANGED');
 const soft=scoreKoreanReadability(input),pendingFinalChecks=final?Object.entries(checks).filter(([,v])=>v==='PENDING').map(([k])=>k):['ACTUAL_CLEANED_BACKGROUND','ACTUAL_RASTER_SAFE_AREA','ACTUAL_RASTER_COLLISIONS','ACTUAL_RASTER_GLYPHS'];
 return{version:VERSION,profile:'KO_GENERAL_HORIZONTAL_V1',stage,status:hardViolations.length?'BLOCKED':soft.warnings.length?'WARN':'PASS',hardChecks:checks,hardViolations,softWarnings:soft.warnings,readability:soft,textEvidence,
  pendingFinalChecks,finalRasterVerified:final&&!hardViolations.length&&!pendingFinalChecks.length,automaticApprovalAllowed:false};
}
function breakGeneralKorean(text,{estimateWidth,getAvailableWidth,maxLines=16}={}){
 if(!text.trim())return[];
 const matches=[...text.matchAll(/\S+/gu)],n=matches.length;if(n<2)return[text];
 const tokens=matches.map((m,i)=>({start:i===0?0:m.index,end:i===n-1?text.length:m.index+m[0].length}));
 const line=(a,b)=>text.slice(tokens[a].start,tokens[b-1].end),widths=new Map(),measure=s=>{if(!widths.has(s))widths.set(s,estimateWidth(s));return widths.get(s);};
 // Bound work and preserve every token even when the requested line limit is
 // impossible. Overflow is reported to measurement; never fragment or truncate.
 if(n>48)return tokens.map((_,i)=>line(i,i+1));
 let best=null,bestCost=Infinity;
 for(let k=1;k<=Math.min(n,16,Math.max(1,maxLines));k++){
  let states=new Map([[0,{cost:0,lines:[]}]]);
  for(let i=0;i<k;i++){
   const next=new Map(),available=Math.max(0,getAvailableWidth(i,k));
   for(const[a,state]of states)for(let b=a+1;b<=n-(k-i-1);b++){
    const s=line(a,b),w=measure(s);if(w>available+1e-9)continue;
    const candidate={cost:state.cost+Math.pow(1-w/Math.max(available,1e-9),2)*2,lines:[...state.lines,s]},old=next.get(b);
    if(!old||candidate.cost<old.cost)next.set(b,candidate);
   }
   states=next;if(!states.size)break;
  }
  const result=states.get(n);if(!result)continue;
  const soft=scoreKoreanReadability({text,lines:result.lines}),cost=soft.penalty+result.cost;
  if(cost<bestCost){best=result.lines;bestCost=cost;}
 }
 return best??tokens.map((_,i)=>line(i,i+1));
}
function verifyFinalKoreanEvidence(expected,proofs,reviewedWarnings={}){
 const fail=code=>{throw Object.assign(Error(code),{code});};
 if(!Array.isArray(proofs)||proofs.length!==expected.length||new Set(proofs.map(p=>p?.id)).size!==expected.length)fail('TYPESETTING_FINAL_VALIDATION_REQUIRED');
 for(const [i,e]of expected.entries()){
  const p=proofs[i],a=p?.assessment;
  if(p?.id!==e.id||p.text!==e.text||p.order!==e.order||a?.version!==VERSION||a.profile!=='KO_GENERAL_HORIZONTAL_V1'||a.stage!=='FINAL_RASTER'||a.finalRasterVerified!==true||a.pendingFinalChecks?.length!==0||a.hardViolations?.length!==0||a.textEvidence?.complete!==true||
    !Array.from({length:8},(_,n)=>'H-0'+(n+1)).every(h=>a.hardChecks?.[h]==='PASS')||!['PASS','WARN'].includes(a.status))fail('TYPESETTING_FINAL_VALIDATION_REQUIRED');
  if(a.status==='WARN'&&!a.softWarnings.every(w=>reviewedWarnings[e.id]?.includes(w.code)))fail('TYPESETTING_READABILITY_REVIEW_REQUIRED');
 }
 return{version:VERSION,status:proofs.some(p=>p.assessment.status==='WARN')?'WARN':'PASS',regions:proofs.length,finalRasterVerified:true};
}
module.exports={VERSION,isGeneralKorean,inspectKoreanText,scoreKoreanReadability,evaluateKoreanTypesetting,breakGeneralKorean,verifyFinalKoreanEvidence};
