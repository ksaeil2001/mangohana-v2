"""Bounded, current-image-only source ink/radial halo postprocessing.

Inputs are RGB uint8 pixels, a current learned binary mask, and normalized
text boxes. No file access, model, OCR text, quad, bubble metadata, IDs or
coordinates from any previous run are needed. Pixel selection never uses IDs.
"""
import math
import cv2
import numpy as np

ALGORITHM="source-ink-radial-halo-v3-experimental"
CLIP_PADDING=2
MAX_PIXELS=12_000_000
MAX_SIDE=8000
MAX_REGIONS=64
MAX_TOTAL_CONTEXT_PIXELS=48_000_000
MAX_COMPONENTS=100_000
MAX_DIAGNOSTICS=128


def plan_regions(width,height,regions):
    if (type(width) is not int or type(height) is not int or not 0<width<=MAX_SIDE or not 0<height<=MAX_SIDE
            or width*height>MAX_PIXELS or not isinstance(regions,list) or not 1<=len(regions)<=MAX_REGIONS):
        raise ValueError("INPUT_LIMIT")
    seen=set();plans=[];total=0
    for region in regions:
        if not isinstance(region,dict) or set(region)!={"id","bbox"}:raise ValueError("INVALID_REGION")
        identity,box=region["id"],region["bbox"]
        if not isinstance(identity,str) or not 1<=len(identity)<=128 or identity in seen:raise ValueError("INVALID_REGION_ID")
        seen.add(identity)
        if not isinstance(box,dict) or set(box)!={"x","y","width","height"}:raise ValueError("INVALID_BBOX")
        if any(type(v) not in (int,float) or not math.isfinite(v) for v in box.values()):raise ValueError("INVALID_BBOX")
        x,y,w,h=box["x"],box["y"],box["width"],box["height"]
        if not (0<=x<1 and 0<=y<1 and 0<w<=1 and 0<h<=1 and x+w<=1+1e-9 and y+h<=1+1e-9):raise ValueError("INVALID_BBOX")
        l,t=max(0,math.floor(x*width)),max(0,math.floor(y*height))
        r,b=min(width,math.ceil((x+w)*width)),min(height,math.ceil((y+h)*height))
        margin=max(12,round(min(r-l,b-t)*.3))
        context=(max(0,l-margin),max(0,t-margin),min(width,r+margin),min(height,b+margin))
        envelope=(max(0,l-2),max(0,t-2),min(width,r+2),min(height,b+2))
        total+=(context[2]-context[0])*(context[3]-context[1])
        if total>MAX_TOTAL_CONTEXT_PIXELS:raise ValueError("CONTEXT_BUDGET")
        plans.append({"id":identity,"box":(l,t,r,b),"context":context,"envelope":envelope})
    return plans


def select_radius(profile,baseline_radius,font_scale):
    if max((p["whiteFraction"] for p in profile if 2<=p["r"]<=4),default=0)<.8:return None
    cap=max(3,min(12,round(font_scale*.35)))
    for current,next_ring in zip(profile,profile[1:]):
        if current["r"]<3 or current["r"]+2>cap:continue
        if current["whiteFraction"]<.65 and next_ring["whiteFraction"]<.65 and current["medianGray"]<235:
            radius=current["r"]+2
            return radius if radius>baseline_radius else None
    return None


def radial_profile(gray,labels,identity,box,font_scale):
    x,y,w,h=box
    maximum=max(8,min(24,round(font_scale*.55)))
    l,t,r,b=max(0,x-maximum),max(0,y-maximum),min(gray.shape[1],x+w+maximum),min(gray.shape[0],y+h+maximum)
    core=(labels[t:b,l:r]==identity).astype(np.uint8)*255
    distance=cv2.distanceTransform(255-core,cv2.DIST_L2,5)
    pixels=gray[t:b,l:r];profile=[]
    for radius in range(1,maximum+1):
        ring=(distance>radius-1)&(distance<=radius)
        if not ring.any():break
        profile.append({"r":radius,"whiteFraction":float(np.mean(pixels[ring]>235)),"medianGray":float(np.median(pixels[ring]))})
    return profile


def refine_region(source,baseline,plan):
    left,top,right,bottom=plan["context"]
    pixels=source[top:bottom,left:right]
    gray=cv2.cvtColor(pixels,cv2.COLOR_RGB2GRAY)
    count,labels,stats,_=cv2.connectedComponentsWithStats((gray<100).astype(np.uint8)*255,connectivity=8)
    if count>MAX_COMPONENTS:raise ValueError("SOURCE_COMPONENT_LIMIT")
    height,width=gray.shape
    ex1,ey1,ex2,ey2=plan["envelope"]
    envelope=np.zeros_like(gray);envelope[ey1-top:ey2-top,ex1-left:ex2-left]=255
    local_baseline=(baseline[top:bottom,left:right]>0)&(envelope>0)
    support=np.bincount(labels[local_baseline].ravel(),minlength=count)
    inside=np.bincount(labels[envelope>0].ravel(),minlength=count)
    frame_ids=[];seed_ids=[];small=[]
    for identity in range(1,count):
        x,y,w,h,size=map(int,stats[identity])
        frame=(x==0 or y==0 or x+w==width or y+h==height or (w>.6*width and h>.6*height) or size>.2*width*height)
        if frame:frame_ids.append(identity)
        elif support[identity]>=max(1,min(8,math.ceil(size*.15))) and inside[identity]>0:seed_ids.append(identity)
        elif inside[identity]==size and size>=4:small.append(identity)
    if not seed_ids:raise ValueError("NO_SOURCE_GLYPH_SEEDS")
    font_scale=float(np.percentile([max(stats[i,2],stats[i,3]) for i in seed_ids],75))
    proximity=max(4,round(font_scale*.35));selected=set(seed_ids);added=[]
    for _ in range(min(8,len(small))):
        core=np.isin(labels,list(selected)).astype(np.uint8)*255
        distance=cv2.distanceTransform(255-core,cv2.DIST_L2,5);accepted=[]
        for identity in small:
            if identity in selected:continue
            x,y,w,h,size=map(int,stats[identity])
            if max(w,h)>font_scale*.45 or size>font_scale*font_scale*.2 or max(w,h)/min(w,h)>2:continue
            local=labels[y:y+h,x:x+w]==identity
            nearest=float(distance[y:y+h,x:x+w][local].min())
            if nearest<=proximity:
                accepted.append(identity)
                added.append({"bboxPx":{"x":x+left,"y":y+top,"width":w,"height":h},"pixels":size,"distancePx":nearest})
        if not accepted:break
        selected.update(accepted)
    core=np.isin(labels,list(selected)).astype(np.uint8)*255
    halo_radius=max(3,min(10,round(font_scale*.15)))
    halo=cv2.dilate(core,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(halo_radius*2+1,halo_radius*2+1)))
    near=cv2.dilate(core,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(halo_radius*2+5,halo_radius*2+5)))
    candidate=halo|(local_baseline.astype(np.uint8)*255&near)
    expansions=[]
    for identity in selected:
        x,y,w,h,size=map(int,stats[identity])
        if max(w,h)>font_scale*.45 or max(w,h)/min(w,h)>2:continue
        radius=select_radius(radial_profile(gray,labels,identity,(x,y,w,h),font_scale),halo_radius,font_scale)
        if radius:
            candidate |= cv2.dilate((labels==identity).astype(np.uint8)*255,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(2*radius+1,2*radius+1)))
            expansions.append({"bboxPx":{"x":x+left,"y":y+top,"width":w,"height":h},"radiusPx":radius})
    frame=np.isin(labels,frame_ids).astype(np.uint8)*255
    frame=cv2.dilate(frame,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5)))
    candidate &= envelope
    candidate[frame>0]=0
    if not candidate.any():raise ValueError("EMPTY_REFINED_MASK")
    # A partial neighbouring letter touching this context's edge must not become
    # a global frame guard outside this member's own protected envelope.
    frame &= envelope
    return candidate,frame,{"id":plan["id"],"fontScale":font_scale,"sourceInkHaloRadius":halo_radius,
        "sourceComponentCount":count-1,"seedComponentCount":len(seed_ids),"frameComponentCount":len(frame_ids),
        "addedSmallComponentCount":len(added),"addedSmallComponents":added[:MAX_DIAGNOSTICS],
        "radialHaloExpansionCount":len(expansions),"radialHaloExpansions":expansions[:MAX_DIAGNOSTICS],
        "diagnosticsTruncated":len(added)>MAX_DIAGNOSTICS or len(expansions)>MAX_DIAGNOSTICS,
        "contextPx":{"x":left,"y":top,"width":right-left,"height":bottom-top},
        "envelopePx":{"x":ex1,"y":ey1,"width":ex2-ex1,"height":ey2-ey1}}


def refine(source,baseline,regions):
    if (not isinstance(source,np.ndarray) or source.dtype!=np.uint8 or source.ndim!=3 or source.shape[2]!=3
            or not isinstance(baseline,np.ndarray) or baseline.dtype!=np.uint8 or baseline.ndim!=2 or source.shape[:2]!=baseline.shape
            or not np.isin(baseline,[0,255]).all()):raise ValueError("INVALID_PIXELS")
    height,width=baseline.shape;plans=plan_regions(width,height,regions)
    result=np.zeros_like(baseline);frames=np.zeros_like(baseline);allowed=np.zeros_like(baseline);members=[];reports=[]
    for plan in plans:
        local,frame,report=refine_region(source,baseline,plan)
        l,t,r,b=plan["context"];result[t:b,l:r] |= local;frames[t:b,l:r] |= frame
        ex1,ey1,ex2,ey2=plan["envelope"];allowed[ey1:ey2,ex1:ex2]=255
        members.append((plan,local));reports.append(report)
    result[(frames>0)|(allowed==0)]=0
    for (plan,local),report in zip(members,reports):
        l,t,r,b=plan["context"];visible=(local>0)&(result[t:b,l:r]>0)
        count=int(np.count_nonzero(visible))
        if not count:raise ValueError("EMPTY_REFINED_MEMBER")
        ex1,ey1,ex2,ey2=plan["envelope"]
        outside=count-int(np.count_nonzero(visible[ey1-t:ey2-t,ex1-l:ex2-l]))
        frame_count=int(np.count_nonzero(visible&(frames[t:b,l:r]>0)))
        if outside or frame_count:raise ValueError("MEMBER_MASK_BOUNDARY")
        report.update({"maskPixels":count,"pixelsOutsideEnvelope":outside,"frameGuardPixelsMasked":frame_count})
    outside=int(np.count_nonzero((result>0)&(allowed==0)));frame_count=int(np.count_nonzero((result>0)&(frames>0)))
    if outside or frame_count or not result.any():raise ValueError("MASK_BOUNDARY")
    return result,{"regions":reports,"maskPixels":int(np.count_nonzero(result)),"pixelsOutsideEnvelope":outside,
        "frameGuardPixelsMasked":frame_count,"contextPolicy":"text_bbox_short_side_0.3_min12",
        "frameGuardPolicy":"source_components_within_selected_envelopes","clipPaddingPx":CLIP_PADDING,
        "baselinePixels":int(np.count_nonzero(baseline)),"addedPixels":int(np.count_nonzero((result>0)&(baseline==0))),
        "removedPixels":int(np.count_nonzero((result==0)&(baseline>0))),"checkedAdditionalProtectedRegions":False}
