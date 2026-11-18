"""App-owned, offline, one-request LaMa CPU worker. No installer or server.

Model provenance/Apache-2.0:
https://huggingface.co/Carve/LaMa-ONNX/tree/c3c0c9e468934d62e79c329e35d82dd09ff8c444
The publisher's ExportLama returns float NCHW pixels clamped to 0..255;
only its input RGB is divided by 255. Batch is the exported dynamic axis.
"""
import base64
import gc
import hashlib
import io
import json
import os
import stat
import sys
import platform
import warnings

import numpy as np
from PIL import Image

MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_OUTPUT_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 16_000_000
MAX_SIDE = 32_768
MAX_TILES = 64
TILE = 512
HALO = 32
CORE = TILE - 2 * HALO
MODEL_SIZE = 208044816
MODEL_SHA256 = "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6"
ARENA_BYTES = 1024 * 1024 * 1024


def deny_network_or_children(event, _args):
    if event.startswith("socket.") or event in ("subprocess.Popen", "os.system", "os.posix_spawn", "os.fork", "os.exec"):
        raise RuntimeError("OFFLINE_ONLY")


def install_offline_guards():
    # Windows ONNX Runtime imports platform.system(). Python initializes its
    # local OS cache through socket.gethostname(); this does not connect to a
    # network. Initialize it before the unchanged network/process deny policy,
    # before reading an image or loading a model. Never log the returned data.
    platform.system()
    sys.addaudithook(deny_network_or_children)


def valid_size(width, height):
    return (type(width) is int and type(height) is int and 0 < width <= MAX_SIDE
            and 0 < height <= MAX_SIDE and width * height <= MAX_PIXELS)


def decode_base64(value):
    if (not isinstance(value, str) or not value or len(value) > 4 * ((MAX_IMAGE_BYTES + 2) // 3)
            or len(value) % 4):
        raise ValueError("INVALID_IMAGE_BYTES")
    data = base64.b64decode(value, validate=True)
    if not data or len(data) > MAX_IMAGE_BYTES or base64.b64encode(data).decode("ascii") != value:
        raise ValueError("INVALID_IMAGE_BYTES")
    return data


def read_request(stream):
    raw = stream.read(MAX_INPUT_BYTES + 1)
    if not raw or len(raw) > MAX_INPUT_BYTES:
        raise ValueError("INPUT_LIMIT")
    request = json.loads(raw)
    if (not isinstance(request, dict) or set(request) != {"version", "imageBase64", "maskBase64"}
            or type(request["version"]) is not int or request["version"] != 1):
        raise ValueError("INVALID_REQUEST")
    return decode_base64(request["imageBase64"]), decode_base64(request["maskBase64"])


def decode_images(image_bytes, mask_bytes):
    # Check header dimensions before Pillow decompresses either image. Do not
    # apply EXIF orientation: the mask addresses the source's actual pixels.
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(image_bytes), formats=["PNG", "JPEG", "WEBP"]) as image:
            if (not valid_size(*image.size) or getattr(image, "n_frames", 1) != 1
                    or image.mode not in ("1", "L", "LA", "P", "RGB", "RGBA", "CMYK")):
                raise ValueError("INVALID_IMAGE")
            size = image.size
            rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
        with Image.open(io.BytesIO(mask_bytes), formats=["PNG"]) as mask_image:
            if mask_image.size != size or getattr(mask_image, "n_frames", 1) != 1:
                raise ValueError("MASK_SIZE_MISMATCH")
            # White/nonzero luminance means remove. Opaque black is unmasked;
            # transparent painted pixels are also unmasked.
            mask = np.array(mask_image.convert("L"), dtype=np.uint8) > 0
            if "A" in mask_image.getbands() or "transparency" in mask_image.info:
                mask &= np.asarray(mask_image.convert("RGBA").getchannel("A")) > 0
    if not mask.any():
        raise ValueError("EMPTY_MASK")
    return rgba, mask


def plan_tiles(mask):
    if mask.ndim != 2 or not valid_size(mask.shape[1], mask.shape[0]) or not mask.any():
        raise ValueError("INVALID_MASK")
    height, width = mask.shape
    tiles = []
    for top in range(0, height, CORE):
        for left in range(0, width, CORE):
            core_width, core_height = min(CORE, width - left), min(CORE, height - top)
            if not mask[top:top + core_height, left:left + core_width].any():
                continue
            tiles.append((left, top, core_width, core_height))
            if len(tiles) > MAX_TILES:
                raise ValueError("TILE_LIMIT")
    return tiles


def verify_model(path):
    if (not os.path.isabs(path) or os.path.basename(path) != "lama_fp32.onnx"
            or os.path.normcase(os.path.realpath(path)) != os.path.normcase(os.path.abspath(path))):
        raise ValueError("INVALID_MODEL")
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or before.st_size != MODEL_SIZE:
        raise ValueError("INVALID_MODEL")
    digest = hashlib.sha256()
    count = 0
    with open(path, "rb") as model:
        opened = os.fstat(model.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != (
                before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns):
            raise ValueError("INVALID_MODEL")
        while True:
            chunk = model.read(256 * 1024)
            if not chunk:
                break
            count += len(chunk)
            if count > MODEL_SIZE:
                raise ValueError("INVALID_MODEL")
            digest.update(chunk)
        after = os.stat(path, follow_symlinks=False)
        if ((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (
                opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
                or count != MODEL_SIZE or digest.hexdigest() != MODEL_SHA256):
            raise ValueError("INVALID_MODEL")


def validate_session(session):
    if session.get_providers() != ["CPUExecutionProvider"]:
        raise ValueError("INVALID_PROVIDER")
    inputs = session.get_inputs()
    expected = {"image": [3, TILE, TILE], "mask": [1, TILE, TILE]}
    if len(inputs) != 2 or {item.name for item in inputs} != set(expected):
        raise ValueError("INVALID_INPUT_METADATA")
    for item in inputs:
        if (item.type != "tensor(float)" or len(item.shape) != 4
                or item.shape[0] not in (1, "batch") or item.shape[1:] != expected[item.name]):
            raise ValueError("INVALID_INPUT_METADATA")
    outputs = session.get_outputs()
    if (len(outputs) != 1 or outputs[0].name != "output" or outputs[0].type != "tensor(float)"
            or len(outputs[0].shape) != 4 or outputs[0].shape[0] not in (1, "batch")
            or outputs[0].shape[1:] != [3, TILE, TILE]):
        raise ValueError("INVALID_OUTPUT_METADATA")


def create_session(model_path):
    import onnxruntime as ort

    ort.disable_telemetry_events()
    ort.set_default_logger_severity(4)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    options.enable_mem_pattern = False
    options.enable_cpu_mem_arena = True
    options.log_severity_level = 4
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    options.add_session_config_entry("session.use_env_allocators", "1")
    # Bound the shared CPU arena and request exact growth, rather than retaining
    # exponentially growing arenas for many tiles. This is not a whole-process
    # working-set claim: weights/Pillow/NumPy allocations also consume memory.
    memory = ort.OrtMemoryInfo("Cpu", ort.OrtAllocatorType.ORT_ARENA_ALLOCATOR, 0, ort.OrtMemType.DEFAULT)
    # ORT rounds arena chunks to 256 bytes. A zero split threshold also splits
    # an exact-size allocation into an empty tail and aborts ORT 1.23 on Windows.
    arena = ort.OrtArenaCfg({"max_mem": ARENA_BYTES, "arena_extend_strategy": 1,
                            "initial_chunk_size_bytes": 16 * 1024 * 1024, "max_dead_bytes_per_chunk": 256})
    ort.create_and_register_allocator(memory, arena)
    session = ort.InferenceSession(model_path, sess_options=options, providers=["CPUExecutionProvider"])
    session.disable_fallback()
    validate_session(session)
    return session


def process_tiles(session, rgba, mask, tiles):
    if (rgba.dtype != np.uint8 or rgba.ndim != 3 or rgba.shape[2] != 4
            or mask.dtype != np.bool_ or mask.shape != rgba.shape[:2]
            or not 0 < len(tiles) <= MAX_TILES):
        raise ValueError("INVALID_PIXELS")
    height, width = mask.shape
    result = rgba.copy()
    for left, top, core_width, core_height in tiles:
        origin_x, origin_y = left - HALO, top - HALO
        x0, y0 = max(0, origin_x), max(0, origin_y)
        x1, y1 = min(width, origin_x + TILE), min(height, origin_y + TILE)
        padding = ((y0 - origin_y, origin_y + TILE - y1), (x0 - origin_x, origin_x + TILE - x1))
        # Only 512px crops become float tensors. Never shrink the whole page or
        # allocate a full-page float tensor. Each tile sees the original image.
        tile_rgb = np.pad(rgba[y0:y1, x0:x1, :3], padding + ((0, 0),), mode="edge")
        tile_mask = np.pad(mask[y0:y1, x0:x1], padding, mode="constant", constant_values=False)
        image_tensor = np.ascontiguousarray(tile_rgb.transpose(2, 0, 1)[None], dtype=np.float32)
        image_tensor /= 255.0
        mask_tensor = np.ascontiguousarray(tile_mask[None, None], dtype=np.float32)
        output = session.run(["output"], {"image": image_tensor, "mask": mask_tensor})[0]
        if (not isinstance(output, np.ndarray) or output.dtype != np.float32 or output.shape != (1, 3, TILE, TILE)
                or not np.isfinite(output).all() or output.min() < 0 or output.max() > 255):
            raise ValueError("INVALID_OUTPUT_PIXELS")
        # ExportLama's output already is 0..255, not 0..1. Match the original
        # implementation's uint8 conversion, without multiplying by 255 again.
        edited = output[0, :, HALO:HALO + core_height, HALO:HALO + core_width].transpose(1, 2, 0).astype(np.uint8)
        core_mask = mask[top:top + core_height, left:left + core_width]
        target = result[top:top + core_height, left:left + core_width, :3]
        target[core_mask] = edited[core_mask]
        # Alpha and every byte outside the binary mask stay exactly as decoded.
        del output, edited, image_tensor, mask_tensor, tile_rgb, tile_mask
    return result


class BoundedPng(io.BytesIO):
    def write(self, data):
        if self.tell() + len(data) > MAX_IMAGE_BYTES:
            raise ValueError("PNG_LIMIT")
        return super().write(data)


def encode_response(rgba, tile_count):
    with BoundedPng() as target:
        Image.fromarray(rgba, mode="RGBA").save(target, format="PNG", compress_level=6)
        png = target.getvalue()
    response = json.dumps({"version": 1, "imagePngBase64": base64.b64encode(png).decode("ascii"),
                           "width": rgba.shape[1], "height": rgba.shape[0], "tiles": tile_count},
                          separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
    if len(response) > MAX_OUTPUT_BYTES:
        raise ValueError("OUTPUT_LIMIT")
    return response


def main():
    # Keep even native library stdout off the protocol pipe. A private duplicate
    # writes exactly one bounded JSON response; diagnostics stay on stderr.
    with os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0) as protocol:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        try:
            install_offline_guards()
            if len(sys.argv) != 3 or sys.argv[1] != "--model":
                raise ValueError("INVALID_ARGUMENTS")
            image_bytes, mask_bytes = read_request(sys.stdin.buffer)
            rgba, mask = decode_images(image_bytes, mask_bytes)
            del image_bytes, mask_bytes
            tiles = plan_tiles(mask)
            verify_model(sys.argv[2])
            session = create_session(sys.argv[2])
            try:
                result = process_tiles(session, rgba, mask, tiles)
            finally:
                del session
                gc.collect()
            del rgba, mask
            response = encode_response(result, len(tiles))
            del result
            protocol.write(response)
            protocol.flush()
            return 0
        except Exception:
            # No file paths, request contents, dependency tracebacks or stderr
            # details are returned to main. Never emit an original-image result.
            sys.stderr.write("MANAGED_LAMA_FAILED\n")
            return 1


if __name__ == "__main__":
    sys.exit(main())
