"""Product JSON bridge with fixed ports. No image decoder or inference session."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

script = Path(__file__).resolve().parents[2] / 'scripts/v2/local_review/product_onnx.py'
spec = importlib.util.spec_from_file_location('tested_product_bridge', script)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class ProductBridgeTest(unittest.TestCase):
    def exchange(self, stage, request, modules):
        raw = json.dumps(request, ensure_ascii=False).encode()
        output = io.BytesIO()
        with patch.dict(sys.modules, modules), patch.object(sys, 'argv', [str(script), stage, 'models']), \
                patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(raw))), \
                patch.object(sys, 'stdout', SimpleNamespace(buffer=output)):
            bridge.main()
        reply = json.loads(output.getvalue())
        self.assertEqual((reply['provider'], reply['stage'], reply['requestSha256']),
                         ('onnx-cpu', stage, hashlib.sha256(raw).hexdigest()))
        return reply['data']

    def test_normalized_ocr_uses_the_product_job_and_checks_its_bytes(self):
        recognized = Mock(return_value={'lines': []})
        ocr = SimpleNamespace(load_ocr_models=Mock(return_value=('ports',)), recognize=recognized)
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'frame'
            file.write_bytes(b'bound synthetic bytes')
            request = dict(jobId='page1', normalized=str(file), sourceSha256=hashlib.sha256(file.read_bytes()).hexdigest())
            self.assertEqual(self.exchange('ocr', request, {'ocr': ocr}), {'lines': []})
            recognized.assert_called_once_with(file.read_bytes(), {'id': 'page1'}, None, 'ports')
            with self.assertRaises(ValueError):
                self.exchange('ocr', {**request, 'sourceSha256': 'changed'}, {'ocr': ocr})
            self.assertEqual(recognized.call_count, 1)

    def test_translation_receipt_binds_context_and_a_pre_generation_failure(self):
        request = dict(lines=[dict(id='bubble', source='猫')], context={'revision': 2})
        port = Mock(revision='pinned', last_generation={'eos': True})
        port.translate.return_value = [{'id':'bubble','ko':'고양이'}]
        factory = Mock(return_value=port)
        modules = {'context_translation': SimpleNamespace(PageTranslator=factory)}
        reply = self.exchange('translate', request, modules)
        port.translate.assert_called_once_with(request['lines'], request['context'])
        self.assertEqual(reply['revision'], 'pinned')
        factory.side_effect = OSError('synthetic unavailable runtime')
        self.assertEqual(self.exchange('translate', request, modules),
                         dict(failure='TRANSLATION_PROVIDER_UNAVAILABLE', inferenceStarted=False))
        self.assertEqual(port.translate.call_count, 1)
