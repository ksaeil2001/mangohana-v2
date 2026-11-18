import type { DialogueLine, SourceLanguage } from "../../src/shared/projectTypes.js";
import type { SpeechBubbleExtractionResult } from "../../src/shared/speechBubbleExtraction.js";
import { draftLines, createRemovalMask, renderCandidate, validateCandidateSourceSnapshot } from "../local-preview/renderer.js";

let activeJobId: string | undefined;
let preparedIds: string[] = [];
let generation = 0;
let preparedLines: DialogueLine[] = [];
let preparedIdentity: SourceMaskIdentity | undefined;
let protectedBoxes: SpeechBubbleExtractionResult["nonSpeechText"][number]["bbox"][] = [];
let rendering = false;
type SourceMaskIdentity = Readonly<{ version: 1; jobId: string; pageNumber: number; sourceImageSha256: string;
  ocrSha256: string; coordinateSpace: "normalized-page-pixels"; width: number; height: number }>;

/** 경로·IPC·파일 접근 없이 기존 후보 전용 textResolver를 재사용한다. */
export async function prepare(input: {
  jobId: string; ocr: SpeechBubbleExtractionResult; width: number; height: number;
  sourcePngBase64: string; sourceLanguage: "auto" | "ja" | "en";
  maskIdentity: SourceMaskIdentity;
}) {
  if (activeJobId || !input.jobId) throw new Error("후보 작업 ID가 올바르지 않습니다.");
  if (!["auto", "ja", "en"].includes(input.sourceLanguage)) throw new Error("지원하지 않는 원문 언어입니다.");
  if (typeof input.sourcePngBase64 !== "string" || !input.sourcePngBase64.trim()) throw new Error("원본 PNG가 필요합니다.");
  const identity = input.maskIdentity;
  if (!identity || identity.version !== 1 || identity.jobId !== input.jobId || identity.pageNumber !== input.ocr.pageNumber ||
      identity.width !== input.width || identity.height !== input.height || identity.coordinateSpace !== "normalized-page-pixels" ||
      !/^[a-f0-9]{64}$/.test(identity.sourceImageSha256) || !/^[a-f0-9]{64}$/.test(identity.ocrSha256)) throw new Error("제거 마스크의 원본·OCR 세대가 올바르지 않습니다.");
  const maskIdentity = structuredClone(identity);
  const lines = draftLines(input.ocr);
  if (!lines.length) throw new Error("인식된 원문 영역이 없습니다.");
  if (input.sourceLanguage !== "auto") {
    for (const line of lines) line.sourceLanguage = input.sourceLanguage as SourceLanguage;
  }
  const jobId = input.jobId, preparingGeneration = ++generation;
  // 원본 decode가 지연되어도 다른 prepare가 이 작업을 덮지 못한다.
  activeJobId = jobId;
  preparedIds = [];
  preparedLines = [];
  preparedIdentity = undefined;
  try {
    const mask = await createRemovalMask(input.ocr, input.width, input.height, `data:image/png;base64,${input.sourcePngBase64}`);
    if (jobId !== activeJobId || preparingGeneration !== generation) throw new Error("이전 후보 작업의 결과입니다.");
    preparedIds = lines.map((line) => line.id);
    preparedLines = structuredClone(lines);
    preparedIdentity = maskIdentity;
    protectedBoxes = input.ocr.nonSpeechText.map(r => ({ ...r.bbox }));
    return { jobId, lines, mask: { ...mask, identity: maskIdentity } };
  } catch (error) {
    if (jobId === activeJobId && preparingGeneration === generation) {
      activeJobId = undefined;
      preparedIds = [];
    }
    throw error;
  }
}

export type CandidateTypesettingIdentity = SourceMaskIdentity & { version: 1; contract: "stage12-input-v1";
  sourceSha256: string; cleanedImageSha256: string; maskSha256: string; translationInputFingerprint: string;
  mode: "unreviewed_candidate"; maskReview: "candidate_validated_not_human_approved" };

export async function render(input: { jobId: string; cleanedPngBase64: string; lines: DialogueLine[]; typesettingIdentity: CandidateTypesettingIdentity; backgroundContext?: NonNullable<Parameters<typeof renderCandidate>[2]>['backgroundContext']; returnStructuredFailure?:boolean }) {
  if (!input.jobId || input.jobId !== activeJobId || !preparedIds.length || input.lines.length !== preparedIds.length ||
      input.lines.some((line, index) => line.id !== preparedIds[index] || line.ocrEditStatus !== "ai_proposed" ||
        line.userTranslation !== undefined || !line.aiTranslation?.trim())) {
    throw new Error("후보 작업 또는 영역 ID·검토 소유권이 변경되었습니다.");
  }
  if (rendering || !preparedIdentity) throw new Error("이전 식자 작업이 진행 중이거나 준비 identity가 없습니다.");
  validateCandidateSourceSnapshot(input.lines, preparedLines);
  const identity = structuredClone(input.typesettingIdentity);
  if (!identity || identity.contract !== "stage12-input-v1" || identity.mode !== "unreviewed_candidate" || identity.maskReview !== "candidate_validated_not_human_approved" ||
      Object.keys(preparedIdentity).some(key => identity[key as keyof SourceMaskIdentity] !== preparedIdentity![key as keyof SourceMaskIdentity]) ||
      ![identity.sourceSha256, identity.cleanedImageSha256, identity.maskSha256, identity.translationInputFingerprint].every(v => /^[a-f0-9]{64}$/.test(v))) throw new Error("식자 원본·cleaned·마스크·번역 revision 결속이 유효하지 않습니다.");
  const jobId = activeJobId, renderingGeneration = generation;
  rendering = true;
  try {
    if(input.backgroundContext&&(input.backgroundContext.sourceSha256!==identity.sourceImageSha256||input.backgroundContext.cleanedSha256!==identity.cleanedImageSha256||input.backgroundContext.maskSha256!==identity.maskSha256))throw Error('배경 검증 원본·복원·마스크 지문이 다릅니다.');
    const result = await renderCandidate(`data:image/png;base64,${input.cleanedPngBase64}`, input.lines, { expectedDimensions: preparedIdentity, protectedBoxes, backgroundContext:input.backgroundContext });
    if (jobId !== activeJobId || renderingGeneration !== generation) throw new Error("이전 후보 작업의 결과입니다.");
    return { ...result, jobId, typesettingIdentity: identity };
  } catch(error) {
    if(!input.returnStructuredFailure)throw error;
    const e=error as Error & {code?:string;layoutDiagnostics?:unknown},code=e.code??(e.message.startsWith('MANUAL_LAYOUT_REQUIRED:')?'MANUAL_LAYOUT_REQUIRED':e.message.startsWith('FONT_OR_GLYPH_ERROR:')?'FONT_OR_GLYPH_ERROR':'IMAGE_WORKER_FAILED');
    return {jobId,failure:{code,message:e.message.slice(0,1000),stack:e.stack?.slice(0,16384)??null,layoutDiagnostics:e.layoutDiagnostics??null}};
  } finally { if (renderingGeneration === generation) rendering = false; }
}

export function invalidate() { generation++; activeJobId = undefined; preparedIds = []; preparedLines = []; preparedIdentity = undefined; protectedBoxes = []; rendering = false; }

// Vite library IIFE의 name과 무관하게 엔진이 사용하는 고정 API다.
if (typeof window !== "undefined") {
  Object.assign(window, { SitesCandidate: Object.freeze({ prepare, render, invalidate }) });
}
