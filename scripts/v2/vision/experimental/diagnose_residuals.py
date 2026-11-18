"""Read-only source/evidence diagnosis; writes only a new supplied output dir."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pixels(box,width,height,padding=0):
    return (max(0,math.floor(box["x"]*width)-padding),max(0,math.floor(box["y"]*height)-padding),
            min(width,math.ceil((box["x"]+box["width"])*width)+padding),
            min(height,math.ceil((box["y"]+box["height"])*height)+padding))


def overlap(a,b):
    return max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--run",required=True,type=Path)
    parser.add_argument("--output",required=True,type=Path)
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=False)
    names=["normalized.png","cleaned.png","candidate.png","raw-ocr.json","region-selection.json","removal-mask.png","learned-mask-evidence.json"]
    original_hashes={name:digest(args.run/name) for name in names}
    raw=json.loads((args.run/"raw-ocr.json").read_text("utf-8"))
    selection=json.loads((args.run/"region-selection.json").read_text("utf-8"))
    evidence=json.loads((args.run/"learned-mask-evidence.json").read_text("utf-8"))
    source=Image.open(args.run/"normalized.png").convert("RGB")
    cleaned=Image.open(args.run/"cleaned.png").convert("RGB")
    candidate=Image.open(args.run/"candidate.png").convert("RGB")
    width,height=source.size
    rgba=np.array(Image.open(args.run/"removal-mask.png").convert("RGBA"))
    mask=rgba[:,:,3]==0
    source_array=np.array(source)
    detections=selection["detection"]["regions"]
    decisions=selection["selection"]["decisions"]
    reports=[]
    for index,identity in enumerate(dict.fromkeys(d["detectorRegionId"] for d in decisions if d["action"]=="translate")):
        detection=next(d for d in detections if d["id"]==identity)
        box=pixels(detection["bbox"],width,height)
        margin=max(20,math.ceil(min(box[2]-box[0],box[3]-box[1])*.25))
        left,top,right,bottom=pixels(detection["bbox"],width,height,margin)
        members=[r for r in raw["speechBubbles"] if any(d["id"]==r["id"] and d.get("detectorRegionId")==identity and d["action"]=="translate" for d in decisions)]
        frames=[d for d in detections if d["kind"]=="bubble" and overlap(box,pixels(d["bbox"],width,height))>.8*(box[2]-box[0])*(box[3]-box[1])]
        frames.sort(key=lambda d: d["bbox"]["width"]*d["bbox"]["height"])
        overlay=source_array[top:bottom,left:right].copy()
        active=mask[top:bottom,left:right]
        overlay[active]=(overlay[active].astype(np.float32)*.4+np.array([255,0,0])*.6).astype(np.uint8)
        panels=[source.crop((left,top,right,bottom)),Image.fromarray(overlay),cleaned.crop((left,top,right,bottom)),candidate.crop((left,top,right,bottom))]
        cw,ch=panels[0].size
        sheet=Image.new("RGB",(cw*4,ch+30),"white")
        draw=ImageDraw.Draw(sheet)
        for col,(label,panel) in enumerate(zip(["source","mask overlay","cleaned","candidate"],panels)):
            sheet.paste(panel,(col*cw,30));draw.text((col*cw+3,5),label,fill="black")
        sheet.save(args.output/f"region-{index:02d}-comparison.png")
        source.crop((left,top,right,bottom)).save(args.output/f"region-{index:02d}-source.png")
        reports.append({"index":index,"detectorId":identity,"detectorBboxPx":box,"cropPx":[left,top,right,bottom],
                        "bubbleFrames":[{"id":d["id"],"bboxPx":pixels(d["bbox"],width,height)} for d in frames],
                        "ocrMembers":[{"id":r["id"],"text":r["text"],"bboxPx":pixels(r["bbox"],width,height),
                                       "sourceQuadsPx":r.get("productionOcrProvenance",{}).get("sourceQuadsPx",[])} for r in members]})
    if original_hashes!={name:digest(args.run/name) for name in names}:
        raise ValueError("EXISTING_EVIDENCE_CHANGED")
    report={"scope":"READ_ONLY_RESIDUAL_DIAGNOSIS_NO_AI_OR_INPAINTING","sourceJob":str(args.run),"sourceHashes":original_hashes,
            "selected":selection["selection"],"model":evidence["model"],"regions":reports,"originalEvidencePreserved":True}
    (args.output/"diagnosis.json").write_text(json.dumps(report,indent=2,ensure_ascii=False),"utf-8")
    print("DIAGNOSIS="+str(args.output),flush=True)


if __name__=="__main__":
    main()
