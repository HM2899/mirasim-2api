# Streams cut mid-answer: keepalive and stall, October 13, 2026

## Symptom

Claude Code and Codex sessions ended long answers with

```
API Error: Connection lost mid-response. The response above may be incomplete.
```

The wording is the client's own; the gateway never resets a socket mid-answer. Locally
replayed against a mock upstream, every way an upstream can die mid-stream ends in a
protocol-level terminator, never a bare close:

| Upstream failure | `/v1/messages` | `/v1/responses` |
| --- | --- | --- |
| EOF between frames | `200` + `event: error` `upstream_stream_incomplete` | `200` + `response.failed` |
| socket error | `502` + JSON | `502` + JSON |
| half a frame then error | `502` + JSON | `502` + JSON |
| half a frame then clean EOF | `200` + `event: error` | `200` + `response.failed` |
| silence, then the idle timeout | `200` + `event: error` `upstream_stream_timeout` | `200` + `response.failed` |

So the client is reading a stream that was open and healthy and then terminated without a
final event for the answer. Two gateway-side causes were reachable, and a third that is not
the gateway's to fix.

## Cause 1: only Claude requests were held open through the relay queue

`holdStreamOpen` was created for `relayAgent === "claude"` alone. The relay queues a request
before sending any header — measured at 24–37 s on an idle pool, reported afterwards as
`x-router-throttle-wait-ms` — and a GPT/Codex request was left to watch a silent socket for
that whole time, so a client idle limit fired before the upstream's first byte.

## Cause 2: once content had reached the caller, silence was fatal

After headers, `MIRASIM_STREAM_IDLE_TIMEOUT_MS` (default 300 s) bounded the wait for the next
chunk and *terminated the stream* on expiry. A retry was impossible anyway — the caller already
held part of the answer, and the comment in the handler says as much — so the only thing that
boundary could still do was throw away a live generation. Heartbeats existed on the native
Messages path, but a translated stream had none, and no stream had a heartbeat at all while the
upstream was between events.

## Cause 3: the relay itself dropping a live stream (not fixed here)

One real failure in the retained request log, `2026-10-13T03:23:05Z`:

```
model claude-opus-5-5 · 48383 ms · ttfb 7060 ms · 40786 response bytes
upstreamError: upstream_stream_incomplete
"The upstream stream ended before message_stop; the response is incomplete."
```

48 seconds and 40 KB into a live answer, the relay closed the stream without `message_stop`.
No gateway timer was involved. The gateway reported it correctly and honestly; there is nothing
to resume, because neither protocol in use carries a resume token for a partially delivered
turn. This case stays. It is distinguishable in the request log by `streamError:
upstream_error_event` with `upstreamError.code: upstream_stream_incomplete`, and by a duration
well inside every configured timeout.

## Fix

**Queue hold for every streaming protocol** (`src/server.js`). The hold no longer keys on the
agent; it applies to any `stream: true` request on `/v1/messages`, `/v1/chat/completions` or
`/v1/responses`. Image generation is excluded in all three of its forms (path, image tool,
image model): `forwardImageConversation` cannot report an in-stream failure, so committing its
status early would turn a real HTTP error into a truncated stream.

**Heartbeats downstream while the upstream is quiet** (`src/stream-lifecycle.js`,
`src/server.js`). `sseHeartbeat` wraps the bytes already on their way to the caller and pushes
its protocol's ignored heartbeat (`event: ping` on Messages, an SSE comment on Chat Completions
and Responses) when nothing has been written for `MIRASIM_STREAM_HEARTBEAT_MS` (default
15 s). It only writes between two frames — a pass-through stream arrives in chunks that may end
halfway through one — which is why it tracks the trailing bytes rather than trusting a chunk
boundary. Relay answers are registered for it in `relayRequest` by the caller's response;
local and error replies are not registered and are forwarded unchanged.

**A stall, not a silence, ends an answer** (`src/config.js`, `src/server.js`). Once an answer
has reached the caller the stream is given `MIRASIM_STREAM_STALL_TIMEOUT_MS` (default 1800 s)
instead of the idle allowance. Before its first content the stream keeps the existing
`firstContentTimeoutMs` bound, so failover still decides on the header and first-content
deadlines exactly as before — the change cannot move a request to another account or delay a
retry.

## Verification

- `test/stream-keepalive.test.js` (16 cases): six routes × a silence past the idle timeout are
  bridged and complete rather than cut; two routes still end a genuine stall with an error
  event, inside the stall deadline rather than the upstream's; three routes show a queued GPT
  request held open with the right heartbeat as its first bytes; a refusal after the commit is
  reported in-stream while a fast refusal keeps its real status; the heartbeat never lands
  inside a frame and never fires while frames keep arriving; the new settings have defaults,
  overrides and validation.
- Against the pre-change code these fail 11 of 16; the 5 that pass either way are the
  "must not change" guards.
- Full suite: 1427 pass, 10 fail — byte-identical to the baseline run without these changes
  (`test/image-protocol.test.js` imports an export its source does not have; the four native
  search cases are documented pre-existing failures).

## Deployment and live check

`mirasim-2api.service` was restarted at 12:05 CST with no in-flight requests. The environment
defines no `MIRASIM_STREAM_*` override, so the new defaults are in effect
(`streamIdleTimeoutMs 300000`, `streamStallTimeoutMs 1800000`, `streamHeartbeatIntervalMs
15000`).

The live interactive check is **outstanding**: the long-streaming request that would exercise
the heartbeat against a real relay was blocked by this session's auto-mode classifier, so the
change is verified offline only. Run it against a real quiet stream before treating the symptom
as closed:

```bash
node /tmp/probe-cut/live-gaps.mjs http://127.0.0.1:8787 <key> /v1/messages claude-opus-5-5 "<long prompt>"
```

Expected: heartbeats between the upstream's own events, a gap longer than 300 s that the
client survives, and `message_stop` rather than `event: error` at the end.
