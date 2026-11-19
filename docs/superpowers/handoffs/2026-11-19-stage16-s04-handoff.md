# S16-04 종료 인계

2026-11-19 KST. 블라인드 평가의 오프라인 배정과 회수를 구현하고 합성 검증을 마쳤다. 브랜치는 `codex/mangohana-v2-sites-20261111`, HEAD는 `4a87e02020a62b3a8925c6568925477e8b063b78`이다. S16-05는 미착수다. [16단계 계획](../plans/2026-11-18-mangohana-v2-stage16-implementation-plan.md) · [검증 보고서](../../validation/2026-11-19-v2-stage16-blind-review.md) · [직전 인계](2026-11-19-stage16-s03-handoff.md)

## 인수할 자료

- 운영자가 `prepareStage16BlindReview(input, anchors, seed)`에 S16-02 잠금·명부·사전등록, 조건표, S16-03 관측, 블라인드 절차를 전달한다. 별도 보관한 `lockId`, `jobsSha256`, `observationsSha256`를 `anchors`로 준다. 32바이트 비밀은 64자리 소문자 hex이며 절차의 `seedSha256`은 그 문자열의 `contentSha256(seed)`다. 받은 `seal`은 운영자용이고 `sealSha256`을 별도로 보관한다. [구현](../../../packages/evaluation/stage16-blind-review.mjs) · [호출용 합성 입력](../../../tests/v2/fixtures/stage16-blind-review.mjs)
- 운영자가 `stage16ReviewerPacket(seal, sealSha256, reviewerId)`로 각 평가자의 서식을 꺼낸다. 원문·문맥·A/B는 봉인표에서 대응 지문을 찾을 수 있는 익명 참조다. [평가자 1 서식](../../validation/stage16-04-20261119/synthetic-form-1.json) · [평가자 2 서식](../../validation/stage16-04-20261119/synthetic-form-2.json)
- `collectStage16BlindReturns(seal, sealSha256, envelopes)`에 수령자별로 보관한 전체 반환 묶음을 넣는다. 각 응답은 배포받은 문항에 `semanticFidelity`와 `naturalness`를 따로 채운다. 회수 원장은 작품·페이지·모델·결과 지문·평가자별 원래 선택과 해석, 미응답 사유, 축별 미해결 불일치를 보존한다. [합성 봉인표·반환 묶음](../../validation/stage16-04-20261119/synthetic-coordinator.json) · [회수 결과](../../validation/stage16-04-20261119/synthetic-recovery.json)

최초 RED 7건, 보강 RED 3건, 최종 집중 21/21과 관련 회귀 23/23을 확인했다. 첫 검사부터 이름 허용 목록과 이미지 차단기가 적용됐다. 재검증에는 기록된 Node로 `run-allowed.mjs focused`와 `run-allowed.mjs regression`을 사용한다. 실제 자료·모델·Permit·사람 평가·이미지 처리는 0회다. [실행기](../../validation/stage16-04-20261119/run-allowed.mjs) · [Node 경로·로그·SHA](../../validation/stage16-04-20261119/test-runs.json)

## 권장 스킬

별도 요청으로 다음 계획 단위를 시작할 때는 Superpowers의 `test-driven-development`와 `verification-before-completion`을 사용한다. 인계 갱신에는 Matt Pocock의 `handoff`를 사용한다.

이후 S16-05에서 이 인계의 합성 봉인표와 반환 묶음을 작품별 짝비교 보고서까지 연결했다. [S16-05 종료 인계](2026-11-19-stage16-s05-handoff.md)
