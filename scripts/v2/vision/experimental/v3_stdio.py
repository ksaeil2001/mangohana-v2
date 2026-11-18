"""Experimental bounded one-image learned-mask v3 stdio candidate.

No cached image/result files are read. Each valid execution loads the pinned
ONNX CPU model, computes dual-context masks for this image, then applies the
pinned current-image source-ink/radial postprocessor. No quality approval.
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
import sys
import struct
import time
import types

BASE_SOURCE_SHA256="9e3a662322e0d5dcf72e26d00c8a493161d390bbabf47843e94165f4d1777b9b"
POSTPROCESS_SHA256="d45e3a504852c1054139ed485576c588778ea729857c7b6d30b15c3657181da7"
MAX_RESPONSE_BYTES=8*1024*1024
MAX_IMAGE_BYTES=32*1024*1024
MAX_REQUEST_BYTES=4*((MAX_IMAGE_BYTES+2)//3)+32*1024


def unique_object(pairs):
    result={}
    for key,value in pairs:
        if key in result:raise ValueError("DUPLICATE_JSON_KEY")
        result[key]=value
    return result


def reject_constant(_value):raise ValueError("INVALID_JSON")


def read_envelope(source):
    """Reject cheap invalid input before loading any native image/AI library."""
    raw=source.readline(MAX_REQUEST_BYTES+1)
    if not raw or len(raw)>MAX_REQUEST_BYTES:raise ValueError("REQUEST_LIMIT")
    value=json.loads(raw,object_pairs_hook=unique_object,parse_constant=reject_constant)
    if not isinstance(value,dict) or set(value)!={"version","imagePngBase64","regions"} or type(value["version"]) is not int or value["version"]!=1:
        raise ValueError("INVALID_REQUEST")
    regions=value["regions"]
    if not isinstance(regions,list) or not 1<=len(regions)<=64:raise ValueError("REGION_LIMIT")
    seen=set()
    for region in regions:
        if not isinstance(region,dict) or set(region)!={"id","bbox"}:raise ValueError("INVALID_REGION")
        identity,box=region["id"],region["bbox"]
        if (not isinstance(identity,str) or not 1<=len(identity)<=128 or identity in seen
                or not all(c.isascii() and (c.isalnum() or c in "-_ .") for c in identity)):raise ValueError("INVALID_REGION_ID")
        seen.add(identity)
        if not isinstance(box,dict) or set(box)!={"x","y","width","height"}:raise ValueError("INVALID_BBOX")
        if any(type(v) not in (int,float) or not math.isfinite(v) for v in box.values()):raise ValueError("INVALID_BBOX")
        x,y,w,h=box["x"],box["y"],box["width"],box["height"]
        if not (0<=x<1 and 0<=y<1 and 0<w<=1 and 0<h<=1 and x+w<=1+1e-9 and y+h<=1+1e-9):raise ValueError("INVALID_BBOX")
    encoded=value["imagePngBase64"]
    if not isinstance(encoded,str) or not encoded or len(encoded)%4 or len(encoded)>MAX_REQUEST_BYTES-128:raise ValueError("IMAGE_LIMIT")
    data=base64.b64decode(encoded,validate=True)
    if not 0<len(data)<=MAX_IMAGE_BYTES or base64.b64encode(data).decode("ascii")!=encoded:raise ValueError("IMAGE_LIMIT")
    if len(data)<33 or data[:8]!=b"\x89PNG\r\n\x1a\n" or data[8:16]!=b"\x00\x00\x00\rIHDR":raise ValueError("IMAGE_FORMAT")
    width,height=struct.unpack(">II",data[16:24])
    if not 0<width<=8000 or not 0<height<=8000 or width*height>12_000_000:raise ValueError("IMAGE_DIMENSIONS")
    position=8;ended=False;chunks=0
    while position+12<=len(data):
        length=struct.unpack(">I",data[position:position+4])[0];kind=data[position+4:position+8]
        chunks+=1
        if chunks>100_000 or length>len(data)-position-12:raise ValueError("IMAGE_FORMAT")
        if kind==b"acTL":raise ValueError("IMAGE_DIMENSIONS")
        position+=length+12
        if kind==b"IEND":
            if length or position!=len(data):raise ValueError("IMAGE_FORMAT")
            ended=True;break
    if not ended:raise ValueError("IMAGE_FORMAT")
    if source.read(1):raise ValueError("MULTIPLE_REQUESTS")
    return raw


def load_pinned(name,file,expected):
    data=file.read_bytes()
    if len(data)>128*1024 or hashlib.sha256(data).hexdigest()!=expected:raise ValueError("SOURCE_PIN")
    module=types.ModuleType(name);module.__file__=str(file)
    # Execute only these reviewed local bytes, never a path reopened after hash.
    exec(compile(data,str(file),"exec"),module.__dict__)
    return module


def load_sources():
    root=Path(__file__).resolve().parents[1]
    base=load_pinned("v3_pinned_baseline",root/"text_mask.py",BASE_SOURCE_SHA256)
    post=load_pinned("v3_pinned_postprocess",Path(__file__).with_name("v3_postprocess.py"),POSTPROCESS_SHA256)
    return base,post


def read_input(base,post,source):
    pixels,digest,regions=base.read_request(source)
    if source.read(1):raise ValueError("MULTIPLE_REQUESTS")
    post.plan_regions(pixels.shape[1],pixels.shape[0],regions)
    return pixels,digest,regions


def install_offline_guards():
    platform.system()
    sys.dont_write_bytecode=True
    def deny(event,args):
        if event.startswith("socket.") or event in ("subprocess.Popen","os.system","os.posix_spawn","os.fork","os.exec"):
            raise RuntimeError("OFFLINE_ONLY")
        if event=="open":
            mode=args[1] if len(args)>1 else None
            flags=args[2] if len(args)>2 else 0
            if (isinstance(mode,str) and any(char in mode for char in "wax+")) or (isinstance(flags,int) and flags&(os.O_WRONLY|os.O_RDWR|os.O_APPEND|os.O_CREAT|os.O_TRUNC)):
                raise RuntimeError("READ_ONLY_WORKER")
    sys.addaudithook(deny)


def execute(base,post,args,pixels,digest,regions,started):
    base.cv2.setNumThreads(1)
    load_start=time.perf_counter()
    session=base.create_session(base.read_pinned_model(args.model))
    load_ms=(time.perf_counter()-load_start)*1000
    baseline,baseline_reports=base.segment(session,pixels,regions)
    if len(baseline_reports)!=len(regions) or any(r["id"]!=regions[i]["id"] or r["maskPixels"]<=0 for i,r in enumerate(baseline_reports)):
        raise ValueError("BASELINE_MEMBER_IDENTITY")
    post_start=time.perf_counter()
    mask,stats=post.refine(pixels,baseline,regions)
    post_ms=(time.perf_counter()-post_start)*1000
    reports=stats.pop("regions")
    if len(reports)!=len(regions) or any(r["id"]!=regions[i]["id"] or r["maskPixels"]<=0 or r["pixelsOutsideEnvelope"]!=0 for i,r in enumerate(reports)):
        raise ValueError("POSTPROCESS_MEMBER_IDENTITY")
    for report,baseline_report in zip(reports,baseline_reports):
        report["baselineMaskPixels"]=baseline_report["maskPixels"]
        report["baselineInferenceMs"]=baseline_report["inferenceMs"]
    rgba=base.np.full((*mask.shape,4),255,base.np.uint8);rgba[:,:,3]=255-mask
    gray_encoded,gray_sha=base.png_payload(mask);rgba_encoded,rgba_sha=base.png_payload(rgba)
    return {"version":1,"ok":True,"imageSha256":digest,"width":pixels.shape[1],"height":pixels.shape[0],
        "model":{"id":base.MODEL_ID,"revision":base.MODEL_REVISION,"sourceSha256":base.SOURCE_SHA256,"file":base.MODEL_FILE,"sha256":base.MODEL_SHA256},
        "executionProvider":"CPUExecutionProvider","maskKind":"LEARNED_PIXEL_MASK","algorithm":post.ALGORITHM,"maskAlgorithm":post.ALGORITHM,
        "qualityStatus":"REQUIRES_REVIEW","baselineAlgorithm":"dual-context-consensus-v1","baselineHaloRadius":2,"clipPaddingPx":2,
        "adaptiveHalo":True,"segmentationThreshold":.5,"cropMargins":[.08,.24],
        "maskPngBase64":gray_encoded,"maskSha256":gray_sha,"maskRgbaPngBase64":rgba_encoded,"maskRgbaSha256":rgba_sha,
        "regions":reports,"postprocessStats":stats,"postprocessSourceSha256":POSTPROCESS_SHA256,"baselineSourceSha256":BASE_SOURCE_SHA256,
        "measurements":{"modelLoadMs":load_ms,"inferenceMs":sum(r["inferenceMs"] for r in baseline_reports),"postprocessMs":post_ms,
                        "totalMs":(time.perf_counter()-started)*1000}}


def main():
    parser=argparse.ArgumentParser();parser.add_argument("--model",required=True,type=Path);args=parser.parse_args()
    with os.fdopen(os.dup(sys.stdout.fileno()),"wb",buffering=0) as protocol:
        os.dup2(sys.stderr.fileno(),sys.stdout.fileno())
        try:
            started=time.perf_counter();install_offline_guards()
            raw=read_envelope(sys.stdin.buffer)
            if not args.model.is_absolute() or not args.model.is_file():raise ValueError("MODEL_PATH")
            base,post=load_sources()
            pixels,digest,regions=read_input(base,post,io.BytesIO(raw))
            response=execute(base,post,args,pixels,digest,regions,started)
            encoded=json.dumps(response,ensure_ascii=True,separators=(",",":"),allow_nan=False).encode("ascii")+b"\n"
            if len(encoded)>MAX_RESPONSE_BYTES:raise ValueError("RESPONSE_LIMIT")
        except Exception:
            response={"version":1,"ok":False,"error":"TEXT_MASK_FAILED"}
            encoded=json.dumps(response,separators=(",",":")).encode("ascii")+b"\n"
        protocol.write(encoded);protocol.flush()
        return 0 if response["ok"] else 1


if __name__=="__main__":raise SystemExit(main())
