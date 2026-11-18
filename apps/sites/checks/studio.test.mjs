import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';
import {zipSync,strToU8} from 'fflate';
const directory=new URL('../.sites-runtime/checks/',import.meta.url);await mkdir(directory,{recursive:true});
for(const name of ['studio-local-translation','studio-model','studio-files','studio-engine']){
 const source=await readFile(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');
 const compiled=transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText.replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"');
 await writeFile(new URL(`${name}.mjs`,directory),compiled);
}
const m=await import(new URL('studio-model.mjs',directory));
const f=await import(new URL('studio-files.mjs',directory));
const engine=await import(new URL('studio-engine.mjs',directory));

test('sample exposes one real geometry/text warning of each requested kind',()=>{
 const p=m.sampleProject();assert.deepEqual(p.pages.map(pg=>m.getIssues(pg).map(i=>i.kind)),[['linebreak'],['overlap'],['missing'],[]]);
});
test('auto fit removes overflow without rewriting the dialogue or confirming review',()=>{
 const p=m.sampleProject().pages[0],before=p.blocks[1];const fitted=m.fitBlock(before,p);
 assert.ok(fitted.size<before.size);assert.equal(fitted.text,before.text);assert.equal(before.size,44);
 assert.equal(m.getIssues({...p,blocks:[p.blocks[0],fitted]}).length,0);assert.equal(m.pageStatus({...p,blocks:[p.blocks[0],fitted]}),'review');
});
test('a page with missing dialogue cannot become reviewed by changing its status',()=>{
 const page=m.sampleProject().pages[2];assert.equal(m.pageStatus({...page,reviewed:true,status:'completed'}),'review');
});
test('import rejects nonfinite coordinates and duplicate region identities',()=>{
 const b=m.makeBlock();assert.throws(()=>m.validateBlocks([{...b,x:NaN}]),/좌표/);assert.throws(()=>m.validateBlocks([b,b]),/중복/);
});
test('import normalizes geometry and unsupported styling into the page bounds',()=>{
 const [b]=m.validateBlocks([{text:'대사',x:99,y:-10,w:20,h:90,size:999,font:'unknown',color:'red',align:'bogus'}]);
 assert.equal(b.w,1);assert.equal(b.y,0);assert.equal(b.size,160);assert.equal(b.font,'sans');assert.equal(b.color,'#202020');
});
test('project round trip keeps content and completed review while clearing stale remote job IDs',()=>{
 const sample=m.sampleProject();sample.pages[3].jobId='stale';const copy=m.validateProject(structuredClone(sample));
 assert.notEqual(copy.id,sample.id);assert.equal(copy.pages[3].reviewed,true);assert.equal(copy.pages[3].status,'completed');assert.equal(copy.pages[3].jobId,undefined);assert.equal(copy.pages[0].blocks[0].text,sample.pages[0].blocks[0].text);
});
test('ZIP import extracts actual deflated bytes and naturally sorts Korean filenames',async()=>{
 const content=zipSync({'폴더/페이지10.png':strToU8('ten'),'폴더/페이지2.png':strToU8('two'),'__MACOSX/._cover.png':strToU8('skip'),'설명.txt':strToU8('skip')});
 const result=await f.extractImages([new File([content],'sample.zip')]);assert.deepEqual(result.map(x=>x.name),['페이지2.png','페이지10.png']);assert.equal(await result[0].text(),'two');
});
test('ZIP and image input reject unsupported content and overlarge files',async()=>{
 await assert.rejects(f.extractImages([new File(['text'],'readme.txt')]),/이미지/);
 await assert.rejects(f.extractImages([new File([new Uint8Array(8*1024*1024+1)],'large.png')]),/8MiB/);
 await assert.rejects(f.extractImages([new File(['GIF89a'],'animation.gif')]),/이미지/);
 const archive=zipSync({'large.png':new Uint8Array(8*1024*1024+1)});
 await assert.rejects(f.extractImages([new File([archive],'large.zip')]),/8MiB/);
});
test('engine URLs require HTTPS including loopback and reject embedded credentials',()=>{
 assert.equal(engine.endpointURL('https://engine.test/'),'https://engine.test');
 for(const address of ['http://example.com','http://127.0.0.1:8000','http://localhost:8000','http://[::1]:8000'])assert.throws(()=>engine.endpointURL(address),/HTTPS/);
 assert.throws(()=>engine.endpointURL('https://secret:token@example.com'),/인증/);
});
test('engine adapter creates an explicit job and accepts validated results as a separate return value',async()=>{
 const originalFetch=globalThis.fetch;const calls=[];const page=m.sampleProject().pages[0];const snapshot=JSON.stringify(page);let job='';
 globalThis.fetch=async(url,options)=>{calls.push(String(url));if(String(url).startsWith('/samples'))return new Response('image');if(options?.method==='POST')return Response.json({id:'job-one'});return Response.json({status:'completed',result:{blocks:[m.makeBlock({text:'결과'})]}});};
 try{const result=await engine.processPage(page,'https://engine.test','ja','ko',new AbortController().signal,id=>job=id,()=>{});assert.equal(job,'job-one');assert.equal(result.blocks[0].text,'결과');assert.equal(JSON.stringify(page),snapshot);assert.ok(calls.includes('https://engine.test/jobs/job-one'));}finally{globalThis.fetch=originalFetch;}
});
test('resuming a recorded job queries its ID without uploading the source again',async()=>{
 const originalFetch=globalThis.fetch;const calls=[];globalThis.fetch=async(url)=>{calls.push(String(url));return Response.json({status:'completed',result:{blocks:[]}});};
 try{const page={...m.sampleProject().pages[0],jobId:'existing-id'};await engine.processPage(page,'https://engine.test','ja','ko',new AbortController().signal,()=>assert.fail('created a second job'),()=>{});assert.deepEqual(calls,['https://engine.test/jobs/existing-id']);}finally{globalThis.fetch=originalFetch;}
});
test('terminal engine failure is distinguishable from a resumable transport failure',async()=>{
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({status:'failed',error:'OCR failed'});
 try{await assert.rejects(engine.processPage({...m.sampleProject().pages[0],jobId:'bad-job'},'https://engine.test','ja','ko',new AbortController().signal,()=>{},()=>{}),engine.TerminalJobError);}finally{globalThis.fetch=originalFetch;}
});
