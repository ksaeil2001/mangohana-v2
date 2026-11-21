import type { DialogueLine, DialogueTypesetting } from "../../src/shared/projectTypes.js";
import type { ExtractedSpeechBubble, NormalizedBbox, PolygonPoint, SpeechBubbleExtractionResult } from "../../src/shared/speechBubbleExtraction.js";
import type { TranslationQaReport } from "../../src/shared/translation/translationQa.js";
import type {} from "../../src/renderer/electronApi.js";
import { buildTranslationContextPayload, computeTranslationPayloadFingerprint } from "../../src/shared/translation/translationPayload.js";
import { buildSourceTextMask, type SourceTextMaskRegionResult } from "../../src/shared/sourceTextMask.js";
import { PRODUCTION_TYPESET_FONT_CSS_FAMILY } from "../../src/shared/productionTypesetFontResource.js";
import { autoFitFontSizeForBubbleShape, getRecommendedFontFallbackChain, layoutTextForBubbleShape, type TypesettingLayoutResult } from "../../src/shared/typesettingGeometry.js";
import { DEFAULT_SHAPE_PADDING } from "../../src/shared/typesettingShape.js";
import { renderTypesettingToCanvas } from "../../src/renderer/imageBurnInRenderer.js";
import { ensureProductionTypesetFontLoaded } from "../../src/renderer/productionTypesetFont.js";
import { findInteriorRectangle, isInsetInteriorRectangle, measureCandidateFit, containsKoreanAddress, honorificWrapAlternatives, inspectCandidateInk, inspectTypesettingText, type CandidateInterior } from "../../src/renderer/candidateTypesettingFit.js";
import { staggeredAddressBands } from "../../src/renderer/candidateAddressBand.js";
import { inspectCanvasGlyphCoverage } from "../../src/renderer/typesettingGlyphRaster.js";
import { expandVerifiedInkBox, findSourceInkBoxes } from "../../src/renderer/candidateSourceInk.js";
import { isSupportedCandidateExpansion } from "../../src/shared/candidateExpansion.js";
import { createBackgroundScene, normalizeManualEntries, inside, type ManualEntry, type Result as BackgroundResult } from "../../../../quality/background-layout.cjs";
import {evaluateKoreanTypesetting,isGeneralKorean,scoreKoreanReadability,type StandardResult} from "../../../../quality/korean-typesetting-standard.cjs";

export type PreviewTranslationRecord = {
  id: string;
  requestId: string;
  engine: "local_ai";
  usedExactTm: false;
  requestedContextFingerprint: string;
  returnedContextFingerprint: string;
  qaReport: TranslationQaReport | null;
  durationMs: number;
};

export type PreviewMaskRegion = SourceTextMaskRegionResult & {
  geometrySource: "sourceQuadsPx" | "polygon";
  polygonsPx: PolygonPoint[][];
};

export type PreviewLayoutReport = {
  standard?:StandardResult;
  order?:number;
  speaker?:string;
  shape?:string;
  writingMode?:string;
  lineHeight?:number;
  id: string;
  sourceBbox: NormalizedBbox;
  bbox: NormalizedBbox;
  bboxInferred: boolean;
  fontFamily: string;
  fontSizeRatio: number;
  fontSizePx: number;
  productionFontLoaded: boolean;
  glyphFontLoaded: boolean;
  qaStatus: "pending";
  reviewReasons: string[];
  measuredFit?: { completeText: boolean; fitsBox: boolean; resized: boolean; linesSeparated: boolean; selection: ReturnType<typeof measureCandidateFit>["selection"];inkBounds?:ReturnType<typeof measureCandidateFit>["inkBounds"] };
  raster?: ReturnType<typeof inspectCandidateInk> & { clippedPixels: number; otherRegionCollisionPixels: number; overlappingInkPixels: number };
  contractVersion?: "stage12-layout-v1";
  fitStatus?: "FIT_VERIFIED" | "FIT_WARNING" | "MANUAL_LAYOUT_REQUIRED" | "FONT_OR_GLYPH_ERROR" | "RENDER_NOT_MEASURED";
  textEvidence?: ReturnType<typeof inspectTypesettingText>;
  glyphEvidence?: ReturnType<typeof inspectCanvasGlyphCoverage>;
  actualLayout?: TypesettingLayoutResult;
  paint?: { font: string; strokeWidth: number; align: string; writingMode: string; rotationDegrees: number; color?: string; strokeColor?: string };
  safeAreaEvidence?: { basis: "CLOSED_WHITE_COMPONENT_INSET_RECTANGLE" | "UNVERIFIED_ROI_OR_MANUAL_GEOMETRY" | "UNIFORM_BACKGROUND_INSET_RECTANGLE" | "USER_REVIEWED_PROTECTED_ROI_RECTANGLE"; humanVerified: false; tailAndArtworkSemanticVerified: null; background?: BackgroundResult['evidence'] };
  manualLayoutApprovalSha256?: string;
};

/** The automatic candidate may add draft translation metadata, never replace
 * prepared page/source/order/geometry or enter a user-owned editing session. */
export function validateCandidateSourceSnapshot(lines: readonly DialogueLine[], snapshot: readonly DialogueLine[]): void {
  validateLineIds(lines);
  if (lines.length !== snapshot.length) throw new Error("준비된 식자 영역 수가 다릅니다.");
  for (const [i, line] of lines.entries()) {
    const source = snapshot[i]!;
    if (line.id !== source.id || line.pageNumber !== source.pageNumber || line.sourceText !== source.sourceText || line.order !== source.order ||
        JSON.stringify(line.typesetting) !== JSON.stringify(source.typesetting) || JSON.stringify(line.polygon) !== JSON.stringify(source.polygon) ||
        JSON.stringify(line.ocrSourceInfo) !== JSON.stringify(source.ocrSourceInfo) ||
        JSON.stringify((line as DialogueLine & { sourceLineIds?: string[] }).sourceLineIds ?? []) !== JSON.stringify((source as DialogueLine & { sourceLineIds?: string[] }).sourceLineIds ?? []) ||
        line.ocrEditStatus !== "ai_proposed" || line.userTranslation !== undefined || line.ocrUserOwnedFields?.length || !line.aiTranslation?.trim()) {
      throw new Error("식자 페이지·원문·revision 또는 사용자 소유 배치가 변경되었습니다.");
    }
  }
}

/** OCR 확인·번역 채택·프로젝트 저장을 수행하지 않는 메모리 전용 후보다. */
export function draftLines(ocr: SpeechBubbleExtractionResult, pageNumber = ocr.pageNumber): DialogueLine[] {
  if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber) || pageNumber < 1) throw new Error("페이지 번호가 올바르지 않습니다.");
  return orderedCandidates(ocr).map((candidate) => ({
    id: candidate.id,
    order: candidate.readingOrder,
    pageNumber,
    sourceText: candidate.text,
    sourceLanguage: candidate.language === "ja" || candidate.language === "en" ? candidate.language : "unknown",
    dialogueType: candidate.type === "thought_bubble" ? "thought" : "speech",
    parseConfidence: candidate.confidence,
    parseWarnings: [...ocr.warnings],
    notes: candidate.notes,
    ocrEditStatus: "ai_proposed",
    ocrGroupId: candidate.productionOcrProvenance?.groupId,
    sourceLineIds: [...((candidate as ExtractedSpeechBubble & { ocrRefinement?: { sourceDetectionIds?: string[] } }).ocrRefinement?.sourceDetectionIds ??
      candidate.productionOcrProvenance?.sourceDetectionIds ?? candidate.inventoryLineIds ?? [])],
    polygon: candidate.polygon ? structuredClone(candidate.polygon) : undefined,
    ocrSourceInfo: {
      rawMangaOcrText: candidate.rawMangaOcrText,
      rawPaddleOcrText: candidate.rawPaddleOcrText,
      isCrossValidated: candidate.isCrossValidated,
      confidence: candidate.confidence,
      orientation: candidate.orientation,
      productionOcrProvenance: candidate.productionOcrProvenance ? structuredClone(candidate.productionOcrProvenance) : undefined
    },
    typesetting: { bbox: { ...candidate.bbox }, writingMode: "horizontal-tb" }
  }));
}

export async function translateDrafts(
  lines: readonly DialogueLine[],
  options: { endpoint: string; model: string }
): Promise<{ lines: DialogueLine[]; records: PreviewTranslationRecord[] }> {
  validateLineIds(lines);
  if (!options.endpoint?.trim() || !options.model?.trim()) throw new Error("로컬 번역 endpoint와 model이 필요합니다.");
  const execute = window.projectApi?.executeTranslation;
  if (!execute) throw new Error("기존 번역 IPC를 사용할 수 없습니다.");
  const drafts = structuredClone([...lines]);
  const records: PreviewTranslationRecord[] = [];
  const completed = new Set<string>();
  const requestIds = new Set<string>();

  for (const line of drafts) {
    const payload = buildTranslationContextPayload({ dialogueLines: drafts, targetLineId: line.id });
    const fingerprint = computeTranslationPayloadFingerprint(payload);
    const requestId = crypto.randomUUID();
    if (requestIds.has(requestId)) throw new Error("번역 요청 ID가 중복되었습니다.");
    requestIds.add(requestId);
    const started = performance.now();
    const result = await execute({
      payload,
      targetLineId: line.id,
      requestId,
      options: {
        engineType: "local_ai",
        localAiRuntime: "custom",
        localAiEndpoint: options.endpoint,
        localAiModel: options.model
      }
    });
    if (!result || result.engine !== "local_ai" || result.usedExactTm ||
        typeof result.translatedText !== "string" || !result.translatedText.trim()) {
      throw new Error(`영역 ${line.id}: 비어 있거나 로컬 AI가 아닌 번역 응답입니다.`);
    }
    if (result.contextFingerprint !== fingerprint) throw new Error(`영역 ${line.id}: 반환 문맥 지문이 요청과 다릅니다.`);
    // IPC 응답에는 ID가 없다. 요청의 ID·지문을 검사한 직후 해당 사본에 결합한다.
    if (payload.source.id !== line.id || completed.has(line.id)) throw new Error("번역 영역 ID 대응이 올바르지 않습니다.");
    line.aiTranslation = result.translatedText.trim();
    completed.add(line.id);
    records.push({
      id: line.id,
      requestId,
      engine: "local_ai",
      usedExactTm: false,
      requestedContextFingerprint: fingerprint,
      returnedContextFingerprint: result.contextFingerprint,
      qaReport: result.qaReport ? structuredClone(result.qaReport) : null,
      durationMs: performance.now() - started
    });
  }
  if (completed.size !== drafts.length || lines.some((line) => !completed.has(line.id))) {
    throw new Error("일부 영역의 번역 응답이 누락되었습니다.");
  }
  return { lines: drafts, records };
}

/** 모든 번역 요청이 성공한 뒤 호출한다. 준비된 ImageData는 원본을 다시 decode하지 않고 사용한다. */
export async function createRemovalMask(
  ocr: SpeechBubbleExtractionResult, width: number, height: number, source: string | ImageData
): Promise<{ maskPngBase64: string; maskedPixels: number; regions: PreviewMaskRegion[] }> {
  validateDimensions(width, height);
  if (!source || typeof source === "string" && !source.trim()) throw new Error("제거 마스크에 실제 원본 이미지가 필요합니다.");
  const candidates = orderedCandidates(ocr);
  if (!candidates.length) throw new Error("제거 마스크를 만들 OCR 후보가 없습니다.");
  const geometry = candidates.map((candidate) => {
    const provenance = candidate.productionOcrProvenance;
    let polygonsPx: PolygonPoint[][];
    let geometrySource: PreviewMaskRegion["geometrySource"];
    if (provenance?.sourceQuadsPx.length) {
      const { imageWidth, imageHeight } = provenance.cropTransform;
      validateDimensions(imageWidth, imageHeight);
      geometrySource = "sourceQuadsPx";
      polygonsPx = provenance.sourceQuadsPx.map((quad) => quad.map((point) => ({
        x: point.x * width / imageWidth, y: point.y * height / imageHeight
      })));
    } else {
      geometrySource = "polygon";
      if (!candidate.polygon?.length) throw new Error(`영역 ${candidate.id}: 실제 제거 polygon이 없습니다.`);
      polygonsPx = [candidate.polygon.map((point) => ({ x: point.x * width, y: point.y * height }))];
    }
    for (const polygon of polygonsPx) {
      const bounds = polygonBounds(polygon);
      if (bounds.x + bounds.width <= 0 || bounds.y + bounds.height <= 0 || bounds.x >= width || bounds.y >= height) {
        throw new Error(`영역 ${candidate.id}: 제거 좌표가 이미지 밖에 있습니다.`);
      }
    }
    return { id: candidate.id, geometrySource, polygonsPx };
  });
  const { canvas, context } = createCanvas(width, height);
  let sourcePixels: ImageData;
  if (typeof source === "string") {
    const image = await loadImage(source);
    if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error("원본 이미지 크기가 제거 마스크 요청과 다릅니다.");
    context.drawImage(image, 0, 0);
    sourcePixels = context.getImageData(0, 0, width, height);
  } else {
    sourcePixels = source;
  }
  if (sourcePixels.width !== width || sourcePixels.height !== height ||
      !(sourcePixels.data instanceof Uint8ClampedArray) || sourcePixels.data.length !== width * height * 4) {
    throw new Error("원본 이미지 픽셀 크기가 제거 마스크 요청과 다릅니다.");
  }
  const mask = buildSourceTextMask({ pixels: sourcePixels.data, width, height }, geometry.map(({ id, polygonsPx }) => ({ id, polygonsPx })));
  const regions: PreviewMaskRegion[] = mask.regions.map((region, index) => ({ ...geometry[index]!, ...region }));
  const pixels = context.createImageData(width, height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = 255;
    pixels.data[index + 3] = mask.pixels[index / 4]! > 0 ? 0 : 255;
  }
  if (!mask.maskedPixels) throw new Error("제거 마스크에 실제 픽셀이 없습니다.");
  context.putImageData(pixels, 0, 0);
  return { maskPngBase64: canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""), maskedPixels: mask.maskedPixels, regions };
}

export async function renderCandidate(
  cleanedUrl: string, lines: readonly DialogueLine[],
  options: { expectedDimensions?: { width: number; height: number }; protectedBoxes?: readonly NormalizedBbox[];
    backgroundContext?: { sourcePngBase64:string; maskPngBase64:string; sourceSha256:string; cleanedSha256:string; maskSha256:string;
      allowedBoxes:readonly {id:string;bbox:NormalizedBbox}[]; manualEntries?:ManualEntry[]; manualApprovalSha256?:string;
      nonWhiteFallback?:true; widenSharedBalloon?:true } } = {}
): Promise<{ pngBase64: string; width: number; height: number; layoutReport: PreviewLayoutReport[] }> {
  validateLineIds(lines);
  if (new Set(lines.map((line) => line.pageNumber)).size > 1) throw new Error("한 이미지에는 같은 페이지의 대사만 식자할 수 있습니다.");
  for (const line of lines) requireBbox(line.typesetting?.bbox, line.id);
  const candidates = structuredClone([...lines]);
  const sourceBoxes = candidates.map((line) => ({ id: line.id, bbox: { ...line.typesetting!.bbox } }));
  if (!await ensureProductionTypesetFontLoaded()) throw new Error("제품 한글 식자 글꼴을 불러오지 못했습니다.");
  const image = await loadImage(cleanedUrl);
  const width = image.naturalWidth, height = image.naturalHeight;
  validateDimensions(width, height);
  if (options.expectedDimensions && (width !== options.expectedDimensions.width || height !== options.expectedDimensions.height)) throw new Error("cleaned 이미지 해상도가 준비한 식자 좌표계와 다릅니다.");
  const protectedRegions = options.protectedBoxes ?? [];
  for (const box of protectedRegions) requireBbox(box, "protected");
  const { canvas: outputCanvas, context } = createCanvas(width, height);
  context.drawImage(image, 0, 0);
  const background=options.backgroundContext;
  const manualEntries=background?.manualEntries?.length?normalizeManualEntries(background.manualEntries,lines.map(line=>({id:line.id,text:candidateText(line),bbox:line.typesetting!.bbox,allowedBbox:background.allowedBoxes.find(b=>b.id===line.id)?.bbox})),width,height):[];
  if(manualEntries.length&&!/^[a-f0-9]{64}$/.test(background?.manualApprovalSha256??''))throw Error('MANUAL_LAYOUT_REQUIRED: 수동 배치의 별도 승인을 확인하지 못했습니다.');
  const readBackgroundScene = async (input: NonNullable<typeof background>) => {
    const readPixels = async (base64: string) => {
      const source = await loadImage('data:image/png;base64,' + base64);
      if (source.naturalWidth !== width || source.naturalHeight !== height) throw Error('MANUAL_LAYOUT_REQUIRED: 배경 검증 좌표계가 다릅니다.');
      const frame = createCanvas(width, height).context;
      frame.drawImage(source, 0, 0);
      return frame.getImageData(0, 0, width, height).data;
    };
    const frames = { sourcePixels: await readPixels(input.sourcePngBase64), maskPixels: await readPixels(input.maskPngBase64),
      cleanedPixels: context.getImageData(0, 0, width, height).data, width, height,
      sourceSha256: input.sourceSha256, cleanedSha256: input.cleanedSha256, maskSha256: input.maskSha256 };
    return { ...createBackgroundScene(frames), frames };
  };
  // The regular engine already verified restoration outside the mask. Read
  // these frames only if its non-white fallback actually needs a pixel scene.
  let scene = background && !background.nonWhiteFallback ? readBackgroundScene(background) : undefined;
  if (scene) await scene;
  const manualTexts=new Map(manualEntries.map(e=>[e.id,e.text]));
  const textFor=(line:DialogueLine)=>manualTexts.get(line.id)??candidateText(line);
  const otherBackgroundBoxes=[...sourceBoxes,...manualEntries.map(e=>({id:e.id,bbox:e.bbox})),...protectedRegions.map((bbox,i)=>({id:'protected-'+i,bbox}))];
  const sharedLayout = background?.widenSharedBalloon && !manualEntries.length ? { protectedBoxes: protectedRegions } : undefined;
  const layoutReport: PreviewLayoutReport[] = [];
  const interiors = new Map<string, CandidateInterior>();
  const layouts = new Map<string, TypesettingLayoutResult>();
  const diagnostics = new Map<string, Record<string, unknown>>();
  const failures: Array<{ id: string; error: Error & { code?: string; layoutDiagnostics?: { reasonCodes?: string[]; background?: unknown; whiteSearch?: unknown;standard?:StandardResult;measuredFit?:PreviewLayoutReport['measuredFit'];fontSizePx?:number } }; stage: string }> = [];
  const recordDiagnostic = (line: DialogueLine, stage: string, error?: typeof failures[number]["error"]) => {
    const report = layoutReport.find(r => r.id === line.id), prior = diagnostics.get(line.id);
    diagnostics.set(line.id, { id: line.id, sourceBbox: sourceBoxes.find(r => r.id === line.id)!.bbox,
      bbox: report?.bbox ?? null, stage, measurementAvailable: !!report,
      fontSizePx: report?.fontSizePx ?? error?.layoutDiagnostics?.fontSizePx ?? null, fitStatus: report?.fitStatus ?? null,
      measuredFit: report?.measuredFit ?? error?.layoutDiagnostics?.measuredFit ?? null, textComplete: report?.textEvidence?.complete ?? null,standard:report?.standard??error?.layoutDiagnostics?.standard??null,
      glyphEvidence: report?.glyphEvidence ? { missingGlyphOccurrences: report.glyphEvidence.missingGlyphOccurrences } : null, safeAreaEvidence: report?.safeAreaEvidence ?? null,
      raster: report?.raster ?? null,
      background: error?.layoutDiagnostics?.background ? { ...error.layoutDiagnostics.background as object, reasonCodes: error.layoutDiagnostics.reasonCodes ?? [] } : prior?.background ?? report?.safeAreaEvidence?.background ?? null,
      whiteSearch: error?.layoutDiagnostics?.whiteSearch ?? prior?.whiteSearch ?? null,
      reasonCodes: error ? error.layoutDiagnostics?.reasonCodes ?? [error.code ?? (error.message.startsWith("MANUAL_LAYOUT_REQUIRED:") ? "MANUAL_LAYOUT_REQUIRED" : "RENDERER_REGION_FAILED")] : [] });
  };
  const throwCollected = () => {
    if (!failures.length) return;
    const first = failures[0]!, error = first.error;
    throw Object.assign(new Error(error.message), { code: error.code ?? (error.message.startsWith("FONT_OR_GLYPH_ERROR:") ? "FONT_OR_GLYPH_ERROR" : error.message.startsWith("MANUAL_LAYOUT_REQUIRED:") ? "MANUAL_LAYOUT_REQUIRED" : "IMAGE_WORKER_FAILED"),
      layoutDiagnostics: { version: 3, rejectedRegion: first.id, stage: first.stage,
        reasonCodes: error.layoutDiagnostics?.reasonCodes ?? [error.code ?? "REGION_LAYOUT_FAILED"],
        background: error.layoutDiagnostics?.background ?? null,
        whiteSearch: error.layoutDiagnostics?.whiteSearch ?? null,
        expectedRegions: candidates.length, observedRegions: diagnostics.size,
        regions: candidates.map(line => diagnostics.get(line.id) ?? { id: line.id, measurementAvailable: false, fontSizePx: null, fitStatus: null, raster: null }) } });
  };
  for (const line of candidates) {
    let stage = "renderer-background";
    try {
    const style = line.typesetting!;
    const sourceBbox = { ...style.bbox };
    const manual=manualEntries.find(e=>e.id===line.id);
    const inferred: ReturnType<typeof inferCandidateBox> = manual?{bbox:{...manual.bbox},expanded:false,reasons:['사용자가 검토·승인한 배치입니다. 실제 복원 배경과 잉크 검사는 별도로 수행합니다.']}:inferCandidateBox(context, line, sourceBoxes, width, height,background?.allowedBoxes.find(b=>b.id===line.id)?.bbox,sharedLayout);
    const allowed=background?.allowedBoxes.find(b=>b.id===line.id)?.bbox;if(allowed&&!inside(inferred.bbox,allowed))throw Object.assign(new Error('MANUAL_LAYOUT_REQUIRED: 식자 후보가 허용 ROI를 벗어났습니다.'),{code:'MANUAL_LAYOUT_REQUIRED',layoutDiagnostics:{reasonCodes:['AUTO_CANDIDATE_OUTSIDE_ALLOWED_ROI']}});
    let backgroundResult: BackgroundResult | undefined;
    let unresolvedBackground: BackgroundResult | undefined;
    let widerUniform: BackgroundResult | undefined;
    let uniformInsetPicked = false;
    const text = textFor(line);
    const automaticDialogue = background?.nonWhiteFallback && !allowed && !manualEntries.length &&
      line.userTranslation === undefined && !line.ocrUserOwnedFields?.length && style.fontSizeRatio === undefined &&
      isGeneralKorean({ text, ...style, dialogueType: line.dialogueType });
    const backgroundError = (result: BackgroundResult) => Object.assign(
      Error('MANUAL_LAYOUT_REQUIRED: 영역 '+line.id+'의 배경·그림 경계·대비 안전 근거를 확인하지 못했습니다.'),
      {code:'MANUAL_LAYOUT_REQUIRED',layoutDiagnostics:{version:2,rejectedRegion:line.id,stage:'renderer-background',reasonCodes:result.reasonCodes,
        background:result.evidence,whiteSearch:{reasons:inferred.reasons,candidateBbox:inferred.bbox,interiorVerified:!!inferred.interior}}});
    if(manual){style.fontSizeRatio=manual.fontSizePx/(manual.bbox.height*height);style.lineHeight=manual.lineHeight;style.writingMode='horizontal-tb';style.rotationDegrees=0;}
    if (background && (manual || !inferred.interior && (!background.nonWhiteFallback || inferred.nonWhiteAnchor))) {
      scene ??= readBackgroundScene(background);
      const verifiedScene = await scene;
      const args={id:line.id,bbox:manual?.bbox??sourceBbox,allowedBbox:manual?background.allowedBoxes.find(b=>b.id===line.id)?.bbox:sourceBbox,otherBoxes:otherBackgroundBoxes,approvalSha256:background.manualApprovalSha256};
      backgroundResult=manual?verifiedScene.inspectManual(args):verifiedScene.inspectUniform(args);
      if (!manual && background.nonWhiteFallback && backgroundResult.reasonCodes.includes('BACKGROUND_NOT_UNIFORM')) {
        const inset = findUniformSourceInset(context, sourceBbox, width, height);
        if (inset) {
          const verifiedInset = verifiedScene.inspectUniform({ ...args, bbox: inset });
          if (verifiedInset.status === 'SAFE_PIXELS_VERIFIED') {
            backgroundResult = verifiedInset;
            uniformInsetPicked = true;
            inferred.reasons.push('원문 중심을 포함한 작은 영역에서 배경과 식자 여백을 다시 확인했습니다.');
            if (!allowed && verifiedInset.interior) {
              const wider = findWiderUniformInset(context, verifiedInset.evidence.bbox, verifiedInset.interior, width, height);
              if (wider) {
                const expanded = verifiedScene.inspectUniform({ ...args, bbox: wider, allowedBbox: wider });
                if (expanded.status === 'SAFE_PIXELS_VERIFIED') widerUniform = expanded;
              }
            }
          }
        }
      }
      if (backgroundResult.status !== 'SAFE_PIXELS_VERIFIED' || !backgroundResult.interior) {
        if (!automaticDialogue || !backgroundResult.reasonCodes.includes('BACKGROUND_NOT_UNIFORM')) throw backgroundError(backgroundResult);
        unresolvedBackground = backgroundResult;
      } else {
        inferred.interior=backgroundResult.interior;inferred.bbox=backgroundResult.evidence.bbox;
        style.color=backgroundResult.paint!.color;style.strokeColor=backgroundResult.paint!.strokeColor;
        inferred.reasons.push(manual?'승인 ROI 안에서도 그림 경계·대비 위험 픽셀에 실제 잉크가 닿으면 차단합니다.':'원본 보호 픽셀과 실제 복원 배경·여백의 균일 색상 및 대비를 확인했습니다.');
      }
    }
    style.bbox = inferred.bbox;
    if (inferred.interior) { interiors.set(line.id, inferred.interior); style.shape = "rectangle"; }
    stage = "renderer-measurement";
    const fontFamily = style.fontFamily || PRODUCTION_TYPESET_FONT_CSS_FAMILY;
    const font = `bold 16px ${getRecommendedFontFallbackChain("ko", fontFamily)}`;
    await document.fonts.load(font, `한글${text}`);
    const glyphFontLoaded = document.fonts.check(font, `한글${text}`);
    if (!glyphFontLoaded) throw new Error(`영역 ${line.id}: 한글 식자 글꼴 확인에 실패했습니다.`);
    if (!text.trim()) throw new Error(`영역 ${line.id}: 식자할 번역문이 비어 있습니다.`);
    const layoutOptions = {
      shape: style.shape ?? "ellipse",
      boxAspectRatio: style.writingMode === "vertical-rl" ? 1 : style.bbox.width * width / (style.bbox.height * height)
    };
    let layout = style.fontSizeRatio
      ? layoutTextForBubbleShape(text, { ...layoutOptions, fontSizeRatio: style.fontSizeRatio })
      : autoFitFontSizeForBubbleShape(text, layoutOptions);
    let measuredFit: PreviewLayoutReport["measuredFit"];
    if (text && (!style.writingMode || style.writingMode === "horizontal-tb") && !style.rotationDegrees) {
      const fitScope = { dialogueType: line.dialogueType };
      // The safe box can be much shorter than the OCR envelope. Use the old
      // box only as a sizing reference; the smaller box still has to fit.
      const sourceFit = uniformInsetPicked && style.fontSizeRatio === undefined
        ? measureCandidateFit(context, text, { ...style, bbox: sourceBbox }, width, height, fitScope) : undefined;
      const preferredFontSizePx = sourceFit?.status === 'FIT_WARNING' ? sourceFit.fontSizePx : undefined;
      let measured = measureCandidateFit(context, text, style, width, height, { ...fitScope, preferredFontSizePx });
      if (widerUniform?.interior && widerUniform.paint) {
        const widerStyle = { ...style, ...widerUniform.paint, bbox: widerUniform.evidence.bbox };
        const larger = measureInVerifiedBox(context, line, text, widerStyle, width, height, measured);
        if (larger) {
          measured = larger;
          Object.assign(style, widerStyle);
          backgroundResult = widerUniform;
          interiors.set(line.id, widerUniform.interior);
          inferred.expanded = true;
          inferred.reasons.push("중앙의 균일한 배경을 좌우로 다시 확인해 더 큰 글씨를 놓았습니다.");
        }
      }
      if (inferred.expanded && inferred.interior && measured.status !== "MANUAL_LAYOUT_REQUIRED" &&
          paintedInkOverlapsRegions(line, text, measured, width, height, protectedRegions)) {
        const inset = findSourceInset(inferred.interior, sourceBbox, width, height);
        const conflicts = inset && (protectedRegions.some(box => boxesOverlap(inset, box)) ||
          sourceBoxes.some(other => other.id !== line.id && boxesOverlap(inset, other.bbox)) ||
          manualEntries.some(other => other.id !== line.id && boxesOverlap(inset, other.bbox)));
        if (inset && !conflicts) {
          const alternate = measureCandidateFit(context, text, { ...style, bbox: inset }, width, height, fitScope);
          if (alternate.status !== "MANUAL_LAYOUT_REQUIRED") {
            measured = alternate;
            style.bbox = inset;
            inferred.expanded = false;
            inferred.reasons = ["보호할 원문과의 충돌을 피하고 원래 말풍선 안에서 전체 대사가 들어가는 배치를 찾았습니다."];
          }
        }
      }
      const wider = inferred.widerSharedBox;
      const originalHeld = measured.status === "MANUAL_LAYOUT_REQUIRED";
      if (wider && (originalHeld || measured.layout.lines.length > 1)) {
        const bbox = normalizeLayoutBox(wider, width, height);
        const widerStyle = { ...style, bbox };
        const alternate = measureCandidateFit(context, text, originalHeld ? widerStyle :
          { ...widerStyle, fontSizeRatio: measured.fontSizePx / wider.height }, width, height, fitScope);
        const fewerLines = alternate.layout.lines.length < measured.layout.lines.length;
        // A narrow column can gain legibility without losing a row. Keep
        // single-line neighbours at their established scale and position.
        const larger = !originalHeld && alternate.status !== "MANUAL_LAYOUT_REQUIRED" &&
          alternate.layout.lines.length > 1 && alternate.layout.lines.length <= measured.layout.lines.length
          ? measureInVerifiedBox(context, line, text, widerStyle, width, height, alternate, "larger-with-side-clearance") : undefined;
        if (alternate.status !== "MANUAL_LAYOUT_REQUIRED" && (originalHeld || fewerLines || larger)) {
          measured = larger ?? alternate;
          style.bbox = bbox;
          interiors.set(line.id, { ...wider, mask: new Uint8Array(wider.width * wider.height).fill(1) });
          inferred.expanded = true;
          inferred.reasons = [larger ? "이웃 대사와의 간격을 지키며 더 큰 글씨로 같은 줄 수 안에 배치했습니다." :
            "이웃 원문과 사이를 띄운 흰 공간에 전체 대사를 배치했습니다."];
        }
      }
      if (background?.nonWhiteFallback && !allowed && !manualEntries.length && inferred.interior &&
          inferred.singleBalloonPadding && measured.status !== "MANUAL_LAYOUT_REQUIRED") {
        const joinLastLine = measured.layout.lines.length === 2 && !/[\r\n]/u.test(text) &&
          measured.standard?.softWarnings.some(w => w.code === "SHORT_LAST_LINE") === true;
        const band = measured.layout.lines.length === 1 || joinLastLine
          ? findWiderSingleLineBox(inferred.interior, style.bbox, measured, width, height, inferred.singleBalloonPadding) : undefined;
        if (band) {
          const bbox = normalizeLayoutBox(band, width, height);
          const clear = !otherBackgroundBoxes.some(other => other.id !== line.id && boxesOverlap(bbox, other.bbox));
          const fit = clear && measureInVerifiedBox(context, line, text, { ...style, bbox }, width, height, measured,
            joinLastLine ? "join-short-last-line" : "larger-with-side-clearance");
          if (fit) {
            measured = fit;
            style.bbox = bbox;
            interiors.set(line.id, { ...band, mask: new Uint8Array(band.width * band.height).fill(1) });
            inferred.expanded = true;
            inferred.reasons.push(joinLastLine ? "말풍선 중앙에 짧은 마지막 어절까지 한 줄로 배치했습니다." :
              "닫힌 말풍선 중앙의 가로 폭과 여백을 확인해 같은 위치에 한 줄을 더 크게 놓았습니다.");
          }
        }
      }
      if (automaticDialogue && (unresolvedBackground || inferred.interior && measured.status === "MANUAL_LAYOUT_REQUIRED")) {
        scene ??= readBackgroundScene(background);
        const verified = await scene;
        const reference = sourceFit ?? measureCandidateFit(context, text, { ...style, bbox: sourceBbox, shape: "rectangle" }, width, height, fitScope);
        const inspect = (bbox:NormalizedBbox) => verified.inspectUniform({
          id:line.id, bbox, allowedBbox:sourceBbox, otherBoxes:otherBackgroundBoxes,
        });
        type Fit = ReturnType<typeof measureCandidateFit>;
        const improves = (next:Fit|undefined, previous:Fit):next is Fit => !!next &&
          next.fontSizePx>previous.fontSizePx && next.layout.lines.length<=previous.layout.lines.length &&
          (next.standard?.readability?.penalty??Infinity)<=(previous.standard?.readability?.penalty??0);
        let chosen:{seed:NormalizedBbox; proof:BackgroundResult; fit:Fit; ink:number}|undefined;
        let checkedNeighbor=false;
        for (const proposal of findSourceInkBoxes(verified.frames, sourceBbox)) {
          if(chosen){
            // Small changes to the same patch can exchange a few rows for a
            // wider column. Keep the first successful location in the balloon.
            if(checkedNeighbor)break;
            const a=chosen.seed,b=proposal.bbox;
            if(Math.abs(a.x-b.x)>a.width/8 || Math.abs(a.y-b.y)>a.height/8 ||
               Math.abs(a.width-b.width)>a.width/8 || Math.abs(a.height-b.height)>a.height/8)continue;
            checkedNeighbor=true;
          }
          const proof=inspect(proposal.bbox);
          if(proof.status!=="SAFE_PIXELS_VERIFIED" || !proof.interior || !proof.paint)continue;
          const proposedStyle={...style,...proof.paint,shape:"rectangle" as const,bbox:proposal.bbox};
          const candidate=measureCandidateFit(context,text,proposedStyle,width,height,{...fitScope,
            preferredFontSizePx:Math.min(reference.fontSizePx,proof.interior.height)});
          if(candidate.status==="MANUAL_LAYOUT_REQUIRED" || !paintFitsVerifiedBox(line,text,proposedStyle,width,height,candidate))continue;
          const larger=measureInVerifiedBox(context,line,text,proposedStyle,width,height,candidate,"larger-with-side-clearance");
          let fit=improves(larger,candidate)?larger:candidate;
          let selectedProof=proof,ink=proposal.erasedInkPixels;
          let expandedProof:BackgroundResult|undefined;
          const expanded=expandVerifiedInkBox(proposal.bbox,verified.frames,box=>{
            const checked=inspect(box);
            if(checked.status!=="SAFE_PIXELS_VERIFIED" || !checked.interior || !checked.paint ||
               checked.paint.color!==proof.paint!.color || checked.paint.strokeColor!==proof.paint!.strokeColor)return false;
            expandedProof=checked;
            return true;
          });
          if(expanded && expandedProof){
            const alternate=measureInVerifiedBox(context,line,text,{...proposedStyle,bbox:expanded.bbox},width,height,fit,"larger-with-side-clearance");
            if(improves(alternate,fit)){fit=alternate;selectedProof=expandedProof;ink=expanded.erasedInkPixels;}
          }
          if(!chosen || improves(fit,chosen.fit))chosen={seed:proposal.bbox,proof:selectedProof,fit,ink};
        }
        if(chosen){
          const {proof,fit,ink}=chosen;
          measured=fit;
          Object.assign(style,proof.paint,{shape:"rectangle",bbox:proof.evidence.bbox});
          backgroundResult=proof;
          proof.evidence.erasedSourceInkPixels=ink;
          interiors.set(line.id,proof.interior!);
          inferred.expanded=false;
          inferred.reasons=["지워진 원문 획 근처에서 원본·복원 배경과 이웃의 여백을 확인해 전체 대사를 배치했습니다."];
          unresolvedBackground=undefined;
        }
        if (unresolvedBackground) { stage = "renderer-background"; throw backgroundError(unresolvedBackground); }
      }
      const verifiedInterior = interiors.get(line.id);
      if (automaticDialogue && verifiedInterior && measured.status !== "MANUAL_LAYOUT_REQUIRED") {
        const neighbors = otherBackgroundBoxes.filter(box => box.id !== line.id).map(box => box.bbox);
        const domain = inferred.widerSharedBox?.domain ?? (inferred.singleBalloonPadding ? { padding: inferred.singleBalloonPadding } : undefined);
        const joined = measureHonorificWrap(context, line, text, style, width, height, measured, verifiedInterior, neighbors,
          inferred.interior && domain ? { ...domain, interior: inferred.interior, source: sourceBbox } : undefined);
        if (joined) {
          measured = joined.fit;
          if (joined.band) {
            style.bbox = normalizeLayoutBox(joined.band, width, height);
            interiors.set(line.id, { ...joined.band, mask: new Uint8Array(joined.band.width * joined.band.height).fill(1) });
            inferred.expanded = true;
          }
          inferred.reasons.push("이름과 호칭을 한 줄에 놓고 실제 글자 획과 이웃 영역의 간격을 확인했습니다.");
        }
      }
      measuredFit = { completeText: measured.completeText, fitsBox: measured.fitsBox, resized: measured.resized, linesSeparated: measured.linesSeparated, selection: measured.selection,inkBounds:measured.inkBounds };
      if (!measured.completeText || !measured.fitsBox || measured.fontSizePx < 10 || measured.standard?.status==='BLOCKED') throw Object.assign(new Error(`MANUAL_LAYOUT_REQUIRED: 영역 ${line.id}의 전체 문자를 가독 하한과 배치 범위 안에 넣지 못했습니다.`),{code:'MANUAL_LAYOUT_REQUIRED',layoutDiagnostics:{standard:measured.standard,measuredFit,fontSizePx:measured.fontSizePx,reasonCodes:measured.standard?.hardViolations.map(v=>v.rule+':'+v.code)??['TEXT_FIT_NOT_VERIFIED']}});
      layout = measured.layout;
      style.strokeWidth = measured.strokeWidthPx;
      if (!measured.fitsBox) inferred.reasons.push("실제 글꼴과 외곽선이 원문 범위에 맞지 않습니다. 안전한 내부 영역도 확인하지 못해 검토가 필요합니다.");
    }
    const glyphEvidence = inspectCanvasGlyphCoverage(text, getRecommendedFontFallbackChain("ko", fontFamily), Math.max(1, Math.round(layout.fontSizeRatio * style.bbox.height * height)));
    if (glyphEvidence.missingGlyphOccurrences) throw new Error(`FONT_OR_GLYPH_ERROR: 영역 ${line.id}에 누락·대체 글리프가 있습니다.`);
    if (style.fontSizeRatio === undefined) style.fontSizeRatio = layout.fontSizeRatio;
    layouts.set(line.id, layout);
    layoutReport.push({
      id: line.id,order:line.order,speaker:line.speaker,shape:style.shape??'ellipse',writingMode:style.writingMode,lineHeight:layout.lines.length>1?(layout.lines[1]!.relativeY-layout.lines[0]!.relativeY)*style.bbox.height*height/Math.max(1,Math.round(layout.fontSizeRatio*style.bbox.height*height)):style.lineHeight??1.3, sourceBbox, bbox: { ...style.bbox }, bboxInferred: inferred.expanded,
      fontFamily, fontSizeRatio: layout.fontSizeRatio,
      fontSizePx: Math.max(10, Math.round(layout.fontSizeRatio * style.bbox.height * height)),
      productionFontLoaded: true, glyphFontLoaded, qaStatus: "pending", reviewReasons: inferred.reasons, measuredFit
      , contractVersion: "stage12-layout-v1", fitStatus: "RENDER_NOT_MEASURED", glyphEvidence,
      textEvidence: inspectTypesettingText(text, layout.lines.map(l => l.text)), actualLayout: structuredClone(layout),
      paint: { font: `bold ${Math.max(1, Math.round(layout.fontSizeRatio * style.bbox.height * height))}px ${getRecommendedFontFallbackChain("ko", fontFamily)}`,
        strokeWidth: style.strokeWidth ?? 0, align: style.align ?? "center", writingMode: style.writingMode ?? "horizontal-tb", rotationDegrees: style.rotationDegrees ?? 0, color:style.color,strokeColor:style.strokeColor },
      safeAreaEvidence: { basis: backgroundResult?.evidence.basis??(inferred.interior ? "CLOSED_WHITE_COMPONENT_INSET_RECTANGLE" : "UNVERIFIED_ROI_OR_MANUAL_GEOMETRY"), humanVerified: false, tailAndArtworkSemanticVerified: null,...(backgroundResult?{background:backgroundResult.evidence}:{}) },
      ...(manual?{manualLayoutApprovalSha256:background!.manualApprovalSha256}:{})
    });
    recordDiagnostic(line, stage);
    } catch (error) {
      const e = error as typeof failures[number]["error"];
      failures.push({ id: line.id, error: e, stage }); recordDiagnostic(line, stage, e);
    }
  }
  // Plan every independent region before rasterizing. A failed plan never
  // produces a partial candidate PNG, but no later font measurements are lost.
  throwCollected();
  const occupancy = new Uint8Array(width * height);
  for (const [index, line] of candidates.entries()) {
    try {
    if (!textFor(line)) continue;
    const report = layoutReport[index]!, style = line.typesetting!;
    const guard = Math.ceil(Math.max(8, report.fontSizePx * 2 + (style.strokeWidth ?? 4)));
    if ((width + guard * 2) * (height + guard * 2) > 32_000_000) throw new Error("식자 픽셀 검사 메모리 한도를 초과했습니다. 수동 배치가 필요합니다.");
    const { canvas: inkCanvas, context: inkContext } = createCanvas(width + guard * 2, height + guard * 2);
    inkContext.translate(guard, guard);
    renderTypesettingToCanvas(inkContext, [line], width, height, { textResolver: textFor, layoutResolver: line => layouts.get(line.id) });
    const padded = inkContext.getImageData(0, 0, inkCanvas.width, inkCanvas.height).data;
    let clippedPixels = 0;
    for (let at = 0; at < padded.length / 4; at++) if (padded[at * 4 + 3]) {
      const x = at % inkCanvas.width - guard, y = Math.floor(at / inkCanvas.width) - guard;
      if (x < 0 || y < 0 || x >= width || y >= height) clippedPixels++;
    }
    const pixels = inkContext.getImageData(guard, guard, width, height).data;
    const raster = inspectCandidateInk(pixels, width, height, interiors.get(line.id));
    let otherRegionCollisionPixels = 0, overlappingInkPixels = 0;
    const protectedBoxes = [...sourceBoxes.filter(b => b.id !== line.id).map(b => b.bbox),...manualEntries.filter(e=>e.id!==line.id).map(e=>e.bbox), ...protectedRegions];
    for (let at = 0; at < width * height; at++) if (pixels[at * 4 + 3]) {
      const x = (at % width + .5) / width, y = (Math.floor(at / width) + .5) / height;
      if (protectedBoxes.some(b => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height)) otherRegionCollisionPixels++;
      if (occupancy[at]) overlappingInkPixels++;
      occupancy[at] = 1;
    }
    report.raster = { ...raster, clippedPixels, otherRegionCollisionPixels, overlappingInkPixels };
    if (!raster.paintedPixels || (raster.outsideInteriorPixels !== null && raster.outsideInteriorPixels > 0)) {
      throw Object.assign(new Error(`MANUAL_LAYOUT_REQUIRED: 영역 ${line.id}의 실제 글자 또는 외곽선이 안전 내부를 벗어났습니다.`),{code:'MANUAL_LAYOUT_REQUIRED'});
    }
    if (clippedPixels || raster.canvasEdgePixels || otherRegionCollisionPixels || overlappingInkPixels) throw new Error(`MANUAL_LAYOUT_REQUIRED: 영역 ${line.id}에 클리핑 또는 다른 영역과의 충돌이 있습니다.`);
    if (!report.textEvidence?.complete) throw new Error(`영역 ${line.id}: 문자열 보존 검사에 실패했습니다.`);
    report.raster = { ...raster, clippedPixels, otherRegionCollisionPixels, overlappingInkPixels };
    report.fitStatus = interiors.has(line.id) && report.measuredFit?.fitsBox && report.fontSizePx > 12 ? "FIT_VERIFIED" : "FIT_WARNING";
    report.standard=evaluateKoreanTypesetting({text:candidateText(line),lines:report.actualLayout!.lines.map(l=>l.text),stage:'FINAL_RASTER',fontSizePx:report.fontSizePx,lineHeight:report.lineHeight,
      shape:style.shape??'ellipse',writingMode:style.writingMode,dialogueType:line.dialogueType,rotationDegrees:style.rotationDegrees??0,measurement:report.measuredFit,
      safety:{safeAreaVerified:interiors.has(line.id),otherRegionCollision:otherRegionCollisionPixels!==0,protectedArtworkCollision:(raster.outsideInteriorPixels??1)!==0},glyphs:{supported:report.productionFontLoaded&&report.glyphFontLoaded,missingGlyphOccurrences:report.glyphEvidence?.missingGlyphOccurrences},
      mapping:{expectedId:line.id,actualId:report.id,expectedOrder:line.order,actualOrder:report.order,...(line.speaker!==undefined?{expectedSpeaker:line.speaker,actualSpeaker:report.speaker}:{})},raster:report.raster});
    if(report.standard.status==='BLOCKED')throw Object.assign(new Error(`MANUAL_LAYOUT_REQUIRED: 영역 ${line.id}의 한국어 식자 필수 규칙을 통과하지 못했습니다.`),{code:'MANUAL_LAYOUT_REQUIRED'});
    if (report.fontSizePx <= 12) report.reviewReasons.push("기존 10px 잠정 하한 근처의 작은 글씨입니다. 사람의 가독성 검토가 필요합니다.");
    // Composite the inspected pixels themselves, rather than re-layout/re-paint.
    context.drawImage(inkCanvas, guard, guard, width, height, 0, 0, width, height);
    recordDiagnostic(line, "renderer-raster");
    } catch (error) {
      const e = error as typeof failures[number]["error"], report = layoutReport.find(r => r.id === line.id);
      if (report) report.fitStatus = "MANUAL_LAYOUT_REQUIRED";
      failures.push({ id: line.id, error: e, stage: "renderer-raster" }); recordDiagnostic(line, "renderer-raster", e);
    }
  }
  throwCollected();
  return { pngBase64: outputCanvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""), width, height, layoutReport };
}

function candidateText(line: DialogueLine): string {
  const text = line.userTranslation !== undefined ? line.userTranslation : (line.aiTranslation ?? "");
  return text.trim() ? text : "";
}

function boxesOverlap(left: NormalizedBbox, right: NormalizedBbox): boolean {
  return Math.min(left.x + left.width, right.x + right.width) > Math.max(left.x, right.x) &&
    Math.min(left.y + left.height, right.y + right.height) > Math.max(left.y, right.y);
}

function paintedInkOverlapsRegions(
  line: DialogueLine, text: string, fit: ReturnType<typeof measureCandidateFit>,
  width: number, height: number, regions: readonly NormalizedBbox[]
): boolean {
  if (!regions.length) return false;
  const style = line.typesetting!;
  const paintLine = { ...line, typesetting: { ...style, fontSizeRatio: fit.layout.fontSizeRatio, strokeWidth: fit.strokeWidthPx } };
  const originX = style.bbox.x * width, originY = style.bbox.y * height;
  // Only paint a small intersection of a protected box and possible ink.
  // A measured envelope can contain a glyph's transparent corners or holes.
  return regions.some(region => fit.inkBounds.some(ink => {
    const left = Math.max(0, Math.ceil(region.x * width - 0.5), Math.floor(originX + ink.left) - 1);
    const top = Math.max(0, Math.ceil(region.y * height - 0.5), Math.floor(originY + ink.top) - 1);
    const right = Math.min(width, Math.floor((region.x + region.width) * width - 0.5) + 1, Math.ceil(originX + ink.right) + 1);
    const bottom = Math.min(height, Math.floor((region.y + region.height) * height - 0.5) + 1, Math.ceil(originY + ink.bottom) + 1);
    if (left >= right || top >= bottom) return false;
    const cropWidth = right - left, cropHeight = bottom - top;
    const { context } = createCanvas(cropWidth, cropHeight);
    context.translate(-left, -top);
    renderTypesettingToCanvas(context, [paintLine], width, height, {
      textResolver: () => text, layoutResolver: () => fit.layout,
    });
    const pixels = context.getImageData(0, 0, cropWidth, cropHeight).data;
    return inspectCandidateInk(pixels, cropWidth, cropHeight).hasInk;
  }));
}

function findSourceInset(interior: CandidateInterior, source: NormalizedBbox, width: number, height: number): NormalizedBbox | undefined {
  // Keep the complete, previously verified component as the erosion mask.
  // Restrict only the permissible placement rectangle to the original ROI.
  const x = Math.max(0, Math.ceil(source.x * width - 1e-9) - interior.left);
  const y = Math.max(0, Math.ceil(source.y * height - 1e-9) - interior.top);
  const right = Math.min(interior.width, Math.floor((source.x + source.width) * width + 1e-9) - interior.left);
  const bottom = Math.min(interior.height, Math.floor((source.y + source.height) * height + 1e-9) - interior.top);
  const boxWidth = right - x, boxHeight = bottom - y;
  if (boxWidth < 10 || boxHeight < 10) return undefined;
  const rectangle = findInteriorRectangle(interior.mask, interior.width, interior.height, { x: x + boxWidth / 2, y: y + boxHeight / 2 },
    { x, y, width: boxWidth, height: boxHeight });
  if (!rectangle) return undefined;
  return { x: (interior.left + rectangle.x) / width, y: (interior.top + rectangle.y) / height,
    width: rectangle.width / width, height: rectangle.height / height };
}

type LayoutPixelBox = Omit<CandidateInterior, "mask">;

function normalizeLayoutBox(box: LayoutPixelBox, width: number, height: number): NormalizedBbox {
  return { x: box.left / width, y: box.top / height, width: box.width / width, height: box.height / height };
}

function verifiedSidePadding(boxWidth: number) {
  const side = Math.min(DEFAULT_SHAPE_PADDING.left, 2 / boxWidth);
  return { ...DEFAULT_SHAPE_PADDING, left: side, right: side };
}

type BandDomain = { padding: number; limits?: LayoutPixelBox };

function measureHonorificWrap(
  context: CanvasRenderingContext2D, line: DialogueLine, text: string, style: DialogueTypesetting,
  width: number, height: number, reference: ReturnType<typeof measureCandidateFit>,
  interior: CandidateInterior, neighbors: readonly NormalizedBbox[], domain?: BandDomain & { interior: CandidateInterior; source: NormalizedBbox },
): { fit: ReturnType<typeof measureCandidateFit>; band?: LayoutPixelBox } | undefined {
  const original = reference.layout.lines.map(row => row.text);
  if (original.length < 2 || /[\r\n]/u.test(text) || !reference.standard?.readability) return undefined;
  const alternatives = honorificWrapAlternatives(text, original);
  const detached = alternatives.length > 0;
  if (!detached) {
    if (!domain || !original.some(containsKoreanAddress)) return undefined;
    alternatives.push(original);
  }
  const penalty = reference.standard.readability.penalty;
  function fitAt(size: number, box: NormalizedBbox, mask: CandidateInterior, excluded: readonly NormalizedBbox[] = neighbors) {
    const sized = { ...style, bbox: box, fontSizeRatio: size / (box.height * height) };
    const padding = verifiedSidePadding(box.width * width);
    for (const softLines of alternatives) {
      const candidate = measureCandidateFit(context, text, sized, width, height, { dialogueType: line.dialogueType, padding, softLines });
      const rows = candidate.layout.lines.map(row => row.text);
      if (candidate.status === "MANUAL_LAYOUT_REQUIRED" || !candidate.standard?.readability || rows.length > original.length ||
          candidate.standard.readability.penalty > penalty || honorificWrapAlternatives(text, rows).length) continue;
      if (paintFitsVerifiedBox(line, text, sized, width, height, candidate, mask) &&
          !paintedInkOverlapsRegions({ ...line, typesetting: sized }, text, candidate, width, height, excluded)) return candidate;
    }
    return undefined;
  }
  const maximum = detached ? reference.fontSizePx : Math.floor(reference.fontSizePx * 1.25);
  const minimum = detached ? Math.max(13, Math.round(reference.fontSizePx * .8)) : reference.fontSizePx + 1;
  // The first/last actual lines may need more room than the suggested soft
  // breaks. Check both block heights at the same optical center and font size.
  const rowCounts = [...new Set([Math.min(...alternatives.map(rows => rows.length)), original.length])];
  for (let size = maximum; size >= minimum; size--) {
    if (detached) {
      const fit = fitAt(size, style.bbox, interior);
      if (fit) return { fit };
    }
    if (!domain) continue;
    for (const count of rowCounts) {
      const halfHeight = Math.ceil((count * size * (style.lineHeight ?? 1.25) + 2 * (reference.strokeWidthPx + 1)) / 2);
      const band = findWiderCenteredBand(domain.interior, style.bbox, width, height, domain.padding, halfHeight, domain.limits);
      if (!band) continue;
      const box = normalizeLayoutBox(band, width, height);
      if (neighbors.some(neighbor => boxesOverlap(box, neighbor))) continue;
      const fit = fitAt(size, box, domain.interior);
      if (fit) return { fit, band };
    }
  }
  if (detached && domain?.limits) {
    for (let size = maximum; size >= minimum; size--) {
      for (const count of rowCounts) {
        const halfHeight = Math.ceil((count * size * (style.lineHeight ?? 1.25) + 2 * (reference.strokeWidthPx + 1)) / 2);
        for (const band of staggeredAddressBands({ ...domain, limits: domain.limits, current: style.bbox, neighbors, width, height, halfHeight })) {
          // Keep the optical center as close as possible to the original
          // column. The shorter row can then stay on its own side of a divider.
          const offset = Math.round((style.bbox.x + style.bbox.width/2)*width - (band.left + band.width/2));
          const maxTrim = Math.min(2*Math.abs(offset), Math.max(0, band.width-Math.ceil(style.bbox.width*width)));
          for (const trim of new Set([maxTrim, Math.round(maxTrim*.75), Math.round(maxTrim*.5), Math.round(maxTrim*.25), 0])) {
            const placement = { left: band.left + (offset>0 ? trim : 0), top: band.top, width: band.width-trim, height: band.height };
            const fit = fitAt(size, normalizeLayoutBox(placement, width, height), domain.interior, [...neighbors, ...band.exclusions]);
            if (fit) return { fit, band: placement };
          }
        }
      }
    }
  }
  return undefined;
}

function measureInVerifiedBox(
  context: CanvasRenderingContext2D, line: DialogueLine, text: string, style: DialogueTypesetting,
  width: number, height: number, reference: ReturnType<typeof measureCandidateFit>,
  mode: "larger" | "larger-with-side-clearance" | "join-short-last-line" = "larger",
): ReturnType<typeof measureCandidateFit> | undefined {
  if (reference.status === "MANUAL_LAYOUT_REQUIRED" || style.fontSizeRatio !== undefined ||
      !isGeneralKorean({ text, ...style, dialogueType: line.dialogueType })) return undefined;
  const boxWidth = style.bbox.width * width, boxHeight = style.bbox.height * height;
  // A rectangle with verified side clearance already excludes its margin.
  // Keep at least the measured stroke inside it during the final ink check.
  const padding = mode === "larger" ? undefined : verifiedSidePadding(boxWidth);
  const join = mode === "join-short-last-line";
  // Use the regular fit's 30% maximum reduction when comparing a single row
  // to an isolated last word. Growth is bounded by the established type size.
  const maxSize = Math.min(Math.floor(boxHeight), Math.floor(reference.fontSizePx * (join ? 1 : 1.5)));
  const minSize = join ? Math.max(13, Math.ceil(reference.fontSizePx * .7)) : reference.fontSizePx + 1;
  for (let size = maxSize; size >= minSize; size--) {
    const sizedStyle = { ...style, fontSizeRatio: size / boxHeight };
    const fit = measureCandidateFit(context, text, sizedStyle, width, height, { dialogueType: line.dialogueType, padding });
    if (fit.status === "MANUAL_LAYOUT_REQUIRED" || fit.layout.lines.length > reference.layout.lines.length ||
        fit.selection.intraWordBreaks > reference.selection.intraWordBreaks) continue;
    if (join) {
      if (fit.layout.lines.length !== 1 || !reference.standard?.readability) continue;
      const score = scoreKoreanReadability({ ...sizedStyle, text, lines: [text], fontSizePx: size, referenceFontSizePx: reference.fontSizePx });
      if (score.score <= 100 - reference.standard.readability.penalty) continue;
    }

    if (paintFitsVerifiedBox(line, text, sizedStyle, width, height, fit)) return fit;
  }
  return undefined;
}

function paintFitsVerifiedBox(
  line: DialogueLine, text: string, style: DialogueTypesetting, width: number, height: number,
  fit: ReturnType<typeof measureCandidateFit>, interior?: CandidateInterior,
): boolean {
  const left = Math.floor(style.bbox.x * width + 1e-9), top = Math.floor(style.bbox.y * height + 1e-9);
  const right = Math.ceil((style.bbox.x + style.bbox.width) * width - 1e-9);
  const bottom = Math.ceil((style.bbox.y + style.bbox.height) * height - 1e-9);
  const guard = Math.ceil(fit.strokeWidthPx + 2);
  const cropWidth = right - left + 2 * guard, cropHeight = bottom - top + 2 * guard;
  const { context: crop } = createCanvas(cropWidth, cropHeight);
  crop.translate(guard - left, guard - top);
  const paintLine = { ...line, typesetting: { ...style, fontSizeRatio: fit.layout.fontSizeRatio, strokeWidth: fit.strokeWidthPx } };
  renderTypesettingToCanvas(crop, [paintLine], width, height, { textResolver: () => text, layoutResolver: () => fit.layout });
  const inspected = inspectCandidateInk(crop.getImageData(0, 0, cropWidth, cropHeight).data, cropWidth, cropHeight,
    interior && { ...interior, left: interior.left - left + guard, top: interior.top - top + guard });
  const ink = inspected.inkBounds;
  return !!ink && !inspected.outsideInteriorPixels && ink.x >= guard && ink.y >= guard &&
    ink.x + ink.width <= cropWidth - guard && ink.y + ink.height <= cropHeight - guard;
}

/** The full-height rectangle in a rounded balloon can be narrower than its
 * waist. For one wide line, verify a shorter band on the same optical center. */
function findWiderSingleLineBox(
  interior: CandidateInterior, bbox: NormalizedBbox, fit: ReturnType<typeof measureCandidateFit>,
  width: number, height: number, margin: number,
): LayoutPixelBox | undefined {
  const [ink] = fit.inkBounds;
  if (!ink || ink.right - ink.left < 2 * (ink.bottom - ink.top)) return undefined;
  return findWiderCenteredBand(interior, bbox, width, height, margin, Math.ceil(Math.max(fit.fontSizePx, ink.bottom - ink.top)));
}

function findWiderCenteredBand(interior: CandidateInterior, bbox: NormalizedBbox, width: number, height: number,
  margin: number, halfHeight: number, limits?: LayoutPixelBox): LayoutPixelBox | undefined {
  const oldLeft = Math.round(bbox.x * width), oldWidth = Math.round(bbox.width * width);
  const oldRight = oldLeft + oldWidth;
  const center = oldLeft + Math.floor(oldWidth / 2);
  const centerY = (bbox.y + bbox.height / 2) * height;
  const top = Math.floor(centerY - halfHeight), bottom = Math.ceil(centerY + halfHeight);
  if (bottom - top >= bbox.height * height || top - margin < interior.top ||
      bottom + margin > interior.top + interior.height || limits && (top < limits.top || bottom > limits.top + limits.height)) return undefined;

  const extension = Math.floor(oldWidth / 4);
  let left = Math.max(interior.left, oldLeft - extension - margin);
  let right = Math.min(interior.left + interior.width, oldRight + extension + margin);
  // Intersect the continuous white span through the center on every row,
  // including the padding of the *whole* component. A hole cuts off the span.
  for (let y = top - margin; y < bottom + margin; y++) {
    const row = (y - interior.top) * interior.width - interior.left;
    if (!interior.mask[row + center]) return undefined;
    let start = center, end = center + 1;
    while (start > left && interior.mask[row + start - 1]) start--;
    while (end < right && interior.mask[row + end]) end++;
    left = start;
    right = end;
  }
  const grow = Math.min(oldLeft - left - margin, right - margin - oldRight,
    limits ? Math.min(oldLeft - limits.left, limits.left + limits.width - oldRight) : Infinity);
  if (grow <= 0) return undefined;
  return { left: oldLeft - grow, top, width: oldWidth + grow * 2, height: bottom - top };
}

/** Grow sideways from a verified band without moving its vertical center. */
function findWiderUniformInset(context: Pick<CanvasRenderingContext2D, "getImageData">, bbox: NormalizedBbox,
  box: LayoutPixelBox, width: number, height: number): NormalizedBbox | undefined {
  const margin = Math.max(2, Math.ceil(box.height * .04));
  const top = box.top - margin, rows = box.height + margin * 2;
  if (top < 0 || top + rows > height) return undefined;
  const extension = Math.floor(box.width / 2);
  const left = Math.max(0, box.left - extension - margin);
  const right = Math.min(width, box.left + box.width + extension + margin);
  const stride = right - left;
  const data = context.getImageData(left, top, stride, rows).data;
  const center = box.left + Math.floor(box.width / 2) - left;
  const anchor = (Math.floor(rows / 2) * stride + center) * 4;
  const uniformColumn = (x: number) => {
    for (let y = 0; y < rows; y++) {
      const at = (y * stride + x) * 4;
      if (data[at + 3]! < 250 || Math.abs(data[at]! - data[anchor]!) > 4 ||
          Math.abs(data[at + 1]! - data[anchor + 1]!) > 4 || Math.abs(data[at + 2]! - data[anchor + 2]!) > 4) return false;
    }
    return true;
  };
  if (!uniformColumn(center)) return undefined;
  let start = center, end = center + 1;
  while (start > 0 && uniformColumn(start - 1)) start--;
  while (end < stride && uniformColumn(end)) end++;
  const expandedLeft = left + start + margin, expandedRight = left + end - margin;
  if (expandedLeft > box.left || expandedRight < box.left + box.width || expandedRight - expandedLeft <= box.width) return undefined;
  return { ...bbox, x: expandedLeft / width, width: (expandedRight - expandedLeft) / width };
}

/** Propose a rectangle in the original OCR box. The caller still checks the original, mask and cleaned pixels. */
export function findUniformSourceInset(context: Pick<CanvasRenderingContext2D, 'getImageData'>, source: NormalizedBbox,
  width: number, height: number): NormalizedBbox | undefined {
  const left = Math.ceil(source.x * width - 1e-9), top = Math.ceil(source.y * height - 1e-9);
  const right = Math.floor((source.x + source.width) * width + 1e-9), bottom = Math.floor((source.y + source.height) * height + 1e-9);
  const sourceWidth = right - left, sourceHeight = bottom - top;
  if (sourceWidth < 10 || sourceHeight < 10) return undefined;
  const margin = Math.max(2, Math.ceil(Math.min(sourceWidth, sourceHeight) * .04));
  const scanLeft = Math.max(0, left - margin), scanTop = Math.max(0, top - margin);
  const scanWidth = Math.min(right + margin, width) - scanLeft;
  const scanHeight = Math.min(bottom + margin, height) - scanTop;
  const anchor = { x: Math.floor((source.x + source.width / 2) * width) - scanLeft,
    y: Math.floor((source.y + source.height / 2) * height) - scanTop };
  const pixels = context.getImageData(scanLeft, scanTop, scanWidth, scanHeight).data;
  const anchorAt = (anchor.y * scanWidth + anchor.x) * 4;
  if (pixels[anchorAt + 3]! < 250) return undefined;
  const bounds = { x: left - scanLeft, y: top - scanTop, width: sourceWidth, height: sourceHeight };
  const mask = new Uint8Array(scanWidth * scanHeight);
  let matchingSourcePixels = 0;
  for (let y = 0; y < scanHeight; y++) for (let x = 0; x < scanWidth; x++) {
    const index = y * scanWidth + x, at = index * 4;
    // Within four steps of the center gives at most the existing eight-step range.
    if (pixels[at + 3]! < 250 || Math.abs(pixels[at]! - pixels[anchorAt]!) > 4 ||
        Math.abs(pixels[at + 1]! - pixels[anchorAt + 1]!) > 4 || Math.abs(pixels[at + 2]! - pixels[anchorAt + 2]!) > 4) continue;
    mask[index] = 1;
    if (x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height) matchingSourcePixels++;
  }
  if (matchingSourcePixels * 2 <= sourceWidth * sourceHeight) return undefined;
  const inset = findInteriorRectangle(mask, scanWidth, scanHeight, anchor, bounds, true);
  return inset && normalizeLayoutBox({ left: scanLeft + inset.x, top: scanTop + inset.y, width: inset.width, height: inset.height }, width, height);
}

function findWiderSharedBox(
  interior: CandidateInterior, source: NormalizedBbox, neighbors: readonly { bbox: NormalizedBbox }[],
  anchor: { x: number; y: number }, width: number, height: number, currentWidth: number
): (LayoutPixelBox & { domain: BandDomain }) | undefined {
  let { left, top } = interior;
  let right = left + interior.width, bottom = top + interior.height;
  const sourceRight = source.x + source.width, sourceBottom = source.y + source.height;
  for (const { bbox: neighbor } of neighbors) {
    const neighborRight = neighbor.x + neighbor.width, neighborBottom = neighbor.y + neighbor.height;
    const apartX = sourceRight < neighbor.x || neighborRight < source.x;
    const apartY = sourceBottom < neighbor.y || neighborBottom < source.y;
    // Both original boxes stay on their own side of the same center of the gap.
    // Overlapping or diagonal boxes do not identify one unambiguous axis.
    if (apartX === apartY) return undefined;
    if (apartX) {
      if (sourceRight < neighbor.x) right = Math.min(right, Math.floor((sourceRight + neighbor.x) * width / 2) - 1);
      else left = Math.max(left, Math.ceil((neighborRight + source.x) * width / 2) + 1);
    } else if (sourceBottom < neighbor.y) {
      bottom = Math.min(bottom, Math.floor((sourceBottom + neighbor.y) * height / 2) - 1);
    } else {
      top = Math.max(top, Math.ceil((neighborBottom + source.y) * height / 2) + 1);
    }
  }
  if (right - left <= currentWidth || bottom - top < 10) return undefined;
  const point = { x: anchor.x - interior.left, y: anchor.y - interior.top };
  const rectangle = findInteriorRectangle(interior.mask, interior.width, interior.height, point,
    { x: left - interior.left, y: top - interior.top, width: right - left, height: bottom - top });
  if (!rectangle || rectangle.width <= currentWidth || point.x < rectangle.x || point.y < rectangle.y ||
      point.x >= rectangle.x + rectangle.width || point.y >= rectangle.y + rectangle.height) return undefined;
  return { left: interior.left + rectangle.x, top: interior.top + rectangle.y, width: rectangle.width, height: rectangle.height,
    domain: { padding: rectangle.padding, limits: { left, top, width: right - left, height: bottom - top } } };
}

function orderedCandidates(ocr: SpeechBubbleExtractionResult): ExtractedSpeechBubble[] {
  validateLineIds(ocr.speechBubbles.map((candidate) => ({ id: candidate.id, order: candidate.readingOrder, pageNumber: 1 })));
  for (const candidate of ocr.speechBubbles) {
    if ((candidate as ExtractedSpeechBubble & { ocrReview?: unknown }).ocrReview || !["speech_bubble", "thought_bubble", "filtered_speech"].includes(candidate.type)) throw new Error(`영역 ${candidate.id}: OCR 검토 또는 자동 식자 제외가 필요합니다.`);
    requireBbox(candidate.bbox, candidate.id);
    if (typeof candidate.text !== "string" || !candidate.text.trim()) throw new Error(`영역 ${candidate.id}: OCR 원문이 비어 있습니다.`);
  }
  return [...ocr.speechBubbles].sort((left, right) => left.readingOrder - right.readingOrder);
}

function validateLineIds(lines: readonly Pick<DialogueLine, "id" | "order" | "pageNumber">[]): void {
  const ids = new Set<string>(), orders = new Set<string>();
  for (const line of lines) {
    if (typeof line.id !== "string" || !line.id.trim() || ids.has(line.id)) throw new Error("영역 ID가 비어 있거나 중복되었습니다.");
    const orderKey = `${line.pageNumber}:${line.order}`;
    if (!Number.isInteger(line.pageNumber) || line.pageNumber < 1 || !Number.isInteger(line.order) || line.order < 1 || orders.has(orderKey)) {
      throw new Error("페이지 또는 읽기 순서가 올바르지 않거나 중복되었습니다.");
    }
    ids.add(line.id);
    orders.add(orderKey);
  }
}

function requireBbox(bbox: NormalizedBbox | undefined, id: string): asserts bbox is NormalizedBbox {
  if (!bbox || ![bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite) || bbox.x < 0 || bbox.y < 0 ||
      bbox.width <= 0 || bbox.height <= 0 || bbox.x + bbox.width > 1 + 1e-9 || bbox.y + bbox.height > 1 + 1e-9) {
    throw new Error(`영역 ${id}: 실제 정규화 bbox가 필요합니다.`);
  }
}

function polygonBounds(polygon: readonly PolygonPoint[]): NormalizedBbox {
  if (polygon.length < 3 || polygon.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new Error("실제 polygon 좌표가 올바르지 않습니다.");
  const xs = polygon.map((point) => point.x), ys = polygon.map((point) => point.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  const width = Math.max(...xs) - x, height = Math.max(...ys) - y;
  if (width <= 0 || height <= 0) throw new Error("실제 polygon 면적이 없습니다.");
  return { x, y, width, height };
}

function validateDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error("이미지 크기가 올바르지 않습니다.");
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("브라우저 2D Canvas를 사용할 수 없습니다.");
  return { canvas, context };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    const timeout = setTimeout(() => finish(new Error("후보 이미지 로드 시간이 초과되었습니다.")), 15000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      image.onload = image.onerror = null;
      if (error) reject(error); else resolve(image);
    };
    image.onload = () => finish();
    image.onerror = () => finish(new Error("후보 이미지를 불러오지 못했습니다."));
    image.src = url;
  });
}

/** 닫힌 흰 영역만 추정한다. 실패·모호성은 원래 bbox와 검토 사유로 남긴다. */
export function inferCandidateBox(
  context: CanvasRenderingContext2D, line: DialogueLine,
  sourceBoxes: readonly { id: string; bbox: NormalizedBbox }[], width: number, height: number, allowedBbox?:NormalizedBbox,
  sharedLayout?: { protectedBoxes: readonly NormalizedBbox[] }
): { bbox: DialogueTypesetting["bbox"]; expanded: boolean; reasons: string[]; interior?: CandidateInterior;
     nonWhiteAnchor?: true; widerSharedBox?: ReturnType<typeof findWiderSharedBox>; singleBalloonPadding?: number } {
  const source = line.typesetting!.bbox;
  const retain = (reason: string) => ({ bbox: { ...source }, expanded: false, reasons: [reason] });
  if(allowedBbox&&(!['x','y','width','height'].every(k=>Number.isFinite(allowedBbox[k as keyof NormalizedBbox]))||allowedBbox.x<0||allowedBbox.y<0||allowedBbox.width<=0||allowedBbox.height<=0||allowedBbox.x+allowedBbox.width>1+1e-12||allowedBbox.y+allowedBbox.height>1+1e-12||!inside(source,allowedBbox)))return retain('허용 ROI가 원문 영역과 일치하지 않아 안전 배치를 보류했습니다.');
  if (line.userTranslation !== undefined || line.ocrUserOwnedFields?.includes("geometry") || line.typesetting?.fontSizeRatio !== undefined || line.typesetting?.rotationDegrees || line.typesetting?.writingMode === "vertical-rl") return retain("사용자 소유 또는 회전·세로쓰기 배치의 실제 bbox를 유지했습니다.");
  const center = (bbox: NormalizedBbox) => ({ x: Math.min(width - 1, Math.floor((bbox.x + bbox.width / 2) * width)), y: Math.min(height - 1, Math.floor((bbox.y + bbox.height / 2) * height)) });
  const anchor = center(source);
  // A tiny OCR text box does not bound a large balloon. Search a bounded page
  // neighborhood, retaining the SAME closure/other-center/expansion guards.
  const halfWidth = Math.ceil(Math.max(source.width * width * 2, Math.min(width, height) * 0.5));
  const halfHeight = Math.ceil(Math.max(source.height * height * 2, Math.min(width, height) * 0.5));
  const left = Math.max(0, anchor.x - halfWidth), top = Math.max(0, anchor.y - halfHeight);
  const right = Math.min(width, anchor.x + halfWidth + 1), bottom = Math.min(height, anchor.y + halfHeight + 1);
  const roiWidth = right - left, roiHeight = bottom - top;
  const pixels = context.getImageData(left, top, roiWidth, roiHeight).data;
  const white = (index: number) => pixels[index * 4 + 3]! >= 250 && Math.min(pixels[index * 4]!, pixels[index * 4 + 1]!, pixels[index * 4 + 2]!) >= 240;
  const start = (anchor.y - top) * roiWidth + anchor.x - left;
  if (!white(start)) return { ...retain("원문 중심이 흰 영역이 아니므로 실제 bbox를 유지했습니다."), nonWhiteAnchor: true };
  const seen = new Uint8Array(roiWidth * roiHeight), queue = new Int32Array(seen.length);
  let head = 0, tail = 1;
  const pageEdges = new Set<string>();
  queue[0] = start;
  seen[start] = 1;
  while (head < tail) {
    const index = queue[head++]!, x = index % roiWidth, y = Math.floor(index / roiWidth);
    if ((x === 0 && left > 0) || (y === 0 && top > 0) ||
        (x === roiWidth - 1 && right < width) || (y === roiHeight - 1 && bottom < height)) {
      return retain("흰 영역이 탐색 경계에 닿아 안전한 내부 확인을 보류했습니다.");
    }
    if (x === 0 && left === 0) pageEdges.add("left");
    if (y === 0 && top === 0) pageEdges.add("top");
    if (x === roiWidth - 1 && right === width) pageEdges.add("right");
    if (y === roiHeight - 1 && bottom === height) pageEdges.add("bottom");
    if (pageEdges.size > 2) return retain("흰 영역이 여러 페이지 경계로 이어져 말풍선 내부인지 확인하지 못했습니다.");
    const neighbors = [];
    if (x > 0) neighbors.push(index - 1);
    if (x + 1 < roiWidth) neighbors.push(index + 1);
    if (y > 0) neighbors.push(index - roiWidth);
    if (y + 1 < roiHeight) neighbors.push(index + roiWidth);
    for (const next of neighbors) {
      if (!seen[next] && white(next)) { seen[next] = 1; queue[tail++] = next; }
    }
  }
  const shared = sourceBoxes.filter(other => {
    if (other.id === line.id) return false;
    const point = center(other.bbox);
    return point.x >= left && point.x < right && point.y >= top && point.y < bottom && seen[(point.y - top) * roiWidth + point.x - left];
  });
  if (shared.length) {
    const overlaps = sourceBoxes.some(other => other.id !== line.id && boxesOverlap(source, other.bbox));
    const x = Math.floor(source.x * width), y = Math.floor(source.y * height);
    const fixed = { x: x - left, y: y - top,
      width: Math.ceil((source.x + source.width) * width) - x,
      height: Math.ceil((source.y + source.height) * height) - y };
    if (overlaps) return retain("공유 말풍선의 원문 ROI가 다른 원문과 겹쳐 배치를 보류했습니다.");
    let bbox = { ...source };
    let reason = "공유 말풍선의 닫힌 흰 영역에서 원래 bbox와 여백 전체를 확인했습니다. 다른 원문 영역으로 확장하지 않았습니다. 시각 검토가 필요합니다.";
    if (!isInsetInteriorRectangle(seen, roiWidth, roiHeight, fixed)) {
      const x0 = Math.ceil(source.x * width), y0 = Math.ceil(source.y * height);
      const bounds = { x: x0 - left, y: y0 - top,
        width: Math.floor((source.x + source.width) * width) - x0,
        height: Math.floor((source.y + source.height) * height) - y0 };
      const inset = bounds.width >= 10 && bounds.height >= 10
        ? findInteriorRectangle(seen, roiWidth, roiHeight, { x: anchor.x - left, y: anchor.y - top }, bounds) : undefined;
      if (!inset) return retain("공유 말풍선의 원문 ROI 안에서 안전 여백이 있는 식자 공간을 확보하지 못했습니다.");
      bbox = normalizeLayoutBox({ ...inset, left: left + inset.x, top: top + inset.y }, width, height);
      reason = "공유 말풍선의 원문 ROI 안에서만 더 작은 닫힌 흰색 내부를 찾았습니다. 전체 성분의 안전 여백과 다른 원문 보호를 유지합니다.";
    }
    const interior = { mask: seen, left, top, width: roiWidth, height: roiHeight };
    if (sharedLayout && !allowedBbox && pageEdges.size === 0) {
      const wider = findWiderSharedBox(interior, source, shared, anchor, width, height, bbox.width * width);
      if (wider) {
        const alternative = normalizeLayoutBox(wider, width, height);
        const conflicts = sourceBoxes.some(other => other.id !== line.id && boxesOverlap(alternative, other.bbox)) ||
          sharedLayout.protectedBoxes.some(protectedBox => boxesOverlap(alternative, protectedBox));
        if (!conflicts) return { bbox, expanded: false, reasons: [reason], interior, widerSharedBox: wider };
      }
    }
    return { bbox, expanded: false, reasons: [reason], interior };
  }
  // Prove closure/padding on the complete component ABOVE. Restrict only the
  // placement search, so a small allowed ROI cannot hide an open boundary or
  // reduce the component's erosion margin.
  let placementBounds:{x:number;y:number;width:number;height:number}|undefined;
  if(allowedBbox){const x=Math.max(left,Math.ceil(allowedBbox.x*width-1e-9)),y=Math.max(top,Math.ceil(allowedBbox.y*height-1e-9)),r=Math.min(right,Math.floor((allowedBbox.x+allowedBbox.width)*width+1e-9)),b=Math.min(bottom,Math.floor((allowedBbox.y+allowedBbox.height)*height+1e-9));placementBounds={x:x-left,y:y-top,width:r-x,height:b-y};if(placementBounds.width<10||placementBounds.height<10)return retain('허용 ROI 안에서 안전 여백이 있는 식자 공간을 확보하지 못했습니다.');}
  const rectangle = findInteriorRectangle(seen, roiWidth, roiHeight, { x: anchor.x - left, y: anchor.y - top },placementBounds);
  if (!rectangle) return retain("닫힌 흰 영역 안에 식자할 공간을 확보하지 못했습니다.");
  const bbox = { x: (left + rectangle.x) / width, y: (top + rectangle.y) / height, width: rectangle.width / width, height: rectangle.height / height };
  if (!isSupportedCandidateExpansion(source, bbox)) {
    // An OCR envelope may include a balloon's dark border. Failure to EXPAND
    // does not invalidate a smaller, fully inset rectangle in that same closed
    // component. Keep every pixel inside the original ROI and retain full-size
    // component padding; the normal font/text/raster gates still decide fit.
    const overlaps = sourceBoxes.some(other => other.id !== line.id &&
      Math.min(source.x + source.width, other.bbox.x + other.bbox.width) > Math.max(source.x, other.bbox.x) &&
      Math.min(source.y + source.height, other.bbox.y + other.bbox.height) > Math.max(source.y, other.bbox.y));
    const x = Math.ceil(source.x * width), y = Math.ceil(source.y * height);
    const bounds = { x: x - left, y: y - top,
      width: Math.floor((source.x + source.width) * width) - x,
      height: Math.floor((source.y + source.height) * height) - y };
    if (overlaps || bounds.width < 10 || bounds.height < 10) return retain("원문 ROI 안에서 다른 대사를 침범하지 않는 식자 공간을 확인하지 못했습니다.");
    const inset = findInteriorRectangle(seen, roiWidth, roiHeight, { x: anchor.x - left, y: anchor.y - top }, bounds);
    if (!inset) return retain("닫힌 흰 영역과 원문 ROI 안에서 안전 여백이 있는 식자 공간을 확보하지 못했습니다.");
    return { bbox: { x: (left + inset.x) / width, y: (top + inset.y) / height, width: inset.width / width, height: inset.height / height },
      expanded: false, reasons: ["원문 ROI 안의 닫힌 흰색 사각형에 같은 안전 여백을 두고 배치했습니다. 글자 크기·완전성·잉크 검증과 시각 검토가 필요합니다."],
      interior: { mask: seen, left, top, width: roiWidth, height: roiHeight },
      singleBalloonPadding: pageEdges.size === 0 ? inset.padding : undefined };
  }
  return { bbox, expanded: true, reasons: [pageEdges.size ? "페이지에서 잘린 말풍선의 보이는 내부에 여백을 두고 배치했습니다. 시각 검토가 필요합니다." : "실제 말풍선 내부에 들어가는 여백 영역으로 후보를 배치했습니다. 시각 검토가 필요합니다."],
    interior: { mask: seen, left, top, width: roiWidth, height: roiHeight },
    singleBalloonPadding: pageEdges.size === 0 ? rectangle.padding : undefined };
}
