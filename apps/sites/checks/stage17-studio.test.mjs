import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {zipSync} from 'fflate';

const build=new URL('../.sites-runtime/stage17-checks/',import.meta.url);
await mkdir(build,{recursive:true});
for(const name of ['studio-local-translation','studio-reading','studio-model','studio-state','studio-files','studio-engine']){
  const src=await readFile(new URL('../lib/'+name+'.ts',import.meta.url),'utf8');
  await writeFile(new URL(name+'.mjs',build),stripTypeScriptTypes(src).replace(/(["'])\.\/(studio-[\w-]+)\1/g,'"./$2.mjs"'));
}
const model=await import(new URL('studio-model.mjs',build)), state=await import(new URL('studio-state.mjs',build));
const engine=await import(new URL('studio-engine.mjs',build)), files=await import(new URL('studio-files.mjs',build));

test('a completed local page can reopen its text inventory without resuming a job',async()=>{
  const project=model.sampleProject();
  const page={...project.pages[0],blocks:[],status:'ready',reviewed:false};
  const requestId='receive-local-result',jobId='mixed-job';
  const started=state.transitionPage(page,{type:'start',requestId});
  const job=state.transitionPage(started,{type:'job',requestId,jobId,endpoint:model.DEFAULT_ENGINE_ENDPOINT});
  const result={blocks:[model.makeBlock({id:'speech',source:'原文',text:'대사'})]};
  assert.equal(state.transitionPage(job,{type:'result',requestId:'earlier-request',result}),job);
  const completed=state.transitionPage(job,{type:'result',requestId,result});
  assert.equal(completed.jobId,undefined);
  assert.equal(state.canEditPage(completed),true);
  const saved=JSON.parse(JSON.stringify({...project,pages:[completed]}));
  const [restored]=model.restoreProject(saved).pages;
  assert.equal(restored.textInventoryJobId,jobId);
  assert.equal(state.getRunTargets(model.restoreProject(saved),'all').length,0);
  assert.equal(model.validateProject(saved).pages[0].textInventoryJobId,undefined);

  const sourceSha256='1'.repeat(64),line={lineId:'sign',source:'入口',pixelBox:[1,2,3,4],status:'read'};
  const inventory=await engine.readTextInventory(restored.textInventoryJobId,new AbortController().signal,async(url,init)=>{
    assert.equal(url,`/api/engine/jobs/${jobId}/text-inventory`);
    assert.equal(init.method,undefined);
    return Response.json({status:'available',textStatus:'ready',
      inventory:{version:1,jobId,sourceSha256,width:20,height:30,lines:[line],uncoveredBubbles:[]},
      notes:{jobId,sourceSha256,lines:[{lineId:line.lineId,source:line.source,translation:'입구'}]}});
  });
  assert.equal(inventory.notes.lines[0].translation,'입구');

  const remote=state.transitionPage(started,{type:'job',requestId,jobId,endpoint:'https://previous.example'});
  assert.equal(state.transitionPage(remote,{type:'result',requestId,result}).textInventoryJobId,undefined);
});

test('an OCR box edit survives TRIO, preserves the observed box and bitmap, and holds a later AI response',()=>{
  const p=model.sampleProject(),source={x:10,y:20,w:15,h:30},override={x:12,y:21,w:16,h:30};
  const block=model.makeBlock({id:'s17-ocr',sourceBox:source,text:'말'}),signature=model.blockVisualSignature([block]);
  const page={...p.pages[0],blocks:[block],reviewed:false,finalImageSignature:signature};
  assert.deepEqual(model.ocrBox(block),source);
  const edited={...page,blocks:[{...block,userSourceBox:override}]};
  assert.deepEqual(model.ocrBox(edited.blocks[0]),override);
  const restored=model.validateProject({...p,pages:[edited]}).pages[0];
  assert.deepEqual(restored.blocks[0].sourceBox,source);assert.deepEqual(model.ocrBox(restored.blocks[0]),override);
  assert.equal(model.blockVisualSignature(restored.blocks),signature);
  const active=state.transitionPage(restored,{type:'start',requestId:'retry'});
  assert.equal(state.canApplyPageResult(active),false);
  assert.deepEqual(state.transitionPage(active,{type:'result',requestId:'retry',result:{blocks:[]}}).blocks,restored.blocks);
  assert.throws(()=>model.validateProject({...p,pages:[{...page,blocks:[{...block,userSourceBox:{...override,w:300}}]}]}),/OCR/);
});

test('moving a page changes reading order and preserves the selected ID, edit history and server numbering',()=>{
  const p=model.sampleProject();
  const page={...p.pages[1],enginePageNumber:28};
  p.pages[1]=page;
  const initial=state.createWorkspaceState([p],p.id,{[p.id]:{pageId:page.id,zoom:1.5,view:'original',anchor:{x:.3,y:.8}}});
  const next=state.workspaceReducer(initial,{type:'project.update',projectId:p.id,updater:p=>state.moveStudioPage(p,page.id,-1),history:'record',id:'event',at:p.updatedAt});
  assert.equal(next.projects[0].pages[0],page);
  assert.deepEqual(next.reading,initial.reading);
  assert.equal(next.projects[0].pages[0].enginePageNumber,28);
  assert.deepEqual(state.workspaceReducer(next,{type:'history.undo',projectId:p.id}).projects[0].pages,p.pages);
  assert.equal(state.moveStudioPage(p,'absent',1),p);
  assert.equal(state.moveStudioPage(p,p.pages[0].id,-1),p);
  const locked={...p,pages:p.pages.map((pg,i)=>i===0?{...pg,jobId:'outstanding',status:'paused'}:pg)};
  assert.equal(state.moveStudioPage(locked,page.id,1),locked);
});

test('the page budget rejects a normal extra file before reading the next archive',async()=>{
  const page=new File(['fixture'],'page.png'), empty=new File([zipSync({})],'next.zip');
  let reads=0;
  Object.defineProperty(empty,'arrayBuffer',{value:async()=>{reads++;return new ArrayBuffer(0);}});
  await assert.rejects(files.extractImages([...Array(101).fill(page),empty]),/100/);
  assert.equal(reads,0);
  const two=zipSync({'chapter/a.png':Uint8Array.of(1),'chapter/b.png':Uint8Array.of(2)});
  await assert.rejects(files.extractImages([...Array(99).fill(page),new File([two],'two.zip')]),/100/);
  assert.equal((await files.extractImages([...Array(98).fill(page),new File([two],'two.zip')])).length,100);
});

test('normal Studio execution always chooses the same origin and retains retired job references for backup',()=>{
  assert.equal(engine.localStudioEndpoint({}),'/api/engine');
  const old={jobId:'existing',jobEndpoint:'https://previous.example'};
  assert.equal(engine.localStudioEndpoint(old),undefined);
  assert.equal(old.jobEndpoint,'https://previous.example');
  assert.equal(engine.localStudioEndpoint({jobId:'same',jobEndpoint:'/api/engine'}),'/api/engine');
  assert.equal(engine.localStudioEndpoint({jobId:'unlocated'}),undefined);
});

test('engine warnings and sound effect dispositions survive normal result application, save and TRIO import',()=>{
  const project=model.sampleProject(), page={...project.pages[0],blocks:[],reviewed:false};
  const evidence={preserved:2,translated:1};
  const raw={blocks:[],warnings:['원문 판독 검토'],evidence:{sound_effects:evidence}};
  const result=engine.validatePageEngineResult(raw);
  const ready=state.transitionPage(page,{type:'start',requestId:'s17'});
  const edited=state.transitionPage(ready,{type:'result',requestId:'s17',result});
  const manual={...edited,reviewed:true,status:'completed'};
  for(const reopen of [model.validateProject,model.restoreProject]){
    const reopened=reopen({...project,pages:[manual]}).pages[0];
    assert.deepEqual(reopened.engineReview,{warnings:raw.warnings,soundEffects:evidence});
    assert.equal(model.pageStatus(reopened),'review');
  }
  assert.equal(engine.validatePageEngineResult({blocks:[]}).engineReview,undefined);
  assert.equal(model.restoreProject({...project,pages:[page]}).pages[0].engineReview,undefined);
  assert.throws(()=>engine.validatePageEngineResult({blocks:[],evidence:{sound_effects:{preserved:-1,translated:1}}}));
  assert.throws(()=>model.validateProject({...project,pages:[{...page,engineReview:{warnings:9}}]}));
  const previous=state.transitionPage({...page,reviewed:true},{type:'start',requestId:'old'});
  assert.equal(state.transitionPage(previous,{type:'result',requestId:'old',result}).engineReview,undefined);
});

test('only matching measured candidate ink can replace the editor height estimate',()=>{
 const block=model.makeBlock({id:'known',text:'부탁해도 돼?',x:10,y:10,w:35,h:5,size:13});
 const png='data:image/png;base64,bG9jYWw=';
 const layout={id:block.id,contractVersion:'stage12-layout-v1',fitStatus:'FIT_VERIFIED',fontSizePx:13,bbox:{x:.1,y:.1,width:.35,height:.05},
   textEvidence:{sourceText:block.text,complete:true,missingCharacters:0,extraCharacters:0,renderedLines:[block.text]},actualLayout:{lines:[{text:block.text}]},
   standard:{stage:'FINAL_RASTER',finalRasterVerified:true,hardViolations:[]},raster:{hasInk:true,inkBounds:{x:32,y:32,width:58,height:12},paintedPixels:270,outsideInteriorPixels:0,clippedPixels:0,canvasEdgePixels:0,overlappingInkPixels:0,otherRegionCollisionPixels:0}};
 const raw={blocks:[block],warnings:['번역 검수'],clean_image:png,final_image:png,evidence:{typesetting_input_identity:{contract:'stage12-input-v1',width:300,height:300,coordinateSpace:'normalized-page-pixels'},typesetting_layouts:[layout]}};
 const page=r=>({id:'test-page',name:'sample.png',image:png,width:300,height:300,status:'review',reviewed:false,processed:true,...engine.validatePageEngineResult(r)});
 const issues=p=>model.getIssues(p).map(i=>i.kind),p=page(raw);
 assert.deepEqual(issues(p),['engine']);assert.equal(p.reviewed,false);
 assert.deepEqual(issues({...p,blocks:[{...p.blocks[0],text:'직접 수정'}]}),['engine','linebreak']);
 assert.deepEqual(issues({...p,height:299}),['engine','linebreak']);
 for(const change of [r=>delete r.final_image,r=>delete r.evidence.typesetting_input_identity,r=>r.evidence.typesetting_layouts.push(layout),r=>r.evidence.typesetting_layouts[0].raster.clippedPixels=1,
   r=>r.evidence.typesetting_layouts[0].raster.inkBounds.x=0,r=>r.evidence.typesetting_layouts[0].bbox.x=.2,r=>r.evidence.typesetting_layouts[0].textEvidence.sourceText='다른 말',r=>r.evidence.typesetting_layouts[0].standard.finalRasterVerified=false]){
   const altered=structuredClone(raw);change(altered);assert.deepEqual(issues(page(altered)),['engine','linebreak']);
 }
 const saved={...model.emptyProject('검수'),pages:[p]};
 assert.deepEqual(issues(model.restoreProject(saved).pages[0]),['engine']);
});
