"""Compare fresh v3 masks to current-kernel replay of cached real baselines.

This verification script creates no model session and performs no OCR/LaMa.
Historical data is read by this audit only, never by the v3 stdio worker.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw


def sha(data):return hashlib.sha256(data).hexdigest()


def main():
    parser=argparse.ArgumentParser();parser.add_argument("--verification",type=Path,required=True);parser.add_argument("--baseline-verification",type=Path,required=True);parser.add_argument("--prior-additional",type=Path);parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=False)
    actual=json.loads(args.verification.read_text("utf-8"));cached=json.loads(args.baseline_verification.read_text("utf-8"))
    prior=json.loads((args.prior_additional/"additional-pages-report.json").read_text("utf-8")) if args.prior_additional else None
    kernel_file=Path(__file__).with_name("v3_postprocess.py");kernel_sha=sha(kernel_file.read_bytes())
    spec=importlib.util.spec_from_file_location("v3kernel_audit",kernel_file);kernel=importlib.util.module_from_spec(spec);spec.loader.exec_module(kernel)
    reports=[]
    for index,page in enumerate(actual["results"]):
        prefix=f"{index+1:03d}";page_out=args.output/prefix;page_out.mkdir()
        source_bytes=Path(page["input"]).read_bytes()
        if sha(source_bytes)!=page["imageSha256"] or kernel_sha!=page["postprocessSourceSha256"]:raise ValueError("CURRENT_SOURCE_OR_KERNEL_CHANGED")
        baseline_index=next(i for i,c in enumerate(cached["results"]) if c["imageSha256"]==page["imageSha256"])
        baseline_page=cached["results"][baseline_index];baseline_file=args.baseline_verification.parent/f"{baseline_index+1:03d}-mask-rgba.png"
        baseline_bytes=baseline_file.read_bytes()
        if sha(baseline_bytes)!=baseline_page["maskRgbaSha256"]:raise ValueError("CACHED_BASELINE_CHANGED")
        source=np.array(Image.open(page["input"]).convert("RGB"))
        baseline=np.where(np.array(Image.open(baseline_file).convert("RGBA"))[:,:,3]==0,255,0).astype(np.uint8)
        real_file=args.verification.parent/(prefix+"-mask-rgba.png");real_bytes=real_file.read_bytes()
        if sha(real_bytes)!=page["maskRgbaSha256"]:raise ValueError("REAL_MASK_CHANGED")
        real=np.where(np.array(Image.open(real_file).convert("RGBA"))[:,:,3]==0,255,0).astype(np.uint8)
        replay,stats=kernel.refine(source,baseline,page["sourceRegions"])
        rgba=np.full((*replay.shape,4),255,np.uint8);rgba[:,:,3]=255-replay
        replay_file=page_out/"cached-kernel-replay-rgba.png";Image.fromarray(rgba).save(replay_file)
        differences=int(np.count_nonzero(replay!=real));same_bytes=sha(replay_file.read_bytes())==page["maskRgbaSha256"]
        if differences or not same_bytes or stats["baselinePixels"]!=page["postprocessStats"]["baselinePixels"]:raise ValueError("FRESH_V3_CACHED_REPLAY_DIFFERENCE")
        overlay=source.copy();selected=real>0
        overlay[selected]=(overlay[selected].astype(np.float32)*.4+np.array([255,0,0])*.6).astype(np.uint8)
        Image.fromarray(overlay).save(page_out/"actual-mask-overlay.png")
        for member_index,region in enumerate(page["regions"]):
            box=region["contextPx"];x,y,w,h=box["x"],box["y"],box["width"],box["height"]
            panels=[Image.fromarray(source[y:y+h,x:x+w]),Image.fromarray(overlay[y:y+h,x:x+w])]
            sheet=Image.new("RGB",(w*2,h+30),"white");draw=ImageDraw.Draw(sheet)
            for col,(label,panel) in enumerate(zip(["current source","fresh v3 mask"],panels)):
                sheet.paste(panel,(col*w,30));draw.text((col*w+3,5),label,fill="black")
            sheet.save(page_out/f"region-{member_index:02d}-actual-comparison.png")
        prior_comparison=None
        if prior:
            previous=next((p for p in prior["pages"] if p["sourceSha256"]==page["imageSha256"]),None)
            if previous:
                # This comparison intentionally names the older bubble-metadata
                # prototype; its geometry policy differs from current v3 stdio.
                prior_file=args.prior_additional/Path(page["input"]).name[:3]/"refined-mask-l.png"
                old=np.array(Image.open(prior_file).convert("L"))
                prior_comparison={"scope":"OLDER_BUBBLE_METADATA_PROTOTYPE_DIFFERENT_CONTEXT_POLICY","file":str(prior_file),"sha256":sha(prior_file.read_bytes()),
                                  "priorPixels":int(np.count_nonzero(old)),"addedPixels":int(np.count_nonzero((real>0)&(old==0))),"removedPixels":int(np.count_nonzero((real==0)&(old>0)))}
                delta=source.copy();added=(real>0)&(old==0);removed=(real==0)&(old>0)
                delta[added]=(delta[added].astype(np.float32)*.3+np.array([0,255,0])*.7).astype(np.uint8)
                delta[removed]=(delta[removed].astype(np.float32)*.3+np.array([0,100,255])*.7).astype(np.uint8)
                Image.fromarray(delta).save(page_out/"older-prototype-delta-green-added-blue-removed.png")
        if sha(Path(page["input"]).read_bytes())!=page["imageSha256"] or sha(baseline_file.read_bytes())!=baseline_page["maskRgbaSha256"] or sha(real_file.read_bytes())!=page["maskRgbaSha256"]:raise ValueError("AUDIT_INPUT_CHANGED")
        reports.append({"page":prefix,"source":page["input"],"sourceSha256":page["imageSha256"],"actualRgbaSha256":page["maskRgbaSha256"],"cachedBaselineSha256":baseline_page["maskRgbaSha256"],
                        "samePngBytesAsCurrentKernelReplay":same_bytes,"differingMaskPixels":differences,"maskPixels":stats["maskPixels"],"priorPrototypeComparison":prior_comparison})
        print(json.dumps({"page":prefix,"samePngBytes":same_bytes,"pixels":stats["maskPixels"],"differences":differences,"prior":prior_comparison}),flush=True)
    if sha(kernel_file.read_bytes())!=kernel_sha:raise ValueError("KERNEL_CHANGED_DURING_AUDIT")
    report={"scope":"FRESH_V3_TO_CACHED_BASELINE_POSTPROCESS_REPLAY_COMPARISON_NO_NEW_AI","newAiExecutions":0,"kernelSha256":kernel_sha,"qualityStatus":"REQUIRES_REVIEW","pages":reports}
    (args.output/"real-vs-cached.json").write_text(json.dumps(report,indent=2),"utf-8")
    print("REAL_CACHED_AUDIT="+str(args.output))


if __name__=="__main__":main()
