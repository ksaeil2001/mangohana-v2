"""Measure source brightness vs distance from compact supported ink."""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image


def profiles(refinement):
    report=json.loads((refinement/"refinement-report.json").read_text("utf-8"))
    source=np.array(Image.open(Path(report["sourceJob"])/"normalized.png").convert("RGB"))
    results=[]
    for region in report["regions"]:
        left,top,right,bottom=region["contextPx"]
        gray=cv2.cvtColor(source[top:bottom,left:right],cv2.COLOR_RGB2GRAY)
        _,labels,stats,_=cv2.connectedComponentsWithStats((gray<100).astype(np.uint8)*255,connectivity=8)
        selected=set(region["seedComponents"])|{c["id"] for c in region["addedSmallComponents"]}
        scale=region["fontScale"]
        for identity in selected:
            x,y,w,h,size=map(int,stats[identity])
            if max(w,h)>scale*.45 or max(w,h)/min(w,h)>2:continue
            max_radius=max(8,min(24,round(scale*.55)))
            l,t,r,b=max(0,x-max_radius),max(0,y-max_radius),min(gray.shape[1],x+w+max_radius),min(gray.shape[0],y+h+max_radius)
            component=(labels[t:b,l:r]==identity).astype(np.uint8)*255
            distance=cv2.distanceTransform(255-component,cv2.DIST_L2,5)
            pixels=gray[t:b,l:r]
            radial=[]
            for radius in range(1,max_radius+1):
                ring=(distance>radius-1)&(distance<=radius)
                radial.append({"r":radius,"whiteFraction":float(np.mean(pixels[ring]>235)),"medianGray":float(np.median(pixels[ring]))})
            results.append({"regionId":region["id"],"componentId":identity,"bboxPx":[x+left,y+top,w,h],"fontScale":scale,"sourcePixels":size,"profile":radial})
    return results


def main():
    parser=argparse.ArgumentParser();parser.add_argument("--refinement",type=Path,required=True);parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=False)
    result={"scope":"SOURCE_HALO_BRIGHTNESS_DIAGNOSIS_NO_AI","profiles":profiles(args.refinement)}
    (args.output/"halo-profiles.json").write_text(json.dumps(result,indent=2),"utf-8")
    print("HALO_PROFILES="+str(args.output))


if __name__=="__main__":main()
