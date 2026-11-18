import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [mode,audit]=process.argv.slice(2),read=p=>fs.readFile(p,'utf8').then(JSON.parse),root=process.cwd();
const json=(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2),{flag:'wx'});
const hash=async p=>{const h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);return h.digest('hex');};
const matrix=[
 ['정상 단일 페이지','D 실행 / BLOCKED','실제 OCR+page translation 응답 length2400 / E 전체 미완료','current-real-checkpoint-replay.json'],
 ['정상 연속2페이지','B 합성 통과 / F NOT_RUN','단일완주 선행 실패','preflight-v2/output.log; verify-warm/engine-runtime-reuse'],
 ['page1 완료 후 page2 실패','B 통과 + C 과거보존 / 현재 F NOT_RUN','verify-warm completed first/failed second; historical warm replay','historical-warm-replay.json'],
 ['모델서버 재사용 성공','D 제한 확인','B 실제 E2B same-PID generation1 health-only warm use; 추가추론0','runtime-snapshots/B-e2b-receipt.json'],
 ['모델 재사용 실패','B 통과 / 실제 Gemma failure NOT_RUN','owned-runtime/engine-runtime-reuse unhealthy runtime and freeze','preflight-v2/output.log'],
 ['유효 checkpoint 복구','C 현재 actual-OCR payload replay 통과','13그룹/추론0; actual runtime rerun과 구분','current-real-checkpoint-replay.json'],
 ['무효 checkpoint 거부','C6조건 + B 통과','source/owner/work/page/config/손상사본','current-real-checkpoint-replay.json'],
 ['모델 timeout','B 통과 / 실제 추론 timeout NOT_RUN','stage13-store TRANSLATION_TIMEOUT, runtime-lease deadlines','preflight-v2/output.log'],
 ['OCR 검토필요','B 통과 / 현재 OCR ROI gate 통과','stage09-ocr-mapping + stage13-store OCR_REVIEW_REQUIRED','preflight-v2/output.log'],
 ['LaMa 안전중단','B 통과 / 실제 LaMa NOT_RUN','engine boundaries cleanup/abort; real page failed upstream','preflight-v2/output.log'],
 ['renderer 실패','B 통과 / 실제 최종render NOT_RUN','stage13-store TYPESET_RESULT + partial checkpoint engine','preflight-v2/output.log'],
 ['재시도 횟수 초과','B 통과','stage13-store rejects fourth explicit attempt; no automatic retry','preflight-v2/output.log'],
 ['오래된 결과 도착','B 통과','stage13-client/store concurrent generation/cancel/confirmed edits','preflight-v2/output.log'],
 ['중복 결과 저장','B 통과','duplicate request/commit receipt repeated reads','preflight-v2/output.log'],
 ['프로세스 종료 실패','B 통과 / 실제 model unknown cleanup NOT_RUN','runtime-lease unconfirmed destroy blocks; owned OS process tests','preflight-v2/output.log'],
 ['소유권 불명 worker','A+B 경계 / 외부 kill 미수행','private Job scope and unrelated sentinel protection','preflight-v2/output.log; native Job receipts'],
 ['서버 재시작 뒤 완료조회','B 통과 / C 옛receipt없는사본 거부','현재 실제 failed job store reopen0추론; current completed result 없음','historical-warm-replay.json; runtime-snapshots/C-store-reopen.json'],
 ['캐시 소유권 불일치','C+B 통과','current OCR owner mismatch rejected; owned runtime scope tests','current-real-checkpoint-replay.json'],
 ['원본 해시 불일치','C+B 통과','current OCR source mismatch rejected; source input hashes unchanged','current-real-checkpoint-replay.json'],
 ['메모리 보호 기준 접근','A+C 과거 / 현재 D 횡단 미관측','과거 시스템 가용497.730MiB; 현재 안전여유 표본','historical-warm-replay.json; runtime-summary.json'],
 ['메모리 보호 기준 초과','A+C 과거 / 현재 D 미재현','512MiB 미만 guard 중단 historical HOST_MEMORY_PRESSURE','historical-warm-replay.json'],
 ['실제 메모리 관측 누락','D+B 보존','초기 GPU255 null 및 PROBE_IN_FLIGHT null; 순간peak 미인증','runtime-summary.json; resource-samples.jsonl'],
 ['첫 페이지 정상파일 불변','C 과거 + B + 보호 full SHA','과거 first-page 실제 assets unchanged; 새첫페이지 완료는 없음','historical-warm-replay.json; preservation-final.json'],
].map((r,i)=>({id:i+1,scenario:r[0],statusAndLevel:r[1],scope:r[2],evidence:r[3]}));
if(mode==='matrix'){
 await json(path.join(audit,'evidence/failure-coverage-matrix.json'),matrix);
 const table='\n\n필수23사례 대응표 (한 검사를 여러 사례에 중복 가산하지 않음):\n\n|#|사례|상태/수준|범위|근거|\n|---|---|---|---|---|\n'+matrix.map(r=>`|${r.id}|${r.scenario}|${r.statusAndLevel}|${r.scope}|${r.evidence}|`).join('\n')+'\n';
 await fs.appendFile(path.join(audit,'Stage14_Regression_Results.md'),table);console.log('23 evidence cases documented');
}else if(mode==='finalize'){
 const b=await read(path.join(audit,'evidence/baseline.json')),protectedProof=await read(path.join(audit,'evidence/preservation-final.json')),sourceProof=await read(path.join(audit,'evidence/source-final.json'));
 const p={...protectedProof,...sourceProof},s=await read(path.join(audit,'evidence/runtime-summary.json')),states=await read(path.join(audit,'evidence/stage14-states.json')),full=await read(path.join(audit,'evidence/preflight-v2/receipt.json'));
 const plan='docs/superpowers/plans/2026-11-11-mangohana-v2-sites-integration.md',beforePlan=await fs.readFile(path.join(audit,'evidence/before',plan)),nowPlan=await fs.readFile(path.join(root,plan));
 const allowed=file=>file===plan||file==='docs/validation/2026-11-13-v2-stage14-runtime.md'||/^scripts\/v2\/stage14-[-a-z0-9]+\.[cm]js$/.test(file);
 const unexpected=p.sourceChanges.filter(r=>!allowed(r.path));if(unexpected.length||p.deleted.length||!p.protectedUnchanged||!nowPlan.subarray(0,beforePlan.length).equals(beforePlan))throw Error('PRESERVATION_OR_SCOPE_FAILED');
 const current=new Map(p.sources.map(r=>[r.path,r.sha256]));
 const postTestProductDrift=full.sourceBefore.filter(r=>!r.path.startsWith('docs/')&&!r.path.startsWith('scripts/v2/stage14-')&&current.get(r.path)!==r.sha256);
 if(postTestProductDrift.length)throw Error('POST_TEST_PRODUCT_DRIFT');
 const changes=[];for(const r of p.sourceChanges){const before=b.files.find(n=>n.path===r.path);if(await hash(path.join(root,r.path))!==r.sha256)throw Error('SOURCE_CHANGED_AFTER_PRESERVATION');changes.push({...r,beforeSha256:before?.sha256??null,kind:before?'modified':'created',recoveryCopy:before?path.join(audit,'evidence/before',r.path):null});}
 for(const file of b.preBaselineToolCreation??[]){const r=p.sources.find(r=>r.path===file);if(!r||await hash(path.join(root,file))!==r.sha256)throw Error('PRE_BASELINE_TOOL_CHANGED');changes.push({...r,beforeSha256:null,kind:'created-before-baseline-explicitly-recorded',recoveryCopy:null,baselineSnapshot:path.join(audit,'evidence/before',file)});}
 const commands=[];for(const e of await fs.readdir(path.join(audit,'evidence'),{withFileTypes:true})){if(!e.isDirectory()||e.name==='before')continue;try{const r=await read(path.join(audit,'evidence',e.name,'receipt.json'));commands.push({name:r.name,command:r.command,exitCode:r.exitCode,counts:r.counts,durationMs:r.durationMs,sourceUnchanged:r.sourceUnchanged,logSha256:r.logSha256,receipt:'evidence/'+e.name+'/receipt.json'});}catch{}}
 const review=await read(path.join(audit,'evidence/test-verifier-review.json'));
 const delivery={createdAt:new Date().toISOString(),scope:'STAGE14_ONLY',headUnchanged:b.git.head===p.git.head,branchUnchanged:b.git.branch===p.git.branch,protectedRows:p.protectedCount,protectedUnchanged:p.protectedUnchanged,protectedHashCompletedAt:protectedProof.createdAt,sourceClosedAt:sourceProof.createdAt,deleted:p.deleted,unexpected,originalPlanPrefixPreserved:true,postTestProductDrift,fullV2:{exitCode:full.exitCode,counts:full.counts},productAlgorithmEdits:0,stoppedAt14:true,requiredReports:10,independentReview:review.status,sourceChanges:changes.map(r=>r.path)};
 await json(path.join(audit,'Stage14_Delivery_Verification.json'),delivery);
 const artifactHashes=[];async function walk(d){for(const e of await fs.readdir(d,{withFileTypes:true})){if(e.isSymbolicLink())throw Error('Audit link');const f=path.join(d,e.name);if(e.isDirectory()){if(f!==path.join(audit,'evidence/before'))await walk(f);}else if(e.isFile())artifactHashes.push({path:path.relative(audit,f).replaceAll('\\','/'),bytes:(await fs.stat(f)).size,sha256:await hash(f)});}}await walk(audit);
 const manifest={schemaVersion:1,kind:'MANGOHANA_V2_STAGE14_CHANGE_MANIFEST',createdAt:new Date().toISOString(),timezone:'Asia/Seoul',scope:'STAGE14_ONLY_REAL_MODEL_RESOURCE_RECOVERY_VALIDATION',repository:{root,headBefore:b.git.head,headAfter:p.git.head,branchBefore:b.git.branch,branchAfter:p.git.branch,statusBefore:b.git.status,statusAfter:p.git.status},baseline:'evidence/baseline.json',recoveryCopies:'evidence/before/',preBaselineToolCreation:b.preBaselineToolCreation,preservation:{protectedRows:p.protectedCount,protectedUnchanged:p.protectedUnchanged,changed:p.changed,deleted:p.deleted,unexpected,originalPlanPrefixBytes:beforePlan.length,originalPlanPrefixPreserved:true,postTestProductDrift},changes,commands,states,failureCoverage:matrix,runtimeSummary:'evidence/runtime-summary.json',currentRealCheckpointReplay:'evidence/current-real-checkpoint-replay.json',historicalReplay:'evidence/historical-warm-replay.json',outputRoot:b.runRoot,actualModelExecutions:{gemmaHttpRequests:2,gemmaTextRequests:1,gemmaPageImageRequests:1,topLevelPageOcrRecognitionRequests:1,ocrRefinementCropRequests:3,regionDetectorRuns:1,textMaskRuns:1,lamaRuns:0,completedPages:0,completedCurrentPngTrio:0,twoPageRun:'NOT_RUN',automaticRetries:0,modelFallbacks:0,modelDownloads:0,externalInferenceCalls:0,paidApiCalls:0,tokenUsage:{stageTotal:null,stageTotalReason:'B adapter discards raw token envelope; C measured3033+2400=5433 only',pageImage:{promptTokens:3033,completionTokens:2400,totalTokens:5433},textAdapter:null},monetaryCost:null},agents:review,limitations:['Actual page response truncated at unchanged max_tokens2400; no prompt/model/sampling change or retry','Current actual single page failed before LaMa/final render; two-page gated NOT_RUN','Sampled resources include gaps and other apps; no continuous peak, stable maximum, repeated mean or leak claim','Actual OCR checkpoint loader replay is C; model crash/timeout/cancel/restart recovery NOT_RUN','Server store failed-state reopen with read-only engine is separate from browser IndexedDB and live model restart','Human semantic/source/artwork/typography GT0 and real output quality NOT_MEASURED'],policies:{stage08:'stage08-v1.1 offline unchanged',hostAvailableAbortBelowMiB:512,gpuFreeAbortBelowMiB:128,ocrOverlapThreshold:0.75,maximumExplicitRetryLineageAttempts:3,roiOcrResumeImplemented:false,rendererIndependentCheckpointImplemented:false,stage15Started:false,model11MComparison:false,newGoal:false,commitPush:false,deployment:false},artifactHashes,outputHashScope:'Critical output artifacts in page receipts plus protected existing files full SHA; new profile/temp directories are not represented as a complete backup'};
 await json(path.join(audit,'Stage14_Change_Manifest.json'),manifest);const digest=await hash(path.join(audit,'Stage14_Change_Manifest.json'));await fs.writeFile(path.join(audit,'Stage14_Change_Manifest.sha256'),digest+'  Stage14_Change_Manifest.json\n',{flag:'wx'});
 console.log(JSON.stringify({changes:changes.map(r=>r.path),protected:p.protectedCount,protectedUnchanged:p.protectedUnchanged,postTestProductDrift:postTestProductDrift.length,reports:10,review:review.status,manifestSha256:digest,states:states.map(r=>[r.state,r.value])}));
}else throw Error('matrix or finalize required');
