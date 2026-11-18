"""Invalid stdio/config tests only. This never executes an ONNX session."""
import base64
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from PIL import Image


def png(width=16,height=16,animated=False):
    with io.BytesIO() as target:
        Image.new("RGB",(width,height),"white").save(target,format="PNG",save_all=animated,append_images=[Image.new("RGB",(width,height),"black")] if animated else [])
        return target.getvalue()


def request(data=None,regions=None):
    return {"version":1,"imagePngBase64":base64.b64encode(png() if data is None else data).decode("ascii"),
            "regions":regions if regions is not None else [{"id":"a","bbox":{"x":.1,"y":.1,"width":.2,"height":.3}}]}


class InvalidProtocolTests(unittest.TestCase):
    def reject(self,value):
        helper=Path(__file__).with_name("v3_stdio.py")
        self.assertTrue(helper.is_file(),"BOUNDED_V3_STDIO_MISSING")
        raw=value if isinstance(value,bytes) else json.dumps(value).encode("ascii")+b"\n"
        # The absolute model argument deliberately does not exist. Valid protocol
        # can therefore only test a configuration failure, never model execution.
        model=helper.parent/"nonexistent-model-directory"/"comic-text-mask-unet-resnet18-384.onnx"
        result=subprocess.run([sys.executable,"-I","-B",str(helper),"--model",str(model)],input=raw,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                              timeout=20,env={"SystemRoot":os.environ.get("SystemRoot","C:/Windows"),"PATH":str(Path(sys.executable).parent)},creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
        self.assertEqual(result.returncode,1)
        self.assertLess(len(result.stderr),65536)
        self.assertLess(len(result.stdout),256)
        self.assertEqual(result.stdout.count(b"\n"),1)
        self.assertEqual(json.loads(result.stdout),{"version":1,"ok":False,"error":"TEXT_MASK_FAILED"})

    def test_missing_and_duplicate_fields_are_rejected(self):
        self.reject(b"{}\n")
        value=json.dumps(request()).encode("ascii")
        self.reject(value.replace(b'{"version": 1,',b'{"version": 0,"version": 1,',1)+b"\n")

    def test_bool_version_and_user_model_field_are_rejected(self):
        value=request();value["version"]=True;self.reject(value)
        value=request();value["model"]="unowned";self.reject(value)

    def test_empty_duplicate_or_outside_regions_are_rejected(self):
        self.reject(request(regions=[]))
        value=request();value["regions"]*=2;self.reject(value)
        value=request();value["regions"][0]["bbox"]["width"]=1;self.reject(value)

    def test_animation_oversized_sides_and_non_png_are_rejected(self):
        self.reject(request(data=png(animated=True)))
        self.reject(request(data=png(8001,1)))
        self.reject(request(data=b"not a png"))

    def test_valid_protocol_with_missing_model_is_a_failure_not_a_fake_success(self):
        self.reject(request())


if __name__=="__main__":unittest.main()
