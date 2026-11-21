import type { CandidateInterior } from "./candidateTypesettingFit.js";

type Box = { x: number; y: number; width: number; height: number };
type Pixels = Omit<CandidateInterior, "mask">;
type Search = {
  interior: CandidateInterior; source: Box; current: Box; neighbors: readonly Box[];
  limits: Pixels; width: number; height: number; padding: number; halfHeight: number;
};

/** A shared balloon may have one tall source column starting well above its
 * neighbor. Where only the first or last line clears a neighbor, return the
 * part of the band that actual glyphs must stay out of. */
export function staggeredAddressBands({ interior, source, current, neighbors, limits, width, height, padding, halfHeight }: Search): (Pixels & { exclusions: Box[] })[] {
  const centerY = (current.y + current.height / 2) * height;
  const centerX = Math.round((current.x + current.width / 2) * width);
  const oldWidth = Math.round(current.width * width), extension = Math.floor(oldWidth / 2);
  const boxRight = limits.left + limits.width;
  const dividers = neighbors.flatMap(box => {
    const left = box.x + box.width < source.x;
    if (!left && source.x + source.width >= box.x) return [];
    const boundary = left ? Math.ceil((box.x + box.width + source.x) * width / 2) + 1 :
      Math.floor((source.x + source.width + box.x) * width / 2) - 1;
    return [{ left, boundary, top: Math.floor(box.y * height), bottom: Math.ceil((box.y + box.height) * height) }];
  });
  const owners = dividers.filter(row => row.boundary === (row.left ? limits.left : boxRight));
  const centers = [...new Set(owners.flatMap(row => [row.top-padding-halfHeight, row.bottom+padding+halfHeight,
    row.top-padding, row.bottom+padding, row.top-padding+Math.floor(halfHeight/4), row.bottom+padding-Math.floor(halfHeight/4)]))]
    .filter(y => Math.abs(y-centerY) <= source.height * height / 4).sort((a,b) => Math.abs(a-centerY)-Math.abs(b-centerY));
  const bands: (Pixels & { exclusions: Box[] })[] = [];
  for (const cy of centers) {
    const top = cy-halfHeight, bottom = cy+halfHeight;
    if (top < Math.max(limits.top, source.y*height, interior.top+padding) ||
        bottom > Math.min(limits.top+limits.height, (source.y+source.height)*height, interior.top+interior.height-padding)) continue;
    let left = Math.max(interior.left+padding, Math.round(current.x*width)-extension);
    let right = Math.min(interior.left+interior.width-padding, Math.round((current.x+current.width)*width)+extension);
    if (!owners.some(row=>row.left)) left = Math.max(left, limits.left);
    if (!owners.some(row=>!row.left)) right = Math.min(right, boxRight);
    for (const divider of dividers) {
      if (top < divider.top-padding || bottom > divider.bottom+padding) continue;
      if (divider.left) left = Math.max(left, divider.boundary);
      else right = Math.min(right, divider.boundary);
    }
    if (left >= limits.left && right <= boxRight || centerX < left || centerX >= right) continue;
    // Intersect the contiguous span through the original horizontal anchor on
    // every row, including the erosion margin from the complete white balloon.
    let a = left-padding, b = right+padding;
    for (let y=top-padding; y<bottom+padding; y++) {
      const offset=(y-interior.top)*interior.width-interior.left;
      if (!interior.mask[offset+centerX]) { b=a; break; }
      let l=centerX, r=centerX+1;
      while (l>a && interior.mask[offset+l-1]) l--;
      while (r<b && interior.mask[offset+r]) r++;
      a=l; b=r;
    }
    left=a+padding; right=b-padding;
    if (right-left>oldWidth && centerX>=left && centerX<right && (left<limits.left || right>boxRight)) {
      const exclusions: Box[] = [];
      for (const divider of dividers) {
        const y = Math.max(top, divider.top-padding), endY = Math.min(bottom, divider.bottom+padding);
        const x = divider.left ? left : Math.max(left,divider.boundary);
        const endX = divider.left ? Math.min(right,divider.boundary) : right;
        if (endX>x && endY>y) exclusions.push({x:x/width,y:y/height,width:(endX-x)/width,height:(endY-y)/height});
      }
      bands.push({left,top,width:right-left,height:bottom-top,exclusions});
    }
  }
  return bands;
}
