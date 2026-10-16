# Compaction live verification: gpt-6-astra

## Current status: standalone compaction retired

At the user's request, both standalone `/responses/compact` paths now return HTTP 410 locally after authentication. They do not contact the upstream or run a compatibility fallback. The fallback implementation has been removed. Native Responses automatic compaction explicitly requested via `context_management` remains unchanged. The observations and compatibility-fix results below are historical, not the current endpoint behavior.

User-authorized production verification covered two distinct mechanisms. The initial observations below preceded the compatibility fix described at the end.

## Initial standalone compact endpoint: unavailable

Both requests used `model: "gpt-6-astra"`, explicit synthetic message history (24,302 JSON bytes), and instructions to retain four exact project-state fields.

| Path | HTTP status | Duration |
| --- | --- | --- |
| `/v1/responses/compact` | 503 | 8.35 s |
| `/backend-api/codex/responses/compact` | 503 | 8.87 s |

Both returned the upstream error `remote compaction is unavailable for this session right now`. No compacted output was returned, so standalone-result continuation could not be tested. Route forwarding being implemented does not establish upstream availability. The test did not determine why these sessions lack standalone compaction.

## Automatic Responses compaction: passed

Separate requests to `/v1/responses` used `context_management: [{type: "compaction", compact_threshold: 1024}]`, `store: false`, and 76,099 bytes of synthetic history. Four random/explicit facts appeared only in early assistant history. The current prompt requested only READY, not repetition of the facts.

| Mode | HTTP | Duration | Compaction output items | Subsequent recall |
| --- | --- | --- | --- | --- |
| JSON | 200 | 13.87 s | 2, with nonempty encrypted content | All four fields recovered |
| SSE | 200 | 15.76 s | 2, with nonempty encrypted content | All four fields recovered |

For each continuation, the test removed the entire original history and used only output starting at the latest compaction item plus a new question. Both continuations returned HTTP 200 and completed normally. The synthetic project identifier, random pin, color, and port were recovered. Original input bytes fell from 76,099 to 4,902 (JSON case) / 4,646 (SSE case), including the new question. Reported input tokens changed from approximately 15,650 to 1,008 / 972; these are observed turn sizes, not a controlled billing-savings estimate.

The threshold of 1,024 was a test trigger, not a production recommendation. This verifies explicitly enabled automatic compaction on the native Responses route, not automatic activation for every conversation, Chat/Anthropic bridging, client-side auto-compaction, or standalone `/compact` availability. No `/compact` fallback was used for the automatic tests.

Sanitized results: `/tmp/mirasim-manual-compaction-report.json` and `/tmp/mirasim-auto-compaction-report.json`. Temporary keys for both tests were revoked. Opaque compaction payloads were not retained in the reports.

## Compatibility fix and successful retest

The gateway still tries the native compact endpoint first. Only an HTTP 503 with the exact upstream message `remote compaction is unavailable for this session right now` triggers a fallback, on the same account and signed relay session, to native Responses automatic compaction. Other native successes and errors remain unchanged.

The fallback returns `response.compaction` with the latest genuine encrypted compaction item and actual upstream usage. `x-mirasim-compaction-mode: automatic-fallback` identifies this compatibility path. A one-turn user acknowledgement is used to avoid executing pending work; it is not imposed as a permanent instruction. The first implementation's permanent READY instruction affected continuation and was corrected before the final successful test.

| Retest | HTTP | Duration | Output JSON bytes | Ordinary / SSE continuation |
| --- | --- | --- | --- | --- |
| `/v1/responses/compact` | 200 | 8.70 s | 3,670 | Both recovered all four exact facts |
| `/backend-api/codex/responses/compact` | 200 | 8.51 s | 3,630 | Both recovered all four exact facts |

Both inputs were 24,302 JSON bytes. The four continuation requests omitted the original history entirely, used the returned output and a new question, and completed successfully. Temporary retest keys were revoked. The final retest log is `/tmp/mirasim-compact-fixed-v2-live.log`.

### Compatibility boundaries

- This is a gateway fallback, not a repair of the upstream native compact service or a guarantee of identical compaction semantics.
- Fallback is restricted to Responses-backed text models and requests containing only `model`, `input`, `instructions`, and optional non-streaming `stream`. Extra fields are not silently discarded; such requests retain the native result.
- Automatic compaction currently uses a 1,024-token trigger. If no real encrypted compaction item is produced (for example, a short history), the gateway returns an explicit 502 instead of inventing an item or reporting a false success.
- A failed fallback is not replayed across the account pool, avoiding repeated paid maintenance turns. Existing native error handling is otherwise unchanged.
- The fallback adds one automatic maintenance generation and reports its usage. Callers should continue using the returned compacted output explicitly, not infer a stored-history ID from the compact response.
