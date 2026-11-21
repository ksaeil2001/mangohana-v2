import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import contract from '../../packages/ai-engine/quality/translation-contract.cjs';

const cases=JSON.parse(await readFile(new URL('./fixtures/repeated-numeric-fields.json',import.meta.url),'utf8'));
test('extra copies of a numeric field hold a draft while matching repetitions and dialogue stay usable',()=>{
 for(const [sourceText,translatedText,expected] of cases){
  const risk=contract.assessSemanticRisk({region:{sourceText},translatedText});
  assert.equal(risk.signals.some(s=>s.code==='REPEATED_NUMERIC_FIELDS'),expected,sourceText);
  assert.equal(risk.draftUsable,!expected);
  const check=()=>contract.assertDraftPredicates([{id:'line-1',sourceText,translatedText}]);
  if(expected)assert.throws(check,e=>e.code==='PAGE_TRANSLATION_INVALID' && e.semanticReview[0].code==='REPEATED_NUMERIC_FIELDS' && e.semanticReview[0].translatedText===translatedText);
  else assert.doesNotThrow(check);
 }
});
