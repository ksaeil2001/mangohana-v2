import importlib.util
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
FONT = ROOT / 'packages/ai-engine/vendor/trio/resources/font_ko_fallback/pretendard-1.3.9/PretendardVariable.ttf'


class TypesettingTest(unittest.TestCase):
    def test_single_vertical_dialogue_uses_its_own_balloon_space_only(self):
        source=[182,90,199,158]
        bubble=[45,50,315,200]
        spaces=self.render.layout_spaces(source,'text_bubble',[bubble],[],400,260)
        self.assertGreater(max(r-l for l,t,r,b in spaces),170)
        shared=self.render.layout_spaces(source,'text_bubble',[bubble],[[70,85,85,170]],400,260)
        self.assertEqual(len(shared),1)

    def test_balloon_letter_size_tracks_the_original_type(self):
        # Horizontal and vertical runs of the same print size should remain peers.
        for box in ([80,100,400,150],[80,100,130,420]):
            row=dict(kind='text_bubble',sourceCharacters=7,pixelBox=box)
            self.assertGreaterEqual(self.render.preferred_font_size(row,720,900),30)
        small=dict(kind='text_bubble',sourceCharacters=12,pixelBox=[10,10,106,22])
        self.assertLessEqual(self.render.preferred_font_size(small,720,900),16)
    def test_invalid_translation_preserves_legacy_unflagged_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp)
            source=Image.new('RGBA',(110,80),'white')
            source.save(base/'source.png')
            digest=hashlib.sha256((base/'source.png').read_bytes()).hexdigest()
            src=dict(id='a',source='来ないで。',kind='text_bubble',pixelBox=[10,12,48,40])
            ocr=dict(page='synthetic',width=110,height=80,lines=[src],detections=[],pngSha256=digest)
            mt=dict(page='synthetic',lines=[dict(id='a',source=src['source'],ko='가나다'*28,flags=[])])
            result=self.render.page_render(base,ocr,mt,SimpleNamespace(MODEL_SHA256='synthetic'),None,FONT)
            self.assertEqual(result['qualityStatus'],'NEEDS_ENGINE_WORK')
            self.assertEqual(result['rows'][0]['placement'],'untranslated')
            self.assertFalse((base/'review.png').exists())
            with Image.open(base/result['outputFile']) as out:
                np.testing.assert_array_equal(np.asarray(out),np.asarray(source))
    def setUp(self):
        file = ROOT / 'scripts/v2/local_review/render.py'
        self.assertTrue(file.exists(), 'local review compositor is missing')
        spec = importlib.util.spec_from_file_location('review_render', file)
        self.render = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.render)

    def test_layout_preserves_every_nonspace_character_and_fits(self):
        value = '반가워요. 오늘은 제가 설명할게요!'
        layout = self.render.fit_text(value, 108, 110, FONT, 28, 12)
        self.assertIsNotNone(layout)
        self.assertEqual(''.join(''.join(v.split()) for v in layout['rows']), ''.join(value.split()))
        self.assertLessEqual(layout['height'], 110)
        self.assertLessEqual(layout['width'], 108)
        self.assertIsNone(self.render.fit_text(value, 7, 3, FONT, 28, 12))

    def test_side_translation_keeps_entire_artwork_and_full_string(self):
        source = Image.new('RGBA', (480, 320), (21, 44, 65, 255))
        record = {'id':'a', 'number':1, 'target':'작은 취향도 존중해 주세요.', 'pixelBox':[10,20,30,60],
                  'flags':[], 'placement':'margin', 'reason':'LAYOUT'}
        result = self.render.add_margin(source, [record], FONT)
        self.assertGreater(result.width, source.width)
        np.testing.assert_array_equal(np.asarray(result)[:320,:480], np.asarray(source))
        self.assertEqual(''.join(record['marginRows']).replace(' ',''), record['target'].replace(' ',''))

    def test_other_ocr_boxes_are_protected(self):
        box = [25, 20, 60, 80]
        selection = np.zeros((100, 100), np.uint8)
        selection[35:45, 30:38] = 255
        self.assertTrue(self.render.intersects(selection, (0,0), [box]))
        self.assertFalse(self.render.intersects(selection, (100,110), [box]))

    def test_missing_character_inside_a_white_balloon_blocks_on_page_lettering(self):
        pixels = np.full((180,320,4),255,np.uint8)
        pixels[65:82,105:110,:3] = 20
        pixels[65:82,78:83,:3] = 35
        class PartialMask:
            def segment(self, session, rgb, regions):
                return (rgb[:,:,0] == 20).astype(np.uint8)*255, []
        fake_cv = SimpleNamespace(dilate=lambda a,k: np.asarray(Image.fromarray(a).filter(ImageFilter.MaxFilter(k.shape[0]))))
        saved = pixels.copy()
        row = dict(id='a',kind='text_bubble',pixelBox=[70,45,160,105],target='안녕.',flags=[])
        with patch.dict('sys.modules', {'cv2':fake_cv}):
            reason = self.render.place(pixels,np.zeros((180,320),bool),row,[],[],PartialMask(),None,FONT)
        self.assertEqual(reason,'PROTECT_ART_OR_REMAINING_INK')
        np.testing.assert_array_equal(pixels,saved)

    def test_only_border_connected_ink_away_from_independent_letters_is_protected_art(self):
        dark=np.zeros((80,100),bool)
        dark[1:70,13]=True
        dark[16:23,33:37]=True
        dark[30:45,50:54]=True
        support=[[44,25,61,52]]
        art=self.render.boundary_art(dark,(8,8,90,62),support,(0,0))
        self.assertTrue(art[35,13])
        self.assertFalse(art[18,34])
        self.assertFalse(art[35,52])
        dark[1:45,52]=True
        self.assertFalse(self.render.boundary_art(dark,(8,8,90,62),support,(0,0))[32,52])

    def test_page_receipt_and_png_preserve_unassigned_rgba(self):
        class FakeMask:
            MODEL_SHA256 = 'synthetic'

            def segment(self, session, rgb, regions):
                return (rgb[:,:,0] == 20).astype(np.uint8)*255, []

        # OpenCV's 5x5 dilation is the sole native dependency exercised here.
        fake_cv = SimpleNamespace(dilate=lambda a, k: np.asarray(Image.fromarray(a).filter(ImageFilter.MaxFilter(k.shape[0]))))
        for alpha, expected in ((255, 'page'), (64, 'margin')):
            with self.subTest(alpha=alpha), tempfile.TemporaryDirectory() as tmp, patch.dict('sys.modules', {'cv2':fake_cv}):
                folder = Path(tmp)
                pixels = np.full((260,400,4),255,np.uint8)
                pixels[91:112,131:139,:3] = 20
                pixels[95,133,3] = alpha
                Image.fromarray(pixels).save(folder/'source.png')
                dig = hashlib.sha256((folder/'source.png').read_bytes()).hexdigest()
                line = dict(id='a',source='空',pixelBox=[102,65,213,133])
                ocr = dict(width=400,height=260,page='synthetic',lines=[line],detections=[],pngSha256=dig)
                mt = dict(page='synthetic',lines=[dict(id='a',source='空',ko='하늘',flags=[])])
                receipt = self.render.page_render(folder,ocr,mt,FakeMask(),None,FONT)
                self.assertEqual(receipt['rows'][0]['placement'],expected)
                self.assertEqual(receipt['outsideEdits'],0)
                self.assertEqual(receipt['outputFile'],'diagnostic.png' if expected=='margin' else 'review.png')
                with Image.open(folder/receipt['outputFile']) as out:
                    actual = np.asarray(out)[:260,:400]
                np.testing.assert_array_equal(actual[:,:,3],pixels[:,:,3])
                if expected == 'margin':
                    np.testing.assert_array_equal(actual,pixels)
                else:
                    self.assertGreater(receipt['changedPixels'],0)
                    x,y,r,b = receipt['rows'][0]['layoutBox']
                    outside = np.ones((260,400),bool)
                    outside[y:b,x:r] = False
                    np.testing.assert_array_equal(actual[outside],pixels[outside])
