// Synthetic disk/report fixtures only. These tests perform ZERO actual AI calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {reportToStudioResult} from '../../apps/engine/result.mjs';
import {cacheProof} from '../../apps/engine/verify-warm.cjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const errorCode=pattern=>error=>pattern.test(error.code??'');
const testRoot=path.resolve('E:/Dev/Outputs/MangohanaV2-20261111/tests/warm-export-'+Date.now()+'-'+randomUUID().slice(0,6));
const images=[Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=','base64'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLeUAAAAASUVORK5CYII=','base64')];
let api;try{api=await import('../../scripts/v2/export-warm-pages.mjs');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;api={exportWarmPages:async()=>({pages:[]})};}
const json=(file,value)=>fs.writeFile(file,JSON.stringify(value),{flag:'wx'});
async function rewrite(file,value){await fs.writeFile(file,JSON.stringify(value));}
async function load(file){return JSON.parse(await fs.readFile(file,'utf8'));}
async function absent(file){await assert.rejects(fs.access(file),{code:'ENOENT'});}
async function fixture(){
 const directory=path.join(testRoot,randomUUID());await fs.mkdir(path.join(directory,'inputs'),{recursive:true});await fs.mkdir(path.join(directory,'jobs'));
 const runId=randomUUID(),owner=hash(runId),projectId='synthetic-'+runId,inputs=[],rows=[];
 for(let index=0;index<2;index++){
  const ordinal=index+1,jobId=randomUUID(),pageId=randomUUID(),bytes=images[index],digest=hash(bytes),jobDirectory=path.join(directory,'jobs',jobId),pageDirectory=path.join(directory,'page-'+String(ordinal).padStart(2,'0')),originalPath=path.join(directory,'inputs','original-'+ordinal+'.png'),copyPath=path.join(directory,'inputs','copy-'+ordinal+'.png');
  await fs.mkdir(jobDirectory);await fs.mkdir(pageDirectory);await fs.writeFile(originalPath,bytes);await fs.writeFile(copyPath,bytes);
  const requestId='synthetic-request-'+ordinal,fingerprint=hash('fixture-'+ordinal),report={version:1,jobId,evidenceKind:'LOCAL_ENGINE_CANDIDATE',originalPreserved:true,userApproved:false,manualCorrections:0,sourceLanguage:'ja',image:{width:1,height:1,originalMime:'image/png'},hashes:{original:digest,normalized:digest,cleaned:digest,candidate:digest,mask:digest},warnings:['SYNTHETIC_FIXTURE_NOT_AI'],ocr:{speechBubbles:[{id:'region',text:'合成入力'}]},lines:[{id:'region',sourceText:'合成入力',aiTranslation:'합성 번역',order:1}],translations:[{id:'region',engine:'local_ai',usedExactTm:false,requestId,requestScope:'page',requestedContextFingerprint:fingerprint,returnedContextFingerprint:fingerprint,responseIdentity:'validated_page_json_ids',modelHttpRequests:1,qaReport:{issues:[]}}],translationRequests:[{requestId,scope:'page',regionIds:['region'],httpRequests:1,usedImageContext:true,contextFingerprint:fingerprint,imageSha256:digest}],typesetting:{layoutReport:[{id:'region',bbox:{x:0,y:0,width:1,height:1},sourceBbox:{x:0,y:0,width:1,height:1},fontSizePx:14,fontFamily:'Synthetic fixture',productionFontLoaded:true,glyphFontLoaded:true}]},measurements:{elapsedMs:0}};
  const reportBytes=Buffer.from(JSON.stringify(report)),state={version:1,id:jobId,status:'completed',owner,projectId,pageId,pageNumber:ordinal,sourceLanguage:'ja',sourceSha256:digest,reportSha256:hash(reportBytes),mime:'image/png',width:1,height:1,createdAt:'2026-11-11T00:00:00.000Z',updatedAt:'2026-11-11T00:00:01.000Z'};
  await json(path.join(jobDirectory,'state.json'),state);await fs.writeFile(path.join(jobDirectory,'report.json'),reportBytes);await fs.writeFile(path.join(jobDirectory,'engine-report.json'),reportBytes);for(const name of ['source.png','normalized.png','cleaned.png','candidate.png','removal-mask.png'])await fs.writeFile(path.join(jobDirectory,name),bytes);
  await fs.writeFile(path.join(pageDirectory,'candidate.png'),bytes);await json(path.join(pageDirectory,'studio-result.json'),reportToStudioResult(report,{cleanedPng:bytes,candidatePng:bytes}));
  const row={ordinal,jobId,pageId,sourceSha256:digest,status:'completed',evidenceVerified:true,manualCorrections:0,qualityStatus:'pending',jobDirectory,pageDirectory,reportSha256:hash(reportBytes),candidateSha256:digest,regions:1,regionIds:['region'],requestIds:[requestId],modelHttpRequests:1};await json(path.join(pageDirectory,'evidence.json'),row);rows.push(row);inputs.push({ordinal,pageId,name:'synthetic-'+ordinal+'.png',originalPath,copyPath,sourceSha256:digest,bytes:bytes.length,width:1,height:1});
 }
 const plan={version:1,scope:'TWO_DISTINCT_JAPANESE_TECHNICAL_SAMPLES',runRoot:directory,runId,ownerScope:owner,projectId,inputs,manualCorrections:0,browserFlowVerified:false,storyChronologyVerified:false,withContext:false};
 const records=['OCR_RUNTIME','LLM_SERVER'].map((role,index)=>({recordId:'synthetic-owned-'+index,pid:400+index,role,birthJobId:rows[0].jobId}));
 for(const [index,row]of rows.entries()){row.beforeProcesses=index?records:[];row.afterProcesses=records;row.runtimeEvents=['ocr','translation'].map(kind=>({phase:kind+'_runtime_cache',mode:index?'warm':'cold',generation:1,identity:hash(kind)}));await rewrite(path.join(row.pageDirectory,'evidence.json'),row);}
 const inner={version:1,scope:plan.scope,status:'completed',runId,pages:rows,manualCorrections:0,browserFlowVerified:false,storyChronologyVerified:false,cleanupConfirmed:true,cacheReuse:cacheProof(rows)};
 const warm={...inner,status:'verified_runtime_reuse',innerCleanupConfirmed:true,sourceUnchanged:true,osJobCleanupConfirmed:true,forcedTermination:false};
 await json(path.join(directory,'kernel-job-summary.json'),{phase:'complete',runId,rootExitCode:0,supervisorExitCode:0,supervisorClosed:true,supervisorSignal:null,failure:null,kernelCleanupConfirmed:true,activeProcessesAfter:0});
 await json(path.join(directory,'warm-plan.json'),plan);await json(path.join(directory,'verification-inner.json'),inner);await json(path.join(directory,'verification-warm.json'),warm);
 return {directory,plan,inner,warm,rows,async save(){await rewrite(path.join(directory,'warm-plan.json'),plan);await rewrite(path.join(directory,'verification-inner.json'),inner);await rewrite(path.join(directory,'verification-warm.json'),warm);for(const row of rows)if(row.evidenceVerified)await rewrite(path.join(row.pageDirectory,'evidence.json'),row);}};
}

test('two synthetic completed warm jobs export through exact Sites source and preserve candidate bytes',async()=>{
 const f=await fixture(),result=await api.exportWarmPages(f.directory);assert.equal(result.pages.length,2);assert.equal(result.scope,'SOURCE_EXPORT_FROM_REAL_WARM_PIPELINE');assert.equal(result.newAiCalls,0);assert.equal(result.browserFlowVerified,false);assert.equal(result.storyChronologyVerified,false);for(const [index,page]of result.pages.entries()){assert.equal(page.jobId,f.rows[index].jobId);assert.equal(page.sourceExportVerified,true);assert.equal(page.projectImportVerified,true);assert.equal(page.exportSha256,page.importedExportSha256);assert.deepEqual(await fs.readFile(page.output),images[index]);assert.equal(Object.keys(page.sourceExportCodeHashes).length,3);assert.equal((await load(path.join(path.dirname(page.output),'project.trio'))).format,'trio-studio-v1');}await absent(path.join(f.directory,'verification-engine.json'));await absent(path.join(f.directory,'input.json'));
});
test('source/copy/preserved source tampering fails before any page export is written',async()=>{
 for(const target of ['original','copy','preserved']){const f=await fixture(),sample=f.plan.inputs[1],file=target==='original'?sample.originalPath:target==='copy'?sample.copyPath:path.join(f.rows[1].jobDirectory,'source.png');await fs.writeFile(file,images[0]);await assert.rejects(api.exportWarmPages(f.directory),errorCode(/SOURCE/));await absent(path.join(f.rows[0].pageDirectory,'source-export'));}
});
test('report digest and foreign job/page bindings are rejected without new output',async()=>{
 for(const defect of ['report','job','page','owner']){const f=await fixture();if(defect==='report')await fs.appendFile(path.join(f.rows[1].jobDirectory,'report.json'),' ');if(defect==='job'){f.rows[1].jobDirectory=f.rows[0].jobDirectory;await f.save();}if(defect==='page'){f.rows[1].pageDirectory=f.rows[0].pageDirectory;f.warm.pages=f.rows;f.inner.pages=f.rows;await rewrite(path.join(f.directory,'verification-warm.json'),f.warm);await rewrite(path.join(f.directory,'verification-inner.json'),f.inner);}if(defect==='owner'){const file=path.join(f.rows[1].jobDirectory,'state.json'),state=await load(file);state.owner='f'.repeat(64);await rewrite(file,state);}await assert.rejects(api.exportWarmPages(f.directory),errorCode(/EVIDENCE|BINDING/));await absent(path.join(f.directory,'page-01','source-export'));}
});
test('every output destination is checked before the first PNG/TRIO write',async()=>{
 const f=await fixture(),conflict=path.join(f.rows[1].pageDirectory,'source-export');await fs.mkdir(conflict);await fs.writeFile(path.join(conflict,'exported.png'),'preserve me');await assert.rejects(api.exportWarmPages(f.directory),/CONFLICT/);assert.equal(await fs.readFile(path.join(conflict,'exported.png'),'utf8'),'preserve me');await absent(path.join(f.rows[0].pageDirectory,'source-export'));
});
test('a genuine completed evidence row can export when the other row failed, without promoting the run',async()=>{
 const f=await fixture();Object.assign(f.rows[1],{status:'failed',evidenceVerified:false,code:'SYNTHETIC_FAILURE'});f.inner.status='partial';f.warm.status='partial';await f.save();const result=await api.exportWarmPages(f.directory);assert.equal(result.pages.length,1);assert.equal(result.pipelineStatus,'partial');assert.equal(result.pipelineComplete,false);assert.equal(result.pages[0].jobId,f.rows[0].jobId);await absent(path.join(f.rows[1].pageDirectory,'source-export'));
});
test('changed warm/page evidence cannot silently alter the run-to-job association',async()=>{
 const f=await fixture();f.warm.pages[0]={...f.rows[0],reportSha256:'0'.repeat(64)};await rewrite(path.join(f.directory,'verification-warm.json'),f.warm);await assert.rejects(api.exportWarmPages(f.directory),/BINDING|EVIDENCE/);await absent(path.join(f.rows[0].pageDirectory,'source-export'));
});
test('a previous warm source export is never overwritten on resume',async()=>{
 const f=await fixture(),first=await api.exportWarmPages(f.directory),before=await fs.readFile(first.pages[0].output);await assert.rejects(api.exportWarmPages(f.directory),/CONFLICT/);assert.deepEqual(await fs.readFile(first.pages[0].output),before);
});
test('shared legacy writer preserves same-content resume and checks all conflicts before writes',async()=>{
 const legacy=await import('../../scripts/v2/export-one-page.mjs');assert.equal(typeof legacy.writeSourceExport,'function');const directory=path.join(testRoot,randomUUID());await fs.mkdir(directory,{recursive:true});const outputs=[['exported.png',images[0]],['project.trio',Buffer.from('synthetic')]];await legacy.writeSourceExport(directory,outputs);await legacy.writeSourceExport(directory,outputs);await fs.writeFile(path.join(directory,'project.trio'),'old private content');await assert.rejects(legacy.writeSourceExport(directory,[['new-file',Buffer.from('new')],...outputs]),{code:'EXPORT_CONFLICT'});await absent(path.join(directory,'new-file'));assert.equal(await fs.readFile(path.join(directory,'project.trio'),'utf8'),'old private content');
});
test('source-only guard denies child processes and external fetch while the exact Sites data-URL path exports',async()=>{
 assert.equal(typeof api.installSourceOnlyGuard,'function');const guard=api.installSourceOnlyGuard();try{const f=await fixture(),result=await api.exportWarmPages(f.directory);assert.equal(result.pages.length,2);assert.deepEqual(guard.proof(),{childProcessRequests:0,externalFetchRequests:0,childProcessBoundary:'DENIED',externalFetchBoundary:'DENIED'});const {default:childProcess}=await import('node:child_process');assert.throws(()=>childProcess.spawn(process.execPath,[]),{code:'EXPORT_NATIVE_PROCESS_DENIED'});await assert.rejects(fetch('https://invalid.example/'),{code:'EXPORT_EXTERNAL_FETCH_DENIED'});assert.equal(guard.proof().childProcessRequests,1);assert.equal(guard.proof().externalFetchRequests,1);}finally{guard.restore();}
});

test('coherent report digests still cannot bypass OCR/layout/font or PNG header evidence',async()=>{
 for(const defect of ['OCR source','layout ID','font','mask header']){
  const f=await fixture(),row=f.rows[1],file=path.join(row.jobDirectory,'report.json'),report=await load(file);
  if(defect==='OCR source')report.ocr.speechBubbles[0].text='別の原文';if(defect==='layout ID')report.typesetting.layoutReport[0].id='foreign';if(defect==='font')report.typesetting.layoutReport[0].productionFontLoaded=false;if(defect==='mask header'){const bytes=Buffer.from(images[1]);bytes.writeUInt32BE(2,16);await fs.writeFile(path.join(row.jobDirectory,'removal-mask.png'),bytes);report.hashes.mask=hash(bytes);}
  const body=Buffer.from(JSON.stringify(report));await fs.writeFile(file,body);await fs.writeFile(path.join(row.jobDirectory,'engine-report.json'),body);const stateFile=path.join(row.jobDirectory,'state.json'),state=await load(stateFile);state.reportSha256=hash(body);row.reportSha256=state.reportSha256;await rewrite(stateFile,state);await f.save();await assert.rejects(api.exportWarmPages(f.directory),errorCode(/EVIDENCE|BINDING/));await absent(path.join(f.rows[0].pageDirectory,'source-export'));
 }
});

async function attachContext(f,{consumed=true}={}){
 const row=f.rows[1],stateFile=path.join(row.jobDirectory,'state.json'),state=await load(stateFile),report=await load(path.join(row.jobDirectory,'report.json'));
 const context={version:1,owner:state.owner,projectId:state.projectId,sourceSha256:state.sourceSha256,pageNumber:state.pageNumber,glossaryRevision:3};
 const bytes=Buffer.from(JSON.stringify(context));state.contextSha256=hash(bytes);state.contextPageNumber=context.pageNumber;
 report.translationContext={snapshotSha256:state.contextSha256,glossaryRevision:3,consumed};
 for(const request of report.translationRequests)request.contextSnapshotSha256=state.contextSha256;
 await fs.writeFile(path.join(row.jobDirectory,'translation-context.json'),bytes);
 async function commit(){const body=Buffer.from(JSON.stringify(report));await fs.writeFile(path.join(row.jobDirectory,'report.json'),body);await fs.writeFile(path.join(row.jobDirectory,'engine-report.json'),body);state.reportSha256=hash(body);row.reportSha256=state.reportSha256;await rewrite(stateFile,state);await f.save();}
 await commit();return {row,state,report,context,stateFile,commit};
}

test('context-enabled exports accept bound snapshots and preserve the immutable dispatch number',async()=>{
 for(const consumed of [true,false]){const f=await fixture(),c=await attachContext(f,{consumed});c.state.pageNumber=2;c.state.contextPageNumber=1;c.context.pageNumber=1;const bytes=Buffer.from(JSON.stringify(c.context));c.state.contextSha256=hash(bytes);c.report.translationContext.snapshotSha256=c.state.contextSha256;for(const request of c.report.translationRequests)request.contextSnapshotSha256=c.state.contextSha256;await fs.writeFile(path.join(c.row.jobDirectory,'translation-context.json'),bytes);await c.commit();assert.equal((await api.exportWarmPages(f.directory)).pages.length,2);}
});

test('missing, altered, or foreign context and false consumption receipts fail before any export',async()=>{
 for(const defect of ['missing','changed bytes','foreign owner','foreign project','foreign source','dispatch number','snapshot receipt','revision receipt','consumption type','missing request snapshot','foreign request snapshot']){
  const f=await fixture(),c=await attachContext(f),file=path.join(c.row.jobDirectory,'translation-context.json');
  if(defect==='missing')await fs.unlink(file);
  else if(defect==='changed bytes')await fs.appendFile(file,' ');
  else if(defect.startsWith('foreign ')&&!defect.includes('request')){const key={'foreign owner':'owner','foreign project':'projectId','foreign source':'sourceSha256'}[defect];c.context[key]='foreign';const bytes=Buffer.from(JSON.stringify(c.context));await fs.writeFile(file,bytes);c.state.contextSha256=hash(bytes);c.report.translationContext.snapshotSha256=c.state.contextSha256;for(const request of c.report.translationRequests)request.contextSnapshotSha256=c.state.contextSha256;}
  else if(defect==='dispatch number')c.state.contextPageNumber=1;
  else if(defect==='snapshot receipt')c.report.translationContext.snapshotSha256='0'.repeat(64);
  else if(defect==='revision receipt')c.report.translationContext.glossaryRevision=4;
  else if(defect==='consumption type')c.report.translationContext.consumed='true';
  else if(defect==='missing request snapshot')delete c.report.translationRequests[0].contextSnapshotSha256;
  else c.report.translationRequests[0].contextSnapshotSha256='0'.repeat(64);
  await c.commit();await assert.rejects(api.exportWarmPages(f.directory),{code:'EXPORT_EVIDENCE_INVALID'});await absent(path.join(f.rows[0].pageDirectory,'source-export'));
 }
});

test('a completed pipeline claim requires consistent cache, source, inner, and kernel cleanup evidence',async()=>{
 for(const defect of ['outer cleanup','inner status','inner cleanup','OS cleanup','forced stop','source drift','cache flag','cache omission','cache identity','kernel active']){
  const f=await fixture();
  if(defect==='outer cleanup')f.warm.cleanupConfirmed=false;
  if(defect==='inner status')f.inner.status='failed';
  if(defect==='inner cleanup')f.inner.cleanupConfirmed=false;
  if(defect==='OS cleanup')f.warm.osJobCleanupConfirmed=false;
  if(defect==='forced stop')f.warm.forcedTermination=true;
  if(defect==='source drift')f.warm.sourceUnchanged=false;
  if(defect==='cache flag')f.warm.cacheReuse={verified:false};
  if(defect==='cache omission')delete f.warm.cacheReuse;
  if(defect==='cache identity')f.warm.cacheReuse={...f.warm.cacheReuse,ocr:{...f.warm.cacheReuse.ocr,identity:'0'.repeat(64)}};
  if(defect==='kernel active')await rewrite(path.join(f.directory,'kernel-job-summary.json'),{phase:'complete',runId:f.plan.runId,rootExitCode:0,kernelCleanupConfirmed:true,activeProcessesAfter:1});
  await f.save();await assert.rejects(api.exportWarmPages(f.directory),{code:'EXPORT_WARM_COMPLETION_INVALID'});await absent(path.join(f.rows[0].pageDirectory,'source-export'));
 }
});

async function translationWarmFixture(){
 const f=await fixture(),mode='OCR_COLD_TRANSLATION_WARM';f.plan.runtimeReuseMode=mode;f.plan.refineConnectedOcr=false;f.plan.configPath=path.join(f.directory,'candidate-config.json');
 const config={runRoot:f.directory,profileRoot:path.join(f.directory,'profile'),dataRoot:path.join(f.directory,'jobs'),reuseOcrRuntime:false,reuseTranslationServer:true,refineConnectedOcr:false};const configBytes=Buffer.from(JSON.stringify(config));await fs.writeFile(f.plan.configPath,configBytes);f.plan.configSha256=hash(configBytes);
 const llm={recordId:'synthetic-kept-llm',pid:501,role:'LLM_SERVER',birthJobId:f.rows[0].jobId,closed:false,bornAt:'2026-11-11T00:00:05.000Z'};
 for(const [index,row]of f.rows.entries()){const seconds=index?20:0,at=offset=>new Date(Date.UTC(2026,10,11,0,0,seconds+offset)).toISOString();Object.assign(row,{startedAt:at(0),finishedAt:at(9),beforeProcesses:index?[llm]:[],afterProcesses:[llm],jobProcesses:[{recordId:'synthetic-closed-ocr-'+index,pid:510+index,role:'OCR_RUNTIME',birthJobId:row.jobId,bornAt:at(1),closed:true,closedAt:at(4),code:0,errorCode:null},...(index?[]:[llm])],runtimeEvents:[{phase:'ocr_runtime_cache',mode:'disabled',at:at(0)},{phase:'ocr_status_start',at:at(1)},{phase:'ocr_status_complete',ready:true,durationMs:1,at:at(2)},{phase:'ocr_recognition_start',at:at(2)},{phase:'ocr_recognition_complete',speechRegions:1,durationMs:1,at:at(3)},{phase:'translation_runtime_cache',mode:index?'warm':'cold',generation:1,identity:hash('same-llm'),at:at(5)}]});}
 Object.assign(f.inner,{runtimeReuseMode:mode,refineConnectedOcr:false,cacheReuse:cacheProof(f.rows,{runtimeReuseMode:mode})});Object.assign(f.warm,{runtimeReuseMode:mode,refineConnectedOcr:false,status:'verified_translation_reuse',cacheReuse:f.inner.cacheReuse});await f.save();return {...f,config};
}
test('translation-only warm export recomputes its own mode proof and never labels OCR as reused',async()=>{
 const f=await translationWarmFixture(),result=await api.exportWarmPages(f.directory);assert.equal(result.pipelineComplete,true);assert.equal(result.pipelineStatus,'verified_translation_reuse');assert.equal(result.runtimeReuseMode,'OCR_COLD_TRANSLATION_WARM');assert.equal(result.pages.length,2);assert.equal(result.newAiCalls,0);for(const [index,page]of result.pages.entries())assert.deepEqual(await fs.readFile(page.output),images[index]);
});
test('translation-only completion rejects relabelled mode, config drift and missing independent OCR cleanup',async()=>{
 for(const defect of ['legacy status','outer mode','inner mode','OCR reuse config','LLM cold config','config digest','missing OCR lifecycle','OCR not closed','cache receipt','kernel cleanup','source drift']){const f=await translationWarmFixture();
  if(defect==='legacy status')f.warm.status='verified_runtime_reuse';
  if(defect==='outer mode')f.warm.runtimeReuseMode='OCR_WARM_TRANSLATION_WARM';
  if(defect==='inner mode')f.inner.runtimeReuseMode='OCR_WARM_TRANSLATION_WARM';
  if(defect==='OCR reuse config'||defect==='LLM cold config'){if(defect==='OCR reuse config')f.config.reuseOcrRuntime=true;else f.config.reuseTranslationServer=false;const bytes=Buffer.from(JSON.stringify(f.config));await fs.writeFile(f.plan.configPath,bytes);f.plan.configSha256=hash(bytes);}
  if(defect==='config digest')await fs.appendFile(f.plan.configPath,' ');
  if(defect==='missing OCR lifecycle')delete f.rows[1].jobProcesses;
  if(defect==='OCR not closed')f.rows[1].jobProcesses[0].closed=false;
  if(defect==='cache receipt')f.warm.cacheReuse={verified:true};
  if(defect==='kernel cleanup')await rewrite(path.join(f.directory,'kernel-job-summary.json'),{phase:'complete',runId:f.plan.runId,rootExitCode:0,kernelCleanupConfirmed:false,activeProcessesAfter:0});
  if(defect==='source drift')f.warm.sourceUnchanged=false;
  await f.save();await assert.rejects(api.exportWarmPages(f.directory),errorCode(/COMPLETION|CONFIGURATION/));await absent(path.join(f.rows[0].pageDirectory,'source-export'));
 }
});
test('OCR-cold partial completion preserves one real evidence row without promoting the run',async()=>{
 const f=await translationWarmFixture();Object.assign(f.rows[1],{status:'failed',evidenceVerified:false,code:'SYNTHETIC_SECOND_FAILURE'});f.inner.status='partial';f.warm.status='partial';await f.save();const result=await api.exportWarmPages(f.directory);assert.equal(result.pipelineComplete,false);assert.equal(result.pipelineStatus,'partial');assert.equal(result.pages.length,1);assert.equal(result.runtimeReuseMode,'OCR_COLD_TRANSLATION_WARM');
});

test('verified export rejects root/supervisor or recorded failure after otherwise complete inner evidence',async()=>{
 for(const factory of [fixture,translationWarmFixture])for(const defect of ['root exit','supervisor exit','supervisor open','supervisor signal','kernel failure','warm failure','inner failure']){
  const f=await factory(),kernelFile=path.join(f.directory,'kernel-job-summary.json'),kernel=await load(kernelFile);if(defect==='root exit')kernel.rootExitCode=1;if(defect==='supervisor exit')kernel.supervisorExitCode=1;if(defect==='supervisor open')kernel.supervisorClosed=false;if(defect==='supervisor signal')kernel.supervisorSignal='SIGTERM';if(defect==='kernel failure')kernel.failure='WARM_JOB_RECEIPT_FAILURE';if(defect==='warm failure')f.warm.failure='LATE_NATIVE_FAILURE';if(defect==='inner failure')f.inner.failure='LATE_INNER_FAILURE';await rewrite(kernelFile,kernel);await f.save();await assert.rejects(api.exportWarmPages(f.directory),{code:'EXPORT_WARM_COMPLETION_INVALID'});await absent(path.join(f.rows[0].pageDirectory,'source-export'));
 }
});
