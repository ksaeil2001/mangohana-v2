// Saved real development outputs plus synthetic candidates; no human GT/inference.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),contract=require('../../packages/ai-engine/quality/translation-contract.cjs'),page=require('../../packages/ai-engine/quality/page-translation.cjs');
let ko={},revision={};try{ko=require('../../packages/ai-engine/quality/korean-output.cjs');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}try{revision=require('../../packages/ai-engine/quality/translation-revision.cjs');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
const read=n=>JSON.parse(fs.readFileSync(new URL('./fixtures/stage14r3/'+n,import.meta.url),'utf8'));
const input=read('translation-input.json'),response=read('translation-response-page.json').response,failures=read('failures.json');
const old=()=>page.parsePageTranslationResponse(response,input.regions);
const check=(sourceText,translatedText,terms=[])=>{assert.equal(typeof ko.assessKoreanOutput,'function');return ko.assessKoreanOutput({sourceText,translatedText,terms});};
const subsetIds=[...input.regions.slice(0,4),input.regions[5]].map(r=>r.id);
const plan=(args={})=>{assert.equal(typeof revision.planSelectiveTranslation,'function');return revision.planSelectiveTranslation({input,previousResults:old(),regionIds:subsetIds,attempt:1,...args});};
const replacements=()=>{const strings=['미안해, 히로 군','다른 두 사람 공부도 봐주고','어?','히로 군의 설명','나도 좀 더 봐줬으면 했는데'];return subsetIds.map((id,i)=>({...old().find(r=>r.id===id),translatedText:strings[i],rawTranslatedText:strings[i]}));};
const review=(args={})=>{assert.equal(typeof revision.reviewSelectiveReplacement,'function');return revision.reviewSelectiveReplacement({plan:plan(),input,previousResults:old(),replacementResults:replacements(),...args});};

for(const f of failures.cases.slice(0,4))test('saved untranslated output is held independently of JSON validity: '+f.source,()=>{
 const x=check(f.source,f.output);assert.equal(x.status,'REVIEW_REQUIRED');assert.equal(x.sourceResidue,true);assert.ok(x.codes.includes('SOURCE_LANGUAGE_RESIDUE'));assert.equal(x.semanticAccuracy,null);
});
test('a long repeated hangul response cannot pass script compliance',()=>{
 assert.ok(check('来ないで。','그만 '.repeat(43)).codes.includes('DEGENERATE_REPETITION'));
 assert.equal(check('ハハハ！','하하하!').status,'PASS');
});
test('benefactive reversal risk remains visible when the entire translation is Korean',()=>{
 const f=failures.cases[4],r=contract.assessSemanticRisk({region:{sourceText:f.source,sourceLanguage:'ja'},translatedText:f.output});
 assert.equal(r.signals.some(s=>s.code==='SOURCE_LANGUAGE_RESIDUE'),false);assert.ok(r.signals.some(s=>s.code==='BENEFACTIVE_DIRECTION_RISK'));assert.equal(r.semanticAccuracy,null);assert.equal(r.automaticQualityApproval,false);
});
test('normal Korean, punctuation and explicitly preserved Japanese names/quotes pass only the language gate',()=>{
 const rows=[['ありがとう','고마워',[]],['謝謝','고마워',[]],['……','……',[]],['ヒロの説明','ヒロ의 설명',[{source:'ヒロ',target:'ヒロ',status:'USER_CONFIRMED'}]],['「あ」の字','‘あ’라는 글자',[{source:'「あ」',target:'‘あ’',category:'quote',status:'USER_CONFIRMED'}]],['ヒロ','ヒロ',[{source:'ヒロ',target:'ヒロ',status:'USER_CONFIRMED'}]]];
 for(const [s,t,terms]of rows){const r=check(s,t,terms);assert.equal(r.status,'PASS',s);assert.equal(r.sourceResidue,false);assert.equal(r.semanticAccuracy,null);assert.equal(r.automaticQualityApproval,false);}
});
test('a preserved name never exempts surrounding dialogue, and an AI quote cannot authorize itself',()=>{
 assert.equal(check('ヒロの説明','ヒロの説明',[{source:'ヒロ',target:'ヒロ',status:'USER_CONFIRMED'}]).status,'REVIEW_REQUIRED');
 assert.equal(check('「あ」の字','‘あ’라는 글자',[{source:'「あ」',target:'‘あ’',status:'AI_PROPOSED'}]).sourceResidue,true);
 assert.equal(check('別の文','あ',[{source:'ない',target:'あ',status:'USER_CONFIRMED'}]).sourceResidue,true);
});
test('kanji-only residue, target language absence, empty output and invented punctuation are held separately',()=>{
 assert.equal(check('説明','説明').sourceResidue,true);
 const english=check('ありがとう','Thank you');assert.equal(english.sourceResidue,false);assert.ok(english.codes.includes('TARGET_LANGUAGE_MISSING'));
 for(const text of ['',' ','…'])assert.equal(check('待って',text).status,'REVIEW_REQUIRED');
});
test('numeric-only dialogue and explicitly confirmed Latin names do not invent a Korean requirement',()=>{
 assert.equal(check('3','3').status,'PASS');
 assert.equal(check('アリス','Alice',[{source:'アリス',target:'Alice',status:'USER_CONFIRMED'}]).status,'PASS');
 assert.equal(check('アリスの説明','Aliceの説明',[{source:'アリス',target:'Alice',status:'USER_CONFIRMED'}]).status,'REVIEW_REQUIRED');
});
test('all thirteen IDs and raw OCR survive changed source reading and a copied translation',()=>{
 const parsed=old(),before=structuredClone(input);parsed[1].proposedSource='他の二人の勉強も見てもらって';const rows=contract.validateTranslationBatch({input,results:parsed});
 assert.deepEqual(rows.map(r=>r.id),input.regions.map(r=>r.id));assert.equal(rows[1].sourceText,'他二人の勉強も見てもらって');assert.ok(rows[1].semantic.signals.some(s=>s.code==='INTERPRETED_SOURCE_CHANGED'));
 assert.equal(rows[1].semantic.outputCompliance.status,'REVIEW_REQUIRED');assert.equal(rows[1].semantic.draftUsable,false);assert.deepEqual(input,before);
});
test('valid JSON with Japanese in translation fails the atomic pre-application gate',()=>{
 const rows=contract.validateTranslationBatch({input,results:old()});assert.equal(typeof ko.assertKoreanOutputBatch,'function');assert.throws(()=>ko.assertKoreanOutputBatch(rows),{code:'PAGE_TRANSLATION_INVALID'});
});
test('negative quantity name and beneficiary warnings never certify meaning',()=>{
 const r=contract.assessSemanticRisk({region:{sourceText:'田中に二人の勉強を見てもらわない',sourceLanguage:'ja'},translatedText:'스즈키가 공부해.',terms:[{id:'name',source:'田中',target:'다나카'}]});
 for(const code of ['GLOSSARY_CONFLICT','POLARITY_RISK','QUANTITY_EXPRESSION_REVIEW','BENEFACTIVE_DIRECTION_RISK'])assert.ok(r.signals.some(s=>s.code===code),code);
 assert.equal(r.humanSemanticVerified,null);
});
test('the 안 inside 미안해 is not a Korean negative auxiliary',()=>{
 const r=contract.assessSemanticRisk({region:{sourceText:'ごめんね',sourceLanguage:'ja'},translatedText:'미안해'});assert.equal(r.signals.some(s=>s.code==='POLARITY_RISK'),false);
 const negative=contract.assessSemanticRisk({region:{sourceText:'行く',sourceLanguage:'ja'},translatedText:'안가'});assert.ok(negative.signals.some(s=>s.code==='POLARITY_RISK'));
});
test('versioned page schema disambiguates reading from Korean without changing Stage14-R sampling or channel options',()=>{
 const q=page.buildPageTranslationRequest({lines:input.regions,translationInput:input,imageDataUrl:'data:image/png;base64,aA=='}),s=q.response_format.json_schema;
 assert.match(s.name,/ko_v1/);assert.match(s.schema.properties.regions.items.properties.translation.description,/한국어/);assert.match(s.schema.properties.regions.items.properties.source_reading.description,/OCR/);
 assert.equal(q.max_tokens,2400);assert.equal(q.temperature,0);assert.equal(q.reasoning_budget_tokens,0);assert.equal(q.chat_template_kwargs.enable_thinking,false);
});
test('subset plan keeps original IDs, entire page context and confirmed context revision without mutating inputs',()=>{
 const before=structuredClone(input),p=plan();assert.deepEqual(p.regionIds,subsetIds);assert.deepEqual(p.input.regions.map(r=>r.id),subsetIds);assert.deepEqual(p.input.pageContext,input.regions);assert.equal(p.parentInputFingerprint,input.fingerprint);assert.equal(p.input.context.revision,input.context.revision);assert.deepEqual(input,before);assert.equal(p.automaticRetry,false);
});
for(const attempt of [0,3,Infinity])test('selective contract refuses out of budget attempt '+attempt,()=>{assert.throws(()=>plan({attempt}));});
test('unknown/duplicate selection, user owned candidates, changed context and stale previous set are rejected',()=>{
 for(const regionIds of [['missing'],[subsetIds[0],subsetIds[0]]])assert.throws(()=>plan({regionIds}));
 assert.throws(()=>plan({ownedRegionIds:[subsetIds[0]]}));const owned=old();owned[0].userTranslation='사용자 확정';assert.throws(()=>plan({previousResults:owned}));
 assert.throws(()=>plan({currentContextRevision:999}));const previousResults=old();previousResults[12].translatedText='달라진 후보';assert.throws(()=>review({previousResults}));
});
test('validated replacement forms thirteen unreviewed candidates while keeping eight old candidates byte-for-byte',()=>{
 const before=old(),x=review();assert.equal(x.status,'UNREVIEWED_CANDIDATE_SET');assert.equal(x.candidates.length,13);assert.equal(x.applied,false);assert.equal(x.executionAuthorized,false);assert.equal(x.humanSemanticVerified,null);
 for(const row of before.filter(r=>!subsetIds.includes(r.id)))assert.deepEqual(x.candidates.find(r=>r.id===row.id),row);
 assert.deepEqual(old(),before);
});
for(const defect of ['missing','duplicate','foreign','empty','japanese','source-change','new-negation'])test('one failed or worse selective candidate refuses the entire replacement: '+defect,()=>{
 const rows=replacements();if(defect==='missing')rows.pop();if(defect==='duplicate')rows[4]={...rows[0]};if(defect==='foreign')rows[4].id='foreign';if(defect==='empty')rows[4].translatedText=' ';if(defect==='japanese')rows[0].translatedText='ごめんね';if(defect==='source-change')rows[0].proposedSource='別の意味';if(defect==='new-negation')rows[0].translatedText='미안하지 않아';
 const before=old(),x=review({replacementResults:rows});assert.equal(x.status,'REJECTED_PRESERVED');assert.deepEqual(x.candidates,before);assert.equal(x.applied,false);
});
