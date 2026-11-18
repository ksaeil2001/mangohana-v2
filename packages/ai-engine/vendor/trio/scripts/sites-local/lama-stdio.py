"""HTTP를 열지 않고 기존 LaMa worker의 검증·종료 경계를 재사용한다.

첫 줄은 {image,mask}, 다음 줄 {cancel:true} 또는 stdin EOF는 취소다.
응답 한 줄의 cleanupConfirmed는 실제 worker wait/pipe close 이후에만 true다.
"""

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading


MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_BODY_BYTES = 2 * (4 * ((MAX_IMAGE_BYTES + 2) // 3)) + 128


def load_bridge():
    source = Path(__file__).resolve().parents[1] / "local-preview" / "lama_http.py"
    spec = importlib.util.spec_from_file_location("sites_lama_validation", source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    # Sites 입력의 압축 해제 PNG와 두 base64를 함께 수용한다. 픽셀 한도는 더 작다.
    module.MAX_IMAGE_BYTES = MAX_IMAGE_BYTES
    module.MAX_BODY_BYTES = MAX_BODY_BYTES
    module.MAX_STDOUT_BYTES = 4 * ((MAX_IMAGE_BYTES + 2) // 3) + 1024
    module.MAX_PIXELS = 12_000_000
    module.MAX_SIDE = 8000
    module.WORKER_TIMEOUT_SECONDS = 80.0
    return module


def execute(bridge_module, args, source, target):
    cancelled = threading.Event()
    record = {"calls": 0, "close": True}
    bridge = None
    try:
        # daemon이 buffered stdin의 lock을 잡은 채 interpreter 종료를 막지 않도록
        # 실제 pipe fd를 읽는다. 한 번 읽은 다음 줄 조각도 취소로 보존한다.
        raw = bytearray()
        while b"\n" not in raw and len(raw) <= MAX_BODY_BYTES:
            chunk = os.read(source.fileno(), min(64 * 1024, MAX_BODY_BYTES + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        first, separator, pending = raw.partition(b"\n")
        if not separator or len(first) > MAX_BODY_BYTES:
            raise bridge_module.BridgeError(400, "invalid_request")
        prepared = bridge_module.prepare_request(bytes(first))
        bridge = bridge_module.LaMaBridge(args.python, args.worker, args.model, args.log_dir, args.tile_wrapper)

        def monitor():
            # 이 프로세스가 소유한 stdin 한 줄만 감시한다. 본문 재수신은 없다.
            if not pending:
                os.read(source.fileno(), 65)
            cancelled.set()

        threading.Thread(target=monitor, name="sites-cancel", daemon=True).start()
        output = bridge._run_worker(prepared.worker_input, cancelled.is_set, record)
        png, tiles = bridge_module.validate_result(output, prepared)
        if cancelled.is_set():
            raise bridge_module.BridgeError(499, "client_disconnected")
        response = {
            "version": 1, "ok": True, "imagePngBase64": base64.b64encode(png).decode("ascii"),
            "width": prepared.source.width, "height": prepared.source.height,
            "verification": {"normalizedImageSha256": prepared.image_sha256,
                             "maskSha256": prepared.mask_sha256,
                             "cleanedSha256": hashlib.sha256(png).hexdigest(),
                             "outsideMaskChangedPixels": 0, "alphaChangedPixels": 0,
                             "tiles": tiles, "workerCalls": record["calls"],
                             "cleanupConfirmed": record.get("close") is True},
        }
    except bridge_module.BridgeError as error:
        response = {"version": 1, "ok": False, "error": error.code,
                    "cleanupConfirmed": record.get("close") is True and not (bridge and bridge.unsafe_cleanup.is_set())}
    except Exception:
        # PIL/환경/예외 문자열·stderr·원문·경로는 stdout 또는 로그에 노출하지 않는다.
        response = {"version": 1, "ok": False, "error": "bridge_failed", "cleanupConfirmed": record.get("close") is True}
    target.write(json.dumps(response, separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n")
    target.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True, type=Path)
    parser.add_argument("--worker", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--tile-wrapper", required=True, type=Path)
    parser.add_argument("--log-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        execute(load_bridge(), args, sys.stdin.buffer, sys.stdout.buffer)
    except Exception:
        sys.stdout.buffer.write(b'{"version":1,"ok":false,"error":"bridge_unavailable","cleanupConfirmed":true}\n')
        sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
