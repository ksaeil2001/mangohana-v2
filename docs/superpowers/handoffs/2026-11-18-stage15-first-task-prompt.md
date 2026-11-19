# 다음 세션으로 복사할 작업 요청

아래 인용 블록을 사용자가 새 Codex 세션에서 직접 전달할 수 있다.

```text
# MangoHana V2 Stage15 — S15-01 합성 품질 판단 정책

작업 폴더는 C:/dev/Projects/mangohana다. 먼저 아래 문서를 읽어라.

1. docs/superpowers/handoffs/2026-11-18-stage15-kickoff-readiness.md
2. docs/superpowers/plans/2026-11-18-mangohana-v2-stage15-implementation-plan.md
3. docs/validation/2026-11-18-v2-stage14r3-git-handoff.md
4. docs/validation/2026-11-18-v2-stage14r3-human-readability-closeout.md

이번 요청으로 허용하는 개발은 계획의 S15-01 한 작업이다.
현재 branch, HEAD, 미커밋 상태, 해당 파일의 기존 구현 여부, 관련 정책 계약과 Node 24.x를 확인하라.
인계 기준 branch는 codex/mangohana-v2-sites-20261111, HEAD는 26c7d96c29577035f4bdd306b1451aac15a5b883이다.
진행에 영향을 주는 drift가 있으면 원인을 확인하고 범위에서 해결 가능한 부분만 진행하라.
Stage14-R3의 기술 종료와 실제 revision 14 PNG의 사용자 가독성 승인은 이미 기록됐다.
Stage14 전체의 남은 실제 런타임·품질 검증은 계획표에 따라 별도 증거로 남겨라.

기존 packages/ai-engine/quality/recovery-policy.cjs와 packages/contracts/src/v2-common-contract.mjs의 상태·출처 의미를 재사용하라.
새 기능의 변경 대상은 packages/ai-engine/quality/stage15-quality-decision.cjs와 tests/v2/stage15-quality-decision.test.mjs다.
assessStage({ binding, observed, findings, authority }) → Decision 순수 함수로 시작한다.
현재 권한, page/owner/revision/input digest, 검사 근거와 provider dispatch 확실성을 명시적 입력으로 사용하라.
이 함수는 실행 권한을 만들거나 provider·서버·파일 저장 호출을 수행하지 않는다.

합성 RED를 먼저 작성하고 실제 실패를 확인한 뒤 최소 구현으로 GREEN을 검증하라.

- 동일한 승인/출처와 양호한 측정 → PASS
- 사용자 검토가 필요한 의미 경고 → MANUAL_REVIEW
- 현재 binding과 stale revision·잘못된 owner/page가 맞지 않음 → BLOCKED
- provider로 보낸 뒤 timeout, 정산과 실제 완료 상태 미확정 → RESULT_UNKNOWN
- 같은 artifact의 검사 재확인 → REVALIDATE_STAGE, provider dispatch 0

Node 24에서 아래 집중 검사와 기존 정책 회귀를 실행하라.

node --test tests/v2/stage15-quality-decision.test.mjs
node --test tests/v2/quality-policy.test.mjs

작업 전의 dirty 변경을 보존하고 RED/GREEN 결과, 변경 파일, 남은 가정을 보고하라.
S15-01의 실제 호출을 운영 host, 기존 큐 또는 Stage14-R3 식자 컨트롤러에 연결하지 마라.
실제 PNG 생성·LaMa/OCR/Gemma/마스크 모델 실행·Permit 발급·외부/유료 호출·모델 설치·사용자 자료 수정·commit/push·배포는 범위 밖이다.
S15-02와 이후 슬라이스는 시작하지 마라.
```
