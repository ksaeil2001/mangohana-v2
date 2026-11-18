# Mangohana V2 로컬 실행

사용자가 제공한 `Trio_Codex_Source_v29.zip`의 v29 소스를 `apps/sites`에서 실행한다. hosted GPT Site에 연결하거나 게시하지 않는다. 사용자 화면은 Sites 하나이며, 기존 Electron 화면은 사용하지 않는다. 숨긴 Electron Canvas는 이미지 처리 엔진에만 사용한다.

PowerShell에서 실행한다.

```powershell
Set-Location 'C:\dev\Projects\mangohana'
.\scripts\v2\start.ps1
# 관리자가 별도로 검증한 프로필이 있을 때만 지정한다. 기본 설정은 덮어쓰지 않는다.
# .\scripts\v2\start.ps1 -ConfigPath 'E:\Dev\Outputs\MangohanaV2-20261111\검증된-프로필.json'
```

웹 주소는 `http://127.0.0.1:5173`이다. 같은 명령에서 loopback AI 작업 서버를 먼저 준비한다. 이미 실행 중인 프로세스와 충돌하면 해당 실행을 먼저 확인한다. 엔진은 동시에 한 페이지씩 처리한다. 자동 처리 결과는 미검수 후보이며 사용자가 검수 완료로 바꾸기 전에는 검수 완료가 아니다.

모델은 `E:\Dev\Models`, 다운로드는 `E:\Dev\Downloads\MangohanaV2`, 작업 원본·결과·검사 로그는 `E:\Dev\Outputs\MangohanaV2-20261111`에 저장한다. API 키나 유료 API는 필요하지 않다. 이 PC의 준비된 경로는 해당 출력 폴더의 `engine-config.json`에 있다.

```powershell
# 이미 설치한 모델과 런타임을 검증하고 엔진을 빌드한다.
.\scripts\v2\start.ps1 -Action prepare
# 구조·계약·실패 복구 검사(합성 AI 보고서 사용)
.\scripts\v2\start.ps1 -Action test
# Sites 배포용 빌드만 생성하며 게시하지 않는다.
.\scripts\v2\start.ps1 -Action build
```

처음 환경을 준비할 때 `resources` 작업은 고정 SHA256의 공개 모델·실행기를 E:에 받는다. 의존성 설치에서 Electron 바이너리 다운로드가 생략됐다면 `packages/ai-engine`에서 `node node_modules/electron/install.js`로 공식 실행 파일을 설치한다.

브라우저 조작과 별도로 실제 엔진과 Sites PNG 내보내기 소스를 검증할 수 있다.

```powershell
node scripts/v2/verify-one-page.mjs --input 'E:\Dev\Outputs\MangohanaV2-20261111\inputs-japanese\원고.png'
# 완료된 실행의 원본·보고서·결과 해시를 다시 확인하고 AI 재호출 없이 내보낸다.
node scripts/v2/verify-one-page.mjs --resume 'E:\Dev\Outputs\MangohanaV2-20261111\one-page-실행폴더'
```

각 실행은 새 폴더를 만들고 원본·OCR·진행 기록·번역·복원·식자·PNG와 보고서를 보존한다. 실패한 실행을 완료로 바꾸지 않는다. 소스 실행 검사에는 `browserFlowVerified: false`를 기록하며 브라우저 업로드·다운로드, 모바일 기기, 이어 읽기를 확인했다는 의미가 아니다.

새 이미지 입력은 서버와 같이 JPG·PNG·WebP/장당8MiB를 지원한다. GIF를 AI 처리 가능 파일로 받아들이지 않으며 ZIP 내부 이미지에도 같은 한도를 적용한다. 이전 프로젝트의 원본·편집·결과는 보존한다.

OCR/번역 서버 재사용은 아직 기본 false다. 명시적인 검증용 후보에서만 reuseOcrRuntime/reuseTranslationServer를 켠다. 같은 owner/작품에만 재사용하며 정리 여부가 불명확하면 새 작업을 차단한다. llamaLoadMode를 명시할 때는 none만 지원하고, --load-mode none --no-host로 Windows 전체 파일 prefetch의 메모리 압박을 피한다. 생략하면 기존 적재 방식이다. 이는 의미 품질 합격을 뜻하지 않는다.

현재 단계·실측 결과·미완료 P0는 `docs/superpowers/plans/2026-11-11-mangohana-v2-sites-integration.md` 및 `docs/validation/`에서 확인한다. 여러 장·작품 용어·읽기 위치·효과음 보존과 의미 품질은 각각 실제 증거를 확보해야 한다. 과거 백업의 검증 기록을 이번 실행 결과로 사용하지 않는다.
