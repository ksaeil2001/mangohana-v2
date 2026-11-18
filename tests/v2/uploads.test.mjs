// ZIP and header validation uses real archive bytes and real synthetic PNGs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ZipFile} from 'yazl';
import {crc32} from 'node:zlib';
import {png} from './batch-fixture.mjs';
const module=await import('../../apps/engine/uploads.mjs').catch(()=>({}));
const expand=async files=>{assert.equal(typeof module.expandUploads,'function','batch uploads must validate archive entries');return module.expandUploads(files);};
async function zip(entries){
 const archive=new ZipFile(),chunks=[];const ready=new Promise((resolve,reject)=>{archive.outputStream.on('data',chunk=>chunks.push(chunk));archive.outputStream.once('end',()=>resolve(Buffer.concat(chunks)));archive.outputStream.once('error',reject);});
 for(const entry of entries)archive.addBuffer(entry.bytes??png,entry.name,{compress:true,...entry.options});archive.end();return ready;
}
function renameEntry(bytes,from,to){assert.equal(Buffer.byteLength(from),Buffer.byteLength(to));const result=Buffer.from(bytes);let cursor=0;while((cursor=result.indexOf(from,cursor))!==-1){result.write(to,cursor);cursor+=Buffer.byteLength(to);}return result;}
function chunk(type,data){const name=Buffer.from(type),result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length,0);name.copy(result,4);data.copy(result,8);result.writeUInt32BE(crc32(Buffer.concat([name,data])),8+data.length);return result;}

test('ordinary images and nested image ZIPs retain bytes and natural page order',async()=>{
 const bytes=await zip([{name:'chapter/10.png'},{name:'chapter/2.png'},{name:'chapter/1.png'}]);
 const result=await expand([{name:'chapter.zip',bytes}]);
 assert.deepEqual(result.pages.map(page=>page.name),['1.png','2.png','10.png']);
 assert.deepEqual(result.pages.map(page=>page.key),['zip:chapter/1.png','zip:chapter/2.png','zip:chapter/10.png']);
 for(const page of result.pages)assert.deepEqual(page.bytes,png);
 const files=await expand([{name:'10.png',bytes:png},{name:'2.png',bytes:png},{name:'1.png',bytes:png}]);
 assert.deepEqual(files.pages.map(page=>page.name),['1.png','2.png','10.png']);assert.deepEqual(files.pages.map(page=>page.key),['file:2','file:1','file:0']);
});
test('ignores only known macOS metadata and reports the ignored names',async()=>{
 const result=await expand([{name:'comic.zip',bytes:await zip([{name:'1.png'},{name:'__MACOSX/._1.png',bytes:Buffer.from('meta')},{name:'.DS_Store',bytes:Buffer.from('meta')}])}]);
 assert.equal(result.pages.length,1);assert.deepEqual(result.ignoredFiles.map(file=>file.name).sort(),['.DS_Store','__MACOSX/._1.png']);
 assert.ok(result.ignoredFiles.every(file=>file.reason==='macos_metadata'));
});
test('rejects path traversal, absolute paths and Windows aliases before extraction',async()=>{
 const valid=await zip([{name:'abcd.png'}]);
 for(const bad of ['../a.png','/bad.png','C:/a.png','a:bc.png'])await assert.rejects(expand([{name:'bad.zip',bytes:renameEntry(valid,'abcd.png',bad)}]));
});
test('rejects case and Unicode-normalization duplicate ZIP paths',async()=>{
 for(const names of [['A.png','a.png'],['e\u0301.png','é.png']])await assert.rejects(expand([{name:'duplicate.zip',bytes:await zip(names.map(name=>({name})))}]),{code:'ZIP_DUPLICATE_PATH'});
});
test('rejects encrypted entries, symlinks, nested archives and disguised non-images',async()=>{
 const encrypted=await zip([{name:'1.png'}]);
 for(let index=0;index<encrypted.length-4;index++){const signature=encrypted.readUInt32LE(index);if(signature===0x04034b50)encrypted.writeUInt16LE(encrypted.readUInt16LE(index+6)|1,index+6);if(signature===0x02014b50)encrypted.writeUInt16LE(encrypted.readUInt16LE(index+8)|1,index+8);}
 const cases=[encrypted,await zip([{name:'link.png',options:{mode:0o120777}}]),await zip([{name:'inner.zip',bytes:Buffer.from('PK')}]),await zip([{name:'1.png',bytes:Buffer.from('%PDF-1.7 fake image')}])];
 for(const bytes of cases)await assert.rejects(expand([{name:'unsafe.zip',bytes}]));
});
test('refuses an excessive entry count or page count before admitting images',async()=>{
 await assert.rejects(expand([{name:'pages.zip',bytes:await zip(Array.from({length:101},(_,index)=>({name:index+'.png'})))}]),{code:'BATCH_PAGE_LIMIT'});
 await assert.rejects(expand([{name:'entries.zip',bytes:await zip(Array.from({length:301},(_,index)=>({name:'__MACOSX/'+index+'.txt',bytes:Buffer.from('x')})))}]),{code:'ZIP_ENTRY_LIMIT'});
});
test('checks declared and streamed expansion bounds without rejecting valid high-compression PNG metadata',async()=>{
 const text=chunk('tEXt',Buffer.concat([Buffer.from('Comment\0'),Buffer.alloc(250_000,65)]));
 const image=Buffer.concat([png.subarray(0,33),text,png.subarray(33)]),packed=await zip([{name:'blank.png',bytes:image}]);
 assert.ok(image.length/packed.length>100,'the benign regression fixture must exceed the old ratio heuristic');
 const result=await expand([{name:'blank.zip',bytes:packed}]);assert.deepEqual(result.pages[0].bytes,image);
 const oversized=Buffer.from(await zip([{name:'1.png'}]));const central=oversized.indexOf(Buffer.from('504b0102','hex'));oversized.writeUInt32LE(9*1024*1024,central+24);
 await assert.rejects(expand([{name:'bomb.zip',bytes:oversized}]),{code:'INPUT_LIMIT'});
});
test('rejects animated PNGs and malformed archive signatures independently of filename MIME',async()=>{
 const actl=Buffer.alloc(8);actl.writeUInt32BE(2,0);const animated=Buffer.concat([png.subarray(0,33),chunk('acTL',actl),png.subarray(33)]);
 await assert.rejects(expand([{name:'still.png',bytes:animated}]),{code:'ANIMATED_IMAGE'});
 await assert.rejects(expand([{name:'comic.zip',bytes:png}]),{code:'ZIP_INVALID'});
 await assert.rejects(expand([{name:'fake.png',bytes:Buffer.from('not image')}]),{code:'INVALID_IMAGE'});
});
test('a corrupt central CRC never yields an accepted image',async()=>{
 const bytes=Buffer.from(await zip([{name:'1.png'}])),central=bytes.indexOf(Buffer.from('504b0102','hex'));bytes.writeUInt32LE(0,central+16);
 await assert.rejects(expand([{name:'corrupt.zip',bytes}]),{code:'ZIP_INTEGRITY_FAILED'});
});
