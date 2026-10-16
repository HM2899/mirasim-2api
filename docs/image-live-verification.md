# Live image verification: gpt-6-astra

The matrix below describes the **pre-optimization** baseline. Subsequent changes add Chat/Messages hosted image tools, Responses-backed direct-image SSE, and multipart-to-JSON conversion. See `image-protocol-and-features.md` for current behavior and `image-p0-optimization.md` for the successful 11-case post-change live retest.

User-authorized production tests used `gpt-6-astra` without model substitution. Generation requested a red circle on white; editing supplied the previously generated PNG and requested a blue circle. All requests used low quality and requested 1024 × 1024 output where supported by the request format.

## Results

| Route / operation | JSON | Requested SSE | Notes |
| --- | --- | --- | --- |
| Responses generation | PASS, 23.2 s | PASS, 24.1 s | SSE included one partial image and completed image |
| Responses editing | PASS, 24.6 s | PASS, 22.0 s | Completed edit; no partial image observed despite requesting one |
| Chat generation and editing | HTTP 400 | HTTP 400 | Gateway rejects hosted image tools on this bridge |
| Anthropic generation and editing | HTTP 400 | HTTP 400 | Gateway requires client-tool name/input_schema, rejects image tool |
| Images generation | PASS, 18.9 s | PARTIAL, 19.0 s | Image returned, but stream=true produced application/json, not SSE |
| Images editing with JSON images | PASS, 16.7 s | PARTIAL, 20.4 s | Image returned, but stream=true produced application/json, not SSE |
| Codex Images alias generation | PASS, 19.6 s | Not separately tested | Canonical raw forwarding route |
| Codex Images alias editing | PASS, 20.3 s | Not separately tested | Canonical raw forwarding route |
| Images multipart editing (`image[]`) | HTTP 400 | Not tested | Upstream error: request body is not valid JSON |

Of 19 requests, 8 met the tested protocol expectations, 2 returned images but failed the requested streaming format, and 9 were rejected. Ten PNG files were returned and verified with ffprobe. Responses and direct-image edited samples were visually inspected and correctly changed the circle to blue.

Output dimensions did not honor 1024 × 1024: generation returned 1254 × 1254 and edits returned 1536 × 1024. These live results supersede any assumption that raw option forwarding guarantees upstream option support.

## Interpretation

Responses image tools and JSON Image API generation/editing work for this model in the tested account pool. Chat/Anthropic image-model bridging previously implemented for `gpt-image-*` does **not** establish hosted `image_generation` tool compatibility for `gpt-6-astra`; that conversion is currently missing. Raw multipart forwarding exists locally but was rejected upstream. No implementation change or restart was performed during this verification.

Temporary test API keys were revoked. Generated files and the sanitized machine-readable results are in `/tmp/mirasim-image-matrix/`; the test log is `/tmp/mirasim-image-matrix.log`. The report's `passed` field records image-production success only; use `protocolPassed` for the stricter streaming-aware outcome. These files contain no API keys or source-account credentials.
