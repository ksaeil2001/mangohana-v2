/** Canvas evidence, not a cmap or semantic character oracle. The actual selected
 * fallback chain is probed at the actual selected size; missing/tofu/empty ink blocks PNG.
 * Which fallback face shaped a cluster cannot be inferred from FontFaceSet.check. */
export function inspectCanvasGlyphCoverage(text: string, fontFamily: string, fontSizePx: number) {
  const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("글리프 픽셀을 검사할 Canvas가 없습니다.");
  if (!Number.isFinite(fontSizePx) || fontSizePx < 1) throw new Error("실제 글리프 크기가 유효하지 않습니다.");
  const font = `bold ${fontSizePx}px ${fontFamily}`;
  const probe = (cluster: string) => {
    context.font = font; context.textBaseline = "alphabetic"; context.textAlign = "left";
    const m = context.measureText(cluster);
    const left = Math.ceil(Math.max(0, m.actualBoundingBoxLeft)), ascent = Math.ceil(Math.max(0, m.actualBoundingBoxAscent));
    canvas.width = Math.max(8, left + Math.ceil(Math.max(m.width, m.actualBoundingBoxRight)) + 8);
    canvas.height = Math.max(8, ascent + Math.ceil(Math.max(0, m.actualBoundingBoxDescent)) + 8);
    if (canvas.width * canvas.height > 1_000_000) throw new Error("글리프 측정 범위를 초과했습니다.");
    context.font = font; context.textBaseline = "alphabetic"; context.textAlign = "left"; context.fillStyle = "#000";
    context.fillText(cluster, left + 4, ascent + 4);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1, ink = 0;
    for (let at = 0; at < pixels.length / 4; at++) if (pixels[at * 4 + 3]) {
      ink++; const x = at % canvas.width, y = Math.floor(at / canvas.width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const alpha: number[] = [];
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) alpha.push(pixels[(y * canvas.width + x) * 4 + 3]!);
    return { ink, signature: `${maxX - minX + 1}:${maxY - minY + 1}:${alpha.join(",")}` };
  };
  const sentinels = ["\uffff", "\u{10ffff}", "\ufffd"].map(probe);
  const graphemes = [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(text)].map(s => s.segment);
  const unique = [...new Set(graphemes.filter(s => !/^\s+$/.test(s)))];
  const missing = unique.filter(s => { const actual = probe(s); return !actual.ink || sentinels.some(m => m.signature === actual.signature); });
  return { measured: true as const, basis: "ACTUAL_CANVAS_GRAPHEME_NONEMPTY_AND_NONTOFU_PROBE" as const,
    font, fontSizePx, testedGraphemes: unique.length, missingGraphemes: missing,
    missingGlyphOccurrences: graphemes.filter(s => missing.includes(s)).length,
    fallbackFaceIdentity: null, fallbackFailureCount: missing.length ? graphemes.filter(s => missing.includes(s)).length : 0,
    primaryFontCmapCoverage: null, humanGlyphCorrectness: null };
}
