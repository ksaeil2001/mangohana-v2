import { dilateBinaryMask } from "./maskMorphology.js";
import type { PolygonPoint } from "./speechBubbleExtraction.js";

type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

/** 색 있는 그림과 붙어 한 성분이 된 원문을, 밝은 배경이 획 양쪽에 있는지 확인해 분리한다. */
export function extractBackgroundSupportedGlyphs(
  source: Readonly<{ width: number; pixels: Uint8ClampedArray }>, roi: Rect,
  polygon: readonly PolygonPoint[], thickness: number, background: number,
  connectedArt: Uint8Array, framePixels: Uint8Array
): Uint8Array {
  const { width, pixels } = source, count = roi.width * roi.height, output = new Uint8Array(count);
  if (background < 200 || !connectedArt.some(Boolean)) return output;
  const neutral = new Uint8Array(count), colour = new Uint8Array(count), candidates = new Uint8Array(count), queue = new Int32Array(count);
  const threshold = Math.min(190, background - 45), radius = Math.max(3, Math.min(24, Math.ceil(thickness * 0.25)));
  for (let y = 0; y < roi.height; y++) for (let x = 0; x < roi.width; x++) {
    const at = y * roi.width + x, page = (y + roi.y) * width + x + roi.x, offset = page * 4;
    const r = pixels[offset]!, g = pixels[offset + 1]!, b = pixels[offset + 2]!;
    if (pixels[offset + 3]! < 240 || 0.299 * r + 0.587 * g + 0.114 * b > threshold) continue;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 8) colour[at] = 255;
    else if (!framePixels[page]) neutral[at] = 255;
  }
  const colourGuard = dilateBinaryMask(colour, roi.width, roi.height, 3);
  const paper = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= roi.width || y >= roi.height) return false;
    const offset = ((y + roi.y) * width + x + roi.x) * 4, r = pixels[offset]!, g = pixels[offset + 1]!, b = pixels[offset + 2]!;
    return pixels[offset + 3]! >= 240 && 0.299 * r + 0.587 * g + 0.114 * b >= background - 24 && Math.max(r, g, b) - Math.min(r, g, b) <= 24;
  };
  for (let y = 0; y < roi.height; y++) for (let x = 0; x < roi.width; x++) {
    const at = y * roi.width + x;
    if (!neutral[at] || colourGuard[at]) continue;
    for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
      let forward = false, backward = false;
      for (let step = 1; step <= radius; step++) { forward ||= paper(x + dx * step, y + dy * step); backward ||= paper(x - dx * step, y - dy * step); }
      if (forward && backward) { candidates[at] = 1; break; }
    }
  }
  for (let start = 0; start < count; start++) {
    if (candidates[start] !== 1) continue;
    let tail = 1, minX = roi.width, minY = roi.height, maxX = -1, maxY = -1, owned = 0, mixed = 0;
    queue[0] = start; candidates[start] = 2;
    for (let head = 0; head < tail; head++) {
      const at = queue[head]!, x = at % roi.width, y = Math.floor(at / roi.width);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      if (inside(x + roi.x + 0.5, y + roi.y + 0.5, polygon)) owned++;
      if (connectedArt[at]) mixed++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= roi.width || ny >= roi.height) continue;
        const next = ny * roi.width + nx;
        if (candidates[next] === 1) { candidates[next] = 2; queue[tail++] = next; }
      }
    }
    if (tail < 16 || owned < tail * 0.9 || mixed < tail * 0.9 || minX === 0 || minY === 0 || maxX === roi.width - 1 || maxY === roi.height - 1 || Math.min(maxX - minX + 1, maxY - minY + 1) < 2 || Math.max(maxX - minX + 1, maxY - minY + 1) > 1.5 * thickness) continue;
    for (let i = 0; i < tail; i++) output[queue[i]!] = 255;
  }
  return output;
}

function inside(x: number, y: number, polygon: readonly PolygonPoint[]): boolean {
  let yes = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i]!, b = polygon[j]!; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) yes = !yes; }
  return yes;
}
