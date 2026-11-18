"""Experimental compact-glyph halo recovery from measured source profiles."""
import argparse
import hashlib
import json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image


def sha(file):return hashlib.sha256(file.read_bytes()).hexdigest()


def select_radius(profile,baseline_radius,font_scale):
    # Require a genuine bright rim followed by two lower-brightness rings.
    if max((p["whiteFraction"] for p in profile if 2<=p["r"]<=4),default=0)<.8:return None
    cap=max(3,min(12,round(font_scale*.35)))
    for current,next_ring in zip(profile,profile[1:]):
        if current["r"]<3 or current["r"]+2>cap:continue
        if current["whiteFraction"]<.65 and next_ring["whiteFraction"]<.65 and current["medianGray"]<235:
            radius=current["r"]+2
            return radius if radius>baseline_radius else None
    return None


def main():
    parser=argparse.ArgumentParser();parser.add_argument("--refinement",type=Path,required=True);parser.add_argument("--profiles",type=Path,required=True);parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=False)
    report=json.loads((args.refinement/"refinement-report.json").read_text("utf-8"))
    profiles=json.loads(args.profiles.read_text("utf-8"))["profiles"]
    run=Path(report["sourceJob"]);source=np.array(Image.open(run/"normalized.png").convert("RGB"))
    original_hash=sha(run/"normalized.png");parent_hash=sha(args.refinement/"refined-mask-rgba.png")
    baseline=np.where(np.array(Image.open(args.refinement/"refined-mask-rgba.png").convert("RGBA"))[:,:,3]==0,255,0).astype(np.uint8)
    result=baseline.copy();height,width=result.shape;frames=np.zeros_like(result);envelopes=np.zeros_like(result);reports=[]
    for region in report["regions"]:
        left,top,right,bottom=region["contextPx"]
        gray=cv2.cvtColor(source[top:bottom,left:right],cv2.COLOR_RGB2GRAY)
        _,labels,stats,_=cv2.connectedComponentsWithStats((gray<100).astype(np.uint8)*255,connectivity=8)
        additions=np.zeros_like(gray);decisions=[]
        for profile in [p for p in profiles if p["regionId"]==region["id"]]:
            identity=profile["componentId"];x,y,w,h,_=map(int,stats[identity])
            if [x+left,y+top,w,h]!=profile["bboxPx"] or profile["fontScale"]!=region["fontScale"]:raise ValueError("PROFILE_SOURCE_MISMATCH")
            radius=select_radius(profile["profile"],region["haloRadius"],region["fontScale"])
            if radius is None:continue
            core=(labels==identity).astype(np.uint8)*255
            additions |= cv2.dilate(core,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(2*radius+1,2*radius+1)))
            decisions.append({"componentId":identity,"bboxPx":profile["bboxPx"],"oldRadius":region["haloRadius"],"measuredRadius":radius})
        frame=np.isin(labels,region["frameComponents"]).astype(np.uint8)*255
        frame=cv2.dilate(frame,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5)))
        frames[top:bottom,left:right] |= frame
        x1,y1,x2,y2=region["textBboxPx"];envelope=np.zeros_like(gray)
        envelope[max(0,y1-top-2):min(gray.shape[0],y2-top+2),max(0,x1-left-2):min(gray.shape[1],x2-left+2)]=255
        envelopes[top:bottom,left:right] |= envelope
        additions[(frame>0)|(envelope==0)]=0
        result[top:bottom,left:right] |= additions
        reports.append({"id":region["id"],"expandedGlyphs":decisions})
    raw=json.loads((run/"raw-ocr.json").read_text("utf-8"));selection=json.loads((run/"region-selection.json").read_text("utf-8"))
    preserved={d["id"] for d in selection["selection"]["decisions"] if d["action"]=="preserve"};protected=np.zeros_like(result)
    for region in [r for r in raw["speechBubbles"] if r["id"] in preserved]+raw["nonSpeechText"]:
        box=region["bbox"];l=max(0,int(np.floor(box["x"]*width)));t=max(0,int(np.floor(box["y"]*height)));r=min(width,int(np.ceil((box["x"]+box["width"])*width)));b=min(height,int(np.ceil((box["y"]+box["height"])*height)))
        protected[t:b,l:r]=255
    result[(frames>0)|(protected>0)|(envelopes==0)]=0
    Image.fromarray(result).save(args.output/"refined-mask-l.png")
    rgba=np.full((height,width,4),255,np.uint8);rgba[:,:,3]=255-result
    Image.fromarray(rgba).save(args.output/"refined-mask-rgba.png")
    checks={"pixelsOutsideEnvelope":int(np.count_nonzero((result>0)&(envelopes==0))),"protectedPixelsMasked":int(np.count_nonzero((result>0)&(protected>0))),"framePixelsMasked":int(np.count_nonzero((result>0)&(frames>0)))}
    if any(checks.values()) or sha(run/"normalized.png")!=original_hash or sha(args.refinement/"refined-mask-rgba.png")!=parent_hash:raise ValueError("BOUNDARY_OR_EVIDENCE_CHANGED")
    evidence={"scope":"SOURCE_HALO_PROFILE_POSTPROCESS_NO_NEW_AI_NO_INPAINTING","algorithm":"source-ink-radial-halo-v3-experimental","qualityStatus":"REQUIRES_REVIEW",
              "sourceJob":str(run),"parentCandidate":str(args.refinement),"profiles":str(args.profiles),"sourceSha256":original_hash,"parentMaskSha256":parent_hash,
              "candidatePixels":int(np.count_nonzero(result)),"addedPixels":int(np.count_nonzero((result>0)&(baseline==0))),"checks":checks,"regions":reports,
              "maskSha256":sha(args.output/"refined-mask-l.png"),"maskRgbaSha256":sha(args.output/"refined-mask-rgba.png")}
    (args.output/"radial-halo-report.json").write_text(json.dumps(evidence,indent=2),"utf-8")
    (args.output/"refinement-report.json").write_text(json.dumps({**report,"radialHaloRefinement":evidence,"parentCandidate":str(args.refinement)},indent=2),"utf-8")
    print(json.dumps({"output":str(args.output),"candidatePixels":evidence["candidatePixels"],"added":evidence["addedPixels"],"expandedCounts":[len(r["expandedGlyphs"]) for r in reports],"checks":checks}),flush=True)


if __name__=="__main__":main()
