'use strict';
const { validQuad } = require('./source-line-roi.cjs');

function sourceLines(region, width, height) {
  const provenance = region.productionOcrProvenance;
  const quads = provenance?.sourceQuadsPx, ids = provenance?.sourceDetectionIds;
  if (!Array.isArray(quads) || quads.length < 2) return [];
  const { imageWidth, imageHeight } = provenance.cropTransform ?? {};
  if (![imageWidth, imageHeight].every(v => Number.isSafeInteger(v) && v > 0) ||
      !Array.isArray(ids) || ids.length !== quads.length || new Set(ids).size !== ids.length ||
      !ids.every(id => typeof id === 'string' && id.length) || !quads.every(q => validQuad(q, imageWidth, imageHeight))) {
    throw Object.assign(Error('복원 검수용 원문 글줄 좌표와 식별자를 확인해 주세요.'), { code: 'TEXT_MASK_INVALID' });
  }
  // Match the mask renderer's source-to-page coordinate transform.
  const box = region.bbox;
  return quads.map((quad, i) => {
    const points = quad.map(p => ({ x: p.x * width / imageWidth, y: p.y * height / imageHeight }));
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    return { regionId: region.id, sourceDetectionId: ids[i], points,
      left: Math.max(0, Math.floor(box.x * width), Math.floor(Math.min(...xs))),
      right: Math.min(width, Math.ceil((box.x + box.width) * width), Math.ceil(Math.max(...xs))),
      top: Math.max(0, Math.floor(box.y * height), Math.floor(Math.min(...ys))),
      bottom: Math.min(height, Math.ceil((box.y + box.height) * height), Math.ceil(Math.max(...ys))),
      changed: false, maskedDarkPixels: 0, darkRows: 0, sampledPixels: 0, lightPixels: 0 };
  });
}

// Convex OCR polygons can be tilted. Count only pixels whose centers lie
// between their two intersections with this scanline.
function scanline(line, y) {
  let left = Infinity, right = -Infinity;
  for (let i = 0; i < line.points.length; i++) {
    const a = line.points[i], b = line.points[(i + 1) % line.points.length];
    if ((a.y > y) === (b.y > y)) continue;
    const x = a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y);
    left = Math.min(left, x); right = Math.max(right, x);
  }
  return [Math.max(line.left, Math.ceil(left - .5)), Math.min(line.right, Math.floor(right - .5) + 1)];
}

function retainedSourceLines({ source, result, mask, width, height, regions }) {
  const lines = regions.flatMap(region => sourceLines(region, width, height));
  if (!lines.length) return [];
  const dark = new Uint32Array(width + 1), changed = new Uint32Array(width + 1), light = new Uint32Array(width + 1);
  for (let y = 0; y < height; y++) {
    const active = lines.filter(line => !line.changed && line.top <= y && y < line.bottom && line.right > line.left);
    if (!active.length) continue;
    const start = active.reduce((x, line) => Math.min(x, line.left), width);
    const end = active.reduce((x, line) => Math.max(x, line.right), 0);
    dark[start] = changed[start] = light[start] = 0;
    for (let x = start; x < end; x++) {
      const p = (y * width + x) * 4;
      const opaque = source[p+3] === 255;
      const ink = opaque && mask[p+3] === 0 && Math.max(source[p], source[p+1], source[p+2]) < 96;
      const removed = ink && (result[p+3] !== source[p+3] || Math.max(Math.abs(source[p]-result[p]),
        Math.abs(source[p+1]-result[p+1]), Math.abs(source[p+2]-result[p+2])) > 3);
      dark[x+1] = dark[x] + Number(ink);
      changed[x+1] = changed[x] + Number(removed);
      light[x+1] = light[x] + Number(opaque && Math.min(source[p], source[p+1], source[p+2]) >= 160);
    }
    for (const line of active) {
      const [a, b] = scanline(line, y + .5);
      if (a >= b) continue;
      if (changed[b] > changed[a]) { line.changed = true; continue; }
      line.maskedDarkPixels += dark[b] - dark[a];
      line.darkRows += Number(dark[b] > dark[a]);
      line.sampledPixels += b-a;
      line.lightPixels += light[b] - light[a];
    }
  }
  // An isolated dark dot or the dark field behind white lettering is
  // insufficient evidence of a retained printed line.
  return lines.filter(line => !line.changed && line.maskedDarkPixels >= 16 && line.darkRows >= 3 &&
    line.lightPixels * 2 > line.sampledPixels).map(({ regionId, sourceDetectionId, maskedDarkPixels, darkRows, sampledPixels, lightPixels }) =>
      ({ regionId, sourceDetectionId, maskedDarkPixels, darkRows, sampledPixels, lightPixels }));
}

module.exports = { retainedSourceLines };
