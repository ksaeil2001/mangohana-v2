"""Independent pixel comparison and all-ROI before/after stage-only sheets."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--run",required=True,type=Path)
    parser.add_argument("--refinement",required=True,type=Path)
    parser.add_argument("--stage",required=True,type=Path)
    parser.add_argument("--output",required=True,type=Path)
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=False)
    evidence=json.loads((args.refinement/"refinement-report.json").read_text("utf-8"))
    source=Image.open(args.run/"normalized.png").convert("RGBA")
    before=Image.open(args.run/"cleaned.png").convert("RGBA")
    after=Image.open(args.stage/"stage-cleaned.png").convert("RGBA")
    mask=np.array(Image.open(args.refinement/"refined-mask-rgba.png").convert("RGBA"))[:,:,3]==0
    a,b=np.array(source),np.array(after)
    changed=np.any(a!=b,axis=2)
    outside=int(np.count_nonzero(changed&~mask));alpha=int(np.count_nonzero(a[:,:,3]!=b[:,:,3]))
    if outside or alpha:raise ValueError("STAGE_CHANGED_PROTECTED_PIXELS")
    for index,region in enumerate(evidence["regions"]):
        box=tuple(region["contextPx"])
        panels=[source.crop(box).convert("RGB"),before.crop(box).convert("RGB"),after.crop(box).convert("RGB")]
        w,h=panels[0].size;sheet=Image.new("RGB",(w*3,h+30),"white");draw=ImageDraw.Draw(sheet)
        for col,(label,panel) in enumerate(zip(["source","baseline LaMa","experimental LaMa"],panels)):
            sheet.paste(panel,(col*w,30));draw.text((col*w+3,5),label,fill="black")
        sheet.save(args.output/f"region-{index:02d}-lama-comparison.png")
    report={"scope":"EXPERIMENTAL_LAMA_STAGE_ONLY_NOT_PRODUCT_COMPLETION","sourceJob":str(args.run),"refinement":str(args.refinement),"stage":str(args.stage),
            "outsideMaskChangedPixels":outside,"alphaChangedPixels":alpha,"changedPixels":int(np.count_nonzero(changed)),"qualityStatus":"REQUIRES_VISUAL_REVIEW",
            "stageCleanedSha256":hashlib.sha256((args.stage/"stage-cleaned.png").read_bytes()).hexdigest()}
    (args.output/"stage-pixel-review.json").write_text(json.dumps(report,indent=2),"utf-8")
    print("STAGE_REVIEW="+str(args.output))


if __name__=="__main__":main()
