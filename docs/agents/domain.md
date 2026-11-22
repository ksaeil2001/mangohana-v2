# Domain docs

현재는 기존 번역 작업실 용어를 소비하는 single-context 최소 구성이다. apps/packages의 물리적 분리를 새로운 bounded context 설계로 확정하지 않는다. GLOSSARY-MAP.md 기반 재구조화는 이번 설치 범위에 포함하지 않는다.

## 읽을 근거

- 기존 AGENTS.md와 docs/source-reference.json, 현재 기존 플랜 및 해당 단계 validation을 우선한다. 원본의 현재 로컬 플랜은 C:/dev/Projects/mangohana/docs/superpowers/plans/2026-11-11-mangohana-v2-sites-integration.md다. OneDrive 원문이 없으면 확인 불가를 표시한다.
- GLOSSARY.md가 있으면 용어를 읽고, GLOSSARY-MAP.md가 있으면 관련 문맥만 따른다. docs/adr/가 있으면 관련 결정만 읽는다. 없으면 빈 문서를 미리 만들지 않는다.
- domain-modeling으로 용어가 실제 확정될 때만 GLOSSARY.md를 기록한다. ADR은 되돌리기 어렵고, 이유가 놀랍고, 실제 trade-off가 있는 결정에만 사용한다. 구현 세부사항을 glossary에 섞지 않는다.
- 제안 용어·설계안·AI 검토를 사용자 확정·실제 앱 승인·실행·저장 사실로 승격하지 않는다. 승인/저장/적용/실행과 unknown 상태를 구분한다.
- handoff는 OS 임시 폴더에 작성하고 기존 플랜/검증 근거를 경로로 참조한다. 인수인계 문서는 대화 기억이나 제품 완료 증명이 아니다.
- 이번 스킬 동작 시험의 용어/인터페이스 문서는 OS 임시 폴더에만 둔다. 제품 glossary·ADR·소스를 변경하지 않는다.
