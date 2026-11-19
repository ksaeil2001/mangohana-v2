# MangoHana V2 S15-02 검사와 단계 의존 그래프 검증

2026-11-18 KST. S15-02의 검사기와 단계 의존 그래프(DAG)를 구현했다. Node 24.22.1에서 집중 테스트 22/22와 기존 회귀 28/28이 통과했다. 작업 유형은 제품 정책 코드 개선과 합성 검증이다. [Stage15 계획](../superpowers/plans/2026-11-18-mangohana-v2-stage15-implementation-plan.md) · [S15-01 검증 기록](2026-11-18-v2-stage15-quality-decision.md)

## 검사와 근거

`inspectStage({ binding, node, observed, authority, inputs, bytes, pixels })`는 현재 소유 경계의 `binding`과 권한, 노드와 관측을 대조한다. 노드는 `id`, `stage`, `regionId` 또는 `null`, `artifact { artifactId, sha256 }`, `inputsSha256`, `parents`를 가진다. 부모 참조는 `nodeId`, `artifactId`, `sha256`으로 이뤄지며, 관측의 `parentsSha256`은 산출물이 소비한 부모 목록을 정렬해 구한 지문이다. 노드의 입력 지문은 기존 checkpoint `key`의 정규화된 JSON 해시이며, 산출물 해시는 검사에 사용한 정확한 바이트의 SHA-256이다. [검사기](../../packages/ai-engine/quality/stage15-quality-inspection.cjs) · [checkpoint 지문](../../packages/ai-engine/quality/recovery-checkpoint.cjs)

| 단계 | 검사한 범위 |
|---|---|
| OCR | 현재 페이지의 승인된 영역 ID, 읽기 순서, 원본 줄 계보와 OCR 관측을 비교한다. 누락·중복·외부 계보를 해당 영역의 HARD로 기록한다. |
| TRANSLATE | 기존 파서로 최종 응답 JSON과 영역 ID를 확인한다. 최종 content가 깨지면 HARD이며, 구조가 정상인 번역의 의미 위험 신호는 기존 규칙 검사의 SOFT로 남긴다. |
| MASK | 메모리 RGBA 산출물에서 흰색 보존·이진 alpha와 허용·보호 범위를 확인한다. 보호 픽셀 하나의 alpha 변화를 검출했다. |
| TYPESET | 바이트로 결속된 식자 보고서와 입력·출력 RGBA를 기존 배경 픽셀 및 식자 검사에 전달한다. 글리프 위반과 승인 범위 밖 픽셀 변경을 검출했다. 래스터 바이트가 없으면 미검증이다. |

검사 결과는 노드·영역 ID와 입력·부모 지문, S15-01에 직접 전달하는 `assessment`다. 측정 근거 ID는 현재 binding, 노드와 산출물, 입력·부모 지문, 검사 ID·버전·상태에 결속된다. 결함과 경고는 같은 검사 근거 ID를 참조한다. 자료나 완료 관측이 없으면 `not_measured`와 `UNVERIFIED`로 남긴다. 오래된 결속과 바이트 불일치는 각각 `STAGE15_INSPECTION_STALE`과 `SOURCE_INTEGRITY_FAILED`로 반환 전에 차단한다. [합성 테스트](../../tests/v2/stage15-inspection-graph.test.mjs)

## 최초 확인 결함과 영향 범위

`analyzeStageGraph({ binding, graph, inspections })`는 순환, 누락·잘못된 부모, 오래된 원본·부모·검사 근거 및 모드별 금지 단계를 차단한다. 현재 노드에 결속된 HARD 근거를 위상 순서로 비교해 확인된 상위 결함을 우선하고, 명시된 자손만 `affectedNodes`와 `affectedStages`에 넣는다. 독립 영역은 별도 노드와 간선으로 유지한다. 번역이 마스크에 영향을 미치는 관계는 해당 간선이 있을 때만 반영한다. `TYPESETTING_ONLY`는 기존 승인 번역·레이아웃과 검증된 cleaned 입력을 읽는 노드에서 식자 → 결과 검사 → 게시 노드로 이어지며 모델 단계가 없다. [단계 그래프](../../packages/ai-engine/quality/stage15-stage-graph.cjs)

독립적인 HARD 원인 후보가 여럿이면 후보 목록을 반환하고 `firstBadStage`는 `null`이다. 상위 검사에 미검증 근거가 있으면 확인된 하위 결함과 영향 범위는 남기고 최초 원인은 미확정으로 둔다. SOFT나 미검증 근거만 있으면 영향을 확대하지 않고 검토 노드를 반환한다. 그래프 결과는 `countsAsDispatch: false`, `retryEligibility: UNDETERMINED`를 유지한다.

## 합성 RED와 GREEN

Git 기준은 `codex/mangohana-v2-sites-20261111`, HEAD `4a87e02020a62b3a8925c6568925477e8b063b78`이다. S15-01 마감 시의 코드와 테스트 SHA-256이 일치했고 S15-02 소스·테스트는 시작 전 없었다. 루트 요구 범위 `>=24.11.1 <25`를 충족하는 Codex Primary Runtime 번들 `v24.22.1`의 절대 경로를 사용했다. [Node 요구 범위](../../package.json)

| 시점 | 명령과 관측 결과 |
|---|---|
| 초기 RED | `node --test tests/v2/stage15-inspection-graph.test.mjs`. 종료 1, 신설 검사기 부재 `ERR_MODULE_NOT_FOUND`. |
| 동작 RED | 같은 명령. 근거 미검증과 빈 영향 범위만 반환하는 시작점에서 0 통과, 18 단언 실패. |
| 첫 GREEN | 같은 명령으로 18/18 통과. |
| 경계 RED | 원본 연결을 함께 바꾼 경우, 부모 변경 뒤 자식 보고서 재사용, 관측과 현재 부모 불일치, 상위 미검증 뒤 하위 원인 확정을 추가했다. 종료 1, 18 통과·4 단언 실패. |
| 최종 집중 GREEN | 같은 명령으로 종료 0, 22/22 통과. |
| 지정 회귀 독립 검증 | `node --test tests/v2/stage15-inspection-graph.test.mjs tests/v2/imported-image-pipeline.test.mjs tests/v2/stage14r-page-response.test.mjs`. 종료 0, 각각 22/22·15/15·13/13. 합계 50/50, 실패·건너뜀·취소·todo 0. |

| 검증 시점 | 파일 | SHA-256 |
|---|---|---|
| 초기·동작 RED | `stage15-inspection-graph.test.mjs` | `3eab37f2e2fd3902b83b7141fdb326298c41ef7a6069442b57e6851421ab2637` |
| 경계 RED | 수정 전 `stage15-quality-inspection.cjs` | `89ae2882a9ffd0c0137d82503e7c8f54f677b2d4c89c29c647d3c68b031fa1fa` |
| 경계 RED | 수정 전 `stage15-stage-graph.cjs` | `2d6f707c647f0e0521bdf1ed3d4c0472bd33fb483302c3fefa7d06a1430d6a9e` |
| 최종 GREEN | `stage15-quality-inspection.cjs` | `4ef51f3f8833533decf45124cec98abd4676dab82fe3d57ba296ba6dd0b2ae3f` |
| 최종 GREEN | `stage15-stage-graph.cjs` | `edcedf8a99a767d302eac0cb1c1124d9fed9e9dfaec110adfa42c762df4d1b05` |
| 경계 RED·최종 GREEN | `stage15-inspection-graph.test.mjs` | `14a704b02626e5ee43d4488985bb8006c54d54caa6d005f944c0c0862c2ac7c4` |

구현과 집중 검증은 메인 Codex가 수행했고, 지정 명령과 적용 범위의 독립 확인은 프로젝트의 `test_verifier` 한 명에게 맡겼다. 역할 설정은 GPT-6 Luna/low이며 실행 모델·추론값의 별도 확인은 미실시다. 검증자가 보고한 최종 소스 지문과 현재 지문이 일치한다.

## 보존과 검증 한계

변경 범위는 신규 정책 파일 2개와 집중 테스트 1개, Stage15 계획의 진행 기록과 이 문서다. 기존 Git 변경을 유지했고 아래 파일의 시작 전후 해시가 일치했다. revision 14 사용자 가독성 승인과 승인 번역·배치·ROI·cleaned·최종 PNG 및 `FAILED` 5개·`SUCCEEDED` 2개 원장은 기존 상태를 유지한다. 실제 자료·영수증의 재검증은 이번 합성 범위 밖이다. [기존 완료 기록](2026-11-18-v2-stage14r3-human-readability-closeout.md) · [사용자 승인 기록](stage14r3-human-readability-closeout-20261118/evidence/human-readability-approval.json)

| 시작 전후 동일 파일 | SHA-256 |
|---|---|
| `AGENTS.md` | `02d495bc13507e4699fb99ba4c07bf23470735e076414456afcbd67510f3c90b` |
| `2026-11-18-v2-stage15-quality-decision.md` | `d5a940f8b033139db16c2f89152550e101505be241272c29f9d7ce03d6d68a2b` |
| `2026-11-18-v2-stage14r3-human-readability-closeout.md` | `f2bf9d80da5310dda1c391580001325efae4e5130f06923b6e608296f4302a36` |
| `human-readability-approval.json` | `32f9e038d920062d9b97122a78f50de1e220f4a49c2cd639e99aeaa30c3f96d9` |
| `stage15-quality-decision.cjs` | `902de5c4875328bbe96d506535fb3d4cae7d1ebdab7fd94f1bb1cbbbc56323a2` |
| `stage15-quality-decision.test.mjs` | `8fd2310860bb0ff8499497789af0436e5e7b88d3b2436b7895af53842f3fc6d9` |
| `page-translation.cjs` | `e117f035049156264075cba7385e321847d8cf706fa2314ccbef10d007a28aa1` |
| `recovery-checkpoint.cjs` | `1aff650b45a2bd09eff7ed2e87336d73db8b4d94519607be99247767eed6398a` |
| `imported-image-contract.cjs` | `fd852dfbccaacd96db9f5b4d7cca25bf7782abb1f9b78e641a76a58b8e9f20dc` |
| `imported-image-pipeline.test.mjs` | `51158758aa52ad8a35fadca5127e3e6877de1b59bb51a8562cc2b160bf21e57f` |
| `stage14r-page-response.test.mjs` | `c550a2af0f6810d7336c55f29e0ffb219c68ad31fc2e7c74ccd29e8036177061` |

실제 dispatch·모델 호출·Permit 발급·PNG 생성 각각 0회. 새 검사기와 그래프는 합성 테스트에서만 진입한다. 지정 회귀는 기존 합성 이미지 포트와 저장된 번역 fixture를 사용했다. 실제 웹 제품 경로의 연결·서명·픽셀 디코딩 계보·독립 의미 및 사람 품질 검사는 별도 근거가 필요하다. S15-03은 시작하지 않았다.

현재 계약은 소유 경계가 정규화한 stage 입력과 현재 그래프 및 관측을 받는다. MASK와 TYPESET은 준비된 RGBA 바이트를 검사하며, 지원하지 않는 단계 검사는 `CHECK_NOT_IMPLEMENTED` 미검증을 반환한다. 최종 PNG 인코딩·재열기와 게시 영수증은 실제 소유 경계에서 검증할 항목으로 남는다.
