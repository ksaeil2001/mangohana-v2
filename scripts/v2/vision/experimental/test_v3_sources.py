"""Source pin, parser, and offline guards only: no ONNX/LaMa execution."""
import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import unittest
import uuid
from PIL import Image

spec=importlib.util.spec_from_file_location("v3stdio",Path(__file__).with_name("v3_stdio.py"))
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)


def request():
    with io.BytesIO() as out:
        Image.new("RGB",(16,16),"white").save(out,format="PNG");data=out.getvalue()
    value={"version":1,"imagePngBase64":base64.b64encode(data).decode("ascii"),"regions":[{"id":"second","bbox":{"x":.2,"y":.2,"width":.2,"height":.2}},{"id":"first","bbox":{"x":.6,"y":.6,"width":.2,"height":.2}}]}
    return data,value


class SourcesAndParserTests(unittest.TestCase):
    def test_stdlib_envelope_preflight_rejects_unowned_fields_before_native_import(self):
        self.assertTrue(callable(getattr(worker,"read_envelope",None)),"EARLY_PREFLIGHT_NOT_IMPLEMENTED")
        _,value=request();raw=json.dumps(value).encode("ascii")+b"\n"
        self.assertEqual(worker.read_envelope(io.BytesIO(raw)),raw)
        value["model"]="unowned"
        with self.assertRaisesRegex(ValueError,"INVALID_REQUEST"):
            worker.read_envelope(io.BytesIO(json.dumps(value).encode("ascii")+b"\n"))

    def test_pinned_sources_and_input_parser_preserve_exact_image_digest_and_id_order(self):
        base,post=worker.load_sources();data,value=request()
        pixels,digest,regions=worker.read_input(base,post,io.BytesIO(json.dumps(value).encode("ascii")+b"\n"))
        self.assertEqual(pixels.shape,(16,16,3));self.assertEqual(digest,hashlib.sha256(data).hexdigest())
        self.assertEqual([r["id"] for r in regions],["second","first"])
        self.assertEqual(post.ALGORITHM,"source-ink-radial-halo-v3-experimental")

    def test_parser_rejections_are_verified_before_any_model_loading(self):
        base,post=worker.load_sources();data,value=request()
        raw=json.dumps(value).encode("ascii")+b"\n"
        for invalid,reason in [(raw+b"{}\n","MULTIPLE_REQUESTS"),
                               (raw.replace(b'"version": 1',b'"version": true'),"INVALID_REQUEST"),
                               (raw.replace(b'{"version": 1,',b'{"version": 0,"version": 1,',1),"DUPLICATE_JSON_KEY")]:
            with self.assertRaisesRegex(ValueError,reason):worker.read_input(base,post,io.BytesIO(invalid))
        base.MAX_IMAGE_BYTES=1
        with self.assertRaisesRegex(ValueError,"IMAGE_LIMIT"):worker.read_input(base,post,io.BytesIO(raw))

    def test_different_local_source_digest_is_rejected_without_executing_it(self):
        with self.assertRaisesRegex(ValueError,"SOURCE_PIN"):
            worker.load_pinned("untrusted",Path(__file__).with_name("v3_postprocess.py"),"0"*64)

    def test_offline_guard_allows_reviewed_source_import_in_a_fresh_process_without_a_model(self):
        code=("import importlib.util,json,sys;from pathlib import Path;"
              "p=Path(sys.argv[1]);s=importlib.util.spec_from_file_location('w',p);w=importlib.util.module_from_spec(s);s.loader.exec_module(w);"
              "w.install_offline_guards();b,k=w.load_sources();"
              "print(json.dumps({'scope':'SOURCE_IMPORT_ONLY_NO_MODEL_EXECUTION','modelSha256':b.MODEL_SHA256,'algorithm':k.ALGORITHM}))")
        result=subprocess.run([sys.executable,"-I","-B","-c",code,str(Path(__file__).with_name("v3_stdio.py"))],stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                              timeout=20,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
        self.assertEqual(result.returncode,0,result.stderr.decode("utf-8",errors="replace")[:1000])
        record=json.loads(result.stdout)
        self.assertEqual(record["scope"],"SOURCE_IMPORT_ONLY_NO_MODEL_EXECUTION")
        self.assertEqual(record["modelSha256"],"b10356a2a12f4dec4650e563724932e542764dbd3201a7e4cae6573597c5bea1")

    def test_z_offline_guard_blocks_socket_children_and_writable_file_opens(self):
        worker.install_offline_guards()
        with self.assertRaisesRegex(RuntimeError,"OFFLINE_ONLY"):socket.socket()
        with self.assertRaisesRegex(RuntimeError,"OFFLINE_ONLY"):
            subprocess.Popen([sys.executable,"-c","raise SystemExit(0)"],creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
        target=Path(__file__).with_name("must-not-exist-"+str(uuid.uuid4())+".txt")
        with self.assertRaisesRegex(RuntimeError,"READ_ONLY_WORKER"):target.open("wb")
        self.assertFalse(target.exists())


if __name__=="__main__":unittest.main()
