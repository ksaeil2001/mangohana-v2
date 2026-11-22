# Stage18 종료 인계

2026-11-19 KST 재평가. **Stage17은 개발 3/3(100%)·출하 `BLOCKED`, Stage18은 개발 2/2(100%)·현재 후보 `HOLD`다.** 공식 20개 절은 00~18과 11M이며 18이 마지막이다. 현재 브랜치는 `codex/mangohana-v2-sites-20261111`, HEAD는 `bb40e16c00de0fed5f06530cf13648dd8a0b49db`다. 이번에 대조한 저장 로그의 제품·테스트 소스 401개가 현재 파일과 일치한다. [출하·변경 재평가와 실제 검증 준비표](../../validation/2026-11-19-v2-stage17-18-release-reassessment.md)

최신 Windows TAP은 전체 V2 **1,340/1,340**, 지정 5개 파일 **40/40**, Stage16 보호 검사 **193/193**(고유 이름 130개)였다. 릴리스 점검표에 최신 회귀를 반영하면 13개 중 통과 4, 추가 검토 3, 미실행 6이다. 실기기·운영 인증/보안·자원·성능·복구·실제 사용자 저장/복원·품질·승인은 남아 있다. Stage18의 당시 기록 재생은 `ROLLBACK`, 같은 후보에 최신 회귀를 연결한 읽기 전용 판정은 `HOLD`다. 새 원고·예산·검토 확정이 빠져 이전 정상 지문을 유지한다. 합성 전후 각 4건·1 USD, 실제 비용과 절감액은 `null`이다. [최신 실행 원장](../../validation/stage17-windows-regression-20261119/quiet-results.json) · [당시 판정](../../validation/stage17-18-20261119/change-decision.log)

## 다음 세션의 첫 작업

1. 사용자가 제공할 **미사용 작품·원본/문맥의 노출 이력, 사용권, 독립 정답 봉인 지문**을 작품을 열기 전에 대조한다. Stage16 실제 개시와 최종 인수는 모두 `BLOCKED`이며 실제 개시 지문은 없다. [실제 인수 계약](../../validation/2026-11-19-v2-stage16-final-acceptance.md)
2. 운영자가 실제 두 페이지·네 조건 경로의 실행/조회/정산, RAM·VRAM·디스크·소유 프로세스 계측과 반환 준비를 증명한다. 현재 운영 worker에는 `RUNTIME_PIPELINE_UNIMPLEMENTED` 경계가 있다. 사용자는 실제 owner/page/revision, A/B × 기존/개선의 모델·버전·폰트·입력, 허용 단계, 페이지·배치 상한 및 fallback 최대 1회의 범위를 승인해야 한다. 시험·품질 평가 승인과 최종 출하 승인을 따로 받는다. [운영 경로](../../../packages/operations/src/runtime-startup.ts) · [두 페이지 시험 조건](../../validation/2026-11-18-v2-stage15-integration.md)
3. 별도 실제 실행 승인이 갖춰지면 당시 잠금·승인·작업 목록을 읽기 전용 개시 판정기로 확인하고 실행 전에 개시 지문을 보관한다. 그 뒤 같은 실행 ID의 시작·결과·정산·반환, 서로 독립인 평가자 2명의 블라인드 의미/자연스러움 원응답·인증, 작품별 짝비교를 확인한다. 불명 결과는 같은 실행 ID를 조회한다. Windows 조사는 새 실패 로그가 들어온 경우에 해당 시도의 첫 미관측 경계에서 재개한다.

누락 조건과 제출 주체·시점은 [재평가 보고](../../validation/2026-11-19-v2-stage17-18-release-reassessment.md)에 있다. 이번 확인에서 보호 파일 18/18, revision 14 승인 PNG, 별도 서명 결과와 기존 Permit 7개(실패 5·성공 2)가 일치했다. 다음 세션에 권장하는 스킬은 증거 대조에 Superpowers의 `verification-before-completion`, 인계 갱신에 Matt Pocock의 `handoff`다.

## 개발 종료 당시의 기록

S18-01 변경 기록과 S18-02 비용·사용량 비교를 구현하고 기존 Stage16의 저장 원장에 연결했다. 아래 표는 그 당시의 1,330/1,340 전체 회귀를 사용한 평가 이력이다. [당시 변경 판단](../../validation/stage17-18-20261119/change-decision.log) · [비용 비교](../../validation/stage17-18-20261119/usage-comparison.log) · [개발 종료 보고서](../../validation/2026-11-19-v2-stage17-18.md)

| 원문 줄 | 요구와 이번에 확보한 근거 |
|---|---|
| 490 | 변경 한 건에 결과 한 가지와 종료 조건을 기록한다. 두 값이 없으면 판정기는 채택을 보류한다. |
| 491 | Stage17의 실제 소스 변경 한 건에서 OCR 좌표 편집의 최초 오류, 가설, RED·표적·새 원고·회귀·최종 판정을 재생한다. 전체 회귀 실패에서 이전본 유지가 선택됐다. 실제 미사용 원고 검사는 `NOT_RUN`이다. |
| 492 | 변경 파일과 전후 SHA, 테스트 소유 원고, region ID 출처, 실행 명령·코드·로그, 편집 뒤 PNG를 기록한다. 수정 전 PNG·실측 시간·토큰·비용은 미측정이다. |
| 493 | 다음 담당자에게 줄 질문 한 개, diff 요약, 근거 경로와 선택적 crop을 추출한다. 이번 독립 검증에는 대상 파일·테스트 소유 자료의 범위만 전달했다. |
| 494 | 지문·결과 파일 동일성·CSS·비용을 코드로 계산했다. 제품 모델 실행은 0회다. |
| 495 | 같은 P0의 서로 다른 두 번의 수정 실패 또는 근거가 확인된 구조·데이터 손실·보안·충돌 조건에서만 승격 자격을 표시한다. 이미 승격한 문제의 재승격을 막는다. 이번 Astra 호출은 0회다. |
| 496 | 중복 후보·추가 지식 부족·비용 상한·검토 불확실·새 원고 누락을 기록한다. 실패한 후보의 되돌림과 이전 정상 지문 유지, 합성 채택 연습을 각각 검증했다. |
| 497 | 모델·역할별 집계는 동일한 실행 ID 모집단을 사용한다. 중복 영수증, 미정산 부분합, 두 조건의 독립 영수증·동일 작업 단위를 검사했다. 저장 합성 원장의 4쌍은 전후 각각 1달러다. 실제 운영 주간 영수증은 없다. |
| 498 | 편집 소스·실제 AI·브라우저·사람의 네 축을 실제 실행 로그에서 기록했다. 전체 회귀는 `FAIL`, 실제 AI와 이번 사람 검토는 `NOT_RUN`이며 실기기·실서비스는 `NEEDS_REVIEW`다. 원로그에는 실패 시도도 함께 남아 있다. |
| 499 | Stage17 독립 브라우저 검증 1개와 Windows 오류 분석 1개가 종료됐다. Stage18 구현의 하위 호출은 0회다. 다음 재개 작업은 아래 공식 정의와 기존 원장·승인 경계를 따른다. |

제품 코드와 진입점은 [Stage18 판정기](../../../packages/evaluation/stage18-operations.mjs)와 [CLI](../../../scripts/v2/review-change.mjs)다. Node v24.22.1 실행 파일 경로와 인자는 각 JSON에, TAP 또는 명령 출력은 같은 이름의 log에 있다. 명령은 변경 기록의 `change`, 동일 모집단의 `usage`·`week`, 전후 비교의 `compare`를 지원한다. 실제 채택·절감에 쓰는 승인 지문은 운영자가 원자료에서 독립적으로 확인해야 한다. 개발자가 재현을 위해 생성한 합성 지문의 범위는 로컬 연습이다. [집중 검사 12/12](../../validation/stage17-18-20261119/operations-verified.json) · [최종 실행 근거](../../validation/stage17-18-20261119/release-regression.json)

최종 변경 기록의 네 축은 소스 `PASS`, 실제 AI `NOT_RUN`, 실제 Chrome의 합성 편집 `PASS`, 사람 `NOT_RUN`이다. 전체 회귀는 별도로 `FAIL`이며 두 판정 CLI의 종료 코드는 각각 2다. 누락 plan 단독 검사의 예상 종료와 네이티브 식자 controller 6개의 정리 결과를 진단 출발점으로 남겼다. [원자료](../../validation/stage17-18-20261119/native-controller-evidence.json) · [단독 재현](../../validation/stage17-18-20261119/entry-witness.log)

당시 브랜치는 `codex/mangohana-v2-sites-20261111`, 기준 HEAD는 `4a87e02020a62b3a8925c6568925477e8b063b78`였고 구현 변경은 미커밋이었다. 여기서 인계했던 Windows 네이티브 종료·기동 조사의 결과는 아래에 있다. [Stage17 인계](2026-11-19-stage17-handoff.md) · [개발 슬라이스와 파일 범위](../plans/2026-11-19-mangohana-v2-stage17-18.md)

## 후속 작업 결과 — Stage17 Windows 회귀

2026-11-19 재검증에서 기존 다섯 파일 40/40, 전체 V2 1,340/1,340, 누락 plan과 기본 식자 단독 각각 1/1, 원래 Stage16 보호 검사 193/193을 확인했다. 네이티브 식자는 후보와 영수증을 저장한 뒤 발생하던 Windows 종료 충돌을 재현했다. 프로젝트가 지정한 Electron 42.9.3과 전용 식자 경로에서 V8 메모리 풀을 끄고, 실패 진단 쓰기 전에 종료 코드 1을 설정했다. supervisor 영수증에 OS가 기록한 worker 종료 시각과 supervisor 준비 시각을 추가했다. 합성 번역 서버는 테스트가 미리 연 원장에 같은 요청 증거를 기록한다. [원인과 전체·단독 시간표](../../validation/2026-11-19-v2-stage17-windows-regression.md) · [최종 실행 원장](../../validation/stage17-windows-regression-20261119/quiet-results.json)

같은 최종 소스의 앞선 전체 실행은 1,333/1,340이었다. 합성 번역 준비 6건과 모델 없는 Electron 정상 기동 1건에서 원래 한도가 만료됐다. 최종 실행 중에는 별도 호스트 진단을 수행하지 않았다. Windows 지연을 일으킨 단일 원인과 다른 부하에서의 반복 안정성은 미확정이다. 위 Stage18 변경 기록의 `ROLLBACK`은 당시 입력에 대한 판정이다. 실제 미사용 작품 평가와 운영 출하 인수는 기존 `BLOCKED` 상태다. [같은 소스의 앞선 실패](../../validation/stage17-windows-regression-20261119/journal-results.json) · [보호 자료 대조](../../validation/stage17-windows-regression-20261119/quiet-protected-final.json)
