"""설치된 LaMa 추론 코드는 보존하고 일반 마스크의 타일 분할만 선택한다."""
import argparse
import importlib.util
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageFilter


def _dilate_bool(mask_bool, radius):
    if radius <= 0:
        return mask_bool
    img = Image.fromarray(mask_bool.astype(np.uint8) * 255, mode='L')
    filtered = img.filter(ImageFilter.MaxFilter(2 * radius + 1))
    return np.asarray(filtered, dtype=np.uint8) > 0


def smooth_flat_masked_regions(rgba, mask, result):
    """Replace LaMa smudges with exact local background median ONLY inside flat solid-color bubbles.

    Never touches any pixel outside `mask` or any alpha channel byte.
    """
    if (not isinstance(rgba, np.ndarray) or not isinstance(result, np.ndarray)
            or not isinstance(mask, np.ndarray) or not mask.any()):
        return result
    height, width = mask.shape
    scale = 4
    sh = max(1, (height + scale - 1) // scale)
    sw = max(1, (width + scale - 1) // scale)
    # Downsample dilated mask by max-pooling over 4x4 blocks to find grouped text islands quickly.
    pad_h = sh * scale - height
    pad_w = sw * scale - width
    padded = np.pad(mask, ((0, pad_h), (0, pad_w)), mode='constant', constant_values=False)
    coarse = padded.reshape(sh, scale, sw, scale).any(axis=(1, 3))
    coarse = _dilate_bool(coarse, 2)
    visited = np.zeros((sh, sw), dtype=np.bool_)
    out = result.copy()

    ys, xs = np.nonzero(coarse)
    for sy, sx in zip(ys.tolist(), xs.tolist()):
        if visited[sy, sx]:
            continue
        stack = [(sy, sx)]
        visited[sy, sx] = True
        min_y = max_y = sy
        min_x = max_x = sx
        cells = []
        while stack:
            cy, cx = stack.pop()
            cells.append((cy, cx))
            if cy < min_y: min_y = cy
            if cy > max_y: max_y = cy
            if cx < min_x: min_x = cx
            if cx > max_x: max_x = cx
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < sh and 0 <= nx < sw and coarse[ny, nx] and not visited[ny, nx]:
                    visited[ny, nx] = True
                    stack.append((ny, nx))

        y0 = max(0, min_y * scale - 6)
        x0 = max(0, min_x * scale - 6)
        y1 = min(height, (max_y + 1) * scale + 6)
        x1 = min(width, (max_x + 1) * scale + 6)

        comp_coarse = np.zeros((max_y - min_y + 1, max_x - min_x + 1), dtype=np.bool_)
        for cy, cx in cells:
            comp_coarse[cy - min_y, cx - min_x] = True
        comp_up = np.repeat(np.repeat(comp_coarse, scale, axis=0), scale, axis=1)
        oy0, ox0 = min_y * scale, min_x * scale
        comp_full = np.zeros((y1 - y0, x1 - x0), dtype=np.bool_)
        iy0, ix0 = max(0, oy0 - y0), max(0, ox0 - x0)
        iy1 = min(y1 - y0, oy0 + comp_up.shape[0] - y0)
        ix1 = min(x1 - x0, ox0 + comp_up.shape[1] - x0)
        comp_full[iy0:iy1, ix0:ix1] = comp_up[:iy1 - iy0, :ix1 - ix0]

        mask_crop = mask[y0:y1, x0:x1]
        comp_mask = mask_crop & comp_full
        if not comp_mask.any():
            continue
        ring = _dilate_bool(comp_mask, 4) & (~_dilate_bool(comp_mask, 1)) & (~mask_crop)
        rgba_crop = rgba[y0:y1, x0:x1]
        ring &= rgba_crop[:, :, 3] >= 250
        if int(ring.sum()) < 32:
            continue
        ring_rgb = rgba_crop[ring, :3]
        p5 = np.percentile(ring_rgb, 5, axis=0)
        p95 = np.percentile(ring_rgb, 95, axis=0)
        if not bool(np.all((p95 - p5) <= 16.0)):
            continue
        median_rgb = np.rint(np.median(ring_rgb, axis=0)).clip(0, 255).astype(np.uint8)
        out[y0:y1, x0:x1, :3][comp_mask] = median_rgb
    return out


def compact_tiles(mask, core=448, max_tiles=64):
    if (not isinstance(mask, np.ndarray) or mask.dtype != np.bool_ or mask.ndim != 2
            or not mask.size or mask.size > 16_000_000 or not mask.any()
            or type(core) is not int or core < 1 or type(max_tiles) is not int or max_tiles < 1):
        raise ValueError('INVALID_MASK')
    height, width = mask.shape
    integral = np.zeros((height + 1, width + 1), dtype=np.int32)
    np.cumsum(mask, axis=0, dtype=np.int32, out=integral[1:, 1:])
    np.cumsum(integral[1:, 1:], axis=1, dtype=np.int32, out=integral[1:, 1:])

    def axis(length, prefix):
        boundaries = [0, *range(prefix or core, length, core), length]
        return list(zip(boundaries[:-1], boundaries[1:]))

    def tiles(x_prefix, y_prefix):
        result = []
        for top, bottom in axis(height, y_prefix):
            for left, right in axis(width, x_prefix):
                count = (int(integral[bottom, right]) - int(integral[top, right])
                         - int(integral[bottom, left]) + int(integral[top, left]))
                if count:
                    result.append((left, top, right - left, bottom - top))
        return result

    # 동점에서는 원래 격자를 유지한다. 첫·끝 core도 페이지 내부의 분할이다.
    best = tiles(0, 0)
    for x_prefix in range(0, core, max(1, core // 8)):
        for y_prefix in range(0, core, max(1, core // 8)):
            candidate = tiles(x_prefix, y_prefix)
            if len(candidate) < len(best):
                best = candidate
    if len(best) > max_tiles:
        raise ValueError('TILE_LIMIT')
    return best


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', required=True, type=Path)
    parser.add_argument('--model', required=True, type=Path)
    args = parser.parse_args()
    if not args.worker.is_absolute() or not args.model.is_absolute():
        parser.error('Main 소유의 절대 경로가 필요합니다.')
    spec = importlib.util.spec_from_file_location('existing_local_lama_worker', args.worker)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    if worker.TILE != 512 or worker.HALO != 32 or worker.CORE != 448:
        raise ValueError('INCOMPATIBLE_WORKER_GEOMETRY')
    worker.plan_tiles = lambda mask: compact_tiles(mask, worker.CORE, worker.MAX_TILES)
    original_process_tiles = worker.process_tiles
    worker.process_tiles = lambda session, rgba, mask, tiles: smooth_flat_masked_regions(
        rgba, mask, original_process_tiles(session, rgba, mask, tiles)
    )
    sys.argv = [str(args.worker), '--model', str(args.model)]
    return worker.main()


if __name__ == '__main__':
    raise SystemExit(main())
