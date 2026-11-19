'use strict';
// Output-script compliance is independent of semantic accuracy. Exact confirmed
// spans may be preserved; a name never grants permission to copy its sentence.
const VERSION='stage14r3-ko-output-v2';
const japanese=/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const hangul=/\p{Script=Hangul}/u;
const letters=/[\p{L}\p{N}]/u;
const controls=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const comparable=s=>s.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu,'');
function assessKoreanOutput({sourceText,translatedText,terms=[]}){
 const codes=[],exceptions=[];let remaining=typeof translatedText==='string'?translatedText:'';
 if(!remaining.trim()||controls.test(remaining))codes.push('EMPTY_OR_INVALID_TRANSLATION');
 const allowed=terms.filter(t=>t.status==='USER_CONFIRMED'&&typeof t.source==='string'&&t.source&&sourceText.includes(t.source)&&typeof t.target==='string'&&t.target&&!hangul.test(t.target)).sort((a,b)=>b.target.length-a.target.length);
 for(const term of allowed){if(remaining.includes(term.target)){remaining=remaining.split(term.target).join(' ');exceptions.push({termId:term.id??null,source:term.source,target:term.target,status:'USER_CONFIRMED_EXACT_SPAN'});}}
 const sourceResidue=japanese.test(remaining);
 const compact=remaining.normalize('NFKC').replace(/\s/gu,'');
 const sourceLength=sourceText.normalize('NFKC').replace(/\s/gu,'').length;
 if(compact.length>=Math.max(18,sourceLength*2)&&Array.from(compact.matchAll(/(.{1,10}?)\1{5,}/gsu))
   .some(match=>match[0].length>=Math.max(15,compact.length*.55)))codes.push('DEGENERATE_REPETITION');
 if(sourceResidue)codes.push('SOURCE_LANGUAGE_RESIDUE');
 if(/\p{L}/u.test(sourceText)&&!hangul.test(remaining)&&(!exceptions.length||letters.test(remaining)))codes.push('TARGET_LANGUAGE_MISSING');
 if(sourceResidue&&comparable(sourceText)===comparable(translatedText))codes.push('SOURCE_TEXT_COPIED');
 return {version:VERSION,status:codes.length?'REVIEW_REQUIRED':'PASS',codes,sourceResidue,exceptions,semanticAccuracy:null,automaticQualityApproval:false};
}
function assertKoreanOutputBatch(results){
 const flagged=results.filter(r=>r.semantic?.outputCompliance?.status!=='PASS');
 if(flagged.length)throw Object.assign(Error('한국어 출력의 누락·원문 잔류·반복 등 번역 오류를 확인하세요.'),{code:'PAGE_TRANSLATION_INVALID',regionIds:flagged.map(r=>r.id),outputCompliance:flagged.map(r=>({id:r.id,...r.semantic?.outputCompliance}))});
 return results;
}
module.exports={VERSION,assessKoreanOutput,assertKoreanOutputBatch};
