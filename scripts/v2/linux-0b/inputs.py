"""Copy only the pinned verification inputs into a private Linux staging directory."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
from zipfile import ZipFile


REPO = Path(__file__).resolve().parents[3]
TRIO = "packages/ai-engine/vendor/trio"
LOCAL = "scripts/v2/local_review"
DRIVER = "scripts/v2/linux-0b"
IMAGE = "sha256:193b31b5c23e74775a5dfc35d3474c9f73b314b8133646f9c9c74ea55b1da86d"
WHEEL = "tokenizers-0.22.2-cp39-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"
WHEEL_SHA256 = "369cc9fc8cc10cb24143873a0d95438bb8ee257bb80c71989e3ee290e8d72c67"
SECCOMP_SHA256 = "322b86b4f7f5b597ed6a9c2cfd6193a4b249a51c8bc9cfba8ff1a485070b24e8"
WHEELS_SHA256 = "b5ff35610b120df8cef4194cba19f43dac1ae30824695d82f2a80776a91b977d"
COPY_CHUNK = 4 * 1024 * 1024
CACHE_WRITE_WINDOW = 16 * 1024 * 1024
QWEN = "MangohanaV2-semantic/qwen3-4b-instruct-onnx-41a4dd4d"
OCR_PACK = "Managed/Trio/resources/pipeline-resources/trio-production-ocr-win32-x64/1.0.0"
OCR_MANIFEST_SHA256 = "c40f832a9b372dc2d45a529ab69d57c2dc45eefeb4d28d59e94a4e32619a15c0"
MODEL_FILES = {
    "MangohanaV2-vision/ogkalu-16e8a622/detector-v4-s_int8.onnx":
        "5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79",
    "MangohanaV2-vision/rapidocr-v4-5e7ff7a3/ch_PP-OCRv4_det_infer.onnx":
        "d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9",
    "lama_fp32.onnx": "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
}
OCR_FILES = {
    "recognizer/onnx/vision_fp16.onnx", "recognizer/onnx/decoder_prefill_int8.onnx",
    "recognizer/onnx/decoder_step_int8.onnx", "recognizer/tokenizer/vocab.json",
    "sidecar/trio_ocr_sidecar.py",
}
QWEN_FILES = {
    "config.json", "tokenizer.json", "tokenizer_config.json",
    "onnx/model_q4.onnx", "onnx/model_q4.onnx_data", "onnx/model_q4.onnx_data_1",
}
SOURCE_FILES = [
    "package.json",
    *(f"{DRIVER}/{file}" for file in ("attempt.mjs", "container.mjs", "canvas.mjs", "pipeline.mjs", "probe.py")),
    *(f"{LOCAL}/{file}" for file in (
        "context-model.json", "context_translation.py", "product_onnx.py", "ocr.py", "pages.py", "quality.py", "text_detector.py",
    )),
    "scripts/v2/vision/region_detector.py",
    *(f"packages/ai-engine/quality/{file}.cjs" for file in (
        "product-onnx", "translation-contract", "korean-output", "region-selection", "source-line-roi",
        "mask-evidence", "recovery-checkpoint", "ocr-environment",
    )),
    f"{TRIO}/src/shared/translation/translationQa.ts",
    f"{TRIO}/scripts/sites-local/engine-boundaries.cjs",
    f"{TRIO}/scripts/sites-local/lama-stdio.py",
    f"{TRIO}/scripts/local-preview/lama_http.py",
    f"{TRIO}/scripts/local-preview/lama_worker.py",
    f"{TRIO}/resources/managed-inpainting/lama_onnx.py",
]


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def digest_file(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def copy_checked(source, target, pin=None, size=None):
    entry = source.lstat()
    if not stat.S_ISREG(entry.st_mode) or size is not None and entry.st_size != size:
        raise ValueError(f"unexpected input type or size: {source.name}")
    target.parent.mkdir(parents=True, exist_ok=True)
    sha = hashlib.sha256()
    git = hashlib.sha1(f"blob {entry.st_size}\0".encode()) if pin and len(pin) == 40 else None
    with source.open("rb") as reader, target.open("xb") as writer:
        def identity(info):
            return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

        opened = os.fstat(reader.fileno())
        if identity(opened) != identity(entry):
            raise ValueError(f"source changed before copy: {source.name}")
        bound_cache = hasattr(os, "posix_fadvise") and hasattr(os, "fdatasync") and entry.st_size >= COPY_CHUNK
        synced = 0
        for chunk in iter(lambda: reader.read(COPY_CHUNK), b""):
            sha.update(chunk)
            if git is not None:
                git.update(chunk)
            writer.write(chunk)
            position = writer.tell()
            if bound_cache and (position - synced >= CACHE_WRITE_WINDOW or position == entry.st_size):
                # Release only clean pages of this private copy. Leave the source cache alone.
                writer.flush()
                os.fdatasync(writer.fileno())
                os.posix_fadvise(writer.fileno(), synced, position - synced, os.POSIX_FADV_DONTNEED)
                synced = position
        if identity(os.fstat(reader.fileno())) != identity(opened) or identity(source.lstat()) != identity(opened):
            raise ValueError(f"source changed during copy: {source.name}")
    actual_pin = git.hexdigest() if git is not None else sha.hexdigest()
    if pin is not None and actual_pin != pin:
        raise ValueError(f"checksum mismatch: {source.name}")
    target.chmod(0o444)
    return {"bytes": entry.st_size, "sha256": sha.hexdigest(), **({"pinnedIdentity": pin} if pin else {})}


def unpack_tokenizer(wheel, directory):
    if wheel.name != WHEEL or digest_file(wheel) != WHEEL_SHA256:
        raise ValueError("unexpected Linux tokenizers wheel")
    with ZipFile(wheel) as archive:
        for item in archive.infolist():
            name = item.filename
            parts = name.rstrip("/").split("/")
            if any(part in {"", ".", ".."} for part in parts) or "\\" in name or ":" in name or stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError("unsafe wheel member")
            target = directory.joinpath(*parts)
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(item) as reader, target.open("xb") as writer:
                shutil.copyfileobj(reader, writer)
            target.chmod(0o444)
    extension = directory / "tokenizers/tokenizers.abi3.so"
    if not extension.is_file() or not (directory / "tokenizers/__init__.py").is_file():
        raise ValueError("wheel lacks Linux CPython extension")


def stage_inputs(dst, args):
    pins = {}

    def include(src, relative, pin=None, size=None):
        pins[relative] = copy_checked(src, dst / relative, pin, size)

    include(args.seccomp, "seccomp.json", SECCOMP_SHA256)
    if args.wheel.name != WHEEL:
        raise ValueError("unexpected tokenizer wheel filename")
    include(args.wheel, f"download/{WHEEL}", WHEEL_SHA256)
    include(args.wheels / "SHA256SUMS", "wheels/SHA256SUMS", WHEELS_SHA256)
    include(args.renderer, "canvas/renderer.js", "e8fa4ab3cd3068b64f65e6df186dbc6355d9d8e9e22ebc4e1f146a893c104ad1")
    include(REPO / TRIO / "resources/font_ko_fallback/pretendard-1.3.9/PretendardVariable.ttf",
            "canvas/PretendardVariable.ttf", "3090ccde0442bb347aa7685d9ba8b17436a60682df6e8f92a9a670de14056e22")
    include(Path("/mnt/c/Windows/Fonts/msgothic.ttc"), "canvas/japanese.ttc")
    for relative in SOURCE_FILES:
        include(REPO / relative, f"repo/{relative}")
    for relative, pin in MODEL_FILES.items():
        include(args.models / relative, f"models/{relative}", pin)
    spec = read_json(dst / "repo" / LOCAL / "context-model.json")
    if spec["revision"] != "41a4dd4d147229f83043afb98a4d4c803b8bfcbb" or {row[0] for row in spec["files"]} != QWEN_FILES:
        raise ValueError("unexpected Qwen revision or file set")
    for relative, size, pin in spec["files"]:
        include(args.models / QWEN / relative, f"models/{QWEN}/{relative}", pin, size)

    pack = args.models / OCR_PACK
    include(pack / "resource-manifest.json", "ocr/resource-manifest.json", OCR_MANIFEST_SHA256)
    manifest = read_json(dst / "ocr/resource-manifest.json")
    required = {entry["relativePath"]: entry["sha256"] for entry in manifest["files"] if entry["relativePath"] in OCR_FILES}
    if required.keys() != OCR_FILES:
        raise ValueError("OCR manifest is missing required files")
    for relative, pin in required.items():
        include(pack / relative, f"ocr/{relative}", pin)

    unpack_tokenizer(dst / "download" / WHEEL, dst / "models" / QWEN / "tokenizer-deps")
    seen = set()
    for entry in (dst / "wheels/SHA256SUMS").read_text(encoding="ascii").splitlines():
        pin, file = entry.split()
        if file in seen or not re.fullmatch(r"[a-f0-9]{64}", pin) or not re.fullmatch(r"[a-zA-Z0-9_+.-]+\.whl", file):
            raise ValueError("invalid wheelhouse manifest")
        seen.add(file)
        include(args.wheels / file, f"wheels/{file}", pin)

    return pins
