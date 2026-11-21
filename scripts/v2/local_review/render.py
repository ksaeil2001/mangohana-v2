"""Compose an offline review PNG from the saved OCR and single translation receipt."""
import argparse
from functools import lru_cache
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import unicodedata
from uuid import uuid4

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pages import fingerprint, once
from quality import review_flags

FONT = ROOT / 'packages/ai-engine/vendor/trio/resources/font_ko_fallback/pretendard-1.3.9/PretendardVariable.ttf'
FONT_SHA = '3090ccde0442bb347aa7685d9ba8b17436a60682df6e8f92a9a670de14056e22'
VERSION = 'local-review-lettering-5'
CLOSING_MARKS = '.,:;!?~…。、！？～〜)]}】」』”’'
SRGB = np.arange(256,dtype=np.float64)/255
LINEAR_RGB = np.where(SRGB<=.04045,SRGB/12.92,((SRGB+.055)/1.055)**2.4)


@lru_cache(maxsize=140)
def face(path, size):
    return ImageFont.truetype(str(path), size)


def word_units(word, font, width):
    units = []
    for char in word:
        if units and (unicodedata.category(char).startswith('M') or char=='\u200d' or units[-1].endswith('\u200d')
                      or len(unicodedata.normalize('NFC', units[-1]+char)) < len(unicodedata.normalize('NFC', units[-1]))+1):
            units[-1] += char
        else:
            units.append(char)
    suffix = len(units)
    while suffix and (units[suffix-1].isspace() or units[suffix-1] in CLOSING_MARKS):
        suffix -= 1
    if 0 < suffix < len(units):
        ending = ''.join(units[suffix-1:])
        if font.getlength(ending) <= width:
            units[suffix-1:] = [ending]
    return units


def wrapped_rows(text, font, width):
    lines = []
    split_closing_word = False
    for paragraph in text.replace('\r\n','\n').replace('\r','\n').split('\n'):
        if font.getlength(paragraph) <= width or not paragraph.strip():
            lines.append(paragraph)
            continue
        words = []
        end = 0
        for match in re.finditer(r'\S+',paragraph):
            word = match.group()
            gap = paragraph[end:match.start()]
            if words and all(c in CLOSING_MARKS for c in word):
                previous_gap,previous_word = words[-1]
                words[-1] = previous_gap,previous_word+gap+word
            else:
                words.append((gap,word))
            end = match.end()
        current = ''
        for index,(gap,word) in enumerate(words):
            joined = current+gap+word
            if font.getlength(joined) <= width:
                current = joined
                continue
            if current:
                lines.append(current)
            current = ''
            token = gap+word if index==0 else word
            if font.getlength(token) <= width:
                current = token
                continue
            if token[-1] in CLOSING_MARKS and any(c.isalnum() for c in token):
                split_closing_word = True
            for unit in word_units(token,font,width):
                if current and font.getlength(current+unit) > width:
                    lines.append(current)
                    current = ''
                current += unit
        lines.append(current+paragraph[end:])
    return lines,split_closing_word


def wrap_text(text, font, width):
    return wrapped_rows(text,font,width)[0]


def measure(text, font, width):
    rows,split_closing_word = wrapped_rows(text, font, width)
    boxes = [font.getbbox(v) if v.strip() else (0,0,0,font.size) for v in rows]
    gap = max(2, round(font.size * .23))
    height = sum(b[3]-b[1] for b in boxes) + max(0, len(rows)-1)*gap
    widest = max((b[2]-b[0] for b in boxes), default=0)
    return dict(rows=rows, boxes=boxes, gap=gap, font=font, height=height, width=widest,
                splitClosingWord=split_closing_word)


def fit_text(text, width, height, font_path, largest, smallest):
    if not text.strip() or min(width, height) <= 0:
        return None
    for size in dict.fromkeys([*range(largest,smallest-1,-2), smallest]):
        layout = measure(text, face(font_path, size), width)
        if layout['rows'] and layout['width'] <= width and layout['height'] <= height:
            if layout['splitClosingWord']:
                # A short exclamation can stay on one line. Longer dialogue
                # keeps its original scale unless a small reduction saves a row.
                short = not any(c.isspace() for c in text) and len(text) <= 16
                minimum = max(smallest, math.floor(size*.8) if short else math.ceil(size*.9))
                for candidate_size in range(size-1,minimum-1,-1):
                    smaller = face(font_path,candidate_size)
                    candidate = measure(text,smaller,width)
                    if short and len(candidate['rows']) > 1:
                        # Side bearings after dots use advance width but do not paint.
                        mask,(dx,dy) = smaller.getmask2(text)
                        ink = mask.getbbox()
                        if ink and ink[2]-ink[0] <= width and ink[3]-ink[1] <= height:
                            candidate.update(rows=[text],boxes=[(ink[0]+dx,ink[1]+dy,ink[2]+dx,ink[3]+dy)],
                                             width=ink[2]-ink[0],height=ink[3]-ink[1],splitClosingWord=False)
                    if (not candidate['splitClosingWord'] and len(candidate['rows']) < len(layout['rows'])
                            and candidate['width'] <= width and candidate['height'] <= height):
                        return candidate
            return layout
    return None


def draw_rows(draw, layout, x, top, color, centered=False):
    for text, box in zip(layout['rows'], layout['boxes']):
        left = x - ((box[2]-box[0])//2 if centered else 0)
        draw.text((left-box[0],top-box[1]), text, font=layout['font'], fill=color)
        top += box[3]-box[1]+layout['gap']


def intersects(alpha, origin, boxes):
    x, y = origin
    h, w = alpha.shape
    for l, t, r, b in boxes:
        l, t, r, b = max(0,l-x), max(0,t-y), min(w,r-x), min(h,b-y)
        if l < r and t < b and alpha[t:b,l:r].any():
            return True
    return False


def ink_layer(layout, width, height):
    image = Image.new('L', (width,height))
    draw_rows(ImageDraw.Draw(image),layout,width//2,(height-layout['height'])//2,255,True)
    return np.asarray(image)


def placement_bounds(box, bubbles, width, height):
    l,t,r,b = box
    cx,cy = (l+r)/2,(t+b)/2
    matching = [p for p in bubbles if p[0] <= cx <= p[2] and p[1] <= cy <= p[3]]
    bubble = min(matching,key=lambda p:(p[2]-p[0])*(p[3]-p[1])) if matching else None
    grow_x = max(7,int(min(height*.065,max((r-l)*.3,(b-t)*.35))))
    grow_y = max(4,int(min(height*.025,(b-t)*.16)))
    expanded = (max(0,l-grow_x),max(0,t-grow_y),min(width,r+grow_x),min(height,b+grow_y))
    if bubble:
        bl,bt,br,bb = bubble
        expanded = (max(expanded[0],min(l,bl+3)),max(expanded[1],min(t,bt+3)),
                    min(expanded[2],max(r,br-3)),min(expanded[3],max(b,bb-3)))
    return expanded


def layout_spaces(box,kind,bubbles,other_boxes,width,height):
    local=placement_bounds(box,bubbles,width,height)
    if kind!='text_bubble':
        return [local]
    l,t,r,b=box
    enclosing=[p for p in bubbles if p[0]<=l<r<=p[2] and p[1]<=t<b<=p[3]]
    if not enclosing:
        return [local]
    bl,bt,br,bb=min(enclosing,key=lambda p:(p[2]-p[0])*(p[3]-p[1]))
    if (br-bl)*(bb-bt)>.5*width*height or any(bl<(x+u)/2<br and bt<(y+v)/2<bb for x,y,u,v in other_boxes):
        return [local]
    px,py=math.ceil((br-bl)*.14),math.ceil((bb-bt)*.14)
    inset=(max(0,bl+px),max(0,bt+py),min(width,br-px),min(height,bb-py))
    return [inset,local] if inset[2]-inset[0]>local[2]-local[0] else [local]


def measured_layouts(text,spaces,font_path,largest,smallest):
    seen = set()
    step = max(1,round(largest*.06))
    for cap in dict.fromkeys([*range(largest,smallest-1,-step),smallest]):
        for x,y,end_x,end_y in spaces:
            w,h=end_x-x,end_y-y
            layout=fit_text(text,w-4,h-4,font_path,cap,smallest)
            if layout:
                key = (x,y,end_x,end_y,layout['font'].size,tuple(layout['rows']))
                if key in seen:
                    continue
                seen.add(key)
                yield layout,(x,y,end_x,end_y)


def art_clearance(art, radius):
    return np.asarray(Image.fromarray(art.astype(np.uint8)).filter(ImageFilter.MaxFilter(2*radius+1))) != 0


def lettering_paint(paper, pixels):
    luminances = LINEAR_RGB[pixels] @ [0.2126,0.7152,0.0722]
    preferred,alternative = (22,245) if np.mean(paper)>=128 else (245,22)
    scores = {}
    for shade in (preferred,alternative,0,255):
        light = LINEAR_RGB[shade]
        minimum = float(np.min((np.maximum(luminances,light)+.05)/(np.minimum(luminances,light)+.05)))
        if minimum>=4.5:
            return shade,None,minimum
        scores[shade] = minimum
    foreground = max((0,255),key=scores.get)
    return foreground,255-foreground,scores[foreground]


def paint_coverage(glyph, font_size, outline):
    if outline is None:
        return glyph,0
    radius = max(1,min(3,round(font_size*.045)))
    # A clipped outline cannot provide the intended edge on all sides.
    if any(band.any() for band in (glyph[:radius],glyph[-radius:],glyph[:,:radius],glyph[:,-radius:])):
        return None,radius
    return np.asarray(Image.fromarray(glyph).filter(ImageFilter.MaxFilter(2*radius+1))),radius


def paint_glyph(area, glyph, shade):
    ink = glyph!=0
    weight = glyph[ink].astype(np.float32)[:,None]/255
    area[ink] = np.rint(area[ink]*(1-weight)+shade*weight).astype(np.uint8)


def preferred_font_size(row,width,height):
    l,t,r,b=row['pixelBox']
    page_span=min(width,height)
    if row.get('kind')=='text_bubble' and row.get('sourceCharacters'):
        # Estimate the size of one Japanese glyph independently of writing direction.
        em=math.sqrt((r-l)*(b-t)/row['sourceCharacters'])
        return max(12,round(min(page_span*.055,em*.78)))
    return max(12,round(min(page_span*.024,max(r-l,b-t)*.36)))


def boundary_art(dark,box,support,origin):
    """Find incoming border strokes only when independent text is safely separated."""
    art=np.zeros_like(dark)
    if not support:
        return art
    l,t,r,b=box
    ox,oy=origin
    h,w=dark.shape
    left,top=max(0,l-ox-4),max(0,t-oy-4)
    right,bottom=min(w,r-ox+4),min(h,b-oy+4)
    area=dark[top:bottom,left:right]
    flooded=Image.fromarray(np.pad(area,1,constant_values=True).astype(np.uint8)*255).copy()
    ImageDraw.floodfill(flooded,(0,0),128)
    perimeter=np.asarray(flooded)[1:-1,1:-1]==128
    if not perimeter.any():
        return art
    for x,y,u,v in support:
        pad=max(4,round(min(u-x,v-y)*.2))
        x,u=max(0,x-ox-left-pad),min(right-left,u-ox-left+pad)
        y,v=max(0,y-oy-top-pad),min(bottom-top,v-oy-top+pad)
        if x<u and y<v and perimeter[y:v,x:u].any():
            return art
    art[top:bottom,left:right]=perimeter
    return art


def place(pixels, used, row, other_boxes, bubbles, model, session, font_path):
    import cv2
    height,width = pixels.shape[:2]
    l,t,r,b = row['pixelBox']
    text = row['target']
    if not text or 'TOKEN_LIMIT' in row['flags']:
        return 'EMPTY_OR_TOKEN_LIMIT'
    if (r-l)*(b-t) > .2*width*height:
        return 'LARGE_ART_REGION'
    spaces = layout_spaces(row['pixelBox'],row.get('kind'),bubbles,other_boxes,width,height)
    scale = max(12,round(min(width,height)*.010))
    largest = max(scale,preferred_font_size(row,width,height))
    # Provide enough surrounding pixels for both contexts of the learned glyph mask.
    context = max(8,math.ceil(min(r-l,b-t)*.26))
    cl=max(0,min(l-context,*(box[0] for box in spaces)))
    ct=max(0,min(t-context,*(box[1] for box in spaces)))
    cr=min(width,max(r+context,*(box[2] for box in spaces)))
    cb=min(height,max(b+context,*(box[3] for box in spaces)))
    crop = pixels[ct:cb,cl:cr]
    crop_h,crop_w = crop.shape[:2]
    rgb = np.ascontiguousarray(crop[:,:,:3])
    rel = {'x':(l-cl)/crop_w,'y':(t-ct)/crop_h,'width':(r-l)/crop_w,'height':(b-t)/crop_h}
    try:
        mask,_ = model.segment(session,rgb,[{'id':row['id'],'bbox':rel}])
    except ValueError as failure:
        if str(failure) == 'EMPTY_TEXT_MASK':
            return 'EMPTY_TEXT_MASK'
        raise
    core = mask != 0
    protected = used[ct:cb,cl:cr]
    if np.any(protected & core) or intersects(mask,(cl,ct),other_boxes):
        return 'OVERLAP'
    if not np.all(crop[:,:,3][core] == 255):
        return 'TRANSPARENCY'
    ring = cv2.dilate(mask,np.ones((5,5),np.uint8)).astype(bool) & ~core
    if np.count_nonzero(ring) < 12:
        return 'BACKGROUND'
    sample = rgb[ring].astype(np.int16)
    color = np.median(sample,axis=0).astype(np.uint8)
    near = lambda values,limit: np.max(np.abs(values.astype(np.int16)-color),axis=-1) <= limit
    if np.mean(near(sample,22)) < .84:
        return 'TEXTURED_BACKGROUND'
    border=boundary_art(~near(rgb,30),row['pixelBox'],row.get('supportBoxes',[]) if row.get('kind')=='text_bubble' else [],(cl,ct))
    if border.any():
        border=cv2.dilate(border.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)
        core &= ~border
        if not core.any():
            return 'EMPTY_TEXT_MASK'
    clean = rgb.copy()
    clean[core] = color
    source_area = clean[t-ct:b-ct,l-cl:r-cl]
    original_area = rgb[t-ct:b-ct,l-cl:r-cl]
    inside = ~border[t-ct:b-ct,l-cl:r-cl]
    original_ink = np.count_nonzero(~near(original_area,30) & inside)
    remaining_ink = np.count_nonzero(~near(source_area,30) & inside)
    if remaining_ink > max(3,original_ink*.035):
        return 'PROTECT_ART_OR_REMAINING_INK'
    # The next pixel outside a layout can be the balloon outline. Read this
    # margin independently of the model crop so the segmentation input stays identical.
    halo = 5
    gx,gy = max(0,cl-halo),max(0,ct-halo)
    guard_image = pixels[gy:min(height,cb+halo),gx:min(width,cr+halo)]
    obstacles = ~near(guard_image[:,:,:3],55) | (guard_image[:,:,3]!=255) | used[gy:gy+guard_image.shape[0],gx:gx+guard_image.shape[1]]
    obstacles[ct-gy:cb-gy,cl-gx:cr-gx] = ~near(clean,55) | border | protected | (crop[:,:,3]!=255)
    clearances = {}
    # Only accept a centered layout whose glyph pixels fall on clean paper.
    for layout,(x,y,end_x,end_y) in measured_layouts(text,spaces,font_path,largest,scale):
        w,h=end_x-x,end_y-y
        target_area=clean[y-ct:end_y-ct,x-cl:end_x-cl]
        glyph = ink_layer(layout,w,h)
        body = glyph!=0
        if not body.any():
            continue
        size = layout['font'].size
        foreground,outline,contrast = lettering_paint(color,target_area[body])
        coverage,outline_width = paint_coverage(glyph,size,outline)
        if coverage is None:
            continue
        ink = coverage!=0
        if (np.any(used[y:end_y,x:end_x] & ink) or intersects(coverage,(x,y),other_boxes)
                or np.any(border[y-ct:end_y-ct,x-cl:end_x-cl] & ink)):
            continue
        radius = max(2,min(5,round(size*.09)))
        if radius not in clearances:
            clearances[radius] = art_clearance(obstacles,radius)
        if np.any(clearances[radius][y-gy:end_y-gy,x-gx:end_x-gx] & ink):
            continue
        if (np.mean(near(target_area[ink],30)) < .997 or
                not np.all(pixels[y:end_y,x:end_x,3][ink] == 255)):
            continue
        crop[:,:,:3][core] = color
        area = pixels[y:end_y,x:end_x,:3]
        if outline is not None:
            paint_glyph(area,coverage,outline)
        paint_glyph(area,glyph,foreground)
        protected |= core
        used[y:end_y,x:end_x] |= ink
        row.update(fontPx=layout['font'].size, textRows=layout['rows'], maskPixels=int(core.sum()),
                   glyphPixels=int(body.sum()), layoutBox=[x,y,end_x,end_y],foreground=foreground,
                   minimumPaperContrast=round(contrast,4),outline=outline,outlineWidthPx=outline_width,
                   additionalOutlinePixels=int(ink.sum()-body.sum()))
        return ''
    return 'LAYOUT_ON_ART'


def add_margin(source, rows, font_path):
    if not rows:
        return source
    w,h = source.size
    font_size = max(20,min(52,round(w*.0185)))
    width = max(325,round(w*.34))
    pad = max(16,round(width*.065))
    body = face(font_path,font_size)
    caption = face(font_path,max(14,round(font_size*.75)))
    total = pad*2 + font_size*2
    cards = []
    for row in rows:
        layout = measure(row['target'] or '번역문 없음 · 원문 확인 필요',body,width-2*pad)
        row['marginRows'] = layout['rows']
        cards.append((row,layout,total))
        total += caption.size + pad//2 + layout['height'] + pad
    canvas = Image.new('RGBA',(w+width,max(h,total+pad)),(244,245,242,255))
    canvas.paste(source,(0,0))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((w,0,w+max(2,pad//8),canvas.height),fill='#648678')
    draw.text((w+pad,pad),'여백 대사',font=face(font_path,font_size+2),fill='#203e32')
    for row,layout,top in cards:
        l,t,r,b = row['pixelBox']
        title = f"{row['number']:02d}   왼쪽에서 {round(50*(l+r)/w)}% · 위에서 {round(50*(t+b)/h)}%"
        draw.text((w+pad,top),title,font=caption,fill='#496559',anchor='lt')
        draw_rows(draw,layout,w+pad,top+caption.size+pad//2,'#152820')
    return canvas


def page_render(folder, ocr, mt, model, session, font_path):
    raw = (folder/'source.png').read_bytes()
    if hashlib.sha256(raw).hexdigest() != ocr['pngSha256']:
        raise ValueError('original pixels fail receipt verification')
    with Image.open(io.BytesIO(raw)) as source:
        pixels = np.array(source.convert('RGBA'))
    before = pixels.copy()
    h,w = pixels.shape[:2]
    if (w,h) != (ocr['width'],ocr['height']) or mt['page'] != ocr['page']:
        raise ValueError('page binding mismatch')
    used = np.zeros((h,w),bool)
    targets = {line['id']:line for line in mt['lines']}
    valid = {line['id'] for line in ocr['lines'] if line['source']}
    if set(targets) != valid or len(targets) != len(mt['lines']):
        raise ValueError('translation group binding mismatch')
    bubbles = []
    for d in ocr['detections']:
        if d['kind'] == 'bubble':
            b = d['bbox']
            bubbles.append((int(w*b['x']),int(h*b['y']),math.ceil(w*(b['x']+b['width'])),math.ceil(h*(b['y']+b['height']))))
    rows = []
    for i,line in enumerate(ocr['lines'],1):
        target = targets.get(line['id'],{})
        if target and target['source'] != line['source']:
            raise ValueError('source text mismatch')
        rec = dict(id=line['id'],number=i,pixelBox=line['pixelBox'],kind=line.get('kind'),target=target.get('ko',''),
                   supportBoxes=line.get('supportBoxes',[]),
                   sourceCharacters=sum(not c.isspace() for c in line['source']),
                   flags=target.get('flags',['OCR_EMPTY']),placement='margin')
        rec['flags']=sorted(set(rec['flags']) | set(review_flags(line['source'],rec['target'],target.get('eos',True))))
        if rec['flags']:
            rec.update(placement='untranslated',reason='TRANSLATION_UNUSABLE')
            rows.append(rec)
            continue
        others = [r['pixelBox'] for r in ocr['lines'] if r['id'] != line['id']]
        rec['reason'] = place(pixels,used,rec,others,bubbles,model,session,font_path)
        if not rec['reason']:
            rec['placement'] = 'page'
        rows.append(rec)
    changed = np.any(pixels != before,axis=2)
    if np.any(changed & ~used) or not np.array_equal(pixels[:,:,3],before[:,:,3]):
        raise ValueError('unassigned source pixels changed')
    result = add_margin(Image.fromarray(pixels,'RGBA'),[r for r in rows if r['placement']=='margin'],font_path)
    with io.BytesIO() as stream:
        result.save(stream,format='PNG',compress_level=4)
        data = stream.getvalue()
    with Image.open(io.BytesIO(data)) as checked:
        if checked.size != result.size or not np.array_equal(np.asarray(checked),np.asarray(result)):
            raise ValueError('PNG pixel verification failed')
    broken = not rows or bool(ocr.get('uncoveredBubbles')) or any(r['placement']=='untranslated' for r in rows)
    partial = any(r['placement']=='margin' for r in rows)
    status = 'NEEDS_ENGINE_WORK' if broken else 'PARTIAL_TYPESETTING' if partial else 'READY_FOR_REVIEW'
    path = folder/('review.png' if status == 'READY_FOR_REVIEW' else 'diagnostic.png')
    temporary = path.with_name('render-'+uuid4().hex+'.tmp')
    with temporary.open('xb') as out:
        out.write(data)
    if path.exists():
        raise FileExistsError(path)
    os.rename(temporary,path)
    return dict(page=ocr['page'],sourceSize=[w,h],outputSize=list(result.size),sha256=hashlib.sha256(data).hexdigest(),
                rows=rows,qualityStatus=status,outputFile=path.name,uncoveredBubbles=ocr.get('uncoveredBubbles',[]),
                changedPixels=int(changed.sum()),outsideEdits=0,version=VERSION,fontSha256=FONT_SHA,
                maskSha256=model.MODEL_SHA256, maskMode='dual-context-consensus/flat-paper', humanReview='PENDING')


def main():
    parser = argparse.ArgumentParser()
    for name in ('manifest','output','mask'):
        parser.add_argument('--'+name,type=Path,required=True)
    args = parser.parse_args()
    if hashlib.sha256(FONT.read_bytes()).hexdigest() != FONT_SHA:
        raise ValueError('unexpected typesetting font')
    spec = importlib.util.spec_from_file_location('text_mask', ROOT/'scripts/v2/vision/text_mask.py')
    model = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(model)
    model.install_offline_guards()
    session = model.create_session(model.read_pinned_model(args.mask))
    pages = json.loads(args.manifest.read_text(encoding='utf-8-sig'))
    for item in pages:
        pid = item['id']
        if not re.fullmatch(r'[\w-]{1,80}',pid):
            raise ValueError('invalid page ID')
        folder = args.output/'pages'/pid
        while not (folder/'translation.json').is_file():
            time.sleep(2)
        ocr,mt = [json.loads((folder/n).read_text('utf8')) for n in ('ocr.json','translation.json')]
        identity = fingerprint([pid,ocr['identity'],mt['identity'],VERSION,FONT_SHA,model.MODEL_SHA256])
        saved = once(folder/'render.json',identity,lambda:page_render(folder,ocr['result'],mt['result'],model,session,FONT))
        page_count = sum(r['placement']=='page' for r in saved['rows'])
        print(json.dumps(dict(page=pid,stage='render',status=saved['qualityStatus'],onPage=page_count,
                              margin=sum(r['placement']=='margin' for r in saved['rows']),
                              untranslated=sum(r['placement']=='untranslated' for r in saved['rows'])),
                         ensure_ascii=False),flush=True)


if __name__ == '__main__':
    main()
