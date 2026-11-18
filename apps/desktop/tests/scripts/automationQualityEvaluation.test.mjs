// @vitest-environment node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { characterErrors, evaluateAutomationQuality, stages, validateCorpus } from "../../scripts/evaluate-automation-quality.mjs";

// 모든 데이터와 검토 기록은 합성 fixture다. actual_product/verified를 설정하는
// 테스트도 평가 조건에 대한 가짜 주장이며 실제 제품 실행이나 인간 검토의 근거가 아니다.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XfoAAAAAASUVORK5CYII=", "base64");
const review = { status: "verified", reviewer: "fixture-not-a-human-review", reviewedAt: "2026-01-01T00:00:00.000Z" };
const box = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const pinCorpus = (corpus, run) => { run.corpusSha256 = digest(JSON.stringify(corpus)); };
let directory;

async function asset(name, bytes) {
  await writeFile(join(directory, name), bytes);
  return { path: name, sha256: digest(bytes) };
}

async function ocrAsset(name, speechBubbles, runId, sourceSha256) {
  const ocr = await asset(name, JSON.stringify({ speechBubbles }));
  ocr.provenance = await asset(`${name}.provenance.json`, JSON.stringify({ runId, sourceSha256, ocrSha256: ocr.sha256 }));
  return ocr;
}

async function fixture(pageCount = 1) {
  const corpus = { schemaVersion: 1, datasetId: "synthetic-fixture-no-human-review", pages: [] };
  const run = {
    schemaVersion: 1, runId: "synthetic-fixture-no-model-run", codeIdentity: "fixture:no-product-execution",
    models: { ocr: "fixture-only" }, pages: []
  };
  for (let index = 1; index <= pageCount; index++) {
    corpus.pages.push({
      id: `page-${index}`, split: "dev", workId: `fixture-work-${index}`, duplicateGroupId: `fixture-duplicates-${index}`,
      usedForDevelopment: true,
      source: await asset(`source-${index}.data`, Buffer.from(`synthetic source bytes ${index}`)),
      groundTruth: { ...review, regions: [{ id: "region-1", bbox: { ...box }, text: "AB", translation: "합성 번역", order: 1 }] }
    });
    const finalImage = await asset(`final-${index}.png`, png);
    run.pages.push({
      pageId: `page-${index}`, evidenceKind: "fixture", stages: Object.fromEntries(stages.map(stage => [stage, "completed"])),
      durationMs: null, peakWorkingSetBytes: null, manualEdits: 0, automaticRetries: 0,
      ocr: await ocrAsset(`ocr-${index}.json`, [{ bbox: { ...box }, text: "AB", readingOrder: 1 }], run.runId, corpus.pages[index - 1].source.sha256),
      finalImage, savedAndReopened: true,
      qualityReview: {
        ...review, runId: run.runId, sourceSha256: corpus.pages[index - 1].source.sha256, finalImageSha256: finalImage.sha256,
        meaning: "pass", omissionsAndDuplicates: "pass", sourceTextRemoval: "pass",
        artworkPreservation: "pass", typesettingReadability: "pass"
      }
    });
  }
  pinCorpus(corpus, run);
  return { corpus, run };
}

async function setOcr(corpus, run, speechBubbles) {
  run.pages[0].ocr = await ocrAsset("custom-ocr.json", speechBubbles, run.runId, corpus.pages[0].source.sha256);
}

describe("automation quality evaluator (synthetic fixtures only)", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "trio-automation-quality-fixture-"));
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network access is forbidden in evaluator fixtures"); }));
  });

  afterEach(async () => {
    try {
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("trio-automation-quality-fixture-")) {
        throw new Error("Refusing to remove a directory outside the isolated fixture tempdir");
      }
      await rm(target, { recursive: true, force: true });
    }
  });

  it("accepts a synthetic positive control for the product-attestation gates", async () => {
    const { corpus, run } = await fixture();
    run.pages[0].evidenceKind = "actual_product";

    expect(validateCorpus(corpus)).toBe(corpus);
    const report = await evaluateAutomationQuality(corpus, run, directory);

    expect(report.pages[0]).toMatchObject({ automaticSuccess: true, quality: "PASS", ocr: { characterErrors: 0 } });
    expect(report.summary.dev).toMatchObject({ pages: 1, automaticSuccesses: 1, automaticSuccessRate: 1 });
  });

  it("does not qualify pending ground truth even when the claimed product run is otherwise complete", async () => {
    const { corpus, run } = await fixture();
    run.pages[0].evidenceKind = "actual_product";
    corpus.pages[0].groundTruth = { status: "pending" };
    pinCorpus(corpus, run);

    const report = await evaluateAutomationQuality(corpus, run, directory);

    expect(report.pages[0]).toMatchObject({ automaticSuccess: false, ocr: null });
    expect(report.groundTruthPending).toBe(1);
    expect(report.summary.dev.automaticSuccesses).toBe(0);
  });

  it("does not qualify pending human quality even when all supplied check values say pass", async () => {
    const { corpus, run } = await fixture();
    run.pages[0].evidenceKind = "actual_product";
    run.pages[0].qualityReview.status = "pending";

    const report = await evaluateAutomationQuality(corpus, run, directory);

    expect(report.pages[0]).toMatchObject({ automaticSuccess: false, quality: "PENDING" });
    expect(report.summary.dev).toMatchObject({ automaticSuccesses: 0, humanQualityPending: 1 });
  });

  it("keeps reviews for another run, source, or final image pending instead of reusing their pass", async () => {
    for (const field of ["runId", "sourceSha256", "finalImageSha256"]) {
      const { corpus, run } = await fixture();
      run.pages[0].evidenceKind = "actual_product";
      run.pages[0].qualityReview[field] = field === "runId" ? "another-fixture-run" : digest(`another-fixture-${field}`);

      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0], field).toMatchObject({ automaticSuccess: false, quality: "PENDING" });
      expect(report.summary.dev).toMatchObject({ automaticSuccesses: 0, humanQualityPending: 1 });
    }
  });

  it("rejects holdout pages already used for development", async () => {
    const { corpus } = await fixture();
    corpus.pages[0].split = "holdout";

    expect(() => validateCorpus(corpus)).toThrow("HOLDOUT_ALREADY_USED_FOR_DEVELOPMENT");
  });

  it("rejects cross-split leakage through work, source digest, or duplicate group independently", async () => {
    for (const identity of ["workId", "source", "duplicateGroupId"]) {
      const { corpus } = await fixture(2);
      const [dev, holdout] = corpus.pages;
      holdout.split = "holdout";
      holdout.usedForDevelopment = false;
      expect(() => validateCorpus(corpus)).not.toThrow();
      holdout[identity] = structuredClone(dev[identity]);

      expect(() => validateCorpus(corpus), identity).toThrow("SPLIT_LEAKAGE:");
    }
  });

  it("rejects a corpus changed after the run digest was pinned", async () => {
    const { corpus, run } = await fixture();
    corpus.pages[0].groundTruth.regions[0].text = "changed reference";

    await expect(evaluateAutomationQuality(corpus, run, directory)).rejects.toThrow("CORPUS_NOT_FROZEN_FOR_RUN");
  });

  it("rejects source, final PNG, and still-parseable OCR byte tampering independently", async () => {
    for (const kind of ["source", "finalImage", "ocr"]) {
      const { corpus, run } = await fixture();
      const pin = kind === "source" ? corpus.pages[0].source : run.pages[0][kind];
      const changed = kind === "source" ? Buffer.from("changed synthetic source")
        : kind === "finalImage" ? Buffer.concat([png, Buffer.from("changed")])
          : JSON.stringify({ speechBubbles: [{ bbox: box, text: "changed OCR", readingOrder: 1 }] });
      await writeFile(join(directory, pin.path), changed);

      await expect(evaluateAutomationQuality(corpus, run, directory), kind).rejects.toThrow(`ASSET_CHANGED:${pin.path}`);
    }
  });

  it("rejects pinned OCR provenance for another run, source, or OCR artifact", async () => {
    for (const field of ["runId", "sourceSha256", "ocrSha256"]) {
      const { corpus, run } = await fixture();
      run.pages[0].evidenceKind = "actual_product";
      const receipt = { runId: run.runId, sourceSha256: corpus.pages[0].source.sha256, ocrSha256: run.pages[0].ocr.sha256 };
      receipt[field] = field === "runId" ? "another-fixture-run" : digest(`another-fixture-${field}`);
      run.pages[0].ocr.provenance = await asset("other-ocr-receipt.json", JSON.stringify(receipt));

      await expect(evaluateAutomationQuality(corpus, run, directory), field).rejects.toThrow("OCR_PROVENANCE_MISMATCH");
    }
  });

  it("computes CER using NFKC Unicode codepoints while preserving spaces and punctuation", () => {
    expect(characterErrors("Ａé😀 !", "Ae\u0301😀 !")).toEqual({ errors: 0, referenceCharacters: 5 });
    expect(characterErrors("😀", "")).toEqual({ errors: 1, referenceCharacters: 1 });
    expect(characterErrors("A😀 !", "A😀")).toEqual({ errors: 2, referenceCharacters: 4 });
    expect(characterErrors("あ！", "あ？")).toEqual({ errors: 1, referenceCharacters: 2 });
  });

  it("counts missing OCR regions as deletions and extra regions as insertions in CER", async () => {
    const { corpus, run } = await fixture();
    corpus.pages[0].groundTruth.regions = [
      { id: "first", bbox: box, text: "Ａ😀", translation: "첫 대사", order: 1 },
      { id: "missing", bbox: { ...box, x: 0.6, y: 0.6 }, text: "B !", translation: "누락 대사", order: 2 }
    ];
    pinCorpus(corpus, run);
    await setOcr(corpus, run, [
      { bbox: box, text: "A😀", readingOrder: 1 },
      { bbox: { ...box, y: 0.6 }, text: "！？", readingOrder: 2 }
    ]);

    const report = await evaluateAutomationQuality(corpus, run, directory);

    expect(report.pages[0].ocr).toMatchObject({
      matchedRegions: 1, referenceRegions: 2, predictedRegions: 2,
      characterErrors: 5, referenceCharacters: 5, characterErrorRate: 1, readingOrderErrors: 0
    });
  });

  it("never matches one reference or prediction to more than one region", async () => {
    for (const duplicated of ["reference", "prediction"]) {
      const { corpus, run } = await fixture();
      const predictions = [{ bbox: box, text: "AB", readingOrder: 1 }];
      if (duplicated === "reference") {
        corpus.pages[0].groundTruth.regions.push({ ...corpus.pages[0].groundTruth.regions[0], id: "second", order: 2 });
      } else {
        predictions.push({ bbox: box, text: "AB", readingOrder: 2 });
      }
      pinCorpus(corpus, run);
      await setOcr(corpus, run, predictions);

      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0].ocr, duplicated).toMatchObject({
        matchedRegions: 1, characterErrors: 2, referenceCharacters: duplicated === "reference" ? 4 : 2,
        referenceRegions: duplicated === "reference" ? 2 : 1, predictedRegions: duplicated === "prediction" ? 2 : 1
      });
    }
  });

  it("reassigns an overlapping match to retain both one-to-one OCR matches", async () => {
    const { corpus, run } = await fixture();
    const wide = { x: 0, y: 0.1, width: 0.6, height: 0.3 };
    corpus.pages[0].groundTruth.regions = [
      { id: "first", bbox: wide, text: "AB", translation: "첫 대사", order: 1 },
      { id: "second", bbox: { ...wide, x: 0.2 }, text: "CD", translation: "다음 대사", order: 2 }
    ];
    pinCorpus(corpus, run);
    await setOcr(corpus, run, [
      { bbox: { ...wide, x: 0.1 }, text: "CD", readingOrder: 2 },
      { bbox: { ...wide, width: 0.4 }, text: "AB", readingOrder: 1 }
    ]);

    const report = await evaluateAutomationQuality(corpus, run, directory);

    expect(report.pages[0].ocr).toMatchObject({ matchedRegions: 2, characterErrors: 0, referenceCharacters: 4, readingOrderErrors: 0 });
  });

  it("maximizes total IoU without crossing nearby matches or using text and reading order as weights", async () => {
    const { corpus, run } = await fixture();
    const wide = { x: 0, y: 0.1, width: 0.6, height: 0.2 };
    const references = [
      { id: "first", bbox: wide, text: "AB", translation: "첫 대사", order: 1 },
      { id: "second", bbox: { ...wide, x: 0.1 }, text: "CD", translation: "다음 대사", order: 2 }
    ];
    const predictions = [
      { bbox: { ...wide, x: 0.05 }, text: "AB", readingOrder: 1 },
      { bbox: { ...wide, x: 0.16 }, text: "CD", readingOrder: 2 }
    ];
    for (const reversed of ["neither", "references", "predictions", "both"]) {
      corpus.pages[0].groundTruth.regions = reversed === "references" || reversed === "both" ? [...references].reverse() : references;
      pinCorpus(corpus, run);
      await setOcr(corpus, run, reversed === "predictions" || reversed === "both" ? [...predictions].reverse() : predictions);

      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0].ocr, reversed).toMatchObject({
        matchedRegions: 2, characterErrors: 0, referenceCharacters: 4, characterErrorRate: 0, readingOrderErrors: 0
      });
    }
    // 글자와 순서가 서로 바뀌어도 좌표상 최적 매칭을 유지해야 오류를 숨기지 않는다.
    corpus.pages[0].groundTruth.regions = references;
    pinCorpus(corpus, run);
    await setOcr(corpus, run, [
      { ...predictions[0], text: "CD", readingOrder: 2 },
      { ...predictions[1], text: "AB", readingOrder: 1 }
    ]);

    const report = await evaluateAutomationQuality(corpus, run, directory);

    expect(report.pages[0].ocr).toMatchObject({ matchedRegions: 2, characterErrors: 4, characterErrorRate: 1, readingOrderErrors: 2 });
  });

  it("never promotes completed component, reused, or fixture evidence to product success", async () => {
    const { corpus, run } = await fixture();
    for (const evidenceKind of ["actual_component", "reused", "fixture"]) {
      run.pages[0].evidenceKind = evidenceKind;

      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0], evidenceKind).toMatchObject({ automaticSuccess: false, quality: "PASS" });
      expect(report.summary.dev).toMatchObject({ actualProductRuns: 0, automaticSuccesses: 0 });
    }
  });

  it("disqualifies manual edits and automatic retries independently", async () => {
    for (const intervention of ["manualEdits", "automaticRetries"]) {
      const { corpus, run } = await fixture();
      run.pages[0].evidenceKind = "actual_product";
      run.pages[0][intervention] = 1;

      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0].automaticSuccess, intervention).toBe(false);
      expect(report.summary.dev.automaticSuccesses).toBe(0);
    }
  });

  it("keeps missing dev and holdout runs as not_run rows in their respective denominators", async () => {
    const { corpus, run } = await fixture(3);
    corpus.pages[2].split = "holdout";
    corpus.pages[2].usedForDevelopment = false;
    pinCorpus(corpus, run);
    run.pages = [run.pages[0]];
    run.pages[0].evidenceKind = "actual_product";

    const report = await evaluateAutomationQuality(corpus, run, directory);

    expect(report.pages).toHaveLength(3);
    for (const row of report.pages.slice(1)) {
      expect(row).toMatchObject({ evidenceKind: "not_run", status: "NOT_RUN", automaticSuccess: false, ocr: null });
    }
    expect(report.summary.dev).toMatchObject({ pages: 2, notRun: 1, automaticSuccesses: 1, automaticSuccessRate: 0.5 });
    expect(report.summary.holdout).toMatchObject({ pages: 1, notRun: 1, automaticSuccesses: 0, automaticSuccessRate: 0 });
  });

  it("rejects malformed PNG headers even when the final output digest matches", async () => {
    const { corpus, run } = await fixture();
    const badSignature = Buffer.from(png), badChunk = Buffer.from(png), zeroWidth = Buffer.from(png);
    badSignature[0] = 0;
    badChunk.write("IDAT", 12, "ascii");
    zeroWidth.writeUInt32BE(0, 16);
    for (const bytes of [badSignature, badChunk, zeroWidth, png.subarray(0, 23)]) {
      run.pages[0].finalImage = await asset("bad-final.png", bytes);

      await expect(evaluateAutomationQuality(corpus, run, directory)).rejects.toThrow("FINAL_IMAGE_NOT_PNG");
    }
  });

  describe("Stage02 additive metrics (no model execution or independent semantic/image assessment)", () => {
    it.each([
      { name: "normal", predictions: [{ id: "ocr-a", bbox: box, text: "AB", readingOrder: 1 }], tp: 1, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1, missing: [], extra: [], errors: 0 },
      { name: "one missing dialogue", predictions: [], tp: 0, fp: 0, fn: 1, precision: null, recall: 0, f1: 0, missing: ["region-1"], extra: [], errors: 2 },
      { name: "one extra region", predictions: [{ id: "ocr-a", bbox: box, text: "AB", readingOrder: 1 }, { id: "extra", bbox: { ...box, x: 0.6 }, text: "X", readingOrder: 2 }], tp: 1, fp: 1, fn: 0, precision: 0.5, recall: 1, f1: 2 / 3, missing: [], extra: ["extra"], errors: 1 },
      { name: "duplicate geometry", predictions: [{ id: "ocr-a", bbox: box, text: "AB", readingOrder: 1 }, { id: "duplicate", bbox: box, text: "AB", readingOrder: 2 }], tp: 1, fp: 1, fn: 0, precision: 0.5, recall: 1, f1: 2 / 3, missing: [], extra: ["duplicate"], errors: 2 },
    ])("reports final OCR proposal counts and unmatched IDs: $name", async value => {
      const { corpus, run } = await fixture();
      await setOcr(corpus, run, value.predictions);
      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0].ocr).toMatchObject({
        truePositives: value.tp, falsePositives: value.fp, falseNegatives: value.fn,
        precision: value.precision, recall: value.recall, f1: value.f1,
        missingRegionIds: value.missing, extraRegionIds: value.extra,
        characterErrors: value.errors, referenceCharacters: 2, characterErrorRate: value.errors / 2,
      });
      expect(report.pages[0].ocr.scope).toBe("FINAL_OCR_PROPOSALS_IOU_0.5_NFKC_SPACES_AND_PUNCTUATION_PRESERVED");
    });

    it("keeps geometry matching independent of prediction IDs, text and reading order", async () => {
      const { corpus, run } = await fixture();
      await setOcr(corpus, run, [{ id: "independently-assigned-ocr-id", bbox: box, text: "AB", readingOrder: 2 }]);
      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0].ocr).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0, readingOrderErrors: 1, characterErrorRate: 0 });
    });

    it.each([
      ["AB", 0, 0], ["AC", 1, 0.5], ["A", 1, 0.5], ["ABC", 1, 0.5], ["ABCDE", 3, 1.5],
    ])("preserves page CER for recognized text %s including real zero and rates above one", async (text, errors, rate) => {
      const { corpus, run } = await fixture();
      await setOcr(corpus, run, [{ bbox: box, text, readingOrder: 1 }]);
      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0].ocr).toMatchObject({ characterErrors: errors, referenceCharacters: 2, characterErrorRate: rate, unmeasuredReasons: { characterErrorRate: null } });
      expect(report.ocrSummary).toMatchObject({ characterErrors: errors, referenceCharacters: 2, microCharacterErrorRate: rate });
    });

    it("weights corpus micro CER by reference characters and excludes unavailable pages", async () => {
      const { corpus, run } = await fixture(3);
      corpus.pages[1].groundTruth.regions[0].text = "ABCDEFGH";
      corpus.pages[2].groundTruth = { status: "pending" };
      pinCorpus(corpus, run);
      await setOcr(corpus, run, [{ bbox: box, text: "CD", readingOrder: 1 }]);
      run.pages[1].ocr = await ocrAsset("long-ocr.json", [{ bbox: box, text: "ABCDEFGH", readingOrder: 1 }], run.runId, corpus.pages[1].source.sha256);
      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.ocrSummary).toMatchObject({ measuredPages: 2, unmeasuredPages: 1, characterErrors: 2, referenceCharacters: 10, microCharacterErrorRate: 0.2, status: "PARTIAL" });
      expect(report.summary.dev.ocr.microCharacterErrorRate).toBe(0.2);
      expect(report.summary.dev.ocrByEvidenceKind.fixture.measuredPages).toBe(2);
      expect(report.pages[2]).toMatchObject({ ocr: null, ocrMeasurement: { status: "NOT_MEASURED", reason: "GROUND_TRUTH_NOT_VERIFIED" } });
    });

    it("keeps split and evidence-kind micro CER separate from the descriptive corpus total", async () => {
      const { corpus, run } = await fixture(2);
      corpus.pages[1].split = "holdout";
      corpus.pages[1].usedForDevelopment = false;
      run.pages[1].evidenceKind = "reused";
      pinCorpus(corpus, run);
      await setOcr(corpus, run, [{ bbox: box, text: "CD", readingOrder: 1 }]);
      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.ocrSummary.microCharacterErrorRate).toBe(0.5);
      expect(report.summary.dev.ocr.microCharacterErrorRate).toBe(1);
      expect(report.summary.holdout.ocr.microCharacterErrorRate).toBe(0);
      expect(Object.keys(report.summary.dev.ocrByEvidenceKind)).toEqual(["fixture"]);
      expect(Object.keys(report.summary.holdout.ocrByEvidenceKind)).toEqual(["reused"]);
    });

    it.each([{ predictions: [] }, { predictions: [{ id: "extra", bbox: box, text: "X", readingOrder: 1 }] }])("keeps zero reference characters distinct from zero errors for predictions $predictions", async ({ predictions }) => {
      const { corpus, run } = await fixture();
      corpus.pages[0].groundTruth.regions = [];
      pinCorpus(corpus, run);
      await setOcr(corpus, run, predictions);
      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0].ocr).toMatchObject({ characterErrors: predictions.length, referenceCharacters: 0, characterErrorRate: null, recall: null,
        precision: predictions.length ? 0 : null, f1: predictions.length ? 0 : null,
        unmeasuredReasons: { characterErrorRate: "NO_REFERENCE_CHARACTERS", recall: "NO_REFERENCE_REGIONS", precision: predictions.length ? null : "NO_PREDICTED_REGIONS", f1: predictions.length ? null : "NO_REFERENCE_OR_PREDICTED_REGIONS" } });
      expect(report.ocrSummary).toMatchObject({ measuredPages: 1, characterErrors: predictions.length, referenceCharacters: 0, microCharacterErrorRate: null, unmeasuredReasons: { microCharacterErrorRate: "NO_REFERENCE_CHARACTERS" } });
      expect(report.pages[0].ocrMeasurement.status).toBe(predictions.length ? "MEASURED" : "NO_TARGETS");
    });

    it.each(["missing OCR", "pending ground truth", "missing run", "explicit not_run"])("does not turn missing observations into perfect OCR: %s", async kind => {
      const { corpus, run } = await fixture();
      if (kind === "missing OCR") delete run.pages[0].ocr;
      if (kind === "pending ground truth") { corpus.pages[0].groundTruth = { status: "pending" }; pinCorpus(corpus, run); }
      if (kind === "missing run") run.pages = [];
      if (kind === "explicit not_run") run.pages[0].evidenceKind = "not_run";
      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0].ocr).toBeNull();
      expect(report.pages[0].ocrMeasurement).toMatchObject({ status: "NOT_MEASURED", reason: expect.any(String) });
      expect(report.summary.dev.ocr).toMatchObject({ measuredPages: 0, unmeasuredPages: 1, characterErrors: null, referenceCharacters: null,
        truePositives: null, falsePositives: null, falseNegatives: null, microCharacterErrorRate: null,
        unmeasuredReasons: { microCharacterErrorRate: "NO_EVALUABLE_OCR_PAGES" } });
    });

    it("reports an empty corpus and empty split denominators as unavailable", async () => {
      const { corpus, run } = await fixture(0);
      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.ocrSummary).toMatchObject({ measuredPages: 0, characterErrors: null, referenceCharacters: null, microCharacterErrorRate: null,
        unmeasuredReasons: { microCharacterErrorRate: "NO_PAGES" } });
      for (const split of [report.summary.dev, report.summary.holdout]) {
        expect(split.automaticSuccessRate).toBeNull();
        expect(split.evaluationDataAvailability).toEqual({ numerator: 0, denominator: 0, value: null, reason: "NO_PAGES" });
        expect(split.qualityReviewPendingRate.value).toBeNull();
      }
    });

    it("does not invent missing prediction IDs or use reference IDs as prediction IDs", async () => {
      const { corpus, run } = await fixture();
      await setOcr(corpus, run, [{ bbox: box, text: "AB", readingOrder: 1 }, { bbox: { ...box, x: 0.6 }, text: "X", readingOrder: 2 }]);
      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0].ocr).toMatchObject({ extraRegionIds: [null], extraRegionIndices: [1], extraRegionIdsReason: "PREDICTION_IDS_NOT_SUPPLIED" });
    });

    it.each(["", null, 7, "duplicate"])("rejects invalid or repeated supplied prediction IDs: %j", async regionId => {
      const { corpus, run } = await fixture();
      const predictions = [{ id: regionId, bbox: box, text: "AB", readingOrder: 1 }];
      if (regionId === "duplicate") predictions.push({ ...predictions[0], readingOrder: 2 });
      await setOcr(corpus, run, predictions);

      await expect(evaluateAutomationQuality(corpus, run, directory)).rejects.toThrow("INVALID_OR_DUPLICATE_OCR_REGION_ID");
    });

    it("keeps legacy attestation success while refusing to certify a model execution from its label", async () => {
      const { corpus, run } = await fixture();
      run.pages[0].evidenceKind = "actual_product";
      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0]).toMatchObject({ automaticSuccess: true, status: "PASS", executionVerification: { status: "UNVERIFIED", productExecutionVerified: false, reason: "RUNTIME_CLAIM_NOT_INDEPENDENTLY_VERIFIED" } });
      expect(report.automaticSuccessBasis).toBe("SUPPLIED_ATTESTATIONS_ONLY_NOT_EXECUTION_PROOF");
      expect(report.summary.dev.verifiedAutomaticSuccessRate).toEqual({ numerator: null, denominator: null, value: null, reason: "INDEPENDENT_RUNTIME_EVIDENCE_NOT_AVAILABLE" });
    });

    it.each([
      { edits: 0, retries: 0, firstAttempt: 1, afterRetry: 0, afterManualEdits: 0 },
      { edits: 0, retries: 1, firstAttempt: 0, afterRetry: 1, afterManualEdits: 0 },
      { edits: 1, retries: 0, firstAttempt: 0, afterRetry: 0, afterManualEdits: 1 },
      { edits: 1, retries: 1, firstAttempt: 0, afterRetry: 0, afterManualEdits: 1 },
    ])("partitions supplied success attestations for edits=$edits retries=$retries", async value => {
      const { corpus, run } = await fixture();
      Object.assign(run.pages[0], { evidenceKind: "actual_product", manualEdits: value.edits, automaticRetries: value.retries });
      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.summary.dev.attestedSuccesses).toEqual({ basis: "SUPPLIED_ATTESTATIONS_ONLY", denominator: 1, firstAttempt: value.firstAttempt, afterRetry: value.afterRetry, afterManualEdits: value.afterManualEdits });
      expect(report.pages[0].automaticSuccess).toBe(value.firstAttempt === 1);
    });

    it.each(["missing", "pending", "mismatch", "fail", "pass"])("distinguishes supplied quality review state: %s", async kind => {
      const { corpus, run } = await fixture();
      if (kind === "missing") delete run.pages[0].qualityReview;
      if (kind === "pending") run.pages[0].qualityReview.status = "pending";
      if (kind === "mismatch") run.pages[0].qualityReview.runId = "other-run";
      if (kind === "fail") run.pages[0].qualityReview.meaning = "fail";
      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0].qualityReviewStatus.status).toBe(kind.toUpperCase());
      expect(report.pages[0].quality).toBe(kind === "pass" ? "PASS" : kind === "fail" ? "FAIL" : "PENDING");
      expect(report.summary.dev.qualityReviewPendingRate.value).toBe(["missing", "pending", "mismatch"].includes(kind) ? 1 : 0);
    });

    it.each(["failed", "review", "blocked", "not_run", "completed"])("reports processing state independently of human quality: %s", async status => {
      const { corpus, run } = await fixture();
      run.pages[0].stages.TRANSLATION = status;
      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0].processingStatus).toBe(status === "failed" ? "FAILED" : ["review", "blocked"].includes(status) ? "NEEDS_REVIEW" : status.toUpperCase());
      expect(report.pages[0].quality).toBe("PASS");
    });

    it("keeps missing resource values null with reasons and preserves observed zeros", async () => {
      const { corpus, run } = await fixture(2);
      run.pages[1].durationMs = 0;
      run.pages[1].peakWorkingSetBytes = 0;
      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.pages[0]).toMatchObject({ durationMs: null, peakWorkingSetBytes: null, resourceMeasurementReasons: { durationMs: "NOT_REPORTED", peakWorkingSetBytes: "NOT_REPORTED" } });
      expect(report.pages[1]).toMatchObject({ durationMs: 0, peakWorkingSetBytes: 0, resourceMeasurementReasons: { durationMs: null, peakWorkingSetBytes: null } });
    });

    it("keeps delivery, independent meaning and image-quality measurements unavailable without their input contracts", async () => {
      const { corpus, run } = await fixture();
      const report = await evaluateAutomationQuality(corpus, run, directory);

      expect(report.summary.dev.delivery.automaticDeliveryRate).toEqual({ numerator: null, denominator: null, value: null, reason: "DELIVERY_RECORDS_NOT_SUPPLIED" });
      expect(report.summary.dev.delivery.humanAuditErrorRate).toEqual({ numerator: null, denominator: null, value: null, reason: "DELIVERY_AND_HUMAN_AUDIT_RECORDS_NOT_SUPPLIED" });
      expect(report.summary.dev.delivery.withheldRate.value).toBeNull();
      expect(report.independentAssessments).toEqual({
        semanticErrors: { value: null, reason: "INDEPENDENT_SEMANTIC_ASSESSMENT_NOT_AVAILABLE" },
        imageSourceResidue: { value: null, reason: "INDEPENDENT_IMAGE_ASSESSMENT_NOT_AVAILABLE" },
        artworkDamage: { value: null, reason: "INDEPENDENT_IMAGE_ASSESSMENT_NOT_AVAILABLE" },
      });
    });

    it("preserves CLI arguments, relative asset base, summary stdout and exclusive report creation", async () => {
      const { corpus, run } = await fixture();
      const corpusFile = join(directory, "corpus.json"), runFile = join(directory, "run.json"), output = join(directory, "report.json");
      await writeFile(corpusFile, JSON.stringify(corpus));
      await writeFile(runFile, JSON.stringify(run));
      const script = fileURLToPath(new URL("../../scripts/evaluate-automation-quality.mjs", import.meta.url));
      const stdout = execFileSync(process.execPath, [script, corpusFile, runFile, output], { cwd: tmpdir(), encoding: "utf8", windowsHide: true });
      const reportBytes = await readFile(output, "utf8"), report = JSON.parse(reportBytes);

      expect(JSON.parse(stdout)).toEqual(report.summary);
      expect(report).toMatchObject({ schemaVersion: 1, datasetId: corpus.datasetId, runId: run.runId, corpusSha256: run.corpusSha256, sourceIntegrityVerified: true });
      expect(report.pages[0].ocr).toMatchObject({ characterErrorRate: 0, referenceCharacters: 2, matchedRegions: 1 });
      const repeated = spawnSync(process.execPath, [script, corpusFile, runFile, output], { cwd: tmpdir(), encoding: "utf8", windowsHide: true });
      expect(repeated.status).not.toBe(0);
      expect(repeated.stderr).toContain("EEXIST");
      expect(await readFile(output, "utf8")).toBe(reportBytes);
    });
  });
});
