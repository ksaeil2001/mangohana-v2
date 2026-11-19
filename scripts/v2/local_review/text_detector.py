"""Independent full-page text-line detections from the pinned RapidOCR ONNX model."""
import hashlib

MODEL_SHA='d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9'


class TextDetector:
    def __init__(self,path):
        import onnxruntime as ort
        raw=path.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=MODEL_SHA:
            raise ValueError('unexpected independent OCR detector')
        options=ort.SessionOptions()
        options.intra_op_num_threads=2
        options.inter_op_num_threads=1
        options.add_session_config_entry('session.intra_op.allow_spinning','0')
        self.session=ort.InferenceSession(raw,options,providers=['CPUExecutionProvider'])
        self.session.disable_fallback()

    def __call__(self,image):
        import cv2
        import numpy as np
        w,h=image.size
        scale=min(1536/max(w,h),1)
        nw,nh=max(32,round(w*scale/32)*32),max(32,round(h*scale/32)*32)
        bgr=cv2.cvtColor(np.asarray(image),cv2.COLOR_RGB2BGR)
        tensor=cv2.resize(bgr,(nw,nh)).astype(np.float32)/255
        tensor=(tensor-np.array([.485,.456,.406],np.float32))/np.array([.229,.224,.225],np.float32)
        prob=self.session.run(None,{self.session.get_inputs()[0].name:np.ascontiguousarray(tensor.transpose(2,0,1)[None])})[0][0,0]
        if prob.shape!=(nh,nw) or not np.isfinite(prob).all():
            raise ValueError('unexpected independent OCR output')
        found=[]
        contours,_=cv2.findContours((prob>.3).astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        for index,points in enumerate(contours):
            x,y,width,height=cv2.boundingRect(points)
            if min(width,height)<3:
                continue
            mask=np.zeros((height,width),np.uint8)
            cv2.fillPoly(mask,[points-np.array([[[x,y]]])],1)
            score=float(cv2.mean(prob[y:y+height,x:x+width],mask)[0])
            if score<.60:
                continue
            pad=max(2,round(min(width,height)*.46))
            l,t=max(0,x-pad)/nw,max(0,y-pad)/nh
            r,b=min(nw,x+width+pad)/nw,min(nh,y+height+pad)/nh
            found.append(dict(id=f'db-{index}',kind='text_free',confidence=score,
                              bbox=dict(x=l,y=t,width=r-l,height=b-t)))
        return found
