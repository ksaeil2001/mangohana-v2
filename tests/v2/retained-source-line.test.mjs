import assert from 'node:assert/strict';
import test from 'node:test';
import maskPolicy from '../../packages/ai-engine/quality/mask-evidence.cjs';

const rectangle = (x, y, w, h) => [{ x, y }, { x: x+w, y }, { x: x+w, y: y+h }, { x, y: y+h }];
function page() {
  const width = 32, height = 20, source = Buffer.alloc(width*height*4, 255), mask = Buffer.from(source);
  const paint = (pixels, x, y, value) => pixels.fill(value, (y*width+x)*4, (y*width+x)*4+3);
  for (const left of [5, 22]) for (let y=5; y<11; y++) for (let x=left; x<left+3; x++) {
    paint(source, x, y, 25); mask[(y*width+x)*4+3] = 0;
  }
  const result = Buffer.from(source);
  for (let y=5; y<11; y++) for (let x=5; x<8; x++) paint(result, x, y, 252);
  const provenance = { sourceDetectionIds: ['a', 'b'], sourceQuadsPx: [rectangle(2,2,10,15), rectangle(18,2,11,15)],
    cropTransform: { imageWidth:width, imageHeight:height } };
  const regions = [{ id:'speech', bbox:{x:0,y:0,width:1,height:1}, productionOcrProvenance:provenance }];
  return { width, height, source, result, mask, regions, paint };
}

test('a restored first OCR line cannot hide a second dark line left on the same light balloon', () => {
  const f = page();
  assert.deepEqual(maskPolicy.unchangedRestorationRegions(f), ['speech']);
  const detail = maskPolicy.inspectRestorationInk(f);
  assert.deepEqual(detail.unchangedSourceLines.map(row=>[row.regionId,row.sourceDetectionId,row.maskedDarkPixels]), [['speech','b',18]]);
  for (let y=5; y<11; y++) for (let x=22; x<25; x++) f.paint(f.result, x, y, 252);
  assert.deepEqual(maskPolicy.unchangedRestorationRegions(f), []);
});

test('an inconsequential shade shift still leaves a whole readable line, including scaled source geometry', () => {
  const f = page(), p = f.regions[0].productionOcrProvenance;
  p.sourceQuadsPx = p.sourceQuadsPx.map(quad=>quad.map(({x,y})=>({x:x*2,y:y*2})));
  p.cropTransform = {imageWidth:f.width*2,imageHeight:f.height*2};
  for (let y=5; y<11; y++) for (let x=22; x<25; x++) f.paint(f.result, x, y, 27);
  assert.deepEqual(maskPolicy.unchangedRestorationRegions(f), ['speech']);
});

test('an exterior change inside the bounding rectangle of a rotated line cannot hide its retained strokes', () => {
  const f = page();
  f.regions[0].productionOcrProvenance.sourceQuadsPx[1] = [{x:14,y:10},{x:24,y:0},{x:32,y:8},{x:22,y:18}];
  f.paint(f.source,15,2,25); f.mask[(2*f.width+15)*4+3]=0; f.paint(f.result,15,2,252);
  assert.deepEqual(maskPolicy.unchangedRestorationRegions(f), ['speech']);
});

test('a small isolated speck, dark background of light lettering and a preserved mark outside the mask pass', () => {
  const speck = page();
  for (let y=5; y<11; y++) for (let x=22; x<25; x++) if (y!==5 || x!==22) speck.mask[(y*speck.width+x)*4+3]=255;
  assert.deepEqual(maskPolicy.unchangedRestorationRegions(speck), []);
  const reversed = page();
  for (let y=2;y<17;y++) for (let x=18;x<29;x++) {
    reversed.paint(reversed.source,x,y,25); reversed.paint(reversed.result,x,y,25);
  }
  for (let y=5;y<11;y++) { reversed.paint(reversed.source,21,y,240); reversed.mask[(y*reversed.width+21)*4+3]=0; }
  assert.deepEqual(maskPolicy.unchangedRestorationRegions(reversed), []);
  const protectedMark = page();
  for (let y=5; y<11; y++) for (let x=22; x<25; x++) protectedMark.mask[(y*protectedMark.width+x)*4+3]=255;
  assert.deepEqual(maskPolicy.unchangedRestorationRegions(protectedMark), []);
});
