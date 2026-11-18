import { calculateAdaptiveDilationRadius, dilateBinaryMask } from "./maskMorphology.js";
import type { PolygonPoint } from "./speechBubbleExtraction.js";
import { sourceOutlineFringe } from "./sourceOutlineFringe.js";

type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;
type Region = Readonly<{ id: string; polygonsPx: readonly (readonly PolygonPoint[])[] }>;

/** 기존에 제거한 글자와 같은 OCR 영역이 입증하는, 여러 글자의 연결 윤곽만 추가한다. */
export function buildLinkedSourceOutlineAdditions(
  source: Readonly<{ width: number; height: number; pixels: Uint8ClampedArray }>,
  trustedMask: Uint8Array, regions: readonly Region[], frames: readonly Rect[], framePixels: Uint8Array
): { pixels: Uint8Array; owners: Uint32Array; regionIds: string[]; regionBounds: { id: string; bounds: Rect }[] } {
  const { width, height, pixels } = source, size = width * height;
  if (trustedMask.length !== size || framePixels.length !== size || pixels.length !== size * 4) throw new Error("연결 윤곽의 원본·마스크 크기가 일치하지 않습니다.");
  const additions = new Uint8Array(size), owners = new Uint32Array(size), regionIds = new Set<string>(), boundsByRegion = new Map<string, Rect>();
  for (const [regionIndex, region] of regions.entries()) {
    const points = region.polygonsPx.flat(), xs = points.map(p => p.x), ys = points.map(p => p.y);
    const thickness = Math.max(...region.polygonsPx.map(p => Math.min(Math.max(...p.map(q => q.x)) - Math.min(...p.map(q => q.x)), Math.max(...p.map(q => q.y)) - Math.min(...p.map(q => q.y)))));
    const padding = Math.ceil(thickness * 0.5) + 5;
    const left = Math.max(0, Math.floor(Math.min(...xs) - padding)), top = Math.max(0, Math.floor(Math.min(...ys) - padding));
    const right = Math.min(width, Math.ceil(Math.max(...xs) + padding)), bottom = Math.min(height, Math.ceil(Math.max(...ys) + padding));
    const rw = right - left, rh = bottom - top, count = rw * rh;
    if (rw <= 0 || rh <= 0) continue;
    const radius = calculateAdaptiveDilationRadius({ bboxWidth: thickness, bboxHeight: thickness, canvasWidth: width, canvasHeight: height, minRadius: 3, maxRadius: 24 }) + 3;
    for (const light of [true, false]) {
      const foreground = new Uint8Array(count), queue = new Int32Array(count);
      for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
        const at = ((y + top) * width + x + left) * 4;
        if (pixels[at + 3]! >= 240 && (light ? Math.min(pixels[at]!, pixels[at + 1]!, pixels[at + 2]!) >= 245 : Math.max(pixels[at]!, pixels[at + 1]!, pixels[at + 2]!) <= 10)) foreground[y * rw + x] = 1;
      }
      for (let start = 0; start < count; start++) {
        if (foreground[start] !== 1) continue;
        let tail = 1, minX = rw, minY = rh, maxX = -1, maxY = -1, frameHit = false;
        queue[0] = start; foreground[start] = 2;
        for (let head = 0; head < tail; head++) {
          const at = queue[head]!, x = at % rw, y = Math.floor(at / rw);
          minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
          frameHit ||= Boolean(framePixels[(y + top) * width + x + left]);
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
            const next = ny * rw + nx;
            if (foreground[next] === 1) { foreground[next] = 2; queue[tail++] = next; }
          }
        }
        if (tail < 16 || frameHit || minX === 0 || minY === 0 || maxX === rw - 1 || maxY === rh - 1) continue;
        const box = { x: minX + left, y: minY + top, width: maxX - minX + 1, height: maxY - minY + 1 };
        if (frames.some(frame => box.x >= frame.x && box.y >= frame.y && box.x + box.width <= frame.x + frame.width && box.y + box.height <= frame.y + frame.height)) continue;
        const component = Int32Array.from(queue.subarray(0, tail)), barrier = new Uint8Array(count);
        if (component.every(at => trustedMask[(Math.floor(at / rw) + top) * width + at % rw + left])) continue;
        for (const at of component) barrier[at] = 1;
        // 실제 AA로 이어지는 닫힘을 먼저 확인한다. 밝기 문턱의 1px 틈을 바깥 배경으로 오인하지 않는다.
        const fringe = sourceOutlineFringe(source, { x: left, y: top, width: rw, height: rh }, barrier, trustedMask, framePixels, light);
        for (let at = 0; at < fringe.length; at++) if (fringe[at]) {
          barrier[at] = 1;
          minX = Math.min(minX, at % rw); minY = Math.min(minY, Math.floor(at / rw));
          maxX = Math.max(maxX, at % rw); maxY = Math.max(maxY, Math.floor(at / rw));
        }
        const seen = new Uint8Array(count), associated = new Uint8Array(count); let qualifiedHoles = 0;
        for (let sy = minY; sy <= maxY; sy++) for (let sx = minX; sx <= maxX; sx++) {
          const seed = sy * rw + sx;
          if (barrier[seed] || seen[seed]) continue;
          let n = 1, edge = false, core = 0, trusted = 0, owned = 0, cx0 = rw, cy0 = rh, cx1 = -1, cy1 = -1;
          queue[0] = seed; seen[seed] = 1;
          for (let head = 0; head < n; head++) {
            const at = queue[head]!, x = at % rw, y = Math.floor(at / rw), page = (y + top) * width + x + left, offset = page * 4;
            cx0 = Math.min(cx0, x); cy0 = Math.min(cy0, y); cx1 = Math.max(cx1, x); cy1 = Math.max(cy1, y);
            if (x === minX || y === minY || x === maxX || y === maxY) edge = true;
            if (pixels[offset + 3]! >= 240 && (light ? Math.max(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!) <= 128 : Math.min(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!) >= 128)) {
              core++; if (trustedMask[page]) trusted++;
              if (region.polygonsPx.some(p => inside(x + left + 0.5, y + top + 0.5, p))) owned++;
            }
            for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
              const nx = x + dx!, ny = y + dy!;
              if (nx < minX || ny < minY || nx > maxX || ny > maxY) continue;
              const next = ny * rw + nx;
              if (!barrier[next] && !seen[next]) { seen[next] = 1; queue[n++] = next; }
            }
          }
          const glyphCavity = !edge && core >= 16 && owned >= core * 0.9 && Math.max(cx1 - cx0 + 1, cy1 - cy0 + 1) <= 1.5 * thickness;
          if (glyphCavity) for (let i = 0; i < n; i++) associated[queue[i]!] = 255;
          if (glyphCavity && core >= n * 0.5 && trusted >= core * 0.9) {
            qualifiedHoles++;
          }
        }
        if (qualifiedHoles < 2 || rectangularBoundary(component, rw)) continue;
        const nearInk = dilateBinaryMask(associated, rw, rh, radius);
        // 원본의 두꺼운 둥근 윤곽은 마스크 팽창 반경과 다르다. 얇게 뻗은 가지는 열기 연산에서 제외한다.
        const broadContour = openedContour(barrier, rw, rh, Math.max(1, Math.floor(radius / 2)));
        let complete = true, addsPixels = false;
        for (const at of component) {
          const x = at % rw + left, y = Math.floor(at / rw) + top;
          if ((!nearInk[at] && !broadContour[at]) || !region.polygonsPx.some(p => nearPolygon(x + 0.5, y + 0.5, p, radius))) { complete = false; break; }
          addsPixels ||= !trustedMask[y * width + x];
        }
        if (!complete || !addsPixels) continue;
        for (const at of component) {
          const page = (Math.floor(at / rw) + top) * width + at % rw + left, owner = regionIndex + 1;
          additions[page] = 255; owners[page] = !owners[page] || owners[page] === owner ? owner : 0xffffffff;
        }
        boundsByRegion.set(region.id, unite(boundsByRegion.get(region.id), box));
        for (let at = 0; at < fringe.length; at++) if (fringe[at]) {
          const x = at % rw + left, y = Math.floor(at / rw) + top, page = y * width + x, owner = regionIndex + 1;
          additions[page] = 255; owners[page] = !owners[page] || owners[page] === owner ? owner : 0xffffffff;
          boundsByRegion.set(region.id, unite(boundsByRegion.get(region.id), { x, y, width: 1, height: 1 }));
        }
        regionIds.add(region.id);
      }
    }
  }
  return { pixels: additions, owners, regionIds: [...regionIds], regionBounds: [...boundsByRegion].map(([id, bounds]) => ({ id, bounds })) };
}

/** 원본 성분 안에 원판이 들어가는 부분만 복원한다. 새 픽셀을 그리거나 OCR 상자로 자르지 않는다. */
function openedContour(body: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const core = new Uint8Array(body.length), offsets: [number, number][] = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) if (dx * dx + dy * dy <= radius * radius) offsets.push([dx, dy]);
  for (let at = 0; at < body.length; at++) {
    if (!body[at]) continue;
    const x = at % width, y = Math.floor(at / width);
    if (offsets.every(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height && body[(y + dy) * width + x + dx])) core[at] = 255;
  }
  // 원판 경계를 픽셀 격자로 반올림하면서 생기는 1px만 허용한다. 선택은 여전히 원본 성분으로 제한된다.
  return dilateBinaryMask(core, width, height, radius + 1);
}

/** 회전 여부와 무관하게 네 변이 연속된 프레임·평평한 배경을 보수적으로 제외한다. */
function rectangularBoundary(component: Int32Array, width: number): boolean {
  const rows = new Map<number, [number, number]>();
  for (const at of component) { const x = at % width, y = Math.floor(at / width), row = rows.get(y); if (row) { row[0] = Math.min(row[0], x); row[1] = Math.max(row[1], x); } else rows.set(y, [x, x]); }
  const points: [number, number][] = [];
  for (const [y, [left, right]] of rows) { points.push([left, y]); if (left !== right) points.push([right, y]); }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a: number[], b: number[], c: number[]) => (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const p of points) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop(); lower.push(p); }
  for (const p of points.slice().reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let best: { ux: number; uy: number; a: number; b: number; c: number; d: number; area: number } | undefined;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i]!, q = hull[(i + 1) % hull.length]!, length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!length) continue;
    const ux = (q[0] - p[0]) / length, uy = (q[1] - p[1]) / length;
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [x, y] of hull) { const u = x * ux + y * uy, v = -x * uy + y * ux; a = Math.min(a, u); b = Math.max(b, u); c = Math.min(c, v); d = Math.max(d, v); }
    const area = (b - a) * (d - c); if (!best || area < best.area) best = { ux, uy, a, b, c, d, area };
  }
  if (!best) return true;
  const { ux, uy, a, b, c, d } = best, alongU = Math.ceil(b - a) + 1, alongV = Math.ceil(d - c) + 1;
  const tolerance = 0.25 + 1.5 * Math.abs(ux * uy);
  const edges = [new Uint8Array(alongV), new Uint8Array(alongV), new Uint8Array(alongU), new Uint8Array(alongU)];
  for (const at of component) {
    const x = at % width, y = Math.floor(at / width), u = x * ux + y * uy, v = -x * uy + y * ux;
    for (const rounded of [Math.floor, Math.ceil]) {
      const ui = Math.max(0, Math.min(alongU - 1, rounded(u - a))), vi = Math.max(0, Math.min(alongV - 1, rounded(v - c)));
      if (u - a <= tolerance) edges[0]![vi] = 1; if (b - u <= tolerance) edges[1]![vi] = 1;
      if (v - c <= tolerance) edges[2]![ui] = 1; if (d - v <= tolerance) edges[3]![ui] = 1;
    }
  }
  return edges.every(edge => edge.reduce((a, b) => a + b, 0) >= edge.length * 0.8);
}
function unite(a: Rect | undefined, b: Rect): Rect {
  if (!a) return b;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function inside(x: number, y: number, polygon: readonly PolygonPoint[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
function nearPolygon(x: number, y: number, polygon: readonly PolygonPoint[], radius: number): boolean {
  return inside(x, y, polygon) || polygon.some((a, i) => {
    const b = polygon[(i + 1) % polygon.length]!, dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length)) : 0;
    return (x - a.x - dx * t) ** 2 + (y - a.y - dy * t) ** 2 <= radius * radius;
  });
}
