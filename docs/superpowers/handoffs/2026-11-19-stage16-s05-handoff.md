# S16-05 종료 인계

2026-11-19 KST. 오프라인 짝비교 보고서의 구현과 합성 검증을 마쳤다. 브랜치는 `codex/mangohana-v2-sites-20261111`, HEAD는 `4a87e02020a62b3a8925c6568925477e8b063b78`이다. S16-06은 미착수다. [단계 계획](../plans/2026-11-18-mangohana-v2-stage16-implementation-plan.md) · [검증 보고서와 손계산](../../validation/2026-11-19-v2-stage16-paired-report.md) · [직전 인계](2026-11-19-stage16-s04-handoff.md)

## 보고서를 다시 만드는 방법

1. 운영자 측에서 `buildStage16PairedReport(input, pins)`를 호출한다. `input`에는 S16-02의 `lock`·`preregistration`, S16-03의 `observations`, S16-04의 전체 반환 원장 `review`, 저장한 자동 점수 묶음 `automatic`을 전달한다. 각 단계에서 별도 보관한 `lockId`, `jobsSha256`, `observationsSha256`, `sealSha256`, `reviewSha256`, `automaticSha256`를 `pins`로 준다. 반환 요약만 남은 경우에는 원래 봉인표·지문·응답 묶음으로 S16-04 원장을 재구성한다. [공개 함수](../../../packages/evaluation/stage16-paired-report.mjs) · [전체 호출 예시](../../../tests/v2/fixtures/stage16-paired.mjs)
2. 자동 점수 묶음은 `schemaVersion: 1`, `kind: stage16-automatic-scores`, 출처 `evidenceKind`, 잠금·관측·평가기 지문과 `rows`를 담는다. 행은 작품·페이지·모델·처리·최종 결과 SHA와 의미·자연스러움 점수 두 개를 가진다. 축별 점수는 0~1 또는 `null`과 결측 사유다. 아직 점수가 없으면 빈 행 배열을 사용한다. 합성 및 저장 자동 평가의 출처 표식은 각각 `synthetic`과 `saved_automatic`이다. [입력 예시](../../../tests/v2/fixtures/stage16-paired.mjs) · [합성 계산 결과](../../validation/stage16-05-20261119/synthetic-report.json)
3. `models.A/B.works`에서 작품·페이지·원래 표결과 실행 비용을 추적한다. `axes`에는 품질 축별 대응 차이·결측 범위·불일치율·작품 간 구간, `primary`와 `noninferiority`에는 사전등록 기준 대조 결과, `costAdjusted`에는 두 처리 각각과 합계의 효율이 있다. S16-05가 해석하는 등록 지표는 `work_paired_score`이며 의미 선호가 주축이고 자연스러움에 비열등성 허용치를 쓴다.

최초 RED 3건, 분수 반올림 보강 RED 1건, 최종 집중 25/25와 관련 회귀 24/24를 확인했다. 기록된 Node에서 `run-allowed.mjs focused`와 `run-allowed.mjs regression`을 사용하면 같은 파일·이름 허용 목록과 이미지 차단기가 적용된다. 실제 자료·제품 모델·Permit·사람 평가·이미지 처리는 0건이다. 실제 평가의 자료·실행 권한·사람 증거는 후속 단계의 인수 조건으로 남는다. [실행기](../../validation/stage16-05-20261119/run-allowed.mjs) · [Node 경로·지문·로그](../../validation/stage16-05-20261119/test-runs.json)

## 권장 스킬

별도 요청으로 다음 계획 단위를 시작할 때는 Superpowers의 `test-driven-development`와 `verification-before-completion`을 적용한다. 인계 갱신에는 Matt Pocock의 `handoff`를 사용한다.
