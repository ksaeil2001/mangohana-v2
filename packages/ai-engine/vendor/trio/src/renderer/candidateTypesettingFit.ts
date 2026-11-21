import type { DialogueTypesetting } from "../shared/projectTypes.js";
import type { ShapePadding } from "../shared/typesettingShape.js";
import type { TypesettingLayoutResult } from "../shared/typesettingGeometry.js";
import {
  autoFitFontSizeForBubbleShape,
  getRecommendedFontFallbackChain, layoutTextForBubbleShape
} from "../shared/typesettingGeometry.js";
import { isValidTypesettingGeometry } from "../shared/renderReadiness.js";
import {evaluateKoreanTypesetting,isGeneralKorean,inspectKoreanText,type StandardResult} from "../../../../quality/korean-typesetting-standard.cjs";

export type InteriorRectangle = { x: number; y: number; width: number; height: number; padding: number };

/** Verify a fixed source box without moving it into another dialogue's area.
 * The rectangular margin is at least as strict as findInteriorRectangle's
 * 4% component inset; holes and every edge pixel remain excluded. */
export function isInsetInteriorRectangle(
  mask: Uint8Array, width: number, height: number,
  box: { x: number; y: number; width: number; height: number }
): boolean {
  if (![width, height].every(v => Number.isSafeInteger(v) && v > 0) || mask.length !== width * height ||
      ![box.x, box.y, box.width, box.height].every(Number.isSafeInteger) || box.width < 10 || box.height < 10) return false;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let at = 0; at < mask.length; at++) if (mask[at]) {
    const x = at % width, y = Math.floor(at / width);
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (maxX < 0) return false;
  const padding = Math.max(2, Math.ceil(Math.min(maxX - minX + 1, maxY - minY + 1) * 0.04));
  const left = box.x - padding, top = box.y - padding, right = box.x + box.width + padding, bottom = box.y + box.height + padding;
  if (left < 0 || top < 0 || right > width || bottom > height) return false;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) if (!mask[y * width + x]) return false;
  return true;
}

/** 연결된 내부 픽셀을 침식한 뒤 그 안에 완전히 들어가는 사각형을 찾는다. */
export function findInteriorRectangle(
  mask: Uint8Array, width: number, height: number, anchor: { x: number; y: number },
  bounds?: { x: number; y: number; width: number; height: number }, requireAnchor = false
): InteriorRectangle | undefined {
  if (mask.length !== width * height || width < 1 || height < 1) throw new Error("말풍선 내부 크기가 올바르지 않습니다.");
  if (bounds && (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) ||
      bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0 ||
      bounds.x + bounds.width > width || bounds.y + bounds.height > height)) throw new Error("흰 영역의 식자 허용 범위가 올바르지 않습니다.");
  const distance = new Uint16Array(mask.length);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * width + x;
    if (!mask[at]) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    distance[at] = Math.min(x ? distance[at - 1]! : 0, y ? distance[at - width]! : 0) + 1;
  }
  if (maxX < 0) return undefined;
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const at = y * width + x;
    if (mask[at]) distance[at] = Math.min(distance[at]!,
      (x + 1 < width ? distance[at + 1]! : 0) + 1,
      (y + 1 < height ? distance[at + width]! : 0) + 1);
  }
  const padding = Math.max(2, Math.ceil(Math.min(maxX - minX + 1, maxY - minY + 1) * 0.04));
  const heights = new Int32Array(width), stack = new Int32Array(width + 1);
  let best: InteriorRectangle | undefined, bestScore = 0;
  for (let y = 0; y < height; y++) {
    // Restrict placement only AFTER measuring the full closed component. Cropping
    // the component first would reduce its 4% padding or hide an open boundary.
    for (let x = 0; x < width; x++) heights[x] = (!bounds ||
      x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height) &&
      distance[y * width + x]! > padding ? heights[x]! + 1 : 0;
    let tail = 0;
    for (let x = 0; x <= width; x++) {
      const currentHeight = x === width ? 0 : heights[x]!;
      while (tail && heights[stack[tail - 1]!]! > currentHeight) {
        const h = heights[stack[--tail]!]!, left = tail ? stack[tail - 1]! + 1 : 0, w = x - left;
        if (w < 10 || h < 10) continue;
        const top = y - h + 1, area = w * h;
        if (requireAnchor && (anchor.x < left || anchor.x >= x || anchor.y < top || anchor.y > y)) continue;
        const dx = Math.max(left - anchor.x, 0, anchor.x - (x - 1));
        const dy = Math.max(top - anchor.y, 0, anchor.y - y);
        const score = area / (1 + 0.25 * Math.abs(Math.log(w / h))) / (1 + (dx * dx + dy * dy) / area);
        if (score > bestScore) { bestScore = score; best = { x: left, y: top, width: w, height: h, padding }; }
      }
      stack[tail++] = x;
    }
  }
  return best;
}

export type MeasuredCandidateFit = {
  layout: TypesettingLayoutResult;
  fontSizePx: number;
  strokeWidthPx: number;
  completeText: boolean;
  fitsBox: boolean;
  resized: boolean;
  linesSeparated: boolean;
  inkBounds: Array<{ left: number; right: number; top: number; bottom: number }>;
  status: "FIT_WARNING" | "MANUAL_LAYOUT_REQUIRED";
  standard?:StandardResult;
  selection: { initialFontSizePx: number; candidatesMeasured: number; intraWordBreaks: number; score: number; rule: "SIZE_AND_EOJEOL_V1" | "KO_STANDARD_V1" };
};

/** Check exact line fragments against the source. Only whitespace AT a soft
 * wrap may move to the break; interior spacing and explicit newlines stay owned. */
export function inspectTypesettingText(source: string, lines: readonly string[]) {
  const paragraphs = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph = 0, offset = 0, complete = true;
  for (const line of lines) {
    const expected = paragraphs[paragraph];
    if (expected === undefined || /[\r\n]/.test(line)) { complete = false; break; }
    if (offset) while (/[ \t]/.test(expected[offset] ?? "\0")) offset++;
    if (!expected.startsWith(line, offset)) { complete = false; break; }
    offset += line.length;
    if (!expected.slice(offset).trim()) { paragraph++; offset = 0; }
  }
  complete &&= paragraph === paragraphs.length && offset === 0;
  const original = [...source.replace(/\s/g, "")], rendered = [...lines.join("").replace(/\s/g, "")];
  return { complete: complete && original.join("") === rendered.join("") && inspectKoreanText(source,lines).complete,
    missingCharacters: Math.max(0, original.length - rendered.length),
    extraCharacters: Math.max(0, rendered.length - original.length), sourceText: source, renderedLines: [...lines] };
}

const titleWord = /^(?:선배님?|후배님?|선생님|씨|군|양|님)(?:께서는|에게서|에게|한테|께서|께|에서|이랑|하고|처럼|까지|부터|이라도|을|를|은|는|이|가|의|와|과|도|만)?[\p{P}~～]*$/u;
function isAddressPair(previous: string, next: string) {
  return /^[가-힣]{1,6}$/u.test(previous) && !/(?:세요|니다|예요|에요)$/u.test(previous) && titleWord.test(next);
}

export function containsKoreanAddress(line: string): boolean {
  const words = line.match(/\S+/gu) ?? [];
  return words.some((word, index) => index > 0 && isAddressPair(words[index - 1]!, word));
}

/** Move a soft break to either side of a short word and its title. Slice the
 * original text so spacing, including spacing inside the joined phrase, survives. */
export function honorificWrapAlternatives(text: string, lines: readonly string[]): string[][] {
  if (lines.length < 2 || /[\r\n]/u.test(text)) return [];
  const words = [...text.matchAll(/\S+/gu)];
  let count = 0;
  const breaks = lines.slice(0, -1).map(line => (count += line.match(/\S+/gu)?.length ?? 0));
  const detached = new Set(breaks.filter(end => isAddressPair(words[end - 1]?.[0] ?? "", words[end]?.[0] ?? "")));
  if (!detached.size || !inspectTypesettingText(text, lines).complete) return [];
  const alternatives: string[][] = [];
  const proposedBreaks = [1, -1].map(direction => breaks.map(end => detached.has(end) ? end + direction : end));
  // Release the other soft breaks as a third option. The regular shape fitter
  // can then balance the words before and after the intact form of address.
  proposedBreaks.push([...detached].flatMap(end => [end - 1, end + 1]));
  for (const proposal of proposedBreaks) {
    const ends = [...new Set(proposal.filter(end => end > 0 && end < words.length))].sort((a, b) => a - b);
    ends.push(words.length);
    let start = 0;
    const rows = ends.map(end => {
      const last = words[end - 1]!;
      const row = text.slice(start ? words[start]!.index : 0, end === words.length ? text.length : last.index + last[0].length);
      start = end;
      return row;
    });
    if (!alternatives.some(other => other.length === rows.length && other.every((row, i) => row === rows[i]))) alternatives.push(rows);
  }
  return alternatives;
}

/** 최종 Canvas와 같은 반올림·굵은 글꼴·외곽선을 측정한다. 사용자 크기는 유지한다. */
export function measureCandidateFit(
  context: CanvasRenderingContext2D, text: string, style: DialogueTypesetting,
  imageWidth: number, imageHeight: number,scope:{dialogueType?:string; preferredFontSizePx?:number; padding?:ShapePadding; softLines?:readonly string[]}={}
): MeasuredCandidateFit {
  if (![imageWidth, imageHeight].every(v => Number.isSafeInteger(v) && v > 0) || !isValidTypesettingGeometry(style) ||
      style.strokeWidth !== undefined && (!Number.isFinite(style.strokeWidth) || style.strokeWidth < 0)) throw new Error("식자 좌표·크기·행간이 유효하지 않습니다.");
  const width = style.bbox.width * imageWidth, height = style.bbox.height * imageHeight;
  const general=isGeneralKorean({text,...style,...scope}),minimum=general?13:10;
  const layoutText = scope.softLines?.join("\n") ?? text;
  const options = { shape: style.shape ?? "ellipse", boxAspectRatio: width / height,preserveEojeol:general,padding:scope.padding,
    measureTextWidth: (value: string, ratio: number) => {
      const px = Math.max(1, Math.round(ratio * height));
      context.font = `bold ${px}px ${getRecommendedFontFallbackChain("ko", style.fontFamily || "Pretendard")}`;
      const stroke = style.strokeWidth ?? Math.min(2, Math.max(1, Math.round(px * 0.06)));
      return (context.measureText(value).width + 2 * stroke) / width;
    }
  };
  let latest!: MeasuredCandidateFit;
  let best: MeasuredCandidateFit | undefined, bestScore = -Infinity, candidatesMeasured = 0;
  context.save();
  try {
    context.textBaseline = "middle"; context.textAlign = style.align ?? "center";
    const initial = style.fontSizeRatio !== undefined
      ? layoutTextForBubbleShape(layoutText, { ...options, fontSizeRatio: style.fontSizeRatio })
      : autoFitFontSizeForBubbleShape(layoutText, options);
    // The estimate's ratio cap can be smaller than the readable minimum in a
    // shallow box. Measure that minimum once against the same ink/shape bounds.
    const requestedStart = scope.preferredFontSizePx ?? 0;
    const preferred = Number.isSafeInteger(requestedStart) ? requestedStart : 0;
    const initialPx = Math.max(style.fontSizeRatio === undefined ? Math.max(minimum, preferred) : 1,
      Math.round(initial.fontSizeRatio * height));
    for (let px = initialPx; px >= Math.min(minimum, initialPx); px--) {
      const ratio = style.fontSizeRatio ?? px / height;
      const fontSizePx = Math.max(1, Math.round(ratio * height));
      context.font = `bold ${fontSizePx}px ${getRecommendedFontFallbackChain("ko", style.fontFamily || "Pretendard")}`;
      const strokeWidthPx = style.strokeWidth ?? Math.min(2, Math.max(1, Math.round(fontSizePx * 0.06)));
      const fullMetrics = context.measureText(text);
      const lineHeight = style.lineHeight ?? Math.max(1.25,
        (fullMetrics.actualBoundingBoxAscent + fullMetrics.actualBoundingBoxDescent + 2 * strokeWidthPx + 1) / fontSizePx);
      const layout = layoutTextForBubbleShape(layoutText, { ...options, fontSizeRatio: ratio, lineHeight });
      const completeText = inspectTypesettingText(text, layout.lines.map(line => line.text)).complete;
      const bounds = layout.lines.filter(line => line.text.trim()).map(line => {
        const metrics = context.measureText(line.text);
        const x = style.align === "left" ? line.startX * width : style.align === "right" ? (line.startX + line.width) * width : width / 2;
        const y = line.relativeY * height;
        return { left: x - metrics.actualBoundingBoxLeft - strokeWidthPx, right: x + metrics.actualBoundingBoxRight + strokeWidthPx,
          top: y - metrics.actualBoundingBoxAscent - strokeWidthPx, bottom: y + metrics.actualBoundingBoxDescent + strokeWidthPx };
      });
      const linesSeparated = bounds.every((line, index) => !index || line.top >= bounds[index - 1]!.bottom);
      const visibleLines=layout.lines.filter(line=>line.text.trim());
      // Match autoFitFontSizeForBubbleShape's existing width acceptance (1.08).
      // Shape padding is a planning span, not a replacement for the stricter
      // independent source/cleaned pixel mask and full stroke bounds checks.
      const spansFit=!general||visibleLines.every(line=>options.measureTextWidth(line.text,ratio)<=line.width*1.08+1e-9);
      const fitsBox = completeText && linesSeparated && spansFit && bounds.every(line => line.left >= 0 && line.right <= width && line.top >= 0 && line.bottom <= height);
      let cursor = 0, intraWordBreaks = 0;
      const canonical = text.replace(/\r\n?/g, "\n");
      for (const [index, line] of layout.lines.entries()) {
        if (!line.text.trim()) continue;
        while (/\s/.test(canonical[cursor] ?? "\0")) cursor++;
        cursor += line.text.length;
        if (index + 1 < layout.lines.length && canonical[cursor] && !/\s/.test(canonical[cursor]!)) intraWordBreaks++;
      }
      const standard=general?evaluateKoreanTypesetting({text,lines:layout.lines.map(l=>l.text),...style,stage:'SOURCE_METRICS',fontSizePx,minFontSizePx:minimum,lineHeight,
        referenceFontSizePx:initialPx,measurement:{completeText,fitsBox,linesSeparated,inkBounds:bounds}}):undefined;
      const score = standard?.readability?.score??(fontSizePx / initialPx * 10 - intraWordBreaks * 4);
      candidatesMeasured++;
      latest = { layout, fontSizePx, strokeWidthPx, completeText, fitsBox, resized: px !== initialPx, linesSeparated, inkBounds: bounds,
        status: fitsBox && fontSizePx >= minimum && standard?.status!=='BLOCKED' ? "FIT_WARNING" : "MANUAL_LAYOUT_REQUIRED",...(standard?{standard}:{}),
        selection: { initialFontSizePx: initialPx, candidatesMeasured, intraWordBreaks, score, rule: general?"KO_STANDARD_V1":"SIZE_AND_EOJEOL_V1" } };
      if (style.fontSizeRatio !== undefined) return latest;
      if (fitsBox && standard?.status!=='BLOCKED' && score > bestScore) { best = latest; bestScore = score; }
      // Search at most 30% smaller once a fit exists; never shrink indefinitely
      // to chase typography. Manual font size is evaluated exactly once above.
      if (best && ((!general&&intraWordBreaks === 0 && fitsBox) || px <= Math.max(minimum, Math.ceil(initialPx * .7)))) {
        best.selection.candidatesMeasured = candidatesMeasured; return best;
      }
    }
    if (best) { best.selection.candidatesMeasured = candidatesMeasured; return best; }
    return latest;
  } finally { context.restore(); }
}

export type CandidateInterior = {
  mask: Uint8Array; left: number; top: number; width: number; height: number;
};

/** 투명 Canvas에 실제로 그린 글자·외곽선의 모든 픽셀을 검사한다. 자르지 않는다. */
export function inspectCandidateInk(
  pixels: Uint8ClampedArray, width: number, height: number, interior?: CandidateInterior
): { paintedPixels: number; outsideInteriorPixels: number | null; hasInk: boolean; canvasEdgePixels: number;
     inkBounds: { x: number; y: number; width: number; height: number } | null } {
  if (![width, height].every(v => Number.isSafeInteger(v) && v > 0) || pixels.length !== width * height * 4) throw new Error("식자 픽셀 크기가 올바르지 않습니다.");
  if (interior && (![interior.left, interior.top, interior.width, interior.height].every(Number.isSafeInteger) ||
      interior.width <= 0 || interior.height <= 0 || interior.mask.length !== interior.width * interior.height)) throw new Error("안전 내부의 픽셀 좌표계가 유효하지 않습니다.");
  let paintedPixels = 0, outside = 0, canvasEdgePixels = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let at = 0; at < width * height; at++) {
    if (!pixels[at * 4 + 3]) continue;
    paintedPixels++;
    const pageX = at % width, pageY = Math.floor(at / width);
    minX = Math.min(minX, pageX); maxX = Math.max(maxX, pageX); minY = Math.min(minY, pageY); maxY = Math.max(maxY, pageY);
    if (!pageX || !pageY || pageX === width - 1 || pageY === height - 1) canvasEdgePixels++;
    if (interior) {
      const x = at % width - interior.left, y = Math.floor(at / width) - interior.top;
      if (x < 0 || y < 0 || x >= interior.width || y >= interior.height || !interior.mask[y * interior.width + x]) outside++;
    }
  }
  return { paintedPixels, outsideInteriorPixels: interior ? outside : null, hasInk: paintedPixels > 0, canvasEdgePixels,
    inkBounds: paintedPixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null };
}
