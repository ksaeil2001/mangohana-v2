"""Pinned, offline, one-page RT-DETR region typing over stdio.

Input line: {"version":1,"imagePngBase64":"..."}.
Output: original normalized-PNG hash, bubble/text_bubble/text_free boxes,
model identity, CPU provider and measured times. This is not a pixel text mask.
No downloading, custom operators, image writes or OCR/translation occur here.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import stat
import sys
import time
import warnings

import numpy as np
import onnxruntime as ort
from PIL import Image

MODEL_ID = "ogkalu/comic-text-and-bubble-detector"
MODEL_REVISION = "16e8a622f91fabc6b5b65c96d32d1183f8843546"
MODEL_FILE = "detector-v4-s_int8.onnx"
MODEL_SIZE = 11120765
MODEL_SHA256 = "5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79"
# The server upload is 8MiB; its lossless normalized PNG may be larger.
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_REQUEST_BYTES = 4 * ((MAX_IMAGE_BYTES + 2) // 3) + 128
MAX_PIXELS = 12_000_000
MAX_SIDE = 8000
LABELS = {0: "bubble", 1: "text_bubble", 2: "text_free"}

def reject_constant(_value):
    raise ValueError("INVALID_JSON")

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result

def read_request(source):
    raw = source.readline(MAX_REQUEST_BYTES + 1)
    if not raw or len(raw) > MAX_REQUEST_BYTES:
        raise ValueError("REQUEST_LIMIT")
    request = json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
    if (not isinstance(request, dict) or set(request) != {"version", "imagePngBase64"}
            or type(request["version"]) is not int or request["version"] != 1):
        raise ValueError("INVALID_REQUEST")
    encoded = request["imagePngBase64"]
    if not isinstance(encoded, str) or not encoded or len(encoded) % 4 or len(encoded) > MAX_REQUEST_BYTES - 64:
        raise ValueError("IMAGE_LIMIT")
    data = base64.b64decode(encoded, validate=True)
    if not 0 < len(data) <= MAX_IMAGE_BYTES or base64.b64encode(data).decode("ascii") != encoded:
        raise ValueError("IMAGE_LIMIT")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        Image.MAX_IMAGE_PIXELS = MAX_PIXELS
        with Image.open(io.BytesIO(data), formats=["PNG"]) as image:
            width, height = image.size
            if (not 0 < width <= MAX_SIDE or not 0 < height <= MAX_SIDE or width * height > MAX_PIXELS
                    or getattr(image, "n_frames", 1) != 1):
                raise ValueError("IMAGE_DIMENSIONS")
            image.load()
            return image.convert("RGB"), hashlib.sha256(data).hexdigest()

def read_pinned_model(file):
    file = Path(file)
    if not file.is_absolute() or file.name != MODEL_FILE or os.path.normcase(str(file.resolve())) != os.path.normcase(os.path.abspath(file)):
        raise ValueError("MODEL_PATH")
    before = file.lstat()
    if not stat.S_ISREG(before.st_mode) or file.is_symlink() or before.st_size != MODEL_SIZE:
        raise ValueError("MODEL_SIZE")
    with file.open("rb") as source:
        opened = os.fstat(source.fileno())
        if (before.st_dev, before.st_ino, before.st_size) != (opened.st_dev, opened.st_ino, opened.st_size):
            raise ValueError("MODEL_CHANGED")
        data = source.read(MODEL_SIZE + 1)
        after = os.fstat(source.fileno())
    if (len(data) != MODEL_SIZE or hashlib.sha256(data).hexdigest() != MODEL_SHA256
            or (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
        raise ValueError("MODEL_CHECKSUM")
    # ORT receives these exact verified bytes, never a path reopened later.
    return data

def create_session(model_bytes):
    ort.disable_telemetry_events()
    options = ort.SessionOptions()
    options.log_severity_level = 3
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    session = ort.InferenceSession(model_bytes, sess_options=options, providers=["CPUExecutionProvider"])
    session.disable_fallback()
    inputs, outputs = session.get_inputs(), session.get_outputs()
    if (session.get_providers() != ["CPUExecutionProvider"] or len(inputs) != 2
            or [(item.name, item.type) for item in inputs] != [("images", "tensor(float)"), ("orig_target_sizes", "tensor(int64)")]
            or inputs[0].shape[1:] != [3,640,640]
            or [(item.name, item.type) for item in outputs] != [("labels", "tensor(int64)"), ("boxes", "tensor(float)"), ("scores", "tensor(float)")]):
        raise ValueError("MODEL_METADATA")
    return session

def detect(session, image):
    width, height = image.size
    resized = image.resize((640,640), Image.Resampling.BICUBIC)
    tensor = np.transpose(np.asarray(resized,dtype=np.float32)/255.0,(2,0,1))[None]
    labels, boxes, scores = session.run(None, {"images":tensor, "orig_target_sizes":np.array([[width,height]],dtype=np.int64)})
    if (labels.shape != (1,300) or boxes.shape != (1,300,4) or scores.shape != (1,300)
            or not np.isfinite(boxes).all() or not np.isfinite(scores).all()
            or np.any(scores < 0) or np.any(scores > 1) or not np.isin(labels,[0,1,2]).all()):
        raise ValueError("MODEL_OUTPUT")
    regions = []
    for index,(label,box,score) in enumerate(zip(labels[0],boxes[0],scores[0])):
        if float(score) < .3:
            continue
        x1,y1,x2,y2 = map(float,box)
        x1,y1,x2,y2 = max(0,x1),max(0,y1),min(width,x2),min(height,y2)
        if x1>=x2 or y1>=y2:
            continue
        regions.append({"id":f"region-{index:04d}", "kind":LABELS[int(label)], "confidence":float(score),
                        "bbox":{"x":x1/width,"y":y1/height,"width":(x2-x1)/width,"height":(y2-y1)/height}})
    return regions

def install_offline_guards():
    platform.system()
    def deny(event, _args):
        if event.startswith("socket.") or event in ("subprocess.Popen","os.system","os.posix_spawn","os.fork","os.exec"):
            raise RuntimeError("OFFLINE_ONLY")
    sys.addaudithook(deny)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    args = parser.parse_args()
    with os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0) as protocol:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        try:
            install_offline_guards()
            started = time.perf_counter()
            image, image_hash = read_request(sys.stdin.buffer)
            load_started = time.perf_counter()
            session = create_session(read_pinned_model(args.model))
            load_ms = (time.perf_counter()-load_started)*1000
            detect_started = time.perf_counter()
            regions = detect(session,image)
            response = {"version":1,"ok":True,"imageSha256":image_hash,"width":image.width,"height":image.height,
                        "model":{"id":MODEL_ID,"revision":MODEL_REVISION,"file":MODEL_FILE,"sha256":MODEL_SHA256},
                        "executionProvider":"CPUExecutionProvider","regions":regions,"maskKind":"REGION_BOXES_ONLY",
                        "measurements":{"modelLoadMs":load_ms,"inferenceMs":(time.perf_counter()-detect_started)*1000,"totalMs":(time.perf_counter()-started)*1000}}
        except Exception:
            response = {"version":1,"ok":False,"error":"REGION_DETECTION_FAILED"}
        protocol.write(json.dumps(response,ensure_ascii=True,separators=(",",":"),allow_nan=False).encode("ascii")+b"\n")
        protocol.flush()
        return 0 if response["ok"] else 1

if __name__ == "__main__":
    raise SystemExit(main())
