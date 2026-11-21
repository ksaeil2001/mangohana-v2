"""Single product job stage. The engine owns the normalized page and all persisted results."""
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))


def main():
    stage, models_arg = sys.argv[1:]
    models = Path(models_arg)
    raw = sys.stdin.buffer.read(256 * 1024 + 1)
    if len(raw) > 256 * 1024:
        raise ValueError('stage request exceeds limit')
    request = json.loads(raw)
    if stage == 'ocr':
        from ocr import load_ocr_models, recognize
        text_tile_limit = request.get('textTileLimit', 0)
        if type(text_tile_limit) is not int or not 0 <= text_tile_limit <= 16:
            raise ValueError('invalid independent text tile limit')
        source = Path(request['normalized']).read_bytes()
        if hashlib.sha256(source).hexdigest() != request['sourceSha256']:
            raise ValueError('normalized image identity changed')
        vision = models / 'MangohanaV2-vision'
        try:
            loaded = load_ocr_models(Path(sys.executable).parent.parent,
                vision / 'ogkalu-16e8a622/detector-v4-s_int8.onnx',
                vision / 'rapidocr-v4-5e7ff7a3/ch_PP-OCRv4_det_infer.onnx')
        except (ImportError, OSError, RuntimeError, ValueError):
            data = dict(failure='OCR_UNAVAILABLE', inferenceStarted=False)
        else:
            search = {'text_tile_limit': text_tile_limit} if text_tile_limit else {}
            data = recognize(source, {'id':request['jobId']}, None, *loaded, **search)
    elif stage == 'translate':
        from context_translation import PageInputLimit, PageTranslator, load_context_tokenizer, prepare_page_tokens
        root = models / 'MangohanaV2-semantic/qwen3-4b-instruct-onnx-41a4dd4d'
        try:
            tokenizer = load_context_tokenizer(root)
            ids = prepare_page_tokens(tokenizer, request['lines'], request['context'])
            model = PageTranslator(root, tokenizer=tokenizer)
        except PageInputLimit as error:
            data = dict(failure='TRANSLATION_INPUT_LIMIT', inferenceStarted=False, inputTokens=error.input_tokens)
        except (ImportError, OSError, RuntimeError, ValueError):
            data = dict(failure='TRANSLATION_PROVIDER_UNAVAILABLE', inferenceStarted=False)
        else:
            rows = model.translate_prepared(request['lines'], ids)
            data = dict(lines=rows, generation=model.last_generation, revision=model.revision)
    else:
        raise ValueError('unknown product stage')
    result = dict(provider='onnx-cpu', stage=stage, requestSha256=hashlib.sha256(raw).hexdigest(), data=data)
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False, allow_nan=False).encode('utf8'))


if __name__ == '__main__':
    main()
