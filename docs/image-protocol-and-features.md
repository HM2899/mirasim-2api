# Image protocols and useful desktop features

## Implemented compatibility

The inspected artifact is Mirasim 0.0.383. Its route switch explicitly maps both canonical and Codex-alias image generation/edit paths and Responses compaction. See `mirasim-0.0.383.md` for artifact hashes. API schema cross-checks used the official image-generation guide, image edit API reference, and Responses compact reference retrieved during implementation; these schemas do not establish Mirasim model entitlement.

### Image API

`POST /v1/images/generations` and `POST /v1/images/edits`, plus `/backend-api/codex/images/...` aliases, use the normal gateway API key and the Codex signed relay agent. Non-streaming JSON requests remain raw passthrough. JSON edits use `images: [{image_url: ...}]` or existing upstream `file_id` references. Multipart edits now parse `image` / `image[]` and optional `mask` uploads into JSON data-URL references, preserving binary bytes in base64. They enforce PNG/JPEG/WebP MIME/signature checks, nonempty files, 16 MiB per-file and 16-source limits, duplicate/unknown-field rejection, and the configured total/converted-request limit. The gateway does not download caller-supplied image URLs or implement upstream file uploads.

For a Responses-backed text model such as `gpt-6-astra`, direct `stream:true` image requests now use the same model on `/v1/responses` with an explicit `image_generation` tool. Native previews map to `image_generation.partial_image` or `image_edit.partial_image`, and a completed result maps to the corresponding `.completed` event. No previews or synthetic progress are fabricated. The bridge supports one base64 image, passes mapped image options, and rejects options that cannot be faithfully translated (for example `n > 1`, hosted URL output, and unmapped fields). Image-model IDs keep their existing direct upstream route; no replacement text model is selected for them. Upstream size-option compliance is not guaranteed.

Image requests have a separate first-byte timeout (`MIRASIM_IMAGE_TIMEOUT_MS`, default 180 seconds, capped by the overall timeout). Image responses are bounded to 64 MiB overall and 32 MiB per SSE frame. Request uploads still follow `MIRASIM_MAX_REQUEST_BYTES` (default 16 MiB, maximum 64 MiB). These limits are local safeguards, not a statement of upstream limits.

### Conversation compatibility

When the top-level model is in the `gpt-image-*` or `dall-e-2`/`dall-e-3` namespace:

| Client protocol | Input | Returned output |
| --- | --- | --- |
| `/v1/chat/completions` | Last user text, optional `image_url` blocks | Assistant Markdown containing image data URLs or upstream URLs |
| `/v1/messages` | Last user text, optional Anthropic URL/base64 image blocks | Anthropic assistant text block containing image Markdown |
| `/v1/responses` | String prompt or last user `input_text` plus `input_image` blocks | `image_generation_call` results for base64 output; message output for URL-only results |

Source images select `/v1/images/edits`; text alone selects `/v1/images/generations`. No new “edit model” alias is invented. The bridge forwards image parameters from `image_options` or their top-level equivalents. It uses the last user message only: old assistant Markdown is not automatically downloaded or replayed as a source image. Send the image explicitly on every edit turn. Tools and stored-history references on a direct image-model conversation are rejected rather than silently ignored.

Conversation `stream:true` returns protocol-shaped SSE **after the final image is collected**, not live partial image previews. Use the direct Image API or a native text-model Responses `image_generation` tool for upstream progressive image events. Chat/Anthropic image Markdown is a gateway compatibility convention; client applications must support rendering it.

For example, substituting an image model actually allowed by your relay:

```json
{
  "model": "YOUR_ENTITLED_IMAGE_MODEL",
  "messages": [{"role":"user","content":[
    {"type":"text","text":"Change the background to a blue sky."},
    {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}
  ]}],
  "image_options": {"size":"1024x1024","quality":"high","input_fidelity":"high"}
}
```

### Native Responses image tools

Chat Completions and Anthropic Messages now accept `tools: [{type: "image_generation", ...}]` as a gateway extension for Responses-backed text models, including `gpt-6-astra`. The existing conversation converter retains its original prompt handling; this change does not insert, rewrite or remove system/developer instructions. Source images, prior messages, existing function/search tools and caller image-tool options are preserved through the supported mappings. Chat can select `{type: "image_generation"}`; Messages can select `{type: "tool", name: "image_generation"}` or `{type: "any"}`. Unsupported model families fail explicitly instead of silently switching models.

For Chat/Messages, each completed image becomes a Markdown data URL in assistant text, with chunked text deltas for SSE and deduplication when upstream repeats a final item. These text-protocol adapters do not expose live image previews as invented native image blocks: use Responses or the direct streaming Image API for real preview events. Clients must render image Markdown. Image-specific bounded stream/aggregate limits apply across these bridges; ordinary text defaults remain unchanged.

A text-model request on `/v1/responses` can carry `tools: [{type: "image_generation", ...}]` unchanged. Tool actions and source `input_image` blocks remain intact. Native partial events, final image items and metadata are retained. The larger image limits apply to stream priming, frame parsing, output aggregation and forwarding, not only the outer transport. Ordinary text responses retain their existing smaller limits.

Native `previous_response_id` remains owner/model scoped in the local history store. Its existing storage limits are unchanged; large image histories should use `store:false` and explicit source images instead. Upstream file IDs and encrypted data remain subject to upstream account ownership and expiry.

### Model listing

The inspected desktop bundle contains no fixed `gpt-image-*` roster, and the sampled live model-health directory did not advertise a standalone image model. Consequently none is silently added to `/v1/models`. Set `MIRASIM_IMAGE_MODELS` only to verified model IDs if a client needs explicit discovery. The setting advertises models; it does not grant entitlement. Namespace support is not proof that every matching model exists upstream.

## Standalone compaction: retired

At the user's request, `POST /v1/responses/compact` and `/backend-api/codex/responses/compact` return HTTP 410 locally after authentication. Neither upstream remote compaction nor automatic compatibility fallback is attempted. Native `/v1/responses` automatic compaction explicitly enabled by callers through `context_management` remains unchanged. See `compaction-live-verification.md` for historical test evidence and the current retirement notice.

## Other useful candidates

| Feature found in the artifact | Value | Decision |
| --- | --- | --- |
| `/v1/alpha/search` and Codex alias | Native Codex search route | Implemented as authenticated opaque JSON POST forwarding; three-protocol conversational search uses the native Responses tool instead of guessing the alpha result schema. See `search-protocol.md`. |
| `/auth/git/connections` and related authorization operations | Git identity for desktop/cloud machines | Useful only with explicit Git authorization; not part of inference compatibility. Do not forward Git credentials through public model APIs. |
| `/v1/machines/enroll-key` | Cloud-machine enrollment | Requires a separate machine lifecycle and security design; not exposed by this gateway. |
| `getNotice` / `getShareKit` desktop messages | Official notices and share assets | Optional read-only console improvement; lower priority than protocol correctness. Remote content would need URL validation and safe rendering. |
| Existing model/limits discovery | Current models and per-model availability | Already supported; preferable to hard-coded invented models. |
| New campaign and reset cards | Account management | Already adapted. The reset-card controls remain only in account rows; the removed standalone panel is not restored. |

## Verification boundaries

Tests use local mock upstreams to exercise all three conversation protocols in JSON/SSE form, editing references, native image-tool results larger than the text-frame limit, raw multipart forwarding, account authentication, compact aliases, progress detection and privacy-preserving logs. Initial deployment verification did not perform real image generation, paid inference or reset-card redemption. Read-only production directory inspection cannot prove a successful image generation.

### Subsequent user-authorized live image test

A production `POST /v1/responses` request with `model: "gpt-6-astra"`, `tools: [{type: "image_generation", quality: "low", size: "1024x1024", output_format: "png"}]`, forced image tool choice, `stream: false`, and `store: false` completed successfully in 20.5 seconds (HTTP 200). The response contained a completed `image_generation_call` with `action: "generate"` and base64 PNG data. The decoded 957,758-byte image was visually inspected and matched the requested red circle on a white background.

The actual image and returned metadata were **1536 × 1024**, despite requesting 1024 × 1024; successful generation does not establish exact size-option compliance. The image was saved locally at `/tmp/mirasim-gpt-6-astra-image-1.png`, with a sanitized report at `/tmp/mirasim-live-image-report.json`. The temporary API key was revoked. This test verifies the native Responses image tool for this model/account-pool run, not direct image-model endpoints, Chat/Anthropic image-tool translation, editing, or progressive previews.
