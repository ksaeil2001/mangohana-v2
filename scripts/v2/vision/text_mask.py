"""Pinned local learned glyph mask, one normalized PNG and server-chosen boxes.

Rectangles choose crops only. Foreground comes from an MIT Unet/ResNet18
segmentation model, two-context consensus, and a 2px halo inside bbox+2px.
This helper never downloads, writes images, executes remote code or inpaints.
The result is an evaluation candidate that always requires quality review.
"""
import argparse
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import platform
import stat
import sys
import time
import warnings

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image

MODEL_ID = "TareHimself/comic-text-mask"
MODEL_REVISION = "ebd37f1a9ae9298519678fb96a796573fb602977"
SOURCE_SHA256 = "ab28dd8450462c4f87ddfd05d13601813bb90414f26bea5590bf6a0a7540f988"
MODEL_FILE = "comic-text-mask-unet-resnet18-384.onnx"
MODEL_SIZE = 57314489
MODEL_SHA256 = "b10356a2a12f4dec4650e563724932e542764dbd3201a7e4cae6573597c5bea1"
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_REQUEST_BYTES = 4 * ((MAX_IMAGE_BYTES + 2) // 3) + 32 * 1024
MAX_PIXELS = 12_000_000
MAX_SIDE = 8000
MAX_REGIONS = 64


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError("INVALID_JSON")


def validate_regions(regions):
    if not isinstance(regions, list) or not 1 <= len(regions) <= MAX_REGIONS:
        raise ValueError("REGION_LIMIT")
    ids = set()
    for region in regions:
        if not isinstance(region, dict) or set(region) != {"id", "bbox"}:
            raise ValueError("INVALID_REGION")
        identity, box = region["id"], region["bbox"]
        if (not isinstance(identity, str) or not 1 <= len(identity) <= 128 or identity in ids
                or not all(char.isascii() and (char.isalnum() or char in "-_ .") for char in identity)):
            raise ValueError("INVALID_REGION_ID")
        ids.add(identity)
        if not isinstance(box, dict) or set(box) != {"x", "y", "width", "height"}:
            raise ValueError("INVALID_BBOX")
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in box.values()):
            raise ValueError("INVALID_BBOX")
        x, y, w, h = box["x"], box["y"], box["width"], box["height"]
        if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1 and 0 < h <= 1 and x+w <= 1+1e-9 and y+h <= 1+1e-9):
            raise ValueError("INVALID_BBOX")
    return regions


def read_request(source):
    raw = source.readline(MAX_REQUEST_BYTES + 1)
    if not raw or len(raw) > MAX_REQUEST_BYTES:
        raise ValueError("REQUEST_LIMIT")
    request = json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
    if (not isinstance(request, dict) or set(request) != {"version", "imagePngBase64", "regions"}
            or type(request["version"]) is not int or request["version"] != 1):
        raise ValueError("INVALID_REQUEST")
    regions = validate_regions(request["regions"])
    encoded = request["imagePngBase64"]
    if not isinstance(encoded, str) or not encoded or len(encoded) % 4 or len(encoded) > MAX_REQUEST_BYTES-128:
        raise ValueError("IMAGE_LIMIT")
    data = base64.b64decode(encoded, validate=True)
    if not 0 < len(data) <= MAX_IMAGE_BYTES or base64.b64encode(data).decode("ascii") != encoded:
        raise ValueError("IMAGE_LIMIT")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        Image.MAX_IMAGE_PIXELS = MAX_PIXELS
        with Image.open(io.BytesIO(data), formats=["PNG"]) as image:
            width, height = image.size
            if (not 0 < width <= MAX_SIDE or not 0 < height <= MAX_SIDE or width*height > MAX_PIXELS
                    or getattr(image, "n_frames", 1) != 1):
                raise ValueError("IMAGE_DIMENSIONS")
            image.load()
            return np.array(image.convert("RGB")), hashlib.sha256(data).hexdigest(), regions


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
        data = source.read(MODEL_SIZE+1)
        after = os.fstat(source.fileno())
    if (len(data) != MODEL_SIZE or hashlib.sha256(data).hexdigest() != MODEL_SHA256
            or (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
        raise ValueError("MODEL_CHECKSUM")
    return data


def create_session(model):
    ort.disable_telemetry_events()
    options = ort.SessionOptions()
    options.log_severity_level = 3
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    session = ort.InferenceSession(model, sess_options=options, providers=["CPUExecutionProvider"])
    session.disable_fallback()
    inputs, outputs = session.get_inputs(), session.get_outputs()
    if (session.get_providers() != ["CPUExecutionProvider"] or len(inputs) != 1 or len(outputs) != 1
            or (inputs[0].name, inputs[0].type, inputs[0].shape) != ("images", "tensor(uint8)", [1,3,384,384])
            or (outputs[0].name, outputs[0].type, outputs[0].shape) != ("probability", "tensor(float)", [1,1,384,384])):
        raise ValueError("MODEL_METADATA")
    return session


def guard_crop_mask(raw):
    """REJECTED PoC retained for experiment reproduction; not used by main.

    Real page 002 lost a glyph connected to a border. Do not use this guard
    as the removal decision; the stdio path uses combine_contexts instead.
    """
    if raw.ndim != 2 or raw.dtype != np.uint8 or not np.isin(raw, [0,255]).all():
        raise ValueError("INVALID_MASK")
    count, labels = cv2.connectedComponents(raw, connectivity=8)
    edge_ids = np.unique(np.concatenate((labels[0], labels[-1], labels[:,0], labels[:,-1])))
    edge_ids = edge_ids[edge_ids != 0]
    dropped = np.isin(labels, edge_ids) if edge_ids.size else np.zeros_like(raw, dtype=bool)
    core = raw.copy()
    core[dropped] = 0
    if not core.any():
        raise ValueError("EMPTY_TEXT_MASK")
    halo = cv2.dilate(core, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5,5)))
    return halo, {"rawPixels": int(np.count_nonzero(raw)), "droppedEdgePixels": int(np.count_nonzero(dropped)),
                  "droppedEdgeComponents": int(len(edge_ids)), "retainedComponents": int(count-1-len(edge_ids)),
                  "maskPixels": int(np.count_nonzero(halo))}


def combine_contexts(first, second, bounds):
    if (first.ndim != 2 or first.shape != second.shape or first.dtype != np.uint8 or second.dtype != np.uint8
            or not np.isin(first,[0,255]).all() or not np.isin(second,[0,255]).all()):
        raise ValueError("INVALID_MASK")
    height,width=first.shape
    x1,y1,x2,y2=bounds
    if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
        raise ValueError("INVALID_MASK_BOUNDS")
    consensus=first&second
    halo=cv2.dilate(consensus,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5)))
    envelope=np.zeros_like(halo)
    envelope[max(0,y1-2):min(height,y2+2),max(0,x1-2):min(width,x2+2)]=255
    final=halo&envelope
    if not final.any():
        raise ValueError("EMPTY_TEXT_MASK")
    return final,{"contextPixels":[int(np.count_nonzero(first)),int(np.count_nonzero(second))],
                  "contextDisagreementPixels":int(np.count_nonzero(first^second)),
                  "consensusPixels":int(np.count_nonzero(consensus)),
                  "clippedEnvelopePixels":int(np.count_nonzero((halo>0)&(envelope==0))),
                  "pixelsOutsideEnvelope":int(np.count_nonzero((final>0)&(envelope==0))),
                  "maskPixels":int(np.count_nonzero(final))}


def predict_context(session,pixels,box,fraction):
    height,width=pixels.shape[:2]
    x1,y1,x2,y2=box
    margin=max(4,math.ceil(min(x2-x1,y2-y1)*fraction))
    left,top=max(0,math.floor(x1)-margin),max(0,math.floor(y1)-margin)
    right,bottom=min(width,math.ceil(x2)+margin),min(height,math.ceil(y2)+margin)
    crop=pixels[top:bottom,left:right]
    ch,cw=crop.shape[:2]
    scale=384/max(ch,cw)
    nh,nw=max(1,round(ch*scale)),max(1,round(cw*scale))
    oy,ox=(384-nh)//2,(384-nw)//2
    square=np.zeros((384,384,3),np.uint8)
    square[oy:oy+nh,ox:ox+nw]=cv2.resize(crop,(nw,nh),interpolation=cv2.INTER_AREA)
    tensor=np.ascontiguousarray(square.transpose(2,0,1)[None])
    start=time.perf_counter()
    probability=session.run(["probability"],{"images":tensor})[0]
    inference_ms=(time.perf_counter()-start)*1000
    if (probability.shape != (1,1,384,384) or not np.isfinite(probability).all()
            or probability.min() < 0 or probability.max() > 1):
        raise ValueError("MODEL_OUTPUT")
    restored=cv2.resize(probability[0,0,oy:oy+nh,ox:ox+nw],(cw,ch),interpolation=cv2.INTER_LINEAR)
    return (restored>.5).astype(np.uint8)*255,(left,top,right,bottom),inference_ms


def segment(session, pixels, regions):
    height, width = pixels.shape[:2]
    mask = np.zeros((height,width), np.uint8)
    reports = []
    for region in regions:
        box = region["bbox"]
        x1, y1 = box["x"]*width, box["y"]*height
        x2, y2 = (box["x"]+box["width"])*width, (box["y"]+box["height"])*height
        small,small_bounds,small_ms=predict_context(session,pixels,(x1,y1,x2,y2),.08)
        large,large_bounds,large_ms=predict_context(session,pixels,(x1,y1,x2,y2),.24)
        left,top,right,bottom=large_bounds
        aligned=np.zeros_like(large)
        sl,st,sr,sb=small_bounds
        aligned[st-top:sb-top,sl-left:sr-left]=small
        bounds=(max(0,math.floor(x1)-left),max(0,math.floor(y1)-top),
                min(right,math.ceil(x2))-left,min(bottom,math.ceil(y2))-top)
        guarded,stats=combine_contexts(aligned,large,bounds)
        mask[top:bottom,left:right] |= guarded
        envelope={"x":max(0,math.floor(x1)-2),"y":max(0,math.floor(y1)-2),
                  "width":min(width,math.ceil(x2)+2)-max(0,math.floor(x1)-2),
                  "height":min(height,math.ceil(y2)+2)-max(0,math.floor(y1)-2)}
        reports.append({"id":region["id"],"cropPx":{"x":left,"y":top,"width":right-left,"height":bottom-top},
                        "envelopePx":envelope,**stats,"warnings":["MASK_QUALITY_REVIEW_REQUIRED"],
                        "inferenceMs":small_ms+large_ms})
    return mask, reports


def png_payload(pixels):
    with io.BytesIO() as output:
        Image.fromarray(pixels).save(output, format="PNG")
        data = output.getvalue()
        return base64.b64encode(data).decode("ascii"), hashlib.sha256(data).hexdigest()


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
            pixels, digest, regions = read_request(sys.stdin.buffer)
            load_start = time.perf_counter()
            session = create_session(read_pinned_model(args.model))
            load_ms = (time.perf_counter()-load_start)*1000
            mask, reports = segment(session,pixels,regions)
            rgba = np.full((*mask.shape,4),255,np.uint8)
            rgba[:,:,3] = 255-mask
            mask_encoded, mask_sha = png_payload(mask)
            rgba_encoded, rgba_sha = png_payload(rgba)
            response = {"version":1, "ok":True, "imageSha256":digest, "width":pixels.shape[1], "height":pixels.shape[0],
                        "model":{"id":MODEL_ID,"revision":MODEL_REVISION,"sourceSha256":SOURCE_SHA256,"file":MODEL_FILE,"sha256":MODEL_SHA256},
                        "executionProvider":"CPUExecutionProvider", "maskKind":"LEARNED_PIXEL_MASK", "threshold":.5,"haloRadius":2,
                        "algorithm":"dual-context-consensus-v1","maskAlgorithm":"dual-context-consensus-v1",
                        "qualityStatus":"REQUIRES_REVIEW","cropMargins":[.08,.24],
                        "maskPngBase64":mask_encoded, "maskSha256":mask_sha,
                        "maskRgbaPngBase64":rgba_encoded, "maskRgbaSha256":rgba_sha, "regions":reports,
                        "measurements":{"modelLoadMs":load_ms,"inferenceMs":sum(r["inferenceMs"] for r in reports),
                                        "totalMs":(time.perf_counter()-started)*1000}}
        except Exception:
            response = {"version":1,"ok":False,"error":"TEXT_MASK_FAILED"}
        protocol.write(json.dumps(response,ensure_ascii=True,separators=(",",":"),allow_nan=False).encode("ascii")+b"\n")
        protocol.flush()
        return 0 if response["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
