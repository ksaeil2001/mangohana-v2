import test from 'node:test';import assert from 'node:assert/strict';import {tsImport} from 'tsx/esm/api';
const {transitionPage,workspaceReducer,createWorkspaceState}=await tsImport('../../apps/sites/lib/studio-state.ts',import.meta.url);
const {blockVisualSignature}=await tsImport('../../apps/sites/lib/studio-model.ts',import.meta.url);
const {processPage}=await tsImport('../../apps/sites/lib/studio-engine.ts',import.meta.url);
const block={id:'r',source:'合成',text:'사용자 확정값',x:5,y:5,w:30,h:40,font:'sans',size:30,weight:600,align:'center',color:'#000000',lineHeight:1.4,fill:false};
const page=()=>({id:'page',name:'one.png',image:'data:image/png;base64,AAAA',width:100,height:100,status:'review',reviewed:false,blocks:[{...block}],cleanImage:'old-clean',finalImage:'old-normal-png',finalImageSignature:blockVisualSignature([block]),engineGeneration:2});
for(const change of ['text','font','geometry','source','image','generation'])test('rejects late result after '+change+' changes and preserves manual values',()=>{
 const original=page(),started=transitionPage(original,{type:'start',requestId:'request'}),edited=structuredClone(started);
 if(change==='text')edited.blocks[0].text='더 최신 사용자 번역';if(change==='font')edited.blocks[0].size=44;if(change==='geometry')edited.blocks[0].x=12;if(change==='source')edited.blocks[0].source='새 OCR';if(change==='image')edited.image='new-source';if(change==='generation')edited.engineGeneration++;
 const result=transitionPage(edited,{type:'result',requestId:'request',result:{blocks:[{...block,text:'오래된 AI'}],cleanImage:'stale'}});
 assert.deepEqual(result.blocks,edited.blocks);assert.equal(result.cleanImage,edited.cleanImage);assert.equal(result.finalImage,'old-normal-png');assert.equal(result.status,'review');
});
test('late result after detaching/cancel or duplicate result cannot overwrite the first accepted candidate',()=>{
 const started=transitionPage(page(),{type:'start',requestId:'request'}),detached=transitionPage(started,{type:'continue-editing'});
 assert.strictEqual(transitionPage(detached,{type:'result',requestId:'request',result:{blocks:[]}}),detached);
 const applied=transitionPage(started,{type:'result',requestId:'request',result:{blocks:[block]}});assert.strictEqual(transitionPage(applied,{type:'result',requestId:'request',result:{blocks:[]}}),applied);
});
test('single-page polling refuses another work or page result before applying any blocks',async()=>{
 const previous=globalThis.fetch;globalThis.fetch=async()=>Response.json({id:'job',projectId:'foreign-work',pageId:'page',status:'completed',result:{blocks:[block]}});
 try{await assert.rejects(processPage({...page(),jobId:'job'},'/api/engine','ja','ko',new AbortController().signal,()=>{},()=>{},{projectId:'work'}),/작품|페이지|연결/);}finally{globalThis.fetch=previous;}
});
test('an unchanged bound page accepts one result through job and batch ticket transitions; confirmed values remain protected',()=>{
 let p=transitionPage(page(),{type:'start',requestId:'request'});p=transitionPage(p,{type:'job',requestId:'request',jobId:'job',endpoint:'/api/engine'});
 const applied=transitionPage(p,{type:'result',requestId:'request',result:{blocks:[{...block,text:'새 후보'}]}});assert.equal(applied.blocks[0].text,'새 후보');
 const confirmed=transitionPage({...page(),reviewed:true},{type:'start',requestId:'request'}),held=transitionPage(confirmed,{type:'result',requestId:'request',result:{blocks:[{...block,text:'덮어쓰기'}]}});assert.equal(held.blocks[0].text,block.text);assert.equal(held.reviewed,true);
});
for(const order of ['edit-first','response-first'])test('controlled ordering '+order+' preserves the latest manual edit',()=>{
 let p=transitionPage(page(),{type:'start',requestId:'request'});const result={type:'result',requestId:'request',result:{blocks:[{...block,text:'AI 후보'}]}};
 if(order==='response-first')p=transitionPage(p,result);p={...p,blocks:p.blocks.map(b=>({...b,text:'최신 사용자값'}))};if(order==='edit-first')p=transitionPage(p,result);
 assert.equal(p.blocks[0].text,'최신 사용자값');assert.strictEqual(transitionPage(p,result),p);
});
test('a project switch routes a late candidate only to its original work and preserves the active work',()=>{
 const project=id=>({id,name:id,chapter:'',source:'ja',target:'ko',mode:'online',sample:false,createdAt:'2026-11-13',updatedAt:'2026-11-13',history:[],pages:[transitionPage(page(),{type:'start',requestId:'request-'+id})]});
 let state=createWorkspaceState([project('old'),project('current')],'old');state=workspaceReducer(state,{type:'project.select',projectId:'current'});const active=state.projects[1];
 state=workspaceReducer(state,{type:'project.update',projectId:'old',at:'2026-11-13',id:'event',history:'preserve',updater:p=>({...p,pages:p.pages.map(pg=>transitionPage(pg,{type:'result',requestId:'request-old',result:{blocks:[{...block,text:'이전 작품의 후보'}]}}))})});
 assert.equal(state.activeId,'current');assert.strictEqual(state.projects[1],active);assert.equal(state.projects[0].pages[0].blocks[0].text,'이전 작품의 후보');
});
