import { readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectFirstImageBlindReturns, firstImageReviewerPacket, prepareFirstImageBlindReview,
  readFirstImageReviewPng } from '../../packages/evaluation/first-image-blind-review.mjs';
import { object, requireValue } from '../../packages/evaluation/offline/contract.mjs';

async function writeReviewFolder({ seal, sealSha256, reviewerId, assetsRoot, outputDirectory }) {
  requireValue([assetsRoot, outputDirectory].every(dir => typeof dir === 'string' && path.isAbsolute(dir)),
    'FIRST_IMAGE_REVIEW_DIRECTORY_REQUIRED');
  const packet = firstImageReviewerPacket(seal, sealSha256, reviewerId);
  const readByDigest = async digest => {
    const file = path.join(assetsRoot, `${digest}.png`);
    const info = await lstat(file);
    requireValue(info.isFile() && info.size <= 32 * 1024 * 1024, 'FIRST_IMAGE_REVIEW_PNG_MISMATCH');
    return readFile(file);
  };
  const template = await readFile(new URL('./first-image-review.html', import.meta.url), 'utf8');
  await mkdir(outputDirectory);
  for (const { sourceRef, images } of packet.items) {
    for (const ref of [sourceRef, ...images.map(image => image.ref)]) {
      const bytes = await readFirstImageReviewPng(seal, sealSha256, reviewerId, ref, readByDigest);
      await writeFile(path.join(outputDirectory, `${ref}.png`), bytes, { flag: 'wx' });
    }
  }
  const data = JSON.stringify(packet).replaceAll('<', '\\u003c');
  const html = template.replace('<!-- REVIEW_DATA -->', () => `<script type="application/json" id="review-data">${data}</script>`);
  await writeFile(path.join(outputDirectory, 'index.html'), html, { flag: 'wx' });
  return { reviewerId, outputDirectory, reviewPages: packet.items.length };
}

try {
  const action = process.argv[2];
  requireValue(process.argv.length === 3 && ['capture', 'prepare', 'packet', 'collect'].includes(action), 'INVALID_ARGUMENTS');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  requireValue(object(input), 'INVALID_ARGUMENTS');
  let result;
  if (action === 'capture') {
    const { captureFirstImageRuns } = await import('./first-image-capture.mjs');
    result = await captureFirstImageRuns(input);
  }
  else if (action === 'prepare') result = prepareFirstImageBlindReview(input, input.pins, input.seed);
  else if (action === 'packet') result = await writeReviewFolder(input);
  else result = collectFirstImageBlindReturns(input, input.pins);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'FIRST_IMAGE_REVIEW_INPUT_INVALID' }));
  process.exitCode = 1;
}
