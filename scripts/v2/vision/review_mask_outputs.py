"""Inspect bounded stdio masks, alpha polarity and source identity locally."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from PIL import Image


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--output",required=True,type=Path)
    args=parser.parse_args()
    evidence=json.loads((args.output/"verification.json").read_text("utf-8"))
    reports=[]
    for index,page in enumerate(evidence["results"]):
        prefix=f"{index+1:03d}"
        source=Path(page["input"]).read_bytes()
        if hashlib.sha256(source).hexdigest()!=page["imageSha256"]:
            raise ValueError("SOURCE_CHANGED")
        with Image.open(page["input"]) as opened:
            pixels=np.array(opened.convert("RGB"))
        height,width=pixels.shape[:2]
        with Image.open(args.output/(prefix+"-mask-l.png")) as opened:
            if opened.mode!="L" or opened.size!=(width,height):
                raise ValueError("MASK_FORMAT")
            mask=np.array(opened)
        with Image.open(args.output/(prefix+"-mask-rgba.png")) as opened:
            if opened.mode!="RGBA" or opened.size!=(width,height):
                raise ValueError("MASK_FORMAT")
            rgba=np.array(opened)
        if not np.isin(mask,[0,255]).all() or not np.array_equal(rgba[:,:,3],255-mask) or not (rgba[:,:,:3]==255).all():
            raise ValueError("MASK_ALPHA_POLARITY")
        allowed=np.zeros_like(mask)
        envelope=np.zeros_like(mask)
        for region_index,region in enumerate(page["regions"]):
            crop=region["cropPx"]
            x,y,w,h=crop["x"],crop["y"],crop["width"],crop["height"]
            allowed[y:y+h,x:x+w]=255
            box=region["envelopePx"]
            ex,ey,ew,eh=box["x"],box["y"],box["width"],box["height"]
            envelope[ey:ey+eh,ex:ex+ew]=255
            if index==0:
                image=pixels[y:y+h,x:x+w].copy()
                active=mask[y:y+h,x:x+w]>0
                image[active]=(image[active].astype(np.float32)*.4+np.array([255,0,0])*.6).astype(np.uint8)
                Image.fromarray(image).save(args.output/f"001-region-{region_index:02d}-guarded-overlay.png")
        outside=int(np.count_nonzero((mask>0)&(allowed==0)))
        if outside:
            raise ValueError("MASK_OUTSIDE_CROPS")
        outside_envelope=int(np.count_nonzero((mask>0)&(envelope==0)))
        if outside_envelope:
            raise ValueError("MASK_OUTSIDE_ORIGINAL_BBOX_PLUS_2PX")
        image=pixels.copy()
        active=mask>0
        image[active]=(image[active].astype(np.float32)*.4+np.array([255,0,0])*.6).astype(np.uint8)
        Image.fromarray(image).save(args.output/(prefix+"-guarded-overlay.png"))
        reports.append({"page":prefix,"maskPixels":int(np.count_nonzero(mask)),"pixelsOutsideCrops":outside,
                        "pixelsOutsideOriginalBboxPlus2Px":outside_envelope,"alphaPolarityVerified":True,
                        "contextDisagreementPixels":sum(region["contextDisagreementPixels"] for region in page["regions"]),
                        "clippedEnvelopePixels":sum(region["clippedEnvelopePixels"] for region in page["regions"]),"sourcePreserved":True})
    report={"scope":"LEARNED_MASK_FORMAT_AND_BOUNDARY_ONLY","pages":reports,"visualQuality":"REQUIRES_REVIEW","inpaintingPerformed":False}
    (args.output/"mask-format-review.json").write_text(json.dumps(report,indent=2),"utf-8")
    print(json.dumps(report))


if __name__=="__main__":
    main()
