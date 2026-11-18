# v3 experimental stdio candidate

Status: source/parser/cached-postprocessor verification only. Fresh ONNX/LaMa
execution is paused until the parent signals that the separate 9B experiment
has finished. This is not production quality approval or a default change.

## Entrypoint

```powershell
& '<existing config.python>' -I -B 'scripts/v2/vision/experimental/v3_stdio.py' --model 'E:\Dev\Models\MangohanaV2-vision\text-mask-onnx-20261110T203802715Z\comic-text-mask-unet-resnet18-384.onnx'
```

One JSON line followed by EOF, exactly the existing three fields:

```json
{"version":1,"imagePngBase64":"<current normalized PNG>","regions":[{"id":"region-0001","bbox":{"x":0.1,"y":0.1,"width":0.2,"height":0.3}}]}
```

The worker reads no old page, OCR, bubble, stage, or output files. It imports
only the reviewed local baseline helper/postprocessor and reads the server-owned
pinned model. Every valid execution computes a new dual-context ONNX CPU mask
for this image, then postprocesses actual source ink and radial brightness.
No OCR quad or text is required. Region IDs are used only for identity/order.

## Pins and limits

- ONNX SHA256: `b10356a2a12f4dec4650e563724932e542764dbd3201a7e4cae6573597c5bea1`.
- Baseline helper SHA256: `9e3a662322e0d5dcf72e26d00c8a493161d390bbabf47843e94165f4d1777b9b`.
- Postprocessor SHA256: `d45e3a504852c1054139ed485576c588778ea729857c7b6d30b15c3657181da7`.
- The exact hash-verified source/model bytes are executed/loaded, rather than
  reopening a verified path later. The original baseline helper is unmodified.
- PNG32MiB,12M pixels,8000 per side, single frame,1~64 unique regions. Invalid
  numeric values, duplicate JSON keys, unknown fields, extra records, bool
  versions and noncanonical base64 fail before model execution.
- JSON/schema/base64/PNG-header/APNG framing is rejected using only stdlib before
  native imports. Pillow then fully decodes the accepted PNG before model load.
  An earlier repeat under the9B resource load timed out during native import;
  early preflight fixed that invalid-input path without extending the20s test
  timeout. The failed log is preserved separately from the final green checks.
- Context crop: text bbox plus0.3 of its shorter side, minimum12px. The sum of
  context areas is limited to48M pixels; a context may have at most100k source
  components. Diagnostic lists are limited to128 entries per member and report
  truncation explicitly. These guards may reject overly complex inputs.
- CPU provider only. Python audit rejects sockets, subprocesses and writable
  Python file opens; bytecode writes are disabled. This is not an OS sandbox for
  native dependencies. Caller must retain30s timeout,8MiB stdout and64KiB stderr
  limits. The response itself is bounded to8MiB.

## Response

Success returns the same original PNG SHA/dimensions and pinned model identity,
exact member IDs in input order, measured model load/inference/postprocess time,
and both PNGs:

- `maskPngBase64` L:255 remove,0 preserve; `maskSha256` hashes decoded PNG bytes.
- `maskRgbaPngBase64`: RGB255, alpha0 remove/255 preserve; `maskRgbaSha256` hashes
  the exact decoded PNG bytes. Pixels are strictly binary.
- `algorithm` and `maskAlgorithm`: `source-ink-radial-halo-v3-experimental`.
- `maskKind`: `LEARNED_PIXEL_MASK`; `qualityStatus`: `REQUIRES_REVIEW`.
- `baselineAlgorithm`: `dual-context-consensus-v1`; `baselineHaloRadius`:2.
- `clipPaddingPx`:2; `adaptiveHalo`:true. There is deliberately no misleading
  fixed `haloRadius=2`: source-ink/radial growth varies by glyph, while the final
  envelope is always the original text bbox+2px.
- `regions`: actual nonempty member counts, actual outside-envelope/frame counts,
  source-ink halo radius and radial expansion diagnostics. Any empty member fails
  the entire response; no partial mask is returned as success.
- `postprocessStats`: whole-mask binary boundary statistics and source-frame
  policy. `checkedAdditionalProtectedRegions=false` is explicit: this input
  contract has no preserved OCR regions. The parent must independently reject
  erasure in preserved speech/nonSpeechText regions using decoded alpha.
- `postprocessSourceSha256` and `baselineSourceSha256`: pinned code identity.

Failure is one JSON line `{"version":1,"ok":false,"error":"TEXT_MASK_FAILED"}`,
exit1. No exception/source text is added. Caller retains stderr bounds.

The current parent verifier accepts v1 only. A server-owned expectedAlgorithm
branch must explicitly authorize this v3 name/code pin, enforce clipPaddingPx2,
decode both masks, verify L=255-alpha and all ID/SHA/nonempty/protection checks.
Do not relabel this output as v1 or change default settings automatically.

## Verification boundaries

`test_v3_postprocess.py`(4), `test_v3_sources.py`(6) and
`test_v3_stdio_protocol.py`(5) run image postprocessing, source/parser/offline tests and malformed/missing-model
protocol tests without creating an ONNX inference session. A fresh guarded
process imports pinned sources successfully before the model-loading phase.

`v3_cached_replay.py` reprocesses explicitly supplied historical evidence solely
as a cache comparison harness. Its scope is `CACHED_AI_MASK_POSTPROCESS_REPLAY_NO_AI`.
It is not reachable from the stdio worker. The existing final first-page mask
`1ac8ea3576c39ee1f2c97ba16bb0611787938772323932ea177a14f64ebddc7b`
was reproduced byte-for-byte using only current pixels/baseline/text boxes.

`verify-v3-stdio.mjs --run-real-inference <config> <detector-evidence> <new-output>`
is the opt-in fresh3-page verification harness. It is prepared but must remain
unexecuted until the parent releases the9B resource constraint. Those actual
inference results and any LaMa experiment must be reported separately.
