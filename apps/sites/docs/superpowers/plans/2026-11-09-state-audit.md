# Trio State Audit Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement these tasks in this session. Checkboxes record completed work.

**Goal:** 암시적 상태 흐름을 전부 목록화하고, 기존 UX를 보존하면서 데이터 유실·비동기 경쟁·상태 오인을 막는다.

**Architecture:** 기존 저장 형식과 화면을 유지한다. 순수한 상태 전이/작업 토큰/저장 큐를 작은 모듈로 분리하고 React는 그 결과를 렌더링한다. 기존 엔진 API 계약과 Sites의 비공개 접근을 보존한다.

**Tech Stack:** React 19, TypeScript, Vinext, IndexedDB, node:test. 새 의존성 없음.

**Spec:** `docs/state-machines.md`와 현재 사용자 요청.

## Global Constraints

- 기존 프로젝트·이미지·번역문·스타일·성공 결과를 보존한다.
- 기존 저장 키와 v1 파일을 호환하며 읽기 실패 후 자동 저장하지 않는다.
- 실제 엔진 없이 샘플 검수만 수행하며 AI 처리 성공을 꾸미지 않는다.
- UI의 기본 배치, 접근 권한과 엔진의 응답 계약을 유지한다.

## Review Focus

- 복원 실패/알 수 없는 저장 버전: 기본값이 저장 레코드를 덮어쓰지 않아야 한다.
- 프로젝트 전환 뒤 늦은 응답: 다른 프로젝트·페이지의 선택/결과를 바꾸지 않아야 한다.
- 멈춤 직전 생성된 작업 ID: 보관하여 재업로드 없이 조회를 재개해야 한다.
- 처리 결과 수신 뒤 undo: 성공 결과나 작업 ID를 과거 스냅샷으로 되돌리지 않아야 한다.
- 내보내기 중 Esc/중복 클릭: 실제 dialog·React 상태·다운로드 요청이 일치해야 한다.

### Task 1: 상태 모델과 회귀 재현

- [x] 관련 코드·참조 그래프·기존 검사 확인, 상태 목록 기록.
- [x] `checks/state-regressions.test.mjs`에서 기존 결함을 실패로 재현한다.
- [x] `lib/studio-model.ts`, `lib/studio-engine.ts`에 ID·페이지 전이·중지/재개 조건을 구현하고 전체 검사 통과.

### Task 2: 문서 상태·작업·저장 경계

- [x] `lib/studio-state.ts`: 순수 workspace/history/activity/connection 전이와 읽기 전용 진단 selector. 프로젝트·페이지를 토큰으로 고정.
- [x] `lib/studio-persistence.ts` 및 React hook: 검증한 복원만 저장 허용, 직렬화·coalescing·flush·재시도.
- [x] 지연된 쓰기, 중복 시작, 잘못된 대상, 오래된 연결 응답, undo 경계에 대한 행위 검사 통과.

### Task 3: UI 연결

- [x] `components/studio.tsx`: 기존 버튼과 레이아웃을 새 전이/guard로 연결. 일관된 busy·aria·안정적인 데이터 ID를 제공.
- [x] 중지/재개·실패 요약·복구 경고·포인터 취소·모달 취소를 실제 경로로 검증.

### Task 4: 검증·기록·배포

- [x] 모든 node:test, TypeScript, 브라우저 회귀 경로와 빌드를 통과.
- [x] 독립 코드 검토 지적 중 재현되는 결함을 수정.
- [x] 전체 상태 목록에 결과와 남은 경계를 적고 같은 Sites 프로젝트에 배포.


## 실행 기록

- 기준: 기존 12개 검사 통과, 배포 v1 소스와 접근 권한 확인.
- 첫 회귀 재현: 내용 경고 은폐, 보류 작업 오표시, 백업 검증의 입력 변경, 누락/중복 페이지 ID, 선행 중지의 업로드, 생성 중지 시 ID 유실. 7개 RED → GREEN.
- 상태 경계: 15개 전이/큐 검사를 RED → GREEN으로 추가.
- 독립 검토: 긴 로컬 내용/기록·많은 영역 복원, 범위가 넓은 드래그 스냅샷, 두 탭 저장 충돌, 수동 페이지 이동 탈취, DOM 전용 초안, 이전 0영역 결과, 빈 프로젝트 백업, 연결 알림/오류 버튼/형식 선택 불일치를 확인하고 수정.
- Ruling: 단순 표시 enum은 유지하고 충돌하는 경계에만 전이 함수를 둔다. 대규모 상태 라이브러리 도입에 따른 회귀 범위를 피한다.
- Ruling: 두 탭의 서로 다른 편집은 조용히 합치거나 덮어쓰지 않는다. 후행 창의 편집을 보존하고 백업을 안내한다. 여러 창에서 편집한 경우 사용자가 프로젝트별로 백업 후 다시 불러와야 한다.
- Ruling: 실제 엔진/인증 제공자 내부와 OS 파일 저장 완료는 이 저장소로 검증할 수 없다. 엔진 계약 검사와 기존 비공개 접근을 보존하고 검증 범위를 명시한다.
