/**
 * YSB Translator Tool 방식 한국어 형태소/조사·어미 결합도 인식 및 줄바꿈 후보 평가기 (Candidate Evaluator)
 * W3C KLReq 조판 표준 규칙과 연동되어 자연스러운 한국어 식자 레이아웃을 생성합니다.
 */

import {
  canBreakBetweenChars,
} from "./typesettingKlreq.js";
import { requiresSingleUtteranceLine } from "../../../../quality/korean-utterance.cjs";
import { breakGeneralKorean, isGeneralKorean } from "../../../../quality/korean-typesetting-standard.cjs";

// 주요 한국어 조사 패턴
const PARTICLES = new Set([
  "은", "는", "이", "가", "을", "를", "에", "에서", "에게", "한테", "께", "으로", "로",
  "와", "과", "도", "만", "까지", "부터", "마저", "조차", "보다", "처럼", "같이", "요",
  "네", "랑", "이랑", "야", "아", "의", "께서는", "에게서", "한테서", "보고", "대로", "만큼"
]);

// 주요 한국어 연결/종결 어미 패턴
const ENDINGS = new Set([
  "고", "며", "면", "서", "어서", "아서", "여서", "려고", "으려고", "는데", "은데", "ㄴ데",
  "지만", "거나", "도록", "자", "자마자", "니까", "으니까", "잖아", "거든", "네요", "군요",
  "구나", "텐데", "을텐데", "ㄹ텐데", "지요", "죠", "라면", "더라", "더군", "을까", "ㄹ까",
  "을래", "ㄹ래", "는다", "ㄴ다", "었다", "았다", "였다", "습니다", "ㅂ니다", "데요", "을게", "ㄹ게"
]);

/**
 * 주어진 어절(word) 내에서 분절이 불가피할 때 조사/어미를 보존하는 최적 분할 지점을 탐색합니다.
 */
export function findBestSubwordBreak(word: string): number {
  if (word.length <= 2) return -1;

  let bestIndex = -1;
  let minPenalty = 999;

  // 뒤에서부터 1~3글자 조사/어미 매칭
  for (const { index: i } of new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(word)) {
    if (!i) continue;
    const prefix = word.slice(0, i);
    const suffix = word.slice(i);
    const leftChar = prefix[prefix.length - 1]!;
    const rightChar = suffix[0]!;

    if (!canBreakBetweenChars(leftChar, rightChar)) {
      continue;
    }

    let penalty = 20;

    // 조사나 어미 바로 앞에서 자르면 높은 패널티 (예: "밥" | "을" -> 50)
    if (PARTICLES.has(suffix) || ENDINGS.has(suffix)) {
      penalty += 40;
    }

    // 외톨이 글자(1글자만 분리) 패널티
    if (prefix.length === 1 || suffix.length === 1) {
      penalty += 30;
    }

    if (penalty < minPenalty) {
      minPenalty = penalty;
      bestIndex = i;
    }
  }

  return bestIndex;
}

export type CandidateEvaluationOptions = {
  preserveEojeol?: boolean;
  estimateWidth: (text: string) => number;
  getAvailableWidth: (lineIndex: number, lineCount: number) => number;
  maxLines?: number;
};

/**
 * YSB Translator Tool 알고리즘: 여러 줄바꿈 후보를 생성하고 조사/어미 결합도, 외톨이 글자 방지,
 * KLReq 금칙, 말풍선 Span 균형을 종합 평가하여 최적의 줄바꿈 배열을 반환합니다.
 */
export function evaluateAndBreakKoreanText(
  text: string,
  options: CandidateEvaluationOptions
): string[] {
  if (!text.trim()) return [];
  if (options.preserveEojeol !== false && isGeneralKorean({text})) return breakGeneralKorean(text, options);
  // Let actual font/box/pixel checks refuse an overlong utterance. Splitting
  // its syllables or detaching punctuation is never a substitute for fitting.
  if (requiresSingleUtteranceLine(text)) return [text];
  // Keep original graphemes. No normalization, summarization or truncation.
  const clusters = [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(text.replace(/\r\n?/g, "\n"))].map(s => s.segment);
  const { estimateWidth, getAvailableWidth, maxLines = 8 } = options;
  const lines: string[] = [];
  const whitespace = (s: string) => /^[ \t]+$/.test(s);
  const widest = Math.max(0, ...Array.from({ length: Math.max(1, Math.min(64, maxLines)) }, (_, i) => getAvailableWidth(i, maxLines)));
  const wordWidths = new Map<string, number>();
  const legal = (at: number) => {
    if (at >= clusters.length || clusters[at] === "\n") return true;
    const left = clusters[at - 1]!, right = clusters[at]!;
    if (left === "\n" || whitespace(left) || whitespace(right)) {
      const a = clusters.slice(0, at).join("").trimEnd().slice(-1);
      const b = clusters.slice(at).join("").trimStart()[0] ?? "";
      return canBreakBetweenChars(a, b);
    }
    // Long Latin names and numeric units overflow rather than lose characters.
    if (/[A-Za-z0-9]/.test(left) && /[A-Za-z0-9]/.test(right)) return false;
    if (/[0-9]/.test(left) && /[가-힣]/.test(right)) return false;
    let begin = at - 1, end = at;
    while (begin > 0 && !/\s/.test(clusters[begin - 1]!)) begin--;
    while (end < clusters.length && !/\s/.test(clusters[end]!)) end++;
    const suffix = clusters.slice(at, end).join("");
    if (/[A-Za-z]/.test(left) && (PARTICLES.has(suffix) || ENDINGS.has(suffix))) return false;
    const word = clusters.slice(begin, end).join("");
    if (!wordWidths.has(word)) wordWidths.set(word, estimateWidth(word));
    // Keep an ordinary eojeol intact when it can occupy a whole line. Only an
    // indivisible overlong Korean token needs syllable-boundary fragmentation.
    if (wordWidths.get(word)! <= widest + 1e-9) return false;
    return canBreakBetweenChars(left, right);
  };
  let begin = 0;
  while (begin < clusters.length) {
    if (clusters[begin] === "\n") { lines.push(""); begin++; continue; }
    const hardEnd = clusters.indexOf("\n", begin);
    const end = hardEnd < 0 ? clusters.length : hardEnd;
    const available = Math.max(0, getAvailableWidth(lines.length, Math.max(1, Math.min(maxLines, lines.length + 1))));
    let chosen = -1, bestPenalty = Infinity, firstLegal = -1;
    for (let at = begin + 1; at <= end; at++) {
      if (!legal(at) && at !== end) continue;
      if (firstLegal < 0) firstLegal = at;
      const candidate = clusters.slice(begin, at).join("").trimEnd();
      if (!candidate) continue;
      const measured = estimateWidth(candidate);
      if (measured > available + 1e-9) continue;
      const wordEnd = at === end || whitespace(clusters[at] ?? "");
      const suffix = clusters.slice(at, end).join("").trim();
      const penalty = Math.pow(1 - measured / Math.max(1e-9, available), 2) * 30
        + (wordEnd ? 0 : 9)
        + (PARTICLES.has(suffix) || ENDINGS.has(suffix) ? 40 : 0)
        + (at - begin === 1 && at < end ? 20 : 0)
        + ([...suffix].length === 1 ? 20 : 0);
      if (penalty <= bestPenalty) { chosen = at; bestPenalty = penalty; }
    }
    // No legal fragment fits: report the indivisible fragment to the fit gate.
    // maxLines never authorizes truncation.
    if (chosen < 0) chosen = firstLegal < 0 ? end : firstLegal;
    lines.push(clusters.slice(begin, chosen).join("").trimEnd());
    begin = chosen;
    while (begin < end && whitespace(clusters[begin]!)) begin++;
    if (begin === end && hardEnd >= 0) begin++;
  }
  return lines;
}
