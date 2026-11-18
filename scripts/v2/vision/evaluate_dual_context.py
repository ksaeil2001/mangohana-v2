"""PoC: consensus of two crop contexts; masks stay learned, never rectangles."""
import importlib.util
import json
import math
from pathlib import Path
import sys
import time
import cv2
import numpy as np
from PIL import Image

spec=importlib.util.spec_from_file_location("textmask",Path(__file__).with_name("text_mask.py"))
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.install_offline_guards()
root=Path("E:/Dev/Outputs/MangohanaV2-20261111")
output=Path(sys.argv[1]);output.mkdir(exist_ok=False)
evidence=json.loads((root/"vision-detector-20261110T201511390Z/evaluation.json").read_text("utf-8"))
pages=next(m["pages"] for m in evidence["models"] if m["model"]=="detector-v4-s_int8.onnx")
session=module.create_session(module.read_pinned_model(Path("E:/Dev/Models/MangohanaV2-vision/text-mask-onnx-20261110T203802715Z/comic-text-mask-unet-resnet18-384.onnx")))
reports=[]
for page_index,page in enumerate(pages):
    source=np.array(Image.open(page["input"]).convert("RGB"))
    height,width=source.shape[:2]
    whole_mask=np.zeros((height,width),np.uint8)
    page_reports=[]
    for region_index,detection in enumerate(d for d in page["detections"] if d["label"]==1):
        x1,y1,x2,y2=detection["boxPx"]
        contexts=[];inference=0
        for fraction in [.08,.24]:
            margin=max(4,math.ceil(min(x2-x1,y2-y1)*fraction))
            left,top=max(0,math.floor(x1)-margin),max(0,math.floor(y1)-margin)
            right,bottom=min(width,math.ceil(x2)+margin),min(height,math.ceil(y2)+margin)
            crop=source[top:bottom,left:right]
            ch,cw=crop.shape[:2];scale=384/max(ch,cw)
            nh,nw=round(ch*scale),round(cw*scale);oy,ox=(384-nh)//2,(384-nw)//2
            square=np.zeros((384,384,3),np.uint8)
            square[oy:oy+nh,ox:ox+nw]=cv2.resize(crop,(nw,nh),interpolation=cv2.INTER_AREA)
            start=time.perf_counter()
            probability=session.run(["probability"],{"images":np.ascontiguousarray(square.transpose(2,0,1)[None])})[0]
            inference+=(time.perf_counter()-start)*1000
            crop_prob=cv2.resize(probability[0,0,oy:oy+nh,ox:ox+nw],(cw,ch),interpolation=cv2.INTER_LINEAR)
            full=np.zeros((height,width),np.uint8)
            full[top:bottom,left:right]=(crop_prob>.5).astype(np.uint8)*255
            contexts.append(full)
        consensus=contexts[0]&contexts[1]
        consensus=cv2.dilate(consensus,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5)))
        # Detector bounds are a protection envelope, not a deletion rectangle.
        envelope=np.zeros_like(consensus)
        left,top=max(0,math.floor(x1)-2),max(0,math.floor(y1)-2)
        right,bottom=min(width,math.ceil(x2)+2),min(height,math.ceil(y2)+2)
        envelope[top:bottom,left:right]=255
        consensus &= envelope
        whole_mask |= consensus
        page_reports.append({"id":detection["id"],"maskPixels":int(np.count_nonzero(consensus)),"inferenceMs":inference})
        if (page_index==0 and detection["id"]=="1-7") or (page_index==1 and detection["id"]=="2-20"):
            margin=20
            l,t,r,b=max(0,left-margin),max(0,top-margin),min(width,right+margin),min(height,bottom+margin)
            image=source[t:b,l:r].copy();active=consensus[t:b,l:r]>0
            image[active]=(image[active].astype(np.float32)*.4+np.array([255,0,0])*.6).astype(np.uint8)
            Image.fromarray(image).save(output/f"{detection['id']}-consensus-overlay.png")
    prefix=f"{page_index+1:03d}"
    Image.fromarray(whole_mask).save(output/(prefix+"-consensus-mask.png"))
    image=source.copy();active=whole_mask>0
    image[active]=(image[active].astype(np.float32)*.4+np.array([255,0,0])*.6).astype(np.uint8)
    Image.fromarray(image).save(output/(prefix+"-consensus-overlay.png"))
    reports.append({"page":prefix,"regions":page_reports,"maskPixels":int(np.count_nonzero(whole_mask)),"inferenceMs":sum(r["inferenceMs"] for r in page_reports)})
    print(json.dumps({"page":prefix,"maskPixels":reports[-1]["maskPixels"],"inferenceMs":reports[-1]["inferenceMs"]}),flush=True)
(output/"consensus-evaluation.json").write_text(json.dumps({"scope":"TWO_CONTEXT_LEARNED_MASK_CONSENSUS_POC","pages":reports},indent=2),"utf-8")
print("CONSENSUS="+str(output))
