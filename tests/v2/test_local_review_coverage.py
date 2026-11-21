import io
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'scripts/v2/local_review'))
import ocr


def region(key, kind, x, y, w, h):
    return dict(id=key,kind=kind,confidence=.9,bbox=dict(x=x,y=y,width=w,height=h))


class CoverageTest(unittest.TestCase):
    def test_independent_high_resolution_tiles_are_bounded_and_report_the_unsearched_corner(self):
        image = Image.new('RGB', (1800, 1800), 'white')
        sizes = []

        def detect(view):
            sizes.append(view.size)
            if len(sizes) == 2:
                return [region('db-small', 'text_free', 600 / 1536, 500 / 1536, 15 / 1536, 30 / 1536),
                        region('db-cut', 'text_free', .99, .20, .01, .05)]
            if len(sizes) == 3:
                return [region('db-same', 'text_free', (600 - 264) / 1536, 500 / 1536, 15 / 1536, 30 / 1536)]
            return []

        observations, search = ocr.detect_independent_text(image, detect, max_tiles=3)
        combined, _ = ocr.crosscheck_text([], observations)
        selected, _ = ocr.select_regions(combined)

        self.assertEqual(sizes, [(1800, 1800)] + [(1536, 1536)] * 3)
        self.assertEqual(search, {'plannedTiles': 4, 'processedTiles': 3, 'unsearchedPixelBoxes': [[264, 264, 1800, 1800]]})
        self.assertEqual(len(selected), 1)
        self.assertAlmostEqual(selected[0]['bbox']['x'], 600 / 1800)
        self.assertAlmostEqual(selected[0]['bbox']['width'], 15 / 1800)

    def test_clear_two_panel_gutter_keeps_right_panel_together(self):
        image = Image.new('RGB', (160, 160), 'white')
        draw = ImageDraw.Draw(image)
        for bounds in [(5, 7, 69, 153), (91, 7, 155, 153)]:
            draw.rectangle(bounds, fill='#ddd', outline='black', width=2)
        observations = [
            region('right-top', 'text_bubble', .70, .16, .10, .04),
            region('right-bottom', 'text_bubble', .69, .40, .10, .04),
            region('left-top', 'text_bubble', .20, .23, .10, .04),
            region('left-bottom', 'text_bubble', .21, .44, .10, .04),
        ]
        stream = io.BytesIO()
        image.save(stream, format='PNG')
        detector = SimpleNamespace(detect=lambda _session, _image: observations)

        result = ocr.recognize(stream.getvalue(), {'id': 'test-page'}, None, detector, None,
                               lambda _crop: 'テスト', {})

        self.assertEqual([line['id'] for line in result['lines']],
                         ['right-top', 'right-bottom', 'left-top', 'left-bottom'])
        self.assertEqual({line['id']: line['bbox'] for line in result['lines']},
                         {line['id']: line['bbox'] for line in observations})

    def test_disjoint_columns_inside_a_coarse_detection_keep_distinct_ids(self):
        coarse = region('wide', 'text_bubble', .28, .17, .36, .52)
        tile = region('tile0-wide', 'text_bubble', .30, .19, .32, .48)
        right = region('right-line', 'text_free', .48, .23, .08, .39)
        left = region('left-line', 'text_free', .33, .28, .08, .21)
        right_duplicate = region('right-duplicate', 'text_free', .49, .24, .065, .33)
        right_duplicate['confidence'] = .8

        enriched, _ = ocr.crosscheck_text([coarse, tile], [right, left, right_duplicate])
        selected, _ = ocr.select_regions(enriched)

        self.assertCountEqual([row['id'] for row in selected], ['right-line', 'left-line'])
        self.assertTrue({'wide', 'tile0-wide'} <= {row['id'] for row in enriched})
        self.assertTrue(all(row['kind'] == 'text_bubble' for row in selected))
        self.assertNotIn('inkSupport', coarse)

    def test_duplicate_or_end_to_end_fragments_of_one_vertical_line_stay_one_crop(self):
        coarse = region('vertical', 'text_bubble', .50, .18, .10, .56)
        upper = region('upper-fragment', 'text_free', .51, .20, .08, .24)
        lower = region('lower-fragment', 'text_free', .51, .45, .08, .24)
        duplicate = region('same-upper', 'text_free', .52, .21, .06, .20)

        enriched, _ = ocr.crosscheck_text([coarse], [upper, lower, duplicate])
        selected, _ = ocr.select_regions(enriched)

        self.assertEqual([row['id'] for row in selected], ['vertical'])

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
