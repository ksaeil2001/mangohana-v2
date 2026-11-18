"""Cached-output postprocessor replay. This script never loads an AI model."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import time
import numpy as np
from PIL import Image


def sha(file):return hashlib.sha256(file.read_bytes()).hexdigest()


def main():
    parser=argparse.ArgumentParser();parser.add_argument("--source",type=Path,required=True);parser.add_argument("--baseline",type=Path,required=True);parser.add_argument("--selection",type=Path,required=True);parser.add_argument("--expected",type=Path);parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=False)
    kernel_path=Path(__file__).with_name("v3_postprocess.py")
    spec=importlib.util.spec_from_file_location("v3_kernel",kernel_path);kernel=importlib.util.module_from_spec(spec);spec.loader.exec_module(kernel)
    files=[args.source,args.baseline,args.selection]+([args.expected] if args.expected else [])
    pins={str(file):sha(file) for file in files}
    selection=json.loads(args.selection.read_text("utf-8"))
    identities=list(dict.fromkeys(d["detectorRegionId"] for d in selection["selection"]["decisions"] if d["action"]=="translate"))
    regions=[{"id":identity,"bbox":next(d["bbox"] for d in selection["detection"]["regions"] if d["id"]==identity)} for identity in identities]
    source=np.array(Image.open(args.source).convert("RGB"))
    baseline=np.where(np.array(Image.open(args.baseline).convert("RGBA"))[:,:,3]==0,255,0).astype(np.uint8)
    started=time.perf_counter();result,stats=kernel.refine(source,baseline,regions);elapsed=(time.perf_counter()-started)*1000
    Image.fromarray(result).save(args.output/"replay-mask-l.png")
    rgba=np.full((*result.shape,4),255,np.uint8);rgba[:,:,3]=255-result
    Image.fromarray(rgba).save(args.output/"replay-mask-rgba.png")
    expected=None
    if args.expected:
        pixels=np.array(Image.open(args.expected).convert("RGBA"))
        expected={"file":str(args.expected),"sha256":sha(args.expected),"samePngBytes":sha(args.expected)==sha(args.output/"replay-mask-rgba.png"),
                  "differingMaskPixels":int(np.count_nonzero(pixels[:,:,3]!=rgba[:,:,3]))}
    if pins!={str(file):sha(file) for file in files}:raise ValueError("CACHED_INPUT_CHANGED")
    report={"scope":"CACHED_AI_MASK_POSTPROCESS_REPLAY_NO_AI","newAiExecutions":0,"currentImageSha256":sha(args.source),"baselineSha256":sha(args.baseline),"kernelSha256":sha(kernel_path),
            "algorithm":kernel.ALGORITHM,"qualityStatus":"REQUIRES_REVIEW","postprocessMs":elapsed,"stats":stats,"expectedComparison":expected,
            "sourceEvidencePreserved":True,"sourcePins":pins,"maskRgbaSha256":sha(args.output/"replay-mask-rgba.png"),"maskSha256":sha(args.output/"replay-mask-l.png")}
    (args.output/"cached-replay.json").write_text(json.dumps(report,indent=2),"utf-8")
    print(json.dumps({"output":str(args.output),"maskPixels":stats["maskPixels"],"postprocessMs":elapsed,"kernelSha256":report["kernelSha256"],"expected":expected}),flush=True)


if __name__=="__main__":main()
