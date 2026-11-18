import type { ProductionOcrGroupingContext } from "./productionRegionGrouping.js";

/** 한 페이지의 실제 픽셀만 사용한다. callback·memo는 해당 execute 밖으로 공유하지 않는다. */
export function createProductionOcrGroupingContext(image: Readonly<{
  width: number; height: number; pixels: Uint8Array;
}>): ProductionOcrGroupingContext {
  const { width, height, pixels } = image;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      !Number.isSafeInteger(width * height * 4) || pixels.byteLength !== width * height * 4) {
    throw new Error("Invalid OCR grouping source bitmap");
  }
  const memo = new Map<string, boolean>();
  return {
    isSeparated(left, right, orientation) {
      if ([left, right].some(d => d.imageWidth !== width || d.imageHeight !== height)) {
        throw new Error("OCR grouping bitmap dimensions do not match detections");
      }
      const a = left.sourceBboxPx, b = right.sourceBboxPx, vertical = orientation === "vertical";
      const aStart = vertical ? a.x : a.y, bStart = vertical ? b.x : b.y;
      const aSize = vertical ? a.width : a.height, bSize = vertical ? b.width : b.height;
      const firstEnd = aStart <= bStart ? aStart + aSize : bStart + bSize;
      const secondStart = Math.max(aStart, bStart), thickness = Math.min(aSize, bSize);
      const gapStart = Math.max(0, Math.ceil(firstEnd)), gapEnd = Math.min(vertical ? width : height, Math.floor(secondStart));
      const longLimit = vertical ? height : width;
      const axisStart = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
      const axisEnd = vertical ? Math.max(a.y + a.height, b.y + b.height) : Math.max(a.x + a.width, b.x + b.width);
      const longStart = Math.max(0, Math.floor(axisStart)), longEnd = Math.min(longLimit, Math.ceil(axisEnd));
      const innerLength = Math.min(longLimit, Math.floor(axisEnd)) - Math.max(0, Math.ceil(axisStart));
      // 짧은 한 글자의 획이나 검출 틀 안의 선을 분리 근거로 삼지 않는다.
      const inset = Math.max(1, Math.ceil(thickness * 0.05));
      // 글줄 끝에서 같이 끝나는 획 대신 글줄 바깥까지 이어지는 선만 확정한다.
      if (gapEnd - gapStart <= 2 * inset || innerLength < 2 * thickness || longStart < inset || longEnd + inset > longLimit) return false;
      const lightFlank = Math.max(1, Math.ceil(thickness * 0.02));
      const key = `${orientation}:${gapStart},${gapEnd},${longStart},${longEnd},${inset},${lightFlank}`;
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      const separated = hasContinuousBoundary(pixels, width, vertical, gapStart, gapEnd, longStart - inset, longEnd + inset, inset, lightFlank);
      memo.set(key, separated);
      return separated;
    }
  };
}

/** 글줄 사이의 틈에서만, 양옆이 밝은 연속 경계가 두 글줄 길이 전체를 잇는지 확인한다. */
function hasContinuousBoundary(
  pixels: Uint8Array, imageWidth: number, vertical: boolean,
  gapStart: number, gapEnd: number, longStart: number, longEnd: number, inset: number, lightFlank: number
): boolean {
  const span = gapEnd - gapStart;
  let previous = new Uint8Array(span), current = new Uint8Array(span);
  const leftLight = new Uint32Array(span), rightLight = new Uint32Array(span), dark = new Uint8Array(span);
  for (let along = longStart; along < longEnd; along++) {
    let lights = 0;
    for (let offset = 0; offset < span; offset++) {
      const across = gapStart + offset;
      const at = (vertical ? along * imageWidth + across : across * imageWidth + along) * 4;
      const alpha = pixels[at + 3]!;
      leftLight[offset] = lights;
      if (alpha >= 240 && Math.min(pixels[at]!, pixels[at + 1]!, pixels[at + 2]!) >= 200) lights++;
      rightLight[offset] = lights;
      dark[offset] = alpha >= 240 && Math.max(pixels[at]!, pixels[at + 1]!, pixels[at + 2]!) <= 96 ? 1 : 0;
    }
    let reachable = false;
    current.fill(0);
    for (let offset = inset; offset < span - inset; offset++) {
      if (!dark[offset] || leftLight[offset]! < lightFlank || lights - rightLight[offset]! < lightFlank) continue;
      if (along === longStart || previous[offset] || previous[offset - 1] || previous[offset + 1]) {
        current[offset] = 1; reachable = true;
      }
    }
    if (!reachable) return false;
    [previous, current] = [current, previous];
  }
  return true;
}
