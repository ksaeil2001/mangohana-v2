"""Recover bounded source-white halos enclosing supported compact glyphs.

Uses no text strings, IDs, page coordinates, model calls or remote services.
The candidate remains review-required; all historical inputs stay untouched.
"""
import argparse
import hashlib
import json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image,ImageDraw


def sha(file):return hashlib.sha256(file.read_bytes()).hexdigest()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--refinement",required=True,type=Path)
    parser.add_argument("--output",required=True,type=Path)
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=False)
    report=json.loads((args.refinement/"refinement-report.json").read_text("utf-8"))
    run=Path(report["sourceJob"])
    source=np.array(Image.open(run/"normalized.png").convert("RGB"))
    original_hash=sha(run/"normalized.png")
    old_hash=sha(args.refinement/"refined-mask-rgba.png")
    baseline=np.where(np.array(Image.open(args.refinement/"refined-mask-rgba.png").convert("RGBA"))[:,:,3]==0,255,0).astype(np.uint8)
    result=baseline.copy();height,width=result.shape
    global_frames=np.zeros_like(result);envelopes=np.zeros_like(result);reports=[]
    raw=json.loads((run/"raw-ocr.json").read_text("utf-8"));selection=json.loads((run/"region-selection.json").read_text("utf-8"))
    preserved={d["id"] for d in selection["selection"]["decisions"] if d["action"]=="preserve"}
    protected=np.zeros_like(result)
    for region in [r for r in raw["speechBubbles"] if r["id"] in preserved]+raw["nonSpeechText"]:
        box=region["bbox"];l=int(np.floor(box["x"]*width));t=int(np.floor(box["y"]*height));r=int(np.ceil((box["x"]+box["width"])*width));b=int(np.ceil((box["y"]+box["height"])*height))
        protected[t:b,l:r]=255
    for index,region in enumerate(report["regions"]):
        left,top,right,bottom=region["contextPx"]
        source_crop=source[top:bottom,left:right]
        gray=cv2.cvtColor(source_crop,cv2.COLOR_RGB2GRAY)
        ink=(gray<100).astype(np.uint8)*255
        count,labels,stats,centroids=cv2.connectedComponentsWithStats(ink,connectivity=8)
        selected=set(region["seedComponents"])|{c["id"] for c in region["addedSmallComponents"]}
        scale=region["fontScale"]
        compact=[i for i in selected if max(stats[i,2],stats[i,3])<=scale*.45 and max(stats[i,2],stats[i,3])/min(stats[i,2],stats[i,3])<=2]
        bright=(gray>235).astype(np.uint8)*255
        white_count,white_labels,white_stats,_=cv2.connectedComponentsWithStats(bright,connectivity=8)
        additions=np.zeros_like(gray);accepted=[]
        for identity in range(1,white_count):
            x,y,w,h,size=map(int,white_stats[identity])
            if x==0 or y==0 or x+w==gray.shape[1] or y+h==gray.shape[0]:continue
            # A full background or a long image highlight is not a glyph halo.
            if min(w,h)>scale*.9 or size>scale*scale*3:continue
            blob=(white_labels==identity).astype(np.uint8)*255
            contours,_=cv2.findContours(blob,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
            filled=np.zeros_like(blob);cv2.drawContours(filled,contours,-1,255,cv2.FILLED)
            surrounded=[i for i in compact if np.count_nonzero((labels==i)&(filled>0))>=.8*stats[i,4]]
            if not surrounded or max(w,h)>scale*(.65*len(surrounded)+.35):continue
            known=np.isin(labels,list(selected))
            unknown=int(np.count_nonzero((ink>0)&(filled>0)&~known))
            total_ink=int(np.count_nonzero((ink>0)&(filled>0)))
            if unknown>max(3,total_ink*.02):continue
            ink_area=sum(int(stats[i,4]) for i in surrounded)
            if size>ink_area*15+scale*scale*.3:continue
            recovered=cv2.dilate(filled,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5)))
            additions |= recovered
            accepted.append({"whiteComponentId":identity,"bboxPx":[x+left,y+top,w,h],"whitePixels":size,"surroundedInkComponents":surrounded,
                             "unknownInkPixels":unknown,"recoveredPixels":int(np.count_nonzero(recovered))})
        tx1,ty1,tx2,ty2=region["textBboxPx"]
        envelope=np.zeros_like(gray)
        envelope[max(0,ty1-top-2):min(gray.shape[0],ty2-top+2),max(0,tx1-left-2):min(gray.shape[1],tx2-left+2)]=255
        frame=np.isin(labels,region["frameComponents"]).astype(np.uint8)*255
        frame=cv2.dilate(frame,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5)))
        global_frames[top:bottom,left:right] |= frame
        envelopes[top:bottom,left:right] |= envelope
        additions[(frame>0)|(envelope==0)]=0
        result[top:bottom,left:right] |= additions
        crop_result=result[top:bottom,left:right]
        panels=[]
        for mask in [baseline[top:bottom,left:right],crop_result]:
            image=source_crop.copy();active=mask>0
            image[active]=(image[active].astype(np.float32)*.4+np.array([255,0,0])*.6).astype(np.uint8)
            panels.append(Image.fromarray(image))
        cw,ch=panels[0].size;sheet=Image.new("RGB",(cw*2,ch+30),"white");draw=ImageDraw.Draw(sheet)
        for col,(label,panel) in enumerate(zip(["source-ink v1","bounded-white-halo candidate"],panels)):
            sheet.paste(panel,(col*cw,30));draw.text((col*cw+3,5),label,fill="black")
        sheet.save(args.output/f"region-{index:02d}-halo-comparison.png")
        reports.append({"id":region["id"],"acceptedHalos":accepted,"contextPx":region["contextPx"],"textBboxPx":region["textBboxPx"]})
    result[(global_frames>0)|(protected>0)|(envelopes==0)]=0
    Image.fromarray(result).save(args.output/"refined-mask-l.png")
    rgba=np.full((height,width,4),255,np.uint8);rgba[:,:,3]=255-result
    Image.fromarray(rgba).save(args.output/"refined-mask-rgba.png")
    checks={"pixelsOutsideEnvelope":int(np.count_nonzero((result>0)&(envelopes==0))),"protectedPixelsMasked":int(np.count_nonzero((result>0)&(protected>0))),
            "framePixelsMasked":int(np.count_nonzero((result>0)&(global_frames>0)))}
    if any(checks.values()) or sha(run/"normalized.png")!=original_hash or sha(args.refinement/"refined-mask-rgba.png")!=old_hash:
        raise ValueError("BOUNDARY_OR_EVIDENCE_CHANGED")
    output_report={"scope":"BOUNDED_HALO_POSTPROCESS_NO_NEW_AI_NO_INPAINTING","qualityStatus":"REQUIRES_REVIEW",
                   "algorithm":"source-ink-components-bounded-white-halo-v2-experimental","sourceJob":str(run),"parentCandidate":str(args.refinement),
                   "originalSourceSha256":original_hash,"parentMaskSha256":old_hash,"candidatePixels":int(np.count_nonzero(result)),
                   "addedPixels":int(np.count_nonzero((result>0)&(baseline==0))),"checks":checks,"regions":reports,
                   "maskSha256":sha(args.output/"refined-mask-l.png"),"maskRgbaSha256":sha(args.output/"refined-mask-rgba.png")}
    (args.output/"halo-report.json").write_text(json.dumps(output_report,indent=2),"utf-8")
    # Same region geometry lets the existing stage review inspect every ROI.
    (args.output/"refinement-report.json").write_text(json.dumps({**report,"haloRefinement":output_report,"parentCandidate":str(args.refinement)},indent=2),"utf-8")
    print(json.dumps({"output":str(args.output),"pixels":output_report["candidatePixels"],"added":output_report["addedPixels"],"haloCounts":[len(r["acceptedHalos"]) for r in reports],"checks":checks}),flush=True)


if __name__=="__main__":main()
