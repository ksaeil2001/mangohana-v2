"""Independent mask guards; real-page inference is verified separately."""
import importlib.util
import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image


class MaskGuardTests(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).with_name("text_mask.py")
        self.assertTrue(path.is_file(), "MISSING_PINNED_TEXT_MASK_HELPER")
        spec = importlib.util.spec_from_file_location("text_mask", path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_crop_edge_art_is_removed_and_interior_glyph_is_preserved(self):
        # A crop contains an image/bubble stroke reaching its edge and a letter.
        mask = np.zeros((100, 60), np.uint8)
        mask[40:90, 0:3] = 255
        mask[30:45, 25:30] = 255
        guarded, stats = self.module.guard_crop_mask(mask)
        self.assertEqual(int(guarded[:, :3].sum()), 0)
        self.assertTrue(np.array_equal(guarded[30:45, 25:30], mask[30:45, 25:30]))
        self.assertEqual(stats["droppedEdgePixels"], 150)

    def test_fine_mask_halo_is_dilated_without_filling_the_rectangle(self):
        mask = np.zeros((100, 60), np.uint8)
        mask[40:50, 25:30] = 255
        guarded, stats = self.module.guard_crop_mask(mask)
        self.assertGreater(int(np.count_nonzero(guarded)), 50)
        self.assertLess(int(np.count_nonzero(guarded)), 300)
        self.assertFalse(guarded[0].any())
        self.assertEqual(stats["droppedEdgePixels"], 0)

    def test_no_foreground_is_not_reported_as_a_successful_mask(self):
        with self.assertRaisesRegex(ValueError, "EMPTY_TEXT_MASK"):
            self.module.guard_crop_mask(np.zeros((100, 60), np.uint8))

    def test_mask_png_digest_matches_the_decoded_exact_bytes(self):
        self.assertTrue(callable(getattr(self.module, "png_payload", None)), "MASK_DIGEST_NOT_IMPLEMENTED")
        encoded, digest = self.module.png_payload(np.zeros((10, 20), np.uint8))
        data = base64.b64decode(encoded, validate=True)
        self.assertEqual(digest, hashlib.sha256(data).hexdigest())
        with Image.open(io.BytesIO(data)) as image:
            self.assertEqual(image.size, (20, 10))
            self.assertEqual(image.mode, "L")

    def test_bbox_identity_and_bounds_cannot_silently_change(self):
        good = {"id": "region-0001", "bbox": {"x": .1, "y": .1, "width": .2, "height": .3}}
        self.assertEqual(self.module.validate_regions([good])[0], good)
        for bad in [
            [good, good],
            [{**good, "path": "C:/other.png"}],
            [{**good, "bbox": {"x": .9, "y": .1, "width": .2, "height": .3}}],
            [{**good, "bbox": {"x": True, "y": .1, "width": .2, "height": .3}}],
            [],
        ]:
            with self.assertRaises(ValueError):
                self.module.validate_regions(bad)

    def test_context_consensus_preserves_glyph_attached_to_an_edge_in_one_context(self):
        self.assertTrue(callable(getattr(self.module, "combine_contexts", None)), "CONTEXT_CONSENSUS_NOT_IMPLEMENTED")
        first=np.zeros((100,60),np.uint8)
        first[15:30,20:30]=255
        first[20:23,:21]=255
        second=np.zeros_like(first)
        second[15:30,20:30]=255
        combined,stats=self.module.combine_contexts(first,second,(10,10,50,90))
        self.assertTrue((combined[15:30,20:30]==255).all())
        self.assertFalse(combined[:,:8].any())
        self.assertGreater(stats["contextDisagreementPixels"],0)

    def test_consensus_cannot_remove_pixels_outside_original_bbox_plus_two_pixels(self):
        self.assertTrue(callable(getattr(self.module, "combine_contexts", None)), "CONTEXT_CONSENSUS_NOT_IMPLEMENTED")
        mask=np.full((100,60),255,np.uint8)
        combined,stats=self.module.combine_contexts(mask,mask,(20,30,40,70))
        expected=np.zeros_like(mask)
        expected[28:72,18:42]=255
        self.assertTrue(np.array_equal(combined,expected))
        self.assertGreater(stats["clippedEnvelopePixels"],0)
        self.assertIn("pixelsOutsideEnvelope",stats)
        self.assertEqual(stats["pixelsOutsideEnvelope"],0)

    def test_a_region_without_consensus_is_a_failure_instead_of_empty_success(self):
        self.assertTrue(callable(getattr(self.module, "combine_contexts", None)), "CONTEXT_CONSENSUS_NOT_IMPLEMENTED")
        first=np.zeros((100,60),np.uint8)
        second=np.zeros_like(first)
        first[10:20,10:20]=255
        second[50:60,30:40]=255
        with self.assertRaisesRegex(ValueError,"EMPTY_TEXT_MASK"):
            self.module.combine_contexts(first,second,(0,0,60,100))

    def test_png_source_identity_and_duplicate_json_are_checked(self):
        with io.BytesIO() as target:
            Image.new("RGB",(20,10),"white").save(target,format="PNG")
            data=target.getvalue()
        request={"version":1,"imagePngBase64":base64.b64encode(data).decode("ascii"),
                 "regions":[{"id":"r1","bbox":{"x":.1,"y":.1,"width":.2,"height":.3}}]}
        raw=json.dumps(request).encode("ascii")+b"\n"
        pixels,digest,regions=self.module.read_request(io.BytesIO(raw))
        self.assertEqual(pixels.shape,(10,20,3))
        self.assertEqual(digest,hashlib.sha256(data).hexdigest())
        self.assertEqual(regions,request["regions"])
        with self.assertRaisesRegex(ValueError,"DUPLICATE_JSON_KEY"):
            self.module.read_request(io.BytesIO(raw.replace(b'{"version": 1,',b'{"version": 0,"version": 1,',1)))

    def test_a_request_cannot_choose_a_different_model_or_use_a_bool_version(self):
        for raw in [b'{"version":true,"imagePngBase64":"AA==","regions":[]}',
                    b'{"version":1,"imagePngBase64":"AA==","regions":[],"model":"other"}']:
            with self.assertRaisesRegex(ValueError,"INVALID_REQUEST"):
                self.module.read_request(io.BytesIO(raw))

    def test_the_actual_onnx_is_loaded_as_pinned_exact_bytes(self):
        model=Path("E:/Dev/Models/MangohanaV2-vision/text-mask-onnx-20261110T203802715Z/comic-text-mask-unet-resnet18-384.onnx")
        data=self.module.read_pinned_model(model)
        self.assertEqual(len(data),57314489)
        self.assertEqual(hashlib.sha256(data).hexdigest(),self.module.MODEL_SHA256)

    def test_changed_model_pin_or_alias_path_cannot_be_loaded(self):
        model=Path("E:/Dev/Models/MangohanaV2-vision/text-mask-onnx-20261110T203802715Z/comic-text-mask-unet-resnet18-384.onnx")
        with patch.object(self.module,"MODEL_SHA256","0"*64):
            with self.assertRaisesRegex(ValueError,"MODEL_CHECKSUM"):
                self.module.read_pinned_model(model)
        with self.assertRaisesRegex(ValueError,"MODEL_PATH"):
            self.module.read_pinned_model(model.with_name("different.onnx"))


if __name__ == "__main__":
    unittest.main()
