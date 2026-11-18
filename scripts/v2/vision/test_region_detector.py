"""Protocol/model-boundary tests. Real page quality is evaluated separately."""
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from PIL import Image

spec = importlib.util.spec_from_file_location("regions", Path(__file__).with_name("region_detector.py"))
regions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(regions)
MODEL=Path("E:/Dev/Models/MangohanaV2-vision/ogkalu-16e8a622/detector-v4-s_int8.onnx")

def png(width=16,height=16,animated=False):
    with io.BytesIO() as target:
        image=Image.new("RGB",(width,height),"white")
        image.save(target,format="PNG",save_all=animated,append_images=[Image.new("RGB",(width,height),"black")] if animated else [])
        return target.getvalue()

def request(data):
    return io.BytesIO(json.dumps({"version":1,"imagePngBase64":base64.b64encode(data).decode("ascii")}).encode("ascii")+b"\n")

class ProtocolTests(unittest.TestCase):
    def test_source_bytes_hash_is_preserved(self):
        data=png()
        image,digest=regions.read_request(request(data))
        self.assertEqual(image.size,(16,16))
        self.assertEqual(digest,hashlib.sha256(data).hexdigest())

    def test_duplicate_keys_cannot_replace_a_request_version(self):
        raw=request(png()).getvalue().replace(b'{"version": 1,',b'{"version": 0,"version": 1,')
        with self.assertRaisesRegex(ValueError,"DUPLICATE_JSON_KEY"):
            regions.read_request(io.BytesIO(raw))

    def test_unknown_fields_and_bool_version_are_not_accepted(self):
        raw=request(png()).getvalue()
        for bad in [raw.replace(b'"version": 1',b'"version": true'),raw.replace(b'{',b'{"model":"other",',1)]:
            with self.assertRaisesRegex(ValueError,"INVALID_REQUEST"):
                regions.read_request(io.BytesIO(bad))

    def test_animated_and_oversized_dimensions_are_rejected(self):
        for data in [png(animated=True),png(8001,1)]:
            with self.assertRaisesRegex(ValueError,"IMAGE_DIMENSIONS"):
                regions.read_request(request(data))

    def test_decoded_byte_bound_is_enforced(self):
        with patch.object(regions,"MAX_IMAGE_BYTES",1):
            with self.assertRaisesRegex(ValueError,"IMAGE_LIMIT"):
                regions.read_request(request(png()))

    def test_pinned_actual_weight_is_loaded_as_verified_bytes(self):
        data=regions.read_pinned_model(MODEL)
        self.assertEqual(len(data),11120765)
        self.assertEqual(hashlib.sha256(data).hexdigest(),regions.MODEL_SHA256)

    def test_different_weight_digest_and_alias_path_are_rejected(self):
        with patch.object(regions,"MODEL_SHA256","0"*64):
            with self.assertRaisesRegex(ValueError,"MODEL_CHECKSUM"):
                regions.read_pinned_model(MODEL)
        with self.assertRaisesRegex(ValueError,"MODEL_PATH"):
            regions.read_pinned_model(MODEL.with_name("different.onnx"))

if __name__ == "__main__":
    unittest.main()
