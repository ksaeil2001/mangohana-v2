import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {once} from 'node:events';import * as stores from '../../apps/engine/store.mjs';
test('translation-only app connects the real context/store path and never opens a model queue',async t=>{
 assert.equal(typeof stores.createTranslationReviewApplication,'function','missing translation-only application entry');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-app-')),origin='http://127.0.0.1:5173';
 const app=await stores.createTranslationReviewApplication({dataRoot:root,allowedOrigin:origin});t.after(()=>app.close());app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base='http://127.0.0.1:'+app.server.address().port;
 const initial=await fetch(base+'/translation-reviews/stage14r3'),p=await initial.json(),cookie=initial.headers.get('set-cookie').split(';')[0];assert.equal(initial.status,200);assert.equal(p.importRequired,true);
 const c={documentId:p.target.documentId,approvalToken:p.approvalToken,requestKey:p.requestKey,expectedEditRevision:p.target.editRevision,expectedContextRevision:p.target.contextRevision,sourceSha256:p.sourceSha256,normalizedSha256:p.normalizedSha256,candidateSetSha256:p.candidateSetSha256,selectedSetSha256:p.selectedSetSha256,importAcknowledged:true,riskAcknowledged:true,regions:p.regions.map(r=>({regionId:r.regionId,selectedTranslation:r.selectedUserTranslation}))};
 const r=await fetch(base+'/translation-reviews/stage14r3/apply',{method:'POST',headers:{origin,cookie,'content-type':'application/json','x-mangohana-review-scope':p.sessionScope},body:JSON.stringify(c)});assert.equal(r.status,200);const saved=await r.json();assert.equal(saved.document.regions.length,13);assert.equal(saved.document.receipt.accountAuth,'NOT_AVAILABLE');
 const denied=await fetch(base+'/jobs',{method:'POST',headers:{origin,cookie}});assert.equal(denied.status,423);assert.equal((await denied.json()).code,'IMAGE_EXECUTION_NOT_AUTHORIZED');
 const health=await (await fetch(base+'/health')).json();assert.equal(health.imageExecutionAuthorized,false);assert.equal(health.mode,'translation-review-only');
 const reread=await (await fetch(base+'/translation-review-pages/'+p.target.documentId,{headers:{cookie}})).json();assert.deepEqual(reread.document,saved.document);
});

test('saved approval preview stays readable while input inspection holds the context revision guard',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-read-')),origin='http://127.0.0.1:5173';
 let release,entered;const held=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
 const app=await stores.createTranslationReviewApplication({dataRoot:root,allowedOrigin:origin,inspectImportedPage:async()=>{entered();await held;return {executionAuthorized:false};}});
 t.after(()=>app.close());app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base='http://127.0.0.1:'+app.server.address().port;
 const initial=await fetch(base+'/translation-reviews/stage14r3'),p=await initial.json(),cookie=initial.headers.get('set-cookie').split(';')[0];
 const headers={origin,cookie,'content-type':'application/json','x-mangohana-review-scope':p.sessionScope};
 const command={documentId:p.target.documentId,approvalToken:p.approvalToken,requestKey:p.requestKey,expectedEditRevision:0,expectedContextRevision:0,sourceSha256:p.sourceSha256,normalizedSha256:p.normalizedSha256,candidateSetSha256:p.candidateSetSha256,selectedSetSha256:p.selectedSetSha256,importAcknowledged:true,riskAcknowledged:true,regions:p.regions.map(r=>({regionId:r.regionId,selectedTranslation:r.selectedUserTranslation}))};
 const applied=await fetch(base+'/translation-reviews/stage14r3/apply',{method:'POST',headers,body:JSON.stringify(command)});assert.equal(applied.status,200);const {document:saved}=await applied.json();
 const file=path.join(root,'translation-reviews',saved.documentId+'.json'),before=await fs.readFile(file);
 const inspection=fetch(base+'/translation-review-pages/'+saved.documentId+'/inspect-inputs',{method:'POST',headers,body:JSON.stringify({expectedEditRevision:1,expectedContextRevision:0,eventSha256:saved.receipt.eventSha256,selectedSetSha256:saved.receipt.selectedSetSha256})});
 try{
  await started;
  // A bounded read must finish before releasing the inspection, without a larger proxy timeout.
  const reread=await fetch(base+'/translation-review-pages/'+saved.documentId,{headers:{cookie},signal:AbortSignal.timeout(1500)});assert.equal(reread.status,200);assert.deepEqual((await reread.json()).document,saved);
  const preview=await fetch(base+'/translation-reviews/stage14r3',{headers:{cookie},signal:AbortSignal.timeout(1500)});assert.equal(preview.status,200);const current=await preview.json();
  assert.equal(current.importRequired,false);assert.deepEqual(current.document,saved);assert.equal(current.target.contextRevision,0);assert.equal(current.document.regions.length,13);
  assert.equal(preview.headers.get('set-cookie'),null);assert.deepEqual(await fs.readFile(file),before);
 }finally{release();const response=await inspection;assert.equal(response.status,200);await response.json();}
});
