# MangoHana V2 S15-03 합성 provider 계약 검증

2026-11-18 KST. Node 24.22.1에서 S15-03 집중 검사는 22/22였다. 임시 로더로 fixture를 바꾼 별도 격리 배치 회귀는 17/17이었다. 원래 fixture와 E: 경로를 그대로 사용한 배치 검사는 미실시다. 작업 유형은 provider 계약 코드 개선과 합성 검증이다. [Stage15 계획](../superpowers/plans/2026-11-18-mangohana-v2-stage15-implementation-plan.md) · [S15-02 검증 기록](2026-11-18-v2-stage15-inspection-graph.md)

## 입력과 결과 관측

`createStage15ProviderAdapter({ providers, now })`의 registry는 provider·모델 ID·버전·profile SHA, 단계·partial·lookup·confidence 지원 범위와 합성 포트를 고정한다. `dispatch(providerId, input, options)`와 `lookup(providerId, input, options)`는 호출자가 지정한 포트만 사용한다. `options`에는 `AbortSignal`과 동일한 단조 시계 기준의 절대 `deadlineMs`를 전달할 수 있다. [합성 어댑터](../../apps/engine/stage15-provider-adapter.mjs)

입력은 `executionId`, S15-01 `binding`, S15-02 `node { id, stage, regionId, inputsSha256, parents }`, `inputs`, 대상 `regionIds`다. 단계 입력과 부모 지문을 확인하고 owner·페이지·리비전·출처·범위와 provider·모델 버전을 요청 지문에 결속한다. 응답은 실행 ID·요청 ID·입력 digest·요청 지문을 되돌려줘야 한다. 산출물 ID와 바이트의 SHA-256, 요청 영역 집합, confidence 종류·척도·근거·범위를 검증한다. [기존 운영 포트 계약](../../packages/domain/src/provider.ts) · [S15-02 단계 그래프](../../packages/ai-engine/quality/stage15-stage-graph.cjs)

| 상황 | 반환 |
|---|---|
| 완료 | 원본 provider 관측·검증된 산출물·S15-01/02 `observed`를 반환한다. S15-02에서 최종 번역 content를 다시 검사한다. |
| 일부 성공 | `PARTIAL`과 수신·누락 영역을 명시한다. `complete: false`와 빈 완료 산출물 참조를 유지한다. |
| 진입 전 deadline | `CONFIRMED_NOT_STARTED`, `BEFORE_DISPATCH`, `started: false`. 관측되지 않은 청구는 `null`이다. |
| 전송 후 transport·RPC timeout, 응답 유실, 호출자 중단 | `RESULT_UNKNOWN`. 시작 확인 근거가 있으면 보존하고, 시작 미확정은 `null`이다. 오류 출처를 `TRANSPORT`, `PROVIDER`, `DEADLINE`, `CALLER`로 기록한다. |
| 조회 | `UNSUPPORTED`, `NOT_FOUND`, `RETURNED`, `ERROR`를 구별한다. 조회는 같은 입력/실행 ID를 전달하고 새 실행을 만들지 않는다. |
| 형식·결속 오류 | 외부 응답처럼 결속이 다르면 `INVALID_OUTPUT`과 결과 불명이다. 결속된 완료 응답의 산출물·confidence·사용량 구조가 깨지면 출력은 거부하고 별도로 확인된 시작·provider 결과·청구 근거를 보존한다. |

## 시간과 비용

시도별로 로컬 전송 응답 대기, 조회, provider·모델·큐 시간, 요청 수와 토큰을 따로 보존한다. 기존 `usageFromReport`를 사용해 같은 페이지 요청이 여러 영역에 나타나는 경우 한 번만 합산한다. `aggregateStage15Usage`는 같은 단계 입력과 리비전의 시도별로 합산하며, 동일 근거 재조회와 중복 기록은 한 번만 센다. 다른 시도에 같은 근거 ID가 붙거나 같은 ID의 사실이 충돌하면 거부한다. 조회 지연은 전송 응답 시간 합계에 포함하지 않는다. [기존 사용량 집계](../../apps/engine/store.mjs) · [집계 구현](../../apps/engine/stage15-provider-adapter.mjs)

USD는 운영 비용 타입과 같은 소수 자릿수 범위에서 증거가 있는 값만 정확한 십진수로 합산한다. 근거 없이 보고된 0원은 원본 주장에 남고 정규화된 청구액은 `null`이다. 시도 하나라도 미확정이면 전체 금액은 `null`이며 확정 부분합과 미확정 실행 ID를 반환한다. 누락된 시간이나 토큰 합계도 `null`이다. 테스트 금액과 시간은 합성 fixture 값이다. [운영 비용 타입](../../packages/domain/src/full-stage-cost.ts)

## RED와 GREEN

브랜치 `codex/mangohana-v2-sites-20261111`과 HEAD `4a87e02020a62b3a8925c6568925477e8b063b78`에서 시작했다. S15-02 검증 기록의 검사기·그래프·테스트 SHA-256과 현재 값이 일치했고, S15-03 소스와 테스트는 시작 당시 없었다. Node 범위 `>=24.11.1 <25`를 충족하는 Codex Primary Runtime 번들 `v24.22.1`을 절대 경로로 선택했다. [프로젝트 Node 요구 범위](../../package.json)

| 검증 | 실제 실행 결과 |
|---|---|
| 초기 RED | `node --test tests/v2/stage15-provider-contract.test.mjs`. 종료 1, 신설 어댑터 부재 `ERR_MODULE_NOT_FOUND`. |
| 첫 GREEN | 같은 명령. 종료 0, 18/18. |
| 경계 RED | 같은 명령. 종료 1, 18 통과·4 실패. 근거 없는 0원의 처리 상태, malformed legacy usage의 예외, 리비전 혼합 합산, 모델 버전의 지문 누락을 재현했다. |
| 최종 집중 GREEN | 같은 명령. 종료 0, 22/22, 실패·건너뜀·취소·todo 0. |
| 지정 배치 회귀 첫 시도 | Windows preloader URL 형식 오류로 수집 전에 중단했다. URL을 수정한 뒤 고정 PNG의 픽셀 디코딩 오류로 1 통과·16 실패를 확인했다. |
| 지정 배치 회귀 최종 | `node --import <OS tmp hook file:/// URL> --test tests/v2/batches.test.mjs`. 종료 0, 17/17, 실패·건너뜀 0. |

기존 배치 fixture의 두 PNG 인코딩과 E: 출력 경로는 사용자 조건을 적용하기 위해 테스트 프로세스의 로더에서만 바꿨다. 고정 PNG는 현재 sharp에서 픽셀 디코딩을 확인한 `tests/fixtures/native-images.ts`의 `ownedNativePng`를 사용했다. 1×1, 91바이트, SHA-256 `880c5d66b17c821a9970f9ab4be09970d43c77dd987963bc23e03c6aaed1a97a`다. 테스트 본문, 기존 저장·디코딩, JPEG/WebP 인코딩과 원본 보존 assertion을 유지했다. OS tmp의 합성 저장 테스트는 기존 PNG 바이트의 사본을 사용했고 PNG 인코더와 제품 최종 출력 생성은 0회다. repo의 원래 fixture를 그대로 로드하는 E: 경로 실행은 미실시다. [기존 배치 테스트](../../tests/v2/batches.test.mjs) · [기존 PNG fixture](../../tests/fixtures/native-images.ts)

| 시점 | 파일 | SHA-256 |
|---|---|---|
| 초기 RED | `stage15-provider-contract.test.mjs` | `99bdd768180868fdf2de4a843677f4a8f990eb33ea14671a6a48f8bdf58d051c` |
| 경계 RED | 수정 전 `stage15-provider-adapter.mjs` | `89a71e61749b9a1d836ed2b2c0bd99acfe334cd917b27bb9463d115d0220eb95` |
| 경계 RED·최종 GREEN | `stage15-provider-contract.test.mjs` | `04725b9cd7be2900551aa7d6d13d5da3c94e80b68fed0eac7bf16725b0ff5612` |
| 최종 GREEN | `stage15-provider-adapter.mjs` | `ed93cb0e7961b1dc53ffdef9cf9a52704edae6c722616376c2d8f48583e746ff` |

메인 Codex가 구현과 집중 검증을 수행했다. 지정 배치 회귀는 프로젝트 `test_verifier` 한 명이 수행했다. 역할 설정은 GPT-6 Luna/low이며 실제 프리셋·추론값은 별도 확인하지 않았다. 첫 배치 실행이 fixture 디코딩에서 실패한 뒤 메인이 검증한 기존 PNG로 한 번 재검증했다. 위 배치 결과는 검증자의 실행 보고와 일치하는 소스 지문에 근거하며 검증자 세션의 임시 로그는 메인 세션에서 재열 수 없었다.

## 변경 보존과 검증 한계

S15-04에서 당시 검증자의 후속 차례에 저장된 실제 명령, 로더 원문과 합쳐진 stdout/stderr를 회수했다. 원실행은 fixture의 E: 경로와 PNG 인코딩 두 곳을 치환했고 17/17, 종료 0이었다. 당시 개별 stdout/stderr와 임시 파일 자체는 회수하지 못했다. 회수 전에 수행한 새 재현도 17/17, 종료 0이지만 정규화 PNG 재인코딩을 실행했다. 각 실행의 명령·로더·SHA·로그를 별도로 보존했다. [원실행 출력](stage15-04-20261118/s15-03/original-combined-output.txt) · [두 실행의 조건과 증거](stage15-04-20261118/s15-03/evidence-summary.md)

변경은 새 어댑터와 집중 테스트, 계획의 진행 기록, 이 문서에 한정했다. 기존 미커밋 변경, revision 14 가독성 승인, 승인 번역·배치·ROI·cleaned·최종 PNG와 `FAILED` 5개·`SUCCEEDED` 2개 원장은 기존 상태를 유지한다. 승인 기록의 해시는 일치했으며 실제 PNG와 영수증은 이번 검증에서 다시 읽지 않았다. [Stage14-R3 마감](2026-11-18-v2-stage14r3-human-readability-closeout.md) · [사용자 승인 기록](stage14r3-human-readability-closeout-20261118/evidence/human-readability-approval.json)

| 보존 파일 | SHA-256 |
|---|---|
| `AGENTS.md` | `02d495bc13507e4699fb99ba4c07bf23470735e076414456afcbd67510f3c90b` |
| `2026-11-18-v2-stage15-inspection-graph.md` | `23063e6d3415f407ab9f6275eeeda59a5c15d77f1229cb45ea38f1db27f42e2a` |
| `2026-11-18-v2-stage14r3-human-readability-closeout.md` | `f2bf9d80da5310dda1c391580001325efae4e5130f06923b6e608296f4302a36` |
| `human-readability-approval.json` | `32f9e038d920062d9b97122a78f50de1e220f4a49c2cd639e99aeaa30c3f96d9` |
| `stage15-quality-inspection.cjs` | `4ef51f3f8833533decf45124cec98abd4676dab82fe3d57ba296ba6dd0b2ae3f` |
| `stage15-stage-graph.cjs` | `edcedf8a99a767d302eac0cb1c1124d9fed9e9dfaec110adfa42c762df4d1b05` |
| `stage15-inspection-graph.test.mjs` | `14a704b02626e5ee43d4488985bb8006c54d54caa6d005f944c0c0862c2ac7c4` |
| `provider.ts` | `4b2cb6bda754a22a40a8c0231721f35e396dfa196a204cc12e0d81f55d96e6de` |
| `full-stage-cost.ts` | `2cd85f2b29c2288c144dd308be2b4c9428bfa724b9a14d0b2a5728bb2d5a179b` |
| `store.mjs` | `7593ec88bd41595015718f6ec83098d93e480be8ffb5c5f0bc4e2859589677cb` |
| `batches.test.mjs` | `1e92b001129e8c99822b136c9c9d3634bc48dc7fa01e967feee89b7b28e17107` |
| `batch-fixture.mjs` | `ced6d927f0d06d8fc39a19193c24f243ec3f34e1f6676b21e037ddb3a5f1812a` |
| `native-images.ts` | `bbf66ec2533aa28699d43812dd0377ef070c81f5e430be2749276ea7b4f7bc75` |

새 어댑터의 import는 합성 테스트 한 곳이다. 실제 dispatch·모델 호출·Permit 발급·최종 PNG 생성·PNG 인코딩 0회. 설치 모델 프로필 원본의 읽기는 현재 권한에서 거부됐으며 합성 registry만 사용했다. 실제 provider 프로토콜과 운영 정산·제품 E2E는 미검증이다. 현재 lookup은 소유 경계가 같은 provider와 동일 입력을 재제공하는 합성 조회다. S15-04 실행 예약·합성 재검증 실행기 구현은 시작하지 않았다.
