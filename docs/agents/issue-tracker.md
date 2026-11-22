# Issue tracker: 기존 프로젝트 진행 기록

현재 설정은 기존 로컬 진행 기록을 사용하는 최소 구성이다. GitHub remote는 https://github.com/ksaeil2001/mangohana.git 이지만 GitHub Issues를 현재 작업 원장으로 사용한다는 근거는 확인하지 않았다. 이번 설치에서 gh/계정 연결·이슈·티켓·레이블을 만들지 않는다.

- source of truth: 프로젝트의 docs/source-reference.json 및 그 문서가 가리키는 기존 Domain Story/spec/plan.
- OneDrive 참조가 없을 때: 원본 C:/dev/Projects/mangohana/docs/superpowers/plans/2026-11-11-mangohana-v2-sites-integration.md와 관련 docs/validation/을 현재 로컬 근거로 사용하고 부재를 표시한다. worktree에서 같은 파일이 없으면 원본 경로를 읽는다.
- 스킬이 publish/create issue/ticket을 요구해도 이번 구성만으로 외부 쓰기를 허용하지 않는다. 실제 요청의 범위가 허용한 문서를 기존 위치에 기록한다. 원격 이슈·티켓·레이블 생성은 별도 명시 요청이 있을 때만 수행한다.
- PRs as a request surface: no. triage/to-spec/to-tickets/implement/implement-spec/wayfinder는 자동 시작하지 않는다.
- GitHub tracker로 전환할 때는 실제 repository/접근/기존 레이블을 먼저 확인하고 사용자가 승인한 작업만 수행한다. 현재 GitHub tracker 동작 검증은 미실시다.
