"""Run one explicitly approved Linux 0B attempt using only local, staged inputs."""

import argparse
from base64 import b64encode
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from uuid import uuid4

from inputs import IMAGE, REPO, WHEEL, digest_file, read_json, stage_inputs


LABEL = "io.mangohana.validation=linux-0b"
MEMORY = 6 * 1024 ** 3
WINDOWS_RUNTIME_RESERVE_MIB = 2048
WINDOWS_SAMPLE_INTERVAL_SECONDS = 2.0
CATALOG = REPO / "docs/validation/linux-0b-runs"
CGROUP = Path("/sys/fs/cgroup")
DOCKER = ["/usr/bin/docker", "--host=unix:///var/run/docker.sock"]
POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
WINDOWS_QUERY = (
    "$ErrorActionPreference='Stop'; "
    "$memory=Get-CimInstance -ClassName Win32_PerfRawData_PerfOS_Memory "
    "-Property AvailableBytes,CommittedBytes,CommitLimit,PagesInputPersec,PagesOutputPersec,Timestamp_PerfTime,Frequency_PerfTime; "
    "[pscustomobject]@{windowsAvailableMiB=[int64][math]::Floor($memory.AvailableBytes/1MB);"
    "windowsCommitUsedBytes=$memory.CommittedBytes;windowsCommitLimitBytes=$memory.CommitLimit;"
    "windowsPagesInputTotal=$memory.PagesInputPersec;windowsPagesOutputTotal=$memory.PagesOutputPersec;"
    "windowsCounterTicks=$memory.Timestamp_PerfTime;windowsCounterFrequency=$memory.Frequency_PerfTime} | ConvertTo-Json -Compress"
)
WINDOWS_PAGE_COUNTERS = (("windowsPagesInputTotal", "windowsPagesInputPerSec"),
                         ("windowsPagesOutputTotal", "windowsPagesOutputPerSec"))


def write_json(target, value, mode="x"):
    with target.open(mode, encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def local_command(command, timeout=15):
    result = subprocess.run(command, capture_output=True, check=True, timeout=timeout,
                            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C", "WSL_INTEROP": os.environ.get("WSL_INTEROP", "")})
    return result.stdout.decode("utf-8-sig").strip()


def docker(*args, timeout=15):
    return local_command([*DOCKER, *args], timeout)


def inspect_state(container):
    state = json.loads(docker("inspect", "-f", "{{json .State}}", container))
    return {name: state.get(name) for name in ("Status", "Running", "Pid", "ExitCode", "OOMKilled", "StartedAt", "FinishedAt")}


def fields(path):
    return {key.rstrip(":"): int(value) for line in path.read_text(encoding="ascii").splitlines()
            if (parts := line.split()) and len(parts) >= 2 for key, value in [parts[:2]]}


def integer(path):
    return int(path.read_text(encoding="ascii"))


def boot_milliseconds():
    # Comparable to the container's reading after checking the boot clock offset.
    return round(float(Path("/proc/uptime").read_text(encoding="ascii").split()[0]) * 1000)


def boot_clock_offset():
    for line in Path("/proc/self/timens_offsets").read_text(encoding="ascii").splitlines():
        fields = line.split()
        if len(fields) == 3 and fields[0] == "boottime":
            return fields[1:]
    raise ValueError("boot clock offset unavailable")


def windows_sample():
    try:
        started = time.time_ns() // 1_000_000
        started_boot = boot_milliseconds()
        result = json.loads(local_command([POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUERY], 8))
        if not isinstance(result, dict):
            return {}
        completed_boot = boot_milliseconds()
        return {**result, "windowsQueryStartedAtMs": started, "windowsSampledAtMs": time.time_ns() // 1_000_000,
                "windowsQueryStartedBootMs": started_boot, "windowsSampledBootMs": completed_boot,
                "windowsQueryDurationMs": completed_boot - started_boot}
    except (OSError, subprocess.SubprocessError, ValueError):
        return {}


def host_reading_is_fresh(host, not_before, now):
    started = host.get("windowsQueryStartedBootMs", -1)
    completed = host.get("windowsSampledBootMs", -1)
    sampled = host.get("sampledAtBootMs", -1)
    return (all(type(value) is int for value in (not_before, started, completed, sampled, now))
            and not_before <= started <= completed <= sampled <= now and now - started <= 12_000)


def raw_windows_counters_valid(sample):
    ticks, frequency = sample.get("windowsCounterTicks"), sample.get("windowsCounterFrequency")
    return (type(ticks) is int and ticks > 0 and type(frequency) is int and frequency > 0
            and all(type(sample.get(total)) is int and sample[total] >= 0 for total, _ in WINDOWS_PAGE_COUNTERS))


def windows_with_page_rates(sample, previous):
    if "windowsCounterTicks" not in sample:
        return sample
    if not raw_windows_counters_valid(sample):
        return {}
    rates = {rate: None for _, rate in WINDOWS_PAGE_COUNTERS}
    if raw_windows_counters_valid(previous):
        ticks = sample["windowsCounterTicks"] - previous["windowsCounterTicks"]
        frequency = sample["windowsCounterFrequency"]
        if ticks <= 0 or frequency != previous["windowsCounterFrequency"]:
            return {}
        for total, rate in WINDOWS_PAGE_COUNTERS:
            delta = sample[total] - previous[total]
            if delta >= 0:
                rates[rate] = delta * frequency // ticks
    return {**sample, **rates}


def host_runtime_issue(host):
    available = host.get("windowsAvailableMiB")
    commit_used = host.get("windowsCommitUsedBytes")
    commit_limit = host.get("windowsCommitLimitBytes")
    pages_output = host.get("windowsPagesOutputPerSec")
    pages_known = (raw_windows_counters_valid(host) if "windowsCounterTicks" in host
                   else type(pages_output) is int and pages_output >= 0)
    if (not host_reading_is_fresh(host, 0, host.get("sampledAtBootMs"))
            or not all(type(value) is int and value >= 0 for value in (available, commit_used, commit_limit))
            or commit_limit == 0 or not pages_known):
        return "HOST_SAMPLE_UNAVAILABLE"
    if available < WINDOWS_RUNTIME_RESERVE_MIB:
        return "HOST_MEMORY_PRESSURE"
    if commit_limit - commit_used < WINDOWS_RUNTIME_RESERVE_MIB * 1024 ** 2:
        return "HOST_COMMIT_PRESSURE"
    return None


def host_start_issue(host):
    issue = host_runtime_issue(host)
    if issue:
        return issue
    wsl_available = host.get("wslAvailableMiB")
    if type(wsl_available) is not int or wsl_available < 0:
        return "HOST_SAMPLE_UNAVAILABLE"
    if host["windowsAvailableMiB"] < 7168 or wsl_available < 6912:
        return "HOST_MEMORY_UNAVAILABLE"
    return None


def host_sample(windows):
    available = fields(Path("/proc/meminfo"))
    vmstat = fields(Path("/proc/vmstat"))
    now = int(time.time() * 1000)
    measured = {
        "wslAvailableMiB": available["MemAvailable"] // 1024,
        "wslSwapUsedKiB": available["SwapTotal"] - available["SwapFree"],
        "wslSwapInPages": vmstat["pswpin"], "wslSwapOutPages": vmstat["pswpout"],
        **windows,
        "sampledAtBootMs": boot_milliseconds(),
    }
    windows_time = windows.get("windowsSampledAtMs")
    measured["sampledAtMs"] = min(now, windows_time) if type(windows_time) is int else 0
    measured["runtimeIssue"] = host_runtime_issue(measured)
    measured["ready"] = host_start_issue(measured) is None
    return measured


def group_for(pid, container):
    entry = next(line[3:] for line in Path(f"/proc/{pid}/cgroup").read_text().splitlines() if line.startswith("0::"))
    target = (CGROUP / entry.lstrip("/")).resolve()
    if not target.is_relative_to(CGROUP) or target.name not in {container, f"docker-{container}.scope"}:
        raise ValueError("unexpected container cgroup")
    return target


def pid_start(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def sample_group(group, seen, *, memory_limit=MEMORY):
    pids = [int(pid) for pid in (group / "cgroup.procs").read_text().split()]
    for pid in pids:
        start = pid_start(pid)
        if start is not None:
            seen.add((pid, start))
    memory = fields(group / "memory.stat")
    sample = {
        "atMs": int(time.time() * 1000), "monotonicNs": str(time.monotonic_ns()),
        "sampledAtBootMs": boot_milliseconds(),
        "memoryCurrent": integer(group / "memory.current"), "memoryPeak": integer(group / "memory.peak"),
        "memoryMax": integer(group / "memory.max"), "memorySwapMax": integer(group / "memory.swap.max"),
        "memorySwapCurrent": integer(group / "memory.swap.current"), "memoryEvents": fields(group / "memory.events"),
        "memoryStat": {name: memory[name] for name in ("anon", "file", "shmem")},
        "cpuMax": (group / "cpu.max").read_text().strip(), "cpuStat": fields(group / "cpu.stat"),
        "pidsCurrent": integer(group / "pids.current"), "pidsMax": integer(group / "pids.max"),
        "pidsEvents": fields(group / "pids.events"), "pids": pids,
    }
    if (sample["cpuMax"], sample["memoryMax"], sample["memorySwapMax"], sample["pidsMax"]) != ("400000 100000", memory_limit, 0, 256):
        raise ValueError("actual cgroup limits are different")
    return sample


def stop_requested(_signo, _frame):
    raise KeyboardInterrupt


def startup_decision(ready_at, host, now, deadline):
    if ready_at is None:
        return "PREFLIGHT_TIMEOUT" if now >= deadline else "WAIT"
    issue = host_start_issue(host) if host_reading_is_fresh(host, ready_at, now) else "HOST_SAMPLE_UNAVAILABLE"
    if now >= deadline:
        return issue or "PREFLIGHT_TIMEOUT"
    return "WAIT" if issue else "OPEN"


def supervise(container, scratch, record, job_id, approval_ref, seen, life, deadline):
    control = scratch / "control"
    models = scratch / "work/evidence"
    ready_at = None
    windows = {}
    last_query = -10.0
    oom_at = None
    with ThreadPoolExecutor(max_workers=1) as monitor:
        reading = None
        while True:
            now = time.monotonic()
            state = inspect_state(container)
            life["docker"] = state
            if not state["Running"]:
                break
            if reading is not None and reading.done():
                windows = windows_with_page_rates(reading.result(), windows)
                reading = None
            if reading is None and now - last_query >= WINDOWS_SAMPLE_INTERVAL_SECONDS:
                reading = monitor.submit(windows_sample)
                last_query = now
            host = host_sample(windows)
            write_json(record / "host.jsonl", host, "a")
            write_json(control / "host-next.json", host)
            (control / "host-next.json").replace(control / "host.json")
            group = life.get("group")
            try:
                if group is None:
                    group = life["group"] = group_for(state["Pid"], container)
                sample = sample_group(group, seen)
            except (FileNotFoundError, ProcessLookupError):
                if not inspect_state(container)["Running"]:
                    continue
                raise
            write_json(record / "resources.jsonl", sample, "a")
            life["samples"] += 1
            life["peak"] = max(life["peak"], sample["memoryPeak"])
            if sample["memoryEvents"]["oom"] or sample["memoryEvents"]["oom_kill"]:
                life["reason"] = "CGROUP_OOM"
                oom_at = oom_at or now
                if not life["released"] or now - oom_at >= 6:
                    break
            if sample["memorySwapCurrent"] or sample["pidsEvents"]["max"]:
                life["reason"] = life["reason"] or "RESOURCE_LIMIT_EVIDENCE_FAILED"
                break
            if life["released"] and host["runtimeIssue"]:
                life["reason"] = life["reason"] or host["runtimeIssue"]
                life["stopRequestedAtBootMs"] = boot_milliseconds()
                # Stop the owned container before waiting for an in-flight Windows query.
                docker("stop", "--time=6", container, timeout=14)
                break
            ready = models / "ready.json"
            if ready_at is None and ready.is_file():
                ready_at = boot_milliseconds()
            if not life["released"] and not life.get("startupGate"):
                decision = startup_decision(ready_at, host, boot_milliseconds(), deadline)
                if decision not in ("WAIT", "OPEN"):
                    life["reason"] = decision
                    break
            else:
                decision = "WAIT"
            if decision == "OPEN":
                # An exclusive claim across runs survives a crash at the dispatch boundary.
                source = read_json(ready)
                if source["jobId"] != job_id:
                    raise ValueError("job identity changed before release")
                life["startupGate"] = {**host, "readyObservedBootMs": ready_at}
                write_json(record / "startup-gate.json", life["startupGate"])
                permit = {"jobId": job_id, "gate": life["startupGate"]}
                if approval_ref is None:
                    write_json(control / "checked-next.json", permit)
                    (control / "checked-next.json").rename(control / "checked.json")
                    continue
                claims = CATALOG / "claims"
                claims.mkdir(exist_ok=True)
                if claims.resolve() != claims:
                    raise ValueError("unexpected claim location")
                claim_key = hashlib.sha256(approval_ref.encode()).hexdigest()
                try:
                    write_json(claims / (claim_key + ".json"), {"jobId": job_id, "approval": approval_ref,
                                                                    "fixture": source["fixture"], "run": job_id})
                except FileExistsError:
                    life["reason"] = "APPROVAL_ALREADY_USED"
                    break
                write_json(control / "release-next.json", permit)
                (control / "release-next.json").rename(control / "release.json")
                life["released"] = True
                life["releaseAt"] = time.monotonic()
            if life["released"] and now >= life["releaseAt"] + 25 * 60:
                life["reason"] = life["reason"] or "ATTEMPT_TIMEOUT"
                break
            if approval_ref is None and life.get("startupGate") and boot_milliseconds() >= deadline + 12_000:
                life["reason"] = "STARTUP_ACK_TIMEOUT"
                break
            time.sleep(0.75)


def cleanup(container, life, seen):
    state = inspect_state(container)
    if state["Running"]:
        docker("stop", "--time=6", container, timeout=14)
    state = life["docker"] = inspect_state(container)
    if state["Running"]:
        return False, None, sorted(pid for pid, _ in seen)
    group = life.get("group")
    populated = None
    if group is not None:
        try:
            populated = fields(group / "cgroup.events")["populated"]
        except FileNotFoundError:
            populated = 0
    survivors = sorted(pid for pid, start in seen if pid_start(pid) == start)
    docker("rm", container)
    return True, populated, survivors


def archive_work(work, record):
    if any(item.is_symlink() for item in work.rglob("*")):
        raise ValueError("unexpected evidence symlink")
    shutil.copytree(work, record / "work")


def verify_candidate(work, worker, dispatches, job_id):
    expected = ("ocr", "mask", "qwen", "lama", "render")
    stages = worker["stages"]
    if tuple((item["stage"], item["mode"], item["status"]) for item in stages) != tuple(
        (stage, "pipeline", "PASS") for stage in expected
    ):
        raise ValueError("pipeline stage evidence is incomplete")
    models = worker["models"]
    if set(models) != {"rtdetr", "ppocrv4", "baberu", "qwen", "lama"} or any(
        model[phase]["status"] != "PASS" for model in models.values() for phase in ("load", "compute", "output")
    ):
        raise ValueError("model evidence is incomplete")
    ready = read_json(work / "ready.json")
    if worker["jobId"] != job_id or ready["jobId"] != job_id:
        raise ValueError("pipeline job identity differs")
    inputs = {"originalSha256": "original.png", "normalizedSha256": "normalized.png",
              "standaloneMaskSha256": "standalone-mask.png"}
    if any(digest_file(work / name) != ready["fixture"][key] for key, name in inputs.items()):
        raise ValueError("fixture fingerprint differs")
    lama_input = {name: b64encode((work / file).read_bytes()).decode("ascii") for name, file in (
        ("image", "normalized.png"), ("mask", "pipeline-mask.png"),
    )}
    lama_bytes = json.dumps(lama_input, separators=(",", ":")).encode("ascii") + b"\n"
    hashes = {
        "ocr": digest_file(work / "ocr-request.json"),
        "qwen": digest_file(work / "qwen-pipeline-request.json"),
        "lama": hashlib.sha256(lama_bytes).hexdigest(),
    }
    for item in stages:
        stage = item["stage"]
        if stage in hashes:
            dispatch = dispatches[stage]
            if dispatch != {"jobId": job_id, "mode": "pipeline", "stage": stage, "inputSha256": hashes[stage]} \
                    or item["requestSha256"] != hashes[stage]:
                raise ValueError("wire request identity differs")
    pending = work / "candidate.pending.png"
    proof = read_json(work / "typesetting.json")
    if digest_file(pending) != proof["candidateSha256"] or stages[-1]["candidateSha256"] != proof["candidateSha256"]:
        raise ValueError("candidate fingerprint differs")
    pending.rename(work / "candidate.png")


def startup_check_status(work, job_id, life, cleanup_ok, claims, error):
    if life["released"] or claims or not cleanup_ok or error or life.get("docker", {}).get("OOMKilled"):
        return {"status": "FAIL", "reason": error or life["reason"] or "TERMINAL_EVIDENCE_FAILED"}
    if life["reason"]:
        blocked = life["reason"] in {"PREFLIGHT_TIMEOUT", "HOST_SAMPLE_UNAVAILABLE", "HOST_MEMORY_UNAVAILABLE",
                                     "HOST_MEMORY_PRESSURE", "HOST_COMMIT_PRESSURE"}
        return {"status": "BLOCKED" if blocked else "FAIL", "reason": life["reason"]}
    try:
        matched = (read_json(work / "ready.json")["jobId"] == job_id
                   and read_json(work / "startup-checked.json") == {"jobId": job_id})
    except (OSError, KeyError, ValueError, TypeError):
        matched = False
    if (matched and life.get("startupGate", {}).get("ready") and life["docker"].get("ExitCode") == 0
            and life["samples"] >= 2 and 0 < life["peak"] <= MEMORY):
        return {"status": "PASS"}
    return {"status": "FAIL", "reason": "TERMINAL_EVIDENCE_FAILED"}


def finish_result(record, life, cleanup_result, job_id, error, check_only=False):
    archived = record / "work"
    unreadable = []

    def receipt(name):
        try:
            value = read_json(archived / name)
            if not isinstance(value, dict):
                raise ValueError("invalid receipt")
            return value
        except (OSError, ValueError):
            unreadable.append(name)
            return {"status": "UNKNOWN"}

    outcome_path = archived / "container-outcome.json"
    worker = receipt(outcome_path.name) if outcome_path.is_file() else {}
    if not worker and not life["reason"] and (archived / "container-error.json").is_file():
        worker_code = receipt("container-error.json").get("code")
        if worker_code in ("PREFLIGHT_OR_EVIDENCE_FAILED", "HOST_DECISION_UNAVAILABLE", "HOST_CLOCK_MISMATCH"):
            error = error or worker_code
    claims = {
        stage: receipt("dispatch-" + stage + ".json")
        for stage in ("ocr", "qwen", "lama") if (archived / ("dispatch-" + stage + ".json")).is_file()
    }
    reported = worker.get("pipeline")
    if reported is not None and (not isinstance(reported, dict) or reported.get("status") not in {"BLOCKED", "FAIL", "PASS"}):
        unreadable.append(outcome_path.name)
        reported = None
    if unreadable:
        error = error or "TERMINAL_EVIDENCE_FAILED"
    no_container_created = life.get("noContainerCreated") is True
    cleanup_ok = no_container_created or cleanup_result == (True, 0, [])
    docker_state = life.get("docker", {})
    if docker_state.get("OOMKilled"):
        life["reason"] = "CGROUP_OOM"
    pipeline = reported or {
        "status": "FAIL" if life["released"] or claims else "BLOCKED",
        "reason": life["reason"] or error or "OUTCOME_UNCONFIRMED",
    }
    if pipeline["status"] == "BLOCKED" and claims:
        pipeline = {"status": "FAIL", "reason": "TERMINAL_EVIDENCE_FAILED"}
    if pipeline["status"] == "PASS":
        counts = {stage: int(stage in claims) for stage in ("ocr", "qwen", "lama")}
        if (life["reason"] or error or not cleanup_ok or docker_state.get("ExitCode") != 0 or life["samples"] < 2
                or not life["peak"] or life["peak"] > MEMORY
                or counts != {"ocr": 1, "qwen": 1, "lama": 1} or worker.get("calls") != counts
                or not life["released"] or worker.get("halted")):
            pipeline = {"status": "FAIL", "reason": life["reason"] or error or "TERMINAL_EVIDENCE_FAILED"}
        else:
            try:
                verify_candidate(archived, worker, claims, job_id)
            except (OSError, ValueError, KeyError, TypeError) as exc:
                pipeline = {"status": "FAIL", "reason": "TERMINAL_EVIDENCE_FAILED", "detail": str(exc)}
    if check_only and not life["released"] and not claims:
        pipeline = {"status": "BLOCKED", "reason": "NOT_REQUESTED_STARTUP_CHECK"}
    result = {"scope": "PRE_INFERENCE_GATE_ONLY" if check_only else "LINUX_0B_SYNTHETIC_ONE_PAGE", "jobId": job_id, "pipeline": pipeline,
              "released": life["released"], "dispatches": claims, "container": docker_state, "worker": worker,
              "cgroupSampleCount": life["samples"], "memoryPeakBytes": life["peak"] or None, "supervision": life["reason"] or error,
              "hostStopToCleanupMs": life.get("hostStopToCleanupMs"),
              "unreadableReceipts": unreadable,
              "cleanup": {"confirmed": cleanup_ok, "containerRemoved": cleanup_result[0],
                          "cgroupPopulated": cleanup_result[1], "remainingObservedPids": cleanup_result[2],
                          "noContainerCreated": no_container_created},
              "candidate": "work/candidate.png" if pipeline["status"] == "PASS" else None}
    write_json(record / "result.json", result)
    if check_only:
        check = startup_check_status(archived, job_id, life, cleanup_ok, claims, error)
        write_json(record / "startup-check.json", {"scope": "PRE_INFERENCE_GATE_ONLY", "jobId": job_id,
                                                  "check": check, "gate": life.get("startupGate"),
                                                  "released": life["released"], "dispatches": list(claims),
                                                  "cleanup": result["cleanup"]})
        print(json.dumps({"record": str(record), "startupCheck": check}))
        return {"PASS": 0, "FAIL": 1, "BLOCKED": 2}[check["status"]]
    print(json.dumps({"record": str(record), "status": pipeline["status"], "reason": pipeline.get("reason")}))
    return {"PASS": 0, "FAIL": 1, "BLOCKED": 2}[pipeline["status"]]


def run_locked(args):
    if not Path("/var/run/docker.sock").is_socket() or docker("ps", "-q", "--filter", "label=" + LABEL):
        raise ValueError("local Docker unavailable or a verification container is active")
    image = docker("image", "inspect", "-f", "{{.Id}} {{.Os}}/{{.Architecture}}", IMAGE)
    if image != IMAGE + " linux/amd64":
        raise ValueError("pinned Linux image was not found")
    if shutil.disk_usage("/tmp").free < 6 * 1024 ** 3:
        raise ValueError("insufficient Linux temporary disk space")
    if not args.check_startup:
        claim_key = hashlib.sha256(args.inference_approval.encode()).hexdigest()
        if (CATALOG / "claims" / (claim_key + ".json")).exists():
            raise ValueError("this inference approval already has a recorded attempt")
    job_id = str(uuid4())
    record = (CATALOG / "preflight" if args.check_startup else CATALOG) / job_id
    record.mkdir(parents=True)
    life = {"samples": 0, "peak": 0, "released": False, "reason": None}
    host_before = host_sample(windows_sample())
    start_issue = host_start_issue(host_before)
    scratch = Path(tempfile.mkdtemp(prefix="mangohana-0b-", dir="/tmp")) if not start_issue else None
    write_json(record / "launch.json", {"jobId": job_id, "at": datetime.now(timezone.utc).isoformat(),
                                       "image": IMAGE, "scratch": str(scratch) if scratch is not None else None,
                                       "wheelApproval": args.wheel_approval, "inferenceApproval": args.inference_approval,
                                       "scope": "PRE_INFERENCE_GATE_ONLY" if args.check_startup else "ONE_PAGE_NO_RETRY"})
    write_json(record / "host-before-copy.json", host_before)
    if start_issue:
        life.update(reason=start_issue, noContainerCreated=True)
        return finish_result(record, life, (False, None, []), job_id, None, args.check_startup)
    cleanup_result = (False, None, None)
    container = None
    seen = set()
    error = None
    work = scratch / "work"
    try:
        staged = scratch / "input"
        pins = stage_inputs(staged, args)
        write_json(record / "inputs.json", pins)
        write_json(record / "host-after-copy.json", host_sample(windows_sample()))
        if args.check_startup:
            # Preserve the physical copy and its cache footprint outside the container's mounts.
            weights = scratch / "unmounted-weights"
            weights.mkdir(mode=0o700)
            hidden = [name for name in pins if re.search(r"\.onnx(?:_data(?:_\d+)?)?$", name)]
            if not hidden:
                raise ValueError("no weights identified for isolation")
            for index, name in enumerate(hidden):
                (staged / name).rename(weights / str(index))
            write_json(record / "unmounted-weights.json", hidden)
        (scratch / "control").mkdir(mode=0o755)
        work.mkdir(mode=0o700)
        (work / "evidence").mkdir(mode=0o700)
        (work / "home").mkdir(mode=0o700)
        for folder in (work, work / "evidence", work / "home"):
            os.chown(folder, 1000, 1000)
        container = docker(
            "create", "--label", LABEL, "--name", "mangohana-0b-" + job_id, "--pull=never", "--restart=no",
            "--init", "--network=none", "--user=1000:1000", "--cap-drop=ALL", "--read-only",
            "--security-opt=no-new-privileges:true", "--security-opt", f"seccomp={staged / 'seccomp.json'}",
            "--shm-size=512m", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
            "--cpus=4", "--memory=6g", "--memory-swap=6g", "--pids-limit=256",
            "--mount", f"type=bind,src={staged},dst=/input,readonly",
            "--mount", f"type=bind,src={scratch / 'control'},dst=/control,readonly",
            "--mount", f"type=bind,src={work},dst=/work",
            IMAGE, "/opt/node24/bin/node", "/input/repo/scripts/v2/linux-0b/container.mjs",
        )
        if not re.fullmatch(r"[a-f0-9]{64}", container):
            container = None
            raise ValueError("Docker returned an invalid container identity")
        write_json(record / "container-id.json", {"id": container})
        deadline = boot_milliseconds() + 230_000
        write_json(scratch / "control/claim.json", {"jobId": job_id, "startupDeadlineBootMs": deadline,
                                                   "bootClockOffset": boot_clock_offset(),
                                                   "checkStartup": args.check_startup})
        docker("start", container)
        supervise(container, scratch, record, job_id, args.inference_approval, seen, life, deadline)
    except KeyboardInterrupt:
        error = "CANCELLED"
    except (OSError, subprocess.SubprocessError, ValueError, KeyError) as exc:
        error = "SUPERVISION_FAILED" if life["released"] else "PREFLIGHT_FAILED"
        write_json(record / "supervisor-error.json", {"type": type(exc).__name__, "detail": str(exc)[:1000]})
    finally:
        try:
            if container is not None:
                cleanup_result = cleanup(container, life, seen)
                if "stopRequestedAtBootMs" in life and cleanup_result == (True, 0, []):
                    life["hostStopToCleanupMs"] = boot_milliseconds() - life["stopRequestedAtBootMs"]
        except (OSError, subprocess.SubprocessError, ValueError, KeyError) as exc:
            error = error or "CLEANUP_UNCONFIRMED"
            write_json(record / "cleanup-error.json", {"type": type(exc).__name__, "detail": str(exc)[:1000]})
        archived = not work.is_dir()
        if work.is_dir():
            try:
                archive_work(work / "evidence", record)
                archived = True
            except (OSError, ValueError) as exc:
                error = error or "ARCHIVE_UNCONFIRMED"
                write_json(record / "archive-error.json", {"type": type(exc).__name__, "detail": str(exc)[:1000]})
        # Keep the private stage for diagnosis if Docker did not confirm removal.
        if archived and (container is None or cleanup_result[0]):
            shutil.rmtree(scratch)
    return finish_result(record, life, cleanup_result, job_id, error, args.check_startup)


def approval_reference(value):
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", value):
        raise argparse.ArgumentTypeError("provide the recorded approval reference")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wheel", type=Path, required=True, help=f"existing approved {WHEEL}")
    parser.add_argument("--wheel-approval", type=approval_reference, required=True)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--inference-approval", type=approval_reference)
    action.add_argument("--check-startup", action="store_true", help="withhold weights and stop at the first dispatch gate")
    parser.add_argument("--wheels", type=Path, required=True, help="0A Linux wheelhouse with SHA256SUMS")
    parser.add_argument("--seccomp", type=Path, required=True, help="0A Chromium seccomp profile")
    parser.add_argument("--models", type=Path, default=Path("/mnt/e/Dev/Models"))
    parser.add_argument("--renderer", type=Path, default=REPO / "packages/ai-engine/.build/renderer.js")
    args = parser.parse_args()
    if sys.platform != "linux" or "wsl2" not in Path("/proc/sys/kernel/osrelease").read_text().lower() or os.geteuid() != 0:
        parser.error("use the approved Ubuntu WSL2 host with local Docker access")
    import fcntl

    os.umask(0o022)
    CATALOG.mkdir(exist_ok=True)
    if CATALOG.resolve() != CATALOG:
        parser.error("unexpected evidence directory")
    signal.signal(signal.SIGTERM, stop_requested)
    try:
        with (CATALOG / ".host.lock").open("a") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return run_locked(args)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "BLOCKED", "reason": str(error)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
