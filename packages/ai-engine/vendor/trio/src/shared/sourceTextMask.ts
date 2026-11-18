import { dilateBinaryMask } from "./maskMorphology.js";
import { buildLinkedSourceOutlineAdditions } from "./linkedSourceOutline.js";
import { completeSourceTextMask } from "./sourceTextMaskCompletion.js";
import { extractBackgroundSupportedGlyphs } from "./backgroundSupportedGlyphs.js";
import type { PolygonPoint } from "./speechBubbleExtraction.js";

type Rect = { x: number; y: number; width: number; height: number };
export type SourceTextMaskRegion = Readonly<{ id: string; polygonsPx: readonly (readonly PolygonPoint[])[] }>;
export type SourceTextMaskOptions = Readonly<{ outlinePolicy?: "legacy" | "bounded-component-v1" }>;
export type SourceTextMaskRegionResult = {
  id: string; radius: number; bboxPx: Rect; selectedInkPixels: number;
  protectedInkPixels: number; maskedPixels: number; reviewReasons: string[];
};
type Quad = { region: number; polygon: readonly PolygonPoint[]; box: Rect; roi: Rect; thickness: number; radius: number; background: number; lightInk: boolean; threshold: number };

/** 양수는 제거 대상이다. 원본과 입력 geometry는 변경하지 않는다. */
export function buildSourceTextMask(
  source: Readonly<{ width: number; height: number; pixels: Uint8ClampedArray }>,
  regions: readonly SourceTextMaskRegion[],
  options: SourceTextMaskOptions = {}
): { pixels: Uint8Array; maskedPixels: number; regions: SourceTextMaskRegionResult[] } {
  if (!options || Object.keys(options).some(key => key !== "outlinePolicy") ||
      !["legacy", "bounded-component-v1"].includes(options.outlinePolicy ?? "legacy")) throw new Error("원문 외곽선 정책이 올바르지 않습니다.");
  const { width, height, pixels } = source, size = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || size > 16_000_000 || pixels.length !== size * 4) throw new Error("원문 제거 원본 픽셀 크기가 올바르지 않습니다.");
  if (!regions.length || new Set(regions.map(r => r.id)).size !== regions.length || regions.some(r => !r.id || !r.polygonsPx.length)) throw new Error("원문 제거 영역 ID가 누락되거나 중복됐습니다.");
  const quads: Quad[] = [];
  const coverage = new Uint8Array(size);
  for (const [region, input] of regions.entries()) for (const polygon of input.polygonsPx) {
    if (polygon.length < 3 || polygon.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error("원문 제거 polygon이 올바르지 않습니다.");
    const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y);
    const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    if (box.width <= 0 || box.height <= 0) throw new Error("원문 제거 polygon 면적이 없습니다.");
    const thickness = Math.min(box.width, box.height), radius = 3;
    const roi = clipRect(box, Math.ceil(thickness * 0.5) + radius + 2, width, height);
    if (!roi.width || !roi.height) throw new Error("원문 제거 polygon이 이미지 밖에 있습니다.");
    const samples: number[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!, steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
      for (let step = 0; step < steps; step++) {
        const x = Math.floor(a.x + (b.x - a.x) * step / steps), y = Math.floor(a.y + (b.y - a.y) * step / steps);
        if (x >= 0 && y >= 0 && x < width && y < height && pixels[(y * width + x) * 4 + 3]! >= 240) samples.push(luma(pixels, (y * width + x) * 4));
      }
    }
    if (!samples.length) throw new Error("원문 제거 영역의 불투명한 배경을 확인하지 못했습니다.");
    samples.sort((a, b) => a - b);
    const background = samples[Math.floor(samples.length / 2)]!, lightInk = background < 128;
    quads.push({ region, polygon, box, roi, thickness, radius, background, lightInk, threshold: lightInk ? Math.max(65, background + 45) : Math.min(190, background - 45) });
    const clipped = clipRect(box, 0, width, height);
    for (let y = clipped.y; y < clipped.y + clipped.height; y++) for (let x = clipped.x; x < clipped.x + clipped.width; x++) if (inside(x + 0.5, y + 0.5, polygon)) coverage[y * width + x] = 255;
  }
  const allowed = dilateBinaryMask(coverage, width, height, 2);
  // 겹친 탐색창은 같은 범위를 쓴다. 작은 창에서 잘린 글자를 구조선으로 오인하지 않는다.
  const parents = quads.map((_, i) => i);
  const find = (index: number): number => { while (parents[index] !== index) index = parents[index]!; return index; };
  for (let i = 0; i < quads.length; i++) for (let j = i + 1; j < quads.length; j++) if (overlaps(quads[i]!.roi, quads[j]!.roi)) parents[find(j)] = find(i);
  const windows = new Map<number, Rect>();
  quads.forEach((q, i) => windows.set(find(i), unite(windows.get(find(i)), q.roi)));
  const mask = new Uint8Array(size), selectedCore = new Uint8Array(size), protectedInk = new Uint8Array(size), continued = new Set<number>();
  const outlined = new Set<number>(), fragmented = new Set<number>(), selectedOutline = new Uint8Array(size), protectedHalo = new Uint8Array(size);
  const paintedBounds: (Rect | undefined)[] = regions.map(() => undefined), maskOwners = new Uint32Array(size), separated = new Set<number>();
  const frames: Rect[] = [], framePixels = new Uint8Array(size);
  for (const [quadIndex, quad] of quads.entries()) {
    const roi = windows.get(find(quadIndex))!, count = roi.width * roi.height;
    const foreground = new Uint8Array(count), ink = new Uint8Array(count), queue = new Int32Array(count), connectedArt = new Uint8Array(count);
    const components: { start: number; box: Rect; text: boolean }[] = [];
    for (let y = 0; y < roi.height; y++) for (let x = 0; x < roi.width; x++) if (isInk(pixels, ((y + roi.y) * width + x + roi.x) * 4, quad)) foreground[y * roi.width + x] = 1;
    for (let start = 0; start < count; start++) {
      if (foreground[start] !== 1) continue;
      let tail = 1, seed = false, covered = 0, chromatic = 0, minX = roi.width, minY = roi.height, maxX = -1, maxY = -1;
      queue[0] = start; foreground[start] = 2;
      for (let head = 0; head < tail; head++) {
        const at = queue[head]!, x = at % roi.width, y = Math.floor(at / roi.width), gx = x + roi.x, gy = y + roi.y;
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        seed ||= inside(gx + 0.5, gy + 0.5, quad.polygon); covered += allowed[gy * width + gx] ? 1 : 0;
        const offset = (gy * width + gx) * 4;
        if (Math.max(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!) - Math.min(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!) > 8) chromatic++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= roi.width || ny >= roi.height) continue;
          const next = ny * roi.width + nx;
          if (foreground[next] === 1) { foreground[next] = 2; queue[tail++] = next; }
        }
      }
      const long = Math.max(maxX - minX + 1, maxY - minY + 1), short = Math.min(maxX - minX + 1, maxY - minY + 1);
      const cut = minX === 0 || minY === 0 || maxX === roi.width - 1 || maxY === roi.height - 1;
      const componentBox = { x: minX + roi.x, y: minY + roi.y, width: maxX - minX + 1, height: maxY - minY + 1 };
      const referenceThickness = Math.max(...quads.filter(q => overlaps(q.box, componentBox)).map(q => q.thickness), 1);
      const straightStructure = long > 2 * referenceThickness && short <= Math.max(2, referenceThickness * 0.08);
      let bridge = false;
      if (!cut && !straightStructure && covered < tail && covered >= tail / 2) {
        const touched = quads.filter(other => {
          if (long > 1.5 * other.thickness) return false;
          for (let i = 0; i < tail; i++) {
            const at = queue[i]!, x = at % roi.width + roi.x + 0.5, y = Math.floor(at / roi.width) + roi.y + 0.5;
            if (nearPolygon(x, y, other.polygon, 2)) return true;
          }
          return false;
        });
        for (let i = 0; i < touched.length && !bridge; i++) for (let j = i + 1; j < touched.length && !bridge; j++) {
          const a = touched[i]!.box, b = touched[j]!.box, vertical = componentBox.height >= componentBox.width;
          const first = (vertical ? a.y : a.x) <= (vertical ? b.y : b.x) ? a : b, second = first === a ? b : a;
          const end = vertical ? first.y + first.height : first.x + first.width, beginning = vertical ? second.y : second.x;
          if (beginning - end <= 4) continue;
          for (let k = 0; k < tail; k++) {
            const at = queue[k]!, axis = vertical ? Math.floor(at / roi.width) + roi.y + 0.5 : at % roi.width + roi.x + 0.5;
            if (axis > end + 2 && axis < beginning - 2) { bridge = true; break; }
          }
        }
      }
      const text = !cut && !straightStructure && (covered === tail || bridge);
      components.push({ start, box: componentBox, text });
      if (seed && text) {
        if (bridge) continued.add(quad.region);
        for (let i = 0; i < tail; i++) ink[queue[i]!] = 255;
      } else if (!text) {
        if (cut && chromatic >= 16 && chromatic >= tail * 0.1) for (let i = 0; i < tail; i++) connectedArt[queue[i]!] = 255;
        // 다른 극성의 이웃 영역 배경을 전역 보호로 등록하지 않는다.
        for (let i = 0; i < tail; i++) {
          const at = queue[i]!, x = at % roi.width + roi.x, y = Math.floor(at / roi.width) + roi.y;
          if (nearPolygon(x + 0.5, y + 0.5, quad.polygon, quad.radius + 2)) protectedInk[y * width + x] = 255;
        }
      }
    }
    // 큰 외곽 성분이 여러 글자 성분을 둘러싸면, 검출 상자 안에 있어도 표지 프레임으로 보존한다.
    for (const component of components) {
      if (component.box.x <= roi.x || component.box.y <= roi.y || component.box.x + component.box.width >= roi.x + roi.width || component.box.y + component.box.height >= roi.y + roi.height) continue;
      const inner = components.filter(other => other !== component && other.text && other.box.x > component.box.x && other.box.y > component.box.y &&
        other.box.x + other.box.width < component.box.x + component.box.width && other.box.y + other.box.height < component.box.y + component.box.height);
      if (inner.length < 2 || (component.text && Math.max(component.box.width, component.box.height) <= 3 * Math.max(...inner.map(c => Math.max(c.box.width, c.box.height))))) continue;
      const visited = new Uint8Array(count); let tail = 1; queue[0] = component.start; visited[component.start] = 1;
      for (let head = 0; head < tail; head++) {
        const at = queue[head]!, x = at % roi.width, y = Math.floor(at / roi.width);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= roi.width || ny >= roi.height) continue;
          const next = ny * roi.width + nx;
          if (foreground[next] === 2 && !visited[next]) { visited[next] = 1; queue[tail++] = next; }
        }
      }
      const left = component.box.x - roi.x - 1, top = component.box.y - roi.y - 1;
      const right = left + component.box.width + 1, bottom = top + component.box.height + 1;
      const outside = new Uint8Array(count); let outsideTail = 1; queue[0] = top * roi.width + left; outside[queue[0]!] = 1;
      for (let head = 0; head < outsideTail; head++) {
        const at = queue[head]!, x = at % roi.width, y = Math.floor(at / roi.width);
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + dx!, ny = y + dy!;
          if (nx < left || ny < top || nx > right || ny > bottom) continue;
          const next = ny * roi.width + nx;
          if (!outside[next] && !visited[next]) { outside[next] = 1; queue[outsideTail++] = next; }
        }
      }
      if (inner.filter(c => !outside[c.start]).length < 2) continue;
      frames.push(component.box);
      for (let y = top + 1; y < bottom; y++) for (let x = left + 1; x < right; x++) if (visited[y * roi.width + x]) {
        const at = (y + roi.y) * width + x + roi.x;
        framePixels[at] = 255;
        if (component.text) { ink[y * roi.width + x] = 0; protectedInk[at] = 255; }
      }
    }
    if (!quad.lightInk) {
      const refined = extractBackgroundSupportedGlyphs(source, roi, quad.polygon, quad.thickness, quad.background, connectedArt, framePixels);
      for (let at = 0; at < refined.length; at++) if (refined[at]) {
        const pageAt = (Math.floor(at / roi.width) + roi.y) * width + at % roi.width + roi.x;
        if (protectedInk[pageAt]) separated.add(quad.region);
        protectedInk[pageAt] = 0; ink[at] = 255;
      }
    }
    for (let y = 0; y < roi.height; y++) for (let x = 0; x < roi.width; x++) if (ink[y * roi.width + x]) selectedCore[(y + roi.y) * width + x + roi.x] = 255;
    // 회색·그림 배경에서 글자를 둘러싼 흰/검은 outline을 남기면 원문 모양이 남는다.
    const outlineCore = ink.slice();
    const nearInk = dilateBinaryMask(outlineCore, roi.width, roi.height, 3);
    // Opt-in only: admit an entire bounded bright component around source ink.
    // The actual mask still requires closure/contour support, frame rejection and
    // the existing structure guards. This does not enlarge every removal pixel.
    const outlineLimit = Math.max(3, Math.min(12, Math.ceil(quad.thickness * (options.outlinePolicy === "bounded-component-v1" ? 0.5 : 0.1))));
    const envelope = dilateBinaryMask(outlineCore, roi.width, roi.height, outlineLimit), halo = new Uint8Array(count);
    const glyphComponents = components.filter(c => outlineCore[c.start]);
    for (let y = 0; y < roi.height; y++) for (let x = 0; x < roi.width; x++) {
      const at = y * roi.width + x, sourceAt = ((y + roi.y) * width + x + roi.x) * 4;
      if (pixels[sourceAt + 3]! < 240) continue;
      const value = luma(pixels, sourceAt);
      if (quad.lightInk ? value <= 10 && value <= quad.background - 16 : value >= 245 && value >= quad.background + 16) halo[at] = 1;
    }
    const contourSupports = halo.some(value => value) ? supportedGlyphContours(outlineCore, glyphComponents, roi, pixels, width, quad, outlineLimit) : [];
    for (let start = 0; start < count; start++) {
      if (halo[start] !== 1 || !nearInk[start]) continue;
      let tail = 1, minX = roi.width, minY = roi.height, maxX = -1, maxY = -1, complete = true;
      queue[0] = start; halo[start] = 2;
      for (let head = 0; head < tail; head++) {
        const at = queue[head]!, x = at % roi.width, y = Math.floor(at / roi.width);
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); complete &&= Boolean(envelope[at]);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= roi.width || ny >= roi.height) continue;
          const next = ny * roi.width + nx;
          if (halo[next] === 1) { halo[next] = 2; queue[tail++] = next; }
        }
      }
      const barrier = new Uint8Array(count);
      for (let i = 0; i < tail; i++) barrier[queue[i]!] = 1;
      const box = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
      let insideGlyph = false;
      for (const glyph of glyphComponents) {
        const coreBox = { ...glyph.box, x: glyph.box.x - roi.x, y: glyph.box.y - roi.y };
        if (minX < coreBox.x || maxX >= coreBox.x + coreBox.width || minY < coreBox.y || maxY >= coreBox.y + coreBox.height || Math.max(coreBox.width, coreBox.height) > 1.5 * quad.thickness) continue;
        const coreOutside = exteriorOf(outlineCore, roi.width, roi.height, coreBox, queue);
        let enclosed = true;
        for (let y = minY; y <= maxY && enclosed; y++) for (let x = minX; x <= maxX; x++) if (barrier[y * roi.width + x] && coreOutside[y * roi.width + x]) { enclosed = false; break; }
        if (enclosed) { insideGlyph = true; break; }
      }
      let wrapsText = false;
      const contourSupported = complete && contourSupports.some(support => {
        const b = support.box;
        if (minX < b.x || minY < b.y || maxX >= b.x + b.width || maxY >= b.y + b.height) return false;
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (barrier[y * roi.width + x] && !support.pixels[(y - b.y) * b.width + x - b.x]) return false;
        return true;
      });
      if ((complete || insideGlyph) && minX > 0 && minY > 0 && maxX < roi.width - 1 && maxY < roi.height - 1) {
        const outside = exteriorOf(barrier, roi.width, roi.height, box, queue);
        const inner = glyphComponents.filter(c => {
          const x = c.start % roi.width, y = Math.floor(c.start / roi.width);
          return x >= minX && x <= maxX && y >= minY && y <= maxY && !outside[c.start] && !barrier[c.start];
        });
        const largeFrame = inner.length >= 2 && Math.max(box.width, box.height) > 3 * Math.max(...inner.map(c => Math.max(c.box.width, c.box.height)));
        wrapsText = !largeFrame && (inner.length > 0 || insideGlyph || contourSupported);
        if (wrapsText && contourSupported && !inner.length && !insideGlyph) fragmented.add(quad.region);
      }
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const at = y * roi.width + x, pageAt = (y + roi.y) * width + x + roi.x;
        if (!barrier[at]) continue;
        if (wrapsText) { ink[at] = 255; selectedOutline[pageAt] = 255; }
        else if (envelope[at]) protectedHalo[pageAt] = 255;
      }
      if (wrapsText) outlined.add(quad.region);
    }
    const expanded = dilateBinaryMask(ink, roi.width, roi.height, quad.radius);
    let minX = roi.width, minY = roi.height, maxX = -1, maxY = -1;
    for (let y = 0; y < roi.height; y++) for (let x = 0; x < roi.width; x++) if (expanded[y * roi.width + x]) {
      mask[(y + roi.y) * width + x + roi.x] = 255;
      const pageAt = (y + roi.y) * width + x + roi.x, owner = quad.region + 1;
      maskOwners[pageAt] = !maskOwners[pageAt] || maskOwners[pageAt] === owner ? owner : 0xffffffff;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    if (maxX >= 0) paintedBounds[quad.region] = unite(paintedBounds[quad.region], { x: minX + roi.x, y: minY + roi.y, width: maxX - minX + 1, height: maxY - minY + 1 });
  }
  let guard = dilateBinaryMask(protectedInk, width, height, 2);
  const haloGuard = dilateBinaryMask(protectedHalo, width, height, 2);
  let maskedPixels = 0;
  for (let i = 0; i < size; i++) {
    // 실제 구조선은 보존한다. 구조선의 여백만 다른 성분의 확정 글자 core를 가릴 수는 없다.
    if (protectedInk[i]) mask[i] = 0;
    else if (selectedCore[i] || selectedOutline[i]) mask[i] = 255;
    else if (guard[i] || haloGuard[i]) mask[i] = 0;
    if (mask[i]) maskedPixels++;
  }
  const linked = buildLinkedSourceOutlineAdditions(source, mask, regions, frames, framePixels);
  if (linked.regionIds.length) {
    for (let i = 0; i < size; i++) {
      if (linked.pixels[i]) protectedInk[i] = 0;
    }
    guard = dilateBinaryMask(protectedInk, width, height, 2);
    for (let i = 0; i < size; i++) {
      if (framePixels[i] || !linked.pixels[i]) continue;
      if (!mask[i]) maskedPixels++;
      maskOwners[i] = !mask[i] || !maskOwners[i] || maskOwners[i] === linked.owners[i] ? linked.owners[i]! : 0xffffffff;
      mask[i] = 255;
    }
    for (const region of linked.regionBounds) {
      const index = regions.findIndex(r => r.id === region.id);
      paintedBounds[index] = unite(paintedBounds[index], region.bounds);
    }
  }
  const completed = completeSourceTextMask(source, mask, maskOwners, regions, framePixels);
  for (let i = 0; i < size; i++) if (completed.pixels[i]) mask[i] = 255;
  maskedPixels += completed.maskedPixels;
  const result = regions.map((region, index): SourceTextMaskRegionResult => {
    const ownQuads = quads.filter(q => q.region === index), bounds = paintedBounds[index];
    const sourceBounds = ownQuads.reduce((rect, q) => unite(rect, clipRect(q.box, 0, width, height)), undefined as Rect | undefined)!;
    let selectedInkPixels = 0, protectedInkPixels = 0, regionMasked = 0;
    for (let y = sourceBounds.y; y < sourceBounds.y + sourceBounds.height; y++) for (let x = sourceBounds.x; x < sourceBounds.x + sourceBounds.width; x++) {
      const at = y * width + x;
      if (!ownQuads.some(q => inside(x + 0.5, y + 0.5, q.polygon) && isInk(pixels, at * 4, q))) continue;
      if (mask[at]) selectedInkPixels++; else if (guard[at]) protectedInkPixels++;
    }
    if (!selectedInkPixels || !bounds) throw new Error(`영역 ${region.id}: 그림을 보존하며 제거할 원문 획을 확인하지 못했습니다.`);
    for (let y = bounds.y; y < bounds.y + bounds.height; y++) for (let x = bounds.x; x < bounds.x + bounds.width; x++) if (mask[y * width + x]) regionMasked++;
    const reviewReasons: string[] = [];
    if (protectedInkPixels) reviewReasons.push("검출 범위와 겹친 구조선·모호한 획을 보존했습니다. 원문 잔여 검토가 필요합니다.");
    if (continued.has(index)) reviewReasons.push("인접 검출 사이에 이어지는 작은 획을 함께 제거했습니다. 원문 잔여 검토가 필요합니다.");
    if (outlined.has(index)) reviewReasons.push("문자를 둘러싼 외곽선도 함께 제거했습니다. 배경 복원을 확인해 주세요.");
    if (outlined.has(index) && options.outlinePolicy === "bounded-component-v1") reviewReasons.push("선택적 닫힌 외곽선 후보입니다. 실제 잔상·작화 품질은 별도 검토가 필요합니다.");
    if (fragmented.has(index)) reviewReasons.push("글자 획의 네 방향에서 이어진 흐린 윤곽 조각을 함께 제거했습니다. 그림 보존과 원문 잔여 검토가 필요합니다.");
    if (linked.regionIds.includes(region.id)) reviewReasons.push("같은 원문의 여러 글자를 잇는 연결 윤곽을 함께 제거했습니다. 그림 보존과 원문 잔여 검토가 필요합니다.");
    if (separated.has(index)) reviewReasons.push("색 있는 그림과 연결된 원문 획을 양쪽 배경 대비로 분리했습니다. 그림 경계를 확인해 주세요.");
    if (completed.regionIds.includes(region.id)) reviewReasons.push("원문 획 안에 갇혀 남은 중성 가장자리를 함께 제거했습니다. 복원과 그림 보존을 확인해 주세요.");
    return { id: region.id, radius: Math.max(...ownQuads.map(q => q.radius)), bboxPx: bounds, selectedInkPixels, protectedInkPixels, maskedPixels: regionMasked, reviewReasons };
  });
  return { pixels: mask, maskedPixels, regions: result };
}

function luma(pixels: Uint8ClampedArray, at: number): number { return Math.round(0.299 * pixels[at]! + 0.587 * pixels[at + 1]! + 0.114 * pixels[at + 2]!); }
function isInk(pixels: Uint8ClampedArray, at: number, quad: Pick<Quad, "lightInk" | "threshold">): boolean { return pixels[at + 3]! >= 240 && (quad.lightInk ? luma(pixels, at) >= quad.threshold : luma(pixels, at) <= quad.threshold); }
function inside(x: number, y: number, polygon: readonly PolygonPoint[]): boolean {
  let yes = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i]!, b = polygon[j]!; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) yes = !yes; }
  return yes;
}
function nearPolygon(x: number, y: number, polygon: readonly PolygonPoint[], radius: number): boolean {
  if (inside(x, y, polygon)) return true;
  return polygon.some((a, i) => { const b = polygon[(i + 1) % polygon.length]!, dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length)) : 0;
    return (x - a.x - dx * t) ** 2 + (y - a.y - dy * t) ** 2 <= radius * radius; });
}
/** 같은 획의 경계에서 관찰한 AA만 잇는다. 배경 간격 너머의 밝은 그림선은 포함하지 않는다. */
function supportedGlyphContours(core: Uint8Array, glyphs: readonly { start: number; box: Rect }[], roi: Rect, source: Uint8ClampedArray, pageWidth: number, quad: Quad, margin: number): { box: Rect; pixels: Uint8Array }[] {
  const supports: { box: Rect; pixels: Uint8Array }[] = [];
  for (const glyph of glyphs) {
    if (Math.max(glyph.box.width, glyph.box.height) > 1.5 * quad.thickness) continue;
    const box = clipRect({ ...glyph.box, x: glyph.box.x - roi.x, y: glyph.box.y - roi.y }, margin, roi.width, roi.height);
    const count = box.width * box.height, body = new Uint8Array(count), queue = new Int32Array(count);
    const local = (x: number, y: number) => (y - box.y) * box.width + x - box.x;
    const startX = glyph.start % roi.width, startY = Math.floor(glyph.start / roi.width);
    let tail = 1; queue[0] = local(startX, startY); body[queue[0]!] = 255;
    for (let head = 0; head < tail; head++) {
      const at = queue[head]!, x = at % box.width + box.x, y = Math.floor(at / box.width) + box.y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < box.x || ny < box.y || nx >= box.x + box.width || ny >= box.y + box.height) continue;
        const next = local(nx, ny); if (core[ny * roi.width + nx] && !body[next]) { body[next] = 255; queue[tail++] = next; }
      }
    }
    const boundary = [0, 0, 0, 0], hits = [0, 0, 0, 0], seeds = new Set<number>();
    const weak = (x: number, y: number): boolean => {
      const at = ((y + roi.y) * pageWidth + x + roi.x) * 4, value = luma(source, at);
      return source[at + 3]! >= 240 && (quad.lightInk ? value <= 20 && value <= quad.background - 8 : value >= 235 && value >= quad.background + 8);
    };
    for (let i = 0; i < tail; i++) {
      const at = queue[i]!, x = at % box.width + box.x, y = Math.floor(at / box.width) + box.y;
      for (const [direction, [dx, dy]] of ([[-1, 0], [1, 0], [0, -1], [0, 1]] as const).entries()) {
        if (x + dx < 0 || y + dy < 0 || x + dx >= roi.width || y + dy >= roi.height) continue;
        if (core[(y + dy) * roi.width + x + dx]) continue;
        boundary[direction]!++;
        let sourcePath = true;
        for (let step = 1; step <= 3; step++) {
          const nx = x + dx * step, ny = y + dy * step;
          if (nx < box.x || ny < box.y || nx >= box.x + box.width || ny >= box.y + box.height || isInk(source, ((ny + roi.y) * pageWidth + nx + roi.x) * 4, quad)) break;
          if (weak(nx, ny)) { hits[direction]!++; if (sourcePath) seeds.add(local(nx, ny)); break; }
          // 배경색으로 돌아간 뒤의 밝은 선은 문자 가장자리의 연속 근거가 아니다.
          if (Math.abs(luma(source, ((ny + roi.y) * pageWidth + nx + roi.x) * 4) - quad.background) <= 4) sourcePath = false;
        }
      }
    }
    if (hits.reduce((a, b) => a + b, 0) * 10 < boundary.reduce((a, b) => a + b, 0) * 9 || hits.some((hit, i) => !boundary[i] || hit * 5 < boundary[i]! * 3)) continue;
    const band = dilateBinaryMask(body, box.width, box.height, margin), support = new Uint8Array(count);
    tail = 0; for (const seed of seeds) { support[seed] = 255; queue[tail++] = seed; }
    for (let head = 0; head < tail; head++) {
      const at = queue[head]!, x = at % box.width, y = Math.floor(at / box.width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= box.width || ny >= box.height) continue;
        const next = ny * box.width + nx;
        if (!support[next] && band[next] && weak(nx + box.x, ny + box.y)) { support[next] = 255; queue[tail++] = next; }
      }
    }
    supports.push({ box, pixels: support });
  }
  return supports;
}
/** 원본 성분의 실제 닫힘을 확인한다. 거리 창에서 잘린 성분을 닫힌 outline으로 보지 않는다. */
function exteriorOf(barrier: Uint8Array, width: number, height: number, box: Rect, queue: Int32Array): Uint8Array {
  const left = Math.max(0, box.x - 1), top = Math.max(0, box.y - 1);
  const right = Math.min(width - 1, box.x + box.width), bottom = Math.min(height - 1, box.y + box.height);
  const outside = new Uint8Array(barrier.length); let tail = 0;
  const seed = (x: number, y: number) => { const at = y * width + x; if (!barrier[at] && !outside[at]) { outside[at] = 1; queue[tail++] = at; } };
  for (let x = left; x <= right; x++) { seed(x, top); seed(x, bottom); }
  for (let y = top; y <= bottom; y++) { seed(left, y); seed(right, y); }
  for (let head = 0; head < tail; head++) {
    const at = queue[head]!, x = at % width, y = Math.floor(at / width);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx!, ny = y + dy!;
      if (nx >= left && ny >= top && nx <= right && ny <= bottom) seed(nx, ny);
    }
  }
  return outside;
}
function clipRect(box: Rect, margin: number, width: number, height: number): Rect {
  const x = Math.max(0, Math.floor(box.x - margin)), y = Math.max(0, Math.floor(box.y - margin));
  return { x, y, width: Math.max(0, Math.min(width, Math.ceil(box.x + box.width + margin)) - x), height: Math.max(0, Math.min(height, Math.ceil(box.y + box.height + margin)) - y) };
}
function unite(a: Rect | undefined, b: Rect): Rect { if (!a) return { ...b }; const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }; }
function overlaps(a: Rect, b: Rect): boolean { return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height; }
