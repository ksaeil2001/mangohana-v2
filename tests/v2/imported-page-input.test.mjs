// Synthetic persisted approval + real strict checkpoint loader. No models or renderer.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {createHash,createHmac} from 'node:crypto';import {createRequire} from 'node:module';
import {once} from 'node:events';
import {createTranslationReviewStore} from '../../apps/engine/store.mjs';
import {createEngineServer} from '../../apps/engine/server.mjs';
import {createContextStore} from '../../apps/engine/context.mjs';
const require=createRequire(import.meta.url),{createCheckpointSession}=require('../../packages/ai-engine/quality/recovery-checkpoint.cjs');
const {selectDialogueRegions}=require('../../packages/ai-engine/quality/region-selection.cjs');
let api={};try{api=require('../../packages/ai-engine/quality/imported-page-input.cjs');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
const sha=x=>createHash('sha256').update(Buffer.isBuffer(x)||typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const owner=sha('cookie-one'),other=sha('cookie-two'),origin='http://127.0.0.1:5173';
const png=Buffer.from('89504e470d0a1a0a0000000d4948445200000010000000100800000000','hex');
export async function fixture(t,{http=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'imported-review-')),dir=path.join(root,'source');await fs.mkdir(dir);
 const scope={ownerScope:sha('original-owner'),projectId:'original-project',pageId:'original-page',pageNumber:1,sourceLanguage:'ja',sourceSha256:sha(png),normalizedSha256:sha(png)};
 const regions=Array.from({length:13},(_,i)=>({regionId:'r'+(i+1),order:i+1,rawOcr:'原文'+i,sourceText:'原文'+i,sourceReading:'原文'+i,originalAiTranslation:'원AI '+i,selectedUserTranslation:'사용자 선택 '+i,selectionOrigin:i===3||i===5?'USER_EDIT':'AI_SUGGESTION_ADOPTED',editRevision:i+1,sourceLineIds:['l'+i],bbox:{x:.1,y:.1,width:.2,height:.2},riskSignals:i===1?[{code:'BENEFACTIVE_DIRECTION_RISK'},{code:'QUANTITY_RISK'}]:[5,6].includes(i)?[{code:i===5?'BENEFACTIVE_DIRECTION_RISK':'QUANTITY_RISK'}]:[],originalConfirmedByHuman:false,originalRiskDecisions:[],independentSemanticVerification:null}));
 const speechBubbles=regions.map(r=>({id:r.regionId,text:r.sourceText,bbox:r.bbox,readingOrder:r.order,confidence:.6,productionOcrProvenance:{groupId:r.regionId,sourceDetectionIds:r.sourceLineIds,sourceQuadsPx:[[{x:2,y:2},{x:4,y:2},{x:4,y:4},{x:2,y:4}]],cropTransform:{imageWidth:16,imageHeight:16}}}));
 const preSelectionExtraction={pageNumber:1,speechBubbles,nonSpeechText:[],warnings:[]},regionDetection={width:16,height:16,imageSha256:scope.normalizedSha256,regions:[{id:'roi',kind:'text_bubble',confidence:.9,bbox:{x:0,y:0,width:1,height:1}}]},selected=selectDialogueRegions(preSelectionExtraction,regionDetection);
 const payload={extraction:selected.extraction,ocrRefinement:{reviews:[]},regionSelection:selected.selection,preSelectionExtraction,regionDetection};
 await fs.writeFile(path.join(dir,'source.png'),png);await fs.writeFile(path.join(dir,'normalized.png'),png);
 const checkpoints={};await createCheckpointSession({directory:dir,jobId:'original-job',scope,onCheckpoint:r=>{checkpoints[r.stage]=r;}}).save('ocr',{configuration:sha('original-configuration')},payload,['normalized.png']);
 const state={id:'original-job',sequence:2,owner:scope.ownerScope,projectId:scope.projectId,pageId:scope.pageId,pageNumber:1,sourceSha256:scope.sourceSha256,sourceLanguage:'ja',checkpoints};await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(state));
 const data={id:'fixture-review',packetSha256:sha('packet'),submissionSha256:sha('submission bytes'),sourceSha256:scope.sourceSha256,normalizedSha256:scope.normalizedSha256,candidateSetSha256:sha('candidates'),translationInputSha256:sha('input'),selectedSetSha256:sha(regions.map(r=>[r.regionId,r.selectedUserTranslation,r.selectionOrigin,r.editRevision])),sourceScope:{owner:scope.ownerScope,projectId:scope.projectId,pageId:scope.pageId,pageNumber:1,sourceSha256:scope.sourceSha256},processingGeneration:2,sourceContextRevision:null,sourceBaselineEditRevision:0,sourceImage:'data:image/png;base64,'+png.toString('base64'),normalizedImage:'data:image/png;base64,'+png.toString('base64'),originalCheckpointSha256:checkpoints.ocr.sha256,regions};
 let context=0;const store=await createTranslationReviewStore({root:path.join(root,'review'),loadCatalog:async()=>structuredClone(data),contextRevision:async()=>context,withContextRevision:async(_o,_p,r,fn)=>{assert.equal(context,r);const out=await fn();if(context!==r)throw Object.assign(Error('context changed'),{code:'REVIEW_REVISION_CONFLICT'});return out;}});t.after(()=>store.close());
 assert.equal(typeof store.withEngineInputs,'function','missing saved approval to engine adapter');
 let cookie,principal=owner,base,server;
 if(http){server=createEngineServer({store:{imageExecutionAuthorized:false,health:async()=>({ready:true}),submit:async()=>assert.fail('no image execution'),get:async()=>null,getResult:async()=>null},reviewStore:store,inspectImportedPage:async binding=>inspect(binding),allowedOrigin:origin});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));base='http://127.0.0.1:'+server.address().port;const init=await fetch(base+'/translation-reviews/fixture-review');cookie=init.headers.get('set-cookie').split(';')[0];principal=sha(cookie.split('=')[1]);}
 const p=await store.preview(principal,'fixture-review');const command={documentId:p.target.documentId,approvalToken:p.approvalToken,requestKey:p.requestKey,expectedEditRevision:0,expectedContextRevision:0,sourceSha256:p.sourceSha256,normalizedSha256:p.normalizedSha256,candidateSetSha256:p.candidateSetSha256,selectedSetSha256:p.selectedSetSha256,importAcknowledged:true,riskAcknowledged:true,regions:p.regions.map(r=>({regionId:r.regionId,selectedTranslation:r.selectedUserTranslation}))};
 const {document}=await store.apply(principal,'fixture-review',command),expected={expectedEditRevision:1,expectedContextRevision:0,eventSha256:document.receipt.eventSha256,selectedSetSha256:document.receipt.selectedSetSha256};
 const source={directory:dir,jobId:state.id,expectedGeneration:2,expectedCheckpointSha256:checkpoints.ocr.sha256};
 const readCurrentOcr=async({scope:originalScope,resumeFrom,originalIdentity})=>{const session=createCheckpointSession({directory:root,jobId:'inspection',scope:originalScope,resumeFrom});return {value:await session.load('ocr',originalIdentity),compatibility:null,currentIdentity:originalIdentity};};
 const inspect=binding=>{assert.equal(typeof api.inspectImportedPageInputs,'function','missing current engine imported-page input contract');return api.inspectImportedPageInputs({binding,source,readCurrentOcr});};
 const run=(o=principal,e=expected,fn=inspect)=>{assert.equal(typeof store.withEngineInputs,'function','missing saved approval to engine adapter');return store.withEngineInputs(o,document.documentId,e,fn);};
 const file=path.join(root,'review',document.documentId+'.json');
 async function mutate(change,{resign=false}={}){const d=JSON.parse(await fs.readFile(file));change(d);if(resign){const {signature,...unsigned}=d;d.signature=createHmac('sha256',await fs.readFile(path.join(root,'review/approval-key.bin'))).update(JSON.stringify(unsigned)).digest('hex');}await fs.writeFile(file,JSON.stringify(d));}
 return {root,dir,data,payload,source,store,document,expected,run,inspect,readCurrentOcr,mutate,file,setContext:v=>{context=v;},base,cookie,principal};
}
test('saved thirteen selections and original OCR enter current imported page without changing AI, warning or approval evidence',async t=>{
 const f=await fixture(t),before=await fs.readFile(f.file),checkpoint=await fs.readFile(path.join(f.dir,'checkpoint-ocr.json'));
 const out=await f.run();assert.equal(out.status,'IMPORTED_PAGE_INPUTS_READY');assert.equal(out.ocrRegions,13);assert.equal(out.userTranslationsUsable,13);assert.equal(out.executionAuthorized,false);assert.equal(out.current.editRevision,1);assert.equal(out.current.contextRevision,0);assert.equal(out.current.processingGeneration,null);assert.notEqual(out.current.ownerScope,out.source.scope.ownerScope);
 assert.deepEqual(out.lines.map(l=>l.userTranslation),Array.from({length:13},(_,i)=>'사용자 선택 '+i));assert.deepEqual(out.lines.map(l=>l.aiTranslation),Array.from({length:13},(_,i)=>'원AI '+i));assert.equal(out.lines.flatMap(l=>l.riskSignals).length,4);assert.equal(out.independentSemanticVerification,null);assert.ok(out.lines.every(l=>l.originalConfirmedByHuman===false));
 assert.deepEqual(await f.run(),out);assert.deepEqual(await fs.readFile(f.file),before);assert.deepEqual(await fs.readFile(path.join(f.dir,'checkpoint-ocr.json')),checkpoint);
});
for(const [name,change]of [['old edit',e=>{e.expectedEditRevision=0;}],['old context',e=>{e.expectedContextRevision=1;}],['wrong receipt',e=>{e.eventSha256=sha('wrong');}],['wrong selections',e=>{e.selectedSetSha256=sha('wrong');}]])test('rejects '+name,async t=>{const f=await fixture(t),e={...f.expected};change(e);await assert.rejects(async()=>f.run(f.principal,e));});
test('rejects another owner before engine access',async t=>{const f=await fixture(t);await assert.rejects(async()=>f.run(other),{code:'REVIEW_PAGE_NOT_FOUND'});});
for(const [name,change,resign]of [
 ['unsigned translation',d=>{d.regions[0].selectedUserTranslation='변조';},false],
 ['signed missing region',d=>{d.regions.pop();},true],['signed duplicate region',d=>{d.regions[1]=d.regions[0];},true],
 ['signed stale edit',d=>{d.editRevision++;},true],['signed changed source owner',d=>{d.sourceProvenance.scope.owner=sha('wrong');},true],
 ['signed geometry',d=>{d.regions[0].bbox.width=.4;},true],['signed removed warning',d=>{d.regions[1].riskSignals=[];},true],
 ['changed approval receipt',d=>{d.receipt.signature=sha('bad signature');},true]
])test('rejects '+name+' rather than adapting corrupted saved evidence',async t=>{const f=await fixture(t);await f.mutate(change,{resign});await assert.rejects(async()=>f.run());});
test('rejects a mutated persisted event file',async t=>{const f=await fixture(t);await fs.appendFile(path.join(f.root,'review/events',f.expected.eventSha256+'.json'),'tamper');await assert.rejects(async()=>f.run());});
test('context edited after approval is stale',async t=>{const f=await fixture(t);f.setContext(1);await assert.rejects(async()=>f.run());});
test('edit changes during engine input verification discard the result',async t=>{const f=await fixture(t);await assert.rejects(async()=>f.run(f.principal,f.expected,async binding=>{const out=await f.inspect(binding);await f.mutate(d=>{d.editRevision++;},{resign:true});return out;}),{code:'REVIEW_REVISION_CONFLICT'});});
test('context changes during engine input verification discard the result',async t=>{const f=await fixture(t);await assert.rejects(async()=>f.run(f.principal,f.expected,async binding=>{const out=await f.inspect(binding);f.setContext(1);return out;}),{code:'REVIEW_REVISION_CONFLICT'});});
for(const [name,change]of [
 ['source bytes',async f=>fs.writeFile(path.join(f.dir,'source.png'),'wrong')],['normalized bytes',async f=>fs.writeFile(path.join(f.dir,'normalized.png'),'wrong')],
 ['checkpoint origin',async f=>{f.source.jobId='other-job';}],['generation',async f=>{f.source.expectedGeneration=3;}],['current OCR miss',async f=>{f.readCurrentMiss=true;}],
 ['state owner',async f=>{const file=path.join(f.dir,'state.json'),s=JSON.parse(await fs.readFile(file));s.owner=sha('wrong');await fs.writeFile(file,JSON.stringify(s));}]
])test('rejects imported OCR '+name+' without inference fallback',async t=>{const f=await fixture(t);await change(f);await assert.rejects(async()=>f.run(f.principal,f.expected,binding=>api.inspectImportedPageInputs({binding,source:f.source,readCurrentOcr:f.readCurrentMiss?async()=>({value:null}):f.readCurrentOcr})));});
test('HTTP readiness requires existing browser session, scope and revisions; cannot grant execution',async t=>{
 const f=await fixture(t,{http:true}),url=f.base+'/translation-review-pages/'+f.document.documentId+'/inspect-inputs',headers={origin,cookie:f.cookie,'content-type':'application/json','x-mangohana-review-scope':f.store.scope(f.principal)};
 const post=h=>fetch(url,{method:'POST',headers:h,body:JSON.stringify(f.expected)});
 const good=await post(headers);assert.equal(good.status,200);assert.equal((await good.json()).userTranslationsUsable,13);
 assert.equal((await post({...headers,cookie:''})).status,403);
 const another=await fetch(f.base+'/health'),otherCookie=another.headers.get('set-cookie').split(';')[0];assert.equal((await post({...headers,cookie:otherCookie})).status,409);
 assert.equal((await fetch(f.base+'/jobs',{method:'POST',headers})).status,423);
});
test('real context revision guard re-reads persistence after a long inspection',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'import-context-')),store=await createContextStore({root});t.after(()=>store.close());
 await assert.rejects(store.withRevision(owner,'project',0,async()=>{const target=path.join(root,sha(owner+'\0project'));await fs.mkdir(target);await fs.writeFile(path.join(target,'state.json'),'corrupt concurrent context');return {ready:true};}));
});
for(const image of ['source.png','normalized.png'])test('image changed during current engine verification aborts '+image,async t=>{
 const f=await fixture(t);await assert.rejects(f.run(f.principal,f.expected,binding=>api.inspectImportedPageInputs({binding,source:f.source,readCurrentOcr:async args=>{const out=await f.readCurrentOcr(args);await fs.writeFile(path.join(f.dir,image),'changed during inspection');return out;}})));
});
