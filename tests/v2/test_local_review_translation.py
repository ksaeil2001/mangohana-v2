import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

MODULE=Path(__file__).resolve().parents[2] / 'scripts/v2/local_review/translate.py'


class LocalTranslationTest(unittest.TestCase):
    def test_predicate_reduced_to_gasps_uses_the_same_examples_as_the_web_engine(self):
        spec = importlib.util.spec_from_file_location('local_mt', MODULE)
        mt = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mt)
        examples = json.loads((Path(__file__).parent / 'fixtures/predicate-gasp.json').read_text('utf-8'))
        for source, target, expected in examples:
            with self.subTest(source=source):
                self.assertEqual('PREDICATE_REDUCED_TO_GASP' in mt.review_flags(source, target, True), expected)

    def test_repeated_numeric_fields_match_web_review(self):
        from pathlib import Path
        import json
        spec = importlib.util.spec_from_file_location('local_mt', MODULE)
        mt = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mt)
        rows = json.loads((Path(__file__).parent / 'fixtures/repeated-numeric-fields.json').read_text('utf-8'))
        for source, target, expected in rows:
            with self.subTest(source=source, target=target):
                self.assertEqual('REPEATED_NUMERIC_FIELDS' in mt.review_flags(source, target, True), expected)

    def test_translation_draft_preserves_early_end_and_uncertain_text(self):
        self.assertTrue(MODULE.exists(), 'local ONNX translation adapter is missing')
        spec=importlib.util.spec_from_file_location('local_mt',MODULE)
        m=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        self.assertEqual(m.review_flags('またね','또 봐.', True),[])
        self.assertIn('NO_TARGET_TEXT',m.review_flags('またね','',True))
        self.assertIn('TOKEN_LIMIT',m.review_flags('またね','또',False))
        self.assertIn('JAPANESE_REMAINS',m.review_flags('またね','またね',True))
        self.assertNotIn('JAPANESE_REMAINS',m.review_flags('…','…',True))
        self.assertIn('PUNCTUATION_EXPANDED',m.review_flags('…','나한테 줘!',True))
        self.assertIn('REQUEST_BECAME_PROMISE',m.review_flags('手を洗って。','손 씻을게요.',True))
        self.assertIn('REQUEST_BECAME_PROMISE',m.review_flags('書いてください。','써 드릴게요.',True))
        self.assertNotIn('REQUEST_BECAME_PROMISE',m.review_flags('荷物を運んで。','짐을 옮겨 줘.',True))
        self.assertNotIn('REQUEST_BECAME_PROMISE',m.review_flags('明日持っていくよ。','내일 가져갈게.',True))
        self.assertNotIn('REQUEST_BECAME_PROMISE',m.review_flags('待って。私が行く。','기다려. 내가 갈게.',True))
        self.assertIn('KINSHIP_SUBJECT_CONFLICT',m.review_flags('姉が決めた。','남동생이 정했어.',True))
        self.assertIn('KINSHIP_SUBJECT_CONFLICT',m.review_flags('弟は眠っている。','남편이 자고 있어.',True))
        self.assertNotIn('KINSHIP_SUBJECT_CONFLICT',m.review_flags('妹は眠っている。','동생이 자고 있어.',True))
        self.assertNotIn('KINSHIP_SUBJECT_CONFLICT',m.review_flags('兄弟は来ない。','형이 안 와.',True))
        self.assertNotIn('KINSHIP_SUBJECT_CONFLICT',m.review_flags('義妹は休む。','처제가 쉰다.',True))
        self.assertNotIn('KINSHIP_SUBJECT_CONFLICT',m.review_flags('妹は兄と来た。','오빠가 동생과 왔어.',True))
        self.assertIn('MALFORMED_KOREAN_NEGATION',m.review_flags('高くない。','가격이 않아요.',True))
        self.assertNotIn('MALFORMED_KOREAN_NEGATION',m.review_flags('高くない。','비싸지 않아요.',True))
        self.assertIn('KINSHIP_RECIPIENT_CONFLICT',m.review_flags('妹に電話した。','오빠한테 전화했어.',True))
        self.assertIn('BENEFACTIVE_ACTOR_REVERSED',m.review_flags('友達に荷物を持ってもらった。','친구에게 짐을 들어 줬어.',True))
        self.assertNotIn('BENEFACTIVE_ACTOR_REVERSED',m.review_flags('先生に本を見せてもらった。','선생님이 나에게 책을 보여줬어.',True))
        self.assertNotIn('BENEFACTIVE_ACTOR_REVERSED',m.review_flags('友達に荷物を持ってもらった。','친구에게 짐을 들어 달라고 부탁했어.',True))
        self.assertIn('REPETITIVE_OUTPUT',m.review_flags('やめて。','하아 '*55,True))
        self.assertNotIn('REPETITIVE_OUTPUT',m.review_flags('ハハハ！','하하하!',True))

    def test_empty_and_completed_pages_do_not_load_or_reinvoke_the_translator(self):
        spec=importlib.util.spec_from_file_location('local_mt',MODULE)
        m=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        class Stub:
            model=distribution=revision=settings='unit'
            def translate(self,lines):
                return [dict(id=lines[0]['id'],source=lines[0]['source'],ko='내일.',flags=[])]
        def unexpected_load():
            self.fail('cached or empty page loaded translator')
        with tempfile.TemporaryDirectory() as tmp:
            saved={'identity':'empty','result':{'page':'a','lines':[]}}
            self.assertEqual(m.translate_page(Path(tmp)/'a',saved,Stub,unexpected_load)['batchCount'],0)
            saved={'identity':'full','result':{'page':'b','lines':[dict(id='b1',source='明日。')]}}
            first=m.translate_page(Path(tmp)/'b',saved,Stub,Stub)
            self.assertEqual(first['batchCount'],1)
            self.assertEqual(first,m.translate_page(Path(tmp)/'b',saved,Stub,unexpected_load))


if __name__=='__main__':
    unittest.main()
