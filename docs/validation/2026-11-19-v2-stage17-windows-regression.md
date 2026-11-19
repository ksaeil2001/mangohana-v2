# Stage17 Windows V2 회귀 원인 분석과 재검증

2026-11-19 KST. 시작 기준은 이전 전체 V2 1,330/1,340, 해당 다섯 파일 34/40, 누락 plan 단일 실행 1/1이다. 같은 worker의 생성·재개·종료와 supervisor 영수증을 대조해 처음 잘못된 지점을 좁히고, 확인된 동작만 수정하는 작업이다. 기존 분모와 보호 조건에서 다섯 파일과 전체 V2를 각각 재검증한다. [이전 인계](../superpowers/handoffs/2026-11-19-stage18-handoff.md)

**최종 Windows 합성 회귀는 다섯 파일 40/40, 전체 V2 1,340/1,340 통과다.** 누락 plan·기본 식자 단독은 각각 1/1, Stage16 보호 검사는 193/193이었다. 같은 소스에서 앞선 전체 실행은 합성 번역 준비 6건과 Electron 정상 기동 1건이 실패했다. 최종 검사는 별도 호스트 진단을 동시에 수행하지 않고 실행했다. 두 실행 모두 네이티브 식자 후보 지문과 승인 거부가 일치했다. 간헐적인 Windows 기동·응답 지연의 단일 원인은 확정하지 못했다. [최종 원장](stage17-windows-regression-20261119/quiet-results.json) · [같은 소스의 앞선 실패](stage17-windows-regression-20261119/journal-results.json)

## 입력과 검증 기준

Git 공유본에는 합성 테스트와 실행 결과를 담았다. 실제 승인·서명 원본 대조와 Windows 보안 이벤트의 원자료를 가리키는 링크는 검증을 수행한 작업 폴더에서 열 수 있다. [공유용 최종 검증 결과](stage17-windows-regression-20261119/quiet-results.json)

기준 브랜치는 `codex/mangohana-v2-sites-20261111`, HEAD는 `4a87e02020a62b3a8925c6568925477e8b063b78`다. 원래 다섯 테스트 파일과 합성 fixture로 시작했다. 모든 비교에서 Node v24.22.1, 직렬 실행, 1.5초 HTTP 조회·5초 테스트용 모델 준비·15초 Electron 테스트·원래 Job 수명·커널 정리 조건을 유지한다. Stage16은 기존 메타데이터 전용 파일·이름 허용 목록과 이미지 차단기로 실행한다. 확인된 수정과 진단은 별도 실행 이름과 소스 지문으로 기록했다.

## 이전 실패의 최초 관측

최종 인계의 전체 TAP에서 시간순으로 처음 실패한 항목은 OCR 136번이다. 직렬 실행에서 첫 OCR fixture가 18:26:52.130 UTC에 생성됐고 18:26:53.770에 합성 입력 `source.png`가 생겼다. 이 실행에는 첫 엔진 이벤트 원장과 정규화 결과가 없으며 정리 기록의 OCR 자식은 0개다. TAP은 15초 제한과 본문·정리를 포함한 27.924초를 기록했다. 이 자료로 식별할 수 있는 범위는 입력 생성 이후 첫 엔진 산출물 이전까지다. 이번 다섯 파일 및 전체 실행의 같은 항목은 통과했고 각각 첫 엔진 이벤트 15건과 OCR 자식 한 개를 확인했다. [원래 TAP](stage17-18-20261119/v2-current.log) · [원래 fixture와 재실행 비교](stage17-windows-regression-20261119/first-ocr-files.json)

| 실행 | 누락 plan의 준비·종료 결과 | 식자 |
|---|---|---|
| 첫 E: 전체 회귀 | 테스트 디렉터리 생성부터 커널 root 생성까지 22.67초. 이후 원래 `plan_read/ENOENT`와 종료 1·정리 완료를 기록했다 | 기본 합성 식자는 최종 승인 후 후보와 결과 JSON을 썼고 실제 PNG SHA가 영수증과 일치했다. 이후 root 자체가 2147483651로 종료됐으며 stderr에 `PostQueuedCompletionStatus (6)`가 있다. |
| 최종 E: 전체 회귀 | 생성까지 0.56초. supervisor의 기록은 `lifetime_timeout`, 종료 87이다 | 승인 ROI 변형도 같은 순서로 결과를 저장하고 동일한 Windows 종료 오류를 냈다. |
| 다섯 파일 | 생성까지 6.62초. 원장의 사유는 `lifetime_timeout`, 종료 87이다 | 두 정상 변형은 종료 0. 별도 변형에서 supervisor 준비 자체가 시간 초과했다. |
| 기존 단일 실행 | 생성까지 2.04초. 원래 plan 읽기 오류·종료 1, 커널 정리 완료 | 해당 없음 |

이전 실행에서는 정확한 root 종료 시각을 저장하지 않았다. E:는 exFAT이고 이 폴더의 파일 수정 시각은 2초 단위로 관측됐다. 이전 원장의 파일 시각은 대략적인 기록 순서에만 사용하고 네이티브 타이머의 `elapsedMs`를 따로 대조했다. Electron의 합성 테스트 폴더는 실행 시간대별로 후보가 하나씩이었고, entry 증명과 kernel 원장의 실행 ID·PID·Windows 생성 시각을 대조했다. 식자 후보는 실제로 생성된 테스트 소유 PNG만 바이트 지문으로 확인했다. [원시각과 두 원장의 대응](stage17-windows-regression-20261119/historical-timeline-v2.json) · [볼륨 형식](stage17-windows-regression-20261119/volume-format.json)

식자 성공 경로의 마지막 호출은 두 출력 쓰기 이후의 `app.exit(0)`이었다. 같은 실행의 supervisor는 `root_exit`와 커널 정리 완료를 기록했다. 첫 가설은 정상 경로를 `app.quit()`으로 바꾸면 충돌을 피한다는 것이었다. 오류 진단 저장이 실패했을 때도 종료 상태 1이 먼저 설정되도록 고쳤다. 첫 가설을 포함한 모의 검사가 1/3에서 3/3이 됐지만, 아래의 실제 Windows 재현에서 같은 충돌을 다시 관측했다. [가설 검사의 RED](stage17-windows-regression-20261119/worker-shutdown-journal-red.tap) · [중간 GREEN](stage17-windows-regression-20261119/worker-shutdown-green.tap)

## Windows에서 새로 측정한 결과

기존 영수증 10개에는 worker 종료 시각이 없었다. supervisor가 이미 보유한 프로세스 핸들에서 종료 신호와 생성 식별자가 일치할 때 Windows의 실제 종료 시각도 읽도록 했다. 이 조회에 실패하면 값은 `null`이다. 시간 제한·PID와 생성 식별자 대조·커널 Job 할당·정리 판정식은 그대로 사용한다. 다섯 파일에서 10/10건의 생성·종료 순서, 완료 이벤트, supervisor 종료와 남은 프로세스 0개를 대조했다. [수정 전](stage17-windows-regression-20261119/exit-time-red.json) · [수정 후](stage17-windows-regression-20261119/measured-five/exit-time.json)

다섯 파일 조사 실행은 36/40, 다음 계측 실행은 38/40이었다. 후자에서 잘못된 Electron 인자 검사는 15초 테스트 제한에 걸렸다. 실행 ID `bbba42aa-e7f5-4d4d-874f-cd8d7b6270d9`의 UTC 시각은 supervisor 요청 20:01:08.042, worker 생성 20:01:21.892, 재개 관측 20:01:21.907, worker 종료 20:01:21.959, supervisor 종료 20:01:22.569다. worker는 예상 코드 1로 67ms 만에 끝났고 준비 이벤트가 도착하기까지 13.864초가 걸렸다. 15초 제한은 테스트 본문 전체에 적용된다. [검사별 TAP](stage17-windows-regression-20261119/measured-five/tap.log) · [시각과 영수증](stage17-windows-regression-20261119/measured-five/joined.json)

같은 실행의 기본 번역 worker는 생성 후 첫 연결이 거부됐고 이어진 세 차례의 요청은 응답 헤더 전에 각각 약 1.51초로 만료됐다. 원장의 최초 실패는 `LLM_START_TIMEOUT`이었다. 19:58:55.084 UTC에 이를 기록한 뒤 19:59:05.809에 자식 종료가 관측됐다. 테스트에 노출된 마지막 오류는 `CLEANUP_FAILED`다. 이전 조사에서 실패한 두 fixture도 인증된 모델 조회 한 건씩만 기록했다. [번역 worker의 부모 이벤트](stage17-windows-regression-20261119/measured-five/trace/engine-runtime-reuse.test.mjs.17244.json) · [원래 실패](stage17-windows-regression-20261119/investigate-five/tap.log)

동일한 합성 서버에서 요청·응답 본문과 인증은 그대로 두고 HTTP 기록 위치만 바꾼 8회는 모두 통과했다. E: 기록은 2~9ms였다. 서버 파일 위치만 바꾸고 기록을 E:에 둔 8회는 7회 통과했다. 실패한 1회는 C: 파일이었고, 5초 동안 연결이 거부됐으며 worker의 첫 계측 이벤트도 도착하지 않았다. 이 두 비교에서 특정 볼륨이나 원장 쓰기 자체가 여러 초의 지연을 일으킨다는 근거는 얻지 못했다. [원장 위치 비교](stage17-windows-regression-20261119/storage-probe.json) · [코드 위치 비교](stage17-windows-regression-20261119/source-probe.json)

최종 비교는 같은 제품 소스에서 직렬 전체 회귀, 다섯 파일만 실행한 회귀, 누락 plan 하나만 실행한 검사로 구성한다. 각 실행에는 독립적인 E: 테스트 폴더를 할당한다. 세 검사에 같은 worker 식별자 대조를 적용하고 각 시도의 실패·취소도 함께 남긴다. Stage16은 기존 허용 목록 검사를 별도로 집계한다.

## 식자 worker의 네이티브 종료 충돌

Electron 42.9.3에서 첫 전체 회귀는 1,340/1,340이었지만 바로 뒤의 다섯 파일은 39/40이었다. 기본 식자 worker PID 13228은 20:18:34.176 UTC에 생성돼 20:18:53.164에 `0x80000003`으로 종료됐다. 실행 ID `173a4464-0663-4958-bc86-33e9a229afa6`에서 결과 JSON의 세대와 candidate PNG의 SHA-256이 모두 맞았다. supervisor는 강제 종료 요청 없이 `root_exit`와 남은 프로세스 0개를 확인하고 20:18:54.126에 종료했다. stderr에는 `PostQueuedCompletionStatus (6)`이 남았다. 같은 코드로 ROI를 승인한 변형은 정상 종료했다. [실패 TAP](stage17-windows-regression-20261119/final-five/tap.log) · [이번 후보와 커널 영수증](stage17-windows-regression-20261119/final-five/joined-v2.json) · [전체 실행 대조](stage17-windows-regression-20261119/measured-full/joined-v2.json)

Electron이 확인한 Windows 종료 결함은 Node의 지연 작업 스케줄러가 libuv 완료 포트를 닫은 뒤 V8 백그라운드 작업이 다시 작업을 등록하는 경쟁이다. 이때 같은 네이티브 오류가 발생한다. 설치된 42.9.3은 수정 전 버전이며, 42.x에 이 수정이 처음 들어간 버전은 42.10.0이다. 로컬에서 확인한 근거는 실행 파일 버전, 네이티브 메시지, 커널 종료 코드와 출력 저장 순서다. 이번 실행의 심볼이 포함된 네이티브 호출 스택은 확보하지 못했다. [Electron 수정·백포트 기록](https://releases.electronjs.org/pr/52956) · [교체 전 실행 파일 지문](stage17-windows-regression-20261119/electron-before.json)

V2 엔진 의존성과 잠금 파일에 42.10.0을 정확히 고정했다. 공식 npm 패키지의 SHA-512와 Windows ZIP의 SHA-256을 확인하고, ZIP 내부와 실제 설치된 `electron.exe`의 SHA-256이 `7d651c286d0c7b2a8658e028fe5a42b145fff33962732cf0977a6453f61da54c`로 같음을 검사했다. 식자 성공 시 기존 종료 호출을 복원했다. 실패 진단의 저장이 실패해도 코드 1로 종료하는 한 가지 순서 수정은 유지했다. [버전 RED](stage17-windows-regression-20261119/electron-red.json) · [바이너리 GREEN](stage17-windows-regression-20261119/electron-green.json) · [최종 종료 계약 3/3](stage17-windows-regression-20261119/worker-final-contract.tap)

이 공식 바이너리의 다섯 파일 실행은 30/40이었다. Windows가 신규 `electron.exe`의 프로세스 생성을 거부했다. 실제 이벤트 3077은 요청자 `powershell.exe`, 대상이 해당 V2 실행 파일, 버전 42.10.0.0, 정책 `VerifiedAndReputableDesktop`, 상태 `0xc0e90002`를 기록했다. Authenticode 상태는 `NotSigned`다. 이 시도에서 네이티브 worker의 실제 생성 시각, 수명, 종료 코드는 미관측이다. 같은 Windows 정책을 계속 적용했다. 원래 실행 파일의 복원용 ZIP 안에서 시작 시 SHA-256 `f05ccb120ecdfc46945d37c68fc7890a70846b5ec5f9cc406c257de2e6ea3baa`가 그대로 나옴을 먼저 검증했다. [정책 이벤트](stage17-windows-regression-20261119/runtime-policy-fields.json) · [Microsoft 이벤트 정의](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/event-id-explanations) · [복원 파일 대조](stage17-windows-regression-20261119/rollback-archive-match.json)

같은 42.10.0 시도의 전체 V2는 1,325/1,340, 누락 plan과 기본 식자 단독 검사는 각각 0/1이었다. 실제 기동을 확인할 수 있었던 42.9.3을 원래 경로에 복원했다. 의존성 선언, 잠금 파일, 설치된 패키지 선언과 실행 파일이 작업 시작 전 SHA-256과 4/4 일치했다. [전체 시도](stage17-windows-regression-20261119/fixed-full/result.json) · [복원 지문](stage17-windows-regression-20261119/restored-files.json)

### Windows 전용 식자 worker 실행 인자

42.9.3에 포함된 V8 14.8.178.38은 선택적 페이지 메모리 풀이 켜져 있을 때 풀을 생성한다. 이 풀은 사용하지 않는 메모리를 해제할 지연 작업을 등록한다. 해당 버전의 엔진 실행 파일과 전용 식자 worker 경로가 모두 일치할 때 시작 인자에 `--js-flags=--no-memory-pool`을 전달했다. 다른 worker·버전, 호출자가 V8 인자를 명시한 경우에는 기존 인자를 사용한다. [V8 풀 생성 조건](https://github.com/v8/v8/blob/14.8.178.38/src/init/isolate-group.cc) · [V8 지연 작업](https://github.com/v8/v8/blob/14.8.178.38/src/heap/memory-pool.cc) · [Electron 시작 스위치](https://www.electronjs.org/docs/latest/api/command-line-switches#--js-flagsflags)

같은 실행 파일을 별도 Job에서 기본·수정 인자로 한 번씩 기동했다. 두 실행 모두 Electron 42.9.3, V8 14.8.178.38, 커널 종료 0 및 정리 완료를 기록했다. worker 안에서 읽은 V8 인자가 빈 값에서 `--no-memory-pool`로, V8 코드 캐시 호환성 값이 3180961085에서 3229274917로 바뀌었다. 전용 경로, 호출자 인자 보존과 실패 진단 저장 오류를 포함한 다섯 검사도 통과했다. [실제 worker 내부 관측](stage17-windows-regression-20261119/v8-option.json) · [회귀 RED](stage17-windows-regression-20261119/worker-arguments-red.tap) · [최종 계약 5/5](stage17-windows-regression-20261119/worker-final-green.tap)

수정 뒤 다섯 파일을 함께 실행한 첫 결과는 36/40이었다. 기본 식자와 승인 ROI 식자는 정상 종료 0, 승인 없는 변경은 예상 거부 1이었다. 두 정상 후보의 PNG 바이트가 각각 이전 지문과 일치했고 해당 세 Job의 커널 정리가 모두 확인됐다. 누락 plan은 20:50:31.928 UTC 생성, 20:50:33.008 종료 1, 20:50:33.821 supervisor 종료였다. 잘못된 인자 검사는 supervisor 요청 후 10.64초에 준비됐고 Job 수명 만료와 15초 테스트 취소를 기록했다. 이 한 건은 정리 시한까지 모든 프로세스 종료를 확인할 수 없어 종료 시각을 비워 두었다. 나머지 세 실패의 첫 오류는 모두 합성 번역 서버 준비 제한이었다. [원래 단언을 사용한 40건](stage17-windows-regression-20261119/verified-five/result.json) · [생성과 종료 시각](stage17-windows-regression-20261119/verified-five/joined.json)

잘못된 인자 검사의 원장에는 종료 요청, 코드 87, Job 활성 프로세스 0개와 `kernelCleanupConfirmed=false`가 함께 있다. Windows에서 타 프로세스에 대한 종료 요청은 비동기로 진행되며 실제 종료는 핸들의 신호로 확인한다. 이번 집계에서도 원래의 미확인 정리 판정을 유지했다. [해당 영수증](stage17-windows-regression-20261119/verified-five/invalid-args-receipt.json) · [Windows 종료와 확인 규약](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)

같은 소스의 전체는 1,337/1,340이었다. 누락 plan의 worker는 21:06:07.521 UTC에 생성됐고 `plan_read` 오류를 출력하기 전에 Job 수명이 만료돼 21:06:11.166에 종료 87을 기록했다. 두 정상 bootstrap은 각각 종료 0과 정리 완료를 냈으나 supervisor가 준비되기까지 16.30초와 14.74초가 걸려 원래 15초 테스트가 취소됐다. 직후 누락 plan 단독은 21:07:28.767 생성, 21:07:29.078 종료 1, 21:07:29.179 supervisor 종료였고 예상 `plan_read/ENOENT`가 남았다. 기본 식자 단독도 종료 0으로 통과했다. [전체 10개 Job](stage17-windows-regression-20261119/verified-full/joined.json) · [누락 plan 단독](stage17-windows-regression-20261119/verified-missing/joined.json) · [식자 단독](stage17-windows-regression-20261119/verified-native/joined.json)

합성 번역의 재사용·콜드 재시작·정리 검사를 별도로 계측한 3/3은 통과했다. 자식 4개 모두 내부 요청부터 응답 완료까지 기록했다. 합성 코드·작업 폴더·임시 파일·HTTP 원장을 한꺼번에 C: 또는 E:에 둔 교차 검사에서는 두 볼륨 각각 4/4가 218~261ms 안에 인증 응답과 인증 거부를 반환했다. 실제 회귀에서 간헐적으로 발생한 지연을 이 짧은 검사로 재현하지 못했다. [하위 프로세스 내부 관측](stage17-windows-regression-20261119/provider-phases/children.json) · [볼륨별 원자료](stage17-windows-regression-20261119/volume-probe.json)

실패한 다섯 파일의 합성 서버 2개는 기동 시작 219ms와 221ms 뒤에 각각 인증된 첫 GET을 원장에 쓰기 시작했다. 두 원장에는 그 한 건만 있다. 부모가 응답 헤더를 받지 못한 구간을 이 두 실행에서 서버의 요청 처리 이후까지 좁힐 수 있다. C:는 NVMe/NTFS이고 E:는 USB/exFAT였다. 대조한 시간대의 Windows System 로그에서 확인한 저장장치 재시도·리셋 이벤트는 0건이다. [실패 원장 생성 시각](stage17-windows-regression-20261119/verified-five/provider-diary-times.json) · [디스크와 이벤트 조회 범위](stage17-windows-regression-20261119/storage-events.json)

### 원래 명령과 supervisor 준비 시간

Node 계측기를 제외한 직렬 원래 명령에서도 지연이 발생하는지 검사했다. supervisor 자체의 Windows 생성 시각과 기존 `Add-Type` 호출 전후 시각을 완료 영수증에 추가했다. 이 시각은 호출자가 전달하는 입력과 분리돼 있고, 커널 Job과 시간 제한 판정에는 쓰이지 않는다. 기존 전체 영수증은 이 구간을 0/10건 측정할 수 있었다. [측정 추가 전](stage17-windows-regression-20261119/prepare-red.json)

원래 다섯 파일은 39/40이었다. 실패한 14번은 식자 식별자 누락을 검사하기 전에 합성 번역 서버의 5초 준비 제한에 걸렸다. 이 실행에서 네이티브 worker 열 건은 모두 예상 코드로 종료했다. supervisor 생성부터 컴파일 시작까지 218~6,586ms, 컴파일과 어셈블리 로드를 수행하는 `Add-Type` 호출은 170~10,256ms였다. 이 호출이 끝난 뒤 worker 생성까지는 61~94ms였다. 가장 긴 `Add-Type` 호출은 정상 종료한 식자 Job에서 관측됐다. 누락 plan과 양쪽 bootstrap을 포함해 열 건 모두 영수증과 프로세스 신원을 대조했다. [원래 명령과 TAP](stage17-windows-regression-20261119/plain-five/result.json) · [준비 구간별 실측](stage17-windows-regression-20261119/plain-five/launch-phases.json)

인계 원장과 공통인 소스·테스트 393개 중 기존 V2 검사·fixture 143개의 SHA-256이 모두 같았다. 이번 제품 변경은 식자 worker의 종료 처리, 전용 실행 인자, Windows supervisor 영수증 세 파일이다. supervisor 소스는 이번 조사의 첫 실행에서 측정한 지문도 별도로 대조했다. [변경 전후 소스 지문](stage17-windows-regression-20261119/handoff-source-comparison.json)

| 원래 Node 명령으로 실행한 범위 | 통과 | 실패·취소·건너뜀 | 커널 영수증에서 대조한 worker |
|---|---:|---|---:|
| [다섯 파일](stage17-windows-regression-20261119/plain-five/result.json) | 39/40 | 실패 1, 취소 0, 건너뜀 0 | 10/10 |
| [전체 V2](stage17-windows-regression-20261119/plain-full/result.json) | 1,338/1,340 | 실패 2, 취소 0, 건너뜀 0 | 지정한 다섯 파일의 10/10 |
| [누락 plan 단독](stage17-windows-regression-20261119/plain-missing/result.json) | 1/1 | 모두 0 | 1/1 |
| [기본 네이티브 식자 단독](stage17-windows-regression-20261119/plain-native/result.json) | 1/1 | 모두 0 | 1/1 |

다섯 파일 안에서는 OCR 정제 10/10, 번역 런타임 재사용 17/18, 폰트 기동 3/3, 네이티브 식자 3/3, Electron 진입 6/6이었다. 전체에서는 기본 콜드 실행 146번과 렌더 재시도 147번에서 합성 번역 서버 준비가 만료됐다. 누락 plan의 전체 실행 시각은 supervisor 생성 21:28:05.085, worker 생성 21:28:07.859, worker 종료 21:28:07.925 UTC였다. 단독은 각각 21:29:14.687, 21:29:15.213, 21:29:15.276 UTC였다. 두 원장 모두 예상 `plan_read/ENOENT`, 종료 1, 활성 프로세스 0개, 커널 정리 완료를 확인했다. 기본·승인 ROI 식자의 두 후보 지문과 승인 없는 변경의 거부도 두 묶음에서 일치했다. [전체 구간별 원장](stage17-windows-regression-20261119/plain-full/launch-phases.json) · [단독 원장](stage17-windows-regression-20261119/plain-missing/launch-phases.json) · [검사·지문 종합](stage17-windows-regression-20261119/results.json)

기존 Stage16 메타데이터 전용 검사 9묶음에서 193회가 모두 통과했다. 겹치는 검사 이름을 한 번씩 센 수는 130개다. 실제 보호 파일 18개와 revision 14 서명 결과 영수증의 SHA-256이 기준과 같았고, 기존 Permit 7개의 ID도 일치했다. 원래 실행 전후 제품·테스트 소스 401개의 지문을 대조했다. [Stage16 검증](stage17-windows-regression-20261119/stage16/result.json) · [보호 자료 확인](stage17-windows-regression-20261119/protected-readback.json)

### 합성 번역 서버의 남은 실패

같은 OCR·번역 테스트 두 파일에서 서버 내부를 계측한 실행은 28/28이었다. 부모의 실행과 자식 21개를 PID·fixture로 연결했다. 응답한 서버의 원장 쓰기는 최대 8ms였다. 네트워크 모듈을 사전 로드하지 않고 실패 이력이 있는 다섯 검사를 다시 관측한 실행도 5/5, 자식 6/6으로 대응했다. 이때 한 자식은 JavaScript 진입부터 첫 요청 처리까지 4.058초가 걸렸으며 그 사이 부모는 연결 거부를 받았다. 첫 요청의 원장 쓰기는 4.3ms였고 이어서 인증 응답 200과 거부 401이 도착했다. 앞서 219ms 안에 인증 요청을 기록하고 헤더를 주지 못한 실패와는 지연 위치가 달랐다. [두 파일 관측](stage17-windows-regression-20261119/provider-all/observed.json) · [실패 이력이 있는 다섯 사례](stage17-windows-regression-20261119/provider-journal/observed.json)

동일한 서버 코드를 E:의 새 파일과 고정된 C: 파일에서 각각 6회 실행한 비교는 12/12 통과했다. 가장 긴 1.775초 실행에서도 실제 메인 파일 경로 조회는 1ms 미만이었고, 긴 간격은 측정 도구 준비에 있었다. 원장을 매 요청마다 여는 방식과 핸들을 재사용하는 방식도 6/6씩 통과했다. 같은 E: 원장에 인증·거부 두 요청이 실제로 남았고 정상 쓰기 시간 차이는 수 ms였다. 이 12회에서는 실패 당시의 파일 지연을 관측하지 못했다. [메인 파일 탐색 비교](stage17-windows-regression-20261119/canonical-probe.json) · [원장 쓰기 비교](stage17-windows-regression-20261119/handle-probe.json)

엔진 TypeScript `--noEmit`, 변경한 JavaScript 구문 검사 둘, PowerShell 파싱, 제품 파일의 `git diff --check`가 통과했다. 제품 모델 호출과 사용자 이미지 입력은 0회였다. 메인 Codex가 수정·통합 검증을 맡았고, 기존 번역 로그의 원인 분석에는 하위 에이전트 1개를 사용했다. 역할 설정은 Luna/medium이며 하위 실행 응답의 실제 모델 식별자는 미제공이다. [정적 검사와 명령](stage17-windows-regression-20261119/static-checks.json)

### 요청 원장과 모델 기동의 지연 대조

부모가 받은 오류가 같은 두 실행에서 마지막으로 확인한 동작이 달랐다. 자식의 표준 입출력을 보존하고 첫 파일 열기를 관측한 실행에서 PID 22600은 기동 요청 50ms 뒤에 로컬 진단 파일을 생성했다. 파일은 0바이트였고 25회 연결 거부 후 5초 기동 제한에 걸렸다. 자식 계측을 제거하고 부모 소켓만 관측한 실행에서 PID 6612는 첫 인증 GET을 원장에 썼다. 부모가 서로 다른 세 소켓에서 요청 전송을 마쳤지만 응답 헤더는 0건, 서버 원장은 인증 GET 한 건이었다. 전자는 수신 대기 전, 후자는 첫 요청을 받은 뒤까지 실패 구간을 좁힌다. [첫 기록 전의 실패](stage17-windows-regression-20261119/provider-local/failed-file.json) · [부모 소켓과 자식 원장 대조](stage17-windows-regression-20261119/provider-wire/failure.json)

HTTP를 사용하지 않는 독립 Node 자식 24개에서 파일 열기·쓰기·닫기를 나눠 측정했다. 24개 모두 예상 바이트를 썼다. C: 새 파일 하나는 열기에 10,238.9ms, 쓰기에 0.16ms, 닫기에 0.08ms가 걸렸다. E: 기존 파일의 열기도 두 번 3.57초와 4.12초가 걸렸다. Windows 파일 열기가 실제 5초 한도를 넘을 수 있었다. 특정 드라이버와 기존 실패 건별로 시간을 소비한 시스템 호출은 미확정이다. [24개 자식의 실측](stage17-windows-regression-20261119/file-latency.json)

합성 서버는 인증 응답 전에 테스트 원장 경로를 동기로 열어 요청 내용을 쓰고 닫았다. 이 동작에만 8초 지연을 재현하자 기존 서버는 `LLM_START_TIMEOUT`으로 실패했다. 수정은 테스트 준비 시 원장을 한 번 열고 그 핸들을 해당 합성 자식의 표준 출력으로 전달하는 것이다. 같은 요청 경로·인증 여부·본문·PID를 같은 JSONL에 동기로 쓰고 나서 실제 응답을 보낸다. 수정 후 인증 모델 조회와 인증 거부, 정확한 region ID의 번역 요청 한 건을 확인했다. 서버 수신 대기 자체를 8초 늦춘 대조군에서는 전과 같이 5초 준비 제한에 걸렸고 번역 요청은 0건이었다. 다섯 테스트 파일의 단언, 실제 번역 서버 기동 코드와 시간 제한은 그대로다. [수정 전 1/2](stage17-windows-regression-20261119/journal-control-red.tap) · [수정 후 2/2](stage17-windows-regression-20261119/journal-control-green.tap) · [합성 원장 구현](../../tests/v2/fixtures/owned-engine-runtime.mjs)

이 변경을 적용한 첫 비계측 다섯 파일은 40/40이었다. 정상 식자 두 건은 예상 PNG 지문과 종료 0, 승인 없는 변경은 후보 없이 종료 1이었다. 누락 plan은 supervisor 생성 21:55:44.071, worker 생성 21:55:44.543, 종료 21:55:44.605 UTC였으며 예상 오류와 정리가 모두 남았다. 이어진 전체 실행의 합성 번역 서버 여섯 개는 각각 첫 인증 GET만 남기고 준비 제한에 걸렸다. 이 전체 실행에서 추가 조사가 필요한 구간은 원장의 첫 요청 기록부터 클라이언트의 인증 응답 수신까지다. [다섯 파일](stage17-windows-regression-20261119/journal-five/result.json) · [Job 10개의 시각](stage17-windows-regression-20261119/journal-five/launch-phases.json) · [전체 실행의 실패한 자식 원장](stage17-windows-regression-20261119/journal-full/provider-failures.json)

## 같은 소스의 첫 전체 실행과 단독 비교

전체 120개 파일 1,340건 중 1,333건이 통과했고 실패 7건, 취소·건너뜀은 0건이었다. 가장 먼저 실패한 152번은 실제 TypeScript 번역 모듈을 쓰는 합성 문맥 검사다. 같은 검사는 단독으로 1/1 통과했다. 전체의 156~160번도 합성 서버 준비 단계에서 막혔다. 159번은 번역 요청을 기다리던 외부 단언이 먼저 보이는 사례이며, 해당 자식 원장의 첫 실패는 `llama_load_failed/LLM_START_TIMEOUT`이다. 나머지 한 건은 1329번 정상 Electron 기동 검사다. [전체 TAP 결과](stage17-windows-regression-20261119/journal-full/result.json) · [첫 실패 단독](stage17-windows-regression-20261119/context-single/result.json)

모든 시각은 2026-11-18 UTC다. 각 행에서 supervisor 영수증의 실행 ID, supervisor PID, root PID와 Windows 생성 시각을 controller 기록과 대조했다. 마지막 열의 정리 확인은 커널 Job의 활성 프로세스가 0이었음을 포함한다.

| 사례 | supervisor 생성 | worker 생성 → 종료 | 실제 결과 |
|---|---|---|---|
| [누락 plan, 전체](stage17-windows-regression-20261119/journal-full/launch-phases.json) | 22:11:50.500 | 22:11:50.985 → 22:11:51.055 | 70ms, 예상 `plan_read/ENOENT`, 종료 1, 정리 확인 |
| [누락 plan, 단독](stage17-windows-regression-20261119/journal-missing/launch-phases.json) | 22:12:43.311 | 22:12:51.494 → 22:12:51.553 | 59ms, 같은 오류·종료·정리 확인 |
| [정상 bootstrap, 전체](stage17-windows-regression-20261119/journal-full/bootstrap-observations.json) | 22:11:55.286 | 22:11:57.577 → 22:12:02.102 | 4초 Job 수명 만료, 종료 87, 정리 확인 |
| [정상 bootstrap, 단독](stage17-windows-regression-20261119/bootstrap-single/launch-phases.json) | 22:16:38.482 | 22:16:50.481 → 22:16:54.495 | 4초 Job 수명 만료, 종료 87, 정리 확인. 15초 테스트도 취소 |
| [정상 bootstrap, 재개 출력 계측](stage17-windows-regression-20261119/bootstrap-resume/launch-phases.json) | 22:20:29.201 | 22:20:29.713 → 22:20:31.634 | supervisor 준비 22:20:29.728, 재개 22:20:29.779, 종료 0, 정리 확인 |

전체 1329번은 gate가 생성되고 worker가 재개됐으나 전용 프로필의 첫 하위 폴더와 내부 정상 기동 보고서가 없었다. 바로 다음 OCR-cold 정상 기동은 프로필 다섯 개와 모델 호출 0회의 보고서를 남기고 종료 0이었다. 실패한 단독에서는 supervisor 생성부터 컴파일 시작까지 10,785ms, 컴파일·로드에 1,146ms, 이후 worker 생성까지 68ms였다. 개별 Windows 시스템 호출에서 지연이 시작된 시각은 실패 영수증에 없다. [전체 프로필 생성 시각](stage17-windows-regression-20261119/journal-full/bootstrap-profiles.json) · [단독 15초 취소](stage17-windows-regression-20261119/bootstrap-single/tap.log) · [재개 관측](stage17-windows-regression-20261119/bootstrap-resume/result.json)

같은 번역 테스트 파일에 자식의 요청 수신·원장 쓰기·모델 ID 조회·응답 완료 시각을 추가한 실행은 16/18이었다. 시간 초과한 두 자식은 부모가 미리 연 전용 기록 파일의 첫 관측값도 남기지 못했고, 그사이 부모가 각각 모델 조회를 25회 시도했다. 일부 실행은 첫 요청 전에도 기동 제한에 걸린다. 별도의 모델 ID 오류 대조군은 실제로 다른 모델을 응답해 거부됐다. [자식 21개와 부모 원장](stage17-windows-regression-20261119/provider-response-1/paired.json)

이 네 실행에서 동일 소스 401개의 지문, 원본 TAP·소스 목록 지문과 원래 Node 명령을 대조했다. 합성 원장 fixture의 다섯 줄 변경을 역적용하면 인계 지문 `d612c3d0…ed213`이 재현된다. 기존 테스트 파일의 단언은 모두 일치했다. 네 실행에서 합계 22개 네이티브 Job 영수증과 신원·정리를 확인했다. Stage16은 기존 메타데이터 허용 목록 9묶음 193/193회(중복 제거 130개)였다. 보호 파일 18개, revision 14 서명 결과, 기존 Permit 7개가 기준과 같았다. [같은 소스의 첫 종합 검증](stage17-windows-regression-20261119/journal-results.json) · [구문과 diff 검사](stage17-windows-regression-20261119/fixture-static.log)

### 프로젝트 코드를 제외한 loopback 대조

Node 내장 HTTP만 쓰고 자식에서 파일이나 원장을 열지 않는 서버 20개가 모두 인증된 모델 ID와 인증 없는 요청의 거부를 반환했다. 이 중 4개에서 개별 1.5초 GET이 합계 5회 만료됐다. 해당 프로세스들은 요청 후 46~58ms에 첫 JavaScript 문장에 도달했다. 인증 두 건을 모두 확인하는 데 걸린 시간은 전체 211~3,629ms였다. 같은 서버를 두 클라이언트로 동시에 조회한 별도 대조는 기본 fetch와 내장 HTTP 각각 12/12였고 개별 시간 초과가 없었다. 클라이언트 구현을 바꿀 근거는 확보되지 않았다. [기본 Node 측정](stage17-windows-regression-20261119/minimal-host.json) · [두 클라이언트의 대조](stage17-windows-regression-20261119/minimal-http-comparison.json)

## 최종 재검증

별도의 진단 명령으로 호스트를 조회하지 않는 동안 검증기만 실행했다. 테스트 파일·Node 실행 파일·인자·한도·제품 소스가 앞선 실행과 같았다. 다른 Windows 프로그램의 활동은 통제하지 않았다. 다음 표는 같은 제품·테스트 소스 401개를 사용한 두 실행의 실제 결과다.

| 검증 범위 | 앞선 실행 | 최종 실행 |
|---|---:|---:|
| 지정한 다섯 파일 | 40/40 | [40/40](stage17-windows-regression-20261119/quiet-five/result.json) |
| Stage16 외 전체 V2, 120개 파일 | 1,333/1,340 | [1,340/1,340](stage17-windows-regression-20261119/quiet-full/result.json) |
| 누락 plan 단독 | 1/1 | [1/1](stage17-windows-regression-20261119/quiet-missing/result.json) |
| 기본 식자 단독 | 1/1 | [1/1](stage17-windows-regression-20261119/quiet-native/result.json) |
| Stage16 보호 검사, 9묶음 | 193/193 | [193/193](stage17-windows-regression-20261119/stage16-quiet/result.json) |

최종 다섯 파일은 OCR 10/10, 번역 런타임 18/18, 폰트 3/3, 식자 3/3, Electron 진입 6/6이었다. 전체 실행도 다섯 파일의 같은 40건을 모두 통과했다. 전체의 누락 plan worker는 22:40:50.266에 생성돼 22:40:50.799 UTC에 종료했다. 단독은 22:41:32.726에 생성돼 22:41:32.789 UTC에 종료했다. 두 경우 모두 `plan_read/ENOENT`, 종료 1, 활성 프로세스 0이었다. 전체에서는 worker 생성 전 supervisor의 컴파일·로드만 10.634초였다. [최종 전체 영수증](stage17-windows-regression-20261119/quiet-full/launch-phases.json) · [최종 단독 영수증](stage17-windows-regression-20261119/quiet-missing/launch-phases.json)

기본 식자 worker는 전체에서 22:39:32.527~22:39:44.531 UTC, 단독에서 22:41:35.445~22:41:47.456 UTC에 실행됐다. 두 종료 코드는 0, 실제 후보 지문은 `ce0111bb…2cea3`였다. 승인 ROI 후보는 `2f48756a…c92bb`였으며 승인 없는 ROI 변경은 후보 없이 종료 1이었다. 최종 네 실행의 대상 Job 22건 모두 supervisor와 커널 신원·정리가 일치했다. 보호 파일 18개, revision 14 서명 결과, 기존 Permit ID 7개도 기준과 일치했다. 실제 모델 실행·사용자 이미지 입력은 0건이다. [최종 검증 원장](stage17-windows-regression-20261119/quiet-results.json) · [기본 식자 단독](stage17-windows-regression-20261119/quiet-native/launch-phases.json) · [보호 자료 대조](stage17-windows-regression-20261119/quiet-protected-final.json)
