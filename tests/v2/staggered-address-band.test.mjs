import assert from 'node:assert/strict';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { staggeredAddressBands } = await tsImport('../../packages/ai-engine/vendor/trio/src/renderer/candidateAddressBand.ts', import.meta.url);
const width = 300, height = 320;
const norm = (x, y, w, h) => ({ x:x/width, y:y/height, width:w/width, height:h/height });
function page() {
  const mask = new Uint8Array(width * height);
  for (let y=10;y<310;y++) mask.fill(1,y*width+15,y*width+265);
  return { interior:{left:0,top:0,width,height,mask}, source:norm(200,40,40,240), current:norm(195,55,60,210),
    neighbors:[norm(90,152,88,135)], limits:{left:190,top:0,width:110,height:320}, width,height,padding:8,halfHeight:22 };
}
test('a joined address can use the upper part of its original column with a full margin above the neighboring speaker',()=>{
  const f=page(), bands=staggeredAddressBands(f);
  assert.ok(bands.length>0);
  for(const b of bands){
    assert.ok(b.left<f.limits.left && b.width>70);
    assert.ok(b.top+b.height<=152-f.padding || b.exclusions.some(cut=>Math.abs(cut.y*height-(152-f.padding))<1e-8));
    assert.ok(Math.abs(b.top+b.height/2-160)<=60);
    assert.ok(b.left+b.width+f.padding<=265);
  }
});
test('same-height neighbors, a second speaker occupying the space or artwork at the anchor block the alternate band',()=>{
  const f=page();
  assert.deepEqual(staggeredAddressBands({...f,neighbors:[norm(90,45,88,230)]}),[]);
  const crowded=staggeredAddressBands({...f,neighbors:[...f.neighbors,norm(90,60,88,90)]});
  for(const band of crowded) for(let y=band.top; y<band.top+band.height; y++)
    assert.ok(band.exclusions.some(b=>y+.5>=b.y*height && y+.5<(b.y+b.height)*height && b.x*width<=band.left+.5));
  for(let y=40;y<200;y++) f.interior.mask[y*width+225]=0;
  assert.deepEqual(staggeredAddressBands(f),[]);
});
