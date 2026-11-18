// Stage13 report finalization. Reads receipts, preserves old evidence, writes this audit only.
import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),audit=process.argv[2];
if(!audit||!/^MangoHana_13_\d{8}_\d{6}$/.test(path.basename(audit)))throw Error('Explicit Stage13 audit required');
const sha=b=>createHash('sha256').update(b).digest('hex'),read=async f=>JSON.parse(await fs.readFile(path.join(audit,f),'utf8'));
const put=async(name,value)=>fs.writeFile(path.join(audit,name),typeof value==='string'?value:JSON.stringify(value,null,2),{flag:'wx'});
const baseline=await read('evidence/baseline.json'),preservation=await read('evidence/preservation-final.json');
const receipts=[];for(const e of await fs.readdir(path.join(audit,'evidence'),{withFileTypes:true}))if(e.isDirectory())try{const r=await read('evidence/'+e.name+'/receipt.json');receipts.push({receipt:'evidence/'+e.name+'/receipt.json',...r});}catch(error){if(error.code!=='ENOENT')throw error;}
const full=receipts.find(r=>r.name==='full-v2-final');if(!full||full.exitCode!==0||full.counts.fail!==0||!full.sourceUnchanged)throw Error('Final full V2 evidence required');
const current=preservation.sources,byBefore=new Map(baseline.files.map(r=>[r.path,r])),changes=[];
for(const row of current){const before=byBefore.get(row.path);if(before?.sha256===row.sha256)continue;const target=path.join(audit,'evidence/after',row.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(root,row.path),target);
 let diff=null;if(before){const dest='evidence/diffs/'+row.path.replaceAll('/','__')+'.patch';await fs.mkdir(path.join(audit,'evidence/diffs'),{recursive:true});let output;try{output=execFileSync('git',['diff','--no-index','--no-ext-diff','--',path.join(audit,'evidence/before',row.path),path.join(root,row.path)],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});}catch(error){if(error.status!==1)throw error;output=error.stdout;}await fs.writeFile(path.join(audit,dest),output,{flag:'wx'});diff={path:dest,sha256:sha(output)};}
 changes.push({path:row.path,kind:before?'MODIFIED_BASELINE_FILE':'NEW_FILE',beforeSha256:before?.sha256??null,afterSha256:row.sha256,bytes:row.bytes,beforeSnapshot:before?'evidence/before/'+row.path:null,afterSnapshot:'evidence/after/'+row.path,diff});
}
const deleted=baseline.files.filter(r=>!current.some(c=>c.path===r.path));
const allowed=new Set(['apps/engine/store.mjs','apps/engine/server.mjs','apps/sites/lib/studio-state.ts','apps/sites/lib/studio-engine.ts','apps/sites/lib/studio-batch-engine.ts','apps/sites/components/studio.tsx','apps/sites/app/api/engine/[...path]/route.ts','apps/sites/checks/engine-integration.test.mjs','packages/ai-engine/vendor/trio/scripts/sites-local/engine.cjs','packages/ai-engine/quality/recovery-policy.cjs','packages/ai-engine/quality/recovery-checkpoint.cjs','packages/evaluation/offline/operations.mjs','tests/v2/engine-runtime-reuse.test.mjs','tests/v2/stage13-store.test.mjs','tests/v2/stage13-client.test.mjs','tests/v2/stage13-cache.test.mjs','tests/v2/stage13-crash-child.mjs','scripts/v2/stage13-evidence.mjs','scripts/v2/stage13-web-checks.mjs','scripts/v2/finalize-stage13.mjs','docs/superpowers/plans/2026-11-11-mangohana-v2-sites-integration.md','docs/validation/2026-11-13-v2-stage13-recovery.md']);
const unexpected=changes.filter(c=>!allowed.has(c.path)).map(c=>c.path);
const plan='docs/superpowers/plans/2026-11-11-mangohana-v2-sites-integration.md',original=await fs.readFile(path.join(audit,'evidence/before',plan)),present=await fs.readFile(path.join(root,plan));
const product=changes.filter(r=>r.path.startsWith('apps/engine/')||r.path.startsWith('apps/sites/lib/')||r.path.includes('/components/')||r.path.includes('/app/api/')||r.path.startsWith('packages/'));
const fullHashes=new Map(full.sourceBefore.map(r=>[r.path,r.sha256]));
const postTestProductDrift=product.filter(r=>fullHashes.get(r.path)!==r.afterSha256).map(r=>r.path);
if(!preservation.protectedUnchanged||deleted.length||unexpected.length||postTestProductDrift.length||!present.subarray(0,original.length).equals(original)||baseline.git.head!==preservation.gitHead||baseline.git.branch!==preservation.gitBranch)throw Error('Preservation or post-test source validation failed: '+JSON.stringify({deleted,unexpected,postTestProductDrift}));
const states=[
 ['RETRY_POLICY_VERIFIED','VERIFIED','code + synthetic; automatic retry false, classified errors, explicit user retry only'],
 ['RETRY_LIMITS_VERIFIED','VERIFIED','maximum three attempts per retry lineage; automatic attempts zero; no model fallback'],
 ['PARTIAL_REPROCESSING_VERIFIED','VERIFIED_LIMITED','actual engine/store code + synthetic providers; whole valid OCR/translation/cleaned checkpoints, not per-ROI resumed OCR'],
 ['CACHE_IDENTITY_VERIFIED','VERIFIED','owner/work/page/source/normalized/stage/configuration content hashes + stored receipt; actual AI not run'],
 ['CACHE_INVALIDATION_VERIFIED','VERIFIED_LIMITED','synthetic ten condition matrix; fresh mask binding and render; live browser not run'],
 ['STALE_RESULT_REJECTION_VERIFIED','VERIFIED_LIMITED','server-owned job generation/context + browser live ticket/content CAS; no global server editor revision migration'],
 ['IDEMPOTENT_COMMIT_VERIFIED','VERIFIED','real disk, serial admission, durable retry link, one completion receipt, repeated retry/read/reopen'],
 ['ATOMIC_RESULT_PROTECTION_VERIFIED','VERIFIED_LIMITED','immutable candidate assets + atomic state/receipt + write faults + full validation; hardware power loss not tested'],
 ['USER_CONFIRMED_VALUES_PRESERVED','VERIFIED_LIMITED','synthetic editor/undo/save/TRIO contracts; browser full flow and human review not run'],
 ['CANCELLATION_AND_LEASE_VERIFIED','VERIFIED_LIMITED','loopback cancel + synthetic late provider + existing real child-process lease tests; unknown cleanup blocks new work'],
 ['FAILURE_INJECTION_VERIFIED','VERIFIED','22 cases mapped below; deterministic synthetic/disk/loopback/OS worker evidence'],
 ['EXISTING_V2_REGRESSION_PASSED','PASSED',`${full.counts.pass}/${full.counts.tests}, fail/skip/cancel/todo0, exit0; separate web96 and typecheck pass`],
 ['ACTUAL_RUNTIME_RECOVERY_VERIFIED','NOT_RUN','actual Gemma/OCR/LaMa model recovery not executed; synthetic OS process recovery is separate'],
 ['BROWSER_END_TO_END_VERIFIED','NOT_RUN','upload/edit/approve/save/download full browser flow not executed; DOM10 baseline not run'],
 ['HUMAN_REVIEW_PENDING','PENDING','human page quality/semantic ground truth remains zero'],
 ['STAGE14_PREREQUISITES_DOCUMENTED','DOCUMENTED','requirements only; Stage14 not started'],
].map(([state,status,scope])=>({state,status,scope}));
const stateTable='|상태|판정|범위|\n|---|---|---|\n'+states.map(s=>`|${s.state}|${s.status}|${s.scope}|`).join('\n');
const cases=[
 ['동일 job 중복 요청','stage13-store: same job duplicate; 기존 jobs/batches tests','SYNTHETIC_REAL_DISK'],
 ['같은 페이지 동시 재처리','stage13-store: concurrent same-page generation; engine owned-store duplicate retry','SYNTHETIC_REAL_DISK'],
 ['작품 전환 중 응답','stage13-client: project switch; single-page foreign work rejection','PURE_REDUCER_AND_SYNTHETIC_HTTP'],
 ['수동 번역 수정 후 응답','stage13-client: text + controlled edit-first/response-first + confirmed value hold','PURE_REDUCER'],
 ['glossary 변경 후 응답','stage13-store: server glossary changes; 기존 context-dispatch','SYNTHETIC_REAL_DISK'],
 ['취소 이후 늦은 완료','stage13-store: pending cancellation + late provider + duplicate cancel','SYNTHETIC_REAL_DISK_AND_LOOPBACK'],
 ['모델 timeout','stage13-store: TRANSLATION_TIMEOUT; 기존 runtime-lease/engine runtime timeout','SYNTHETIC_PROVIDER_AND_OWNED_PROCESSES'],
 ['부분 번역 응답','기존 engine-runtime-reuse Stage11 page/text partial response; stage11 contracts','ACTUAL_ENGINE_WITH_SYNTHETIC_PROVIDERS'],
 ['잘못된 OCR 검토','stage13-store OCR_REVIEW_REQUIRED; Stage09/Stage11 reviewed OCR + result contracts','SYNTHETIC_CONTRACT'],
 ['마스크 검증 실패','stage13-store TEXT_MASK_INVALID + 기존 stage10-engine-mask/source-mask/contracts','ACTUAL_ENGINE_WITH_SYNTHETIC_MASKS'],
 ['렌더링 실패','stage13-store TYPESET_RESULT + Stage13 render failure before checkpoint replay','ACTUAL_ENGINE_WITH_SYNTHETIC_RENDERER'],
 ['저장 도중 오류','stage13-store: state publication write failure; invalid receipt restart','REAL_DISK_FAULT'],
 ['정상 후보 후 재처리 실패','stage13-store failed reprocessing preserves previous PNG and receipt','REAL_DISK'],
 ['이전 generation 완료 요청','stage13-store getResult expectedGeneration0/server latest guard + client generation','SERVER_STATE_AND_REDUCER'],
 ['중복 결과 commit','engine owned-store retry key duplicate/reopen receipt unchanged; client duplicate result','ACTUAL_STORE_AND_ENGINE_WITH_SYNTHETIC_PROVIDERS'],
 ['다른 페이지 캐시','stage13-cache another page; client foreign page/work identity','REAL_DISK_CACHE'],
 ['다른 작품 캐시','stage13-cache another work/owner; 기존 owned-runtime identity','REAL_DISK_CACHE_AND_LEASE'],
 ['모델 요청 중복 비용','usage shared-request tests + stage13-cache reuse + Stage06 adapter red2→green + owned-store current calls0','REQUEST_LEDGER_AND_EVALUATOR'],
 ['lease 반환 실패','stage13-store cleanup blocks new work + 기존 runtime-lease real child failures','SYNTHETIC_AND_OWNED_PROCESSES'],
 ['재시도 예산 소진','stage13-store fourth attempt rejected after three explicit attempts','DETERMINISTIC_SYNTHETIC'],
 ['프로세스 갑작스런 종료','stage13-crash-child real Node exit23 after durable running; recovery no replay; engine model not run','REAL_OS_WORKER_SYNTHETIC_ENGINE'],
 ['이전 정상/현재 실패 후보 충돌','stage13-store earlier PNG and receipt unchanged through failure/write fault + web state preservation','REAL_DISK_AND_REDUCER'],
].map(([scenario,evidence,level],i)=>({id:i+1,scenario,status:'PASS_SCOPED',evidence,level,receipt:'evidence/full-v2-final/receipt.json'}));
const caseTable='|#|필수 오류 사례|실행 증거|범위|\n|---|---|---|---|\n'+cases.map(c=>`|${c.id}|${c.scenario}|${c.evidence}|${c.level}|`).join('\n');
const header=title=>`# ${title}\n\n2026-11-13 KST · Stage13만 수행. 원인 분석·공통 제품 수정·합성/디스크/OS 프로세스 검증이다. 사람 검수·실제 모델 결과가 아니다.\n\n`;
const shared='\n\n실행 명령·exit·원시 로그·소스 SHA는 evidence/*/receipt.json과 output.log, 전후 파일 SHA/diff·보호 확인은 Stage13_Change_Manifest.json에 있다. 실제 제품 AI 모델과 브라우저 전체 흐름은 NOT_RUN이며 비용/토큰/사람 품질은 측정하지 않았다.\n';
await put('Stage13_Retry_And_Recovery_Architecture.md',header('Stage13 — 재시도·부분 복구 구조')+`
기존 createJobStore의 단일 직렬 큐, immutable job 폴더, public/batch 요청 namespace, source 보존, durable retry link, verify/reportToStudioResult, runtime-lease/owned-runtime을 재사용한다. 새 DB/state machine/모델/의존성은 도입하지 않았다.

실제 호출: studio.run → processPage/processProjectBatch → same-origin proxy → engine server(owner cookie) → store.submit/submitBatch → queued → running/preparing → 서버 문맥 snapshot → normalize → 필요 ROI/refinement → OCR → renderer.prepare/마스크 검증 → Stage11 전체 번역 검증 → LaMa → 식자/PNG 검증 → 엔진 cleanup → store 후보/report 저장 → 전체 hash/contract 검증 → atomic state+receipt → GET 시 최신 server generation/context 확인 → 브라우저 입력 ticket/CAS → review → 사용자 검수/편집 → IndexedDB storageRevision transaction → PNG/TRIO export.

기존 안전 구현: owner-scoped idempotency, source hash·wx asset, retry 불확실 수락 보류, 75% OCR guard, mask identity, 전체 번역 응답 검증, Stage12 render identity, 차용자 하나의 runtime lease. 보강 결함: 오류 코드 소실, 재시도 횟수 부재, single-page 응답 identity 누락, 편집 뒤 stale 적용, 취소 API/완료 확인 부재, 완료 영수증 모순, 부분 재사용 부재, 평가기의 과거 요청 재집계.

선택: 기존 경계에 작은 phase journal/receipt와 guard를 추가했다. 대체 거대 state machine 또는 공유 결과 캐시 재설계는 요청 범위와 기존 데이터 보호에 맞지 않아 사용하지 않았다. OCR/번역/cleaned의 검증 완료 checkpoint만 자식 job으로 재사용한다. mask prepare와 render는 새 job에 다시 결속한다.

정책: 자동 재시도/자동 전달 false 유지. retry lineage는 최초1+사용자 명시 retry2, 모델 fallback0. Stage08의 최대 보정2/fallback1은 당시 제안이며 fallback을 활성화한 것으로 표현하지 않는다. timeout은 실제 호출 완료 여부가 불명확할 수 있어 자동 재호출하지 않는다. 실패 사용량/금액·토큰 unknown은 null이다. 반복 budget 소진은 RETRY_BUDGET_EXHAUSTED로 종료하며 원인·입력이 달라지는 새 사용자 작업과 구분한다.

최소 단위 한계: 원래 OCR 서비스는 페이지/기존 crop refinement 경계다. Stage13이 임의 단일 ROI OCR resume나 의미상 최고 후보 자동 선택을 추가하지 않았다. 부분 번역은 일괄 검증 실패로 보류하고 유효 OCR만 재사용한다.
`+shared);
await put('Stage13_State_Transition_And_Identity.md',header('Stage13 — 상태 전이와 식별자')+`
|의미|기존 상태/추가 metadata|완료 의미|
|---|---|---|
|대기|queued/queued|실행 전 저장|
|실행|running + preparing/ocr/translate/inpaint/typeset|진행 중|
|검토 필요|failed + needs_review/recovery.type|자동 retry 없음|
|일시 실행 실패|failed + transient_execution|자동 retry 없음, 원인 확인 뒤 명시 retry|
|영구/불명확 입력|failed + permanent_or_unclassified|unknown을 transient로 추정하지 않음|
|취소 요청|running/cancel_requested + requestedAt|cleanup 미확정|
|취소 완료|cancelled + confirmedAt|queued 미실행 또는 run/cleanup 종료 확인|
|cleanup 불확실|failed/cleanup_unconfirmed|새 작업 차단|
|부분 실패|batch partial|다른 페이지 정상 후보 보존|
|후보 생성 완료|engine completed + unreviewed|사용자 승인/최종 저장과 별개|
|승인 대기|browser review|사용자 검토 필요|
|최종 저장|browser reviewed/page status + IndexedDB transaction|engine completed만으로 주장하지 않음|

|식별/버전|현재 권위와 guard|
|---|---|
|jobId|서버 UUID immutable incarnation|
|work/page/owner|projectId/pageId + cookie에서 파생한 owner hash; cache와 getResult 양쪽 확인|
|regionId|Stage09 원본 line/ROI lineage와 Stage11 전체 ID, Stage12 layout ID 유지|
|source/normalized hash|원본 bytes/정규화 PNG의 실제 SHA-256|
|OCR generation|선택 OCR JSON digest/출처를 checkpoint와 새 mask identity에 결속; 별도 전역 editor OCR counter 없음|
|translation/context/glossary|server snapshot hash + glossaryRevision/content digest + prompt/input fingerprint|
|user edit revision|브라우저 live content ticket, reviewed/manual 보호, IndexedDB storageRevision CAS; 전역 서버 editor revision은 미구현|
|processing generation|서버 state.sequence, currentPage가 owner/work/page의 더 최신 수락 job 검사|
|result revision|immutable candidate마다 resultReceipt.revision=1; 수정하며 덮는 revision 아님|
|cache key|canonical scope+phase identity/content dependency SHA|
|idempotency|owner + namespace + 요청 key + 입력 fingerprint; retry parent link durable commit|

클라이언트가 보낸 revision만으로 결과를 승인하지 않는다. 서버는 저장한 source/sequence/context에 따라 후보 반환 권한을 확인한다. 브라우저의 수동값 권위는 현재 로컬 workspace에 있으므로 서버에 존재하지 않는 edit revision을 있다고 주장하지 않는다. 결과 수신은 시작 시 content와 현재 content/이미지/generation이 같고 수동 확정값이 아닐 때만 적용한다. 확인할 수 없는 ticket/이전 블록 출처는 보류한다. 프로젝트 전환 응답은 원래 프로젝트로만 전달되고 현재 프로젝트를 변경하지 않는다.
`+shared);
await put('Stage13_Cache_And_Invalidation.md',header('Stage13 — 캐시와 무효화')+`
기존 owned-runtime은 OCR/번역 프로세스의 재사용이며 페이지 결과 캐시가 아니다. owner/work/configuration을 검사하고 요청 context를 resident 값에 보존하지 않는다. 기존 default false를 바꾸지 않았다. Stage13 journal은 동일 owner/work/page의 서버가 연결한 retry parent 폴더만 읽는다. 공유 캐시 전체 삭제나 브라우저 임의 경로는 없다.

checkpoint-ocr/translation/cleaned.json은 version, job, scope, phase identity, payload와 asset SHA를 포함한다. 파일은 wx+sync 뒤 서버 state의 checkpoint SHA receipt로 pin한다. load는 regular directory/file, link 거부, bounded read, receipt SHA, version/identity, asset bytes SHA를 확인하고 일치하지 않는 단계만 miss로 남긴다. 원래 파일은 보존한다. OCR/번역/LaMa 설정·실행 파일·모델·국소 JS 의존성의 실제 bytes를 hash하며 stage 실행 전후 일치도 확인한다. 모델 다운로드는 없다. hash 비용/대형 리소스 성능은 실제 모델에서 미측정이다.

|변경|처리|
|---|---|
|1 원본 교체|source/normalized scope 불일치; 전 단계 miss|
|2 OCR 재검토|OCR digest/input fingerprint 변경 시 의존 번역 거부; 임의 ROI resume는 미구현|
|3 사용자 번역 수정|기존 manual/signature/live ticket 보호; AI 응답은 사용자값을 덮지 않음; manual export가 현재 블록 렌더|
|4 확정 용어 변경|서버 revision/content 재확인 + translation input miss|
|5 문맥 revision 변경|이전 번역 반환 거부; OCR/cleaned는 별도 phase dependency로 검사|
|6 마스크 변경|매 job 새 mask 검증; mask SHA가 다르면 cleaned miss|
|7 폰트/식자 영역|render는 항상 현재 입력으로 다시 실행; 유효 upstream cache는 유지; 수동 geometry 보호|
|8 프로젝트/owner 전환|scope 불일치 miss + 결과의 project/page/job 검증|
|9 취소 후 재요청|abort 시 hit/새 receipt 거부; cancelled job은 완료/자동 retry로 바뀌지 않음. 명시 fresh job은 새 incarnation|
|10 오래된 엔트리|지원하지 않는 version/receipt/dependency/source는 miss. 날짜만으로 유효한 동일 bytes를 일괄 삭제하지 않음|

translation 재사용은 과거 request ID/원시 token 기록을 보존하지만 현재 localModelRequests=0으로 분리한다. 금액·token은 관측 없으면 null이다. Stage06 집계도 server retry/checkpoint/usage 결속이 있을 때만 현재 호출0으로 처리하며 임의 reuse label은 거부한다. 실제 모델별 캐시 성능/실전 브라우저 전환은 NOT_RUN이다.
`+shared);
await put('Stage13_Atomic_Commit_And_Data_Protection.md',header('Stage13 — 원자적 후보 반영과 데이터 보호')+`
후보 생성 → report와 normalized/cleaned/mask/candidate 실제 bytes 검증 → OCR/번역/식자 ID·계약 전체 검사 → 완료할 state 사본 + resultReceipt 구성 → fsync 임시 state와 rename → 메모리에 completed 공개 순서다. resultReceipt는 같은 JSON에 들어가므로 별도 receipt 파일과 state 사이의 이중 commit을 만들지 않는다. getResult는 실제 무결성과 현재 서버 source generation/context를 검사한 뒤 반환하고 브라우저가 마지막 content CAS를 수행한다.

모든 job은 새 폴더이며 source/derived PNG/report/journal은 wx로 생성한다. failed retry는 부모 정상 PNG/TRIO/번역/수동값 파일을 덮지 않는다. 초기 completed 메모리를 저장 전에 노출하지 않도록 state 사본이 실제 atomic write에 성공한 뒤 교체한다. 반복 조회/중복 retry는 같은 job/receipt를 반환한다. restore와 serve에서 receipt와 report/candidate hash 모순은 실패로 보류한다.

부분 번역·OCR 검토·mask 실패·render 실패·PNG/asset 이상·state write 실패·저장 전 취소·stale generation·중복 commit은 전체 성공 근거가 아니다. completed는 물리적으로 검증된 미검수 후보이며 사용자 승인/최종 workspace 저장으로 승격하지 않는다. 오래된 후보는 파일을 보존해도 적용/반환을 막을 수 있다.

보호 검사는 원래 source/설정/감사/모델/output의 full hash 비교와 plan 원본 bytes prefix, Git HEAD/branch/dirty 보존을 포함한다. 원본 Electron/.ctp/IPC, Stage09 75%, Stage10 알고리즘, Stage11 의미 guard, Stage12 식자 알고리즘 및 생성 renderer bundle은 수정하지 않았다.

한계: OS 파일 atomic rename과 restart 재검증 범위다. 전원 차단/스토리지 하드웨어 장애·완전 브라우저 IndexedDB 제품 흐름은 미실행이다. 전역 server editor-revision 저장이나 DB migration/품질 최고 후보 자동 선택은 하지 않았다.
`+shared);
await put('Stage13_Cancellation_And_Runtime_Lease.md',header('Stage13 — 취소와 런타임 자원 반환')+`
POST /jobs/:uuid/cancel, same-origin proxy, 기존 owner cookie/CSRF·body allowlist를 사용한다. queued 작업은 큐에서 제거하고 cancelled로 저장한다. running은 먼저 cancel_requested/requestedAt을 저장하고 해당 record의 controller만 abort한다. run promise는 실제 engine finally/owner.cleanup과 lease 정리를 거쳐야 settle한다. 그 뒤에만 confirmedAt/cancelled로 기록한다. 늦은 progress/결과는 상태·controller·record 사본 guard로 거부한다. 중복 취소는 멱등이다.

CLEANUP_FAILED/RUNTIME_LEASE_BLOCKED/cleanupUncertain은 cancel 성공보다 우선한다. cleanup_unconfirmed로 보류하고 새 submit/retry/queue 실행을 차단한다. close 실패 시 같은 root 소유권을 해제하지 않는다. 갑작스러운 종료로 running만 남으면 INTERRUPTED로 보존하되 이전 프로세스 정리가 증명되지 않아 새 모델 작업을 차단한다. running cancel_requested에서 재시작돼도 취소 완료로 추정하지 않는다. 소유권을 확인하지 못한 외부/다른 작업 프로세스를 kill하지 않는다. 자동 unblock/reclaim은 구현하지 않았다.

기존 runtime-lease는 단일 borrower, 늦은 callback drain, cleanup deadline, create/destroy 불확실 차단과 owner 전용 종료를 재사용한다. 실제 OS child-process 합성 검사와 loopback 취소를 수행했다. 실제 Gemma/OCR/LaMa의 중단·재시작 회복은 NOT_RUN이다.

사이트의 기존 '조회 중지'는 observer abort이며 엔진 취소라고 바꾸지 않았다. 새 서버 취소 API의 UI 버튼/확인 UX를 추가하지 않았고 기존 디자인을 보존했다. 브라우저의 '이전 결과로 편집'도 엔진 취소가 아니며 late callback 분리 기능을 유지한다.
`+shared);
await put('Stage13_Failure_Injection_Results.md',header('Stage13 — 실패 주입 결과')+`
수정 전 유효 fixture: state/client 21 중19 실패·2 통과, checkpoint engine1 실패, 비용 adapter16 중2 실패·14 통과를 보존했다. 초기 하네스 hang은 합성 provider 종료 장치 누락으로 중단되었고 테스트 통과로 집계하지 않는다. OS tmp checkpoint 시도는 E: profile guard에 막힌 환경 실패이며 E: 고유 fixture에서 실제 제품 결함을 다시 재현했다. 첫 web 사본91 중4 실패는 identity fixture3/fflate 연결1로 분류하고 assertion 완화 없이 보완했다.

최종 전체 V2 ${full.counts.pass}/${full.counts.tests}, fail/skip/cancel/todo0, exit0. 아래는 필수22건의 분리 가능한 근거다. 동일 검사/fixture가 여러 사례를 다룰 수 있으며 총합에 중복 가산하지 않는다. PASS_SCOPED는 해당 합성/디스크/OS 검사 합격이며 실제 AI/브라우저/사람 합격이 아니다.

${caseTable}

독립 test_verifier는 당시에 full 진행 중·후속 소스 변경·22항목 대응표 부재를 지적하고 전체 승인하지 않았다. 추가 실행 없이 이전 영수증/코드를 읽었다. 응답 중 tests/engine 경로 언급은 전달한 tests/v2 경로와 달라 근거로 채택하지 않았다. 최종 full과 이 대응표는 메인이 검증하며 후속 독립 재검토는 NOT_RUN이다. Luna/low 역할1명 요청, 실제 runtime model attestation/사용량은 미확인이다.
`+shared);
const testsTable='|영수증|명령|결과|소스 불변|\n|---|---|---|---|\n'+receipts.map(r=>`|${r.name}|\`${r.command.join(' ')}\`|exit ${r.exitCode}; ${r.counts.tests===null?'test count 해당 없음':`${r.counts.pass}/${r.counts.tests}, fail${r.counts.fail}, skip${r.counts.skipped}`}|${r.sourceUnchanged}|`).join('\n');
await put('Stage13_Regression_Results.md',header('Stage13 — 회귀와 보존 결과')+`
Stage12 원본 C:/dev/Projects/_audits/MangoHana_12_20261113_131536/Stage12_Change_Manifest.json과 E:/Dev/Outputs/MangohanaV2-20261111/tests/stage12-full-v2-20261113_144940-ca6c48a4/Stage12_Full_V2_Addendum.md를 실제로 읽었다. Stage12 601/601·fail/skip0·exit0과 당시70419 보존은 과거 증거로 유지한다. 당시 PARTIAL 원본을 교체하지 않았다.

${testsTable}

최종 regression은 초기 full644 후 evaluator 연결 수정과 비용 red2→green126을 거친 full${full.counts.tests}이다. 현재 제품 변경 파일의 hash가 마지막 full의 sourceBefore와 일치함을 다시 검사한다. 관련 웹96과 사이트 noEmit 타입 검사는 변경한 웹 owning source가 동일한 영수증을 재사용한다. 기존 Stage02 evaluator·기존 QA/모델/알고리즘은 hash 보존하며 별도 재실행/새 제품 품질로 가산하지 않는다.

보호: hash 항목 ${preservation.protectedCount}개, 정규화한 실제 파일 ${new Set(baseline.protectedFiles.map(r=>path.resolve(r.path).toLowerCase())).size}개(경로 표기 중복16), 변경0. 원래 plan prefix ${original.length}bytes 불변, Git HEAD/branch 불변, 삭제0, 범위 밖 수정0. 정확한 전후 source SHA/diff는 manifest를 따른다. 이 범위가 전체 디스크/장치 분리 backup 검증은 아니다.

DOM10 NOT_RUN, Legacy 과거147 미해결/이번 미재검사, PG 미실행, 실제 모델/신규 만화/브라우저 전체/사람 품질 NOT_RUN. 전체 Legacy/제품 품질 PASS로 표시하지 않는다.
`+shared);
await put('Stage13_Next_Steps.md',header('Stage13 — 독립 판정과 다음 단계 선행 조건')+stateTable+`

Stage13의 코드·결정적 합성/디스크·OS 자원 검사는 위 범위에서 완료했다. 제품 전체 품질 완료는 아니다. 자동 retry/전달·모델/fallback·사이트 디자인 변경 없이 종료한다.

다음 승인된 단계에서 확인할 조건:

1. 실제 소유 runtime의 취소·프로세스 종료·lease 반환·갑작스런 종료 후 owner 회복 증거를 확보한다. unknown cleanup을 임의 해제하지 않는다.
2. 전역 서버 editor revision/수동 OCR revision 권위를 연결할지 별도 설계 범위를 확정한다. 현재 로컬 ticket+IndexedDB CAS를 서버 전역 편집 저장으로 오인하지 않는다.
3. DOM 준비 환경과 실제 브라우저 업로드→편집→취소/재요청→저장→PNG/TRIO 다운로드 및 다중 탭 충돌을 검증한다.
4. 실제 모델에서 checkpoint resource hash 비용·메모리·2페이지 처리와 lease 성능을 측정한다. 이 문서로 Stage14를 실행한 것이 아니다.
5. 기존 Gemma E2B structured response·새 만화의 무보정 결과·의미/잔상/작화/식자를 사람 정답과 검수한다. GT0은 유지하며 AI 검토로 대체하지 않는다.

하위는 test_verifier1명/1회, bug_triage/quality/critical0, 재위임0. main은 세션/사용자 모델 설정을 변경하지 않았다. 요청 역할 Luna/low와 실제 모델 실행 attestation은 구분하며 토큰·비용은 null이다. commit/push/배포/모델 다운로드/실제 추론/11M/새 Goal/Stage14 이후 실행은 하지 않았다.
`+shared);
await put('evidence/failure-case-matrix.json',cases);
const artifactNames=['Stage13_Retry_And_Recovery_Architecture.md','Stage13_State_Transition_And_Identity.md','Stage13_Cache_And_Invalidation.md','Stage13_Atomic_Commit_And_Data_Protection.md','Stage13_Cancellation_And_Runtime_Lease.md','Stage13_Failure_Injection_Results.md','Stage13_Regression_Results.md','Stage13_Next_Steps.md'];
const artifactHashes=[];for(const f of artifactNames){const b=await fs.readFile(path.join(audit,f));artifactHashes.push({path:f,bytes:b.length,sha256:sha(b)});}
const manifest={schemaVersion:1,kind:'MANGOHANA_V2_STAGE13_CHANGE_MANIFEST',createdAt:new Date().toISOString(),timezone:'Asia/Seoul',scope:'STAGE13_ONLY_RETRY_RECOVERY_CACHE_AND_ATOMIC_CANDIDATES',
 repository:{root,headBefore:baseline.git.head,headAfter:preservation.gitHead,branchBefore:baseline.git.branch,branchAfter:preservation.gitBranch,statusBefore:baseline.git.status,statusAfter:preservation.gitStatus},states,
 baseline:'evidence/baseline.json',finalSourceAndPreservation:'evidence/preservation-final.json',preBaselineToolCreation:baseline.preBaselineToolCreation,
 preservation:{protectedRows:preservation.protectedCount,uniqueResolvedFiles:new Set(baseline.protectedFiles.map(r=>path.resolve(r.path).toLowerCase())).size,protectedUnchanged:true,changed:[],deleted,unexpected,existingPlanPrefixBytes:original.length,existingPlanPrefixPreserved:true,postTestProductDrift,modelAndConfigurationChanged:false},
 changes,tests:receipts.map(r=>({receipt:r.receipt,command:r.command,exitCode:r.exitCode,counts:r.counts,sourceUnchanged:r.sourceUnchanged,durationMs:r.durationMs,logSha256:r.logSha256})),
 fullRegression:{status:'PASSED',...full.counts,exitCode:full.exitCode,sourceUnchanged:full.sourceUnchanged},failureInjection:cases,
 agents:{requestedMain:'session preserved; user designated Sol/Max',requestedSubagentRole:'test_verifier Luna/low',distinctSubagents:1,spawns:1,followups:0,redelegation:0,modelRuntimeAttestation:null,tokens:null,cost:null,independentFinalApproval:false},
 notRun:['actual Gemma/OCR/LaMa recovery','full browser E2E','DOM10','PG','human page review','Legacy147 remediation','Stage14'],
 limitations:['global server editor revision not implemented','per-ROI OCR checkpoint resume not implemented','hardware power-loss durability not tested','unknown cleanup needs separately verified owner recovery; no automatic unblock','large-model resource hashing performance unmeasured'],
 policies:{automaticRetry:false,automaticDelivery:false,maximumRetryLineageAttempts:3,modelFallbacks:0,modelChanged:false,downloadedModels:false,actualAiRuns:false,committed:false,pushed:false,deployed:false,newGoal:false,stage14Started:false},artifactHashes};
await put('Stage13_Change_Manifest.json',manifest);await put('Stage13_Change_Manifest.sha256',sha(await fs.readFile(path.join(audit,'Stage13_Change_Manifest.json')))+'  Stage13_Change_Manifest.json\n');
console.log(JSON.stringify({audit,changes:changes.length,productFiles:product.length,full:full.counts,protected:preservation.protectedCount,postTestProductDrift,artifacts:artifactNames.length+1}));
