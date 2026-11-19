# S16-02 종료 인계

2026-11-18 KST, `C:/dev/Projects/mangohana`, 브랜치 `codex/mangohana-v2-sites-20261111`, HEAD `4a87e02020a62b3a8925c6568925477e8b063b78`. S16-02의 합성 실험 사전 잠금까지 구현했다. 다음 계획 단위 S16-03은 미착수다. [Stage16 계획](../plans/2026-11-18-mangohana-v2-stage16-implementation-plan.md) · [검증 보고서](../../validation/2026-11-18-v2-stage16-experiment-lock.md)

- **인수할 결과** — 실험 표본의 작품·누출 그룹이 달라도 후보 선정 문맥 SHA가 겹치거나 노출 근거가 불명이면 잠금 ID는 `null`이다. 독립 대조군은 사전등록 SHA와 현재 이력 SHA가 모두 맞을 때 결정적인 ID를 반환한다. 결과 열람 후 튜닝한 작품은 개발셋 강등 기록과 대체 표본 요구가 남는다. [공개 함수와 합성 입력](../../../tests/v2/stage16-experiment-lock.test.mjs) · [실제 합성 응답](../../validation/stage16-02-20261118/synthetic-decisions.json)
- **검증 근거** — 최초 RED 2건, 최종 집중 55/55, 관련 회귀 108/108. 독립 계산 1명이 대조군과 첫 두 차단 판정을 확인했고 최종 소스에서 같은 기대값을 재확인했다. [실행 인수·소스·로그 SHA](../../validation/stage16-02-20261118/test-runs.json)
- **실행 범위 이탈** — 중간 회귀에서 의도와 달리 Stage05 검사 4건이 합성 PNG를 메모리와 OS 임시 폴더에서 처리했다. 해당 실행은 최종 검증 수치에서 제외했다. 최종 회귀는 정확한 허용 이름과 이미지 호출 차단을 적용했다. 실제 자료·제품 모델·Permit·사용자 결과 PNG 실행은 0회다. [당시 실행 목록](../../validation/stage16-02-20261118/matrix-policy-dataset-regression.log) · [최종 회귀](../../validation/stage16-02-20261118/final-regression.log)

실제 미사용 작품, 독립 사람 정답, 11M의 실제 노출 이력과 고정된 기준의 출처는 미검증이다. 잠금 ID는 메타데이터의 지문이다. Stage05의 홀드아웃 정답 열람 범위와 Stage06의 최종 평가 차단이 적용된다. 후속 요청이 들어오면 S16-03의 합성 영수증 대조 범위부터 기존 계획에서 확인한다. [원래 인계](2026-11-18-stage16-s01-handoff.md) · [계획의 작업 순서](../plans/2026-11-18-mangohana-v2-stage16-implementation-plan.md#작업-순서와-검증)

## 권장 스킬

다음 합성 계약의 실패 선행에는 Superpowers의 `test-driven-development`, 실행 근거 확인에는 `verification-before-completion`, 다음 인계 갱신에는 Matt Pocock의 `handoff`를 사용한다.

2026-11-19 KST에 S16-03의 합성 영수증 대조를 마쳤다. 현재 재개 기준은 [S16-03 종료 인계](2026-11-19-stage16-s03-handoff.md)에 있다.
