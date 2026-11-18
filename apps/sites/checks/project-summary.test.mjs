import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';
const dir=new URL('../.sites-runtime/project-summary-checks/',import.meta.url);await mkdir(dir,{recursive:true});
const source=await readFile(new URL('../lib/studio-project-summary.ts',import.meta.url),'utf8');
await writeFile(new URL('summary.mjs',dir),transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText);
const {inlineImageBytes,projectImageSummary,formatFileBytes,isSampleImage}=await import(new URL('summary.mjs',dir));
const page=(id,image='data:image/png;base64,YWJj')=>Object.freeze({id,name:id,image,cleanImage:'data:image/png;base64,YWJjZA=='});
test('image sizes count decoded source bytes and handle padding, whitespace and unpadded legacy data',()=>{
 for(const [data,bytes] of [['YQ==',1],['YWI=',2],['YWJj',3],['YWJjZA==',4],['YQ',1],['Y W\nJj',3]])assert.equal(inlineImageBytes(`data:image/png;base64,${data}`),bytes);
 assert.equal(inlineImageBytes('data:image/svg+xml;base64,PHN2Zz4='),5);
});
test('missing or malformed sizes remain unknown instead of being reported as zero',()=>{
 for(const image of ['/samples/journey-01.png','data:image/png;base64,Y','data:image/png;base64,??==','data:image/png;base64,YQ=','data:image/png;base64,'])assert.equal(inlineImageBytes(image),null);
 const result=projectImageSummary([page('one','missing')]);assert.equal(result.bytes,0);assert.equal(result.unknownCount,1);
});
test('a project above the preview limit keeps all files and bytes while showing only its first 12 pages',()=>{
 const pages=Object.freeze(Array.from({length:15},(_,index)=>page(`p${index}`))),before=JSON.stringify(pages);
 const result=projectImageSummary(pages);
 assert.equal(result.fileCount,15);assert.equal(result.bytes,45);assert.equal(result.unknownCount,0);
 assert.equal(result.previews.length,12);assert.deepEqual(result.previews.map(item=>item.id),pages.slice(0,12).map(item=>item.id));assert.equal(result.previews[0],pages[0]);assert.equal(JSON.stringify(pages),before);
});
test('empty projects have zero files and bytes with no artificial thumbnails',()=>{
 assert.deepEqual(projectImageSummary([]),{fileCount:0,bytes:0,unknownCount:0,previews:[]});
});
test('sample asset results are tied to their source image and cannot leak into another project total',()=>{
 const sizes={'/samples/journey-01.png':1000,'/samples/journey-02.svg':null};
 assert.equal(projectImageSummary([page('a','/samples/journey-01.png')],sizes).bytes,1000);
 const other=projectImageSummary([page('b'),page('c','/samples/journey-02.svg')],sizes);assert.equal(other.bytes,3);assert.equal(other.unknownCount,1);
 assert.equal(isSampleImage('/samples/journey-01.png'),true);assert.equal(isSampleImage('https://elsewhere.test/image.png'),false);
});
test('file size labels use decimal units and keep exact bytes available separately',()=>{
 for(const [bytes,label] of [[0,'0 B'],[999,'999 B'],[1000,'1 KB'],[470000,'470 KB'],[1500000,'1.5 MB']])assert.equal(formatFileBytes(bytes),label);
});
