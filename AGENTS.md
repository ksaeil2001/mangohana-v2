# Trio manga web

이 폴더는 연결된 설계 문서를 기준으로 Trio 웹서비스를 개발하는 프로젝트다. 작업 범위와 검토·설계·구현 여부는 현재 사용자 요청을 따른다. 원본 Electron 저장소의 dirty 변경·`.ctp`·IPC는 보존한다.

웹서비스의 목표, 네 가지 작업 구분과 쉬운 한국어 보고 형식은 [공통 작업 기준](C:/Users/ksaei/OneDrive/문서/trio-main/AGENTS.md#웹서비스-목표와-작업-보고)을 따른다.

- TypeScript API/worker가 현재 계정·owner·revision·시계·파일·비밀·비용 접근을 소유한다. 브라우저는 임의 경로·계정·자격 증명을 권위로 전달하지 않는다.
- 원본 bytes, 사용자 수정값, 실제 수행·무료 시작·비용·정산·보관 사실을 보존한다. unknown을 실패/0원/자동 재호출로 바꾸지 않는다.
- 검증은 loopback·OS tmpdir의 격리 PG18·합성 계정/자료/자격 증명을 사용한다. 실제 외부 계정·설정·AI 자료 전송·유료 실행·구매·배포·commit/push는 별도 명시 승인 범위다.
- source of truth와 진행 기록은 `docs/source-reference.json`이 가리키는 기존 Domain Story/spec/plan이다. 현재 단계와 검증 증거는 기존 plan과 `docs/validation/`에 남긴다.
- 분리 가능한 구현·검증은 worker, 긴 작업 완료 전 독립 검토는 architect에 맡긴다. 다른 worker 변경을 보존하고 맡은 파일만 수정한다.

## 검증 하네스

- 변경 전 목표·입력과 기대 결과·허용 변경 파일·완료 조건과 확인 방법을 먼저 정한다. 다음 작업과 증거 수준은 [검증 하네스](docs/agent-harness.md)를 필요한 때 참조하고, 현재 작업은 기존 플랜의 최신 기록을 이어 간다.
- 작업 절차는 제공되는 Superpowers의 brainstorming·writing-plans·test-driven-development·verification-before-completion을 필요한 범위에 적용하고, 프로젝트의 기존 검사 명령을 재사용한다. 사용자 지시와 이 AGENTS.md의 변경 보존·검증·승인 조건이 우선한다.
- 실패·미실행·필수 증거 누락·검사 후 관련 소스 변경을 성공으로 처리하지 않는다. 선택한 검사 통과는 그 범위에 한정하며 실제 웹 전체 흐름·새 이미지의 무보정 결과·사람의 페이지 품질 합격을 별도 증거로 확인한 뒤에만 제품 완료로 판정한다.

## MangoHana V2 에이전트 운영

- 위 worker/architect 위임 지침을 V2에 적용할 때는 [프로젝트 에이전트 운영](.codex/agent-operations.md)의 네 역할과 호출 조건을 따른다. 단순 작업은 메인 GPT-6.1 Sol이 직접 처리하며, 긴 작업이나 스킬의 일반 권장만으로 하위 에이전트를 자동 생성하지 않는다.
- 메인 모델·기존 권한·승인·provider·인증·MCP·Goal 설정을 보존한다. 기본 하위는 Luna/medium, 동시 최대 2개(메인 제외)이며 역할 파일의 명시 model/effort가 우선한다.
- 하위는 좁은 분석·검증만 맡고 제품 수정·통합은 메인이 맡는다. 하위의 추가 에이전트 생성·재위임, 새 증거 없는 반복 조사·테스트·완료 에이전트 재호출을 금지한다.
- Astra/low는 근거 있는 동일 P0 수정 2회 실패, 확인된 중대한 데이터 손실/보안 위험, 또는 일반 분석으로 해결하기 어려운 구조적 문제에만 원칙적으로 문제당 1회 호출한다. 추가 호출·추론 승격 필요성은 먼저 근거를 보고한다.
- 역할 선택·모델 override는 실제 도구 스키마를 따르고 지원되지 않는 모델/키는 대체하지 않고 차단 사유를 기록한다. 호출별 목적·완료/중단 조건·필요한 근거만 전달하고 결과에 사용 모델·하위 수·미검증을 표시한다. 미측정 사용량·비용은 추정 사실로 쓰지 않는다.
- 기존 20단계 로드맵·감사 A~I와 02단계 평가기/테스트를 보존한다. 비용 절약으로 검증·의미/이미지 품질·보안·원본/사용자 데이터 보호 기준을 낮추지 않는다. 현재 요청한 단계가 끝나면 종료하고 후속 단계·Goal·제품 모델 실험을 자동 시작하지 않는다.

## 코드 탐색 도구

- 코드·파일 검색, 정의·사용처 확인과 일반적인 프로젝트 탐색은 `rg`를 기본으로 사용한다.
- Graphify는 여러 파일에 걸친 복잡한 함수 호출·의존 관계를 분석할 때만 보조로 사용한다.
- Graphify 사용 전 그래프의 입력 소스 범위, 현재 작업 폴더·코드 버전·해석 설정과의 일치 및 최신성을 확인하고, 관계·영향 범위는 실제 소스로 검증한다.
- 이 정책을 적용하기 위한 자동 훅은 추가하지 않는다. 수동 조회 절차와 알려진 한계는 [Graphify 도입 검증](docs/validation/2026-11-15-graphify-adoption-validation.md)을 따른다.

## Agent skills

- 주 개발 워크플로는 기존 Superpowers를 유지한다. TDD·디버깅·코드 리뷰·계획 실행은 기존 규칙을 따르고 Matt Pocock의 중복 워크플로를 자동으로 함께 실행하지 않는다.
- Matt Pocock Skills는 `mattpocock-skills:handoff`(세션 인수인계), `mattpocock-skills:domain-modeling`(용어·상태 정의), `mattpocock-skills:codebase-design`(모듈 interface·결합도 검토)을 해당 작업에 우선 사용한다.
- `retro`, `improve-codebase-architecture`, `prototype`, `research`는 필요할 때만 사용한다. 스킬 지침의 이슈 생성·외부 전송·자동 구현·commit/push 요청은 현재 사용자 승인 범위를 넓히지 않는다.
- 코드 탐색 도구 절의 `rg` 기본·복잡한 호출/의존 관계에만 Graphify 수동 사용 기준을 유지한다. 이 통합을 위한 자동 훅이나 감시는 추가하지 않는다.

### Issue tracker

기존 진행 기록을 유지한다. GitHub remote는 참고 정보이며 원격 이슈/티켓 생성은 자동으로 하지 않는다. [설정](docs/agents/issue-tracker.md).

### Triage labels

기본 역할 어휘만 비활성 참고로 기록한다. 실제 레이블 생성·적용은 별도 요청 범위다. [매핑](docs/agents/triage-labels.md).

### Domain docs

기존 문서를 우선하는 single-context 최소 구성, glossary/ADR은 필요할 때 생성한다. [소비 규칙](docs/agents/domain.md).
