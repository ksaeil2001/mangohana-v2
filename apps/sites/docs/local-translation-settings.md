# 로컬 번역 모델 설정 v1 — 폐기된 기능 기록

현재 앱은 온라인 처리만 제공한다. 로컬 모드 버튼, Gemma·OCR 설정 UI, capability 협상과 로컬 설정 전송을 제거했다. 아래 규격은 이전 버전의 기록이며 현재 요청 계약이 아니다. 기존 프로젝트의 `localTranslation`, `localOcr`, workspace의 `endpoints.local`은 v1 백업 호환성을 위해 보관하지만 실행에 사용하지 않는다. 가져오기·저장소 복원 시 `mode`는 `online`으로 전환한다.

현재 `POST /jobs`는 `file`, `source_language`, `target_language` 세 항목만 전송한다. 연결 검사·새 작업·저장된 작업 조회 모두 HTTPS를 요구하며 이전 HTTP 작업을 자동 재개하지 않는다. 이전 작업 ID는 보관하고, 기존 `이전 결과로 편집` 동작으로 해당 연결을 정리한 뒤 온라인 처리 또는 직접 편집을 이어갈 수 있다. 이미지·텍스트·스타일·작업 기록은 보존한다.

Trio가 연결된 엔진에 전달하는 선택적 확장 규격이다. 모델 실행기·다운로더는 이 웹 앱에 포함하지 않는다. 로컬 모드의 Gemma 설정 UI, 프로젝트별 저장, 명시적으로 지원을 알린 엔진으로의 전달을 제공한다. Codex·Claude Code·API 번역 엔진 설정은 이번 범위에 없다.

## 표시와 저장

로컬 모드의 기본 오른쪽 패널에 `번역 모델 / Gemma 로컬`을 표시한다. 언어·모델 소스·HF 프리셋 방식·프리셋·런타임·여유 VRAM은 기본 영역, 샘플링·토큰 한도는 접힌 상세 영역이다. 로컬 버튼은 연결 화면에서 모델 설정으로 돌아가는 역할도 한다. 온라인 모드에서는 로컬 패널을 숨기며 저장된 값은 유지한다.

`Project.localTranslation`은 선택적 필드이므로 기존 workspace v1/프로젝트 백업을 유지한다. 필드가 없는 프로젝트는 표시 시 기본값을 사용하고 사용자 변경 시 저장한다. 입력은 유한 숫자/범위/선택지/문자열 길이로 정규화한다. 식별자·파일 경로의 바깥 공백을 제거한다. 문자열과 숫자 입력은 blur/Enter에서 확정하여 입력 문자마다 문서 undo를 쌓지 않는다. 기존 프로젝트 변경 이력·백업·복원·프로젝트별 독립 상태를 사용한다.

## 지원 확인과 요청

엔진의 `/health`가 다음 capability를 명시한 경우만 새 작업에 설정을 첨부한다.

```json
{"status":"ok","capabilities":["local_translation_settings_v1"]}
```

현재 저장된 로컬 endpoint와 성공한 테스트의 endpoint가 일치해야 한다. 테스트 결과는 요청 ID와 endpoint에 묶이며 다른 주소/새 테스트/실패/취소는 이전 테스트 결과를 채택하지 않는다. 지원하지 않는 엔진은 기존 요청을 유지하고 UI에는 `설정 보관 중`으로 표시한다. 연결 전에는 `연결 대기`, 지원 엔진에 유효한 입력이 준비되면 `엔진에 적용`으로 표시한다. 이는 새 작업에 전달할 상태이며 이미 실행 중인 모델을 바꿨다는 의미는 아니다.

새 로컬 작업의 기존 `POST /jobs` multipart 항목 `file`, `source_language`, `target_language`에 문자열 필드 `local_translation_settings`를 추가한다. JSON 값은 다음과 같다.

```json
{
  "version":1,"engine":"gemma-local",
  "modelSource":"huggingface","variant":"fast","preset":"12b","runtime":"cuda12",
  "repoId":"","filename":"","modelPath":"","vramReserveMiB":512,
  "temperature":0.1,"topP":0.95,"topK":64,
  "maxOutputTokens":24576,"contextLength":32768
}
```

| 항목 | 허용 값과 의미 |
| --- | --- |
| modelSource | `huggingface` 또는 `local` |
| preset | HF의 `12b`, `26b`, `31b`, `custom` 프리셋 |
| variant | HF 프리셋의 `fast` 또는 `legacy` 선택 |
| runtime | `cuda12`, `rtx50`, `vulkan`, `rocm` |
| repoId / filename | HF `custom`일 때 `소유자/저장소`와 `.gguf` 파일명 |
| modelPath | `local`일 때 엔진 PC의 GGUF 경로 |
| vramReserveMiB | 모델에 할당하지 않을 여유 VRAM, 정수 0–65,536 MiB |
| temperature / topP / topK | UI 범위 0–2 / 0.01–1 / 정수 0–1,000 |
| maxOutputTokens / contextLength | UI 범위 정수 1–131,072 / 512–262,144, 출력은 컨텍스트 이하 |

프리셋이 특정한 실제 저장소/파일을 가리키는 매핑은 엔진이 제공한다. UI에서 임의의 Hugging Face 저장소 ID를 만들어 넣지 않는다. `local` 소스의 엔진은 `preset`, `variant`, `repoId`, `filename`을 무시하고 `modelPath`의 모델을 사용한다. HF 소스는 `modelPath`를 무시한다. 비활성 소스의 입력을 보존하여 소스 전환 시 복원한다. 런타임 설치 여부·장치 메모리·실제 모델의 토큰 한도·모델 파일 접근은 엔진이 최종 검증하고 기존 작업 오류 규격으로 응답한다. UI 입력 범위와 기본값은 공식 모델 사양을 보증하지 않는다.

온라인 요청과 capability가 없는 기존 엔진의 multipart는 변경하지 않는다. 저장된 `jobId` 조회 재개에는 설정 첨부·모델 로드·새 이미지 전송을 하지 않는다. 처리 시작 시 프로젝트·설정을 고정하고 준비/가져오기/내보내기/처리 guard를 유지한다.

## 번역 생성 권장값 표시

`RECOMMENDED_LOCAL_GENERATION`을 Trio 번역용 프로필로 사용한다. Temperature 0.1, Top P 0.95, Top K 64, 최대 출력 24,576, 컨텍스트 32,768이다. 이는 참고 이미지에 맞춘 앱의 프로필이며 모든 모델·하드웨어의 공식 최적값을 보증하지 않는다.

`권장값 적용`은 위 다섯 필드만 한 번에 바꾸고 모델 소스·파일·프리셋·런타임·VRAM·OCR을 유지한다. 다섯 저장값이 모두 일치하고 현재 입력 초안도 일치할 때 버튼을 `권장값 사용 중`으로 바꾸며 상세 영역이 접혀 있어도 초록색 `권장값` 표시를 남긴다. 따로 저장하는 활성 플래그가 없으므로 수동 편집·undo·새로고침 후에도 값에서 판정한다. 입력 중 값이 다르면 blur 전에도 표시를 해제하고, 재적용 시 초안도 복원한다. 기존 숫자 입력의 blur/Enter 확정·이력 정책은 유지한다.

## 로컬 OCR 확장

로컬 모드에서 번역 모델 바로 아래 별도의 작은 접이식 OCR 영역을 표시한다. 프로젝트의 선택적 `localOcr` 필드를 보관한다. 기본은 HayaiOCR / NVIDIA CUDA이며 선택 범위는 다음과 같다.

| 필드 | 값 |
| --- | --- |
| engine | `hayai` → HayaiOCR, `hunyuan15` → HunyuanOCR 1.5, `paddle` → PaddleOCR 레거시 |
| device | `cuda` → NVIDIA CUDA, `rocm` → AMD ROCm, `cpu` → CPU |

참고 이미지의 일본어/Hayai·다국어/Hunyuan 안내를 짧게 표시하되 언어 변경만으로 사용자의 OCR 선택을 바꾸지 않는다. 장치 선택은 실제 설치·지원 여부를 탐지했다는 뜻이 아니며 실행 엔진이 최종 검증한다.

OCR 설정 전달은 번역 설정 지원과 독립적으로 `/health`의 `local_ocr_settings_v1` capability가 있어야 한다. 같은 endpoint를 성공적으로 테스트한 뒤 새 로컬 작업의 multipart에만 다음 문자열 JSON 필드 `local_ocr_settings`를 추가한다.

```json
{"version":1,"engine":"hayai","device":"cuda"}
```

두 capability를 모두 알린 엔진에는 두 JSON 필드를 함께, OCR만 알린 엔진에는 OCR 필드만 보낸다. capability가 없으면 기존 OCR 방식으로 요청하며 UI에는 설정을 보관 중이라고 표시한다. 기존 프로젝트의 필드 부재, 온라인 요청, 과거 작업 ID의 재조회는 이전 규격과 동작을 유지한다. 이 변경에 OCR 실행기 설치나 이미지 인식 모델은 포함하지 않는다.
