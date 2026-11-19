"""MangoHana offline OCR for review. Uses its pinned RT-DETR and Baberu ONNX weights."""
import argparse
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import sys
import time
import unicodedata

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pages import fingerprint, load_pages, once, select_regions


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def bounds(bbox, width, height):
    return (max(0, math.floor(bbox['x']*width)), max(0, math.floor(bbox['y']*height)),
            min(width, math.ceil((bbox['x']+bbox['width'])*width)),
            min(height, math.ceil((bbox['y']+bbox['height'])*height)))


def detect_page(image, detect, session):
    """Keep the full-page layout and inspect overlapping views for small print."""
    width,height=image.size
    observations=list(detect(session,image))
    def starts(length):
        return [(0,length)] if length<=1280 else [(0,math.ceil(length*.58)),(math.floor(length*.42),length)]
    regions=[(l,t,r,b) for l,r in starts(width) for t,b in starts(height)]
    if len(regions)==1:
        return observations,1
    for i,(l,t,r,b) in enumerate(regions):
        crop=image.crop((l,t,r,b))
        for candidate in detect(session,crop):
            box=candidate['bbox']
            # Truncated words at an interior tile edge must not replace a full observation.
            if ((l and box['x']<.008) or (t and box['y']<.008)
                or (r<width and box['x']+box['width']>.992) or (b<height and box['y']+box['height']>.992)):
                continue
            bounds=dict(x=(l+box['x']*crop.width)/width,y=(t+box['y']*crop.height)/height,
                        width=box['width']*crop.width/width,height=box['height']*crop.height/height)
            observations.append({**candidate,'id':f'tile{i}-'+candidate['id'],'bbox':bounds})
    return observations,1+len(regions)


def coverage(inner, outer):
    a,b=inner['bbox'],outer['bbox']
    def shared(axis,extent):
        return max(0,min(a[axis]+a[extent],b[axis]+b[extent])-max(a[axis],b[axis]))
    return shared('x','width')*shared('y','height')/(a['width']*a['height'])


def crosscheck_text(observations, independent):
    text,_=select_regions(observations)
    bubbles=sorted((r for r in observations if r['kind']=='bubble'),key=lambda x:-x['confidence'])
    unique_bubbles=[]
    for bubble in bubbles:
        if not any(min(coverage(bubble,b),coverage(b,bubble))>=.72 for b in unique_bubbles):
            unique_bubbles.append(bubble)
    combined=list(observations)
    supports={}
    for line in sorted(independent,key=lambda r:-r['confidence']):
        matches=[q for q in text if max(coverage(line,q),coverage(q,line))>=.74]
        if matches:
            if len(matches)==1 and coverage(line,matches[0])>=.90:
                supports.setdefault(matches[0]['id'],[]).append(line['bbox'])
            continue
        inside=any(coverage(line,b)>.7 for b in unique_bubbles)
        added={**line,'kind':'text_bubble' if inside else 'text_free'}
        combined.append(added)
        text.append(added)
        supports[added['id']]=[line['bbox']]
    missing=[b['id'] for b in unique_bubbles if not any(coverage(q,b)>.5 for q in text)]
    return [{**r,'inkSupport':supports[r['id']]} if r['id'] in supports else r for r in combined],missing


def recognize(source_bytes, page, workdir, detector, session, reader, pins, db_detector=None):
    from PIL import Image
    import numpy as np
    with Image.open(io.BytesIO(source_bytes)) as opened:
        width, height = opened.size
        if (max(width,height) > 8000 or width*height > 12_000_000 or getattr(opened,'n_frames',1) != 1
                or opened.getexif().get(274,1) != 1):
            raise ValueError('unsupported image dimensions, orientation or frame count')
        rgba = opened.convert('RGBA')
    image = rgba.convert('RGB')
    png_bytes = source_bytes
    if workdir is not None:
        png = io.BytesIO()
        rgba.save(png, format='PNG', compress_level=4)
        png_bytes = png.getvalue()
        with Image.open(io.BytesIO(png_bytes)) as check:
            if check.size != rgba.size or not np.array_equal(np.asarray(check),np.asarray(rgba)):
                raise ValueError('PNG pixels changed')
        with (workdir/'source.png').open('xb') as out:
            out.write(png_bytes)
    region_list,views=detect_page(image,detector.detect,session)
    extra=db_detector(image) if db_detector else []
    region_list,uncovered=crosscheck_text(region_list,extra)
    selected,duplicates=select_regions(region_list)
    lines=[]
    for region in selected:
        left, top, right, bottom = bounds(region['bbox'],width,height)
        pad_x=max(2,round((right-left)*.025))
        pad_y=max(2,round((bottom-top)*.025))
        crop=image.crop((max(0,left-pad_x),max(0,top-pad_y),min(width,right+pad_x),min(height,bottom+pad_y)))
        raw=reader(crop)
        text=unicodedata.normalize('NFC',raw).strip()
        lines.append({**region,'source': text,'pixelBox':[left,top,right,bottom],
                      'supportBoxes':[bounds(box,width,height) for box in region.get('inkSupport',[])]})
    return {'page':page['id'],'width':width,'height':height,'sourceSha256':hashlib.sha256(source_bytes).hexdigest(),
            'pngSha256':hashlib.sha256(png_bytes).hexdigest(), 'models':pins,'views':views,
            'detections':region_list,'duplicates':duplicates,'lines':lines,'uncoveredBubbles':uncovered,
            'independentTextRegions':len(extra)}


def load_ocr_models(pack, detector_file, db_file):
    pack=pack.resolve(strict=True)
    if Path(sys.executable).resolve().parent.parent != pack:
        raise ValueError('unexpected OCR runtime')
    detector=module('region_detector',ROOT/'scripts/v2/vision/region_detector.py')
    sidecar=module('approved_onnx_recognizer',pack/'sidecar/trio_ocr_sidecar.py')
    detector.install_offline_guards()
    import onnxruntime as ort
    ort.disable_telemetry_events()
    session=detector.create_session(detector.read_pinned_model(detector_file))
    manifest=json.loads((pack/'resource-manifest.json').read_text(encoding='utf-8-sig'))
    pins={'detector':detector.MODEL_SHA256,'detectorRevision':detector.MODEL_REVISION,
          'recognizer':sidecar.RECOGNIZER_MODEL_ID,'recognizerRevision':sidecar.RECOGNIZER_REVISION}
    for entry in manifest['files']:
        rel=entry['relativePath']
        if rel.startswith('recognizer/onnx/') or rel=='recognizer/tokenizer/vocab.json' or rel=='sidecar/trio_ocr_sidecar.py':
            digest=hashlib.sha256((pack/rel).read_bytes()).hexdigest()
            if digest!=entry['sha256']:
                raise ValueError('OCR asset hash mismatch')
            pins[rel]=digest
    reader=sidecar.BaberuOnnxOCR(pack/'recognizer/onnx',pack/'recognizer/tokenizer')
    from text_detector import TextDetector, MODEL_SHA
    db=TextDetector(db_file) if db_file else None
    pins['independentTextDetector']=MODEL_SHA if db else None
    return detector,session,reader,pins,db


def main():
    parser=argparse.ArgumentParser()
    for key in ('manifest','originals','output','detector','pack'):
        parser.add_argument('--'+key,type=Path,required=True)
    parser.add_argument('--text-detector',type=Path,help='Pinned PP-OCRv4 ONNX text detector')
    args=parser.parse_args()
    default_db=args.detector.parent.parent/'rapidocr-v4-5e7ff7a3'/'ch_PP-OCRv4_det_infer.onnx'
    detector,session,reader,pins,db=load_ocr_models(args.pack,args.detector,args.text_detector or (default_db if default_db.is_file() else None))
    rows=load_pages(args.manifest,args.originals)
    start=time.monotonic()
    for page in rows:
        raw=page['path'].read_bytes()
        if len(raw)>8*1024*1024:
            raise ValueError('image byte limit')
        directory=args.output/'pages'/page['id']
        ident=fingerprint({'adapter':'mango-multiview-rev3','models':pins,'page':page['id'],'source':hashlib.sha256(raw).hexdigest()})
        result=once(directory/'ocr.json',ident,lambda:recognize(raw,page,directory,detector,session,reader,pins,db))
        n=sum(bool(l['source']) for l in result['lines'])
        print(json.dumps({'page':page['id'],'stage':'ocr','regions':len(result['lines']),'recognized':n,'elapsed':round(time.monotonic()-start)},ensure_ascii=False),flush=True)


if __name__ == '__main__':
    main()
