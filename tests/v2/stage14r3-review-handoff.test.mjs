import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {tsImport} from 'tsx/esm/api';
import {makeHumanReviewTemplate,inspectHumanReview} from '../../scripts/v2/stage14r2-review.mjs';
import {makeReviewTemplate,inspectReviewSubmission,renderReviewHtml} from '../../scripts/v2/stage14r3-review.mjs';
import {reportToStudioResult} from '../../apps/engine/result.mjs';
const require=createRequire(import.meta.url);
const {packetHash,applyHumanTranslationReview,assertReviewExecution,assertReviewedReport,requireReviewedOcr,resolveEngineReview}=require('../../packages/ai-engine/quality/human-translation-review.cjs');
const sha=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
function fixture(){
 const scope={owner:'a'.repeat(64),projectId:'project',pageId:'page',pageNumber:1,sourceSha256:'b'.repeat(64)};
 const bindings={sourceSha256:scope.sourceSha256,inputFingerprint:'c'.repeat(64),normalizedSha256:'d'.repeat(64),candidateSetSha256:'e'.repeat(64),baseEditRevision:0,processingGeneration:2};
 const regions=Array.from({length:13},(_,i)=>({pageId:scope.pageId,regionId:'region-'+(i+1),order:i+1,sourceText:'原文'+(i+1),rawOcrText:'原文'+(i+1),translatedText:'실제 후보 '+(i+1),sourceTextSha256:sha('原文'+(i+1)),translationSha256:sha('실제 후보 '+(i+1)),origin:i<5?'NEW_B5_CANDIDATE':'REUSED_HISTORICAL_A13',sourceLineIds:['line-'+i],bbox:{x:0,y:0,width:.1,height:.1},sourceImage:{dataUrl:'data:image/png;base64,aA=='},context:{previous:[],next:[]},signals:[],analysis:{suggestedTranslation:'AI 제안 '+(i+1),note:'합성 제안'},humanReview:{status:'HUMAN_REVIEW_PENDING'}}));
 const packet={schemaVersion:'stage14r2-residue-review-v1',status:'HUMAN_REVIEW_PENDING',scope,bindings,allRegionIds:regions.map(r=>r.regionId),allResponses:[],regions};packet.packetSha256=packetHash(packet);
 const submission=makeReviewTemplate(packet);
 const current={...scope,ownerScope:scope.owner,normalizedSha256:bindings.normalizedSha256,candidateSetSha256:bindings.candidateSetSha256,editRevision:0,processingGeneration:2,contextRevision:null};
 const lines=regions.map(r=>({id:r.regionId,sourceText:r.sourceText,sourceLineIds:r.sourceLineIds,order:r.order,pageNumber:1,ocrEditStatus:'ai_proposed',typesetting:{fontSizeRatio:1}}));
 const approve=()=>{
  submission.reviewer='synthetic-user';submission.submittedAt='2026-11-14T00:00:00Z';submission.status='HUMAN_SUBMISSION_UNVERIFIED';
  submission.stage14r3.applicationApprovalRequested=true;submission.stage14r3.reviewScope='13개 OCR·번역·인접 대사';submission.stage14r3.remainingUncertainties='최종 이미지 미검수';
  for(const r of submission.regions)Object.assign(r,{decision:'ACCEPT_AS_IS',confirmedByHuman:true,rationale:'합성 입력 검증',selectedTranslation:r.translatedText,selectionOrigin:'MODEL_CANDIDATE'});
  return {kind:'USER_TRANSLATION_APPLICATION',packetSha256:packet.packetSha256,submissionSha256:sha(submission),reviewer:submission.reviewer,approvedAt:submission.submittedAt,evidenceId:'synthetic-event'};
 };
 return {packet,submission,current,lines,approve};
}
test('R3 extends the R2 JSON without preselecting an approval or promoting an independent answer',()=>{
 const f=fixture(),t=f.submission;assert.equal(inspectHumanReview(f.packet,t).status,'HUMAN_REVIEW_PENDING');assert.equal(inspectReviewSubmission(f.packet,JSON.parse(JSON.stringify(t))).completed,0);
 for(const r of t.regions){assert.equal(r.decision,null);assert.equal(r.selectedTranslation,null);assert.equal(r.confirmedByHuman,false);}
 assert.equal(t.stage14r3.applicationApprovalRequested,false);assert.equal(t.stage14r3.executionAuthorized,false);assert.equal(t.stage14r3.independentGroundTruthVerified,false);
 assert.equal(makeHumanReviewTemplate(f.packet).schemaVersion,t.schemaVersion);
});
test('all thirteen actual values and reused origins appear with empty user selections',()=>{
 const f=fixture(),html=renderReviewHtml(f.packet);for(const r of f.packet.regions){assert.ok(html.includes(r.regionId));assert.ok(html.includes(r.translatedText));}
 assert.equal((html.match(/data-region=/g)??[]).length,13);assert.ok(html.includes('과거 A13 재사용'));assert.ok(html.includes('새 B5'));assert.ok(html.includes('이번에 사용할 후보'));assert.ok(html.includes('type="file"'));
});
test('a self-declared completed JSON remains unverified without trusted user evidence',()=>{
 const f=fixture();f.approve();assert.equal(inspectReviewSubmission(f.packet,f.submission).completed,13);
 assert.throws(()=>applyHumanTranslationReview({...f}),{code:'HUMAN_REVIEW_AUTHORITY_REQUIRED'});
});
test('a complete authenticated review preserves AI, applies user text first, and creates an explicit render projection atomically',async()=>{
 const f=fixture(),authority=f.approve();Object.assign(f.submission.regions[0],{decision:'CORRECT_TRANSLATION',correctedTranslation:'AI 제안 1',selectedTranslation:'AI 제안 1',selectionOrigin:'AI_SUGGESTION_ADOPTED',editRevision:1});authority.submissionSha256=sha(f.submission);
 const before=structuredClone(f.lines),out=applyHumanTranslationReview({...f,authority});
 assert.deepEqual(f.lines,before);assert.equal(out.lines[0].aiTranslation,'실제 후보 1');assert.equal(out.lines[0].userTranslation,'AI 제안 1');assert.equal(out.renderLines[0].aiTranslation,'AI 제안 1');assert.equal(out.renderLines[0].userTranslation,undefined);
 assert.equal(out.receipt.independentGroundTruthVerified,false);assert.equal(out.receipt.executionAuthorized,false);assert.equal(out.receipt.selections[0].selectionOrigin,'AI_SUGGESTION_ADOPTED');assert.equal(out.receipt.selections.length,13);
 const {validateCandidateSourceSnapshot}=await tsImport('../../packages/ai-engine/vendor/trio/scripts/local-preview/renderer.ts',import.meta.url);
 assert.doesNotThrow(()=>validateCandidateSourceSnapshot(out.renderLines,before));assert.throws(()=>validateCandidateSourceSnapshot(out.lines,before));
 const wrong=structuredClone(out.renderLines);wrong[0].sourceText='외부 원문';assert.throws(()=>validateCandidateSourceSnapshot(wrong,before));
});
for(const [label,mutate] of [
 ['missing',f=>f.submission.regions.pop()],['duplicate',f=>f.submission.regions[12]=structuredClone(f.submission.regions[0])],['unknown',f=>f.submission.regions[0].regionId='foreign'],
 ['wrong-page',f=>f.current.pageId='other'],['wrong-owner',f=>f.current.ownerScope='f'.repeat(64)],['wrong-source',f=>f.current.sourceSha256='f'.repeat(64)],['wrong-candidates',f=>f.current.candidateSetSha256='f'.repeat(64)],
 ['stale-edit',f=>f.current.editRevision=1],['stale-generation',f=>f.current.processingGeneration=3],['wrong-normalized',f=>f.current.normalizedSha256='f'.repeat(64)],
 ['one-pending',f=>{f.submission.regions[12].confirmedByHuman=false;f.submission.status='HUMAN_REVIEW_PENDING';}],['one-context-hold',f=>{f.submission.regions[12].decision='NEEDS_MORE_CONTEXT';f.submission.regions[12].selectedTranslation=null;}],
 ['changed-source-lineage',f=>f.lines[0].sourceLineIds=['foreign']],['current-user-value',f=>f.lines[0].userTranslation='이전 사용자 확정'],
 ['unrequested-application',f=>f.submission.stage14r3.applicationApprovalRequested=false],['forged-ground-truth',f=>f.submission.stage14r3.independentGroundTruthVerified=true],
])test('one '+label+' refuses the entire approval and preserves previous lines',()=>{
 const f=fixture();const authority=f.approve();mutate(f);authority.submissionSha256=sha(f.submission);const before=structuredClone(f.lines);
 assert.throws(()=>applyHumanTranslationReview({...f,authority}));assert.deepEqual(f.lines,before);
});
test('candidate/packet edits cannot reuse the old external approval evidence',()=>{
 const f=fixture(),authority=f.approve();f.packet.regions[0].translatedText='바꿔치기';f.packet.packetSha256=packetHash(f.packet);
 assert.throws(()=>applyHumanTranslationReview({...f,authority}));
});
test('translation approval does not permit execution; a checkpoint miss never becomes an OCR fallback',()=>{
 const f=fixture(),authority=f.approve(),out=applyHumanTranslationReview({...f,authority});
 assert.throws(()=>assertReviewExecution(undefined,{...f.current,outputDirectory:'isolated'},out.receipt),{code:'HUMAN_REVIEW_EXECUTION_REQUIRED'});
 assert.throws(()=>requireReviewedOcr(true,null),{code:'HUMAN_REVIEW_OCR_CHECKPOINT_REQUIRED'});assert.doesNotThrow(()=>requireReviewedOcr(false,null));
 const permit={kind:'USER_SINGLE_PAGE_EXECUTION',evidenceId:'synthetic-execution-event',packetSha256:f.packet.packetSha256,submissionSha256:authority.submissionSha256,outputDirectory:'isolated',maxPages:1,maxRuns:1};
 assert.doesNotThrow(()=>assertReviewExecution(permit,{...f.current,outputDirectory:'isolated'},out.receipt));
 assert.throws(()=>assertReviewExecution(permit,{...f.current,outputDirectory:'other'},out.receipt));
});
test('the final report must preserve the complete reviewed text set and its receipt binding',()=>{
 const f=fixture(),authority=f.approve(),out=applyHumanTranslationReview({...f,authority});
 const report={humanTranslationReview:out.receipt,lines:out.lines,hashes:{original:f.current.sourceSha256,normalized:f.current.normalizedSha256},manualCorrections:13};
 assert.doesNotThrow(()=>assertReviewedReport(report));report.lines[12].userTranslation='바꿔치기';assert.throws(()=>assertReviewedReport(report));
});
test('the engine controller revalidates live revision and cannot replace an approval between render stages',async()=>{
 const f=fixture(),authority=f.approve(),snapshot={...f.current,outputDirectory:'isolated'};
 const executionAuthority={kind:'USER_SINGLE_PAGE_EXECUTION',evidenceId:'exec',packetSha256:f.packet.packetSha256,submissionSha256:authority.submissionSha256,outputDirectory:'isolated',maxPages:1,maxRuns:1};
 const bundle={packet:f.packet,submission:f.submission,authority,current:f.current,executionAuthority};
 const first=await resolveEngineReview({resolve:async()=>bundle,snapshot,lines:f.lines,phase:'translation'});
 assert.equal(first.lines.length,13);bundle.current={...f.current,editRevision:1};
 await assert.rejects(resolveEngineReview({resolve:async()=>bundle,snapshot,lines:f.lines,phase:'before-render',previousReceipt:first.receipt}),{code:'HUMAN_REVIEW_REVISION_CONFLICT'});
});
test('reviewing a flagged sentence requires an explicit scoped disposition and retains the warning rule',()=>{
 const f=fixture();f.packet.regions[1].signals=[{code:'BENEFACTIVE_DIRECTION_RISK'}];f.packet.packetSha256=packetHash(f.packet);f.submission=makeReviewTemplate(f.packet);
 // Use a fresh fixture's approval fields with this newly bound template.
 const s=f.submission;s.reviewer='synthetic-user';s.submittedAt='2026-11-14T00:00:00Z';s.status='HUMAN_SUBMISSION_UNVERIFIED';s.stage14r3.applicationApprovalRequested=true;s.stage14r3.reviewScope='13문장';
 for(const r of s.regions)Object.assign(r,{decision:'ACCEPT_AS_IS',confirmedByHuman:true,rationale:'합성 근거',selectedTranslation:r.translatedText,selectionOrigin:'MODEL_CANDIDATE'});
 const authority={kind:'USER_TRANSLATION_APPLICATION',packetSha256:f.packet.packetSha256,submissionSha256:sha(s),reviewer:s.reviewer,approvedAt:s.submittedAt,evidenceId:'synthetic'};
 assert.throws(()=>applyHumanTranslationReview({...f,authority}),{code:'HUMAN_REVIEW_RISK_UNRESOLVED'});
 s.regions[1].riskDecisions=[{code:'BENEFACTIVE_DIRECTION_RISK',decision:'ACCEPT_THIS_SENTENCE',rationale:'화자는 상대가 공부를 봐주길 바람을 문맥으로 확인'}];authority.submissionSha256=sha(s);
 const out=applyHumanTranslationReview({...f,authority});assert.equal(out.receipt.selections[1].riskDecisions[0].code,'BENEFACTIVE_DIRECTION_RISK');assert.equal(f.packet.regions[1].signals.length,1);
});
test('current engine result conversion uses selected user text, retains AI provenance and refuses missing or contradictory receipts',()=>{
 const f=fixture(),authority=f.approve();Object.assign(f.submission.regions[0],{decision:'CORRECT_TRANSLATION',correctedTranslation:'사용자 확정 수정문',selectedTranslation:'사용자 확정 수정문',selectionOrigin:'USER_EDIT',editRevision:1});authority.submissionSha256=sha(f.submission);const out=applyHumanTranslationReview({...f,authority});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=','base64');
 const imageHash=createHash('sha256').update(png).digest('hex');
 const r={version:1,jobId:'synthetic',evidenceKind:'LOCAL_ENGINE_CANDIDATE',originalPreserved:true,userApproved:false,manualCorrections:13,image:{width:1,height:1},
 hashes:{original:f.current.sourceSha256,normalized:f.current.normalizedSha256,cleaned:imageHash,candidate:imageHash},lines:out.lines,humanTranslationReview:out.receipt,
 ocr:{speechBubbles:out.lines.map(l=>({id:l.id,productionOcrProvenance:{sourceDetectionIds:l.sourceLineIds}}))},
 translations:out.lines.map(l=>({id:l.id,engine:'human_review',usedExactTm:false,modelHttpRequests:0,rawModelTranslation:l.aiTranslation,humanReviewReceiptSha256:out.receipt.receiptSha256,qaReport:{issues:[]}})),
 typesetting:{layoutReport:out.lines.map(l=>({id:l.id,bbox:{x:0,y:0,width:.1,height:.1},fontSizePx:14,productionFontLoaded:true,glyphFontLoaded:true}))}};
 const assets={cleanedPng:png,candidatePng:png},result=reportToStudioResult(r,assets);assert.equal(result.blocks[0].text,out.lines[0].userTranslation);assert.equal(result.evidence.human_translation_review.independentGroundTruthVerified,false);
 assert.notEqual(result.blocks[0].text,out.lines[0].aiTranslation);
 r.hashes.mask='f'.repeat(64);r.translationInput={version:'synthetic-layout-input',fingerprint:'1'.repeat(64)};
 r.typesetting.inputIdentity={version:1,contract:'stage12-input-v1',jobId:r.jobId,pageNumber:1,width:1,height:1,sourceSha256:r.hashes.original,sourceImageSha256:r.hashes.normalized,cleanedImageSha256:imageHash,maskSha256:r.hashes.mask,translationInputFingerprint:r.translationInput.fingerprint,coordinateSpace:'normalized-page-pixels',mode:'unreviewed_candidate',maskReview:'candidate_validated_not_human_approved'};
 for(const layout of r.typesetting.layoutReport){const selected=out.lines.find(l=>l.id===layout.id).userTranslation;Object.assign(layout,{contractVersion:'stage12-layout-v1',qaStatus:'pending',fitStatus:'FIT_WARNING',textEvidence:{sourceText:selected,complete:true,missingCharacters:0,extraCharacters:0,renderedLines:[selected]},actualLayout:{lines:[{text:selected}]},glyphEvidence:{measured:true,missingGlyphOccurrences:0},raster:{paintedPixels:1,clippedPixels:0,otherRegionCollisionPixels:0,overlappingInkPixels:0,outsideInteriorPixels:null}});}
 assert.equal(reportToStudioResult(r,assets).blocks[0].text,'사용자 확정 수정문');
 for(const mutate of [x=>delete x.humanTranslationReview,x=>x.lines[0].userTranslation='바꿔치기',x=>x.translations[0].modelHttpRequests=1,x=>x.translations[0].rawModelTranslation='다른 AI',x=>x.humanTranslationReview.independentGroundTruthVerified=true]){const bad=structuredClone(r);mutate(bad);assert.throws(()=>reportToStudioResult(bad,assets));}
 const oldText=structuredClone(r);oldText.typesetting.layoutReport[0].textEvidence.sourceText=oldText.lines[0].aiTranslation;assert.throws(()=>reportToStudioResult(oldText,assets));
});
