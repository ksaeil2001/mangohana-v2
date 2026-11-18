import type { NormalizedBbox } from "./speechBubbleExtraction.js";

/** An inferred expansion must still describe the source region. */
export function isSupportedCandidateExpansion(source: NormalizedBbox, candidate: NormalizedBbox): boolean {
  const overlapWidth = Math.min(source.x + source.width, candidate.x + candidate.width) - Math.max(source.x, candidate.x);
  const overlapHeight = Math.min(source.y + source.height, candidate.y + candidate.height) - Math.max(source.y, candidate.y);
  return overlapWidth > 0 && overlapHeight > 0
    && candidate.width * candidate.height >= source.width * source.height;
}
