"""Check target-ORT numerical parity and inspect learned masks on 3 local pages.

Rectangle boxes only choose model crops. The removal mask comes from the
network's per-pixel probability; full rectangles are never used as masks.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import sys
import time

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image

def sha(data):
    return hashlib.sha256(data).hexdigest()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--export",required=True,type=Path)
    parser.add_argument("--detections",required=True,type=Path)
    parser.add_argument("--output",required=True,type=Path)
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=False)
    platform.system()
    def deny(event,_args):
        if event.startswith("socket.") or event in ("subprocess.Popen","os.system","os.posix_spawn","os.fork","os.exec"):
            raise RuntimeError("OFFLINE_ONLY")
    sys.addaudithook(deny)
    export=json.loads((args.export/"export-report.json").read_text("utf-8"))
    model=Path(export["onnxFile"]).read_bytes()
    if sha(model)!=export["onnxSha256"] or len(model)!=export["onnxBytes"]:
        raise ValueError("EXPORTED_MODEL_CHANGED")
    ort.disable_telemetry_events()
    options=ort.SessionOptions()
    options.intra_op_num_threads=4
    options.inter_op_num_threads=1
    options.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL
    options.add_session_config_entry("session.intra_op.allow_spinning","0")
    start=time.perf_counter()
    session=ort.InferenceSession(model,sess_options=options,providers=["CPUExecutionProvider"])
    session.disable_fallback()
    if session.get_providers()!=["CPUExecutionProvider"]:
        raise ValueError("CPU_ONLY")
    load_ms=(time.perf_counter()-start)*1000
    reference=np.load(args.export/"export-reference.npz",allow_pickle=False)
    parity=session.run(["probability"],{"images":reference["images"]})[0]
    np.testing.assert_allclose(parity,reference["probability"],atol=1e-4,rtol=1e-4)
    max_error=float(np.max(np.abs(parity-reference["probability"])))
    detector=json.loads(args.detections.read_text("utf-8"))
    pages=next(item["pages"] for item in detector["models"] if item["model"]=="detector-v4-s_int8.onnx")
    results=[]
    for page_index,page in enumerate(pages):
        image_path=Path(page["input"])
        original=image_path.read_bytes()
        if sha(original)!=page["inputSha256"]:
            raise ValueError("INPUT_CHANGED")
        image=Image.open(image_path).convert("RGB")
        pixels=np.asarray(image)
        height,width=pixels.shape[:2]
        raw=np.zeros((height,width),np.uint8)
        dilated=np.zeros_like(raw)
        allowed=np.zeros_like(raw)
        report=[]
        for region_index,detection in enumerate(item for item in page["detections"] if item["label"]==1):
            x1,y1,x2,y2=detection["boxPx"]
            margin=max(4,math.ceil(min(x2-x1,y2-y1)*.08))
            left,top=max(0,math.floor(x1)-margin),max(0,math.floor(y1)-margin)
            right,bottom=min(width,math.ceil(x2)+margin),min(height,math.ceil(y2)+margin)
            crop=pixels[top:bottom,left:right]
            ch,cw=crop.shape[:2]
            scale=384/max(ch,cw)
            nh,nw=round(ch*scale),round(cw*scale)
            oy,ox=(384-nh)//2,(384-nw)//2
            square=np.zeros((384,384,3),np.uint8)
            square[oy:oy+nh,ox:ox+nw]=cv2.resize(crop,(nw,nh),interpolation=cv2.INTER_AREA)
            tensor=np.ascontiguousarray(square.transpose(2,0,1)[None])
            start=time.perf_counter()
            probability=session.run(["probability"],{"images":tensor})[0]
            inference_ms=(time.perf_counter()-start)*1000
            if probability.shape!=(1,1,384,384) or not np.isfinite(probability).all() or probability.min()<0 or probability.max()>1:
                raise ValueError("INVALID_PROBABILITY")
            crop_prob=cv2.resize(probability[0,0,oy:oy+nh,ox:ox+nw],(cw,ch),interpolation=cv2.INTER_LINEAR)
            crop_mask=(crop_prob>.5).astype(np.uint8)*255
            halo=cv2.dilate(crop_mask,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5)))
            raw[top:bottom,left:right]|=crop_mask
            dilated[top:bottom,left:right]|=halo
            allowed[top:bottom,left:right]=255
            report.append({"id":detection["id"],"bboxPx":[left,top,right,bottom],"cropSize":[cw,ch],"pasteBox":[ox,oy,nw,nh],
                           "rawPixels":int(np.count_nonzero(crop_mask)),"dilatedPixels":int(np.count_nonzero(halo)),"inferenceMs":inference_ms})
            if page_index==0:
                Image.fromarray(crop).save(args.output/f"001-region-{region_index:02d}-source.png")
                Image.fromarray(crop_mask).save(args.output/f"001-region-{region_index:02d}-mask-raw.png")
                crop_overlay=crop.copy()
                selected=halo>0
                crop_overlay[selected]=(crop_overlay[selected].astype(np.float32)*.4+np.array([255,0,0])*.6).astype(np.uint8)
                Image.fromarray(crop_overlay).save(args.output/f"001-region-{region_index:02d}-overlay.png")
        prefix=f"{page_index+1:03d}"
        Image.fromarray(raw).save(args.output/(prefix+"-mask-raw.png"))
        Image.fromarray(dilated).save(args.output/(prefix+"-mask-dilate2.png"))
        rgba=np.full((height,width,4),255,np.uint8)
        rgba[:,:,3]=np.where(dilated>0,0,255).astype(np.uint8)
        Image.fromarray(rgba).save(args.output/(prefix+"-mask-rgba-dilate2.png"))
        overlay=pixels.copy()
        selected=dilated>0
        overlay[selected]=(overlay[selected].astype(np.float32)*.4+np.array([255,0,0])*.6).astype(np.uint8)
        Image.fromarray(overlay).save(args.output/(prefix+"-mask-overlay.png"))
        outside=int(np.count_nonzero((dilated>0)&(allowed==0)))
        if outside or sha(image_path.read_bytes())!=page["inputSha256"]:
            raise ValueError("MASK_OR_INPUT_BOUNDARY_CHANGED")
        results.append({"input":str(image_path),"inputSha256":page["inputSha256"],"width":width,"height":height,"regions":report,
                        "rawPixels":int(np.count_nonzero(raw)),"dilatedPixels":int(np.count_nonzero(dilated)),"outsideCropMaskPixels":outside,
                        "inferenceMs":sum(region["inferenceMs"] for region in report),"originalPreserved":True})
        print(json.dumps({"page":prefix,"regions":len(report),"pixels":results[-1]["dilatedPixels"],"inferenceMs":results[-1]["inferenceMs"]}),flush=True)
    result={"scope":"REAL_LEARNED_TEXT_MASK_POC_NOT_INPAINTING","onnxSha256":export["onnxSha256"],"sourceWeightSha256":export["sourceSha256"],
            "license":"mit","executionProvider":"CPUExecutionProvider","modelLoadMs":load_ms,"numericalParityMaxAbsError":max_error,
            "numericalParityAtol":1e-4,"threshold":.5,"haloRadius":2,"imagesUploaded":False,"pixelsOutsideSelectedCrops":0,"pages":results,
            "artworkPreservation":"NOT_PROVEN_BY_MASK_BOUNDARY","glyphRecall":"VISUAL_REVIEW_REQUIRED"}
    (args.output/"mask-evaluation.json").write_text(json.dumps(result,indent=2),"utf-8")
    print("MASK_OUTPUT="+str(args.output),flush=True)

if __name__=="__main__":
    main()
