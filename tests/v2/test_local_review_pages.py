import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[2] / 'scripts/v2/local_review/pages.py'


def source_module():
    if not MODULE.exists():
        return None
    spec = importlib.util.spec_from_file_location('review_pages', MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReviewPageTest(unittest.TestCase):
    def setUp(self):
        self.pages = source_module()
        self.assertTrue(hasattr(self.pages, 'once'), 'one-time per-page stage is missing')

    def test_finished_translation_is_reused_without_calling_again(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'translation.json'
            calls = []
            def translate():
                calls.append(1)
                return {'groups': [{'source': '夜', 'ko': '밤'}]}
            first = self.pages.once(target, 'a' * 64, translate)
            second = self.pages.once(target, 'a' * 64, translate)
            self.assertEqual(first, second)
            self.assertEqual(calls, [1])
            with self.assertRaises(ValueError):
                self.pages.once(target, 'b' * 64, translate)

    def test_interrupted_model_call_is_not_retried(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'translation.json'
            with self.assertRaisesRegex(ValueError, 'interrupted'):
                self.pages.once(target, 'a' * 64, lambda: (_ for _ in ()).throw(ValueError('interrupted')))
            with self.assertRaisesRegex(RuntimeError, 'already claimed'):
                self.pages.once(target, 'a' * 64, lambda: self.fail('duplicate inference'))

    def test_source_manifest_disallows_references_and_escaping_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'originals'
            root.mkdir()
            (root / 'one.webp').write_bytes(b'')
            manifest = Path(tmp) / 'manifest.json'
            row = {'id': 'work-001','work': 'work','index':1,'source':'one.webp'}
            manifest.write_text(json.dumps([row]), encoding='utf8')
            self.assertEqual(self.pages.load_pages(manifest, root)[0]['path'], root / 'one.webp')
            for bad in [dict(row, source='../expert.webp'), dict(row, expert='one.webp')]:
                manifest.write_text(json.dumps([bad]), encoding='utf8')
                with self.assertRaises(ValueError):
                    self.pages.load_pages(manifest, root)

    def test_same_ink_region_read_once_and_competing_boxes_stay_visible(self):
        def box(i, kind, x, score):
            return {'id': i, 'kind':kind, 'confidence':score,
                    'bbox':{'x':x,'y':.15,'width':.13,'height':.19}}
        boxes = [box('bubble','bubble',.12,.99), box('b','text_bubble',.12,.92),
                 box('duplicate','text_free',.121,.64),box('caption','text_free',.72,.8)]
        selected, duplicates = self.pages.select_regions(boxes)
        self.assertEqual({r['id'] for r in selected}, {'b','caption'})
        self.assertEqual(duplicates, ['duplicate'])

    def test_tiled_fragment_does_not_duplicate_a_known_region(self):
        def rec(key,x,y,w,h,score):
            return dict(id=key,kind='text_bubble',confidence=score,bbox=dict(x=x,y=y,width=w,height=h))
        full=rec('region-1',.2,.2,.2,.2,.86)
        small=rec('tile1-region-3',.24,.23,.11,.12,.94)
        neighbour=rec('tile1-region-4',.43,.2,.05,.1,.9)
        kept,skipped=self.pages.select_regions([full,small,neighbour])
        self.assertEqual({b['id'] for b in kept},{full['id'],neighbour['id']})
        self.assertIn(small['id'],skipped)

if __name__ == '__main__':
    unittest.main()
