"""Candidate postprocessing of a real learned mask; no model/network calls.

The same rules apply to every selected ROI. Source-ink components, rather
than learned-mask connectivity, separate text from actual frame strokes.
No original/evidence/helper/config is modified. This is not a P0 approval.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import platform
import sys
import cv2
import numpy as np
from PIL import Image,ImageDraw


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def px(box,width,height,pad=0):
    return (max(0,math.floor(box["x"]*width)-pad),max(0,math.floor(box["y"]*height)-pad),
            min(width,math.ceil((box["x"]+box["width"])*width)+pad),min(height,math.ceil((box["y"]+box["height"])*height)+pad))


def area(box):
    return (box[2]-box[0])*(box[3]-box[1])


def intersection(a,b):
    return max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))


def overlay(source,mask,color=(255,0,0)):
    result=source.copy()
    active=mask>0
    result[active]=(result[active].astype(np.float32)*.4+np.array(color)*.6).astype(np.uint8)
    return result


def refine_region(source,baseline,text_box,context_box,source_quads):
    left,top,right,bottom=context_box
    pixels=source[top:bottom,left:right]
    gray=cv2.cvtColor(pixels,cv2.COLOR_RGB2GRAY)
    ink=(gray<100).astype(np.uint8)*255
    count,labels,stats,centroids=cv2.connectedComponentsWithStats(ink,connectivity=8)
    height,width=gray.shape
    local_baseline=baseline[top:bottom,left:right]>0
    tx1,ty1,tx2,ty2=text_box
    envelope=np.zeros_like(ink)
    envelope[max(0,ty1-top-2):min(height,ty2-top+2),max(0,tx1-left-2):min(width,tx2-left+2)]=255
    quad_mask=np.zeros_like(ink)
    for quad in source_quads:
        points=np.array([[round(p["x"]-left),round(p["y"]-top)] for p in quad],np.int32)
        cv2.fillPoly(quad_mask,[points],255)
    frame_ids=[];seed_ids=[];small=[];component_reports=[]
    for identity in range(1,count):
        x,y,w,h,pixels_count=map(int,stats[identity])
        component=labels==identity
        touches=x==0 or y==0 or x+w==width or y+h==height
        spans=w>.6*width and h>.6*height
        dense=pixels_count>.2*width*height
        is_frame=touches or spans or dense
        supported=int(np.count_nonzero(component&local_baseline))
        in_envelope=int(np.count_nonzero(component&(envelope>0)))
        in_quad=int(np.count_nonzero(component&(quad_mask>0)))
        seed=not is_frame and supported>=max(1,min(8,math.ceil(pixels_count*.15))) and in_envelope>0
        if is_frame:frame_ids.append(identity)
        elif seed:seed_ids.append(identity)
        elif in_envelope==pixels_count and pixels_count>=4:small.append(identity)
        component_reports.append({"id":identity,"bboxPx":[x+left,y+top,w,h],"pixels":pixels_count,"baselineSupport":supported,
                                  "insideEnvelope":in_envelope,"insideOcrQuad":in_quad,"frame":is_frame,"seed":seed})
    if not seed_ids:
        raise ValueError("NO_SOURCE_GLYPH_SEEDS")
    font_scale=float(np.percentile([max(stats[i,2],stats[i,3]) for i in seed_ids],75))
    proximity=max(4,round(font_scale*.35))
    selected=set(seed_ids);added=[]
    for _ in range(min(8,len(small))):
        core=np.isin(labels,list(selected)).astype(np.uint8)*255
        distance=cv2.distanceTransform(255-core,cv2.DIST_L2,5)
        accepted=[]
        for identity in small:
            if identity in selected:continue
            x,y,w,h,pixels_count=map(int,stats[identity])
            compact=max(w,h)<=font_scale*.45 and pixels_count<=font_scale*font_scale*.2 and max(w,h)/min(w,h)<=2
            if not compact:continue
            component=labels==identity
            nearest=float(distance[component].min())
            if nearest<=proximity:
                accepted.append(identity)
                added.append({"id":identity,"bboxPx":[x+left,y+top,w,h],"pixels":pixels_count,"distanceToExistingGlyph":nearest})
        if not accepted:break
        selected.update(accepted)
    core=np.isin(labels,list(selected)).astype(np.uint8)*255
    halo_radius=max(3,min(10,round(font_scale*.15)))
    halo=cv2.dilate(core,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(halo_radius*2+1,halo_radius*2+1)))
    near=cv2.dilate(core,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(halo_radius*2+5,halo_radius*2+5)))
    candidate=halo|(local_baseline.astype(np.uint8)*255&near)
    frame=np.isin(labels,frame_ids).astype(np.uint8)*255
    frame_guard=cv2.dilate(frame,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5)))
    candidate &= envelope
    candidate[frame_guard>0]=0
    if not candidate.any():raise ValueError("EMPTY_REFINED_MASK")
    return candidate,frame_guard,{"contextPx":context_box,"textBboxPx":text_box,"fontScale":font_scale,"haloRadius":halo_radius,
                                 "proximityPx":proximity,"frameComponents":frame_ids,"seedComponents":seed_ids,"addedSmallComponents":added,
                                 "components":component_reports,"maskPixels":int(np.count_nonzero(candidate)),
                                 "framePixelsMasked":int(np.count_nonzero((candidate>0)&(frame>0)))}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--run",required=True,type=Path)
    parser.add_argument("--output",required=True,type=Path)
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=False)
    platform.system()
    def deny(event,_args):
        if event.startswith("socket.") or event in ("subprocess.Popen","os.system","os.posix_spawn","os.fork","os.exec"):
            raise RuntimeError("OFFLINE_ONLY")
    sys.addaudithook(deny)
    files=["normalized.png","removal-mask.png","raw-ocr.json","region-selection.json","cleaned.png"]
    original_hashes={name:sha(args.run/name) for name in files}
    source=np.array(Image.open(args.run/"normalized.png").convert("RGB"))
    baseline=np.where(np.array(Image.open(args.run/"removal-mask.png").convert("RGBA"))[:,:,3]==0,255,0).astype(np.uint8)
    raw=json.loads((args.run/"raw-ocr.json").read_text("utf-8"))
    selection=json.loads((args.run/"region-selection.json").read_text("utf-8"))
    height,width=baseline.shape
    result=np.zeros_like(baseline);frames=np.zeros_like(baseline);envelopes=np.zeros_like(baseline);reports=[]
    decisions=selection["selection"]["decisions"];detections=selection["detection"]["regions"]
    identities=list(dict.fromkeys(d["detectorRegionId"] for d in decisions if d["action"]=="translate"))
    for index,identity in enumerate(identities):
        detection=next(d for d in detections if d["id"]==identity)
        box=px(detection["bbox"],width,height)
        options=[px(d["bbox"],width,height,8) for d in detections if d["kind"]=="bubble" and intersection(box,px(d["bbox"],width,height))>.8*area(box)]
        context=min(options,key=area) if options else px(detection["bbox"],width,height,max(12,round(min(box[2]-box[0],box[3]-box[1])*.3)))
        # Include the target rectangle even if the frame detector underestimates.
        context=(min(context[0],box[0]-4),min(context[1],box[1]-4),max(context[2],box[2]+4),max(context[3],box[3]+4))
        context=(max(0,context[0]),max(0,context[1]),min(width,context[2]),min(height,context[3]))
        members=[r for r in raw["speechBubbles"] if any(d["id"]==r["id"] and d["action"]=="translate" and d.get("detectorRegionId")==identity for d in decisions)]
        quads=[quad for member in members for quad in member.get("productionOcrProvenance",{}).get("sourceQuadsPx",[])]
        refined,frame,report=refine_region(source,baseline,box,context,quads)
        left,top,right,bottom=context
        result[top:bottom,left:right] |= refined
        frames[top:bottom,left:right] |= frame
        ex1,ey1,ex2,ey2=px(detection["bbox"],width,height,2)
        envelopes[ey1:ey2,ex1:ex2]=255
        crop=source[top:bottom,left:right]
        panels=[Image.fromarray(crop),Image.fromarray(overlay(crop,baseline[top:bottom,left:right])),Image.fromarray(overlay(crop,refined))]
        cw,ch=panels[0].size;sheet=Image.new("RGB",(cw*3,ch+30),"white");draw=ImageDraw.Draw(sheet)
        for col,(label,panel) in enumerate(zip(["source","baseline learned","source component candidate"],panels)):
            sheet.paste(panel,(col*cw,30));draw.text((col*cw+3,5),label,fill="black")
        sheet.save(args.output/f"region-{index:02d}-comparison.png")
        report.update({"id":identity,"ocrIds":[r["id"] for r in members]});reports.append(report)
    protected=np.zeros_like(result)
    preserved={d["id"] for d in decisions if d["action"]=="preserve"}
    for region in [r for r in raw["speechBubbles"] if r["id"] in preserved]+raw["nonSpeechText"]:
        l,t,r,b=px(region["bbox"],width,height);protected[t:b,l:r]=255
    # All physical frame components are protected across overlapping contexts.
    result[(frames>0)|(protected>0)|(envelopes==0)]=0
    for report in reports:
        box=report["textBboxPx"];l,t,r,b=box
        if not result[max(0,t-2):min(height,b+2),max(0,l-2):min(width,r+2)].any():raise ValueError("EMPTY_REFINED_REGION")
    Image.fromarray(result).save(args.output/"refined-mask-l.png")
    rgba=np.full((height,width,4),255,np.uint8);rgba[:,:,3]=255-result
    Image.fromarray(rgba).save(args.output/"refined-mask-rgba.png")
    Image.fromarray(overlay(source,result)).save(args.output/"refined-overlay.png")
    delta=source.copy();added=(result>0)&(baseline==0);removed=(result==0)&(baseline>0)
    delta[added]=(delta[added].astype(np.float32)*.3+np.array([0,255,0])*.7).astype(np.uint8)
    delta[removed]=(delta[removed].astype(np.float32)*.3+np.array([0,100,255])*.7).astype(np.uint8)
    Image.fromarray(delta).save(args.output/"delta-overlay-green-added-blue-removed.png")
    checks={"pixelsOutsideEnvelope":int(np.count_nonzero((result>0)&(envelopes==0))),
            "protectedPixelsMasked":int(np.count_nonzero((result>0)&(protected>0))),
            "framePixelsMasked":int(np.count_nonzero((result>0)&(frames>0)))}
    if any(checks.values()) or original_hashes!={name:sha(args.run/name) for name in files}:raise ValueError("BOUNDARY_OR_EVIDENCE_CHANGED")
    report={"scope":"POSTPROCESS_REAL_LEARNED_MASK_NO_NEW_AI_NO_INPAINTING","algorithm":"source-ink-components-v1-experimental",
            "qualityStatus":"REQUIRES_REVIEW","sourceJob":str(args.run),"sourceHashes":original_hashes,"originalEvidencePreserved":True,
            "baselinePixels":int(np.count_nonzero(baseline)),"candidatePixels":int(np.count_nonzero(result)),"addedPixels":int(np.count_nonzero(added)),
            "removedPixels":int(np.count_nonzero(removed)),"checks":checks,"regions":reports,
            "maskRgbaSha256":sha(args.output/"refined-mask-rgba.png"),"maskSha256":sha(args.output/"refined-mask-l.png")}
    (args.output/"refinement-report.json").write_text(json.dumps(report,indent=2),"utf-8")
    print(json.dumps({"output":str(args.output),"pixels":report["candidatePixels"],"added":report["addedPixels"],"removed":report["removedPixels"],"checks":checks}),flush=True)


if __name__=="__main__":
    main()
