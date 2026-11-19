# MangoHana V2 S15-01 품질 판단 정책 검증

2026-11-18 KST. 단계 품질을 평가하는 `assessStage`를 구현했고 합성 집중 검사 21/21과 기존 품질 정책 회귀 38/38이 통과했다. 작업 유형은 제품 정책 코드 개선과 합성 검증이다. 실제 웹과 새 이미지에 적용된 품질은 미검증이다. [Stage15 계획](../superpowers/plans/2026-11-18-mangohana-v2-stage15-implementation-plan.md) · [정책 코드](../../packages/ai-engine/quality/stage15-quality-decision.cjs) · [합성 테스트](../../tests/v2/stage15-quality-decision.test.mjs)

## 입출력 계약

`assessStage({ binding, observed, findings, authority })`는 소유 경계에서 정리한 데이터 스냅샷을 받는다. ID는 1~200자의 영숫자 또는 `._:-`, 해시는 소문자 SHA-256 hex다. [Stage04 공통 계약](../../packages/contracts/src/v2-common-contract.mjs) · [기존 복구 정책](../../packages/ai-engine/quality/recovery-policy.cjs)

| 입력 | 필수 데이터와 판정 근거 |
|---|---|
| `binding` | `ownerScope { kind, id }`의 `owner` 또는 `session`, `projectId`, `pageId`, 1부터 시작하는 `pageNumber`, `requestId`, `generation`, `editRevision`, `contextRevision`, `layoutRevision`, `sourceSha256`, `inputDigest`, `mode`. revision은 0 이상의 안전한 정수이며 generation은 같은 범위의 정수 또는 ID다. `mode`는 `FULL_IMAGE` 또는 `TYPESETTING_ONLY`다. `permitId`, `proposalSha256`, `approvalEventSha256`은 근거가 제공될 때 세 필드 전체가 필요하다. |
| `observed` | `binding`, `stage`, `attemptId`, `state`, `phase`, `started`, `evidenceRefs`, `usageConfirmed`, `costUsd`, `errorCode`, `artifact`, `checks`. `state`는 `CONFIRMED_SUCCESS`, `CONFIRMED_NOT_STARTED`, `CONFIRMED_FAILURE`, `PARTIAL`, `CANCELLED`, `RESULT_UNKNOWN` 중 하나다. `phase`는 `BEFORE_DISPATCH`, `DISPATCHED`, `PUBLISHING` 중 하나이며 `started`는 `true`, `false`, `null`을 구별한다. 확정 USD는 0 이상의 십진 문자열, 미확정은 `usageConfirmed: false`, `costUsd: null`이다. 성공에는 `artifact { artifactId, sha256 }`가 필요하다. |
| `observed.checks` | 고유한 `checkId`, `version`, `status`. Stage04의 `passed`·`failed`는 `identity` 전체와 `subjectArtifactId`, `subjectSha256`, `evidenceId`가 필요하다. `unknown`·`not_measured`·`pending`의 네 근거 필드는 모두 `null`이다. |
| `findings` | 고유 `id`, `severity` (`HARD`, `SOFT`, `UNVERIFIED`), `code`, `scope`, `regionId` 또는 `null`, 연결된 `checkId`·`evidenceId`. HARD와 SOFT에는 측정 근거가 필요하다. |
| `authority` | 기존 경계의 `verified`, 현재 `binding`, `stage`, 대상 `artifact` 또는 `null`, `requiredChecks`의 `checkId`·`version` 목록, `softApprovals` 배열. SOFT 수용에는 사람 검토 근거 ID와 현재 identity·artifact·stage·finding ID·code·scope·region·검사 ID·버전·근거 ID가 모두 일치해야 한다. |

반환값은 `kind`, `reasons`, `findingIds`, `acceptedSoftFindingIds`, `revalidateCheckIds`, `execution`, `countsAsDispatch`다. `execution`은 제출된 실행 상태와 시도 ID·단계·시작 여부·근거 ID·오류 및 복구 분류·정산값을 보존한다. `resultUnknown`은 공급자 관측의 불확실성을 나타낸다. 모든 반환에서 `countsAsDispatch`는 `false`다. 실행과 게시는 각 소유 경계의 권한 검사를 거친다.

## 판단 우선순위

1. **`BLOCKED`**는 잘못된 형식 `COMMON_CONTRACT_INVALID`, 현재 권한·단계 불일치 `AUTHORITY_MISMATCH`, 현재 결속 불일치 `COMMON_CONTRACT_STALE`, 산출물·검사 출처 불일치 `SOURCE_INTEGRITY_FAILED`, 또는 `HARD_VIOLATION`에 적용한다. 이미 시작된 실행이 불명확하면 `RESULT_UNKNOWN`을 부가 사유로 남기고 시도·시작·근거·정산값을 보존한다.
2. **`RESULT_UNKNOWN`**은 명시적 결과 불명, 또는 전송 효과가 있을 수 있는 시도에서 timeout·전송/정리 불명·시작 여부 또는 정산 미확정에 적용한다. 비용 미확정은 `null`로 유지한다. 복구 분류의 오류 코드와 유형을 판단 근거로 사용한다.
3. **`MANUAL_REVIEW`**는 확인된 미완료·부분 성공, 누락된 관측·품질 근거, 검사 실패 또는 미검토 SOFT에 적용한다. 필수 검사 목록이 비거나 필수 측정이 없으면 `QUALITY_EVIDENCE_MISSING`이다. 이 슬라이스의 완료 전 상태는 `STAGE_INCOMPLETE`와 기존 실행 상태로 표현한다.
4. **`REVALIDATE_STAGE`**는 동일한 산출물에 결속된 필수 검사의 버전이 달라진 경우에 해당 검사 ID만 반환한다. 이전 단계의 검사·모델·파일 접근은 호출하지 않는다.
5. **`PASS`**는 현재 authority와 완료 근거, 일치하는 필수 측정이 있고 미해결 위반·경고가 없을 때 적용한다. 승인된 SOFT는 `findingIds`와 `acceptedSoftFindingIds`에 함께 남는다. 가독성 수용은 일치하는 경고 범위에 적용하며 번역 의미에는 별도 근거가 필요하다.

## 실행 증거

프로젝트의 `>=24.11.1 <25` 범위에 맞는 Codex Primary Runtime 번들 Node `v24.22.1`을 전체 경로로 지정했다. Git 인계의 `codex/mangohana-v2-sites-20261111`과 HEAD `26c7d96c29577035f4bdd306b1451aac15a5b883`가 일치했고 시작 전 제품 코드와 테스트 대상은 둘 다 없었다. OneDrive 공통 작업 기준은 로컬 보존 사본을 사용했다. [Git 인계](2026-11-18-v2-stage14r3-git-handoff.md) · [Node 요구 버전](../../package.json) · [공통 작업 기준 보존 사본](../reference/trio-main/AGENTS.md#웹서비스-목표와-작업-보고)

| 순서 | 실행 | 실제 결과 |
|---|---|---|
| 초기 RED | `node --test tests/v2/stage15-quality-decision.test.mjs` | 종료 1. 구현 파일 부재로 `ERR_MODULE_NOT_FOUND`. |
| 동작 RED | 같은 집중 명령, 차단만 반환하는 시작점 | 종료 1. 18개 중 1 통과, 17개 단언 실패. 정상 입력도 `BLOCKED`였다. |
| 첫 GREEN | 같은 집중 명령 + 기존 정책 회귀 | 종료 0. 집중 18/18, 회귀 38/38. |
| 경계 RED | 미시작 또는 실패 코드와 함께 온 성공 관측 추가 | 종료 1. 19개 통과, 2개 단언 실패. 두 모순 모두 `PASS`였다. |
| 최종 GREEN | `node --test tests/v2/stage15-quality-decision.test.mjs` | 종료 0. 21/21 통과, 실패·건너뜀 0. |
| 기존 정책 회귀 | `node --test tests/v2/quality-policy.test.mjs` | 종료 0. 38/38 통과, 실패·건너뜀 0. |

| 시점 | 대상 | SHA-256 |
|---|---|---|
| 초기·동작 RED | 집중 테스트 | `919a03ca765ce8a58d6bc6b5040913189715d3c4825d859054fa78289523f0ca` |
| 동작 RED | 차단만 반환한 임시 정책 | `556c9cf36bb47fa0b30339acb9304925333a7266f3d86c63eac5fae4081374c5` |
| 경계 RED | 관측 형식 수정 전 정책 | `e850f3ebc38a509808a5f7b906821482942d59c5dbd0507bd522f7af3a91548f` |
| 경계 RED·최종 GREEN | 집중 테스트 | `8fd2310860bb0ff8499497789af0436e5e7b88d3b2436b7895af53842f3fc6d9` |
| 최종 GREEN | 정책 코드 | `902de5c4875328bbe96d506535fb3d4cae7d1ebdab7fd94f1bb1cbbbc56323a2` |
| 전후 동일 | `recovery-policy.cjs` | `161a708dae946d67f3a8f0fa215c18f6a63ac84af85279842b1d61f81300d812` |
| 전후 동일 | `v2-common-contract.mjs` | `e2fd1e616d874365097363c4228d5794bcdb9e13ddcb184e6cadae9d7a3c2def` |
| 전후 동일 | `quality-policy.test.mjs` | `fb0747c3430af3dc7144ab563a981af63bc612d739005ac15e1e7e8563495308` |

변경은 새 정책·합성 테스트와 Stage15 계획의 진행 기록 및 이 검증 문서에 한정했다. 기존 미커밋 작업, revision 14 사용자 가독성 승인과 승인 번역·배치·ROI·cleaned·최종 PNG, `FAILED` 5개·`SUCCEEDED` 2개 실행 기록은 당시 보존 상태를 유지한다. 이번 작업에서는 그 실물과 영수증을 다시 검사하지 않았다. 새 정책의 import는 합성 테스트 한 곳이며 실제 dispatch·모델 호출·Permit 발급·PNG 생성은 모두 0회다. 실제 HMAC, 브라우저 인증, 실제 모델, 제품 E2E는 미검증이다. 메인 에이전트가 구현·검증했고 하위 에이전트는 0개다. [Stage14-R3 마감 증거](2026-11-18-v2-stage14r3-human-readability-closeout.md)

## S15-02 인계

현재 함수는 소유 경계가 검증한 상태·증거 ID와 결속을 신뢰한다. 단계별 필수 검사·버전과 검사 근거의 생성은 S15-02의 검사기에서 담당한다. 검사와 finding을 동일한 현재 artifact·입력 digest·revision에 결속하고, 검사 누락을 명시해 빈 결과로 통과하지 않게 한다. DAG를 검증하고 최초 원인과 영향을 받은 단계만 식별하는 작업은 S15-02로 남겼다. Stage14의 다중 페이지·실제 모델·독립 품질 검증은 기존 계획의 후속 증거로 유지한다.
