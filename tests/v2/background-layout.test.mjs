import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);let api={};try{api=require('../../packages/ai-engine/quality/background-layout.cjs');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
const width=100,height=90,bbox={x:.2,y:.2,width:.4,height:.4},allowedBbox={x:.1,y:.1,width:.7,height:.7};
function pixels(color){const b=new Uint8Array(width*height*4);for(let i=0;i<b.length;i+=4){b.set(color,i);b[i+3]=255;}return b;}
function fixture(color=[170,170,170,255],cleaned=true){const source=pixels(color),mask=pixels([255,255,255,255]),out=pixels(color);for(let y=30;y<35;y++)for(let x=30;x<35;x++){const at=(y*width+x)*4;source.set([10,10,10,255],at);mask[at+3]=0;}return {width,height,sourcePixels:source,cleanedPixels:cleaned?out:undefined,maskPixels:mask,sourceSha256:'a'.repeat(64),cleanedSha256:cleaned?'b'.repeat(64):null,maskSha256:'c'.repeat(64)};}
const inspect=(f,manual=false,extra={})=>{assert.equal(typeof api.createBackgroundScene,'function');const s=api.createBackgroundScene(f);return s[manual?'inspectManual':'inspectUniform']({id:'one',bbox,allowedBbox,otherBoxes:[],...extra});};
for(const color of [[170,170,170,255],[35,35,35,255],[205,170,90,255],[25,50,100,255]])test('uniform nonwhite background admits protected pixels and chooses contrast '+color.slice(0,3),()=>{
 const f=fixture(color),before=[...f.sourcePixels],r=inspect(f);assert.equal(r.status,'SAFE_PIXELS_VERIFIED');assert.equal(r.evidence.basis,'UNIFORM_BACKGROUND_INSET_RECTANGLE');assert.ok(r.evidence.minimumContrast>=4.5);assert.ok(r.interior);assert.deepEqual([...f.sourcePixels],before);
});
test('source-only checks never manufacture cleaned safety evidence',()=>{const r=inspect(fixture(undefined,false));assert.equal(r.status,'CLEANED_PENDING');assert.equal(r.evidence.basis,null);assert.equal(r.evidence.cleanedVerified,false);assert.equal(r.interior,undefined);assert.equal(r.sourceReviewable,true);});
test('a uniform cleaned patch cannot hide original protected artwork',()=>{const f=fixture();f.sourcePixels.set([20,20,20,255],(40*width+45)*4);f.cleanedPixels.set([20,20,20,255],(40*width+45)*4);const r=inspect(f);assert.equal(r.status,'MANUAL_LAYOUT_REQUIRED');});
test('texture and a balloon border remain blocked for automatic layout',()=>{for(const mode of ['texture','border']){const f=fixture();for(let y=18;y<58;y++)for(let x=18;x<62;x++)if(mode==='texture'&&(x+y)%3===0||mode==='border'&&x===22){const at=(y*width+x)*4;if(f.maskPixels[at+3]===255){f.sourcePixels.set([100,100,100,255],at);f.cleanedPixels.set([100,100,100,255],at);}}assert.equal(inspect(f).status,'MANUAL_LAYOUT_REQUIRED');}});
test('restoration artifacts inside the old text mask also reject uniform safety',()=>{const f=fixture();f.cleanedPixels.set([0,0,0,255],(32*width+32)*4);assert.equal(inspect(f).status,'MANUAL_LAYOUT_REQUIRED');});
test('mask mismatch, alpha mismatch and changed protected pixels fail closed',()=>{
 for(const kind of ['mask','alpha','protected']){const f=fixture();if(kind==='mask')f.maskPixels[3]=127;if(kind==='alpha')f.cleanedPixels[3]=0;if(kind==='protected')f.cleanedPixels[0]--;assert.throws(()=>inspect(f),e=>/BACKGROUND_/.test(e.code));}
});
test('out-of-ROI, page-edge margin and other OCR overlaps stay blocked',()=>{
 for(const patch of [{allowedBbox:{x:0,y:0,width:.1,height:.1}},{bbox:{x:0,y:0,width:.3,height:.3}},{otherBoxes:[{id:'two',bbox}]}])assert.equal(inspect(fixture(),false,patch).status,'MANUAL_LAYOUT_REQUIRED');
});
test('manual mode constructs holes for artwork and never clips ink to make it pass',()=>{
 const f=fixture();for(let y=20;y<57;y++){const at=(y*width+45)*4;f.sourcePixels.set([30,30,30,255],at);f.cleanedPixels.set([30,30,30,255],at);}
 const r=inspect(f,true,{approvalSha256:'d'.repeat(64)});assert.equal(r.status,'SAFE_PIXELS_VERIFIED');assert.equal(r.evidence.basis,'USER_REVIEWED_PROTECTED_ROI_RECTANGLE');
 assert.equal(r.interior.mask[(40-r.interior.top)*r.interior.width+45-r.interior.left],0);assert.ok(r.evidence.protectedEdgePixels>0);
 assert.equal(api.footprintFits(r.interior,[{left:40,right:48,top:35,bottom:40}]),false);
});
test('manual pixels need an actual bound approval to become final evidence',()=>{assert.equal(inspect(fixture(),true).status,'MANUAL_LAYOUT_REQUIRED');const r=inspect(fixture(undefined,false),true);assert.equal(r.status,'CLEANED_PENDING');assert.equal(r.evidence.basis,null);assert.ok(r.previewInterior);});
test('manual line breaks retain original characters, spaces and explicit paragraphs',()=>{
 assert.equal(typeof api.layoutTextMatches,'function');for(const [before,after]of [['한국어 문장','한국어\n문장'],['한국어 문장','한\n국어 문장'],['첫째\n둘째','첫째\n둘째']])assert.equal(api.layoutTextMatches(before,after),true);
 for(const [before,after]of [['한국어 문장','한국어문장'],['둘  사이','둘 사이'],['첫째\n둘째','첫째둘째'],['한국어','다른 말']])assert.equal(api.layoutTextMatches(before,after),false);
});
