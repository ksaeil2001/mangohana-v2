import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {assessSemanticRisk}=require('../../packages/ai-engine/quality/translation-contract.cjs');
let api={};try{api=await import('../../scripts/v2/stage14r2-review.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const sha=s=>createHash('sha256').update(s).digest('hex');
function fixture(){
 const input={version:'stage11-input-v1',scope:{owner:'owner',projectId:'work',pageId:'page',pageNumber:1,sourceSha256:'a'.repeat(64)},context:{revision:null,terms:[],profiles:[],previousVerified:[],excluded:[]},regions:[{id:'r1',order:1,sourceText:'ありがとう',sourceLanguage:'ja'},{id:'r2',order:2,sourceText:'ヒロの話',sourceLanguage:'ja'}]};input.fingerprint=sha(JSON.stringify(input));
 const raw={regions:input.regions.map(r=>({id:r.id,source_reading:r.sourceText,translation:r.id==='r1'?'고마워':'ヒロ의 이야기',uncertain:false}))};
 const response={choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(raw)}}]};
 const translations={lines:input.regions.map((r,i)=>({...r,aiTranslation:raw.regions[i].translation})),records:input.regions.map(r=>({id:r.id,qaReport:{score:100,passed:true,issues:[]}}))};
 return {input,response,translations,ocr:{speechBubbles:input.regions.map(r=>({id:r.id,text:r.sourceText,bbox:{x:0,y:0,width:.2,height:.2}}))},gate:{flagged:[{id:'r2',riskCodes:['SOURCE_LANGUAGE_RESIDUE']}]},bindings:{translationInputSha256:'b'.repeat(64),responseSha256:'c'.repeat(64),normalizedSha256:'d'.repeat(64)},images:[],analysis:{}};
}
function packet(){assert.equal(typeof api.collectResidueReview,'function');return api.collectResidueReview(fixture());}
function submitted(p,decision='ACCEPT_AS_IS'){
 const s=api.makeHumanReviewTemplate(p);s.status='HUMAN_SUBMISSION_UNVERIFIED';s.reviewer='synthetic-test-reviewer';s.submittedAt='2026-11-13T12:00:00.000Z';s.regions[0]={...s.regions[0],decision,rationale:'합성 검사 입력, 실제 사람 검수 아님',confirmedByHuman:true};return s;
}
const residue=(sourceText,translatedText,terms=[])=>assessSemanticRisk({region:{sourceText,sourceLanguage:'ja'},translatedText,terms});
test('normal Korean remains a draft without a residue signal or human approval',()=>{
 const r=residue('ありがとう','고마워');assert.equal(r.signals.some(s=>s.code==='SOURCE_LANGUAGE_RESIDUE'),false);assert.equal(r.automaticQualityApproval,false);assert.equal(r.humanSemanticVerified,null);
});
test('actual untranslated dialogue produces a warning rather than a confirmed meaning verdict',()=>{
 const r=residue('待って','待って');const s=r.signals.find(s=>s.code==='SOURCE_LANGUAGE_RESIDUE');assert.equal(s.severity,'warning');assert.equal(s.confirmedError,false);assert.equal(r.humanReviewRequired,true);
});
test('a confirmed Japanese name satisfies glossary matching and exact-span output policy while meaning stays unverified',()=>{
 const r=residue('ヒロの話','ヒロ의 이야기',[{id:'name',source:'ヒロ',target:'ヒロ',status:'USER_CONFIRMED'}]);assert.equal(r.signals.some(s=>s.code==='GLOSSARY_CONFLICT'),false);assert.equal(r.signals.some(s=>s.code==='SOURCE_LANGUAGE_RESIDUE'),false);assert.equal(r.outputCompliance.status,'PASS');assert.equal(r.automaticQualityApproval,false);
});
test('a legitimate quotation can also trigger the conservative warning without proving an error',()=>{
 const r=residue('「あ」の字','‘あ’라는 글자');assert.equal(r.signals[0].code,'SOURCE_LANGUAGE_RESIDUE');assert.equal(r.signals[0].confirmedError,false);
});
test('packet preserves exact raw strings, script spans, original QA and adjacent context',()=>{
 const p=packet();assert.equal(p.allRegionIds.length,2);assert.equal(p.regions.length,1);const r=p.regions[0];assert.equal(r.sourceText,'ヒロの話');assert.equal(r.translatedText,'ヒロ의 이야기');assert.deepEqual(r.japaneseSpans.map(s=>s.text),['ヒロ']);assert.equal(r.qaReport.score,100);assert.equal(r.context.previous[0].translation,'고마워');assert.equal(r.humanReview.status,'HUMAN_REVIEW_PENDING');assert.equal(r.analysis.classification,'INCONCLUSIVE');
});
test('packet refuses a raw-to-saved translation mismatch',()=>{
 const f=fixture();f.translations.lines[1].aiTranslation='다른 값';assert.equal(typeof api.collectResidueReview,'function');assert.throws(()=>api.collectResidueReview(f),{code:'REVIEW_EVIDENCE_MISMATCH'});
});
test('all response IDs are checked even when only one region is flagged',()=>{
 const f=fixture();const raw=JSON.parse(f.response.choices[0].message.content);raw.regions[0].id='unexpected';f.response.choices[0].message.content=JSON.stringify(raw);assert.equal(typeof api.collectResidueReview,'function');assert.throws(()=>api.collectResidueReview(f),{code:'PAGE_TRANSLATION_INVALID'});
});
test('packet rejects missing warning IDs and a changed OCR input fingerprint',()=>{
 assert.equal(typeof api.collectResidueReview,'function');const f=fixture();f.gate.flagged[0].id='foreign';assert.throws(()=>api.collectResidueReview(f),{code:'REVIEW_EVIDENCE_MISMATCH'});const changed=fixture();changed.input.regions[0].sourceText='changed';assert.throws(()=>api.collectResidueReview(changed),{code:'REVIEW_EVIDENCE_MISMATCH'});
});
test('every human decision starts empty and an unfilled form remains pending',()=>{
 const p=packet(),s=api.makeHumanReviewTemplate(p);assert.equal(s.regions[0].decision,null);assert.equal(s.regions[0].correctedTranslation,null);assert.equal(s.regions[0].confirmedByHuman,false);assert.equal(api.inspectHumanReview(p,s).status,'HUMAN_REVIEW_PENDING');
});
test('binding checks reject foreign source, packet and page identities',()=>{
 const p=packet();for(const field of ['sourceSha256','packetSha256','pageId']){const s=submitted(p);s[field]='foreign';assert.throws(()=>api.inspectHumanReview(p,s),{code:'HUMAN_REVIEW_BINDING_INVALID'});}
});
test('edited or duplicate region IDs and raw strings cannot be submitted as approvals',()=>{
 const p=packet();for(const mutate of [s=>s.regions[0].regionId='foreign',s=>s.regions.push(s.regions[0]),s=>s.regions[0].translatedText='교체',s=>s.regions[0].sourceText='교체']){const s=submitted(p);mutate(s);assert.throws(()=>api.inspectHumanReview(p,s),{code:'HUMAN_REVIEW_BINDING_INVALID'});}
});
test('a decision without reviewer, reason or explicit confirmation is still pending',()=>{
 const p=packet();for(const mutate of [s=>s.reviewer='',s=>s.regions[0].rationale='',s=>s.regions[0].confirmedByHuman=false,s=>s.submittedAt=null]){const s=submitted(p);mutate(s);s.status='HUMAN_REVIEW_PENDING';assert.equal(api.inspectHumanReview(p,s).status,'HUMAN_REVIEW_PENDING');}
});
test('translation correction requires nonblank text and preserves the submitted correction verbatim',()=>{
 const p=packet(),s=submitted(p,'CORRECT_TRANSLATION');assert.throws(()=>api.inspectHumanReview(p,s),{code:'HUMAN_REVIEW_CORRECTION_REQUIRED'});s.regions[0].correctedTranslation='  히로의 이야기  ';const r=api.inspectHumanReview(p,s);assert.equal(r.regions[0].correctedTranslation,s.regions[0].correctedTranslation);assert.equal(r.executionAuthorized,false);
});
test('OCR correction returns to OCR review and never permits page execution',()=>{
 const p=packet(),s=submitted(p,'OCR_CORRECTION_REQUIRED');s.regions[0].correctedOcr='ヒロの説明';const r=api.inspectHumanReview(p,s);assert.equal(r.regions[0].route,'RETURN_TO_OCR_REVIEW');assert.equal(r.executionAuthorized,false);
});
test('needs context and reject remain blocked',()=>{
 const p=packet();for(const d of ['NEEDS_MORE_CONTEXT','REJECT']){const r=api.inspectHumanReview(p,submitted(p,d));assert.equal(r.regions[0].route,'KEEP_BLOCKED');assert.equal(r.executionAuthorized,false);}
});
test('even a complete claimed acceptance is not authenticated human evidence',()=>{
 const p=packet(),r=api.inspectHumanReview(p,submitted(p));assert.equal(r.status,'HUMAN_SUBMISSION_UNVERIFIED');assert.equal(r.humanApprovalVerified,false);assert.equal(r.executionAuthorized,false);
});
test('HTML contains five choices with no preselected approval, export and safely escaped data',()=>{
 const p=packet();p.regions[0].analysis.note='</script><img src=x onerror=alert(1)>';assert.equal(typeof api.renderHumanReviewHtml,'function');const html=api.renderHumanReviewHtml(p);for(const d of ['ACCEPT_AS_IS','CORRECT_TRANSLATION','OCR_CORRECTION_REQUIRED','NEEDS_MORE_CONTEXT','REJECT'])assert.ok(html.includes(d));assert.ok(html.includes('application/json'));assert.ok(html.includes('download'));assert.ok(!html.includes('<img src=x onerror=alert(1)>'));assert.ok(!html.includes('value="ACCEPT_AS_IS" selected'));assert.ok(html.includes('HUMAN_REVIEW_PENDING'));
});
test('submission header cannot claim approval, use an unknown status or malformed reviewer metadata',()=>{
 const p=packet();for(const [key,value]of [['status','HUMAN_REVIEWED'],['humanApprovalVerified',true],['reviewer',17],['submittedAt','not-a-date']]){const s=submitted(p);s[key]=value;assert.throws(()=>api.inspectHumanReview(p,s),{code:'HUMAN_REVIEW_BINDING_INVALID'});}
});
test('a complete submission with a pending header is rejected rather than promoted',()=>{
 const p=packet(),s=submitted(p);s.status='HUMAN_REVIEW_PENDING';assert.throws(()=>api.inspectHumanReview(p,s),{code:'HUMAN_REVIEW_STATE_INVALID'});
});
test('an incomplete form cannot claim the submitted state',()=>{
 const p=packet(),s=api.makeHumanReviewTemplate(p);s.status='HUMAN_SUBMISSION_UNVERIFIED';assert.throws(()=>api.inspectHumanReview(p,s),{code:'HUMAN_REVIEW_STATE_INVALID'});
});
