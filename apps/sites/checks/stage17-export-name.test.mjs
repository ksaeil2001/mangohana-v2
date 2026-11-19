import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {unzipSync} from 'fflate';

const dir=new URL('../.sites-runtime/export-name-checks/',import.meta.url);
await mkdir(dir,{recursive:true});
for(const f of ['studio-local-translation','studio-model','studio-files']){
 const src=await readFile(new URL('../lib/'+f+'.ts',import.meta.url),'utf8');
 await writeFile(new URL(f+'.mjs',dir),stripTypeScriptTypes(src).replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"'));
}
const {downloadPages}=await import(new URL('studio-files.mjs',dir));
const {blockVisualSignature}=await import(new URL('studio-model.mjs',dir));
test('an imported chapter label is retained in the list while result ZIP entries use leaf names',async t=>{
 const page={name:'Chapter One/표지.png',width:1,height:1,blocks:[],finalImageSignature:blockVisualSignature([]),
   finalImage:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBaYAAAAASUVORK5CYII='};
 const old=globalThis.document;let archive;
 globalThis.document={body:{appendChild(){}},createElement:()=>({click(){},remove(){}})};
 t.after(()=>{if(old===undefined)delete globalThis.document;else globalThis.document=old;});
 t.mock.method(URL,'createObjectURL',blob=>{archive=blob;return 'blob:fixture';});
 const originalTimer=globalThis.setTimeout;
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>originalTimer(fn,ms,...args).unref());
 await downloadPages([page,{...page,name:'Chapter Two\\표지.png'}],'book');
 const entries=unzipSync(new Uint8Array(await archive.arrayBuffer()));
 assert.deepEqual(Object.keys(entries),['001-표지.png','002-표지.png','페이지목록.txt']);
 assert.match(new TextDecoder().decode(entries['페이지목록.txt']),/Chapter One\/표지/);
 assert.equal(page.name,'Chapter One/표지.png');
});
