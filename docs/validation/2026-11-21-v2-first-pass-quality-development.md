# MangoHana V2 첫 자동 이미지 품질 개발 검증

2026-11-21 KST에 작업 폴더의 `01292d9`를 기준으로 3번의 병합을 먼저 고친 뒤 1·2·4·5번을 제품 경로에 반영했다. 7번의 독립 평가 기준은 착수 때 준비했다. Windows에서 합성 글줄·이미지·계정과 고정 응답을 사용했다. 실제 OCR·Qwen·LaMa 호출과 독립 원고 처리는 각각 0건이다. [품질 계획과 판정표](../superpowers/plans/2026-11-20-mangohana-v2-text-coverage-and-translation-quality.md#2026-11-21-품질-구현-기록)

## 같은 입력에서 확인한 변화

| 계획 항목 | 수정 전 | 수정 후 |
| --- | --- | --- |
| 1. 누락·오독 계측 | 영역 단위의 기존 집계가 있었다. 글줄 ID와 역할을 근거로 누락·공백·오독을 따로 보고하지 않았다. | 정답 10줄에서 효과음 1줄을 없애면 검출 9/10, 무누락 쪽 0/1이다. 판독 1줄이 비면 검출 10/10, 비어 있지 않은 판독 9/10이다. 한 글자 오독·분할·합침·무문자 오탐도 별도로 집계했다. 정답이 없으면 미측정으로 남긴다. [평가 회귀](../../tests/v2/text-coverage.test.mjs) |
| 2. 판독 일부 보존 | 마지막 판독이 빈 6줄을 제출하면 OCR에서 보류됐고 전용 조회가 없었다. 혼합 쪽의 대사 결과를 적용할 때 작업실이 작업 번호를 지웠다. | 같은 보류에 원문 5줄·보류 1줄을 위치와 함께 조회하고 다시 열었다. 번역·복원·완성 PNG 0건이었다. 다른 계정, 원시 파일 변조, 중복 게시와 늦은 저장을 차단했다. 작업실 상태 회귀에서는 혼합 쪽을 저장·복원한 뒤 같은 번호로 별도 번역 주석을 조회하고 일반 편집 상태를 확인했다. [저장 회귀](../../tests/v2/text-inventory.test.mjs) · [작업실 회귀](../../apps/sites/checks/stage17-studio.test.mjs) |
| 3. 병합·작은 글줄 탐색 | 넓은 상자가 두 세로 글줄을 함께 포함하면 선택 결과가 1개였다. | 두 글줄은 각각 1개, 같은 줄을 재검출한 후보와 앞뒤 조각은 각각 총 1개다. 고해상도 탐색을 선택한 1,800×1,800 합성 쪽에서 4개 중 3개를 처리해 작은 줄 중복은 제거했고 잘린 후보를 제외했으며 미탐색 위치 1개를 보류로 남겼다. 실제 원고의 누락과 메모리를 계측하기 전에는 조각 탐색 기본값을 0으로 둔다. [Python OCR 회귀](../../tests/v2/test_local_review_coverage.py) |
| 4. 읽기 순서·보호 영역 | 명확한 두 세로 열의 대사가 우상→좌상→우하→좌하 순서로 섞였다. 대사와 겹친 별도 간판을 제거 대상으로 선택했다. | 우상→우하→좌상→좌하로 정렬하고 기존 ID와 좌표를 유지했다. 주석으로 처리할 간판을 보호 영역에 두고 대사 마스크에서 제외했다. [영역 선택 회귀](../../tests/v2/region-selection.test.mjs) · [마스크 회귀](../../tests/v2/stage10-mask-contract.test.mjs) |
| 5. 번역 문맥·복원·식자 | 합성 요청에 컷 순서와 확정 화자 정보가 글줄에 직접 연결되지 않았다. 한 말풍선이 복원되면 다른 말풍선에 변화가 없는 사례가 있었다. | 같은 원문과 ID에 검증된 컷 순서·화자·말투를 연결했다. 8,192 토큰 필수 입력 초과를 모델 적재 전에 기록하는 경우 모델 생성자 호출은 0회다. 그대로 남은 어두운 획을 말풍선별로 보류한다. 대사와 주석은 같은 한 번의 번역에서 받아 주석만 조회할 때 추가 생성이 없었다. 식자 전후의 픽셀 결과는 아래에 있다. [번역 계약 회귀](../../tests/v2/stage11-translation-contract.test.mjs) · [웹·CLI 회귀](../../tests/v2/web-product-path.test.mjs) |

## Electron 식자 전후

동일한 합성 원본과 고정 복원 이미지, 영역 ID, 글꼴을 사용했다. 두 빌드에서 확인한 글줄 ID는 `detected-17`이다. 이전 식자 동작의 비교 빌드는 가독 하한 후보 값만 기존 값으로 되돌렸다. 말풍선 높이는 25px이고 요청한 한국어는 ‘해’다.

| 검사 | 관측 결과 | 증거 |
| --- | --- | --- |
| 낮은 말풍선, 수정 전 | `MANUAL_LAYOUT_REQUIRED`, 후보 PNG 생성 없음 | [이전 동작 영수증](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-quality-20261121-a9bec6db88114bf48c3f2cbfb0bc20a6/verified-lineage-mosHwT/tests/web-canvas-97K9OS/receipt.json>) |
| 같은 말풍선, 수정 후 | 13px로 후보 PNG 생성. 렌더링 182픽셀, 잘림 0픽셀, 누락 글리프 0건 | [개선 동작 영수증](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-quality-20261121-a9bec6db88114bf48c3f2cbfb0bc20a6/verified-lineage-mosHwT/tests/web-canvas-kKKZXr/receipt.json>) |
| 보통 말풍선 | 마스크 4,858픽셀, 렌더링 2,618픽셀, 잘림 0픽셀, 누락 글리프 0건 | [보통 말풍선 영수증](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-quality-20261121-a9bec6db88114bf48c3f2cbfb0bc20a6/verified-lineage-mosHwT/tests/web-canvas-QCTGYp/receipt.json>) |
| 더 좁은 말풍선 | `MANUAL_LAYOUT_REQUIRED`, 후보 PNG 생성 없음 | [좁은 말풍선 영수증](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-quality-20261121-a9bec6db88114bf48c3f2cbfb0bc20a6/verified-lineage-mosHwT/tests/web-canvas-zPnoXW/receipt.json>) |

처음 Electron 호출은 종료 코드를 받았으나 영수증이 없었다. 종료를 추적하는 호출로 바꾸고 임시 컴파일 출력에서 설치 모듈 `pkijs`를 찾지 못한 문제를 해결했다. 후속 입력에서 글줄 ID가 빠지는 실패를 한 번 더 재현했다. 수정한 글줄 전달과 번역 요청 검증을 거친 최종 검사에서 네 영수증과 낮은 말풍선의 두 입력 지문 일치를 확인했다. 브라우저에서의 업로드와 다운로드는 아래 합성 검사에 기록했다. 실제 복원 모델과 사람의 품질 판정은 미실행이다. [렌더러 검사](../../tests/v2/fixtures/web-product-canvas.cjs)

## 회귀와 남은 검증

- Node 24의 집중 회귀 26개 파일은 510/510을 통과했다. 이후 저장 경계에 추가한 회귀를 포함해 부분 OCR 파일을 다시 검사했다. Sites 작업실·배치·프록시 4개 파일은 47/47, `tsc --noEmit`은 종료 코드 0이다. 합성 작업실 회귀는 새 참조가 없을 때 실패했고, 수정 후 저장·재열기·GET 조회와 기존 편집 보호를 통과했다. [집중 Node 로그](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-quality-20261121-4405aee6184d45c08ab85ee9390dca3a/quality-regressions.log>)
- 처음 전체 V2 실행은 1,566건 중 1,559건 통과와 실패 7건을 기록했다. 실패는 모두 Linux 0B의 `TRANSLATION_IDENTITY_INVALID`였다. 독립 실행용 초안과 공통 렌더러에 ONNX 글줄 ID가 빠졌다. 두 곳 모두 선택한 OCR의 ID를 넘긴 뒤 0B 19/19를 포함한 관련 Node 71/71과 AI 엔진 타입 검사가 통과했다. Electron은 같은 합성 입력으로 수정 전 `[]`를 반환했고, 수정 후 준비·번역 요청 검증·식자까지 ID를 유지했다. 첫 전체 실행 동안 관련 시험 파일 두 개에 재현 검사를 추가했다. 새 실제 0B 시험 전에 렌더러와 코드의 지문을 다시 고정해야 한다. [첫 전체 실행 영수증](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-regression-1795197002914-9b1a8b9d/verification.json>) · [0B 회귀](../../tests/v2/linux-0b.test.mjs) · [공통 렌더러 회귀](../../tests/v2/stage11-ocr-lineage.test.mjs)
- 최종 코드의 전체 V2 재실행은 Node 24.22.3에서 **1,567/1,567 통과**, 실패·건너뜀·취소 0건이었다. 실행기가 기록한 소스와 별도로 확인한 제품 파일 26개의 SHA-256이 실행 전후 일치했다. 시작 때 Windows 가용 RAM은 857 MiB였으며 이번 전체 회귀는 실제 모델 호출 없이 실행했다. [최종 전체 실행 영수증](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-regression-1795198299340-706c57d1/verification.json>) · [최종 전체 실행 로그](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-regression-1795198299340-706c57d1/tests.log>)
- Python 3.12의 로컬 검토 회귀는 31/31을 통과했다. Linux 런처를 Windows에서 실행한 검사에서는 15건 통과, 2건 건너뜀, 1건 오류였다. 해당 오류는 Linux의 `/proc/uptime`을 읽는 호스트 메모리 감독 경로에서 발생했다. 실행 중인 Ubuntu를 확인하지 못해 해당 런처 분기를 Linux에서 검증하지 못했다.
- **6번**은 현재 제품에서 실제 긴 원고가 한 요청의 필수 입력을 초과하거나 편집 후 관계없는 대사가 다시 생성된 증거를 확인할 때 시작한다. 이번에는 모의 입력 한계만 확인했다.
- **7번과 실제 품질은 미완료**다. 평가 사용권과 미노출을 확인한 원고, 원문 글줄·읽기 순서·작화 보호에 대한 사람 정답, 두 버전의 첫 자동 실행 승인과 실행 가능한 환경, 두 독립 검수자의 응답이 필요하다. 먼저 표본과 기준을 고정한다. 같은 원고의 기존판·개선판 첫 자동 이미지에서 글줄, 의미, 작화, 식자를 가려서 판정한다. 실제 무수정 합격률과 개선폭, 주요 오역·원화 훼손 변화, 수정 시간은 미측정이다. [독립 평가 표본 조건](2026-11-19-v2-stage16-actual-start-evidence.md) · [판정표](../superpowers/plans/2026-11-20-mangohana-v2-text-coverage-and-translation-quality.md#7번-독립-평가-자료와-판정표)

제품 적용과 합성 실행은 메인이 맡았다. GPT-6 Luna/low 하위 검증 1회는 부분 OCR·주석의 저장과 재개를 소스로 검토했다. 실행 증거를 확인해야 할 중복 게시와 늦은 쓰기 사례를 메인 회귀에 추가했다.

## 로컬 작업실의 합성 브라우저 검사

Windows의 Chrome 157.0.8103.79를 격리한 Playwright 프로필과 1440×860 뷰포트에서 열었다. 실제 Sites 경로와 작업 저장소를 루프백으로 연결했다. 합성 1픽셀 이미지 한 장을 업로드하고 현재 페이지를 처리했다. 브라우저 제목과 작업실 콘텐츠를 확인했고 콘솔 오류와 외부 접속 시도는 각각 0건이었다. 첫 시도에서 색상 문자가 섞인 서버 시작 로그를 준비 완료로 읽지 못했다. 후속 시도는 실제 페이지 목록과 처리 범위 메뉴를 찾아 같은 흐름을 완료했다.

- 원문 글줄을 열어 원문 위치 표시와 간판 번역 주석을 확인했다. 자동 저장 후 새로고침한 작업실에서 같은 페이지와 주석을 확인했다. 목록 조회 2회 모두 HTTP 200이고, 페이지 접수는 1회였다.
- 작업실에서 내려받은 PNG의 SHA-256은 서버가 반환한 첫 후보 PNG와 동일한 `0812b19e9a0bf6d389baa65e56d59a19364795e03e9ee31b5454faf228b74a6c`였다. 실제 모델 호출 0건이며 작업실에서의 모바일 배치 검토는 미실행이다. [검사 기록](<C:/Users/ksaei/AppData/Local/Temp/mangohana-v2-studio-LdYlAk/result.json>) · [검사 화면](<C:/Users/ksaei/AppData/Local/Temp/mangohana-v2-studio-LdYlAk/01-source-and-note.png>)

## 공식 원고 두 작품의 입력 준비

두 공식 배포 원본을 임시 폴더에 저장했다. 2026-11-21에 확인한 이용 조건에서 지정 파일의 번역과 개작을 허용한다. 원고의 장르와 페이지 분포를 근거로 후보를 골랐다. 아래 번호는 PDF에서 첫 장을 1로 세는 순서다. 글꼴과 읽기 방향, 컷 배치와 개발 노출 이력은 아직 확인 대기다.

| 작품과 판본 | 전체 및 후보 쪽 | 원본 이용 기록 |
| --- | --- | --- |
| 《ブラックジャックによろしく》, 佐藤秀峰 공식 일본어판 1권 | 총 209쪽. 24·64·112·160쪽 | 電書バト가 배포한 ZIP에서 지정 일본어판 PDF를 확인했다. 한국어 등 일본어 외 이용 시 약관이 지정한 영문 제목과 저자명을 표시한다. 공개한 경우 1개월 안에 보고하는 조건이 있다. [공식 원본 및 이용 조건](https://www.densho810.com/free/) |
| 《漫画で学ぶ 旅行とツーリストシップ》, 일반사단법인 투어리스트십 공식 일본어 PDF | 총 16쪽. 3·7·10·12쪽 | 공식 목차에서 여행의 시작, 지속 가능한 여행, 배려, 교류에 해당하는 후보를 골랐다. 약관은 번역·개작을 허용하고 공개한 경우 1개월 안에 보고하도록 한다. [공식 PDF](https://touristship.jp/wp/wp-content/uploads/2024/11/%E6%BC%AB%E7%94%BB%E3%81%A7%E5%AD%A6%E3%81%B6%E6%97%85%E8%A1%8C%E3%81%A8%E3%83%84%E3%83%BC%E3%83%AA%E3%82%B9%E3%83%88%E3%82%B7%E3%83%83%E3%83%97.pdf) · [이용 조건](https://touristship.jp/wp/wp-content/uploads/2024/11/%E5%88%A9%E7%94%A8%E8%A6%8F%E7%B4%84.pdf) |

Poppler 26.07.0에서 긴 변 1,800px의 PNG 8장을 만들고, 각 파일을 다시 열어 해상도·지문·중복 없음과 단색 빈 이미지가 아님을 확인했다. 작품별 첫 후보를 동일 조건으로 다시 변환한 두 장은 바이트가 일치했다. 변환 전후 원본 PDF 지문이 일치했고 결과 PNG는 1,315,348~2,694,308바이트였다. 후보 원장 SHA-256은 `285f6d45f7cf831909c28d2b427a68cfa892398d6044d679d43b925a8623622d`다. 원장의 `artworkAndTextTags`와 `humanGroundTruthSha256`은 `null`이며 첫 출력은 양쪽 모두 `NOT_RUN`이다. [후보 원장](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/paired-input-candidates.json>)

Stage05 원본 20장과 변형본 10개의 기록된 지문, 기존 번역 검수 원본 71장을 대조했다. 71장은 당시 실행표에 있는 원본 SHA-256과 현재 파일이 모두 일치했다. 로컬에서 기존 이미지 지문과 근접 중복 거리 기준 6을 적용했다. 새 후보 8장과 기존 71장의 568쌍에서 근접 중복 후보가 0건이었고, Stage05에서도 0건이었다. 최단 거리는 각각 8과 12였다. 작품·문맥과 미기록 개발 노출 이력은 미확인이다. [기존 71장 대조 영수증](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/prior-71-overlap-check.json>) · [Stage05 지문 대조 영수증](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/recorded-exposure-check.json>)

## 두 버전과 실행 준비

- 이전 소스 보관본 134개를 ZIP에서 다시 읽어 보관 시 지문과 대조했다. 현재 품질 변경 소스 26개를 바이트 그대로 보관하고 ZIP에서 다시 읽었다. 두 보관본에 모두 있는 경로는 14개다. 기준 커밋 `01292d9`와 이전 보관본의 소스 129개로 기존판을 구성하고, 개선판에는 품질 변경 26개를 적용했다. 두 사본의 공통 경로 671개와 변경 경로 26개를 검증했다. Node 24.22.1에서 `buildEngine()`을 각각 실행했고, 두 빌드의 산출물은 각각 70개였다. 두 렌더러는 사전에 기록한 각 지문과 일치했다. [기존 소스 목록](linux-0b-runs/preflight/20261120-plan-environment/baseline.json) · [두 소스 사본의 지문](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/paired-local-source-trees-signed.json>) · [두 엔진 빌드의 지문](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/paired-local-engine-builds-signed.json>)
- 03:56 KST에 Windows 가용 RAM 8,904 MiB를 관측했다. WSL 가동 목록에서 실행 중인 Ubuntu는 확인되지 않았다. Windows의 기존 ONNX 한 장 프로필에서는 OCR·번역·LaMa와 렌더러 파일 확인이 통과했다. 전용 Python 3.10.10에서 ONNX Runtime 1.23.2, NumPy 2.2.6, OpenCV 4.10.0을 불러왔고 CPU 제공자를 확인했다. 모델 세션 생성과 실제 출력 각각 0건이다. 공용 운영 작업자 진입점은 `RUNTIME_PIPELINE_UNIMPLEMENTED`다. [Windows 한 장 경로](2026-11-19-v2-web-product-engine-integration.md#6-추가-승인-후-실제-한-장-시험) · [운영 진입점](../../packages/operations/src/runtime-startup.ts)
- 두 버전에서 함께 쓸 수 있는 설치 자원 17개 파일을 읽어 지문을 기록했다. Python, Baberu·RT-DETR·PP-OCRv4, Qwen, LaMa, Pretendard를 포함한다. Qwen 6개 파일의 크기와 지문은 고정 revision `41a4dd4d147229f83043afb98a4d4c803b8bfcbb` 목록과 모두 일치했다. 이번 읽기에서 모델 세션은 0건이다. [공통 자원 지문](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/paired-runtime-resource-pins.json>)
- 첫 서버 실행에서 기존 OCR의 E 드라이브 전용 프로필 조건으로 준비 응답이 실패해 두 격리 프로필을 E 드라이브 시험 폴더에 만들었다. 이어 Pretendard 매니페스트와 이용허락 파일의 줄바꿈이 임시 사본을 만들 때 달라져 서명 검증에 실패했다. 저장소의 서명에 맞는 바이트로 두 임시 사본을 다시 빌드하고 검증을 재실행했다. 두 서버가 같은 ONNX 설정에서 `/health`에 HTTP 200과 `ready=true`를 반환했고 각 서버가 종료 코드 0으로 정상 종료했다. 상태 조회는 각 1회, 업로드·작업 제출·모델 세션은 각 0회였다. [두 서버의 시작·종료 영수증](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/paired-local-host-preflight.json>)
- 원고 노출 이력과 글꼴·컷 유형 분포를 확인하고 사람 정답을 봉인한다. 사용할 모델·설정과 해당 원고의 실행 범위를 확정한 뒤 실제 비교를 시작한다. 두 독립 검수자의 응답으로 첫 자동 출력 쌍을 판정한다. 현재 적격 독립 쪽은 0장, 실제 비교 실행은 0건이다. 대사 누락·읽기 순서·번역 의미·작화 보존·식자 가독성의 유형별 빈도와 무수정 합격률은 미측정이다. [유형별 판정 및 재검증 계획](../superpowers/plans/2026-11-20-mangohana-v2-text-coverage-and-translation-quality.md#두-작품의-첫-자동-출력-비교-준비)

## 기존 개발 71쪽의 보관 기록 대조

- 기존 실행표와 OCR·번역 영수증 71쌍의 페이지 ID, 원본 SHA-256, 요청 영수증과 영역 ID를 맞췄다. 작품04-012는 당시 별도로 보관한 보조 PP-OCRv4 영수증을 썼다. 도중에 첫 검사에서 보관본 71건이 모두 `OCR_INCOMPLETE`였다. 기존 보관본에 현 제품의 `uncoveredBubbles` 배열이 없음을 확인했다. 이전 데이터의 빈 말풍선 확인 상태는 미확인으로 남겼다.
- 저장된 판독문을 빠짐없이 쓰고 새 프로젝트와 같은 빈 작품 문맥으로 입력을 재구성했다. 제품의 요청 구성 코드와 로컬 Qwen 고정 토크나이저로 잰 입력은 385~852토큰이었다. 8,192토큰을 넘은 쪽은 0/71쪽이고 최대는 작품03-009의 852토큰이었다. 실제 이어진 제품 요청과 편집 이후 재번역의 관측은 0건이다. 이전 M2M100 기록에는 생성 한도 도달 49쪽·85영역이 있었다.
- 현재 한국어 출력 규칙으로 당시 M2M100 응답 554개를 검사했다. 응답 111개·54쪽에서 보류 신호를 확인했다. 반복 83개·46쪽, 한글 누락 50개·35쪽, 일본어 잔류 6개·3쪽, 원문 복사 1개·1쪽이었다. 한 응답에 여러 신호가 해당할 수 있다. 의미 정확도와 현재 모델의 실제 출력 품질은 측정하지 않았다. [입력 토큰·출력 규칙 대조 영수증](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/recorded-71-qwen-and-ko-output-audit.json>)
- 기존 OCR 글줄이 있는 같은 보관 PNG 71장의 SHA-256과 좌표 틀을 대조했다. 기존 위아래·오른쪽 정렬을 다시 적용한 결과는 보관 순서와 71쪽 모두 일치했다. 개선 규칙이 컷을 둘 이상으로 구분한 쪽은 3장이고, 순서 변화와 글줄 ID 추가·누락은 각각 0건이다. 사람 읽기 순서 정답 대조와 모델 호출은 각각 0건이다. [같은 이미지와 좌표의 순서 비교](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/recorded-71-reading-order-replay.json>)

## 독립 원고의 사람 검수 자료

후보 원고 8장과 엑셀을 ZIP으로 만들었다. 엑셀에는 원고, 글줄, 보호 영역의 세 탭이 있다. 원고 탭에서 개발 사용 이력·글 방향·주요 글꼴·컷 배치·작은 글과 후리가나·식자 대상 여부를 확인한다. 글줄과 보호 영역 탭에는 동일한 PNG의 픽셀 좌표와 사람이 읽은 일본어·핵심 의미·읽기 순서를 남긴다. 각 검수자는 자기 사본에 기록한다.

세 탭의 화면, 내보낸 파일 재열기, 선택 목록 12개, 상대 원본 링크 8개, ZIP 속 원고 지문 8개를 대조했다. Excel 앱에서 링크 클릭은 확인하지 않았다. 링크가 열리지 않으면 압축을 푼 폴더의 `pages`에서 원본을 열 수 있다. 검수표의 작성란은 비어 있고 개발 사용 이력은 미확인이다. 제출 0건, 봉인된 사람 정답 0건, 실제 첫 출력 쌍 0건이다. [원고 8장과 검수표 ZIP](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/MangoHana_독립_원고_검수자료.zip>)

## 보호 영역 옆 자동 식자 전후

실제 제품의 Electron Canvas로 같은 합성 원본·복원 바이트, 원문 글줄·보호 영역 ID, 번역, Pretendard를 사용했다. 배치가 넓어질 때 보호 영역을 마지막에 확인해, 원래 영역 안에 들어갈 수 있는 대사도 PNG가 보류되는 사례를 재현했다.

| 합성 입력 | 수정 전 | 최종 수정 후 |
| --- | --- | --- |
| 말풍선 옆의 보호할 간판에 글씨가 닿음 | 최종 픽셀 검사에서 보호 영역 충돌 997개. 후보 PNG 보류. | 원래 말풍선 안전 내부의 25px 후보. 보호 영역 변경, 충돌, 잘림, 누락 글리프 각각 0건. |
| 글씨와 떨어진 보호 영역 | 64px PNG 생성. | 64px PNG 생성. 전후 PNG 지문 동일. |
| 예상 글자 경계 안에 들어가지만 실제 잉크가 비어 있는 보호 영역 | 64px PNG 생성. | 64px PNG 생성. 전후 PNG 지문 동일. |

중간 수정본은 글자 경계의 사각형만 검사해 세 번째 경우에도 확대 배치를 취소했다. 예상 충돌 부분의 실제 잉크만 다시 그려 대조하도록 수정했다. 잉크가 보호 영역에 닿은 대사는 기존 검사에서 닫힌 것으로 확인한 흰 영역과 원래 말풍선의 교집합에서 다시 측정한다. 전체 대사가 안전하게 들어갈 때에만 이 후보를 선택하고 마지막 픽셀 검사를 거친다. 낮은 말풍선, 식자할 공간이 없는 말풍선, 일반 말풍선을 포함한 같은 Electron 회귀 6개를 통과했다. 모델과 새 평가 원고 사용은 0건이다. [수정 전 997픽셀](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/protected-typeset-red-render-WQ3Vky/protected-note.log>) · [중간 수정의 가독성 회귀](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/protected-typeset-clear-interim-O8FAru/protected-note-clear.log>) · [최종 Canvas 실행](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/protected-typeset-green-pixels-yTmbyt/run.json>) · [25px 출력 지문](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/protected-typeset-green-pixels-yTmbyt/tests/web-canvas-lPgC7c/receipt.json>)

제품 실행 소스의 품질 변경 경로는 앞서 정한 26개다. 그중 식자 파일 한 개의 최신 바이트를 새 개선판 사본에 반영했다. 새로 만든 산출물 70개와 이전 지문을 대조했으며 이전 개선판과 달라진 빌드 파일은 렌더러 한 개다. 같은 로컬 ONNX 설정으로 기준판과 최신 개선판을 차례로 시작해 준비 상태와 정상 종료를 확인했다. 업로드·작업 제출·모델 세션은 각 0회였다. [두 빌드의 최신 지문](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/paired-local-engine-builds-protected.json>) · [실행 준비 영수증](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/paired-local-host-preflight-protected.json>)

최종 식자 수정 뒤 렌더러 진입점의 TypeScript 검사와 전체 V2 회귀 **1,567/1,567**을 통과했다. 실패·건너뜀·취소·실제 모델 요청은 0건이었다. 전체 회귀가 기록한 입력 소스와 별도로 두 빌드의 산출물 140개, 작업 폴더의 품질 변경 소스 26개의 지문을 확인했다. [최신 전체 회귀 영수증](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-regression-1795204408673-07d81974/verification.json>)

## 두 버전의 로컬 작업실 비교

기준판과 최신 개선판의 Sites 소스를 각 사본의 지문과 대조했다. 같은 설치 라이브러리와 공통 미리보기 파일을 두 사본에 두고, 각 버전의 일반 로컬 진입점에서 별도의 루프백 포트로 실행했다. Windows Chrome 157의 데스크톱 1440×860, 개별 브라우저 저장소를 사용했다. 실제 작업실과 같은 페이지 접수·저장·조회 흐름에 합성 처리 응답을 연결했다.

| 검사 | 기준판 | 개선판 |
| --- | --- | --- |
| 같은 320×384 합성 원본 업로드와 완료 | 1쪽·1회 접수 | 1쪽·1회 접수 |
| 첫 PNG와 새로고침 후 다운로드 | 두 파일 모두 첫 서버 후보와 일치. 새 처리 0회. | 두 파일 모두 첫 서버 후보와 일치. 새 처리 0회. |
| 같은 합성 식자 보류 페이지 | `PARTIAL_TYPESETTING` 1쪽. 후보 PNG·현재 페이지 PNG 다운로드 0회. | `PARTIAL_TYPESETTING` 1쪽. 후보 PNG·현재 페이지 PNG 다운로드 0회. |
| 최종 콘솔 오류·외부 브라우저 요청·실제 모델 호출 | 각각 0건 | 각각 0건 |

첫 완료 입력 지문은 두 버전에서 `cb310442fe3f91a970b96741f0099add787438dcdf2466525ba2af18e224d168`였다. 첫 후보와 두 차례 다운로드의 지문은 모두 `a836186ec192e5664b89d87f3e036a99adec30ac05a7d199808c0e381f01af91`로 일치했다. 브라우저를 닫고 테스트용 프런트엔드와 작업 서버의 포트가 모두 닫힌 것을 확인했다. 처음에는 차가운 사본의 의존성 검색이 대기 제한에 도달했다. 다음에는 미리보기 파일이 빠진 상태에서 화면 준비 전에 파일 입력을 시도했다. 대기 시간을 늘리고 공통 미리보기를 복사한 뒤 실제 페이지 추가 버튼으로 두 판을 다시 확인했다. 모바일과 실제 OCR·번역·복원은 이번 검사에서 미실행이다. [두 작업실 실행 기록](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/paired-workbench-fyFN9I/paired-workbench-result.json>) · [기준판 화면](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/paired-workbench-fyFN9I/baseline/01-first-image.png>) · [개선판 화면](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/paired-workbench-fyFN9I/improved/01-first-image.png>)

## 첫 자동 이미지의 사람 판정 집계

- 동일한 20쪽을 고정한 합성 회귀에서 기존판 합격 12/20, 개선판 합격 14/20, 차이 +10%p였다. 두 판 모두 보류·실패·미실행을 예정 분모에 포함했다. 같은 쪽의 판정 변화와 작품별 결과를 계산했고 불일치·판단 불가·무응답을 원래 답변과 함께 보존했다. 글줄·읽기 순서, 번역 의미, 원문 제거·작화, 한국어 식자 네 항목을 전부 통과한 첫 PNG가 무수정 합격이다. [회귀](../../tests/v2/first-image-paired-report.test.mjs)
- 첫 실행 기록·원본·PNG와 답변의 지문을 대조한다. 초기 검사에서 집계 입력에 덧붙인 필드가 합성 출처 표시를 덮어쓸 수 있었다. 고정 지문 두 개만 결과에 넣고 검사한 첫 기록과 답변을 복사해, 뒤에 입력을 바꿔도 집계 내용이 유지되는지 다시 확인했다. 평가자 본인 확인과 실제 사용권·자료 검증은 운영자가 기존 절차에서 수행한다. [집계 구현](../../packages/evaluation/first-image-paired-report.mjs) · [실제 개시 조건](2026-11-19-v2-stage16-actual-start-evidence.md)
- 위 두 작업실의 합성 기록 4건을 다시 읽었다. 원본 4개와 후보 PNG 2개의 지문이 저장 기록에 맞았으며 보류 2건에는 후보 PNG가 없었다. 각 판에서 완료 1쪽·보류 1쪽, 예정 분모 2쪽, 합격률과 전후 차이는 `null`이었다. 사람 답변과 모델 호출은 0건이다. 재검증 기록의 SHA-256은 `a410986c5b2e4dbaafe5ad0f8f55d059c99a9b3a99a5f49ce4253fda76a1e292`다. [재검증에 사용한 작업실 영수증](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/paired-workbench-fyFN9I/paired-workbench-result.json>)
- Node 24.22.3에서 첫 이미지 7건, 글줄 집계 6건과 Stage16 관련 검사를 합쳐 **186/186**이었다. 실패·취소·건너뜀은 0건이다. 앞서 전체 회귀를 실행한 품질 변경 제품 파일 26개의 지문을 다시 대조했다. 후보 8쪽 중 독립성과 사람 정답이 확정된 쪽은 0장이다. 실제 품질 합격률, 결함 빈도, 수정 시간은 미측정이며 7번은 미완료다. [후보와 사전 검수표](#독립-원고의-사람-검수-자료)

## 균일한 회색 말풍선의 자동 식자

일반 작업이 렌더러에 배경 검사 입력을 넘기지 않아 합성 회색 말풍선이 `MANUAL_LAYOUT_REQUIRED`로 보류되었다. 같은 제품 접수 회귀는 `backgroundContext` 누락에서 실패했고, 수정 후에는 원본·마스크의 바이트와 세 지문이 작업 파일과 일치했다. 렌더러는 흰색이 아닌 원문 중심을 만났을 때만 정규화 원본·마스크·복원 화면을 추가로 읽어 기존 균일도와 대비 검사를 적용한다. [제품 접수 회귀](../../tests/v2/web-product-path.test.mjs) · [배경 검증 구현](../../packages/ai-engine/vendor/trio/scripts/local-preview/renderer.ts)

| 동일 합성 입력 | 수정 전 | 수정 후 |
| --- | --- | --- |
| 76×339픽셀 회색 말풍선, `아싸~!` | 보류 1건, 후보 PNG 0장 | 23px 후보 생성. 대비 10.1282, 그린 픽셀 969개. 잘림, 누락 글리프, 식자 영역 밖 변경 각각 0건. |
| 회색 배경에 진한 선이 섞인 원고 | 새 대조 입력 | `BACKGROUND_NOT_UNIFORM`으로 보류. |
| 테두리 없이 페이지에 이어진 흰 영역 | 새 대조 입력 | 안전한 닫힌 내부를 확인할 수 없어 보류. |

회색 말풍선의 수정 전후 원본·복원·마스크 지문을 각각 대조했다. 회색 배경과 열린 흰 영역을 포함해 Electron 9개 사례를 확인했다. 일반 흰 말풍선과 보호 대상 위치를 바꾼 사례의 자동 출력도 확인했다. [수정 전 영수증](<C:/Users/ksaei/AppData/Local/Temp/mangohana-gray-canvas-BZh82C/tests/web-canvas-QNBgva/receipt.json>) · [수정 후 영수증](<C:/Users/ksaei/AppData/Local/Temp/mangohana-gray-canvas-BZh82C/tests/web-canvas-s6QTfQ/receipt.json>) · [Electron 9개 실행 기록](<C:/Users/ksaei/AppData/Local/Temp/mangohana-gray-canvas-P7Lvpr/run.json>)

보관된 실제 Stage14-R3의 정규화 원본·마스크·복원 PNG 3개를 지문과 대조했다. 수동 배치를 승인받은 12번의 원래 영역 중심은 RGB 215·216·214이고, 복원 영역 내부의 채널별 명암 범위는 117·119·119였다. 허용 범위 8을 넘어 같은 자동 배경 검사에서 `BACKGROUND_NOT_UNIFORM`으로 보류됐다. 사람이 승인한 30px 배치의 실제 글자 폭도 83픽셀로 원래 글줄 검사 영역 77픽셀보다 넓다. 이 가독 크기를 재현하려면 글줄 밖의 안전 공간까지 확인해야 한다. 이번 대조의 모델 요청과 새 PNG 생성은 0회였다. [이전 사람 승인](2026-11-18-v2-stage14r3-human-readability-closeout.md) · [실제 글자 경계](stage14r3-revision14-final-20261118/evidence/region-diagnostics.json) · [보관본 대조 기록](<C:/Users/ksaei/AppData/Local/Temp/mangohana-gray-recorded-20VbZd/read-only.json>)

같은 보관본에서 사람이 승인한 13개 영역의 실제 글자 크기를 두 판의 자동 흰 배경 탐색과 비교했다. 8개 영역의 승인 글자 폭이 원래 OCR 상자보다 넓었다. 두 판 모두 12개에서 닫힌 흰 영역을 확인했고, 그중 9개에서 자동으로 고른 상자가 승인 글자 경계를 담을 수 있는 폭·높이였다. 4·5·6번은 닫힌 내부가 있어도 폭이 부족했다. 12번은 비흰색 배경 검사에 걸렸다. 이 수치는 기존 한 쪽의 가로·세로 치수 대조이며 자동 출력의 가독성 판정은 미실행이다. [두 판의 영역별 치수](<C:/Users/ksaei/AppData/Local/Temp/mangohana-gray-approved-size-7gcCfK/comparison.json>)

일반 작업 연결과 렌더러 소스 두 파일을 반영해 개선판을 새로 만들었다. 기존판과 개선판의 빌드 파일 각 70개를 대조했고 이전 개선판과 달라진 빌드 산출물은 렌더러였다. 최신 개선판의 루프백 준비 응답과 정상 종료를 확인했다. 작업 제출과 모델 세션은 각각 0건이다. [새 소스 지문](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-image-gray-pins-b2GxUr/paired-local-source-trees-gray.json>) · [두 빌드 지문](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-image-gray-pins-b2GxUr/paired-local-engine-builds-gray.json>) · [개선판 준비 확인](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-image-gray-pins-b2GxUr/paired-local-host-preflight-gray.json>)

전체 V2 검사 첫 실행의 연결이 도중에 끊겼다. 같은 실행의 로그는 Stage15 중간에서 끝났고 종료 영수증과 해당 프로세스가 없었다. 출력과 종료 영수증을 보존하는 별도 프로세스에서 다시 실행해 Node 24.22.3으로 **1,575/1,575**를 통과했다. 실패·취소·건너뜀과 실제 모델 요청은 0건이었다. 실행 전후 검사 소스와 최신 개선판의 제품 변경 파일 26개의 지문을 대조했다. [첫 실행 중간 로그](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-regression-1795229227198-82066f66/tests.log>) · [재실행 영수증](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-regression-1795230006159-c881b532/verification.json>)

## 같은 말풍선의 독립 대사 식자

보관된 실제 쪽의 4·5·6번은 동일한 닫힌 흰 공간이었고 자동 배치는 각 원문 상자 안의 폭만 사용했다. 두 원문이 가로나 세로 한 축에서 떨어지면 사이의 중앙에 여백을 두고, 같은 흰 내부에서 원문 중심을 포함하는 더 넓은 사각형을 찾는다. 다른 원문·보호 영역이 겹치거나 방향이 모호하거나 사용자가 지정한 범위가 있으면 기존 배치를 적용한다. 일반 작업의 첫 자동 후보에 연결했고, 실제 그린 글자와 외곽선이 배정 영역을 벗어나면 보류한다. [공유 원문 분석](<C:/Users/ksaei/AppData/Local/Temp/mangohana-shared-spot-MxUxmM/diagnostic.json>) · [자동 식자 코드](../../packages/ai-engine/vendor/trio/scripts/local-preview/renderer.ts)

| 같은 합성 입력 | 수정 전 | 최종 수정 후 |
| --- | --- | --- |
| 좁은 글줄의 긴 대사와 옆의 짧은 답변 | 긴 대사 보류. 짧은 답변 측정 35px. | 두 대사 모두 후보에 식자. 긴 대사 16px, 짧은 답변 35px와 기존 위치. |
| 두 줄로 나뉜 대사 | 15px 두 줄. | 같은 15px 한 줄. |
| 보호 영역이 후보 폭을 가로막거나 흰 영역이 탐색 경계에 닿는 경우 | 보류. | 보류. |

전후의 정규화 원본·마스크·복원 이미지 지문과 대사 ID·문자열을 대조했다. 중간 수정은 이미 맞던 짧은 답변을 35px에서 61px로 키웠다. 들어가던 대사의 크기를 고정하고 같은 크기에서 줄 수가 줄 때만 후보를 바꾸도록 고쳤다. 최종 합성 PNG의 식자 영역 밖 변경, 글자 충돌, 잘림, 누락 글리프는 0건이었다. 처음 넓은 합성 입력에서 탐색 경계로 보류된 증거도 대조 사례로 보존했다. [중간 크기 회귀](<C:/Users/ksaei/AppData/Local/Temp/background-native-R9W42J/result.json>) · [최종 Electron 기록](<C:/Users/ksaei/AppData/Local/Temp/background-native-9tCwJM/result.json>)

같은 보관 원고의 복원 PNG와 OCR 지문을 대조하고, 원래 자동 후보와 넓어진 후보에서 저장된 승인 문장을 제품 Pretendard로 측정했다. 4·5·6번의 후보 폭은 각각 **52→60, 103→118, 104→131픽셀**이었다. 5·6번의 넓은 후보는 이전 승인 글자 치수를 담을 크기였다. 자동 선택 조건과 동일하게 다시 측정했을 때 4번은 17px 세 줄, 5번은 25px 세 줄을 유지했고, 6번은 20px 네 줄에서 세 줄로 줄었다. 자동 새 원고 실행, 모델 호출, 실제 원고 PNG 재생성은 각각 0건이었다. [보관 원고의 후보 치수](<C:/Users/ksaei/AppData/Local/Temp/mangohana-shared-width-replay-FRY9TP/same-page.json>) · [보관 번역의 실제 글꼴 측정](<C:/Users/ksaei/AppData/Local/Temp/mangohana-real-font-fit-XMPQQO/width-measurement.json>)

Node 24.22.3의 식자·배경·검수 배치·제품 접수 관련 검사 22파일 **172/172**를 통과했다. 실행 전후 관련 소스 지문은 일치했고 렌더러 타입 검사도 통과했다. 이번 두 파일을 반영한 개선판을 다시 빌드해 기준판과 개선판의 빌드 각 70개와 현재 품질 변경 소스 26개를 대조했다. 개선판 로컬 서버의 준비 응답과 정상 종료를 확인했고, 작업 제출과 모델 세션은 각각 0회였다. [관련 검사 영수증](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-shared-typography-10760f647c824577a11e5163cfc31730/verification.json>) · [두 소스 사본 지문](<C:/Users/ksaei/AppData/Local/Temp/mangohana-shared-width-pair-attx61/paired-local-source-trees-shared.json>) · [두 빌드 지문](<C:/Users/ksaei/AppData/Local/Temp/mangohana-shared-width-pair-attx61/paired-local-engine-builds-shared.json>) · [개선판 준비 확인](<C:/Users/ksaei/AppData/Local/Temp/mangohana-shared-width-pair-attx61/paired-local-host-preflight-shared.json>)

## 사용자 확정 원문 표기의 번역·식자 연결

공통 한국어 출력 검사는 사용자가 원문 표기로 확정한 이름을 허용한다. ONNX 제품 경로는 공통 검사에 도달하기 전에 `JAPANESE_REMAINS`와 `NO_HANGUL`로 승인된 이름까지 보류했다. 첫 수정에서 번역을 통과한 뒤 이미지와 주석을 저장할 때 같은 경고로 차단되는 것도 재현했다. 이제 세 단계 모두 해당 원문 글줄과 작업에 묶인 확정 어휘를 대조한다. 정확히 일치한 확정 표기를 제외한 나머지 문장이 공통 검사를 통과해야 한다. 원래 경고를 응답 파일에 보존하며, 의미 변화 경고는 계속 보류한다. [최초 번역 차단](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-original-name-red-bff17a5fd01a456dbe427c57a2e0da5d/tests.log>) · [저장 단계 재현](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-original-name-publication-red-e86b8401f81c4ed6b3d3e5b6222e20f6/tests.log>) · [제품 검사](../../tests/v2/web-product-path.test.mjs)

| 동일한 합성 입력 | 저장 단계 수정 전 | 저장 단계 수정 후 |
| --- | --- | --- |
| 확정 이름이 들어간 `アリス의 설명`, 이름만 있는 `アリス` | 두 이미지 모두 `PARTIAL` | 두 작업 모두 `CANDIDATE_READY`. 조회한 이미지 결과의 대사와 보고서의 확정 어휘 ID가 일치했다. |
| 이름만 있는 주석 `アリス` | 주석 저장 실패 | 주석을 조회했다. 원문 제거 마스크·복원 이미지·후보 PNG 생성은 0건이었다. |
| 이미지 대사와 확정 이름이 들어간 주석 한 줄 | 주석 저장 실패 | 한 합성 생성으로 주석을 조회했고 PNG 결과에는 말풍선 대사만 포함됐다. |
| 미확정 이름, 확정 이름 주변까지 복사한 일본어 문장, 요청을 약속으로 바꾼 응답, 혼합 페이지의 미확정 주석 | 네 건 모두 보류 | 네 건 모두 보류. 공개 후보 PNG와 번역 주석은 없었다. |

Node 24.22.3에서 제품 접수·문맥·저장·재개 등 관련 **178/178**을 통과했다. 실행 전후 검사 대상 소스 지문은 같았다. Python 3.12.14의 실제 경고 함수에서 합성 번역 4종의 경고가 시험 응답과 일치했고, 문맥 회귀 7건도 통과했다. 별도로 제품 Electron 렌더러와 설치 글꼴을 사용한 합성 캔버스에서 `アリス의 설명`은 54px, `アリス`는 64px였다. 두 결과의 누락 글리프와 잘림은 각각 0건이었다. 실제 모델 호출, 새 원고 출력, 사람 판정은 각 0건이다. [관련 검사 영수증](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-original-name-publication-2690b3db260a43d6a7adca8eac5dd454/verification.json>) · [이름을 포함한 대사 캔버스](<C:/Users/ksaei/AppData/Local/Temp/mangohana-confirmed-names-rjhPb7/tests/web-canvas-xXCXw6/receipt.json>) · [이름 단독 캔버스](<C:/Users/ksaei/AppData/Local/Temp/mangohana-confirmed-names-rjhPb7/tests/web-canvas-sSv0hp/receipt.json>)

이전 개선판에서 실행 소스 5개가 바뀌었다. 새 임시 사본을 빌드할 때 작업 폴더가 달라 렌더러의 소스 경로 주석이 바뀐 것을 확인했다. 이전과 같은 사본 내부에서 다시 빌드한 결과, 개선판의 렌더러를 포함한 산출물 70개가 이전 개선판과 바이트 단위로 일치했다. 기준판의 소스와 산출물 70개도 기존 지문과 일치했다. 최신 개선판 로컬 서버의 준비 응답과 정상 종료를 확인했다. 제출과 모델 세션은 각 0회였다. [두 소스 지문](<C:/Users/ksaei/AppData/Local/Temp/mangohana-confirmed-name-pair-ye89gN/paired-local-source-trees-names.json>) · [두 빌드 지문](<C:/Users/ksaei/AppData/Local/Temp/mangohana-confirmed-name-pair-ye89gN/paired-local-engine-builds-names.json>) · [최신 준비 확인](<C:/Users/ksaei/AppData/Local/Temp/mangohana-confirmed-name-pair-ye89gN/paired-local-host-preflight-names.json>)

## 독립 첫 PNG 판정표와 결함 집계

기존 Stage16의 익명 판정은 번역 의미와 자연스러움의 상대 비교를 받는다. 첫 PNG 평가용 집계에 같은 쪽의 익명 이미지 배정과 유형별 결함 수집을 연결했다. 새 판정표는 원본과 첫 PNG를 열고, 글줄·읽기 순서, 번역 의미, 원문 제거·작화, 식자 가독성에 각각 답한다. 결함 위치와 중대도도 기록한다. 같은 유형이 한 쪽에서 여러 번 발견되거나 두 평가자가 함께 지적하면 쪽 수는 한 번 센다. 평가자별 보고와 위치는 기록에 남으며, 완료된 PNG에서 결함 상세 미측정 쪽 수도 별도로 확인할 수 있다. [익명 배정과 파일 대조](../../packages/evaluation/first-image-blind-review.mjs) · [첫 PNG 집계](../../packages/evaluation/first-image-paired-report.mjs)

로컬 검수 도구는 JSON을 표준 입력으로 받는다. `prepare`에 봉인된 `cohort`, `firstRuns`, 지문 `pins`, 사전 등록한 `seed`를 넣어 운영자용 배정 기록을 만든다. `packet`에 그 기록과 `reviewerId`, 원본·결과의 SHA-256 이름 PNG가 있는 `assetsRoot`, 새 `outputDirectory`를 주면 각 평가자용 `index.html`과 익명 PNG를 만든다. 운영자는 평가자용 폴더를 전달하고 버전 대응표는 따로 보관한다. `collect`는 같은 `cohort`, `firstRuns`, `seal`, 배정 지문까지 포함한 `pins`와 내려받은 응답 `returns`를 받아 집계를 출력한다. 실제 사용권·미노출·원고 정답·평가자 독립성과 첫 실행 영수증의 출처는 운영자가 기존 증거에 대조해 확인한다. [검수 도구](../../scripts/v2/first-image-review.mjs)

처음에는 기존 첫 이미지 집계가 결함 필드를 거부했고 배정·패키지 명령이 없었다. 새 도구로 같은 합성 입력을 다시 실행했다. 한 판이 보류된 쪽은 다른 판만 판정할 수 있었고, 보류와 미실행은 두 판의 분모에 남았다. 수정 전에는 상속된 평가자 필드가 검사를 통과했다. 실제 반환 필드가 있는지 검사해 거부하도록 고쳤다. 다른 평가자의 이미지 참조, 바뀐 배정·실행 원장, 바뀐 PNG는 거부됐고 중복 응답은 집계되지 않았다. [회귀](../../tests/v2/first-image-blind-review.test.mjs) · [파일과 명령 회귀](../../tests/v2/first-image-review-cli.test.mjs)

합성 원고 세 쪽을 로컬 Chrome 157에서 열었다. 1280×900의 일반 폭에서 원본과 결과 A·B에 같은 560px를 적용했다. 390×844의 모바일 화면에서도 두 결과의 표시 폭이 같고 가로 넘침은 없었다. 최초 브라우저 검사는 결함 선택란의 라벨을 정확히 찾지 못했다. 라벨을 각 입력에 분리해 연결하고 같은 검사로 쪽 이동 뒤 값 보존, 응답 저장, 집계까지 확인했다. 한 평가자의 부분 응답만 받았을 때 합격률은 미측정으로 남고 읽기 순서 지적은 한 쪽에 기록됐다. 외부 요청과 스크립트 오류는 각각 0건이었다. [합성 판정표 예시](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-image-review-browser-Z86l4s/synthetic-review-example/index.html>) · [브라우저 영수증](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-image-review-browser-Z86l4s/verification.json>)

최종 소스로 Node 24.22.3의 첫 이미지·자료·Stage16 관련 회귀 **287/287**을 통과했다. 현재 후보는 두 작품 8장, 확인된 독립 원고와 정답표는 0장이다. 실제 모델·사람 판정 각 0건이다. 새 원고 무수정 합격률과 유형별 실제 빈도는 미측정이다. 이번 확인은 메인에서 진행했고 하위 에이전트 호출은 0회였다. [회귀 영수증](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-image-review-suite-fa4c3e6174234bfc817d41e6c8158a2b/verification.json>)

## 명암이 섞인 말풍선의 중심 식자

제품 자동 식자에서는 전체 OCR 상자가 명암 차이로 보류될 때만 중심부를 다시 탐색한다. 중심에 가까운 색이 원래 상자의 과반을 차지하고, 중심을 포함한 사각형이 원래 상자 안에 있어야 한다. 실제 원본·마스크·복원·여백과 기존 균일도·대비를 다시 대조한 뒤 글꼴·글자·외곽선을 검사한다. 높은 원래 상자에서 계산한 글자 크기부터 후보에 대입하고, 들어가는 크기는 새 사각형의 글자 치수와 픽셀 검사로 결정한다. [렌더러](../../packages/ai-engine/vendor/trio/scripts/local-preview/renderer.ts) · [크기·사각형 검사](../../packages/ai-engine/vendor/trio/src/renderer/candidateTypesettingFit.ts)

| 같은 합성 원고 | 이전판 또는 중간 수정 | 최종 결과 |
| --- | --- | --- |
| OCR 상자 아래에 어두운 띠가 있는 말풍선 | 기존판은 `BACKGROUND_NOT_UNIFORM`으로 후보 0장 | 일반 제품 `prepare`·`render`에서 24px 후보. 원본·마스크·복원 지문과 글줄 ID가 전후 일치했고, 후보 영역 밖 픽셀 변경과 잘림·누락 글리프는 0건. |
| 띠 사이에 높이 36px의 중심 후보가 있는 짧은 대사 | 중심 후보만 적용한 중간 수정은 13px 한 줄 | 글자와 외곽선을 다시 확인해 31px 한 줄. 후보 영역 밖 픽셀 변경과 누락 글리프 0건. |
| 반복 질감, 중심을 가로지르는 선, 보호 영역 중첩, 좁은 영역에 너무 긴 문장 | 보류 | 보류. |
| 전체가 균일한 회색 말풍선 | 23px 후보 | 23px와 후보 PNG 바이트 일치. |

첫 합성 회귀에서 어두운 띠가 있는 말풍선의 보류를 확인했다. 중심 영역을 적용한 뒤 낮은 후보의 13px 축소를 다시 재현했고, 원래 상자에서 계산한 크기를 기준에 넣어 같은 입력을 재실행했다. [최초 보류](<C:/Users/ksaei/AppData/Local/Temp/background-native-29S695/result.json>) · [낮은 후보 중간 측정](<C:/Users/ksaei/AppData/Local/Temp/background-native-tG2hpD/result.json>) · [최종 Electron 대조](<C:/Users/ksaei/AppData/Local/Temp/background-native-xjvZFQ/result.json>) · [제품 렌더러의 동일 입력 전후](<C:/Users/ksaei/AppData/Local/Temp/mangohana-gray-inset-product-UQe7w8/paired-product.json>)

보관 개발 원고 12번에서 원본·마스크·복원과 OCR 지문을 대조했다. 77×339픽셀의 기존 검사 영역은 보류됐고, 수정한 계산은 중심을 포함한 76×47픽셀의 배치를 찾았다. 바깥 반올림까지 포함한 검사 범위는 77×47픽셀이며, 여백과 함께 확인한 원본·복원의 색 채널 차는 각각 7단계, 최소 대비는 14.1474였다. 기존 승인 문구를 설치된 제품 글꼴로 쟀다. 중간 수정은 16px 한 줄, 최종은 23px 한 줄과 글자·외곽선 폭 64px, 높이 24px가 들어갔다. 예전 사람 승인 배치는 30px였다. 실제 원고 PNG 재생성, 모델 호출과 새 사람 판정은 각 0건이다. [같은 보관 픽셀 전후](<C:/Users/ksaei/AppData/Local/Temp/mangohana-gray-inset-replay-5GoW9q/pixel-proof.json>) · [중간 크기](<C:/Users/ksaei/AppData/Local/Temp/mangohana-gray-inset-font-jb4QHf/font-proof.json>) · [최종 제품 글꼴 측정](<C:/Users/ksaei/AppData/Local/Temp/mangohana-gray-inset-font-cOyzCp/font-proof.json>)

최종 소스로 Node 24.22.3의 식자·배경·제품 접수·로컬 실행 관련 27파일 **223/223**과 렌더러 TypeScript 검사를 통과했다. 두 비교용 소스 사본을 다시 대조하고 개선판을 빌드했다. 두 판의 빌드 산출물은 각 70개다. 기존 개선판 대비 새 산출물 지문은 `renderer.js`에서 바뀌었다. 최신 개선판은 격리한 루프백에서 준비 응답과 정상 종료를 확인했고, 제출과 모델 세션은 0회였다. 독립 평가는 두 작품 후보 8장 중 적격 확인 0장, 반환된 판독표와 실제 첫 PNG 비교 0건이다. 이번 작업은 메인 Codex에서 수행했고 하위 호출은 0회였다. [회귀 영수증](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-gray-center-inset-e216af0d0fd249408d373ad5e99f976e/verification.json>) · [비교용 소스 지문](<C:/Users/ksaei/AppData/Local/Temp/mangohana-gray-inset-pair-L6DtYV/paired-local-source-trees-inset.json>) · [빌드 지문](<C:/Users/ksaei/AppData/Local/Temp/mangohana-gray-inset-pair-L6DtYV/paired-local-engine-builds-inset.json>) · [준비 확인](<C:/Users/ksaei/AppData/Local/Temp/mangohana-gray-inset-pair-L6DtYV/paired-local-host-preflight-inset.json>)

## 제품 배치의 첫 PNG와 검수 원장

제품의 배치 조회는 재시도 연결을 따라 최신 작업의 결과를 보여준다. 첫 PNG 평가에는 격리 저장소에 남은 원래 접수의 작업 ID를 사용한다. `first-image-review.mjs capture`는 봉인된 `cohort`와 그 지문, 두 판의 격리된 `storeRoot`와 원래 배치 ID·배치 지문·작품 ID, 새 `outputDirectory`를 표준 입력 JSON으로 받는다. 원래 작업의 소유권·페이지·원본 지문을 대조하고 완료한 경우 보고서·저장 영수증·PNG를 확인한다. 검출된 이후 시도, 다른 배치의 재사용 결과, 변조된 파일, 수동 보정 결과는 첫 이미지로 접수하지 않는다. [수집 도구](../../scripts/v2/first-image-capture.mjs) · [검수 명령](../../scripts/v2/first-image-review.mjs)

`first-runs.json`에서 최초 보류와 실패를 확인하고 보고서에 들어가는 이미지 지문을 `assets`의 PNG와 대조할 수 있다. 운영자가 확인한 명시적 미실행은 `notRun`에 담는다. 작업이 이미 접수됐으면 해당 쪽의 미실행 선언은 충돌로 거부한다. 미확정 결과는 원본 상태와 사유를 관측 기록에 보존하고 판정은 미측정으로 남긴다. 중간 상태에서 정리 미확정이 실패로 잘못 분류된 사례를 재현했고, 저장된 정리 상태를 확인하도록 수정한 뒤 같은 테스트를 통과했다.

격리한 제품 루프백에서 같은 합성 쪽의 첫 작업을 보류한 뒤 명시적으로 재시도해 완료시켰다. 일반 배치 조회에서는 재시도 작업이 `CANDIDATE_READY`이고, 수집한 최초 작업은 원래 ID의 `held`에 PNG 없음이었다. 별도로 한 번에 완료한 다른 판의 PNG만 검수 폴더에 들어갔다. 평가 폴더를 내보내는 동안 새 합성 단계 호출도 0회였다. [제품 경로 회귀](../../tests/v2/web-product-path.test.mjs) · [원본·후보·정리 상태 회귀](../../tests/v2/first-image-capture.test.mjs)

앞서 고정한 기존판과 최신 개선판의 `host`, `server`, `store`, `result` 소스와 렌더러 지문을 대조했다. 두 로컬 서버에 같은 합성 원고 두 쪽을 배치로 넣고 정상 종료했다. 각 저장소에서 먼저 접수된 작업 ID와 PNG 지문을 수집했고 두 판 각각 완료 한 쪽·보류 한 쪽이었다. 같은 완료 쪽의 첫 이미지 두 장을 기존 `prepare`와 `packet`으로 익명 판정표에 묶었다. 합성 응답과 같은 후보 PNG를 재사용한 흐름 확인으로 실제 모델·독립 원고·사람 판정은 각각 0건이다. [두 제품 사본의 배치·수집 영수증](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-capture-two-builds-Rc7Aqh/verification.json>) · [합성 결과의 익명 판정표](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-capture-two-builds-Rc7Aqh/blind-review/index.html>)

최종 소스로 첫 PNG 수집·제품 배치·평가 관련 17파일의 Node 24.22.3 회귀 **349/349**를 통과했다. 소스 지문은 실행 전후 일치했다. 이번 작업은 메인 Codex에서 수행했고 하위 호출은 0회였다. 현재 후보 두 작품 8쪽에서 개발 미노출과 독립 판독표가 확인된 쪽은 0쪽이다. 두 판의 실제 실행 승인과 첫 PNG에 대한 검수 결과도 대기 중이다. 6번은 현재 제품의 실제 요청 한도 초과나 불필요한 재번역 근거가 확인될 때 착수한다. [최종 회귀 영수증](<E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-first-png-capture-d9e007532de84dfeb2234f862546f3d6/verification.json>) · [독립 원고 후보와 사전 판독표](<C:/Users/ksaei/AppData/Local/Temp/mangohana-first-images-b5knzz35.n4w/MangoHana_독립_원고_검수자료.zip>)


## 보관 실제 원고 한 페이지의 자동 식자 전후

같은 2039×2880 원고의 기존 OCR 13개, 승인 번역문, 원본·마스크·복원 픽셀과 Pretendard 글꼴을 고정했다. 기준판 01292d9와 이 문서에서 고정한 최신 개선판의 제품 렌더러를 로컬에서 실행했다. 원고와 검수 기록을 읽기 전용으로 사용했으며 제품 모델·외부 네트워크·새 사람 판정은 각 0회다. 실행과 대조는 메인 Codex가 맡았고 하위 호출은 0회다.

기준판의 전체 실행은 12번 회색 말풍선의 안전 영역 확인에서 보류돼 페이지 PNG가 없었다. 비교 화면의 기준판은 12번을 보호 영역으로 남기고 나머지 대사 12개를 다시 자동 식자한 진단용 PNG다. 이 12개의 크기·배치 사각형·획 픽셀 경계는 기준판의 전체 실행 진단과 일치했다. 개선판은 13개를 모두 자동 식자했다. 개선판의 진단용 12개와 전체 PNG의 차이도 12번 획 경계 안에 있었다.

| 대사 | 기준판의 진단용 PNG | 개선판의 전체 PNG |
| --- | --- | --- |
| 6번 | 20px, 네 줄. 글자 폭 95px, 높이 96px | 20px, 세 줄. ‘좀 더 봐줬으면’이 한 줄에 들어갔다. 글자 폭 116px, 높이 71px |
| 12번 | 보류로 공란 | ‘아싸~!’ 23px 한 줄. 77×47px 회색 영역에 배치 |
| 나머지 11개 | 크기·줄바꿈·배치 일치 | 두 영역의 획 경계를 벗어난 전후 변경 픽셀 0개 |

이 기록은 보관 개발 원고 1쪽의 식자 비교다. 독립 원고 무수정 합격률을 산출하려면 별도의 판독이 필요하다. [전후 이미지와 전체 측정표](C:/Users/ksaei/AppData/Local/Temp/mangohana-real-page-ab-6f42c30d/index.html) · [대조 기록](C:/Users/ksaei/AppData/Local/Temp/mangohana-real-page-ab-6f42c30d/comparison.json)



## 말풍선 여백을 활용한 자동 식자

같은 보관 원고에서 직전 개선판의 6번 20px와 12번 23px를 기준으로 삼았다. 원본·마스크·복원 이미지, OCR 좌표, 승인 번역문과 글꼴의 지문이 전후 일치했다. 제품의 식자 렌더러로 각각 2039×2880 PNG를 다시 만들었다. 대사 13개가 두 PNG에 모두 들어갔다. 모델·외부 네트워크·새 사람 판정은 0회이며 메인 Codex 단독으로 작업했다.

흰 공유 말풍선에서 줄을 다시 나눈 뒤에는 이웃 대사와의 안전 간격 안에서 더 큰 글꼴을 실측한다. 줄 수나 어절 갈라짐이 늘었거나 실제 획이 검증한 사각형을 벗어나면 이전 배치를 사용한다. 균일한 배경 띠는 세로 위치를 유지한 채 좌우를 확인한다. 원본·마스크·복원으로 배경과 여백을 다시 검사하고 보호 영역과 겹치면 기존 범위를 사용한다. 명시된 허용 범위와 사용자 크기를 보존한다. [제품 식자 렌더러](../../packages/ai-engine/vendor/trio/scripts/local-preview/renderer.ts#L307) · [실측 글꼴 검사](../../packages/ai-engine/vendor/trio/src/renderer/candidateTypesettingFit.ts#L122)

| 대사 | 전후 글자 크기와 줄 수 | 실제 픽셀 경계 |
| --- | --- | --- |
| 6번 | 20→22px, 기존 세 줄 | 가로 중심 268px 유지. 획 범위 116×71→128×78px |
| 12번 | 23→34px, 기존 한 줄 | 확인한 회색 영역 77×47→149×47px. 획 범위 63×24→92×36px |

나머지 11개는 식자 크기·글줄·배치가 일치했다. 6번과 12번의 획 경계 밖 변경 픽셀, 전체의 잘림·다른 영역과의 충돌·누락 글리프는 각각 0개다. [실제 원고 전후 이미지](C:/Users/ksaei/AppData/Local/Temp/mangohana-typeset-room-a7d4f201/index.html) · [픽셀·글꼴·입력 지문](C:/Users/ksaei/AppData/Local/Temp/mangohana-typeset-room-a7d4f201/comparison.json)

제품 변경 전 합성 회색 원고가 22px에 그대로 머물러 추가한 검사가 실패했고, 공유 말풍선의 대사도 기존 15px에서 멈췄다. 변경 후 회색 22→33px, 공유 대사 15→17px와 다섯 줄에서 세 줄을 확인했다. 회색 띠 옆에 보호 영역을 추가한 대조군은 22px를 유지했다. Electron 합성 검사와 AI 엔진 TypeScript 검사를 통과했다. [수정 전 재현](C:/Users/ksaei/AppData/Local/Temp/background-native-7YPHXn/result.json) · [수정 후 합성 이미지 검사](C:/Users/ksaei/AppData/Local/Temp/background-native-YK3Cny/result.json) · [회귀 소스](../../tests/v2/background-renderer-native.test.mjs#L101)


최종 소스에서 Node 24.22.3으로 기존 V2 회귀 1,596개를 모두 통과했다. 실패·건너뜀은 각 0건이다. AI 엔진 TypeScript 검사와 최종 제품 렌더러 두 판의 실제 원고 PNG 대조도 통과했다. [V2 전체 회귀 영수증](E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-regression-1795254648783-35849b94/verification.json)

## 좁은 말풍선과 짧은 마지막 어절

보관 원고의 원본·복원·마스크, 기존 OCR과 승인 번역 13개, 서명 글꼴을 고정했다. 변경 전 다시 그린 PNG의 SHA-256은 직전 결과와 같은 `3220cd958ddca60b3f5fe6708e560c01f58896e49296cf4ece4fe0cd20343cc2`였다. 독립 AI 식자 검토에서 4번의 작은 글씨와 갈라진 호칭, 13번의 한 줄 크기를 짚었다.

| 대사 | 수정 전 | 수정 후 |
| --- | --- | --- |
| 4번 | 17px, ‘히로 / 군의 / 설명은’ | 21px, 같은 세 줄. 이름과 호칭은 여전히 두 줄에 걸친다. |
| 5번 | 25px, ‘정말 / 이해하기 / 쉬워.’ | 32px, 같은 세 줄 |
| 8번 | 83px, ‘부탁해도 / 돼?’ | 65px, ‘부탁해도 돼?’ 한 줄 |
| 13번 | 26px, ‘다행이다~’ | 31px, 같은 중심의 한 줄 |

공유 말풍선에서는 세 줄을 유지하면서 글씨를 키운 합성 사례가 17→25px였다. 단독 타원에서는 실제 중앙 폭을 사용해 22→30px가 됐다. 보호 영역이 있는 대조군은 22px를 유지했다. 짧은 질문은 26px 두 줄에서 24px 한 줄로 바뀌었고, 번역문에 명시한 줄바꿈은 두 줄로 남았다. 새 사례는 각 변경 전에 기존 동작에서 실패했다. [합성 회귀](../../tests/v2/background-renderer-native.test.mjs) · [Electron 결과](C:/Users/ksaei/AppData/Local/Temp/background-native-62Km8X/result.json)

완성 원고의 40,858개 변경 픽셀은 네 대사의 전후 획 경계에 모두 들어갔다. 나머지 9개 대사의 글자·크기·배치가 일치했고, 잘림·안전 영역 이탈·충돌·누락 글리프는 모두 0건이었다. 원고는 개발에 사용한 페이지이며 새 번역이나 사람 판독은 이번 비교에 포함되지 않았다. [전후 확대 PNG](../../.runtime/lettering-7eee6f3a30/joined/before-after.png) · [전체 원고](../../.runtime/lettering-7eee6f3a30/joined/page.png) · [대사별 픽셀·입력 지문](../../.runtime/lettering-7eee6f3a30/joined/comparison.json)

## 반투명 말풍선 때문에 보류되던 두 번째 원고

다른 2039×2880 개발 원고에서 보관된 원본·복원·마스크·OCR·번역 6개와 같은 글꼴을 사용했다. 수정 전에는 5번의 작은 흰 공간과 12번의 불균일 배경 때문에 페이지 전체가 보류됐다. 수정 후에는 해당 대사의 지워진 원문 획이 분포한 범위에서 평탄한 복원 면과 대비를 다시 검사해 6개를 모두 배치했다. 5번은 17px 한 줄, 12번은 19px 세 줄이다. 기준판에는 완성 PNG가 없어 원본과 보관 복원본을 나란히 놓았다. [원본·복원·식자 확대 PNG](../../.runtime/lettering-7eee6f3a30/second/recovered/source-cleaned-final.png) · [전체 PNG](../../.runtime/lettering-7eee6f3a30/second/recovered/page.png) · [대사별 측정](../../.runtime/lettering-7eee6f3a30/second/recovered/comparison.json)

첫 독립 검사에서 마스크 알파를 버리고 RGB로 제거 여부를 판정해 원고 전체를 제거 영역으로 셌다. 이 검사의 마스크 포함률과 5·12번 원문 획 집계를 철회했다. RGBA로 다시 확인한 제거 영역은 114,125픽셀, 보존 영역은 5,758,195픽셀이다. 원본에서 복원본으로 바뀐 112,891픽셀은 모두 알파 0인 제거 영역 안에 있다. 5번과 12번의 실제 배치 상자 안에서 제거 대상으로 표시된 어두운 원문 픽셀은 각각 196개와 881개였고, 복원 후에는 각각 0개였다. 원고 전체 마스크 안에는 복원 뒤에도 어두운 픽셀 163개가 관측됐다. 이 수치만으로 글자 잔상 여부를 판정할 수 없다. [알파 및 보호 영역 8곳의 독립 재검사](../../.runtime/lettering-7eee6f3a30/second/verify-alpha-corrected/report.json)

복원본과 첫 식자판의 차이 25,128픽셀은 그 식자판의 여섯 대사 획 경계 안에 있었다. 호칭을 개선한 최종판과 복원본의 차이는 22,006픽셀이다. 이 중 177픽셀은 10번 대사의 이전 배치 상자 밖에 있었고, 최종판 자신의 배치 상자와 실제 획 범위 밖 변경은 각각 0픽셀이었다. 두 판 모두 보호 영역 여덟 곳의 변경은 0픽셀이다. 메모리 복사본에서 보존 위치와 식자 밖 위치를 각각 1픽셀 바꾼 두 검사는 모두 종료 코드 1을 냈다. [첫 식자판 경계](../../.runtime/lettering-7eee6f3a30/second/recovered/alpha-and-paint-bounds.json) · [최종판 경계와 앞 판에 따른 차이](../../.runtime/lettering-7eee6f3a30/second/center-band/alpha-and-paint-bounds.json) · [음성 대조 실행 코드](../../.runtime/lettering-7eee6f3a30/verify-page-bounds.cjs)

저장된 모델 번역으로 식자만 재현했다. 5번은 지쳐 죽을 것 같다는 대사가 신음으로 축약된 기존 중대 오역을 포함한다. 독립 AI 식자 검토에서는 5번의 작은 글씨와 12번의 낮은 배치, 11번에서 이름과 호칭이 갈라지는 점이 남았다. 두 원고 모두 이번 비교에서 사람의 품질 판정을 받지 않았다. [기존 번역·복원 관찰](2026-11-11-v2-one-page-validation.md)

이 배경 복원 변경 시점의 전체 V2 회귀는 Node 24.22.3에서 1,596개 통과, 실패·건너뜀 각 0개였다. 이후의 호칭 줄바꿈과 번역 검수 변경은 다음 비교에 해당한다. [이 시점의 전체 회귀 영수증](E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-regression-1795258343656-82abae62/verification.json)

## 이름과 호칭을 함께 놓은 줄바꿈

고정된 글꼴로 이름과 호칭 앞뒤의 줄바꿈 후보를 재측정했다. 명시적인 줄바꿈과 사용자 지정 배치를 보존하고, 실제 획이 기존 안전 영역에 들어오는 후보를 비교했다. 10번은 31px 세 줄에서 25px ‘우라라 선배, / 이거 음료수...’ 두 줄로, 11번은 43px 네 줄에서 34px ‘아... / 고마워 / 히로 군...’ 세 줄로 바뀌었다. 첫 원고 4번은 이 배치에서 21px 세 줄을 유지했다. [호칭 전후 확대](../../.runtime/lettering-7eee6f3a30/second/addressed/before-after.png)

두 번째 원고의 변경 22,289픽셀은 모두 해당 두 대사의 전후 획 경계 안에 있었다. 나머지 네 대사와 보호 영역 여덟 곳의 변경은 0픽셀이었다. 첫 원고의 결과 지문은 직전 식자판과 일치했다. [두 번째 원고 측정](../../.runtime/lettering-7eee6f3a30/second/addressed/wrap-comparison.json) · [첫 원고 측정](../../.runtime/lettering-7eee6f3a30/addressed/comparison.json)

## 일본어 서술이 숨소리만으로 번역된 대사

보관 개발 원고의 19개 대사는 기존 한국어 출력 형식 검사를 모두 통과했다. 새 의미 검사는 첫 원고 13개 중 0개, 두 번째 원고 6개 중 1개를 보류했다. 해당 5번에서 ‘ひ...ひんじゃう〜’의 번역이 ‘흐...흐윽...’이었다. ‘～ちゃう·～じゃう·～てしまう’ 계열의 말끝이 관측되고 후보 전체가 제한된 한국어 숨소리로 이루어진 경우에 원문과 후보를 보존하고 검수를 요청한다. 원문 자체가 숨소리이거나 서술이 살아 있는 후보는 대조군을 통과했다. 이 검사는 정확한 대체 번역을 결정하지 않는다. [보관 번역과 검수 근거](../../.runtime/lettering-7eee6f3a30/archive-predicate-review.json) · [두 실행기가 공유하는 대조 사례](../../tests/v2/fixtures/predicate-gasp.json)

합성 공급자가 경고 없이 돌려준 같은 유형의 문장은 수정 전 웹 배치에서 다운로드 후보가 됐다. 수정 후 원문·공급자 원본 응답·받은 대사 ID·보류 사유가 남고, 웹 작업실에는 숨소리만 남았을 수 있다는 검수 안내가 표시된다. 복원·식자 PNG·자동 재호출은 0건이었다. 명시적으로 문장을 검수한 경우에는 해당 위험을 수락한 기록을 확인한다. Node 번역 관련 58개, Python 로컬 검토 33개, 집중 HTTP 회귀 1개를 통과했다. 새 모델 추론 및 번역가의 정답 평가는 수행하지 않았다. [웹 경로 회귀](../../tests/v2/web-product-path.test.mjs) · [의미·사람 검수 계약](../../tests/v2/predicate-omission.test.mjs)

별도로 원본 OCR과 보관 M2M100 응답 지문이 일치한 기존 개발 원고 71쪽, 554개 대사를 재검사했다. 기존 한국어 출력 형식 보류는 111개였고, 이번 숨소리 규칙이 추가로 표시한 대사는 0개였다. 이 묶음에는 문장별 독립 정답이 없어 규칙의 일반적인 오탐률과 누락률은 미측정이다. [71쪽 보관 응답 검사](../../.runtime/lettering-7eee6f3a30/recorded-71-predicate.json)

## 호칭을 붙인 뒤 두 줄의 글자 크기 회복

독립 AI 판독에서는 11번의 이름·호칭 연결이 나아졌고, 10번은 25px로 작아진 것이 눈에 띈다고 했다. 닫힌 말풍선의 가운데에서 두 줄 전체가 들어갈 높이와 매 행의 가로 여백을 원본 해상도로 확인한 결과, 10번이 같은 두 줄로 25→29px가 됐다. 처음 31px에서 이름을 나눠 그리던 결과와 비교하면 두 줄을 붙여 읽는 데 든 축소는 2px다. 11번은 34px 세 줄을 유지했다. [최종 호칭 전후 확대](../../.runtime/lettering-7eee6f3a30/second/center-band/before-after.png) · [완성 원고](../../.runtime/lettering-7eee6f3a30/second/center-band/page.png)

보호 영역 여덟 곳의 변경은 0픽셀이다. 호칭을 나눴던 결과에서 바뀐 23,369픽셀은 모두 10·11번의 전후 획 범위에 있다. 합성 원고에서 세 줄 호칭은 25→27px가 됐고 새 여백 안에 그림 1픽셀을 지정했을 때는 25px를 유지했다. 같은 제품 빌드의 첫 원고는 직전 PNG와 바이트가 같았다. 로컬 제품 번들과 두 원고 재현 번들의 SHA-256은 `0793e17808e19c1a18d205a735bbb098c335d3496f44775766b864519d3534f4`로 일치했다. [최종 픽셀 대조](../../.runtime/lettering-7eee6f3a30/second/center-band/wrap-comparison.json) · [보호 대조군을 포함한 Electron 검사](C:/Users/ksaei/AppData/Local/Temp/background-native-kkOJPa/result.json)

이 시점의 V2 전체 회귀는 Node 24.22.3에서 1,603개 통과, 실패·취소·건너뜀 각 0개였다. 독립 AI가 최신 PNG에서 10번의 29px 두 줄과 11번의 34px 세 줄을 읽고, 두 대사 모두 호칭이 한 줄에 있고 테두리와 분리된 것을 확인했다. [이 시점의 전체 회귀](E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-regression-1795260056133-a37f9a78/verification.json)

## 복원 뒤 같은 말풍선에 원문 한 줄이 남은 경우

보관 개발 원고 두 쪽의 고정 OCR 19줄·11줄과 원본·복원·마스크를 대조했다. 복원본 복사본에 일본어 한 줄만 되살린 여섯 사례에서 기존 검사는 0개, 변경 후 검사는 6개를 보류했다. 보관된 복원본 자체는 두 쪽 모두 이 검사에서 보류되지 않았다. 결과 기록에는 남은 글줄의 OCR 식별자와 마스크 안의 어두운 픽셀 수가 담긴다. 웹 작업실에서는 원문 획이 남았을 수 있다는 사유를 보여준다. 검사 입력은 인위적으로 만든 누락이다. 실제 복원 실패율과 흰 테두리 잔상의 검출률은 미측정이다. [변경 전](../../.runtime/lettering-7eee6f3a30/retained-lines-before.json) · [변경 후](../../.runtime/lettering-7eee6f3a30/retained-lines-after.json) · [이미지 예시](../../.runtime/lettering-7eee6f3a30/retained-line-example.png)

## 보류된 원문과 번역을 작업실에서 확인

합성 CPU 응답을 반환한 실제 loopback 웹 배치에서 문장 검수로 보류된 후보가 원문 글줄 옆에 나타났다. 응답 지문을 바꾸면 조회가 거부됐고, 다른 세션에서도 조회할 수 없었다. 저장소 재시작 후 원본 세션에서는 같은 후보를 확인했다. 재조회에 따른 모델 호출과 후보 PNG 생성은 모두 0회였다. [웹 배치와 조회 회귀](../../tests/v2/web-product-path.test.mjs)

실제 작업실 컴포넌트에 합성 원고와 고정 HTTP 응답을 연결해 Chrome 1280×900·390×844에서 각각 원문 선택, 해당 줄 확대, 전체 원고 위치, 키보드로 다음 보류 위치 선택을 확인했다. 수정 전에는 두 화면에서 번역 후보와 확대가 보이지 않았다. 수정 후 확대 창은 138×294 원본 범위를 122×260 CSS 픽셀로 표시했다. 양쪽 모두 브라우저 오류 0건이며 Sites TypeScript 검사를 통과했다. [브라우저 측정](C:/Users/ksaei/AppData/Local/Temp/mangohana-source-review-c5a0c27ccc/after-browser.json) · [데스크톱](C:/Users/ksaei/AppData/Local/Temp/mangohana-source-review-c5a0c27ccc/after-desktop.png) · [모바일](C:/Users/ksaei/AppData/Local/Temp/mangohana-source-review-c5a0c27ccc/after-mobile.png)

잔여 원문 판별과 보류 후보 조회를 포함한 V2 회귀는 1,607개 통과, 실패·취소·건너뜀 각 0개였다. 아래 공유 말풍선과 작업실 편집 변경은 그 이후에 진행했다. [해당 시점의 회귀 기록](E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-regression-1795261279556-c28d47ff/verification.json)

## 공유 말풍선 4번의 이름과 호칭

첫 원고에서 ‘히로 / 군의 / 설명은’ 21px 세 줄을 ‘히로 군의 / 설명은’ 19px 두 줄로 배치했다. 바뀐 3,802픽셀은 모두 4번의 전후 잉크 범위 안에 있고 다른 대사 12개의 줄과 획 경계는 같았다. 4번이 이웃 대사 쪽으로 넘어가는 실제 획은 공유 높이에서 0픽셀이었다. 이 원고의 별도 보호 목록은 비어 있다. 두 번째 원고의 PNG는 직전 결과와 바이트 단위로 같았다. 독립 AI 판독에서는 이름·호칭 연결이 개선됐고 테두리 접촉이 보이지 않았다. 5번에 비해 활자가 작고 두 대사 사이가 벌어진 점은 남았다. [이미지 전후](../../.runtime/lettering-7eee6f3a30/staggered-anchor/before-after.png) · [픽셀 대조와 변조 대조군](../../.runtime/lettering-7eee6f3a30/staggered-anchor/independent/report.json)

## 대사 한 개를 수정한 페이지

첫 보관 원고의 기존 프로젝트 형식에서 1번만 ‘네.’로 고쳤다. 기존에는 변경하지 않은 대사를 다시 측정하다 글자가 넘쳐 PNG 내보내기가 실패했다. 변경 후 Chrome의 2039×2880 PNG에서 1번 영역 안 11,507픽셀이 달라졌고 바깥은 0픽셀이었다. 편집한 항목과 겹치는 사각형은 이전 획이 섞일 수 있어 새로 그린다. 이동·삭제·겹침·이전 저장 형식도 시험했다. [변경 전](C:/Users/ksaei/AppData/Local/Temp/mangohana-source-review-c5a0c27ccc/before-one-edit.json) · [변경 후](C:/Users/ksaei/AppData/Local/Temp/mangohana-source-review-c5a0c27ccc/after-one-edit.json) · [편집 회귀](../../apps/sites/checks/final-image.test.mjs)

실제 작업실에서 같은 편집을 저장하고 이웃 4번을 화면 캡처했다. Chrome 1280×900과 390×844 모두 편집·저장이 작동했고 콘솔 오류는 0개였다. 축소 화면의 4번 사각형은 각각 22×16, 12×9 CSS 픽셀이다. 편집 전후 화면 합성의 최대 채널 값 차이는 8/255, 11/255였다. 두 캡처의 완전 일치는 확인되지 않았다. [두 화면 측정](C:/Users/ksaei/AppData/Local/Temp/mangohana-source-review-c5a0c27ccc/after-html-editor-browser.json)

합성 어두운 바탕에서 엔진이 선택한 흰 글자를 ‘기다려요.’로 수정했다. 기존 PNG에는 밝기 220 이상 회색 획이 0픽셀이었다. 수정 후 PNG에는 밝은 획 1,288픽셀과 지정한 외곽선색 537픽셀이 있었다. 대사 영역 바깥의 변경은 0픽셀이다. 엔진 보고서의 굵기·행간·정렬·본획·외곽선과 실제 프리텐다드 파일을 사용했다. 기존 글꼴의 SHA-256과 웹에서 제공한 파일은 일치했고 Chrome에서 로드 완료를 확인했다. [변경 전](../../.runtime/lettering-7eee6f3a30/dark-edit-before.png) · [변경 후](../../.runtime/lettering-7eee6f3a30/dark-edit-packaged.png) · [글꼴·픽셀 측정](../../.runtime/lettering-7eee6f3a30/dark-edit-packaged.json)

두 번째 보관 원고에서도 10번만 ‘고마워요.’로 바꿔 검사했다. 프리텐다드 29px로 내보낸 2039×2880 PNG의 변경 7,411픽셀은 모두 10번 상자 안에 있었다. 나머지 대사 5개 및 별도로 지정한 보호 영역 8곳 전체에서 차이는 0픽셀이었다. 독립 실행은 현재 제품 함수를 사용했고 브라우저 메모리에만 임시 ID 생성 함수를 제공했다. 원래 블록 ID와 보관 이미지는 유지했다. [두 번째 원고의 편집 PNG](../../.runtime/lettering-7eee6f3a30/second/manual-edit-audit/raw-2-order-10-one-edit.png) · [독립 대조](../../.runtime/lettering-7eee6f3a30/second/manual-edit-audit/report.json)

## 수동 편집한 한국어의 단어와 줄바꿈

같은 26px 프리텐다드와 영역에서 ‘잠깐만 설 / 명을 들어 / 봐요.’를 ‘잠깐만 / 설명을 / 들어봐요.’로 그렸다. 양쪽 모두 세 줄이며 문구를 그대로 보존했다. 말풍선 영역 밖의 변경은 각각 0픽셀이다. 한 단어가 한 줄보다 긴 경우 글자 묶음과 뒤의 문장부호를 보존해 나누며, 사용자가 입력한 빈 줄도 남긴다. [기존 줄](../../.runtime/lettering-7eee6f3a30/word-wrap-before.png) · [바뀐 줄](../../.runtime/lettering-7eee6f3a30/word-wrap-after.png)

데스크톱 1280×900과 모바일 390×844에서 같은 문장을 직접 입력하고 저장했다. 작업실이 표시한 세 줄은 내보낸 PNG와 일치했고 가로·세로 넘침과 콘솔 오류는 0건이었다. 어두운 원고에서 흰 대사를 직접 고칠 때는 반투명 흰 바탕을 제거하고 커서를 본문과 같은 흰색으로 표시했다. [화면별 줄의 실제 좌표](../../.runtime/lettering-7eee6f3a30/word-preview-final.json)

## 실제 획이 들어간 대사에 표시되던 줄 넘침 경고

두 보관 원고의 최종 PNG·좌표·획과 줄 기록으로 작업실 결과 입력을 재구성했다. 기존 추정식은 첫 쪽의 4·8·11·12·13번, 두 번째 쪽의 5·7·10·12·14번에 경고를 표시했다. 새 검사는 현재 글자·좌표·크기와 최종 PNG가 연결되고 해당 영역의 원본 해상도 획 경계, 전체 문구, 잘림·충돌 검사까지 일치할 때 실제 측정을 사용한다. 두 쪽에서 위 경고는 각각 5→0개가 됐다. 각 쪽의 첫 대사를 긴 문장으로 수동 교체하면 그 대사에 경고가 다시 나타났다. 잘림을 1픽셀로 바꾼 대조군에서도 기존 경고가 돌아왔다. 두 쪽 모두 미승인 후보 상태였다. 두 번째 원고 5번의 20px 높이를 작업실 복구 시 28.8px로 강제로 늘리던 문제도 함께 수정했다. [측정 기록](../../.runtime/lettering-7eee6f3a30/studio-fit-archive.json) · [경고 대조군](../../apps/sites/checks/stage17-studio.test.mjs)

## 회색 말풍선의 원래 획 근처에서 글자 확대

두 번째 원고의 5번은 17→24px 한 줄, 12번은 19→21px 세 줄로 커졌다. 각 후보의 원본·마스크·복원 픽셀과 여백을 재확인하고, 줄 수와 가독성 점수가 나빠지지 않는 범위에서 크기를 골랐다. 전후 PNG 사이에서 6,064픽셀이 달라졌고 전부 두 대사의 전후 획 경계 안에 있었다. 보호 영역 8곳과 나머지 대사 4개의 픽셀 차이는 0개다. 첫 원고 13개 대사의 완성 PNG는 직전판과 바이트가 같았다. [두 대사 전후 확대](../../.runtime/lettering-7eee6f3a30/second/flat-neighbor/before-after.png) · [픽셀·입력 지문](../../.runtime/lettering-7eee6f3a30/second/flat-neighbor/wrap-comparison.json)

독립 AI가 두 크롭에서 더 또렷해진 획, 테두리와의 간격, 12번 세 줄의 구별을 확인했다. 5번의 회색 띠와 옅은 무늬가 남아 있고, 이 그림만으로 미세한 복원 흔적을 판정할 수 없었다. 5번의 번역은 의미 검수 대상이다. 다시 그린 PNG는 기존 번역 고정 비교이며 실제 자동 경로에서는 계속 보류된다. [완성 PNG](../../.runtime/lettering-7eee6f3a30/second/flat-neighbor/page.png)

실제 Electron에서 검은 작화 1픽셀이 있는 합성 면은 해당 픽셀 앞에서 멈췄고, 보호 상자가 원문과 겹치는 대조군은 수동 검수로 남았다. 제품 렌더러와 보관 원고 재현 번들의 SHA-256은 b4759938c462918f4052e5654d72dfb1cd573e29e9f15947d86bd287d86c6813이다. [네이티브 검사](C:/Users/ksaei/AppData/Local/Temp/background-native-ttLWPd/result.json)

앞선 전체 회귀에서 수동 줄바꿈의 공백 한 칸 누락으로 1,610개 중 1개가 실패했다. 캔버스에 원래 구분 공백을 전달하고 글자의 가운데 위치를 보정한 후 해당 수동 내보내기 회귀가 통과했다. 공백 보존 전후의 세 줄 PNG는 바이트가 같았다. 작업실 전체 246개가 통과했다. [실패한 전체 회귀](E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-regression-1795262728285-91dc025e/verification.json) · [공백을 포함한 실제 캔버스 문자열](../../.runtime/lettering-7eee6f3a30/word-wrap-spaces.json) · [작업실 회귀](../../.runtime/lettering-7eee6f3a30/studio-regression-final.log)


## 보관 번역에서 과도하게 반복된 수치 항목

보관 M2M100 응답 71쪽·554줄에서 네 줄의 동일한 한국어 수치 항목이 원문보다 여러 번 늘었다. 두 줄은 수치 쌍 3개가 18개로, 다른 두 줄은 4개가 13개로 늘었다. 이전에도 숫자 차이 신호가 있었지만 네 줄 모두 한국어 출력 검사와 초안 사용 검사를 통과했다. 현재 한국어 출력 검사의 보류는 111줄 그대로이고, 식자 전에 검토할 초안은 115줄이다. 네 줄 모두 원문에 없는 수치 항목이 있다는 독립 AI 문자 검토를 받았다. 마지막 두 줄은 별도의 페이지·행 키로 저장돼 있으나 문구와 숫자가 비슷해 독립 원고 두 장으로 세지 않았다. 새 모델 실행과 사람 정답 평가는 없었다. [이전 수치 검사](../../.runtime/lettering-7eee6f3a30/numeric-fields-before.json) · [전체 재검사](../../.runtime/lettering-7eee6f3a30/numeric-fields-after.json)

합성 웹 작업에서는 같은 요청이 수정 전에는 결과 다운로드를 제공했고 수정 후에는 복원 전에 멈췄다. 원문과 수신 번역은 소유자 작업 목록에서 다시 열렸고 외부 세션은 404, 응답이 바뀌면 502였다. 데스크톱·모바일 Chrome의 작업실에서 중립적인 수치 예시와 보류 이유, 원문 확대를 확인했다. [웹 수정 전](../../.runtime/lettering-7eee6f3a30/numeric-http-before.json) · [웹 수정 후](../../.runtime/lettering-7eee6f3a30/numeric-http-after.json) · [작업실 두 화면](../../.runtime/lettering-7eee6f3a30/numeric-review-browser.json)

## 말풍선에 글자 맞춤을 눌렀을 때의 실제 크기

두 번째 보관 개발 원고에 짧은 수동 편집 문구를 넣고 같은 위치와 색에서 PNG를 비교했다. 5번 ‘네.’는 이전 맞춤 버튼의 13px에서 24px로, 14번 ‘네?’는 28px에서 36px로 출력됐다. 10번 ‘고마워요.’는 이전과 같은 29px였고 PNG도 같았다. 바뀐 두 PNG의 차이는 각각 488픽셀, 1,290픽셀이며 선택 영역 밖과 별도 보호 상자 8곳에서 0픽셀이었다. 문구는 식자 확인용이며 해당 페이지의 승인 번역이 아니다. 저장된 최종 PNG·복원 PNG·식자 기록으로 작업실 입력을 재구성했다. [왼쪽 기존 / 오른쪽 현재](../../.runtime/lettering-7eee6f3a30/second/fit-archive/before-after.png) · [크기·획·보호 영역 측정](../../.runtime/lettering-7eee6f3a30/second/fit-archive/report.json)

이제 맞춤 버튼·수동 미리보기·PNG가 같은 글꼴의 실제 획 경계와 외곽선으로 잘림과 줄 겹침을 확인한다. 이미 들어가는 글자는 그대로 두며, 최소 크기로도 들어가지 않으면 기존 값을 보존하고 영역 변경을 안내한다. 합성 모바일·데스크톱 화면에서 들어가는 대사의 26px 유지와 경고 0개를 확인했다. 작업실 회귀는 247/247개 통과했고 빌드에 포함된 프리텐다드 TTF의 SHA-256이 원본과 일치했다. [버튼 실측](../../.runtime/lettering-7eee6f3a30/fit-preview-final.json) · [작업실 회귀](../../.runtime/lettering-7eee6f3a30/studio-regression-fit-isolated.log)

중간 V2 전체 회귀에서 1,610개 중 대체 번역 경로 8개가 실패했다. 당시 오류는 STALE_RESULT와 INSPECTION_INVALID였고 수정 작업이 진행 중이었다. 현재 파일로 해당 대체 경로를 단독 재실행해 43/43개가 통과했다. [해당 전체 회귀](E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-regression-1795263844035-d0fc6083/verification.json) · [대체 번역 경로 재검사](../../.runtime/lettering-7eee6f3a30/fallback-e2e-current.log)

## 줄에 홀로 남은 문장부호와 회색 말풍선의 획 대비

로컬 Python 검토판의 보관 원고 71쪽에서 화면 안에 식자한 361줄의 이전 줄바꿈을 전부 재현했다. 같은 상자와 글꼴에서 콜론·말줄임·물결표만 한 줄에 남는 경우가 4건에서 0건으로 줄었다. 전체 34곳의 줄 배치가 달라졌다. 여백에 기록한 193줄은 집계에서 제외했다. 작업실 수동 편집에서도 사용자가 입력한 빈 줄과 단어 사이 간격을 보존하며 닫는 문장부호를 앞말과 함께 배치한다. [Python 줄바꿈·작화 보호 검사](../../tests/v2/test_local_review_render.py) · [작업실 줄바꿈 검사](../../apps/sites/checks/studio.test.mjs)

문장부호 네 곳은 보관 PNG에서 원래 획을 재현하고, 다른 대사와 그림에 닿는 후보를 제외한 뒤 새 획을 비교했다. 글자 크기는 각각 49→40px, 49→34px, 52→43px, 52→52px였다. 네 곳 모두 전후 글자 획 바깥과 다른 OCR 상자의 변경은 0픽셀이었다. 독립 AI가 네 크롭에서 부호 연결과 테두리 간격을 확인했다. 49→34px인 대사는 강조가 약해졌고, 두 곳에는 바탕에 옅은 흔적이 보였다. 불투명한 옛 글자 밑의 바탕은 추정했으며 이 네 곳의 전체 페이지 사람 검수는 미실행이다. [로컬 크롭별 측정](../../.runtime/lettering-7eee6f3a30/archived-punctuation-clearance/report.json)

같은 회색 원고의 두 대사는 크기를 유지하고 글색과 외곽선만 바꿨다. 22px 대사는 바탕 대비 최솟값이 2.58→5.10, 중앙값이 3.72→5.17이었다. 50px 대사는 중앙값이 4.17→4.54가 됐고 일부 본획과 바탕의 대비는 4.06까지 내려갔다. 이 대사에는 검은 2px 외곽선을 넣어 흰 본획과 외곽선의 대비가 21:1이 됐다. 두 비교에서 전후 획 바깥과 다른 OCR 상자의 변경은 0픽셀이었다. 저장된 번역을 고정해 식자를 비교했으며 두 문구의 번역 정확도는 승인되지 않았다. [로컬 대비·보호 픽셀 측정](../../.runtime/lettering-7eee6f3a30/archive-contrast/result.json)

## 원문 문장부호에 단어가 추가된 번역

같은 554개 보관 번역에서 `、`가 ‘그리고’로, `！？`가 ‘그럼 !’로 처리된 세 줄이 이전에는 초안 검사를 통과했다. 현재는 문장부호뿐인 원문에서 번역에 단어나 숫자가 생기면 식자 전에 보류한다. `！？`를 `?!`로 표기하는 경우는 허용한다. 기존 한국어 출력 검사에 걸린 111줄, 과도하게 반복된 수치 4줄, 이번 3줄을 합해 초안 검토 대상은 118줄이다. 합성 웹 배치에서도 같은 쉼표 대사가 수정 전에는 다운로드 후보였고 수정 후에는 원문·수신 번역과 이유가 남은 `NEEDS_REVIEW`가 됐다. 복원·식자 호출은 0회였다. [번역 계약 검사](../../tests/v2/stage11-translation-contract.test.mjs) · [웹 배치 검사](../../tests/v2/web-product-path.test.mjs) · [로컬 71쪽 재검사](../../.runtime/lettering-7eee6f3a30/punctuation-expansion-after.json)

위 수치는 보관 개발 원고와 합성 회귀에서 얻었다. 새 원고의 무수정 합격률, 독립 번역가의 정답 대조, 이전 번역 체크포인트를 되살렸을 때의 새 문장부호 보류 동작은 미검증이다. `.runtime`과 드라이브 경로의 영수증·이미지는 로컬에 보관한다.

## Git에 담은 파일의 최종 검증

커밋 대상 파일을 Git에 저장된 줄바꿈으로 별도 폴더에 꺼내고 기존 설치 의존성만 연결했다. 첫 웹 빌드에서 개인 호스팅 설정을 찾지 못했다. 일반 로컬 빌드에 계정 없는 기본 설정을 제공한 뒤 웹 빌드와 TypeScript 검사, 식자 엔진 빌드가 모두 통과했다. 호스팅 설정을 제공하면 원래 바이트를 사용하고, 관리형 빌드에서 필요한 설정이 빠지면 오류가 유지된다. 완성 번들 속 Pretendard와 엔진에서 검증한 글꼴의 SHA-256은 `3090ccde0442bb347aa7685d9ba8b17436a60682df6e8f92a9a670de14056e22`로 일치했다. [호스팅 검사](../../apps/sites/checks/portable-hosting.test.mjs) · [로컬 웹 빌드 기록](../../.runtime/lettering-7eee6f3a30/staged-site-build-final.log)

| Git 사본에서 실행한 검사 | 결과 |
| --- | --- |
| 웹 작업실 전체 | 248/248 통과 |
| Python 로컬 OCR·번역·그리기 | 38/38 통과 |
| 식자·번역 계약·첫 이미지 평가 관련 Node 검사 | 67/67 통과 |
| 경고 없이 들어온 불량 번역 세 종류의 웹 배치 보류 | 3/3 통과 |
| 이번에 빌드한 Electron 엔진의 합성 말풍선·보호 영역 그리기 | 1/1 통과 |

문장부호 변경 전의 V2 전체 회귀는 앞의 대체 경로 실패를 포함해 다시 실행한 결과 1,612/1,612개가 통과했다. 검사 전후 대상 소스 지문이 일치했고 건너뜀·취소·실패와 실제 AI 호출은 모두 0건이었다. [이전 전체 회귀](E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-regression-1795264872902-257f1578/verification.json)

문장부호 보류까지 포함한 마지막 전체 V2 회귀는 기존 작업 폴더와 로컬 시험 자료를 사용해 Node 24.22.3에서 **1,614/1,614개 통과**했다. 종료 코드 0, 실패·취소·건너뜀·미완료 각 0개, 실제 제품 AI 요청 0회였고 검사 전후 대상 소스 지문이 같았다. 위 표는 Git에 담은 사본에서 별도로 실행한 검사다. [최종 전체 회귀 영수증](E:/Dev/Outputs/MangohanaV2-20261111/tests/v2-regression-1795266352207-92bd196b/verification.json)

메인 Codex가 구현·통합을 맡았다. 하위 에이전트 2개가 독립 확인에 참여했다. 가독성 검토 역할의 설정은 GPT-6.1 Sol이고, 회귀·픽셀 측정 검증 역할의 설정은 GPT-6 Luna다. 개별 추론 사용량은 미측정이다. 보관 원고의 원본·재현 PNG와 개인 호스팅 설정은 로컬에 보관한다.
