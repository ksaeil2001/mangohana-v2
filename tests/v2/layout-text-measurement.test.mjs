import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import fs from 'node:fs/promises';
import {measureLayoutText} from '../../apps/engine/layout-text-measurement.mjs';
const root=process.cwd(),context={width:500,height:400,config:{buildRoot:path.join(root,'packages/ai-engine/.build/compiled'),resourcesPath:path.join(root,'packages/ai-engine/.build/resources')}};
test('automatic source preflight measures the real candidate fit without supplying a manual font size',async()=>{
 const r=await measureLayoutText([{id:'auto',bbox:{x:.1,y:.1,width:.4,height:.4},text:'자동 배치'}],context);
 assert.ok(r.entries[0].fontSizePx>12);assert.equal(r.entries[0].completeText,true);assert.equal(r.entries[0].fitsBox,true);assert.equal(r.paintCalls,0);assert.equal(r.encodeCalls,0);
});
test('signed production font measurement returns actual bounds without page pixels, painting, PNG or Permit',async t=>{
 const entries=[{id:'synthetic-one',bbox:{x:.1,y:.1,width:.6,height:.6},fontSizePx:24,lineHeight:1.5,text:'합성 한국어\n두 번째 줄'}],r=await measureLayoutText(entries,context);
 assert.equal(r.cleanupConfirmed,true);assert.equal(r.fontLoaded,true);assert.equal(r.paintCalls,0);assert.equal(r.encodeCalls,0);assert.equal(r.actualPageSupplied,false);assert.equal(r.actualImageExecution,false);
 assert.equal(r.entries[0].fontSizePx,24);assert.equal(r.entries[0].completeText,true);assert.equal(r.entries[0].fitsBox,true);assert.equal(r.entries[0].linesSeparated,true);assert.ok(r.entries[0].inkBounds.length>=2);
 const receipt=JSON.parse(await fs.readFile(path.join(r.evidenceDirectory,'controller.json')));assert.equal(receipt.completion.kernelCleanupConfirmed,true);assert.equal(receipt.completion.activeProcessesAfter,0);assert.equal(receipt.completion.rootExitCode,0);
 const input=JSON.parse(await fs.readFile(path.join(r.evidenceDirectory,'input.json')));assert.equal(input.permit,undefined);assert.equal(input.image,undefined);assert.deepEqual(Object.keys(input.measurement),['width','height','entries']);assert.ok(!(await fs.readdir(r.evidenceDirectory)).some(n=>/\.png$/i.test(n)));t.diagnostic('LAYOUT_MEASUREMENT_EVIDENCE='+r.evidenceDirectory);
});
test('oversized synthetic manual text is reported as a failed fit, never shrunk below the chosen size',async()=>{
 const r=await measureLayoutText([{id:'synthetic-too-big',bbox:{x:.1,y:.1,width:.1,height:.1},fontSizePx:200,lineHeight:1.5,text:'너무 큰 합성 글자'}],context);assert.equal(r.entries[0].fontSizePx,200);assert.equal(r.entries[0].fitsBox,false);assert.equal(r.paintCalls,0);assert.equal(r.encodeCalls,0);
});

test('real font keeps a Korean utterance on one line, blocking narrow 29px and fitting a wider 29px box',async()=>{
 const r=await measureLayoutText([76,96].map(width=>({id:'synthetic-utterance-'+width,bbox:{x:275/2039,y:1914/2880,width:width/2039,height:339/2880},fontSizePx:29,lineHeight:1.5,text:'아싸~!'})),{...context,width:2039,height:2880});
 for(const e of r.entries){assert.equal(e.fontSizePx,29);assert.deepEqual(e.layout.lines.map(l=>l.text),['아싸~!']);assert.equal(e.completeText,true);assert.equal(e.linesSeparated,true);}assert.equal(r.entries[0].fitsBox,false);assert.equal(r.entries[1].fitsBox,true);assert.equal(r.paintCalls,0);assert.equal(r.encodeCalls,0);assert.equal(r.cleanupConfirmed,true);
});
