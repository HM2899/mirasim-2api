# Image protocol improvements without prompt changes

## Implemented

- Chat Completions and Anthropic Messages accept the hosted `image_generation` tool for Responses-backed text models. The original model is retained. Conversation image references are converted using the existing protocol converters, and completed image results are returned as deduplicated Markdown data URLs in assistant text. Both JSON and SSE are supported.
- Direct Images requests with `stream:true` and a Responses-backed text model use the native Responses image tool and translate actual partial/completed image events. The adapter never fabricates previews. Client cancellation releases the upstream reader.
- Multipart edits convert uploaded PNG/JPEG/WebP source images and optional masks to JSON data-URL references. File signatures, file count/size, total request size, duplicate fields and field types are checked. Uploaded bytes are base64 encoded without resizing or recompression.
- Image-specific limits are carried through request relay, Responses parsing, Chat aggregation/preflight and Anthropic conversion. Ordinary text limits are unchanged.

No system/developer/instructions rewriting or existing prompt-normalization logic was changed. Tests assert exact system text on both conversational bridges and absence of injected instructions on direct image streaming. Retired remote compaction remains retired.

## Client examples

Chat Completions:

```json
{
  "model": "gpt-6-astra",
  "messages": [{"role":"user","content":"Draw a red circle on white."}],
  "tools": [{"type":"image_generation","action":"generate","quality":"low"}],
  "tool_choice": {"type":"image_generation"},
  "stream": true
}
```

For Messages, use the same `messages` and tool declaration, add `max_tokens`, and select `tool_choice: {"type":"tool","name":"image_generation"}` or `{"type":"any"}`. For edits, use `action:"edit"` and provide the source image in the corresponding protocol's image content block. Existing client functions and supported hosted search tools may coexist.

Direct Images streaming:

```json
{
  "model": "gpt-6-astra",
  "prompt": "Draw a red circle on white.",
  "quality": "low",
  "stream": true,
  "partial_images": 1
}
```

Send to `/v1/images/generations`; edits use `/v1/images/edits` with JSON `images` or multipart `image`/`image[]`. Codex aliases share the same handlers. No server-side download of supplied URLs is performed.

## Boundaries

- Chat/Messages image Markdown is a gateway extension, not a claim that their native assistant schemas include generated-image blocks. Their SSE carries the final image in text chunks, not progressive image previews. Use Responses or direct Images SSE for previews.
- Direct streaming translation supports one base64 image and mapped options. Untranslatable options return 400 instead of being ignored. Explicit image-model IDs are not replaced with a guessed text model; they retain the existing direct route.
- The upstream can return no preview even when one was requested, and can return dimensions different from the requested size. The gateway reports actual results without resizing them.
- Multipart signature validation is not a complete image decoder or malware scanner. Per-file maximum is 16 MiB, at most 16 source images, and both received and converted bodies obey the configured request limit.
- Search citation improvements, general parameter diagnostics and broad retry-policy changes remain outside this patch.

## Verification and deployment

The final full regression suite passed **1,144 tests**. Targeted coverage includes 3 MiB image payloads on both conversational bridges, exact prompt text, multipart byte preservation and rejection paths, preview-before-completion behavior, failure events, and upstream cancellation.

Live retesting used `gpt-6-astra` throughout, without model substitution:

| Operation | JSON | SSE |
| --- | --- | --- |
| Chat generation | PASS, 20.8 s | PASS, 19.7 s |
| Chat editing | PASS | PASS, 22.3 s |
| Messages generation | PASS, 19.5 s | PASS, 20.8 s |
| Messages editing | PASS, 23.3 s | PASS, 23.7 s |
| Direct Images generation | Existing baseline retained | PASS, 24.6 s, real preview and completed events |
| Direct Images editing | Existing baseline retained | PASS, 25.5 s, real preview and completed events |
| Multipart editing | PASS, 19.5 s | Not separately live tested |

All 11 selected post-change cases returned HTTP 200, valid PNG output and their requested response format. Chat, Messages and multipart edited examples were visually checked and correctly changed the red circle to blue. The original Responses route and Codex aliases retain mock regression coverage and their earlier live baseline; they were not redundantly regenerated in this retest. Masks, other image formats and every tool combination were not live-tested. Requested 1024 × 1024 sizes still returned 1254 × 1254 generation / 1536 × 1024 editing results upstream.

The service was restarted with the final cancellation fix before the direct-stream and multipart retests. The initial long-running probe was interrupted after the eight conversational cases; its abandoned temporary key was revoked and only the remaining cases resumed. All temporary retest keys were removed. Reports and output images: `/tmp/mirasim-image-p0-retest/`. Standalone compaction remains HTTP 410.
