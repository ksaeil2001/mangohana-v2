"""Source-only page manifests and persistent, single-attempt stage results."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
from datetime import datetime, timezone
from uuid import uuid4


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def once(target, identity, generate):
    """An incomplete claim is deliberately ambiguous after a process crash."""
    target = Path(target)
    if target.is_file():
        saved = json.loads(target.read_text(encoding='utf8'))
        if saved['identity'] != identity:
            raise ValueError('saved stage belongs to different inputs')
        return saved['result']
    target.parent.mkdir(parents=True, exist_ok=True)
    claim = target.with_suffix('.claim.json')
    try:
        with claim.open('x', encoding='utf8') as stream:
            json.dump({'identity': identity, 'at': datetime.now(timezone.utc).isoformat()}, stream)
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError:
        raise RuntimeError('stage already claimed: ' + str(target)) from None
    value = generate()
    temporary = target.with_name(target.name + '.' + uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf8') as stream:
        json.dump({'identity': identity, 'result': value}, stream, ensure_ascii=False, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)
    return value


def load_pages(manifest, original_root):
    root = Path(original_root).resolve(strict=True)
    rows = json.loads(Path(manifest).read_text(encoding='utf-8-sig'))
    result, ids, files, positions = [], set(), set(), set()
    for row in rows:
        if set(row) != {'work', 'id', 'index', 'source'}:
            raise ValueError('unexpected source manifest fields')
        if not all(re.fullmatch(r'[\w-]{1,80}', row[k]) for k in ('id', 'work')):
            raise ValueError('invalid work or page ID')
        relative = Path(row['source'])
        if relative.is_absolute() or relative.drive or '..' in relative.parts:
            raise ValueError('source outside original directory')
        if relative.suffix.lower() not in ('.png', '.webp', '.jpg', '.jpeg'):
            raise ValueError('unsupported source')
        file = (root / relative).resolve(strict=True)
        position = (row['work'], row['index'])
        if not file.is_relative_to(root) or not file.is_file() or file in files or row['id'] in ids:
            raise ValueError('unbound or duplicate original')
        if type(row['index']) is not int or row['index'] < 1 or position in positions:
            raise ValueError('invalid page position')
        files.add(file)
        ids.add(row['id'])
        positions.add(position)
        result.append({**row, 'path':file})
    if not result:
        raise ValueError('empty source manifest')
    return result


def select_regions(regions, *, duplicate_owners=None):
    """Keep both speech and free text while removing duplicate predictions."""
    def from_tile(region):
        return bool(re.match(r'^tile\d+-', region['id']))

    text = sorted((r for r in regions if r['kind'] in ('text_bubble','text_free') and not r.get('refinedBy')),
                  key=lambda r: (from_tile(r), -r['confidence']))
    selected, duplicates = [], []
    for item in text:
        a = item['bbox']
        if any(not math.isfinite(v) for v in a.values()) or min(a['width'],a['height']) <= 0:
            raise ValueError('invalid detection box')
        area = a['width'] * a['height']
        for kept in selected:
            b = kept['bbox']
            width = max(0, min(a['x']+a['width'], b['x']+b['width'])-max(a['x'], b['x']))
            height = max(0, min(a['y']+a['height'], b['y']+b['height'])-max(a['y'], b['y']))
            overlap = width*height
            tile_fragment = from_tile(item) and not from_tile(kept) and overlap / area >= .90
            if tile_fragment or overlap / (area+b['width']*b['height']-overlap) >= .65:
                duplicates.append(item['id'])
                if duplicate_owners is not None:
                    duplicate_owners[item['id']] = kept['id']
                break
        else:
            selected.append(item)
    selected.sort(key=lambda r: (int(r['bbox']['y']/.06), -r['bbox']['x'], r['bbox']['y']))
    return selected, duplicates
