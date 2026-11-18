import { createHash } from "node:crypto";
import { PRODUCTION_OCR_CONTRACT } from "../../../shared/productionOcr.js";
import type {
  ProductionOcrDetection,
  ProductionOcrDetectionModelIdentity,
  ProductionOcrGroup,
  ProductionOcrPixelBbox
} from "../../../shared/productionOcr.js";

export type ProductionOcrGroupingContext = Readonly<{
  isSeparated?: (
    left: ProductionOcrDetection, right: ProductionOcrDetection,
    orientation: "horizontal" | "vertical"
  ) => boolean;
}>;

export function groupProductionOcrDetections(
  detections: readonly ProductionOcrDetection[],
  context?: ProductionOcrGroupingContext
): readonly ProductionOcrGroup[] {
  if (detections.length === 0) return [];

  const orderedDetections = resolveUnknownOrientations([...detections].sort((left, right) =>
    left.detectionId.localeCompare(right.detectionId, "en-US")
  ), context);
  const imageWidth = orderedDetections[0]!.imageWidth;
  const imageHeight = orderedDetections[0]!.imageHeight;
  if (orderedDetections.some((detection) =>
    detection.imageWidth !== imageWidth || detection.imageHeight !== imageHeight
  )) {
    throw new Error("Production OCR detections must share one source image");
  }

  const parents = orderedDetections.map((_detection, index) => index);
  const forbidden = orderedDetections.map(() => new Set<number>());
  // 경계와 겹치는 제3의 검출이 있어도 검사 순서·이름에 따라 경계를 우회하지 않는다.
  const spatialIndices = parents.slice().sort((left, right) => {
    const a = orderedDetections[left]!.sourceBboxPx, b = orderedDetections[right]!.sourceBboxPx;
    return a.x - b.x || a.y - b.y || a.width - b.width || a.height - b.height;
  });
  for (let leftPosition = 0; leftPosition < spatialIndices.length; leftPosition += 1) {
    const leftIndex = spatialIndices[leftPosition]!, left = orderedDetections[leftIndex]!;
    for (let rightPosition = leftPosition + 1; rightPosition < spatialIndices.length; rightPosition += 1) {
      const rightIndex = spatialIndices[rightPosition]!, right = orderedDetections[rightIndex]!;
      if (!canGroup(left, right)) continue;
      if (context?.isSeparated?.(left, right, left.orientation as "horizontal" | "vertical")) {
        forbidden[leftIndex]!.add(rightIndex); forbidden[rightIndex]!.add(leftIndex);
      }
    }
  }
  // 허용된 후보 쌍 전체를 저장하지 않고, 확정된 분리 제약만 유지한다.
  for (let leftPosition = 0; leftPosition < spatialIndices.length; leftPosition += 1) {
    const left = spatialIndices[leftPosition]!;
    for (let rightPosition = leftPosition + 1; rightPosition < spatialIndices.length; rightPosition += 1) {
      const right = spatialIndices[rightPosition]!;
      if (!canGroup(orderedDetections[left]!, orderedDetections[right]!)) continue;
      const leftRoot = find(parents, left), rightRoot = find(parents, right);
      if (leftRoot === rightRoot || [...forbidden[leftRoot]!].some(index => find(parents, index) === rightRoot)) continue;
      union(parents, leftRoot, rightRoot);
      const root = find(parents, leftRoot), merged = root === leftRoot ? rightRoot : leftRoot;
      for (const index of forbidden[merged]!) forbidden[root]!.add(index);
      forbidden[merged]!.clear();
    }
  }

  const components = new Map<number, ProductionOcrDetection[]>();
  orderedDetections.forEach((detection, index) => {
    const root = find(parents, index);
    const members = components.get(root) ?? [];
    members.push(detection);
    components.set(root, members);
  });

  const groups = [...components.values()].map((members) => buildGroup(members, imageWidth, imageHeight));
  groups.sort(compareReadingOrder);
  return groups.map((group, index) => ({ ...group, readingOrder: index + 1 }));
}

function canGroup(left: ProductionOcrDetection, right: ProductionOcrDetection): boolean {
  if (left.orientation === "unknown" || left.orientation !== right.orientation) return false;
  return canGroupInOrientation(left, right, left.orientation);
}

function canGroupInOrientation(
  left: ProductionOcrDetection,
  right: ProductionOcrDetection,
  orientation: Exclude<ProductionOcrDetection["orientation"], "unknown">,
  context?: ProductionOcrGroupingContext
): boolean {
  // A small annotation beside a larger line is a separate recognition region.
  // Combining unlike character scales can make Baberu omit the smaller text.
  // Compare thickness across the reading axis, never line length or language.
  const leftThickness = orientation === "horizontal" ? left.sourceBboxPx.height : left.sourceBboxPx.width;
  const rightThickness = orientation === "horizontal" ? right.sourceBboxPx.height : right.sourceBboxPx.width;
  if (Math.min(leftThickness, rightThickness) < 0.5 * Math.max(leftThickness, rightThickness)) return false;

  // Detector bounds already include space around the glyphs. A larger gap can
  // bridge a caption and a separate bubble, especially across different sizes.
  if (orientation === "horizontal") {
    return overlapRatio(
      left.sourceBboxPx.x,
      left.sourceBboxPx.width,
      right.sourceBboxPx.x,
      right.sourceBboxPx.width
    ) >= 0.5 && axisGap(
      left.sourceBboxPx.y,
      left.sourceBboxPx.height,
      right.sourceBboxPx.y,
      right.sourceBboxPx.height
    ) <= 0.5 * Math.min(leftThickness, rightThickness)
      && !context?.isSeparated?.(left, right, orientation);
  }
  return overlapRatio(
    left.sourceBboxPx.y,
    left.sourceBboxPx.height,
    right.sourceBboxPx.y,
    right.sourceBboxPx.height
  ) >= 0.5 && axisGap(
    left.sourceBboxPx.x,
    left.sourceBboxPx.width,
    right.sourceBboxPx.x,
    right.sourceBboxPx.width
  ) <= 0.5 * Math.min(leftThickness, rightThickness)
    && !context?.isSeparated?.(left, right, orientation);
}

function resolveUnknownOrientations(
  detections: readonly ProductionOcrDetection[],
  context?: ProductionOcrGroupingContext
): ProductionOcrDetection[] {
  return detections.map((detection) => {
    if (detection.orientation !== "unknown") return detection;
    let horizontalEvidence = false;
    let verticalEvidence = false;
    for (const other of detections) {
      if (other === detection) continue;
      const horizontal = canGroupInOrientation(detection, other, "horizontal", context);
      const vertical = canGroupInOrientation(detection, other, "vertical", context);
      if (
        horizontal && !vertical
        && (other.orientation === "horizontal" || other.orientation === "unknown")
      ) horizontalEvidence = true;
      if (
        vertical && !horizontal
        && (other.orientation === "vertical" || other.orientation === "unknown")
      ) verticalEvidence = true;
    }
    if (horizontalEvidence === verticalEvidence) return detection;
    return {
      ...detection,
      orientation: horizontalEvidence ? "horizontal" : "vertical"
    };
  });
}

function overlapRatio(firstStart: number, firstSize: number, secondStart: number, secondSize: number): number {
  const overlap = Math.max(0, Math.min(firstStart + firstSize, secondStart + secondSize) - Math.max(firstStart, secondStart));
  return overlap / Math.max(1, Math.min(firstSize, secondSize));
}

function axisGap(firstStart: number, firstSize: number, secondStart: number, secondSize: number): number {
  return Math.max(0, Math.max(firstStart, secondStart) - Math.min(firstStart + firstSize, secondStart + secondSize));
}

function find(parents: number[], index: number): number {
  let root = index;
  while (parents[root] !== root) root = parents[root]!;
  let current = index;
  while (parents[current] !== current) {
    const next = parents[current]!;
    parents[current] = root;
    current = next;
  }
  return root;
}

function union(parents: number[], left: number, right: number): void {
  const leftRoot = find(parents, left);
  const rightRoot = find(parents, right);
  if (leftRoot === rightRoot) return;
  parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
}

function buildGroup(
  members: readonly ProductionOcrDetection[],
  imageWidth: number,
  imageHeight: number
): ProductionOcrGroup {
  const orderedMembers = [...members].sort((left, right) =>
    left.detectionId.localeCompare(right.detectionId, "en-US")
  );
  const minX = Math.min(...orderedMembers.map((member) => member.sourceBboxPx.x));
  const minY = Math.min(...orderedMembers.map((member) => member.sourceBboxPx.y));
  const maxX = Math.max(...orderedMembers.map((member) => member.sourceBboxPx.x + member.sourceBboxPx.width));
  const maxY = Math.max(...orderedMembers.map((member) => member.sourceBboxPx.y + member.sourceBboxPx.height));
  const groupBboxPx = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  const bbox = normalizePixelBbox(groupBboxPx, imageWidth, imageHeight);
  const polygon = [
    { x: bbox.x, y: bbox.y },
    { x: bbox.x + bbox.width, y: bbox.y },
    { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
    { x: bbox.x, y: bbox.y + bbox.height }
  ] as const;

  return {
    groupId: createGroupId(orderedMembers),
    sourceDetectionIds: orderedMembers.map((member) => member.detectionId),
    memberQuadsPx: orderedMembers.map((member) => member.sourceQuadPx),
    memberScores: orderedMembers.map((member) => member.score),
    memberModels: orderedMembers.map((member): ProductionOcrDetectionModelIdentity => member.sourceModel === undefined
      ? { modelId: PRODUCTION_OCR_CONTRACT.detector.modelId, revision: PRODUCTION_OCR_CONTRACT.detector.revision }
      : { ...member.sourceModel }),
    ...(orderedMembers.some((member) => member.supportedBy !== undefined) ? {
      memberSupportModels: orderedMembers.map((member): ProductionOcrDetectionModelIdentity | null =>
        member.supportedBy === undefined ? null : { ...member.supportedBy })
    } : {}),
    groupBboxPx,
    bbox,
    polygon,
    orientation: orderedMembers[0]!.orientation,
    readingOrder: 0,
    confidence: Math.min(...orderedMembers.map((member) => member.score)),
    imageWidth,
    imageHeight
  };
}

function normalizePixelBbox(bbox: ProductionOcrPixelBbox, imageWidth: number, imageHeight: number) {
  return {
    x: bbox.x / imageWidth,
    y: bbox.y / imageHeight,
    width: bbox.width / imageWidth,
    height: bbox.height / imageHeight
  };
}

function createGroupId(members: readonly ProductionOcrDetection[]): string {
  const identity = members.map((member) => ({
    orientation: member.orientation,
    quad: member.sourceQuadPx.map((point) => [roundGeometry(point.x), roundGeometry(point.y)])
  }));
  return `group-${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16)}`;
}

function roundGeometry(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function compareReadingOrder(left: ProductionOcrGroup, right: ProductionOcrGroup): number {
  const leftBottom = left.groupBboxPx.y + left.groupBboxPx.height;
  const rightBottom = right.groupBboxPx.y + right.groupBboxPx.height;
  if (leftBottom <= right.groupBboxPx.y) return -1;
  if (rightBottom <= left.groupBboxPx.y) return 1;

  if (left.orientation === "vertical" && right.orientation === "vertical") {
    return right.groupBboxPx.x - left.groupBboxPx.x || left.groupId.localeCompare(right.groupId, "en-US");
  }
  if (left.orientation === "horizontal" && right.orientation === "horizontal") {
    return left.groupBboxPx.y - right.groupBboxPx.y
      || left.groupBboxPx.x - right.groupBboxPx.x
      || left.groupId.localeCompare(right.groupId, "en-US");
  }
  return left.groupBboxPx.y - right.groupBboxPx.y
    || orientationRank(left.orientation) - orientationRank(right.orientation)
    || left.groupBboxPx.x - right.groupBboxPx.x
    || left.groupId.localeCompare(right.groupId, "en-US");
}

function orientationRank(orientation: ProductionOcrGroup["orientation"]): number {
  if (orientation === "vertical") return 0;
  if (orientation === "horizontal") return 1;
  return 2;
}
