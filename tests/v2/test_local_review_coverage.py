import sys
from pathlib import Path
import unittest

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'scripts/v2/local_review'))
import ocr


def region(key, kind, x, y, w, h):
    return dict(id=key,kind=kind,confidence=.9,bbox=dict(x=x,y=y,width=w,height=h))


class CoverageTest(unittest.TestCase):
    def test_large_page_with_one_hit_still_recovers_small_text_from_a_tile(self):
        original=Image.new('RGB',(1600,2000))
        calls=[]
        def detect(_,image):
            calls.append(image.size)
            if image.size==original.size:return [region('global','text_bubble',.2,.2,.1,.1)]
            if len(calls)==5:return [region('small','text_bubble',.5,.5,.1,.1)]
            return []
        observations,views=ocr.detect_page(original,detect,None)
        self.assertEqual(views,len(calls))
        self.assertEqual(views,5)
        self.assertEqual(len(ocr.select_regions(observations)[0]),2)

    def test_independent_detector_adds_uncovered_text_once_and_records_empty_bubble(self):
        bubbles=[region('a','bubble',.1,.1,.3,.4),region('b','bubble',.65,.12,.28,.4)]
        main=[*bubbles,region('line','text_bubble',.15,.15,.1,.2)]
        secondary=[region('contained','text_free',.165,.18,.05,.1),
                   region('new','text_free',.29,.25,.05,.12)]
        enriched,missing=ocr.crosscheck_text(main,secondary)
        selected,_=ocr.select_regions(enriched)
        self.assertEqual({r['id'] for r in selected},{'line','new'})
        self.assertEqual(next(r for r in selected if r['id']=='new')['kind'],'text_bubble')
        self.assertEqual(next(r for r in selected if r['id']=='line')['inkSupport'],[secondary[0]['bbox']])
        self.assertEqual(missing,['b'])
