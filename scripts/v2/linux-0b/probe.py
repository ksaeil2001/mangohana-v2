"""Observe the pinned product workers inside the one-page verification container."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import runpy
import stat
import sys
import time


REPO = Path(__file__).resolve().parents[3]
LOCAL = REPO / "scripts/v2/local_review"
TRIO = REPO / "packages/ai-engine/vendor/trio"
WORK = Path("/work")
INPUT = Path("/input")
MODELS = INPUT / "models"
QWEN = MODELS / "MangohanaV2-semantic/qwen3-4b-instruct-onnx-41a4dd4d"
SENTENCE = "駅で待ってるよ。"
CPU = "CPUExecutionProvider"
QWEN_TOTAL_TOKEN_LIMIT = 1536

FILE_GRAPHS = {
    "vision_fp16.onnx": "baberu_vision",
    "decoder_prefill_int8.onnx": "baberu_prefill",
    "decoder_step_int8.onnx": "baberu_step",
    "model_q4.onnx": "qwen",
    "lama_fp32.onnx": "lama",
}
BYTE_GRAPHS = {
    "5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79": "rtdetr",
    "d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9": "ppocrv4",
}
OCR_GRAPHS = {"rtdetr", "ppocrv4", "baberu_vision", "baberu_prefill", "baberu_step"}


def phase(event, **data):
    target = Path(os.environ["TEMP"]).resolve()
    if not target.is_relative_to(WORK / "evidence"):
        raise ValueError("invalid phase log directory")
    with (target / "model-events.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"phase": event, "monotonicNs": time.monotonic_ns(), **data}) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def failure_kind(error, default="MODEL_ERROR"):
    message = str(error).lower()
    if isinstance(error, MemoryError) or any(phrase in message for phrase in (
        "std::bad_alloc", "failed to allocate memory", "out of memory",
        "failed to allocate buffer", "not enough memory",
    )):
        return "MEMORY_ALLOCATION_FAILED"
    if isinstance(error, ImportError):
        return "RUNTIME_DEPENDENCY"
    if type(error).__name__ in {"InvalidGraph", "InvalidProtobuf", "NotImplemented", "InvalidArgument"} or any(
        phrase in message for phrase in (
            "could not find an implementation for", "not a registered function/op",
            "unsupported model ir version", "unexpected context model graph", "unexpected execution provider",
            "invalid_input_metadata", "invalid_output_metadata",
        )
    ):
        return "MODEL_COMPATIBILITY"
    return default


def observe_assets(original, model):
    def verified(*args, **kwargs):
        start = time.monotonic()
        phase("asset_check_start", model=model)
        try:
            result = original(*args, **kwargs)
        except Exception as error:
            phase("asset_check_error", model=model, failure=failure_kind(error, "ARTIFACT_CHECK_FAILED"),
                  errorType=type(error).__name__)
            raise
        phase("asset_check_ok", model=model, seconds=time.monotonic() - start)
        return result
    return verified


def observe_compute(original, model, output_check=None):
    def computed(*args, **kwargs):
        start = time.monotonic()
        try:
            result = original(*args, **kwargs)
        except Exception as error:
            phase("model_error", model=model, failure=failure_kind(error), errorType=type(error).__name__)
            raise
        phase("model_complete", model=model, seconds=time.monotonic() - start)
        if output_check is not None:
            phase("output_ok" if output_check(result) else "output_invalid", model=model)
        return result
    return computed


def observe_sessions(allowed):
    import onnxruntime as ort

    if ort.__version__ != "1.23.2" or CPU not in ort.get_available_providers():
        raise ImportError("unexpected CPU runtime")
    original_init = ort.InferenceSession.__init__
    original_run = ort.InferenceSession.run
    counts = {}

    def init(session, model, *args, **kwargs):
        graph = (BYTE_GRAPHS.get(hashlib.sha256(model).hexdigest()) if isinstance(model, bytes)
                 else FILE_GRAPHS.get(Path(model).name))
        if graph not in allowed or graph in counts:
            raise ValueError("unexpected or repeated ONNX session")
        counts[graph] = 0
        session.probe_graph = graph
        start = time.monotonic()
        phase("load_start", graph=graph)
        try:
            original_init(session, model, *args, **kwargs)
            if session.get_providers() != [CPU]:
                raise ValueError("unexpected execution provider")
        except Exception as error:
            phase("load_error", graph=graph, failure=failure_kind(error), errorType=type(error).__name__)
            raise
        phase("load_ok", graph=graph, provider=CPU, seconds=time.monotonic() - start)

    def run(session, *args, **kwargs):
        graph = session.probe_graph
        if not counts[graph]:
            phase("compute_start", graph=graph)
        start = time.monotonic()
        try:
            data = original_run(session, *args, **kwargs)
        except Exception as error:
            phase("compute_error", graph=graph, failure=failure_kind(error), errorType=type(error).__name__)
            raise
        counts[graph] += 1
        if counts[graph] == 1:
            phase("compute_ok", graph=graph, firstRunSeconds=time.monotonic() - start)
        return data

    ort.InferenceSession.__init__ = init
    ort.InferenceSession.run = run
    return counts


def observe_ocr():
    sys.path.insert(0, str(LOCAL))
    import ocr
    from text_detector import TextDetector

    load_module = ocr.module

    def module(name, path):
        loaded = load_module(name, path)
        if name == "region_detector":
            loaded.detect = observe_compute(loaded.detect, "rtdetr", lambda value: isinstance(value, list))
        elif name == "approved_onnx_recognizer":
            native = loaded.BaberuOnnxOCR
            native.__call__ = observe_compute(native.__call__, "baberu", lambda value: isinstance(value, str) and bool(value.strip()))
        return loaded

    ocr.module = module
    TextDetector.__call__ = observe_compute(TextDetector.__call__, "ppocrv4", lambda value: isinstance(value, list))


def observe_qwen():
    sys.path.insert(0, str(LOCAL))
    import context_translation as translation

    translation.verify_assets = observe_assets(translation.verify_assets, "qwen")
    observed = observe_compute(translation.PageTranslator.generate, "qwen")

    def generate(instance, ids, limit):
        budget = qwen_generation_budget(len(ids), limit)
        phase("generation_budget", model="qwen", budget=budget)
        if not ids or budget["generationLimit"] <= 0:
            phase("model_error", model="qwen", failure="QWEN_TOKEN_LIMIT")
            raise ValueError("QWEN_TOKEN_LIMIT")
        return observed(instance, ids, budget["generationLimit"])

    translation.PageTranslator.generate = generate


def product_stage(stage):
    counts = observe_sessions(OCR_GRAPHS if stage == "ocr" else {"qwen"})
    if stage == "ocr":
        observe_ocr()
    else:
        observe_qwen()
    product = LOCAL / "product_onnx.py"
    sys.argv = [str(product), stage, str(MODELS)]
    try:
        runpy.run_path(str(product), run_name="__main__")
    except Exception as error:
        phase("worker_error", failure=failure_kind(error), errorType=type(error).__name__)
        raise
    finally:
        phase("compute_counts", counts=counts)


def lama_worker():
    counts = observe_sessions({"lama"})
    original_spec = importlib.util.spec_from_file_location
    approved = TRIO / "resources/managed-inpainting/lama_onnx.py"

    def worker_spec(name, location, *args, **kwargs):
        spec = original_spec(name, location, *args, **kwargs)
        if name == "existing_local_lama_worker" and Path(location).resolve() == approved:
            execute = spec.loader.exec_module

            def observed(module):
                execute(module)
                module.verify_model = observe_assets(module.verify_model, "lama")
                module.process_tiles = observe_compute(module.process_tiles, "lama")

            spec.loader.exec_module = observed
        return spec

    importlib.util.spec_from_file_location = worker_spec
    wrapper = TRIO / "scripts/local-preview/lama_worker.py"
    sys.argv[0] = str(wrapper)
    try:
        runpy.run_path(str(wrapper), run_name="__main__")
    finally:
        phase("compute_counts", counts=counts)


def no_model_sessions():
    import onnxruntime as ort

    def reject(*args, **kwargs):
        raise RuntimeError("model construction in preparation")

    ort.InferenceSession.__init__ = reject
    return ort


def tokenizer():
    deps = QWEN / "tokenizer-deps"
    sys.path.insert(0, str(deps))
    import tokenizers

    if tokenizers.__version__ != "0.22.2" or not Path(tokenizers.__file__).resolve().is_relative_to(deps):
        raise ImportError("tokenizer does not match pinned dependency")
    return tokenizers.Tokenizer.from_file(str(QWEN / "tokenizer.json"))


def qwen_generation_budget(input_tokens, default_limit):
    return {
        "inputTokens": input_tokens,
        "defaultGenerationLimit": default_limit,
        "generationLimit": max(0, min(default_limit, QWEN_TOTAL_TOKEN_LIMIT - input_tokens)),
        "totalTokenLimit": QWEN_TOTAL_TOKEN_LIMIT,
    }


def budget():
    no_model_sessions()
    sys.path.insert(0, str(LOCAL))
    from context_translation import page_prompt

    request = json.load(sys.stdin)
    lines = request["lines"]
    ids = tokenizer().encode(page_prompt(lines, request["context"]), add_special_tokens=False).ids
    default_limit = min(4096, max(120, (len(ids) + 16 * len(lines)) * 2))
    print(json.dumps(qwen_generation_budget(len(ids), default_limit)))


def release_setup_cache(root, *, sync):
    files = total = 0
    for folder, _, names, directory in os.fwalk(root, follow_symlinks=False):
        for name in names:
            entry = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if not stat.S_ISREG(entry.st_mode):
                continue
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            try:
                current = os.fstat(fd)
                if not os.path.samestat(entry, current):
                    raise ValueError(f"setup file changed: {Path(folder).name}/{name}")
                if sync:
                    os.fdatasync(fd)
                os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
                files += 1
                total += current.st_size
            finally:
                os.close(fd)
    return {"files": files, "bytes": total}


def prepare():
    from PIL import Image, ImageDraw, ImageFont
    import cv2
    import numpy
    import platform
    import PIL

    ort = no_model_sessions()
    if (platform.machine(), sys.version_info[:2], ort.__version__, numpy.__version__, PIL.__version__, cv2.__version__) != (
        "x86_64", (3, 12), "1.23.2", "2.2.6", "12.1.0", "4.10.0",
    ) or CPU not in ort.get_available_providers():
        raise ImportError("unexpected Linux runtime versions")
    ids = tokenizer().encode(SENTENCE).ids
    if not ids:
        raise ValueError("empty tokenizer output")

    pack = Path(sys.executable).resolve().parent.parent
    spec = importlib.util.spec_from_file_location("approved", pack / "sidecar/trio_ocr_sidecar.py")
    sidecar = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(LOCAL))
    spec.loader.exec_module(sidecar)
    from ocr import load_ocr_models
    from text_detector import TextDetector

    if not all(callable(item) for item in (sidecar.BaberuOnnxOCR, load_ocr_models, TextDetector)):
        raise ImportError("OCR imports unavailable")

    image = Image.new("RGBA", (640, 480), "#b9c1c8")
    canvas = ImageDraw.Draw(image)
    for y in range(0, 480, 24):
        canvas.line((0, y, 639, y), fill="#a2adb6")
    canvas.ellipse((52, 104, 588, 344), fill="white", outline="#181818", width=4)
    font = ImageFont.truetype(str(INPUT / "canvas/japanese.ttc"), 36)
    if not all(font.getmask(char).getbbox() for char in SENTENCE):
        raise ValueError("synthetic input font failed")
    box = canvas.textbbox((320, 224), SENTENCE, font=font, anchor="mm")
    canvas.text((320, 224), SENTENCE, font=font, fill="#101010", anchor="mm")
    safe = [box[0] - 8, box[1] - 8, box[2] + 8, box[3] + 8]
    if not (110 < safe[0] < safe[2] < 530 and 175 < safe[1] < safe[3] < 275):
        raise ValueError("synthetic input is outside the bubble")
    mask = Image.new("RGBA", image.size, "white")
    ImageDraw.Draw(mask).rectangle((safe[0], safe[1], safe[2] - 1, safe[3] - 1), fill=(0, 0, 0, 0))
    out = WORK / "evidence"
    image.save(out / "original.png")
    with Image.open(out / "original.png") as original:
        normalized = original.convert("RGBA")
        if normalized.tobytes() != image.tobytes() or original.n_frames != 1:
            raise ValueError("synthetic frame changed")
        normalized.save(out / "normalized.png")
    mask.save(out / "standalone-mask.png")
    print(json.dumps({"width": 640, "height": 480, "sentence": SENTENCE, "inkBox": box, "standaloneBox": safe,
                      "python": platform.python_version(), "ort": ort.__version__, "providerAvailable": CPU,
                      "tokenizer": "0.22.2", "tokenizerProbeCount": len(ids)}))


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "--worker":
        lama_worker()
    elif command in {"ocr", "translate"} and len(sys.argv) == 2:
        product_stage(command)
    elif command == "prepare":
        prepare()
    elif command == "release-setup-cache":
        print(json.dumps({"runtime": release_setup_cache(WORK / "ocr-pack", sync=True),
                          "wheels": release_setup_cache(INPUT / "wheels", sync=False)}))
    elif command == "budget":
        budget()
    else:
        raise SystemExit("unsupported verification operation")
