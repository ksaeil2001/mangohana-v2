import type { NormalizedBbox } from "../shared/speechBubbleExtraction.js";
import { findInteriorRectangle } from "./candidateTypesettingFit.js";

type Pixels = Uint8Array | Uint8ClampedArray;
export type BackgroundFrames = {
  sourcePixels: Pixels; cleanedPixels: Pixels; maskPixels: Pixels; width: number; height: number;
};

function erasedSourcePixel(frames:BackgroundFrames,at:number) {
  const {sourcePixels,cleanedPixels,maskPixels}=frames;
  return maskPixels[at+3]===0 && cleanedPixels[at+3]!>=250 && Math.max(
    Math.abs(cleanedPixels[at]!-sourcePixels[at]!),Math.abs(cleanedPixels[at+1]!-sourcePixels[at+1]!),
    Math.abs(cleanedPixels[at+2]!-sourcePixels[at+2]!))>=32;
}

/** Expand from the identified erased strokes only while every newly proposed
 * rectangle passes the same full-resolution source, restoration and neighbor checks. */
export function expandVerifiedInkBox(seed:NormalizedBbox,frames:BackgroundFrames,allowed:(box:NormalizedBbox)=>boolean) {
  const {width,height}=frames;
  let left=Math.round(seed.x*width),top=Math.round(seed.y*height);
  let right=left+Math.round(seed.width*width),bottom=top+Math.round(seed.height*height);
  // Bound additional pixel inspections on a fallback path that may run for many bubbles.
  if((right-left)*(bottom-top)>65_536)return;
  let best:NormalizedBbox|undefined;
  for(const step of [16,8,4,2,1]){
    for(const edge of ['left','right','top','bottom']){
      const x=left-(edge==='left'?step:0),y=top-(edge==='top'?step:0);
      const x1=right+(edge==='right'?step:0),y1=bottom+(edge==='bottom'?step:0);
      if(x<0 || y<0 || x1>width || y1>height)continue;
      const box={x:x/width,y:y/height,width:(x1-x)/width,height:(y1-y)/height};
      if(!allowed(box))continue;
      left=x;top=y;right=x1;bottom=y1;best=box;
    }
  }
  if(!best)return;
  let erasedInkPixels=0;
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)if(erasedSourcePixel(frames,(y*width+x)*4))erasedInkPixels++;
  return {bbox:best,erasedInkPixels};
}

/** Proposals only. The caller must verify the full-resolution original, mask,
 * restored rectangle and margin, then measure and paint the entire utterance. */
export function findSourceInkBoxes(frames: BackgroundFrames, source: NormalizedBbox) {
  const { width, height, cleanedPixels } = frames;
  const left = Math.ceil(source.x * width - 1e-9), top = Math.ceil(source.y * height - 1e-9);
  const right = Math.floor((source.x + source.width) * width + 1e-9);
  const bottom = Math.floor((source.y + source.height) * height + 1e-9);
  const w = right - left, h = bottom - top;
  const proposals: { bbox: NormalizedBbox; erasedInkPixels: number; score: number }[] = [];
  if (w < 10 || h < 10) return proposals;

  const erasedInk = (at: number) => erasedSourcePixel(frames,at);
  // Nominate actual restored colours at erased strokes. Quantizing an almost
  // gray RGB triple independently can shift the proposed band off the paper.
  const counts = new Map<number, number>();
  const sampleStep = Math.max(1, Math.ceil(Math.sqrt(w * h / 8192)));
  for (let y = top; y < bottom; y += sampleStep) for (let x = left; x < right; x += sampleStep) {
    const at = (y * width + x) * 4;
    if (!erasedInk(at)) continue;
    const color = cleanedPixels[at]! << 16 | cleanedPixels[at + 1]! << 8 | cleanedPixels[at + 2]!;
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  const colors = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (!colors.length) return proposals;
  const step = Math.max(1, Math.ceil(Math.sqrt(w * h / 131072)));
  const cols = Math.ceil(w / step), rows = Math.ceil(h / step);
  const matching = new Uint8Array(cols * rows), seen = new Set<string>();
  for (const [color] of colors) {
    const r = color >> 16, g = (color >> 8) & 255, b = color & 255;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const at = ((top + y * step) * width + left + x * step) * 4;
      matching[y * cols + x] = Number(cleanedPixels[at + 3]! >= 250 &&
        Math.abs(cleanedPixels[at]! - r) <= 4 && Math.abs(cleanedPixels[at + 1]! - g) <= 4 && Math.abs(cleanedPixels[at + 2]! - b) <= 4);
    }
    const rect = findInteriorRectangle(matching, cols, rows, { x: cols / 2, y: rows / 2 });
    if (!rect) continue;
    const x0 = left + rect.x * step, y0 = top + rect.y * step;
    const x1 = Math.min(right, x0 + rect.width * step), y1 = Math.min(bottom, y0 + rect.height * step);
    const key = [x0, y0, x1, y1].join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    let count = 0, minX = x1, minY = y1, maxX = x0, maxY = y0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!erasedInk((y * width + x) * 4)) continue;
      count++;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    // A blank patch or one erased speck doesn't locate this utterance.
    const boxWidth = x1 - x0, boxHeight = y1 - y0;
    if (count < 32 || (maxX - minX + 1 < Math.max(12, boxWidth / 3) &&
        maxY - minY + 1 < Math.max(12, boxHeight / 3))) continue;
    const dx = (x0 + x1 - left - right) / (2 * w), dy = (y0 + y1 - top - bottom) / (2 * h);
    const score = boxWidth * boxHeight / (1 + 4 * (dx * dx + dy * dy));
    proposals.push({ bbox: { x: x0 / width, y: y0 / height, width: boxWidth / width, height: boxHeight / height },
      erasedInkPixels: count, score });
  }
  return proposals.sort((a, b) => b.score - a.score);
}
