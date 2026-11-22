"""Synthetic Linux 0B validation contracts. No Docker or model access."""

import base64
import contextlib
import ctypes
import hashlib
import io
import json
import mmap
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/v2/linux-0b"))
from launch import finish_result, write_json
from inputs import copy_checked, read_json
import probe
import launch


class StartupGateTest(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "linux", "Linux page cache operation")
    def test_setup_cache_release_uses_only_regular_private_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            private, external = root / "private", root / "external"
            private.mkdir()
            external.mkdir()
            payload = b"synthetic" * 65536
            (private / "runtime.py").write_bytes(payload)
            (external / "model").write_bytes(b"external sentinel")
            (private / "link").symlink_to(external, target_is_directory=True)
            (private / "another").symlink_to(external / "model")
            self.assertEqual(probe.release_setup_cache(private, sync=True), {"files": 1, "bytes": len(payload)})
            self.assertEqual((private / "runtime.py").read_bytes(), payload)
            self.assertEqual((external / "model").read_bytes(), b"external sentinel")
    def test_worker_timeout_before_dispatch_preserves_its_recorded_reason(self):
        with tempfile.TemporaryDirectory() as temporary:
            record = Path(temporary)
            work = record / "work"
            work.mkdir()
            write_json(work / "container-error.json", {"type": "Error", "code": "HOST_DECISION_UNAVAILABLE"})
            life = {"released": False, "reason": None, "samples": 4, "peak": 200, "docker": {"ExitCode": 2}}
            with contextlib.redirect_stdout(io.StringIO()):
                code = finish_result(record, life, (True, 0, []), "job", None)
            self.assertEqual(code, 2)
            self.assertEqual(read_json(record / "result.json")["pipeline"],
                             {"status": "BLOCKED", "reason": "HOST_DECISION_UNAVAILABLE"})

    def test_only_a_fresh_post_preparation_query_can_open_the_gate_before_the_deadline(self):
        fresh = {"ready": True, "windowsQueryStartedBootMs": 1001, "windowsSampledBootMs": 1002,
                 "sampledAtBootMs": 1003, "windowsAvailableMiB": 7168, "wslAvailableMiB": 6912,
                 "windowsCommitUsedBytes": 4 * 1024 ** 3, "windowsCommitLimitBytes": 12 * 1024 ** 3,
                 "windowsPagesOutputPerSec": 0}
        self.assertEqual(launch.startup_decision(1000, fresh, 1010, 1200), "OPEN")
        self.assertEqual(launch.startup_decision(1000, {**fresh, "windowsQueryStartedBootMs": 999}, 1010, 1200), "WAIT")
        self.assertEqual(launch.startup_decision(1000, fresh, 1200, 1200), "PREFLIGHT_TIMEOUT")
        self.assertEqual(launch.startup_decision(1000, {**fresh, "windowsAvailableMiB": 7167}, 1200, 1200),
                         "HOST_MEMORY_UNAVAILABLE")
        self.assertEqual(launch.startup_decision(1000, {**fresh, "windowsAvailableMiB": 7167}, 1010, 1200), "WAIT")
        corrupt = {**fresh, "ready": False, "runtimeIssue": "HOST_COMMIT_PRESSURE", "windowsCommitUsedBytes": None}
        self.assertEqual(launch.startup_decision(1000, corrupt, 1200, 1200), "HOST_SAMPLE_UNAVAILABLE")
        self.assertEqual(launch.startup_decision(1000, {}, 1200, 1200), "HOST_SAMPLE_UNAVAILABLE")
        self.assertEqual(launch.startup_decision(1000, fresh, 15000, 15000), "HOST_SAMPLE_UNAVAILABLE")
        self.assertEqual(launch.startup_decision(None, fresh, 1200, 1200), "PREFLIGHT_TIMEOUT")

    def test_wall_clock_rollback_and_stale_windows_reads_cannot_open_startup(self):
        windows = {"windowsAvailableMiB": 8000, "windowsQueryStartedAtMs": 20000, "windowsSampledAtMs": 21000,
                   "windowsQueryStartedBootMs": 1000, "windowsSampledBootMs": 2000,
                   "windowsCommitUsedBytes": 10 * 1024 ** 3, "windowsCommitLimitBytes": 20 * 1024 ** 3,
                   "windowsPagesOutputPerSec": 0}
        linux = {"MemAvailable": 7200 * 1024, "SwapTotal": 0, "SwapFree": 0, "pswpin": 0, "pswpout": 0}
        with patch.object(launch, "fields", return_value=linux), patch.object(launch.time, "time", return_value=10):
            with patch.object(Path, "read_text", return_value="14.00 2.00\n"):
                self.assertFalse(launch.host_sample(windows)["ready"])
            with patch.object(Path, "read_text", return_value="12.00 2.00\n"):
                self.assertTrue(launch.host_sample(windows)["ready"])
            with patch.object(Path, "read_text", return_value="1.50 2.00\n"):
                self.assertFalse(launch.host_sample(windows)["ready"])

    def test_host_sample_distinguishes_pressure_and_missing_observations(self):
        gib = 1024 ** 3
        windows = {"windowsAvailableMiB": 7168, "windowsCommitUsedBytes": 10 * gib,
                   "windowsCommitLimitBytes": 12 * gib, "windowsPagesOutputPerSec": 3,
                   "windowsQueryStartedBootMs": 1000, "windowsSampledBootMs": 1400}
        linux = {"MemAvailable": 6912 * 1024, "SwapTotal": 0, "SwapFree": 0, "pswpin": 0, "pswpout": 0}
        with patch.object(launch, "fields", return_value=linux), patch.object(launch, "boot_milliseconds", return_value=1500):
            good = launch.host_sample(windows)
            physical = launch.host_sample({**windows, "windowsAvailableMiB": 2047})
            commit = launch.host_sample({**windows, "windowsCommitUsedBytes": 10 * gib + 1})
            missing = launch.host_sample({**windows, "windowsCommitLimitBytes": None})
            self.assertFalse(commit["ready"])
            malformed = launch.host_sample({**windows, "windowsSampledBootMs": None})
        self.assertTrue(good["ready"])
        self.assertIsNone(good["runtimeIssue"])
        self.assertEqual(physical["runtimeIssue"], "HOST_MEMORY_PRESSURE")
        self.assertEqual(commit["runtimeIssue"], "HOST_COMMIT_PRESSURE")
        self.assertEqual(missing["runtimeIssue"], "HOST_SAMPLE_UNAVAILABLE")
        self.assertEqual(malformed["runtimeIssue"], "HOST_SAMPLE_UNAVAILABLE")
        self.assertEqual(launch.startup_decision(999, commit, 1600, 1600), "HOST_COMMIT_PRESSURE")
        self.assertEqual(launch.startup_decision(999, missing, 1600, 1600), "HOST_SAMPLE_UNAVAILABLE")

    def test_raw_windows_sample_uses_real_gauges_and_needs_two_readings_for_page_rates(self):
        raw = {"windowsAvailableMiB": 7168, "windowsCommitUsedBytes": 10 * 1024 ** 3,
               "windowsCommitLimitBytes": 16 * 1024 ** 3, "windowsPagesInputTotal": 210,
               "windowsPagesOutputTotal": 30, "windowsCounterTicks": 10_000, "windowsCounterFrequency": 1000}
        linux = {"MemAvailable": 6912 * 1024, "SwapTotal": 0, "SwapFree": 0, "pswpin": 0, "pswpout": 0}
        with (patch.object(launch, "local_command", return_value=json.dumps(raw)) as command,
              patch.object(launch, "fields", return_value=linux),
              patch.object(launch, "boot_milliseconds", side_effect=[1000, 1020, 1020, 1020])):
            reading = launch.windows_sample()
            self.assertTrue(launch.host_sample(reading)["ready"])
            self.assertFalse(launch.host_sample({**reading, "windowsCounterFrequency": 0})["ready"])
        self.assertIn("Win32_PerfRawData_PerfOS_Memory", command.call_args.args[0][-1])
        self.assertIsNone(reading.get("windowsPagesOutputPerSec"))
        next_raw = {**raw, "windowsCounterTicks": 12_000, "windowsPagesInputTotal": 214, "windowsPagesOutputTotal": 76}
        with_rates = launch.windows_with_page_rates(next_raw, raw)
        self.assertEqual(with_rates["windowsPagesInputPerSec"], 2)
        self.assertEqual(with_rates["windowsPagesOutputPerSec"], 23)
        self.assertEqual(launch.windows_with_page_rates(raw, raw), {})
        self.assertIsNone(launch.windows_with_page_rates({**next_raw, "windowsPagesOutputTotal": 1}, raw)["windowsPagesOutputPerSec"])

    def test_supervisor_stops_running_container_on_host_pressure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "control").mkdir()
            life = {"released": True, "samples": 0, "peak": 0, "reason": None, "releaseAt": launch.time.monotonic()}
            pressure = {"ready": False, "runtimeIssue": "HOST_MEMORY_PRESSURE"}
            resource = {"memoryEvents": {"oom": 0, "oom_kill": 0}, "memoryPeak": 1,
                        "memorySwapCurrent": 0, "pidsEvents": {"max": 0}}
            with (patch.object(launch, "inspect_state", side_effect=[{"Running": True, "Pid": 1}, {"Running": False}]),
                  patch.object(launch, "group_for", return_value=root), patch.object(launch, "sample_group", return_value=resource),
                  patch.object(launch, "host_sample", return_value=pressure), patch.object(launch, "windows_sample", return_value={}),
                  patch.object(launch, "docker") as docker, patch.object(launch.time, "sleep")):
                launch.supervise("owned", root, root, "fixture", "approval", set(), life, 100)
            docker.assert_called_once_with("stop", "--time=6", "owned", timeout=14)
            self.assertEqual(life["reason"], "HOST_MEMORY_PRESSURE")
            self.assertGreaterEqual(life["stopRequestedAtBootMs"], 0)

    def test_insufficient_host_memory_blocks_before_copy_or_container_creation(self):
        for check_startup in (True, False):
            with self.subTest(check_startup=check_startup), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                catalog, scratch = root / "catalog", root / "scratch"
                scratch.mkdir()
                host = {"windowsAvailableMiB": 5965, "wslAvailableMiB": 7169,
                        "windowsQueryStartedBootMs": 10, "windowsSampledBootMs": 20, "sampledAtBootMs": 21,
                        "windowsCommitUsedBytes": 10 * 1024 ** 3, "windowsCommitLimitBytes": 20 * 1024 ** 3,
                        "windowsPagesOutputPerSec": 0, "ready": False}
                args = SimpleNamespace(check_startup=check_startup, wheel_approval="wheel",
                                       inference_approval=None if check_startup else "one-page")
                with (patch.object(launch, "CATALOG", catalog), patch.object(Path, "is_socket", return_value=True),
                      patch.object(launch, "docker", side_effect=["", launch.IMAGE + " linux/amd64"]) as docker,
                      patch.object(launch.shutil, "disk_usage", return_value=SimpleNamespace(free=10 * 1024 ** 3)),
                      patch.object(launch, "host_sample", return_value=host), patch.object(launch, "windows_sample", return_value={}),
                      patch.object(launch, "stage_inputs", side_effect=ValueError("unexpected staging")) as stage,
                      patch.object(launch.tempfile, "mkdtemp", return_value=str(scratch)) as make_scratch,
                      contextlib.redirect_stdout(io.StringIO())):
                    result = launch.run_locked(args)
                self.assertEqual(result, 2)
                stage.assert_not_called()
                make_scratch.assert_not_called()
                self.assertEqual(docker.call_count, 2)
                self.assertFalse((catalog / "claims").exists())
                (receipt_path,) = catalog.rglob("result.json")
                receipt = read_json(receipt_path)
                self.assertEqual(receipt["dispatches"], {})
                self.assertTrue(receipt["cleanup"]["noContainerCreated"])
                self.assertFalse((receipt_path.parent / "inputs.json").exists())
                self.assertEqual(receipt["supervision"], "HOST_MEMORY_UNAVAILABLE")

    def test_startup_check_requires_matching_ack_no_release_no_dispatch_and_clean_exit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            work = root / "work"
            work.mkdir()
            life = {"startupGate": {"ready": True}, "released": False, "reason": None,
                    "docker": {"ExitCode": 0, "OOMKilled": False}, "samples": 12, "peak": 200}
            write_json(work / "ready.json", {"jobId": "fixture"})
            write_json(work / "startup-checked.json", {"jobId": "fixture"})
            for issue in ("none", "claim", "wrong-job", "cleanup", "release", "missing-gate"):
                with self.subTest(issue=issue):
                    status = launch.startup_check_status(work, "wrong" if issue == "wrong-job" else "fixture",
                        {**life, "released": issue == "release", "startupGate": {} if issue == "missing-gate" else life["startupGate"]},
                        issue != "cleanup", {"ocr": {}} if issue == "claim" else {}, None)
                    self.assertEqual(status["status"], "PASS" if issue == "none" else "FAIL")


class FinalizerTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.record = Path(self.folder.name)
        self.work = self.record / "work"
        self.work.mkdir()
        self.job = "0b-test-fake-receipt"
        self.roles = ("ocr", "mask", "qwen", "lama", "render")
        self.life = {"reason": None, "released": True, "samples": 2, "peak": 1024,
                     "docker": {"ExitCode": 0, "OOMKilled": False}}
        values = {"original.png": b"original", "normalized.png": b"normalized",
                  "standalone-mask.png": b"standalone", "pipeline-mask.png": b"mask",
                  "ocr-request.json": b"ocr fixture", "qwen-pipeline-request.json": b"qwen fixture",
                  "candidate.pending.png": b"candidate"}
        for name, data in values.items():
            (self.work / name).write_bytes(data)
        fingerprints = {name: hashlib.sha256(data).hexdigest() for name, data in values.items()}
        write_json(self.work / "ready.json", {"jobId": self.job, "fixture": {
            "originalSha256": fingerprints["original.png"], "normalizedSha256": fingerprints["normalized.png"],
            "standaloneMaskSha256": fingerprints["standalone-mask.png"],
        }})
        lama_request = json.dumps({"image": base64.b64encode(values["normalized.png"]).decode(),
                                   "mask": base64.b64encode(values["pipeline-mask.png"]).decode()},
                                  separators=(",", ":")).encode() + b"\n"
        self.inputs = {"ocr": fingerprints["ocr-request.json"], "qwen": fingerprints["qwen-pipeline-request.json"],
                       "lama": hashlib.sha256(lama_request).hexdigest()}
        for stage, digest in self.inputs.items():
            write_json(self.work / f"dispatch-{stage}.json", {
                "jobId": self.job, "stage": stage, "mode": "pipeline", "inputSha256": digest,
            })
        self.candidate = fingerprints["candidate.pending.png"]
        write_json(self.work / "typesetting.json", {"candidateSha256": self.candidate})

    def finalize(self, roles, cleanup=(True, 0, [])):
        verified = {phase: {"status": "PASS"} for phase in ("load", "compute", "output")}
        worker = {
            "jobId": self.job, "pipeline": {"status": "PASS"}, "calls": {stage: 1 for stage in self.inputs},
            "models": {model: verified for model in ("rtdetr", "ppocrv4", "baberu", "qwen", "lama")},
            "stages": [{"stage": role, "mode": "pipeline", "status": "PASS",
                        **({"requestSha256": self.inputs[role]} if role in self.inputs else {}),
                        **({"candidateSha256": self.candidate} if role == "render" else {})} for role in roles],
        }
        write_json(self.work / "container-outcome.json", worker)
        with contextlib.redirect_stdout(io.StringIO()):
            exit_code = finish_result(self.record, self.life, cleanup, self.job, None)
        return exit_code, read_json(self.record / "result.json")

    def test_promotes_only_the_bound_candidate_after_resource_and_cleanup_evidence(self):
        code, result = self.finalize(self.roles)
        self.assertEqual((code, result["pipeline"]["status"]), (0, "PASS"))
        self.assertEqual((self.work / "candidate.png").read_bytes(), b"candidate")
        self.assertFalse((self.work / "candidate.pending.png").exists())

    def test_attempt_with_missing_mask_stage_fails_even_if_worker_reported_pass(self):
        code, result = self.finalize(("ocr", "qwen", "lama", "render"))
        self.assertEqual((code, result["pipeline"]["status"]), (1, "FAIL"))
        self.assertFalse((self.work / "candidate.png").exists())

    def test_attempt_with_mismatched_wire_request_never_promotes_candidate(self):
        (self.work / "qwen-pipeline-request.json").write_bytes(b"changed fixture")
        code, result = self.finalize(self.roles)
        self.assertEqual((code, result["pipeline"]["status"]), (1, "FAIL"))
        self.assertFalse((self.work / "candidate.png").exists())

    def test_unconfirmed_cleanup_never_promotes_candidate(self):
        code, result = self.finalize(self.roles, cleanup=(True, 1, [11]))
        self.assertEqual((code, result["pipeline"]["status"]), (1, "FAIL"))
        self.assertFalse((self.work / "candidate.png").exists())

    def test_interrupted_receipt_cannot_turn_a_dispatched_attempt_into_a_preflight_block(self):
        (self.work / "container-outcome.json").write_bytes(b'{"pipeline":')
        with contextlib.redirect_stdout(io.StringIO()):
            code = finish_result(self.record, self.life, (True, 0, []), self.job, None)
        result = read_json(self.record / "result.json")
        self.assertEqual((code, result["pipeline"]["status"]), (1, "FAIL"))
        self.assertEqual(set(result["dispatches"]), {"ocr", "qwen", "lama"})
        self.assertFalse((self.work / "candidate.png").exists())

    def test_copy_checks_pin_and_preserves_source_and_existing_target(self):
        source, target = self.record / "source", self.record / "staged"
        source.write_bytes(b"fixture")
        pin = hashlib.sha256(b"fixture").hexdigest()
        self.assertEqual(copy_checked(source, target, pin)["sha256"], pin)
        self.addCleanup(target.chmod, 0o600)
        with self.assertRaises(FileExistsError):
            copy_checked(source, target, pin)
        self.assertEqual(source.read_bytes(), target.read_bytes())

    @unittest.skipUnless(sys.platform == "linux", "requires Linux file cache accounting")
    def test_large_checked_copy_leaves_only_a_small_resident_tail(self):
        source, target = self.record / "source", self.record / "staged"
        size = 64 * 1024 * 1024 + 37
        with source.open("xb") as stream:
            stream.seek(size - 1)
            stream.write(b"z")
        with source.open("rb") as stream:
            pin = hashlib.file_digest(stream, "sha256").hexdigest()
        receipt = copy_checked(source, target, pin, size)
        self.assertEqual(receipt["sha256"], pin)

        pages = (ctypes.c_ubyte * ((size + mmap.PAGESIZE - 1) // mmap.PAGESIZE))()
        with target.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_COPY) as view:
            address = ctypes.c_void_p(ctypes.addressof(ctypes.c_char.from_buffer(view)))
            self.assertEqual(ctypes.CDLL(None).mincore(address, ctypes.c_size_t(size), pages), 0)
        self.assertLessEqual(sum(page & 1 for page in pages) * mmap.PAGESIZE, 4 * 1024 * 1024)
        with target.open("rb") as stream:
            self.assertEqual(hashlib.file_digest(stream, "sha256").hexdigest(), pin)


class QwenTokenBudgetTest(unittest.TestCase):
    def test_measured_requests_use_the_remaining_capacity(self):
        for input_tokens, default_limit, effective_limit in (
            (525, 1082, 1011), (521, 1074, 1015), (100, 232, 232), (1536, 3104, 0), (1537, 3106, 0),
        ):
            with self.subTest(input_tokens=input_tokens):
                self.assertEqual(probe.qwen_generation_budget(input_tokens, default_limit), {
                    "inputTokens": input_tokens,
                    "defaultGenerationLimit": default_limit,
                    "generationLimit": effective_limit,
                    "totalTokenLimit": 1536,
                })

    def test_decoder_receives_and_reports_the_effective_limit(self):
        calls = []

        class Translator:
            def generate(self, ids, limit):
                calls.append((len(ids), limit))
                return "fixture", True, 1

        translation = SimpleNamespace(PageTranslator=Translator, verify_assets=lambda: None)
        with patch.dict(sys.modules, {"context_translation": translation}), \
                patch.object(sys, "path", list(sys.path)), patch.object(probe, "phase") as events:
            probe.observe_qwen()
            self.assertEqual(Translator().generate([1] * 525, 1082), ("fixture", True, 1))
            events.assert_any_call("generation_budget", model="qwen", budget={
                "inputTokens": 525, "defaultGenerationLimit": 1082, "generationLimit": 1011, "totalTokenLimit": 1536,
            })
            with self.assertRaisesRegex(ValueError, "QWEN_TOKEN_LIMIT"):
                Translator().generate([1] * 1536, 3104)
        self.assertEqual(calls, [(525, 1011)])
