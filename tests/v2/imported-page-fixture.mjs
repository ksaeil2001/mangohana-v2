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
export async function fixture(t,{http=false,tempRoot=os.tmpdir()}={}){
 const root=await fs.mkdtemp(path.join(tempRoot,'imported-review-')),dir=path.join(root,'source');await fs.mkdir(dir);
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
