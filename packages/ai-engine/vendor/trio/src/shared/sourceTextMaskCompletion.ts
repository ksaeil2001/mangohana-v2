import type { PolygonPoint } from "./speechBubbleExtraction.js";

type Region = Readonly<{ id: string; polygonsPx: readonly (readonly PolygonPoint[])[] }>;

/** 원래 마스크와 같은 영역이 둘러싼 구멍에서 배경과 다른 무채색 픽셀만 추가한다. 입력은 변경하지 않는다. */
export function completeSourceTextMask(
  source: Readonly<{ width: number; height: number; pixels: Uint8ClampedArray }>,
  mask: Uint8Array,
  owners: Uint32Array,
  regions: readonly Region[],
  framePixels: Uint8Array
): { pixels: Uint8Array; maskedPixels: number; regionIds: string[] } {
  const { width, height, pixels } = source, size = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || size > 16_000_000 || pixels.length !== size * 4 || mask.length !== size || owners.length !== size || framePixels.length !== size) {
    throw new Error("원문 구멍 보완의 원본·마스크·소유권·프레임 크기가 올바르지 않습니다.");
  }
  if (new Set(regions.map(region => region.id)).size !== regions.length || regions.some(region => !region.id || !region.polygonsPx.length)) {
    throw new Error("원문 구멍 보완 영역 ID나 polygon이 누락되거나 중복됐습니다.");
  }
  const additions = new Uint8Array(size), regionIds: string[] = [];
  let maskedPixels = 0;
  for (const [regionIndex, region] of regions.entries()) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, thickness = 0;
    for (const polygon of region.polygonsPx) {
      if (polygon.length < 3 || polygon.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new Error("원문 구멍 보완 polygon이 올바르지 않습니다.");
      const xs = polygon.map(point => point.x), ys = polygon.map(point => point.y);
      const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys);
      if (right <= left || bottom <= top) throw new Error("원문 구멍 보완 polygon 면적이 없습니다.");
      x0 = Math.min(x0, left); y0 = Math.min(y0, top); x1 = Math.max(x1, right); y1 = Math.max(y1, bottom);
      thickness = Math.max(thickness, Math.min(right - left, bottom - top));
    }
    const left = Math.max(0, Math.floor(x0 - 3)), top = Math.max(0, Math.floor(y0 - 3));
    const right = Math.min(width, Math.ceil(x1 + 3)), bottom = Math.min(height, Math.ceil(y1 + 3));
    const rw = right - left, rh = bottom - top, count = rw * rh;
    if (rw <= 0 || rh <= 0) continue;
    const seen = new Uint8Array(count), inPolygon = new Uint8Array(count), queue = new Int32Array(count);
    const holes: Int32Array[] = [], histogram = new Map<number, number>();
    let backgroundSamples = 0;
    // 폴리곤에서 자르거나 중간에 멈추지 않는다. 대각선 통로도 ROI 바깥 연결로 판정한다.
    for (let start = 0; start < count; start++) {
      const pageStart = (Math.floor(start / rw) + top) * width + start % rw + left;
      if (seen[start] || mask[pageStart]) continue;
      let tail = 1, edge = false, frameHit = false, ownBoundary = true, contained = 0;
      let minX = rw, minY = rh, maxX = -1, maxY = -1;
      queue[0] = start; seen[start] = 1;
      for (let head = 0; head < tail; head++) {
        const at = queue[head]!, x = at % rw, y = Math.floor(at / rw);
        const pageAt = (y + top) * width + x + left;
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        if (x === 0 || y === 0 || x === rw - 1 || y === rh - 1) edge = true;
        if (framePixels[pageAt]) frameHit = true;
        if (region.polygonsPx.some(polygon => inside(x + left + 0.5, y + top + 0.5, polygon))) {
          inPolygon[at] = 1; contained++;
        }
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
          const next = ny * rw + nx, pageNext = (ny + top) * width + nx + left;
          if (mask[pageNext]) {
            if (owners[pageNext] !== regionIndex + 1) ownBoundary = false;
            if (framePixels[pageNext]) frameHit = true;
          } else if (!seen[next]) {
            seen[next] = 1; queue[tail++] = next;
          }
        }
      }
      if (edge) {
        // 같은 원문 폴리곤 안에서, 원래부터 바깥과 연결된 불투명 픽셀만 배경 근거로 쓴다.
        for (let i = 0; i < tail; i++) {
          const at = queue[i]!;
          if (!inPolygon[at]) continue;
          const sourceAt = ((Math.floor(at / rw) + top) * width + at % rw + left) * 4;
          if (pixels[sourceAt + 3]! < 240) continue;
          const bin = (pixels[sourceAt]! >> 3) * 1024 + (pixels[sourceAt + 1]! >> 3) * 32 + (pixels[sourceAt + 2]! >> 3);
          histogram.set(bin, (histogram.get(bin) ?? 0) + 1); backgroundSamples++;
        }
      } else if (!frameHit && ownBoundary && contained >= tail * 0.9 && Math.max(maxX - minX + 1, maxY - minY + 1) <= 1.5 * thickness) {
        holes.push(queue.slice(0, tail));
      }
    }
    let mode = -1, modeCount = 0;
    for (const [bin, samples] of histogram) if (samples > modeCount) { mode = bin; modeCount = samples; }
    if (mode < 0 || modeCount < backgroundSamples * 0.3) continue;
    const backgroundR = ((mode >> 10) & 31) * 8 + 4, backgroundG = ((mode >> 5) & 31) * 8 + 4, backgroundB = (mode & 31) * 8 + 4;
    let added = 0;
    for (const hole of holes) for (const at of hole) {
      const pageAt = (Math.floor(at / rw) + top) * width + at % rw + left, sourceAt = pageAt * 4;
      const r = pixels[sourceAt]!, g = pixels[sourceAt + 1]!, b = pixels[sourceAt + 2]!;
      if (pixels[sourceAt + 3]! < 240 || Math.max(r, g, b) - Math.min(r, g, b) > 8) continue;
      // 우연히 닫힌 구멍만으로 강한 흰 그림선을 새 원문 윤곽으로 채택하지 않는다.
      if (Math.min(r, g, b) >= 245) continue;
      if (Math.abs(r - backgroundR) <= 8 && Math.abs(g - backgroundG) <= 8 && Math.abs(b - backgroundB) <= 8) continue;
      // additions는 출력에만 기록한다. 다음 영역의 경계·연결·배경 근거는 항상 원래 mask다.
      additions[pageAt] = 255; added++;
    }
    if (added) { regionIds.push(region.id); maskedPixels += added; }
  }
  return { pixels: additions, maskedPixels, regionIds };
}

function inside(x: number, y: number, polygon: readonly PolygonPoint[]): boolean {
  let yes = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) yes = !yes;
  }
  return yes;
}
