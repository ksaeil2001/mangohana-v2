"""Same candidate on cached real detector/mask pages, without invented OCR."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import math
import cv2
import numpy as np
from PIL import Image,ImageDraw


def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+".py"))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def main():
    parser=argparse.ArgumentParser();parser.add_argument("--detector-evidence",type=Path,required=True);parser.add_argument("--mask-evidence",type=Path,required=True);parser.add_argument("--output",type=Path,required=True);parser.add_argument("--skip",type=int,default=0)
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=False)
    component=load("refine_source_components");radial=load("radial_halo_candidate")
    detectors=json.loads(args.detector_evidence.read_text("utf-8"))["results"]
    masks=json.loads(args.mask_evidence.read_text("utf-8"))["results"];reports=[]
    for page in masks[args.skip:]:
        source_bytes=Path(page["input"]).read_bytes()
        if hashlib.sha256(source_bytes).hexdigest()!=page["imageSha256"]:raise ValueError("SOURCE_CHANGED")
        source=np.array(Image.open(page["input"]).convert("RGB"));height,width=source.shape[:2]
        detection=next(p for p in detectors if p["imageSha256"]==page["imageSha256"])
        mask_name=Path(page["input"]).name[:3]+"-mask-rgba.png"
        baseline_file=args.mask_evidence.parent/mask_name
        if hashlib.sha256(baseline_file.read_bytes()).hexdigest()!=page["maskRgbaSha256"]:raise ValueError("BASELINE_CHANGED")
        baseline=np.where(np.array(Image.open(baseline_file).convert("RGBA"))[:,:,3]==0,255,0).astype(np.uint8)
        result=np.zeros_like(baseline);frames=np.zeros_like(baseline);envelopes=np.zeros_like(baseline);region_reports=[]
        page_dir=args.output/Path(page["input"]).name[:3];page_dir.mkdir()
        for index,detected in enumerate(d for d in detection["regions"] if d["kind"]=="text_bubble"):
            box=component.px(detected["bbox"],width,height)
            contexts=[component.px(d["bbox"],width,height,8) for d in detection["regions"] if d["kind"]=="bubble" and component.intersection(box,component.px(d["bbox"],width,height))>.8*component.area(box)]
            context=min(contexts,key=component.area) if contexts else component.px(detected["bbox"],width,height,max(12,round(min(box[2]-box[0],box[3]-box[1])*.3)))
            context=(max(0,min(context[0],box[0]-4)),max(0,min(context[1],box[1]-4)),min(width,max(context[2],box[2]+4)),min(height,max(context[3],box[3]+4)))
            refined,frame,stats=component.refine_region(source,baseline,box,context,[])
            left,top,right,bottom=context;gray=cv2.cvtColor(source[top:bottom,left:right],cv2.COLOR_RGB2GRAY)
            _,labels,ink_stats,_=cv2.connectedComponentsWithStats((gray<100).astype(np.uint8)*255,connectivity=8)
            selected=set(stats["seedComponents"])|{c["id"] for c in stats["addedSmallComponents"]};scale=stats["fontScale"];expansions=[]
            for identity in selected:
                x,y,w,h,size=map(int,ink_stats[identity])
                if max(w,h)>scale*.45 or max(w,h)/min(w,h)>2:continue
                maximum=max(8,min(24,round(scale*.55)))
                l,t,r,b=max(0,x-maximum),max(0,y-maximum),min(gray.shape[1],x+w+maximum),min(gray.shape[0],y+h+maximum)
                core=(labels[t:b,l:r]==identity).astype(np.uint8)*255;distance=cv2.distanceTransform(255-core,cv2.DIST_L2,5);pixels=gray[t:b,l:r]
                profile=[]
                for radius in range(1,maximum+1):
                    ring=(distance>radius-1)&(distance<=radius)
                    profile.append({"r":radius,"whiteFraction":float(np.mean(pixels[ring]>235)),"medianGray":float(np.median(pixels[ring]))})
                radius=radial.select_radius(profile,stats["haloRadius"],scale)
                if radius:
                    refined |= cv2.dilate((labels==identity).astype(np.uint8)*255,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(2*radius+1,2*radius+1)))
                    expansions.append({"componentId":identity,"radius":radius})
            envelope=np.zeros_like(refined);x1,y1,x2,y2=box
            envelope[max(0,y1-top-2):min(refined.shape[0],y2-top+2),max(0,x1-left-2):min(refined.shape[1],x2-left+2)]=255
            refined[(frame>0)|(envelope==0)]=0
            result[top:bottom,left:right] |= refined;frames[top:bottom,left:right] |= frame;envelopes[top:bottom,left:right] |= envelope
            crop=source[top:bottom,left:right];panels=[Image.fromarray(crop),Image.fromarray(component.overlay(crop,baseline[top:bottom,left:right])),Image.fromarray(component.overlay(crop,refined))]
            cw,ch=panels[0].size;sheet=Image.new("RGB",(cw*3,ch+30),"white");draw=ImageDraw.Draw(sheet)
            for col,(label,panel) in enumerate(zip(["source","real learned baseline","experimental components+halo"],panels)):
                sheet.paste(panel,(col*cw,30));draw.text((col*cw+3,5),label,fill="black")
            sheet.save(page_dir/f"region-{index:02d}-comparison.png")
            region_reports.append({"id":detected["id"],**stats,"haloExpansions":expansions})
        # Free text is protected conservatively; no OCR has been run here.
        protected=np.zeros_like(result)
        for region in detection["regions"]:
            if region["kind"]=="text_free":
                l,t,r,b=component.px(region["bbox"],width,height);protected[t:b,l:r]=255
        result[(frames>0)|(envelopes==0)|(protected>0)]=0
        Image.fromarray(result).save(page_dir/"refined-mask-l.png")
        Image.fromarray(component.overlay(source,result)).save(page_dir/"refined-overlay.png")
        checks={"outsideEnvelope":int(np.count_nonzero((result>0)&(envelopes==0))),"framePixels":int(np.count_nonzero((result>0)&(frames>0))),"freeTextPixels":int(np.count_nonzero((result>0)&(protected>0)))}
        if any(checks.values()) or hashlib.sha256(Path(page["input"]).read_bytes()).hexdigest()!=page["imageSha256"]:raise ValueError("BOUNDARY_OR_SOURCE_CHANGED")
        reports.append({"source":page["input"],"sourceSha256":page["imageSha256"],"baselineMaskSha256":page["maskRgbaSha256"],"baselinePixels":int(np.count_nonzero(baseline)),"candidatePixels":int(np.count_nonzero(result)),"checks":checks,"regions":region_reports})
        print(json.dumps({"page":page_dir.name,"regions":len(region_reports),"pixels":reports[-1]["candidatePixels"],"checks":checks}),flush=True)
    (args.output/"additional-pages-report.json").write_text(json.dumps({"scope":"REAL_CACHED_LEARNED_MASK_POSTPROCESS_NO_OCR_NO_INPAINTING","qualityStatus":"REQUIRES_REVIEW","pages":reports},indent=2),"utf-8")
    print("ADDITIONAL_PAGES="+str(args.output))


if __name__=="__main__":main()
