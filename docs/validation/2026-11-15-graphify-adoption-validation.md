# Graphify 도입 검증 — 2026-11-15

권고: **제한적 도입 — 알려진 심볼의 관계를 확인하는 수동 보조 도구로만 사용한다.** 기본 탐색은 기존 `rg`와 실제 소스 확인을 유지한다. Codex의 자동 Graphify 규칙·스킬·훅은 적용하지 않는다. 이 실험에서 전체 개발 속도나 토큰 절감은 입증되지 않았다.

설치, 실제 MangoHana 코드 분석, A/B/C 비교, 독립 프로세스 재사용과 합성 갱신 검증까지 실행했다. 제품 코드·의존성·기존 Codex 설정은 변경하지 않았다. 실제 새 Codex 채팅의 스킬 로딩, 앱 E2E와 번역·이미지 품질은 이번 검증 대상에서 실행하지 않았다.

## 1. 실제 환경과 격리

| 항목 | 확인 결과 |
|---|---|
| 실행 환경 | Windows 10.0.26300 네이티브 PowerShell. WSL 목록 조회는 실패했으므로 WSL2 사용 가능 여부는 미확인 |
| 프로젝트 | `C:/dev/Projects/mangohana` |
| Git | `codex/mangohana-v2-sites-20261111`, HEAD `26c7d96c29577035f4bdd306b1451aac15a5b883`. 기존 수정 및 미추적 V2 코드 존재 |
| 실험 worktree | `C:/dev/Codex/worktrees/graphify-validation-20261115/mangohana`, 동일 HEAD의 detached worktree |
| Python·uv 사전 상태 | PATH의 Python은 실행되지 않는 WindowsApps 별칭. uv는 PATH에 없음 |
| 설치 후 | uv 0.13.8, 격리 CPython 3.12.16, **graphifyy 0.9.108**, 의존성 포함 31개 패키지 |
| Codex | CLI `0.169.0-alpha.11.1`. 디스크의 전역 main은 Sol/max, 프로젝트 하위 기본값은 Luna/medium·최대 2개. 설정 계층의 신규 채팅 적용은 별도 미검증 |
| 기존 탐색·지침 | `rg` 우선, 루트/desktop AGENTS, `.codex/config.toml`과 네 역할 파일. 사용자 전역 스킬 디렉터리는 `.system`; 기존 Git 사용자 훅과 `core.hooksPath` 설정은 발견되지 않음. Git LFS 설정 보존 |
| source of truth | `docs/source-reference.json`의 OneDrive 원본 경로가 현재 없음. 현재 요청을 실험 명세로 하고 기존 로컬 V2 플랜에 이 작업만 추가 기록 |

worktree 도구는 미커밋 변경을 복사하지 않으므로 **현재 dirty·미추적 소스의 실제 bytes**를 선택해 SHA-256 manifest와 함께 복사했다. 처음에는 소스 630개를 분석했다. 이후 `@/...` 별칭 해석에 필요한 tsconfig/package 설정 10개를 추가한 **640개 입력 보완 실험**을 별도 출력에 수행했다. 초기 결과를 덮어쓰지 않았다.

입력은 `apps/`, `packages/`의 실제 코드다. `packages/ai-engine/vendor/trio/src`, `scripts/sites-local`과 실제 연결되는 `local-preview/renderer.ts`, `lama_http.py`는 제품 구현이므로 포함했다. node_modules·빌드·캐시·테스트/fixture·실험용 scripts·문서·이미지·`.ctp`·모델·`.env`·인증자료는 분석 입력에서 제외했다. 제외 파일 목록은 [source-exclusions.json](graphify-20261115/source-exclusions.json), 보완 설정은 [configuration-inputs.json](graphify-20261115/configuration-inputs.json)에 있다.

## 2. 공식 설치와 변경 비교

[공식 README](https://github.com/Graphify-Labs/graphify), [설치 문서](https://docs.graphify.com/installation), [CLI 문서](https://docs.graphify.com/open-source/configuration/cli), [공식 PyPI 배포](https://pypi.org/project/graphifyy/0.9.108/)를 직접 확인했다. 패키지 이름은 double-y인 `graphifyy`이며 명령은 `graphify`다. 문서의 기준 버전과 실제 배포 버전이 달라 실제 설치기의 파일 변경과 CLI 출력을 우선 검증했다.

다음 환경변수는 설치 프로세스에만 설정했다. 사용자 전역 PATH·uv·Python·Codex 설정을 수정하지 않았다.

```powershell
$taskRoot = 'C:/dev/Codex/worktrees/graphify-validation-20261115/mangohana'
$env:UV_TOOL_DIR = "$taskRoot/.tools/graphify/tools"
$env:UV_TOOL_BIN_DIR = "$taskRoot/.tools/graphify/bin"
$env:UV_CACHE_DIR = "$taskRoot/.tools/graphify/cache"
$env:UV_PYTHON_INSTALL_DIR = "$taskRoot/.tools/graphify/python"
uv tool install --no-config --python 3.12 --default-index https://pypi.org/simple --no-build graphifyy==0.9.108
graphify install --project --platform codex
```

실행은 다운로드한 공식 uv와 설치된 실행 파일의 **절대 경로**를 사용했다. uv ZIP은 공식 GitHub release digest와 SHA-256 일치를 확인했다. PyPI metadata의 공식 저장소 URL·배포 파일 SHA도 기록했다. 패키지 설치 exit 0, 11,855ms. 설치된 `graphify.exe --version` 출력도 `graphify 0.9.108`이었다. [배포 근거](graphify-20261115/official-distributions.json), [설치 로그](graphify-20261115/package-install.txt), [실행 파일 확인](graphify-20261115/console-version.json).

실제 설치기는 worktree에 아래 파일을 썼다.

| 파일 | 결과와 최종 처리 |
|---|---|
| `AGENTS.md` | 기존 내용 뒤에 모든 코드 질문에서 graph-first를 강제하고 수정 후 update를 요구하는 섹션 추가. 기존 `rg` 우선 지침 및 이번 통제 비교와 충돌하므로 제거. **원본 bytes와 동일하게 복원** |
| `.codex/skills/graphify/SKILL.md`, references와 버전 stamp | 이 버전의 실제 Codex 설치 위치. 일반 skill은 문서·매체 의미 추출과 자동 업그레이드 경로도 포함하므로 상시 등록하지 않음. 공식 제거기로 제거 |
| `.codex/hooks.json` | `graphify hook-check`를 실행하는 PreToolUse no-op 훅 추가. Git 훅은 아님. 공식 제거 후 남은 빈 JSON도 이번 실험 소유임을 확인하고 삭제 |
| `.tools/graphify/` | worktree 전용 Python·uv tool 환경·캐시·그래프 사본 유지. 전역 PATH 등록 없음 |

[AGENTS 전후 diff](graphify-20261115/registration-agents-diff.txt), [생성 파일 manifest](graphify-20261115/registration-created-files.json), [제거 영수증](graphify-20261115/registration-uninstall.json), [빈 훅 정리](graphify-20261115/registration-empty-hook-cleanup.json)를 보존했다. `graphify hook install`, watch, MCP 등록, global graph, cloud, 외부 AI provider는 활성화하지 않았다.

## 3. 실제 그래프 생성과 무결성

설치된 콘솔 진입점과 같은 `python -m graphify`를 사용했다. 실행 환경에서는 API 키 등 기존 환경변수를 상속하지 않고, 별도 USERPROFILE과 Python `sitecustomize` 감사 가드를 적용했다. 가드는 socket DNS/연결/바인드 등을 거부하고 AST 하위 Python 프로세스에도 상속된다. 별도 smoke test에서 실제 연결 시도를 차단했다. 분석·조회 중 이 가드가 관측한 네트워크 시도 기록은 없었다. OS 패킷 캡처나 임의 외부 실행 파일 전체의 통신 감시는 수행하지 않았다. 설치 시의 공개 배포 다운로드는 이 오프라인 분석과 구분한다.

```text
python -m graphify extract <worktree>/.graphify-source --code-only --max-workers 2 --out <worktree>/.tools/graphify/configured
python -m graphify cluster-only <worktree>/.tools/graphify/configured --no-label --no-viz
```

| 결과 | 초기 소스 전용 | 해석 설정 포함 보완본 |
|---|---:|---:|
| 입력 | 630개 소스 | 같은 소스 630 + 설정 10 |
| 노드 / 관계 | 9,384 / 29,184 | **9,751 / 30,356** |
| community | 289 | 277 |
| 생성 시간 | 44,577ms | 22,099ms |
| graph.json 크기 | 12,762,407 bytes¹ | 13,174,028 bytes¹ |
| 끊어진 edge endpoint | 0 | 0 |

¹ report 생성을 위해 cluster-only를 실행한 후의 파일 크기. 두 생성 시간은 OS 캐시 등의 조건이 달라 최적화 속도 향상률로 해석하지 않는다. schema_version은 1, graphify_version은 0.9.108이다. 모든 입력은 file node로 표시되지만 초기 12개 파일에는 심볼이 없다는 경고가 있었다. 파일 노드 존재는 모든 함수·관계의 완전 추출을 뜻하지 않는다. HTML은 외부 스크립트 로딩을 피하고 이번 비교에 필요하지 않아 생성하지 않았다. JSON과 Markdown 보고서를 검사했다.

최종 그래프: `C:/dev/Codex/worktrees/graphify-validation-20261115/mangohana/.tools/graphify/configured/graphify-out/graph.json`. [구조 검사](graphify-20261115/configured/graph-integrity.json), [보완 입력 manifest](graphify-20261115/configured/source-manifest.json), [생성 로그](graphify-20261115/configured/extract.json), [생성 보고서](graphify-20261115/configured/GRAPH_REPORT.md).

## 4. 테스트 A — 실제 기능 위치와 연결

다음은 그래프 후보를 **현재 소스와 직접 대조해서** 확인한 구조다. `V`는 `packages/ai-engine/vendor/trio`다. 제품 모델을 실행한 결과가 아니다.

| 기능 | 실제 구현 및 연결 근거 |
|---|---|
| 웹→엔진 | `apps/sites/lib/studio-engine.ts`와 `apps/sites/app/api/engine/[...path]/route.ts`의 제한된 proxy → `apps/engine/server.mjs`. `host.cjs:35–44`가 store·engine·server를 연결 |
| OCR | `V/scripts/sites-local/engine.cjs:69,76`가 컴파일된 production OCR service를 로드·생성. 대응 소스는 `V/src/main/productionOcrService.ts:103`. 실제 native/model 동작은 실행하지 않음 |
| 페이지 번역 | `engine.cjs:413,424`의 요청/응답 → `packages/ai-engine/quality/page-translation.cjs:15,40` → `translation-contract.cjs`의 batch 검증 |
| 이미지 복원 | `engine.cjs:518`의 Python stdio 실행 → `V/scripts/sites-local/lama-stdio.py:22,38` → `V/scripts/local-preview/lama_http.py`의 `LaMaBridge`. 동적 파일 로딩·별도 worker는 그래프의 정적 호출만으로 완결되지 않음 |
| 식자·마스크 | `engine.cjs:332,578`의 rendererCall prepare/render → `V/scripts/sites-local/renderer.ts` → `V/scripts/local-preview/renderer.ts`. 후자는 typesettingGeometry, imageBurnInRenderer, glyph/layout 검사를 import |
| 사용자 검토·저장 | Studio review dialog → `studio-translation-review.ts` → proxy → `server.mjs:124–135` → `translation-review-store.mjs` → `store.mjs:98`의 fsync+rename `atomicState`. 일반 작업실 저장은 별도 `studio-storage.ts` |

그래프의 넓은 질문은 기대한 핵심 파일 10개 중 7개를 반환했다. OCR의 desktop/현재 V2 동명 함수, LaMa bridge 두 경로를 놓쳤다. 정확한 node ID/파일 경로로 `explain`하면 초기 그래프에서도 이 파일들을 조회할 수 있었다. 따라서 **그래프에 존재함과 한 번의 자연어/심볼 질문으로 찾을 수 있음은 다르다**. 최종 보완본에서도 같은 넓은 질문의 7/10은 개선되지 않았다.

## 5. 테스트 B — 번역 파서 변경 영향

선정 함수: `packages/ai-engine/quality/page-translation.cjs:40`의 `parsePageTranslationResponse`.

```text
graphify explain parsePageTranslationResponse --all
graphify affected parsePageTranslationResponse --depth 2 --relation calls
```

실제 조회는 `engine.cjs:424`의 `executeJob` 호출, `engine.cjs:657`의 상위 `run`, 파서 내부 `page-translation.cjs:46`의 `parsePageTranslation`과 `:43`의 `invalid`를 반환했다. 소스와 일치했다. 이 함수가 응답을 거부하면 해당 페이지 번역 경로가 영향을 받으며, 반환 데이터는 이후 batch 검증으로 간다. 이는 수정 영향 후보이며 실제 모든 실행 경로의 영향 증명은 아니다.

그래프는 rg 결과의 파일 3개를 관련 production 파일 2개로 좁히고 호출 방향과 행 번호를 직접 보여 줬다. 이 기능이 가장 유용했다. scripts/tests는 초기 분석 범위 밖이므로 저장 응답 분석 도구와 테스트 호출자는 그래프에서 빠진다. 제품 함수 변경 전에는 `rg -n 'parsePageTranslationResponse' apps packages scripts tests`로 추가 확인해야 한다.

## 6. 테스트 C — 실제 사용자 행동 추적

대상은 작업실의 **‘선택 번역 13개 저장’ → 명시적 가져오기/적용 버튼**이다. 소스에서 확인한 경로는 다음과 같다.

1. `studio.tsx:432,478`가 review dialog를 연다.
2. `studio-translation-review-dialog.tsx:22–28`의 apply handler가 `makeReviewCommand`, `applyTranslationReview`를 호출한다.
3. `studio-translation-review.ts:15–16`이 `/api/engine/translation-reviews/stage14r3/apply`로 POST한다.
4. `app/api/engine/[...path]/route.ts:58,70,138`이 허용 경로·세션 정보를 검증하고 loopback 엔진으로 전달한다.
5. `server.mjs:124–135`가 owner/scope와 요청을 확인해 `reviewStore.apply`를 호출한다.
6. `translation-review-store.mjs:84,119`가 revision/승인 조건을 확인하고 `store.mjs:98`의 `atomicState`로 문서를 저장한다.

초기 그래프에서는 `@/...` 별칭 설정이 빠져 frontend 연결도 누락됐다. tsconfig/package 10개를 포함한 보완본은 dialog→applyTranslationReview 경로를 찾았다. 그래도 dialog→atomicState의 **directed path는 찾지 못했다**. HTTP 문자열, 의존성 주입, 동적 import와 실제 버튼 이벤트를 정적 그래프만으로 완전히 연결했다고 주장할 수 없다.

초기 그래프의 `--undirected` 결과는 `.preview → naturalSort → files.ts → node:crypto → store.mjs` 등을 거쳤다. 이는 **실제 저장 실행 경로로 사용하면 잘못된 결론**이다. mixed relation의 구조적 연관과 호출 흐름을 구분해야 한다. `INFERRED`, 높은 confidence, `EXTRACTED` 비율은 실행·정확성 보증이 아니다. 이 버전의 `path`는 경로를 못 찾아도 exit 0을 반환했으므로 로그 내용도 확인했다.

## 7. 비교 측정

아래는 **설정 포함 보완본**의 고정 검색 작업을 각 방식으로 3회 실행한 중앙값이다. 같은 630개 소스와 설정 10개, 동일 과제/기대 파일 집합을 사용했고 실행 순서를 교차했다. 기존 방식은 `rg -n -m 3` 한 명령, Graphify는 budget을 제한한 query/explain/affected/path 두 명령이다. 따라서 CLI 시작·Python·JSON 로딩 비용도 포함한 실제 선택한 조회 절차의 비교다.

| 과제 | rg 조회 | Graphify 조회 | 반환 후보 파일 rg / graph | 직접 읽은 기대 파일 rg / graph | 기대 파일 발견 rg / graph |
|---|---:|---:|---:|---:|---:|
| A 구조 | 37.1ms | 1,722.1ms | 18 / 22 | 10 / 7 | 10/10 / 7/10 |
| B 영향 | 39.2ms | 1,621.0ms | 3 / 2 | 2 / 2 | 2/2 / 2/2 |
| C 저장 흐름 | 39.7ms | 1,712.9ms | 8 / 11 | 6 / 6 | 6/7 / 6/7 |

출력량은 A 4,981/9,567 bytes, B 944/1,048 bytes, C 2,911/6,223 bytes(rg/graph)였다. **토큰은 측정 불가**이며 bytes를 토큰으로 환산하지 않았다. 비용과 전체 코딩 과제의 사고·탐색 완료 시간도 미측정이다. `--budget` 수치는 도구의 출력 한도이지 Codex 실사용 토큰 측정이 아니다.

발견률은 사전에 고정한 소규모 파일 집합의 회수율이다. 전체 프로젝트의 정확도·precision/recall로 일반화하지 않는다. 그 외 후보를 모두 오답으로 세지 않았다. 파일 수는 출력에 나타난 고유 소스 경로/직접 확인한 파일 수이며, rg가 내부적으로 스캔한 파일 수나 Python이 읽은 라이브러리 파일 수가 아니다. 명시한 행 주변만 읽어 두 방식의 소스 검증 절차를 같게 했다. 사람이 모르는 저장소를 처음 탐색하는 blind benchmark는 아니다.

C의 첫 검색 묶음에서 rg는 `store.mjs`, 그래프는 HTTP proxy를 놓쳤다. 둘 다 소스 후속 확인으로 위의 6단계 경로를 완성했다. 그 후속 추론까지 포함한 시간을 측정하지 않았으므로 이 표를 완성된 전체 흐름 탐색 속도라고 표현하지 않는다. [보완 측정 집계](graphify-20261115/configured/comparison-summary.json), [모든 명령·반복·누락](graphify-20261115/configured/comparisons.json), [사전 고정 과제](graphify-20261115/workloads.json). 초기 630개 실험 결과도 [초기 집계](graphify-20261115/comparison-summary.json)에 남겼다.

## 8. 세션 재사용과 오래된 그래프

| 질문 | 실행 결과 |
|---|---|
| 어디에 저장되는가? | 지정한 output의 `graphify-out/graph.json`, report, manifest/cache, `.graphify_root`, `.graphify_build.json`. 입력은 별도 `.graphify-source` 사본 |
| 프로세스 종료 후 남는가? | 생성 프로세스 종료 뒤 파일이 유지됐고 별도 Python 프로세스가 재조회 성공 |
| 새로운 세션에서도 가능한가? | 그래프를 소스 트리가 없는 별도 cwd에 복사해 독립 프로세스의 `explain` exit 0·해시 불변 확인. **새 Codex 채팅 자체는 만들지 않았으므로 자동 지침/스킬 발견은 미검증** |
| 코드 변경 후 갱신 | 별도 합성 Python 2파일에서 `normalize_ocr`를 `normalize_ocr_v2`로 변경. 갱신 전 old 조회 성공/new exit 4, `graphify update <fixture>` 후 old 심볼 제거·new 조회 성공 |
| stale 위험 | 저장 그래프만 조회하면 옛 함수가 정상 답처럼 나온다. 코드 수정만으로 자동 최신화되지 않음. watcher/Git 훅을 켜지 않았으므로 수동 갱신 필요 |
| 무변경 갱신 안정성 | 초기 그래프의 재추출은 630 unchanged·0 re-extracted였지만 9,384→9,379 노드, 29,184→29,177 관계로 변경. 사라진 5개는 외부 import stub(`node:fs`, `tsx` 등). 원인/안전성을 확정하지 않았고 보완본의 무변경 안정성은 미검증 |

무변경 재분석은 10,161ms였다. 변화 전·후 그래프와 delta를 모두 보존하고 비교용 초기 그래프를 SHA로 검증해 복원했다. 상시 자동 갱신을 도입하지 않은 이유 중 하나다. [독립 재사용](graphify-20261115/configured/independent-process-reuse.json), [합성 갱신](graphify-20261115/update-fixture.json), [무변경 delta](graphify-20261115/unchanged-refresh-delta.json), [원본 그래프 복원](graphify-20261115/baseline-graph-restored.json).

Graphify가 저장하는 것은 **소스 구조의 스냅샷**이다. Codex의 대화·사용자 승인·진행 이력·품질 판정·설계 결정을 기억하는 기능으로 취급하지 않는다. 새 작업은 기존 AGENTS와 현재 플랜을 먼저 읽고, 해당 코드 버전에 맞는 그래프인지 확인한 뒤 필요한 심볼만 조회한다. 프로젝트/단계의 사실은 기존 플랜·실제 소스·검증 문서가 우선한다.

## 9. 유지 범위와 간단한 사용법

유지: 격리 worktree의 고정 패키지·보완 그래프, 이 보고서와 증거, **명시적으로 실행하는 읽기 전용 도우미**. 자동 graph-first·Codex skill/훅·Git 훅·watch·provider 설정은 유지하지 않는다. worktree는 이 조회 도구의 runtime이므로 현재는 보존하며 commit/push는 하지 않았다.

```powershell
node C:/dev/Projects/mangohana/docs/validation/graphify-20261115/graphify-local.mjs status
node C:/dev/Projects/mangohana/docs/validation/graphify-20261115/graphify-local.mjs explain parsePageTranslationResponse
node C:/dev/Projects/mangohana/docs/validation/graphify-20261115/graphify-local.mjs affected parsePageTranslationResponse --depth 2 --relation calls
```

도우미는 640개 입력의 현재 SHA·추가/삭제 파일과 저장 그래프 SHA를 확인한다. 불일치하면 exit 2로 중단한다. 읽기 명령 네 종류만 허용하고 다른 graph 지정·설치·갱신을 거부한다. 경로 미발견은 원 CLI의 exit 0을 그대로 성공으로 쓰지 않고 exit 4로 표시한다. 변경/삭제/추가·금지 명령·실제 조회를 포함한 최종 검사 10개가 통과했다. [검사 영수증](graphify-20261115/local-guard-checks.json).

도우미는 **이번 검증 스냅샷용**이며 재구축 기능을 제공하지 않는다. 코드 변경 후에는 현재 소스와 tsconfig/package를 새 사본에 모으고, 새 출력 디렉터리에 `extract --code-only --max-workers 2 --out <new-output>`를 실행한다. 원본 manifest와 이전 그래프를 덮어쓰지 말고 실제 심볼/행을 확인한 뒤 새 manifest·그래프 SHA와 도우미의 명시적 참조를 함께 갱신한다. 단순히 기존 SHA만 다시 서명하지 않는다. 일반 `graphify update .`를 원본 프로젝트 루트에서 실행하면 이번 제한된 corpus와 출력 경로를 혼동할 수 있으므로 사용하지 않는다. 공식 갱신 사용법은 [incremental updates](https://docs.graphify.com/open-source/features/incremental-updates), 제외 규칙은 [ignoring files](https://docs.graphify.com/open-source/configuration/ignoring-files)를 참고한다.

최종 `.tools/graphify`의 파일 논리 크기 합계는 **395,988,793 bytes**였다. 설치본/캐시의 hardlink, 여러 그래프 사본과 합성 fixture를 포함하므로 실제 디스크 할당량은 미측정이다. [크기 기록](graphify-20261115/runtime-logical-size-final.json).

이 유지·갱신 수고와 Python 시작 비용을 고려하면 작은 수정·정확한 이름 검색·HTTP/동적 로딩 경로에서는 기존 탐색이 유리하다. 이미 만든 그래프에서 특정 함수의 이웃·역방향 호출을 확인하거나, 같은 버전의 구조를 새 프로세스에서 재사용할 때만 선택한다.

## 10. 보존, 제거와 검증 한계

기존 소스·설정·Git hook/config 등의 사전 manifest **1,253개에서 변경/삭제 0**, 추가 해석 설정 10개도 hash 일치(일부 중복). 원본 AGENTS·프로젝트 및 전역 Codex config를 유지했다. 기존 V2 플랜에는 이번 기록만 덧붙였으며 원래 bytes가 동일 prefix로 남는 것도 확인했다. 최종 그래프 SHA·원래 브랜치/HEAD·조회 신선도·등록 제거 상태가 일치했다. [최종 전달 검사](graphify-20261115/delivery-verification.json), [보존 검사](graphify-20261115/preservation-after.json), [해석 설정 보존](graphify-20261115/configuration-preservation.json). 새 audit JS만 대상으로 기존 ESLint 명령도 exit0이었다. [린트 영수증](graphify-20261115/lint-final.json). 미디어·원본 사용자 데이터 전체를 재해시한 검사는 아니며 이 작업의 입력/쓰기 대상에 넣지 않았다.

제거는 다음 순서로 한다. 이번 자동 등록은 이미 제거되어 다시 실행할 필요 없다.

1. 프로젝트 Codex 등록 제거가 필요한 경우 해당 **worktree cwd**에서 `graphify uninstall --project --platform codex`를 사용하고 AGENTS와 남은 hooks JSON을 원본과 비교한다. `--purge`나 사용자 전역 uninstall은 사용하지 않는다.
2. 위 `UV_TOOL_DIR`/`UV_TOOL_BIN_DIR`를 같은 worktree 경로로 지정한 프로세스에서 uv 절대 경로로 `uv tool uninstall graphifyy`를 실행하면 이 tool 환경만 제거한다. 수동 조회 도우미는 이후 사용할 수 없다.
3. 보고서/증거를 먼저 보존한 뒤 이 실험 소유 `.tools/graphify`, `.graphify-source`와 그래프 출력만 제거한다. 삭제 전 절대 경로가 `C:/dev/Codex/worktrees/graphify-validation-20261115/mangohana` 내부인지 확인하고 기존 checkout·사용자 `.codex`에 재귀 삭제를 적용하지 않는다. worktree 자체 정리는 Codex의 worktree 관리 기능으로 수행한다. 현재는 재사용을 위해 남겼다.
4. 원본 프로젝트에서 실험을 완전히 제거하려면 새 보고서/`docs/validation/graphify-20261115`와 이번 플랜 추가 부분만 제거한다. 기존 AGENTS·설정·제품 코드는 복원 작업이 필요 없다.

실패/보완도 숨기지 않았다. 최초 sandbox의 공개 배포 DNS 실패 뒤 승인된 다운로드를 사용했고, 관리 worktree 쓰기 제한은 해당 경로의 승인된 명령으로 처리했다. 해석 설정 누락은 별도 보완 분석으로 수정했다. 무변경 graph 변동은 보호 도우미의 최초 조회 검사를 실패시켰고 원본 graph를 복원해 재검증했다. 증거 집계 스크립트의 누락 import 오류 1회도 기록 후 수정했다. 이를 제품 결함이나 Graphify 설치 실패로 집계하지 않았다.

이번 결과는 선택한 구조/조회/보호 검사의 증거다. 모든 그래프 관계의 정답률, 모든 영향 범위, 실제 새 Codex 세션의 효율, 토큰/금액/주간 절약, 실제 앱 처리·번역/이미지 품질은 미검증이다. 이 작업은 Stage15·새 Goal·제품 모델 실험·commit/push·배포를 시작하지 않는다.

독립 검토는 test_verifier **Luna/low 요청 1회**, 하위 생성 합계1·재위임0·추가 검사0으로 완료했다. 지정 B/C 소스 연결과 보수적 권고에 중대한 과장은 발견하지 못했다. 방법론 고정 문구의 630/640 모호함 1건은 실행 원본을 보존한 뒤 설명만 수정했다. 미사용 import2개는 린트에서 발견해 제거했다. 질의·입력·측정 값은 바꾸지 않았다. [독립 검토와 반영](graphify-20261115/independent-review.md). 메인의 기존 Sol 설정을 유지했고 하위의 실제 runtime 모델/추론과 사용량/금액은 확인 불가·미측정이다. AI 증거 검토를 사람 검수로 표현하지 않는다.
