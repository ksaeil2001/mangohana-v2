"""Local targeted experiment; raw and edge-filter masks remain separate."""
import importlib.util
import json
import math
from pathlib import Path
import sys
import cv2
import numpy as np
from PIL import Image

spec=importlib.util.spec_from_file_location("textmask",Path(__file__).with_name("text_mask.py"))
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.install_offline_guards()
root=Path("E:/Dev/Outputs/MangohanaV2-20261111")
output=Path(sys.argv[1])
output.mkdir(exist_ok=False)
evidence=json.loads((root/"vision-detector-20261110T201511390Z/evaluation.json").read_text("utf-8"))
pages=next(m["pages"] for m in evidence["models"] if m["model"]=="detector-v4-s_int8.onnx")
session=module.create_session(module.read_pinned_model(Path("E:/Dev/Models/MangohanaV2-vision/text-mask-onnx-20261110T203802715Z/comic-text-mask-unet-resnet18-384.onnx")))
reports=[]
for page_index,identity in [(0,"1-7"),(1,"2-20")]:
    page=pages[page_index]
    source=np.array(Image.open(page["input"]).convert("RGB"))
    height,width=source.shape[:2]
    detection=next(d for d in page["detections"] if d["id"]==identity)
    x1,y1,x2,y2=detection["boxPx"]
    for fraction in [.08,.24,.5,1.0]:
        margin=max(4,math.ceil(min(x2-x1,y2-y1)*fraction))
        left,top=max(0,math.floor(x1)-margin),max(0,math.floor(y1)-margin)
        right,bottom=min(width,math.ceil(x2)+margin),min(height,math.ceil(y2)+margin)
        crop=source[top:bottom,left:right]
        ch,cw=crop.shape[:2]
        scale=384/max(ch,cw)
        nh,nw=round(ch*scale),round(cw*scale)
        oy,ox=(384-nh)//2,(384-nw)//2
        square=np.zeros((384,384,3),np.uint8)
        square[oy:oy+nh,ox:ox+nw]=cv2.resize(crop,(nw,nh),interpolation=cv2.INTER_AREA)
        probability=session.run(["probability"],{"images":np.ascontiguousarray(square.transpose(2,0,1)[None])})[0]
        crop_prob=cv2.resize(probability[0,0,oy:oy+nh,ox:ox+nw],(cw,ch),interpolation=cv2.INTER_LINEAR)
        raw=(crop_prob>.5).astype(np.uint8)*255
        guarded,stats=module.guard_crop_mask(raw)
        for name,mask in [("raw",raw),("edge",guarded)]:
            overlay=crop.copy()
            selected=mask>0
            overlay[selected]=(overlay[selected].astype(np.float32)*.4+np.array([255,0,0])*.6).astype(np.uint8)
            Image.fromarray(overlay).save(output/f"{identity}-margin-{fraction}-{name}.png")
        count,labels,boxstats,centroids=cv2.connectedComponentsWithStats(raw,connectivity=8)
        edge=np.unique(np.concatenate((labels[0],labels[-1],labels[:,0],labels[:,-1])))
        reports.append({"id":identity,"margin":fraction,**stats,"edgeComponents":[{"bbox":boxstats[i].tolist(),"centroid":centroids[i].tolist()} for i in edge if i]})
(output/"comparison.json").write_text(json.dumps(reports,indent=2),"utf-8")
print("COMPARISON="+str(output))
