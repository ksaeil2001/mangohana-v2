'use strict';

// Structural validation and bounded warning signals, never a semantic oracle.
const {createHash}=require('node:crypto');
const VERSION='stage11-input-v1',TEXT_PROMPT='stage11-text-v1',PAGE_PROMPT='stage14r3-page-ko-v1';
const {assessKoreanOutput}=require('./korean-output.cjs');
const controls=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const must=(ok,code='TRANSLATION_IDENTITY_INVALID')=>{if(!ok)fail(code,'번역 원문·영역·문맥의 대응을 확인해야 합니다. 기존 결과는 보존했습니다.');};
const text=(s,max=4000)=>typeof s==='string'&&!!s.trim()&&s.length<=max&&!controls.test(s);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const userOwnedSpeaker=line=>Array.isArray(line.ocrUserOwnedFields)&&line.ocrUserOwnedFields.includes('speaker')&&text(line.speaker,200);

function buildTranslationInput({lines,extraction,selection,context,scope={}}){
 must(Array.isArray(lines)&&lines.length>0&&lines.length<=128&&Array.isArray(extraction?.speechBubbles)&&lines.length===extraction.speechBubbles.length);
 must(!selection?.needsReviewRegions&&!selection?.decisions?.some(d=>d.action==='needs_review'),'OCR_REVIEW_REQUIRED');
 const groups=[...extraction.speechBubbles].sort((a,b)=>(a.readingOrder??0)-(b.readingOrder??0));
 const seen=new Set(),sourceIds=new Set();let characters=0;
 const regions=lines.map((line,i)=>{
  const group=groups[i];must(line&&text(line.id,200)&&!seen.has(line.id)&&line.id===group.id&&line.sourceText===group.text&&text(line.sourceText,2000));seen.add(line.id);
  must(line.userTranslation===undefined&&line.aiTranslation===undefined&&(!line.ocrEditStatus||line.ocrEditStatus==='ai_proposed'));
  must(Number.isSafeInteger(line.order)&&line.order>0&&line.order===(group.readingOrder??i+1)&&(i===0||line.order>lines[i-1].order)&&(!line.pageNumber||line.pageNumber===extraction.pageNumber));
  const ids=group.ocrRefinement?.sourceDetectionIds??group.productionOcrProvenance?.sourceDetectionIds??group.inventoryLineIds??[];
  must(Array.isArray(ids)&&ids.every(id=>text(id,200)&&!sourceIds.has(id))&&new Set(ids).size===ids.length&&same(line.sourceLineIds??[],ids));ids.forEach(id=>sourceIds.add(id));
  const decision=selection?.decisions?.find(d=>d.id===line.id);if(selection)must(decision?.action==='translate'&&(!decision.sourceLineIds||same(decision.sourceLineIds,ids)));
  const candidates=(group.speakerCandidates??[]).filter(s=>text(s,200));
  const speaker=userOwnedSpeaker(line)?{name:line.speaker,status:'USER_MODIFIED',confirmed:true,origin:'ocr_user_owned_speaker'}:
   {name:candidates.length===1?candidates[0]:null,status:candidates.length?'AI_PROPOSED':'UNKNOWN',confirmed:false,origin:'ocr_speaker_candidates',candidates};
  characters+=line.sourceText.length;
  return {id:line.id,order:line.order,pageNumber:extraction.pageNumber,sourceText:line.sourceText,sourceLanguage:line.sourceLanguage??'auto',dialogueType:line.dialogueType??'speech',sourceLineIds:[...ids],mappingKind:ids.length?'explicit_source_line_group':'legacy_group_without_source_line_evidence',roiId:decision?.detectorRegionId??group.ocrRefinement?.roiId??null,speaker,addressee:{name:null,status:'UNKNOWN',origin:'not_observed'},
   ...(Number.isSafeInteger(group.panelOrder)&&group.panelOrder>0?{panelOrder:group.panelOrder}:{})};
 });
 must(characters<=8000);
 const safe={revision:null,snapshotSha256:null,terms:[],profiles:[],previousVerified:[],excluded:[]};
 if(context){
  const copied=structuredClone(context),{snapshotSha256,...snapshot}=copied;
  if(!snapshotSha256){safe.excluded.push({kind:'unbound_context',reason:'SERVER_SNAPSHOT_REQUIRED'});}
  else {
   must(snapshotSha256===sha(snapshot),'TRANSLATION_CONTEXT_INVALID');
   for(const key of ['owner','projectId','pageId','pageNumber','sourceSha256'])must(snapshot[key]===scope[key],'TRANSLATION_CONTEXT_INVALID');
   must(Number.isSafeInteger(snapshot.glossaryRevision)&&snapshot.glossaryRevision>=0,'TRANSLATION_CONTEXT_INVALID');
   safe.revision=snapshot.glossaryRevision;safe.snapshotSha256=snapshotSha256;
   const terms=[...(snapshot.glossary??[]),...(snapshot.conditionalGlossary??[])];must(terms.length<=1000,'TRANSLATION_CONTEXT_INVALID');
   for(const term of terms){
    must(term&&text(term.id,128)&&text(term.source,200)&&text(term.target,200),'TRANSLATION_CONTEXT_INVALID');
    if(term.status!==undefined&&term.status!=='USER_CONFIRMED'){safe.excluded.push({kind:'term',id:term.id,reason:'UNCONFIRMED_TERM'});continue;}
    const eligible=regions.some(r=>applies(term,r));
    if(eligible)safe.terms.push({...term,status:'USER_CONFIRMED'});
    else safe.excluded.push({kind:'term',id:term.id,reason:term.condition?'CONDITIONAL_TERM_UNRESOLVED':'TERM_NOT_IN_CURRENT_SOURCE'});
   }
   safe.terms.sort((a,b)=>(b.priority??0)-(a.priority??0)||b.source.length-a.source.length||a.id.localeCompare(b.id));
   for(const profile of snapshot.profiles??[]){must(profile&&text(profile.id,128)&&text(profile.name,200)&&Array.isArray(profile.aliases)&&profile.aliases.every(a=>text(a,200)),'TRANSLATION_CONTEXT_INVALID');if(profile.status!==undefined&&profile.status!=='USER_CONFIRMED'){safe.excluded.push({kind:'profile',id:profile.id,reason:'UNCONFIRMED_PROFILE'});continue;}safe.profiles.push({...profile,status:'USER_CONFIRMED'});}
   must(safe.profiles.length<=100,'TRANSLATION_CONTEXT_INVALID');
   for(const turn of snapshot.previousContext??[]){
    // The existing store supplies AI_PROPOSED turns only. Explicit user-owned
    // prior context additionally needs same-owner/work/page/hash provenance.
    const trusted=turn.status==='USER_CONFIRMED'&&turn.owner===scope.owner&&turn.projectId===scope.projectId&&Number.isSafeInteger(turn.pageNumber)&&turn.pageNumber<scope.pageNumber&&turn.pageNumber>0&&text(turn.source)&&text(turn.translation)&&/^[a-f0-9]{64}$/.test(turn.reportSha256??'')&&/^[a-f0-9]{64}$/.test(turn.sourceSha256??'');
    if(trusted)safe.previousVerified.push(structuredClone(turn));
    else safe.excluded.push({kind:'prior_turn',id:turn.regionId??turn.id??null,reason:turn.status==='AI_PROPOSED'?'UNREVIEWED_AI_CONTEXT':'PRIOR_CONTEXT_PROVENANCE_UNVERIFIED'});
   }
   for(const id of snapshot.deferredConditionalTermIds??[])safe.excluded.push({kind:'term',id,reason:'CONDITIONAL_TERM_UNRESOLVED'});
  }
 }
 for(const r of regions.filter(r=>r.speaker.confirmed)){
  const matches=safe.profiles.filter(p=>[p.name,...p.aliases].includes(r.speaker.name));
  if(matches.length===1){r.speaker.profileId=matches[0].id;r.speaker.speechStyle=matches[0].speechStyle;}
 }
 const input={version:VERSION,promptVersions:{text:TEXT_PROMPT,page:PAGE_PROMPT},scope:structuredClone(scope),regions,preserved:structuredClone(extraction.nonSpeechText??[]),context:safe};
 input.fingerprint=sha(input);return freeze(input);
}

function applies(term,region){
 if(!region.sourceText.includes(term.source))return false;
 const c=term.condition;if(!c)return true;
 if(c.targetContext||c.speaker&&(!region.speaker.confirmed||c.speaker!==region.speaker.name)||c.dialogueType&&c.dialogueType!==region.dialogueType)return false;
 return true;
}

function resolveTerms(input,region){
 const bySource=new Map(),terms=[],conflicts=[],excluded=[];
 for(const term of input.context.terms.filter(t=>applies(t,region))){const entries=bySource.get(term.source)??[];entries.push(term);bySource.set(term.source,entries);}
 const specificity=t=>Object.keys(t.condition??{}).length;
 for(const [source,candidates]of bySource){
  candidates.sort((a,b)=>specificity(b)-specificity(a)||(b.priority??0)-(a.priority??0));
  const first=candidates[0],best=candidates.filter(t=>specificity(t)===specificity(first)&&(t.priority??0)===(first.priority??0));
  if(new Set(best.map(t=>t.target)).size>1){conflicts.push({source,termIds:best.map(t=>t.id)});excluded.push(...candidates.map(t=>({kind:'term',id:t.id,reason:'CONFIRMED_TERM_CONFLICT'})));}
  else {terms.push(first);excluded.push(...candidates.slice(1).map(t=>({kind:'term',id:t.id,reason:'MORE_SPECIFIC_OR_HIGHER_PRIORITY_TERM_SELECTED'})));}
 }
 return {terms,conflicts,excluded};
}

// UTF-8 byte budgets are conservative input-selection limits, not measured
// tokenizer counts. The installed 4096/8192 model context settings stay intact.
function linePromptData(input,id,{budget=4096}={}){
 const target=input.regions.find(r=>r.id===id);must(target);
 const resolved=resolveTerms(input,target),terms=[],profiles=[],previousVerified=[],currentPage=[],excluded=[...resolved.excluded];
 const data={priority:['USER_CONFIRMED','VERIFIED_WORK_CONTEXT','SOURCE_OBSERVATION','AI_PROPOSED'],revision:input.context.revision,source:target,terms,profiles,previousVerified,currentPage};
 must(Buffer.byteLength(JSON.stringify(data),'utf8')<=budget,'TRANSLATION_INPUT_LIMIT');
 const offer=(list,item,kind)=>{list.push(item);if(Buffer.byteLength(JSON.stringify(data),'utf8')>budget){list.pop();excluded.push({kind,id:item.id??item.regionId??null,reason:'PROMPT_BUDGET_EXCLUDED'});}};
 for(const term of resolved.terms)offer(terms,term,'term');
 // Relevant confirmed profiles outrank lower priority page/prior context.
 for(const p of input.context.profiles.filter(p=>[p.name,...p.aliases].some(n=>target.sourceText.includes(n)||target.speaker.confirmed&&target.speaker.name===n)))offer(profiles,p,'profile');
 for(const turn of input.context.previousVerified.slice(-16))offer(previousVerified,turn,'verified_prior_turn');
 for(const r of input.regions.filter(r=>r.id!==id))offer(currentPage,r,'source_observation');
 return {...data,budget:{unit:'utf8_bytes',limit:budget,selectedBytes:Buffer.byteLength(JSON.stringify(data),'utf8'),tokenCount:null},excluded:[...input.context.excluded,...excluded]};
}

function pagePromptData(input,{budget=12000,compact=false}={}){
 const targets=compact?{scene:input.regions.map(r=>({id:r.id,order:r.order,
   ...(r.panelOrder?{panelOrder:r.panelOrder}:{}),
   ...(r.speaker.confirmed?{speaker:r.speaker.name,...(r.speaker.speechStyle?{speechStyle:r.speaker.speechStyle}:{})}:{})
 }))}:{targets:input.regions};
 const data={promptVersion:compact?'onnx-page-ja-ko-v1':PAGE_PROMPT,revision:input.context.revision,...targets,...(input.pageContext?{currentPage:input.pageContext}:{}),terms:[],profiles:[],previousVerified:[],excludedCounts:{}};
 must(Buffer.byteLength(JSON.stringify(data),'utf8')<=budget,'TRANSLATION_INPUT_LIMIT');
 const omitted=[...input.context.excluded];
 const offer=(list,item,kind)=>{list.push(item);if(Buffer.byteLength(JSON.stringify(data),'utf8')>budget){list.pop();omitted.push({kind,reason:'PROMPT_BUDGET_EXCLUDED'});}};
 const selected=new Map();for(const r of input.regions){const resolved=resolveTerms(input,r);omitted.push(...resolved.excluded);for(const term of resolved.terms){const value=selected.get(term.id)??{...term,targetRegionIds:[]};value.targetRegionIds.push(r.id);selected.set(term.id,value);}}
 for(const term of selected.values())offer(data.terms,term,'term');
 for(const p of input.context.profiles.filter(p=>input.regions.some(r=>[p.name,...p.aliases].some(n=>r.sourceText.includes(n)||r.speaker.confirmed&&r.speaker.name===n))))offer(data.profiles,p,'profile');
 for(const turn of input.context.previousVerified.slice(-16))offer(data.previousVerified,turn,'verified_prior_turn');
 for(const e of omitted){const key=e.kind+':'+e.reason;data.excludedCounts[key]=(data.excludedCounts[key]??0)+1;}
 return data;
}

function regionResponseFormat(regions){
 return {type:'json_schema',json_schema:{name:regions.length===1?'manga_dialogue_line':'manga_dialogue_page',strict:true,schema:{type:'object',properties:{regions:{type:'array',minItems:regions.length,maxItems:regions.length,items:{type:'object',properties:{id:{type:'string',enum:regions.map(r=>r.id)},source_reading:{type:'string',minLength:1},translation:{type:'string',minLength:1},uncertain:{type:'boolean'}},required:['id','source_reading','translation','uncertain'],additionalProperties:false}}},required:['regions'],additionalProperties:false}}};
}

const gaspRisk = 'PREDICATE_REDUCED_TO_GASP';
const repeatedFieldsRisk = 'REPEATED_NUMERIC_FIELDS';
const punctuationRisk = 'PUNCTUATION_EXPANDED';
const draftReviewNotices = Object.freeze({
 [gaspRisk]: '숨소리만 남아 대사의 동작이나 상태가 생략됐을 수 있어요. 원문과 번역을 확인해 주세요.',
 [repeatedFieldsRisk]: '같은 수치 항목이 원문보다 여러 번 반복됐어요. 원문과 번역을 확인해 주세요.',
 [punctuationRisk]: '판독한 원문에는 문장부호만 있고 번역에는 단어가 생겼어요. 원문과 번역을 확인해 주세요.',
});
function draftReviewNotice(rows) {
 const code=rows[0]?.code;
 return Object.hasOwn(draftReviewNotices,code) && rows.every(row=>row.code===code) ? draftReviewNotices[code] :
  '표시한 대사에 서로 다른 검토 사유가 있어요. 원문과 번역을 확인해 주세요.';
}
const completedPredicate = /[ぁ-ん一-龯々](?:[ちじ]ゃ(?:う|った)|[てで]しま(?:う|った))(?:んだ)?(?:よ|ね|ぞ|わ|かも)?$/u;
function predicateReducedToGasp(source, target) {
 if (typeof source !== 'string' || typeof target !== 'string') return false;
 const clause = source.normalize('NFKC').replace(/[。．.!！?？…〜～~「」『』“”\s]+$/u, '');
 if (!completedPredicate.test(clause)) return false;
 const syllables = target.normalize('NFKC').replace(/[\p{P}\s~〜～]/gu, '');
 return /^[흐윽헉하아으헥후우휴허억]+$/u.test(syllables) && /흐|윽|헉|헥|하아|허억|후우|으으/u.test(syllables);
}
function numericRatios(value) {
 return (value.match(/[0-9]+\s*\/\s*[0-9]+/gu) ?? []).map(ratio => ratio.replace(/\s+/gu, ''));
}
function repeatedNumericFields(sourceText, translatedText) {
 const source = sourceText.normalize('NFKC');
 if ((source.match(/[【\[]/gu) ?? []).length < 2) return false;
 const target = translatedText.normalize('NFKC');
 const original = numericRatios(source);
 if (original.length < 2 || numericRatios(target).length < original.length + 3) return false;
 const originalCounts = new Map(), fieldCounts = new Map();
 for (const ratio of original) originalCounts.set(ratio, (originalCounts.get(ratio) ?? 0) + 1);
 for (const match of target.matchAll(/\[([^\[\]\r\n]{1,120})\]|【([^【】\r\n]{1,120})】/gu)) {
  const field = (match[1] ?? match[2]).replace(/\s+/gu, '');
  const ratios = numericRatios(field);
  if (ratios.length !== 1 || !/[가-힣]/u.test(field)) continue;
  const count = (fieldCounts.get(field) ?? 0) + 1;
  if (count >= (originalCounts.get(ratios[0]) ?? 0) + 3) return true;
  fieldCounts.set(field, count);
 }
 return false;
}
function draftReviewReason(source, target) {
 if (typeof source !== 'string' || typeof target !== 'string') return null;
 if (source.trim() && /^[\p{P}\s]+$/u.test(source) && /[\p{L}\p{N}]/u.test(target)) return punctuationRisk;
 if (predicateReducedToGasp(source, target)) return gaspRisk;
 return repeatedNumericFields(source, target) ? repeatedFieldsRisk : null;
}
function assertDraftPredicates(rows, translationEvidence) {
 const semanticReview = [];
 for (const { id, sourceText, translatedText, semantic } of rows) {
  const code = draftReviewReason(sourceText, translatedText) ??
    semantic?.signals?.find(signal => Object.hasOwn(draftReviewNotices,signal.code))?.code;
  if (code) semanticReview.push({ id, sourceText, translatedText, code });
 }
 if (semanticReview.length) throw Object.assign(Error(draftReviewNotice(semanticReview)), {
   code: 'PAGE_TRANSLATION_INVALID', regionIds: semanticReview.map(row => row.id), receivedCandidateIds: rows.map(row => row.id), semanticReview,
   ...(translationEvidence ? { translationEvidence } : {}),
 });
}

function assessSemanticRisk({region,translatedText,terms=[],proposedSource,uncertain=false,qaReport}){
 const source=region.sourceText,signals=[];
 const warn=(code,detail)=>signals.push({code,classification:'LIMITED_RULE_RISK_SIGNAL',confirmedError:false,severity:'warning',detail});
 for(const term of terms)if(applies(term,{...region,speaker:region.speaker??{confirmed:false}})&&!translatedText.includes(term.target))warn('GLOSSARY_CONFLICT',{termId:term.id,expected:term.target,source:term.source,condition:term.condition??null});
 const jaNegative=/(?:ない|なかった|ません|ぬ[。！!?？]?|じゃない)/.test(source),koNegative=/(?:않|없|아니|말[아고]|마[.!?。…]*$|(?:^|[\s\p{P}])(?:안(?:\s|[가갈갔해했돼되먹줄])|못(?:\s|[가갈해했먹])))/u.test(translatedText);
 // Auxiliary negatives/idioms are ambiguous: never claim a confirmed reversal.
 if(jaNegative!==koNegative)warn('POLARITY_RISK','부정 표현의 형태 차이; 관용구·이중 부정·생략은 독립 검토 필요');
 const nums=s=>s.normalize('NFKC').match(/\d+(?:[,.]\d+)*/g)??[];
 if(!same(nums(source).sort(),nums(translatedText).sort())&&(nums(source).length||nums(translatedText).length))warn('NUMBER_RISK','숫자 형태/수량 차이; 한글 수사·단위 환산은 별도 검토');
 if(/[?？]/.test(source)&&!/[?？]/.test(translatedText))warn('QUESTION_RISK','의문문 표지 차이');
 if(/(?:来い|しろ|せよ|なさい|待て)/.test(source)&&/[?？]/.test(translatedText))warn('COMMAND_RISK','명령·질문 표현 차이');
 if(/(?:です|ます|ください)/.test(source)&&!/(?:요|니다|시오|세요|죠)[.!?。…~\s]*$/.test(translatedText))warn('REGISTER_RISK','원문 경어의 한국어 말끝 검토');
 if(region.speaker?.confirmed&&region.speaker.speechStyle&&qaReport?.issues?.some(i=>i.type==='SPEECH_STYLE_MISMATCH'))warn('SPEAKER_STYLE_RISK','사용자 소유 화자·관계·상황의 말투 규칙 검토');
 const outputCompliance=assessKoreanOutput({sourceText:source,translatedText,terms});
 const draftHold = draftReviewReason(source, translatedText);
 if (draftHold) warn(draftHold,draftReviewNotices[draftHold]);
 for(const code of outputCompliance.codes)warn(code,'한국어 출력 준수 검토; 의미 정확도 판정과 독립');
 // Japanese benefactive auxiliaries encode who acts and who receives help.
 // The presence/absence of Korean morphology cannot prove that direction.
 if(/(?:て|で)(?:もら|くれ|あげ)/.test(source))warn('BENEFACTIVE_DIRECTION_RISK','행위자·수혜자·희망의 방향을 앞뒤 대사와 함께 검토; 올바른 후보도 사람 검수 필요');
 if(/(?:[一二三四五六七八九十百]+(?:人|個|回|本|枚|つ)|ふたり|ひとり)/.test(source))warn('QUANTITY_EXPRESSION_REVIEW','한자·일본어 수량과 한국어 수사 대응은 문자 숫자 검사로 확정 불가');
 if(proposedSource!==undefined&&proposedSource!==source)warn('INTERPRETED_SOURCE_CHANGED','모델이 제안한 원문 읽기가 OCR 관측과 다름; 원본은 유지');
 if(uncertain)warn('MODEL_UNCERTAIN','모델 자체 불확실 표시');
 return {version:'stage11-risk-v1',riskPolicyVersion:'stage14r3-risk-v2',outputCompliance,signals,statuses:[...(qaReport?.passed?['RULE_QA_PASSED']:[]),...(signals.length?['SEMANTIC_RISK_FLAGGED']:[]),'SEMANTIC_REVIEW_REQUIRED','SEMANTIC_NOT_MEASURED'],semanticReviewRequired:true,humanReviewRequired:true,humanSemanticVerified:null,semanticAccuracy:null,independentSemanticEvaluation:null,automaticQualityApproval:false,draftUsable:outputCompliance.status==='PASS'&&!draftHold,notMeasured:['omission_addition','speaker_addressee_meaning','honorific_relationship','tense_aspect','context_contradiction','role_classification','ambiguity_irony_wordplay','kanji_korean_number_equivalence']};
}

function validateTranslationBatch({input,results,currentContextRevision=input.context.revision}){
 must(currentContextRevision===input.context.revision,'TRANSLATION_CONTEXT_STALE');
 must(Array.isArray(results)&&results.length===input.regions.length,'TRANSLATION_RESPONSE_INVALID');
 const byId=new Map();for(const r of results){must(r&&text(r.id,200)&&!byId.has(r.id)&&input.regions.some(x=>x.id===r.id)&&text(r.translatedText)&&(!r.sourceText||r.sourceText===input.regions.find(x=>x.id===r.id).sourceText),'TRANSLATION_RESPONSE_INVALID');byId.set(r.id,r);}
 return input.regions.map(region=>{const r=byId.get(region.id),resolved=resolveTerms(input,region),semantic=assessSemanticRisk({region,translatedText:r.translatedText,terms:resolved.terms,proposedSource:r.proposedSource,uncertain:r.uncertain,qaReport:r.qaReport});
  if(resolved.conflicts.length){semantic.signals.push({code:'GLOSSARY_POLICY_CONFLICT',classification:'CONFIRMED_POLICY_CONFLICT_NOT_SEMANTIC_ORACLE',confirmedError:false,severity:'warning',detail:resolved.conflicts});if(!semantic.statuses.includes('SEMANTIC_RISK_FLAGGED'))semantic.statuses.push('SEMANTIC_RISK_FLAGGED');}
  semantic.statuses.unshift('OUTPUT_SCHEMA_VALID','REGION_MAPPING_VALID');return {...structuredClone(r),semantic};});
}
module.exports={VERSION,TEXT_PROMPT,PAGE_PROMPT,buildTranslationInput,resolveTerms,linePromptData,pagePromptData,regionResponseFormat,assessSemanticRisk,draftReviewReason,draftReviewNotices,draftReviewNotice,assertDraftPredicates,validateTranslationBatch};
