import { dilateBinaryMask } from "./maskMorphology.js";

type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

/** 입증된 원문 윤곽에 직접 닿고 전체가 3px 안에 있는 배경 혼합색 성분만 추가한다. */
export function sourceOutlineFringe(
  source: Readonly<{ width: number; height: number; pixels: Uint8ClampedArray }>,
  roi: Rect, body: Uint8Array, trustedMask: Uint8Array, framePixels: Uint8Array, light: boolean
): Uint8Array {
  const { width, pixels } = source, count = roi.width * roi.height;
  if (body.length !== count || trustedMask.length !== width * source.height || framePixels.length !== trustedMask.length) throw new Error("원문 가장자리의 크기가 일치하지 않습니다.");
  const band = dilateBinaryMask(body, roi.width, roi.height, 3), ring = dilateBinaryMask(body, roi.width, roi.height, 6);
  const outside = new Uint8Array(count), queue = new Int32Array(count); let tail = 0;
  const seed = (x: number, y: number) => { const at = y * roi.width + x; if (!body[at] && !outside[at]) { outside[at] = 1; queue[tail++] = at; } };
  for (let x = 0; x < roi.width; x++) { seed(x, 0); seed(x, roi.height - 1); }
  for (let y = 0; y < roi.height; y++) { seed(0, y); seed(roi.width - 1, y); }
  for (let head = 0; head < tail; head++) {
    const at = queue[head]!, x = at % roi.width, y = Math.floor(at / roi.width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= roi.width || ny >= roi.height) continue;
      const next = ny * roi.width + nx;
      if (!body[next] && !outside[next]) { outside[next] = 1; queue[tail++] = next; }
    }
  }
  const histogram = new Map<number, number>(); let samples = 0;
  for (let at = 0; at < count; at++) {
    if (!outside[at] || !ring[at] || band[at]) continue;
    const page = (Math.floor(at / roi.width) + roi.y) * width + at % roi.width + roi.x, offset = page * 4;
    if (trustedMask[page] || framePixels[page] || pixels[offset + 3]! < 240) continue;
    const key = (pixels[offset]! >> 3) * 1024 + (pixels[offset + 1]! >> 3) * 32 + (pixels[offset + 2]! >> 3);
    histogram.set(key, (histogram.get(key) ?? 0) + 1); samples++;
  }
  let mode = -1, votes = 0;
  for (const [key, n] of histogram) if (n > votes) { mode = key; votes = n; }
  const additions = new Uint8Array(count);
  if (samples < 16 || votes < samples * 0.3) return additions;
  const background = [((mode >> 10) & 31) * 8 + 4, ((mode >> 5) & 31) * 8 + 4, (mode & 31) * 8 + 4];
  const direction = background.map(c => (light ? 255 : 0) - c), norm = direction.reduce((n, c) => n + c * c, 0);
  if (!norm) return additions;
  const candidates = new Uint8Array(count);
  for (let at = 0; at < count; at++) {
    if (body[at]) continue;
    const page = (Math.floor(at / roi.width) + roi.y) * width + at % roi.width + roi.x, offset = page * 4;
    if (pixels[offset + 3]! < 240) continue;
    const colour = [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
    if (light ? Math.min(...colour) >= 245 : Math.max(...colour) <= 10) continue;
    const alpha = colour.reduce((n, c, i) => n + (c - background[i]!) * direction[i]!, 0) / norm;
    if (alpha < 0.08 || alpha >= 1 || colour.some((c, i) => Math.abs(c - background[i]! - alpha * direction[i]!) > 8)) continue;
    candidates[at] = 1;
  }
  for (let start = 0; start < count; start++) {
    if (candidates[start] !== 1) continue;
    tail = 1; queue[0] = start; candidates[start] = 2; let complete = true, attached = false;
    for (let head = 0; head < tail; head++) {
      const at = queue[head]!, x = at % roi.width, y = Math.floor(at / roi.width), page = (y + roi.y) * width + x + roi.x;
      if (!band[at] || framePixels[page] || x === 0 || y === 0 || x === roi.width - 1 || y === roi.height - 1) complete = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= roi.width || ny >= roi.height) continue;
        const next = ny * roi.width + nx;
        if (body[next]) attached = true;
        if (candidates[next] === 1) { candidates[next] = 2; queue[tail++] = next; }
      }
    }
    if (complete && attached) for (let i = 0; i < tail; i++) additions[queue[i]!] = 255;
  }
  return additions;
}
