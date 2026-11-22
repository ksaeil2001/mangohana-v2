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


def map_tile_detection(candidate, tile, page_size, prefix):
    left, top, right, bottom = tile
    width, height = page_size
    box = candidate['bbox']
    if ((left and box['x'] < .008) or (top and box['y'] < .008) or
            (right < width and box['x'] + box['width'] > .992) or
            (bottom < height and box['y'] + box['height'] > .992)):
        return None
    tile_width, tile_height = right - left, bottom - top
    return {**candidate, 'id': prefix + candidate['id'], 'bbox': {
        'x': (left + box['x'] * tile_width) / width, 'y': (top + box['y'] * tile_height) / height,
        'width': box['width'] * tile_width / width, 'height': box['height'] * tile_height / height,
    }}


def detect_independent_text(image, detect, *, max_tiles):
    observations = list(detect(image))
    side, overlap = 1536, 192
    width, height = image.size
    if max(width, height) <= side:
        return observations, {'plannedTiles': 0, 'processedTiles': 0, 'unsearchedPixelBoxes': []}

    def starts(length):
        last = max(0, length - side)
        return [*range(0, last, side - overlap), last]

    tiles = [(x, y, min(x + side, width), min(y + side, height))
             for y in starts(height) for x in starts(width)]
    for index, tile in enumerate(tiles[:max_tiles]):
        with image.crop(tile) as crop:
            for line in detect(crop):
                observation = map_tile_detection(line, tile, image.size, f'db-view{index}-')
                if observation is not None:
                    observations.append(observation)
    return observations, {'plannedTiles': len(tiles), 'processedTiles': min(len(tiles), max_tiles),
                          'unsearchedPixelBoxes': [list(tile) for tile in tiles[max_tiles:]]}


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
            observation = map_tile_detection(candidate, (l, t, r, b), image.size, f'tile{i}-')
            if observation is not None:
                observations.append(observation)
    return observations,1+len(regions)


def coverage(inner, outer):
    a,b=inner['bbox'],outer['bbox']
    def shared(axis,extent):
        return max(0,min(a[axis]+a[extent],b[axis]+b[extent])-max(a[axis],b[axis]))
    return shared('x','width')*shared('y','height')/(a['width']*a['height'])


def crosscheck_text(observations, independent):
    duplicate_owners = {}
    text, _ = select_regions(observations, duplicate_owners=duplicate_owners)
    primary = {line['id']: line for line in text}
    bubbles=sorted((r for r in observations if r['kind']=='bubble'),key=lambda x:-x['confidence'])
    unique_bubbles=[]
    for bubble in bubbles:
        if not any(min(coverage(bubble,b),coverage(b,bubble))>=.72 for b in unique_bubbles):
            unique_bubbles.append(bubble)
    combined=list(observations)
    supports={}
    contained_lines = {}
    for line in sorted(independent,key=lambda r:-r['confidence']):
        matches=[q for q in text if max(coverage(line,q),coverage(q,line))>=.74]
        if matches:
            if len(matches)==1 and coverage(line,matches[0])>=.90:
                owner = matches[0]['id']
                supports.setdefault(owner, []).append(line['bbox'])
                if owner in primary:
                    contained_lines.setdefault(owner, []).append(line)
            continue
        inside=any(coverage(line,b)>.7 for b in unique_bubbles)
        added={**line,'kind':'text_bubble' if inside else 'text_free'}
        combined.append(added)
        text.append(added)
        supports[added['id']]=[line['bbox']]

    refinements = {}
    for owner, candidates in contained_lines.items():
        lines = separate_parallel_lines(candidates)
        if not lines:
            continue
        refinements[owner] = [line['id'] for line in lines]
        for line in lines:
            detection = {**line, 'kind': primary[owner]['kind'], 'refinedFrom': owner}
            combined.append(detection)
            text.append(detection)
            supports[line['id']] = [line['bbox']]
    text = [line for line in text if line['id'] not in refinements]
    missing=[b['id'] for b in unique_bubbles if not any(coverage(q,b)>.5 for q in text)]
    for index, observation in enumerate(combined):
        region_id = observation['id']
        replacement_ids = refinements.get(duplicate_owners.get(region_id, region_id))
        if replacement_ids:
            observation = {**observation, 'refinedBy': replacement_ids}
        if region_id in supports:
            observation = {**observation, 'inkSupport': supports[region_id]}
        combined[index] = observation
    return combined, missing


def separate_parallel_lines(candidates):
    """Split a broad observation only when distinct supports are clearly side by side."""
    lines = []
    for candidate in candidates:
        if not any(max(coverage(candidate, line), coverage(line, candidate)) >= .74 for line in lines):
            lines.append(candidate)
    if len(lines) < 2:
        return []

    boxes = [line['bbox'] for line in lines]
    if all(box['height'] >= 1.2 * box['width'] for box in boxes):
        along, length, across, extent = 'y', 'height', 'x', 'width'
    elif all(box['width'] >= 1.2 * box['height'] for box in boxes):
        along, length, across, extent = 'x', 'width', 'y', 'height'
    else:
        return []

    across_boxes = sorted(boxes, key=lambda box: box[across])
    for first, second in zip(across_boxes, across_boxes[1:]):
        if first[across] + first[extent] >= second[across]:
            return []
    for index, first in enumerate(boxes):
        for second in boxes[index + 1:]:
            overlap = min(first[along] + first[length], second[along] + second[length]) - max(first[along], second[along])
            if overlap < .5 * min(first[length], second[length]):
                return []
    return lines


def panel_reading_order(image, regions):
    """Use clearly bordered page gutters. Keep OCR order when the image is ambiguous."""
    import numpy as np

    page_width, page_height = image.size
    if len(regions) < 2:
        return regions
    pixels = np.asarray(image.convert('L'))

    def partition(left, top, right, bottom, members, depth):
        if len(members) < 2 or depth == 8:
            return [members]
        crop = pixels[top:bottom, left:right]
        for axis, extent, offset, page_size, collapse in (
            ('y', 'height', top, page_height, 1), ('x', 'width', left, page_width, 0),
        ):
            white_share = (crop >= 245).mean(axis=collapse)
            edge_share = (crop <= 96).mean(axis=collapse)
            white = white_share >= .98
            borders = np.flatnonzero(np.diff(np.pad(white, (1, 1))))
            gutters = []
            for start, end in zip(borders[::2], borders[1::2]):
                if start < 2 or end > white.size - 2 or end - start < max(3, page_size * .008):
                    continue
                if max(edge_share[start - 2:start]) >= .70 and max(edge_share[end:end + 2]) >= .70:
                    gutters.append((start, end))
            for start, end in sorted(gutters, key=lambda span: span[1] - span[0], reverse=True):
                cut = int(offset + (start + end) // 2)
                boundary = cut / page_size
                before = [region for region in members if region['bbox'][axis] + region['bbox'][extent] <= boundary]
                after = [region for region in members if region['bbox'][axis] >= boundary]
                if not before or not after or len(before) + len(after) != len(members):
                    continue
                if axis == 'y':
                    return (partition(left, top, right, cut, before, depth + 1) +
                            partition(left, cut, right, bottom, after, depth + 1))
                return (partition(cut, top, right, bottom, after, depth + 1) +
                        partition(left, top, cut, bottom, before, depth + 1))
        return [members]

    panels = partition(0, 0, page_width, page_height, regions, 0)
    if len(panels) == 1:
        return regions
    return [{**region, 'panelOrder': order} for order, panel in enumerate(panels, 1) for region in panel]


def _join_ocr_columns(parts):
    joined = ''
    for part in parts:
        if not part:
            continue
        if joined and joined[-1].isascii() and joined[-1].isalnum() and part[0].isascii() and part[0].isalnum():
            joined += ' ' + part
        else:
            joined += part
    return joined


def merge_refined_bubble_lines(lines, region_list, width, height):
    """Merge parallel OCR columns back into their enclosing RT-DETR speech bubble."""
    detections_by_id = {r['id']: r for r in region_list}
    grouped = {}
    for index, line in enumerate(lines):
        owner_id = line.get('refinedFrom')
        owner = detections_by_id.get(owner_id) if owner_id else None
        if owner and owner.get('kind') == 'text_bubble':
            grouped.setdefault(owner_id, []).append((index, line))

    mergeable = {}
    for owner_id, members in grouped.items():
        if len(members) >= 2 and all(m['source'] for _, m in members):
            mergeable[owner_id] = members
    if not mergeable:
        return lines, region_list

    merged_owners = {}
    emitted = set()
    result_lines = []
    for index, line in enumerate(lines):
        owner_id = line.get('refinedFrom')
        if owner_id not in mergeable:
            result_lines.append(line)
            continue
        if owner_id in emitted:
            continue
        emitted.add(owner_id)
        owner = detections_by_id[owner_id]
        children = [m for _, m in mergeable[owner_id]]
        boxes = [c['bbox'] for c in children]
        if all(b['height'] >= 1.2 * b['width'] for b in boxes):
            ordered = sorted(children, key=lambda c: (-c['bbox']['x'], c['bbox']['y']))
        else:
            ordered = sorted(children, key=lambda c: (c['bbox']['y'], c['bbox']['x']))
        all_boxes = [owner['bbox'], *[c['bbox'] for c in ordered]]
        left = min(b['x'] for b in all_boxes)
        top = min(b['y'] for b in all_boxes)
        right = max(b['x'] + b['width'] for b in all_boxes)
        bottom = max(b['y'] + b['height'] for b in all_boxes)
        merged_bbox = {
            'x': max(0.0, min(1.0, left)),
            'y': max(0.0, min(1.0, top)),
            'width': max(1e-6, min(1.0, right) - max(0.0, min(1.0, left))),
            'height': max(1e-6, min(1.0, bottom) - max(0.0, min(1.0, top))),
        }
        updated_owner = {k: v for k, v in owner.items() if k != 'refinedBy'}
        updated_owner['bbox'] = merged_bbox
        merged_owners[owner_id] = updated_owner
        panel_orders = [c['panelOrder'] for c in ordered if isinstance(c.get('panelOrder'), int) and c['panelOrder'] > 0]
        merged_line = {
            **updated_owner,
            'source': _join_ocr_columns([c['source'] for c in ordered]),
            'rawSource': _join_ocr_columns([c.get('rawSource', c['source']) for c in ordered]),
            'pixelBox': bounds(merged_bbox, width, height),
            'supportBoxes': [box for c in ordered for box in c.get('supportBoxes', [])],
            'mergedLineIds': [c['id'] for c in ordered],
            **({'panelOrder': min(panel_orders)} if panel_orders else {}),
        }
        result_lines.append(merged_line)

    updated_detections = [merged_owners.get(r['id'], r) for r in region_list]
    return result_lines, updated_detections


def recognize(source_bytes, page, workdir, detector, session, reader, pins, db_detector=None, *, text_tile_limit=0):
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
    independent_search = None
    if db_detector and text_tile_limit:
        extra, independent_search = detect_independent_text(image, db_detector, max_tiles=text_tile_limit)
    else:
        extra = db_detector(image) if db_detector else []
    region_list,uncovered=crosscheck_text(region_list,extra)
    selected,duplicates=select_regions(region_list)
    selected=panel_reading_order(image,selected)
    lines=[]
    for region in selected:
        left, top, right, bottom = bounds(region['bbox'],width,height)
        pad_x=max(2,round((right-left)*.025))
        pad_y=max(2,round((bottom-top)*.025))
        crop=image.crop((max(0,left-pad_x),max(0,top-pad_y),min(width,right+pad_x),min(height,bottom+pad_y)))
        raw=reader(crop)
        text=unicodedata.normalize('NFC',raw).strip()
        lines.append({**region,'source': text,'rawSource':raw,'pixelBox':[left,top,right,bottom],
                      'supportBoxes':[bounds(box,width,height) for box in region.get('inkSupport',[])]})
    lines, region_list = merge_refined_bubble_lines(lines, region_list, width, height)
    return {'page':page['id'],'width':width,'height':height,'sourceSha256':hashlib.sha256(source_bytes).hexdigest(),
            'pngSha256':hashlib.sha256(png_bytes).hexdigest(), 'models':pins,'views':views,
            'detections':region_list,'duplicates':duplicates,'lines':lines,'uncoveredBubbles':uncovered,
            'independentTextRegions':len(extra),
            **({'independentSearch': independent_search} if independent_search is not None else {})}


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
