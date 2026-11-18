import sharp from 'sharp';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const FINGERPRINT_VERSION = 1;

/** Local decode only. Perceptual matches are review candidates, never human truth. */
export async function fingerprintImage(input) {
  const bytes = Buffer.isBuffer(input) ? input : await (await import('node:fs/promises')).readFile(input);
  const metadata = await sharp(bytes, { failOn: 'error', limitInputPixels: 120000000 }).metadata();
  if (metadata.pages > 1) throw Object.assign(new Error('Multi-frame image needs explicit page extraction'), { code: 'MULTIFRAME_IMAGE' });
  const { data, info } = await sharp(bytes).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const perceptualHashes = [];
  // Full view plus two central crops; orientations cover rotations and mirrors.
  // Arbitrary crops, drawings, blur and low-information images still need review.
  for (const ratio of [1, 0.9, 0.75]) {
    const width = Math.max(1, Math.floor(info.width * ratio)), height = Math.max(1, Math.floor(info.height * ratio));
    const cropped = await sharp(data, { raw: info }).extract({ left: Math.floor((info.width - width) / 2), top: Math.floor((info.height - height) / 2), width, height }).png().toBuffer();
    for (const angle of [0, 90, 180, 270]) for (const mirrored of [false, true]) {
      let pipeline = sharp(cropped).rotate(angle);
      if (mirrored) pipeline = pipeline.flop();
      const gray = await pipeline.flatten({ background: '#fff' }).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
      let bits = 0n;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | BigInt(gray[y * 9 + x] > gray[y * 9 + x + 1]);
      perceptualHashes.push(bits.toString(16).padStart(16, '0'));
    }
  }
  return { sha256: hash(bytes), width: info.width, height: info.height, format: metadata.format,
    pixelSha256: hash(Buffer.concat([Buffer.from(`RGBA:${info.width}:${info.height}:`), data])),
    fingerprintVersion: FINGERPRINT_VERSION, perceptualHashes: [...new Set(perceptualHashes)].sort() };
}

export function duplicateRelation(a, b, maxDistance = 6) {
  if (a.sha256 === b.sha256) return { candidate: true, kind: 'exact_bytes', distance: 0 };
  if (a.pixelSha256 === b.pixelSha256) return { candidate: true, kind: 'exact_oriented_pixels', distance: 0 };
  let distance = 65;
  for (const x of a.perceptualHashes) for (const y of b.perceptualHashes) {
    let bits = BigInt('0x' + x) ^ BigInt('0x' + y), count = 0;
    while (bits) { bits &= bits - 1n; count++; }
    distance = Math.min(distance, count);
  }
  return { candidate: distance <= maxDistance, kind: 'perceptual_candidate', distance };
}
