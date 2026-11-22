# MangoHana V2 Linux 0B 저메모리 실행 계획

## 목표

최근 Windows 가용 메모리가 약 6.2~6.6 GiB로 측정된 현재 PC에서, Windows와 WSL이 실제로 감당할 수 있는 구간을 측정해 창작 원고 한 장을 안전하게 검증한다. 실행 시점의 메모리 여유와 단계별 최고 사용량을 함께 적용한다. 구현할 때는 기존 0B 하네스와 Superpowers의 계획 실행 절차를 사용한다.

이번 개발의 환경 기준은 **현재 PC의 물리 RAM 16GB**다. 모델 추론을 쓰지 않는 OCR·번역 코드 개발과 회귀는 이 환경에서 진행할 수 있다. 계획의 합성 Node 회귀 480건과 격리 PostgreSQL 저장·복구 33건의 통과 기록이 있다. 메모리 조건에 민감한 실제 0B는 위 작업의 검증을 거친다. [합성 회귀](../../validation/linux-0b-runs/preflight/20261120-plan-environment/plan-node-checks.tap) · [0C 시험 결과](./2026-11-20-mangohana-v2-service-improvements.md#0c-격리-postgresql-확인)

## 현재 확인한 상태

- 앱 종료 후 Windows 가용량은 6,638~6,692 MiB였고 WSL은 7,141~7,172 MiB였다. 코드의 착수 기준은 Windows 7,168 MiB와 WSL 6,912 MiB다. 현재 조건에서 먼저 확인할 지점은 Windows 착수 기준이다. [실측 기록](../../validation/2026-11-20-v2-headless-linux-0b.md#재실행-승인-후-착수-확인) · [현재 기준](../../../scripts/v2/linux-0b/launch.py)
- 컨테이너의 RAM 6 GiB는 최대 사용량이다. WSL은 Windows와 물리 메모리를 공유하므로 두 환경의 가용량을 합산하지 않는다. Qwen 가중치 파일의 크기와 전체 캐시 한 벌의 432 MiB는 확인했다. 세션 적재와 토큰 생성의 최고 메모리는 미측정이다. [Docker 자원 제한](https://docs.docker.com/engine/containers/resource_constraints/) · [WSL 메모리 설정](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) · [모델 메모리 근거](../../validation/2026-11-20-v2-headless-linux-0b.md#그래프-입출력과-linux-cpu-연산-확인)
- 호스트는 컨테이너 자원과 Windows 메모리를 수집한다. 현재 모델 실행 도중의 자동 중단은 주로 cgroup OOM·자원 오류에 의존하며, 자식 종료 후 새 호스트 표본을 요구하는 분기는 독립 시험에 있다. 저메모리 경로에서는 전체 파이프라인의 단계 시작과 실행 중에 Windows 여유를 판단한다. [호스트 감시](../../../scripts/v2/linux-0b/launch.py) · [단계 전 검사](../../../scripts/v2/linux-0b/container.mjs)

## 작업 1. 호스트 여유 확인과 중단

**수정 위치**는 `scripts/v2/linux-0b/launch.py`, `container.mjs`, `attempt.mjs`다. Python과 Node의 기존 0B 검사를 확장한다.

- [x] Windows 물리 가용량, 커밋 사용량·한도, 페이지 쓰기 카운터와 WSL `MemAvailable`·스왑, 컨테이너 `memory.current`·`memory.peak`·`memory.stat`·`memory.events`를 한 시계로 연결한다. Windows 조회 자체의 시간도 잰다. 파일 읽기로 생기는 페이지 입력만으로 메모리 부족을 판정하지 않는다. [Windows 카운터 설명](https://learn.microsoft.com/en-us/troubleshoot/windows-server/performance/ram-virtual-memory-pagefile-management) · [Linux cgroup 지표](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- [x] 실행기에서 OCR·Qwen·LaMa와 Chromium 단계 전에 새 표본을 확인한다. 모델 호출을 기록하기 직전에도 다시 확인한다. 이전 자식이 종료된 뒤 시작한 관측이 필요하다. 프로젝트의 실행기에서 Windows 가용 RAM 또는 커밋 여유가 2 GiB 아래로 내려가거나 관측의 유효 시간이 지나면 소유한 컨테이너를 중단한다. 2 GiB는 시험 중 보호 기준이며 착수 기준은 Windows 7,168 MiB·WSL 6,912 MiB다.
- [ ] 종료 판단부터 소유한 컨테이너와 자식이 정리될 때까지 걸린 시간을 잰다. 기존 조회 방식으로 예상 메모리 급락보다 빠르게 중단할 수 없으면, 지연을 낮춘 Windows 조회를 먼저 검증한다. 순간적으로 크게 잡히는 할당은 실행 중 감시만으로 보호할 수 없으므로, 통과한 사전 메모리 확인과 강제 상한을 함께 적용한다.
- [ ] 회귀 검사에서 부족한 메모리·커밋 여유, 오래되거나 순서가 뒤바뀐 표본, 샘플러 응답 유실, 실행 중 급락, 중단 뒤 다음 호출 시도, 정리 실패를 재현한다. `HOST_MEMORY_UNAVAILABLE`, 관측 유실, 실행 중 호스트 메모리 부족, cgroup OOM, 호환성 오류, 비정상 출력을 각각 증거로 남긴다. 이미 기록한 모델 호출은 한 번으로 보존한다.

**통과 조건**은 정상 표본에서만 단계가 열리고 이상 표본에서 추가 호출이 0인 것이다. 소유한 PID와 컨테이너 제거를 확인하고, 중단이 확인되지 않으면 결과 PNG를 최종본으로 게시하지 않는다.

## 작업 2. 현재 PC에서 낮은 시작 기준 산정

- [ ] 기존 0B 이미지에서 가중치 없이 실제 준비 절차를 재현한다. 현재 검증의 CPU 4개·RAM 최대 6 GiB·스왑 0·PID 256을 사용한다. 원고 준비·Chromium·자식 정리 경계를 재사용한다. 합성 자식이 실제 페이지를 건드린 익명 RAM을 점진적으로 늘리는 구간과, 전용 큰 파일을 읽어 파일 캐시가 늘어나는 구간을 각각 측정한다.
- [ ] Windows 6,656 MiB를 첫 후보로 평가한다. 6,400 MiB는 안전 여유를 입증할 수 있을 때만 다음 후보로 평가한다. 현재 WSL 착수 기준 6,912 MiB를 적용한다. 경계 관측이 불안정할 때만 필요한 구간을 한 번 더 확인한다. 후보 숫자는 이 PC에서 확인할 값이다.
- [ ] Windows에서 지키려는 최소 여유를 설계값 **2,048 MiB**로 두고 후보를 평가한다. 시작 시 필요한 가용량의 하한은 **2,048 MiB + 시험에서 확인한 해당 단계의 최대 추가 물리 메모리 + 측정부터 종료까지 필요한 여유**다. 종료 여유는 같은 장비의 가용량 하락폭과 종료 지연을 근거로 정한다. 커밋 여유와 지속적인 페이지 쓰기도 함께 확인한다. 계산된 안전 하한과 후보값 중 큰 값 아래에서는 열지 않는다.
- [ ] 예를 들어 최근 Windows 표본 6,692 MiB에서는 설계상 최소 여유를 빼면 4,644 MiB가 남는다. 여기서 종료 여유도 확보해야 한다. 이 수치는 Windows의 추가 사용량을 평가할 때 쓰는 계산값이다. Qwen 세션과 운영체제의 실제 점유량은 시험 결과로 확정한다.
- [ ] 현재처럼 컨테이너 최대 6 GiB와 낮은 Windows 시작값의 조합에서 순간 할당까지 안전하다는 근거를 못 얻으면, 해당 조합을 보류한다. 실행 환경의 최대 6 GiB는 유지하면서 단계 또는 시험 전용 컨테이너에 더 작은 **강제 상한**을 둘 수 있다. 이 경우 합성 검증은 그 상한으로 다시 수행하고, 실제 모델이 들어가는지도 증명해야 한다.

**통과 조건**은 시험한 범위에서 Windows의 최소 여유를 유지하면서 cgroup OOM·스왑·PID 초과가 모두 0이고, 중단 시험에서도 자식이 모두 정리되는 것이다. 통과한 장비·이미지·런타임·설정 지문에 한해 저메모리 경로를 켠다. 이 범위를 벗어난 측정은 기본 7,168 MiB 경로의 판단을 따른다.

## 작업 3. 모델 시험과 Qwen 최적화 조건

- [ ] 작업 2를 통과한 설정에서 창작 원고 한 장을 실행한다. 기존 단회 제한을 적용해 OCR·Qwen·LaMa를 각 최대 한 번 호출한다. OCR 뒤의 독립 시험도 기존의 미사용 호출 한도를 따른다. 적재·계산·출력·최종 페이지를 각각 판정하고, 원본·모델 지문·PNG 픽셀 검사·자원·정리 증거를 보존한다.
- [ ] Qwen에서 메모리 부족이 나오면 먼저 적재 중인지 토큰 생성 중인지 증거로 구분한다. 적재가 원인이면 기존 가중치와 토크나이저를 사용하는 별도 시험에서 ONNX Runtime의 `session.disable_prepacking=1` 한 가지만 비교 대상으로 삼는다. 계산이 원인이면 프롬프트 처리 묶음을 64에서 16토큰으로 줄이는 방안을 먼저 평가한다. 이론상 프롬프트 한 번의 로짓 공간은 약 37.09에서 9.27 MiB로 줄어든다. 실제 최고 사용량과 속도는 그 시험에서 측정한다. [현재 Qwen 실행](../../../scripts/v2/local_review/context_translation.py) · [ORT 설정 키](https://github.com/microsoft/onnxruntime/blob/main/include/onnxruntime/core/session/onnxruntime_session_options_config_keys.h)
- [ ] 로짓 절감으로 부족하면 1,536에서 1,024로 줄이는 검증 전용 토큰 상한을 검토한다. KV 캐시 한 벌은 이론상 432에서 288 MiB로 줄어든다. 고정 입력과 필요한 생성 길이가 모두 들어가는지 확인한다. 번역 문장·용어·원문 범위를 바꾸는 별도 품질 시험과 구분해 기록한다.
- [ ] 첫 호출 전 여유나 필수 근거가 부족하면 `BLOCKED`로 기록한다. 모델 호출을 배정한 뒤 적재·계산·출력에서 기준을 충족하지 못하면 해당 모델과 전체 파이프라인은 `FAIL`로 남긴다. 모델 설정 변경과 추가 모델 호출은 별도 범위로 승인받는다. 저장된 기록으로 원인을 좁힌 후에만 추가 시도를 검토한다.

**완료 조건**은 현재 PC의 실제 낮은 Windows 가용량에서 합성 자원 검사를 먼저 통과한 뒤, 승인된 한 장에서 모델별 적재·실제 계산·출력과 전체 페이지 및 종료를 확인하는 것이다. 합성 자원 검사는 물리 메모리 운용을 확인한다. 별도의 실제 원고 번역 품질 기준은 기존 품질 계획을 따른다. [품질 개발 계획](./2026-11-20-mangohana-v2-text-coverage-and-translation-quality.md)

## 이번 작성 범위

계획만 작성했다. 기존 승인 기록은 한 장의 이전 실행 조건과 함께 보존한다. 새로운 저메모리 기준으로 실제 호출하는 범위는 위 합성 자원 검증을 마친 뒤 확정한다.

## 2026-11-20 재개 결과

Ubuntu 24.04 WSL2, Docker Engine 29.10.0과 cgroup v2, 고정 Linux 이미지를 확인했다. 필요한 로컬 입력 경로가 모두 있었고 창작 한 장의 재승인 참조는 미사용이었다. WSL 기동 후 Windows 가용 RAM 5,930~5,972 MiB, WSL 가용 RAM 7,164~7,165 MiB를 관측했다. 메모리를 충분히 확보했다는 판정에는 Ubuntu가 켜진 동안의 양쪽 표본을 사용한다. [호스트와 기존 자산 확인](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/host-readiness.json)

고정 이미지에서 가중치 없이 CPU 4개·RAM 2 GiB·스왑 0·PID 256으로 자원 시험을 했다. 컨테이너 유휴 상태에서 익명 메모리 1,024 MiB와 파일 캐시 512 MiB를 더한 뒤 cgroup 최고치 1,575 MiB와 Windows 가용량 5,658→4,169 MiB를 기록했다. Windows 조회 시간은 부하 중 680~700ms였다. 소유한 컨테이너 종료·제거와 자식 정리는 140ms, OOM·스왑·남은 PID는 0건이었다. Windows 가용량은 종료 직후 4,164 MiB였으며, WSL이 중지된 뒤 7,130~7,158 MiB였다. 이 시험은 작게 제한한 합성 부하의 자원·종료 증거다. 실제 6 GiB 경로의 안전한 시작값과 Qwen의 요구 메모리는 미확인이다. [cgroup·Windows 표본](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/d0c93bfc-fef5-4a97-ae8c-6bc503b21d58/samples.jsonl) · [종료 영수증](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/d0c93bfc-fef5-4a97-ae8c-6bc503b21d58/result.json)

Windows 커밋 부족과 호스트 압박 중단, Qwen 토큰 검사 후 호출 예약 전 차단을 실패로 재현한 뒤 고쳤다. 독립 코드 검토에서 착수 판정이 요약 표지와 실제 수치가 함께 바뀌었다는 가정에 의존하는 경우를 찾아, Windows·WSL 원 표본으로 재판정하도록 수정했다. 최종 Ubuntu Python 16/16, Node 18/18, Chromium을 호출하는 실행기 문법 검사가 통과했다. Docker에서 남은 0B·프로브 컨테이너 0개와 모델 호출 0회를 확인했다. [최종 회귀](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/verification.json)

현재 측정은 6,656 MiB와 6,400 MiB 두 후보에 미달한다. 기존 7,168 MiB 착수 기준을 적용한다. 작업 2의 낮은 착수값은 안전한 추가 메모리 상한과 정리 여유를 확인해 정하고, 실제 실행 범위는 그 결과에 맞춰 승인받는다.

### 복사 전 착수 판정과 Windows 조회 개선

WSL을 켠 뒤 Windows 가용량 5,942~5,965 MiB를 확인했다. 실행기에 복사 전 자원 확인을 추가했다. 메모리가 부족하면 실제 실행과 사전 검사 모두 입력 복사·임시 작업 경로·컨테이너 생성 전에 판정을 기록한다. Ubuntu에서 새 사전 검사로 Windows 6,013 MiB, WSL 7,137 MiB를 기록했고 `HOST_MEMORY_UNAVAILABLE`, 종료 코드 2, 작업 경로·컨테이너·승인 청구·모델 호출 0건을 확인했다. 기존 복사 후·첫 호출 전 조건도 적용한다. [호스트 표본과 실제 시작 판정](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/admission-and-observer.json) · [검사 영수증](../../validation/linux-0b-runs/preflight/83f80a63-69c2-4513-a889-842c4d9f1254/startup-check.json)

WSL을 거쳐 온 Windows 관측 시간을 비교한 뒤 가용 RAM·커밋·페이지 누적 카운터를 한 번의 원시 카운터 조회에서 가져오도록 바꿨다. 프리웜 뒤 3표본 중앙값이 670ms에서 310ms로 줄었다. 두 방식의 가용 RAM은 순차 관측에서 4~8 MiB 차이가 났고 커밋 한도는 일치했다. 상주 샘플러는 추가하지 않고 조회 주기를 4초에서 2초로 조정했다. 연속 카운터 두 개가 있을 때만 초당 페이지 수를 계산하고 동일한 표본이 다시 도착하면 관측 유실로 판단한다. 첫 조회나 호스트 부하가 갑자기 늘 때의 최대 대응 시간은 아직 보장할 수 없다. Ubuntu Python과 Node 각 18/18이 통과했다. [조회 비교와 회귀](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/admission-and-observer.json) · [Microsoft 원시 카운터 정의](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-perfrawdata)

현재 Codex에 속한 `ChatGPT.exe` 프로세스 묶음과 별도 Telegram은 실행 경로로 구분했다. 관측한 Telegram 전용 작업 집합은 약 633 MiB였다. 해당 구간에서 Windows 기준까지 부족한 양은 1,155 MiB였고 앱 종료 후 실제 회수량은 미측정이다. [메모리 관측](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/admission-and-observer.json)

### CPU·GPU 경로의 환경 확인

WSL은 RTX 4060 Laptop GPU를 인식했고 당시 가용 VRAM은 7,029 MiB였다. Docker의 NVIDIA 런타임·장치 등록은 발견되지 않았고 기존 wheel 묶음에는 CPU용 ONNX Runtime만 있었다. 지문이 일치하는 Qwen 그래프 454,851바이트에서 `GroupQueryAttention` 36개 모두 FP32 캐시를 직접 받는 것을 확인했다. 고정 ONNX Runtime 1.23.2의 CUDA 커널은 이 연산에 FP16과 BF16만 등록한다. 따라서 GPU를 연결하기만 해서는 동일 그래프를 CUDA 전용으로 실행할 수 없다. CPU와 CUDA에 연산을 나누는 경로의 복사 비용과 메모리·출력 재현은 실측이 필요하다. 이번 조회는 가중치 파일·세션·모델 호출 0회이며 Linux CPU 0B의 판정은 계속 보류다. [장치와 고정 그래프 검사](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/gpu-compatibility.json) · [NVIDIA의 WSL 컨테이너 안내](https://docs.nvidia.com/cuda/wsl-user-guide/index.html#nvidia-compute-software-support-on-wsl) · [고정 버전 CUDA 커널](https://github.com/microsoft/onnxruntime/blob/v1.23.2/onnxruntime/contrib_ops/cuda/bert/group_query_attention.cc#L16-L32)

### 3 GiB 합성 부하와 WSL 기동 상태의 회수 시간

Windows 가용 RAM 6,051 MiB와 WSL 가용 RAM 7,167 MiB에서 고정 이미지로 3 GiB 합성 시험을 시작했다. 익명 메모리 2,048 MiB와 파일 768 MiB를 추가했다. cgroup 최고치 2,865 MiB, 부하 중 Windows 가용량 최저 3,204 MiB를 관측했다. 종료·제거와 자식 정리는 200ms였다. OOM·스왑·남은 PID와 모델 호출은 0건이었다. [실행 전 표본](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/cdc6ded4-98ab-4b2a-8c95-6bf820c82d83/start.json) · [부하 표본](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/cdc6ded4-98ab-4b2a-8c95-6bf820c82d83/samples.jsonl) · [종료 영수증](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/cdc6ded4-98ab-4b2a-8c95-6bf820c82d83/result.json)

컨테이너 종료 직후 Windows 가용량은 3,199 MiB였다. 같은 WSL 세션에서 약 4초 뒤 3,971 MiB, 약 12초 뒤 5,428 MiB, 약 24초 뒤 5,984 MiB로 돌아왔다. 유효한 관측이 계속 도착하는 경우 단계 사이에 최대 30초간 회복을 기다리게 했다. 12초를 초과한 표본은 사용할 수 없고, 관측 유실의 대기 한도는 12초다. 가용 RAM 또는 커밋 압박은 즉시 중단한다. 시작 기준을 넘은 새 표본이 도착해야 다음 단계에 진입한다. Node 19/19와 Ubuntu Python 18/18, 남은 시험 컨테이너 0개를 확인했다. [WSL 기동 상태의 연속 표본](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/cdc6ded4-98ab-4b2a-8c95-6bf820c82d83/recovery.jsonl) · [회귀 결과](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/stage-recovery-verification.json)

4 GiB 합성 시험의 시작 조건은 보호 여유 2,048 MiB, 컨테이너 상한 4,096 MiB와 중단 여유 512 MiB를 더한 Windows 6,656 MiB다. 실제 사전 확인은 6,001 MiB여서 할당과 컨테이너 생성 전에 정지했다. 별도 Telegram의 작업 집합은 약 805 MiB였고 정상 종료 뒤 회수량은 미측정이다. [4 GiB 시작 표본](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/7eb6802f-bb6f-45c5-a695-ca8fe1e46028/start.json) · [차단 영수증](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/7eb6802f-bb6f-45c5-a695-ca8fe1e46028/result.json)

고정 Qwen 외부 파일의 합계는 약 3.69 GiB다. 그중 약 1.45 GiB의 FP32 테이블은 `Gather`와 `Transpose`가 함께 참조한다. 고정 CPU 런타임은 외부 텐서의 파일 매핑을 우선 시도한다. 실제로 RAM에 올라가는 범위에는 접근한 파일 페이지, 세션 초기화 버퍼 및 KV 캐시가 영향을 준다. 3 GiB와 4 GiB 중 어느 쪽에서 고정 모델을 실행할 수 있는지는 미확인이다. 이 확인에는 그래프 외의 가중치를 열거나 세션을 만들지 않았다. [그래프 지문과 참조 크기](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/qwen-cpu-memory.json) · [고정 런타임의 CPU 외부 텐서 처리](https://github.com/microsoft/onnxruntime/blob/v1.23.2/onnxruntime/core/framework/session_state_utils.cc#L90-L110)

21:04 KST에 Windows 가용량 5,958 MiB와 WSL 가용량 7,137 MiB를 확인했다. 4 GiB 합성 시험 기준에는 698 MiB, 기존 한 장 착수 기준에는 1,210 MiB 부족했다. Telegram은 실행 중이었고 0B·합성 시험 컨테이너는 모두 0개였다. 실제 모델 호출과 승인 청구도 0회다. 환경의 가용 메모리가 기준을 충족해야 다음 시험을 시작할 수 있다. [현재 표본과 이전 판정](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/blocked-environment-audit.json)

### Telegram 종료 후 4 GiB 시험

Telegram의 정상 종료를 확인했다. 첫 표본에서 Windows 가용량이 6,653 MiB여서 4 GiB 합성 시험은 착수 전에 멈췄다. WSL을 켠 상태에서 한 차례 더 확인한 결과 Windows 6,688 MiB와 WSL 7,166 MiB에서 착수했다. 최고 cgroup 사용량 2,070 MiB를 남긴 뒤, 다음 할당에 대비한 Windows 여유 검사에서 중단됐다. 마지막으로 기록된 Windows 가용량은 4,493 MiB였다. 이 표본에서 보호 여유 2,048 MiB, 남은 컨테이너 상한 약 2,026 MiB와 중단 여유 512 MiB를 더하면 약 4,586 MiB가 필요했다. 중단을 결정한 다음 표본의 개별 수치는 이번 기록에 없다. [첫 확인](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/9248061e-8b4f-4b96-91ff-252b3bba41e0/start.json) · [실행 중 관측](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/d76b5534-6415-4149-a7b9-03598849decf/samples.jsonl)

정리 150ms, 컨테이너 제거, 잔류 PID 0개를 확인했다. OOM·스왑·모델 호출은 각각 0이었다. 종료 후 Windows 가용량은 약 12초에 6,496 MiB, 약 24초에 6,413 MiB였다. 4 GiB 합성 부하의 전 구간과 실제 Qwen 적재는 미검증이다. 기존 한 장 실행의 승인 청구는 0회다. [중단·정리 기록](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/d76b5534-6415-4149-a7b9-03598849decf/result.json) · [종료 후 표본](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/d76b5534-6415-4149-a7b9-03598849decf/recovery.jsonl)

### 합성 시험의 단계별 대기와 착수 재확인

다음 부하를 허용할 여유만 일시적으로 부족하면 기존 부하를 유지하고 최대 12초 안에 새 Windows 표본을 받도록 합성 시험기를 보완했다. 새 표본의 RAM·커밋 여유와 cgroup 제한을 확인해야 할당을 허용한다. 호스트 압박, 스왑, cgroup 한도 오류, 중복 표본은 중단 처리한다. 대기·허용·중단 결정과 관측치를 `admission.jsonl`에 남긴다. 회복, 압박, 중복 표본, 지속 부족 네 가지 모의 검사가 통과했다. [검사 영수증](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/phase-admission-recheck.json)

Telegram 종료 뒤 이어서 본 WSL 기동 상태의 Windows 가용 RAM은 6,542 MiB와 6,541 MiB였다. 22:52 KST 착수 확인에서는 Windows 5,496 MiB, WSL 7,134 MiB였다. 4 GiB 합성 시험의 Windows 기준 6,656 MiB에 1,160 MiB 부족해 컨테이너 생성과 할당 전에 멈췄다. 모델 호출과 한 장 실행 승인 청구는 각 0회다. [호스트 원본 표본과 착수 판정](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/phase-admission-recheck.json)

22:58~23:00 KST에 Ubuntu가 꺼졌을 때와 켜졌을 때를 구분해 재측정했다. Windows 가용 RAM은 Ubuntu를 켜기 전에 7,359 MiB, 켠 직후 착수 확인에서 5,728 MiB였다. 추가 부하 없이 다시 본 세 표본은 5,851·5,909·5,912 MiB였다. 마지막 값은 4 GiB 합성 시험의 시작값에 744 MiB 부족했고, WSL 가용량 7,163 MiB는 기준을 충족했다. 확인 범위에서 Windows에 정리할 검증 프로세스는 0개였다. 새 컨테이너는 생성하지 않았으며, 실제 모델 호출과 승인 청구는 0회다. [기동 전후 연속 표본](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/phase-admission-recheck.json)

23:03 KST 재확인에서도 Ubuntu 가동 중 Windows 가용 RAM은 5,755~5,763 MiB였다. 마지막 표본에서 4 GiB 합성 시험 착수 기준에 893 MiB 부족했다. 같은 시점의 WSL 가용량은 7,171 MiB였다. 세 차례 모두 컨테이너 생성 전 차단됐고, 이미 진행 중인 검증 컨테이너와 승인 청구 기록은 0개였다. 현재 계획은 Windows 메모리 확보를 기다린다. [재확인 원본 표본](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/phase-admission-recheck.json)

### 2026-11-21 Chrome 종료 후 4 GiB 합성 시험 통과

Chrome 프로세스가 모두 종료된 뒤 Ubuntu 가동 상태에서 처음 본 Windows 가용 RAM은 6,380~6,386 MiB였다. 같은 WSL 세션을 약 245초 동안 유휴 상태로 유지해 착수 전 표본에서 Windows 6,988 MiB와 WSL 7,169 MiB를 확인했다. Windows 가용량이 올라간 두 표본의 Linux `Cached` 값은 같았으므로 회복 원인은 미확정이다. [유휴 상태의 표본](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/20261121-chrome-exit-recheck.json) · [WSL 기본 메모리 회수 설정](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#experimental-settings)

00:31 KST의 실제 착수값은 Windows 6,975 MiB와 WSL 7,162 MiB였다. 고정 이미지에서 CPU 4개·RAM 상한 4 GiB·스왑 0·PID 256을 확인했다. 익명 메모리 3,072 MiB와 파일 캐시 768 MiB를 포함해 8개 구간이 통과했다. cgroup 최고 3,891 MiB, 부하 중 Windows 가용량 최저 3,130 MiB, Windows 커밋 여유 최저 8,324 MiB였다. OOM·스왑·PID 초과는 모두 0이었고 컨테이너와 자식은 220ms에 정리했다. [착수](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/8b651c5a-4b5c-465d-847e-9cf944f16459/start.json) · [단계 허용](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/8b651c5a-4b5c-465d-847e-9cf944f16459/admission.jsonl) · [부하 표본](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/8b651c5a-4b5c-465d-847e-9cf944f16459/samples.jsonl) · [종료 영수증](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/8b651c5a-4b5c-465d-847e-9cf944f16459/result.json)

종료 약 24초 뒤 Windows 가용 RAM은 6,915 MiB였다. 이후 기존 6 GiB 한 장 경로를 위해 다시 확인한 마지막 값은 Windows 6,945 MiB와 WSL 7,151 MiB였다. Windows가 기존 기준 7,168 MiB에 223 MiB 부족해 착수하지 않았다. 금번 통과 범위는 6,975 MiB에서 시작한 4 GiB 합성 부하다. 고정 모델의 실제 메모리와 낮은 시작값에서의 완주 여부는 미측정이며 OCR·Qwen·LaMa 호출과 승인 청구는 모두 0회다. [회복 표본](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/8b651c5a-4b5c-465d-847e-9cf944f16459/recovery.jsonl) · [기존 한 장 착수 확인](../../validation/linux-0b-runs/preflight/20261120-low-memory-resumption/20261121-chrome-exit-recheck.json)
