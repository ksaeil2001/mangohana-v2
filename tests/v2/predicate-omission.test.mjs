import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import contract from '../../packages/ai-engine/quality/translation-contract.cjs';
import { translatedPage, revision } from '../../packages/ai-engine/quality/product-onnx.cjs';
import { assertReviewedRisks } from '../../packages/ai-engine/quality/human-translation-review.cjs';
import { createHash } from 'node:crypto';

const code = 'PREDICATE_REDUCED_TO_GASP';
const cases = JSON.parse(await readFile(new URL('./fixtures/predicate-gasp.json', import.meta.url), 'utf8'));

test('Japanese predicates reduced to breathing are held while genuine gasps and translated predicates survive', () => {
  for (const [sourceText, translatedText, expected] of cases) {
    const row = { id: 'speech', sourceText, translatedText };
    const semantic = contract.assessSemanticRisk({ region: row, translatedText });
    const signal = semantic.signals.find(item => item.code === code);
    assert.equal(Boolean(signal), expected, sourceText);
    assert.equal(semantic.outputCompliance.status, 'PASS');
    assert.equal(semantic.draftUsable, !expected);
    assert.equal(semantic.humanSemanticVerified, null);
    if (expected) {
      assert.equal(signal.confirmedError, false);
      assert.throws(() => contract.assertDraftPredicates([row]), error => {
        assert.equal(error.code, 'PAGE_TRANSLATION_INVALID');
        assert.deepEqual(error.semanticReview, [{ ...row, code }]);
        return true;
      });
    } else {
      assert.doesNotThrow(() => contract.assertDraftPredicates([row]));
    }
  }
});

test('the ONNX adapter checks the candidate against the bound source even when provider flags are empty', () => {
  const [sourceText, translatedText] = cases[0], line = { id: 'speech', sourceText };
  for (const flags of [[], [code]]) {
    const reply = { data: { revision, generation: { eos: true, inputTokens: 10, generatedTokens: 3 },
      lines: [{ id: line.id, source: sourceText, ko: translatedText, rawKo: translatedText, flags }] } };
    const original = structuredClone(reply);
    assert.throws(() => translatedPage(reply, [line], () => ({ issues: [] }), { requestId: 'local' }),
      error => error.code === 'PAGE_TRANSLATION_INVALID' && error.semanticReview?.[0].id === line.id);
    assert.deepEqual(reply, original);
  }
});

test('a signed sentence decision can explicitly accept the new risk without treating it as human ground truth', () => {
  const [sourceText, translatedText] = cases[0], row = { id: 'speech', translatedText };
  row.semantic = contract.assessSemanticRisk({ region: { sourceText }, translatedText });
  const receipt = { selections: [{ regionId: row.id, selectedTranslationSha256: createHash('sha256').update(translatedText).digest('hex'), riskDecisions: [] }] };
  assert.throws(() => assertReviewedRisks(receipt, [row]), { code: 'HUMAN_REVIEW_RISK_UNRESOLVED' });
  receipt.selections[0].riskDecisions.push({ code, decision: 'ACCEPT_THIS_SENTENCE', rationale: '검수 예시' });
  assert.doesNotThrow(() => assertReviewedRisks(receipt, [row]));
});
