# Claude client-identity admission — October 4, 2026

## Symptom

An ordinary API call for a Claude model failed with HTTP 403:

```json
{"error":{"message":"this client is not supported; use the mirasim client or Claude Code","type":"permission_error"}}
```

It reproduced on both routes — a native `POST /v1/messages` and an OpenAI
`POST /v1/chat/completions` that this gateway translates to Messages. GPT models
(`/v1/chat/completions` → Codex upstream) answered HTTP 200 in the same period, so
transport, device-ticket minting and signed/sealed metadata were all healthy.

## Cause

The relay admits Anthropic Messages traffic only from a client it recognizes, keyed on the
request `User-Agent`. Measured against the live relay with one account:

| `User-Agent` | Result |
| --- | --- |
| `node` (Node's fetch default, what the gateway sent) | `403 this client is not supported` |
| `curl/8.5.0`, `Bun/1.4.3`, `hello-world` | `403` |
| `claude-cli/2.1.289 (external, sdk-cli)` | admitted (reaches the model queue) |
| `Mirasim/0.0.403` | admitted |

A local echo upstream captured the gateway's real outgoing headers and confirmed
`user-agent: node`. The headers are built by `relayHeaders()` in `src/server.js`, which never
set a User-Agent, so Node's fetch supplied its default. Only the Claude (Anthropic Messages)
upstream gates this way; the Codex upstream serves GPT models regardless, which is why those
calls kept working.

This is not the same as the relay's capacity state: a *real* Claude Code client probing the
same models in the same window received `503 overloaded_error/platform_queue_full`, not `403`.
The relay accepted the client and the upstream was merely overloaded.

## Fix

A request for the Claude (or ZCode) upstream now states this gateway's own Mirasim client
identity, `Mirasim/<MIRASIM_CLIENT_VERSION>` — the same version the relay is already told in
`x-mirasim-client`. It names itself as the Mirasim client, which is what the refusal asks for,
rather than borrowing Claude Code's identity. The other agents (Codex, DeepSeek, Kimi) are not
gated on the client and are unchanged.

- `src/relay-device.js`: `mirasimClientUserAgent()` and `relayNeedsClientIdentity()`; the
  identity is set in `baseHeaders()` for the Anthropic Messages upstream only.
- `src/server.js`: `relayHeaders()` sets it for the same condition; the native-Messages
  metadata forwarding no longer forwards the caller's own `User-Agent` (it could be a refused
  value). The `x-stainless-*` and `anthropic-*` metadata a real client sends is still forwarded.

A caller's own identity is deliberately not forwarded on this path. With a single fixed
default the upstream sees one consistent client for all gateway traffic; a relay-side refusal
that still reaches the caller is then the relay's own decision about the account, not a missing
client identity.

## Scope and verification

- Offline: the full suite passes except the four documented pre-existing native-search
  assertion failures (`docs/mirasim-0.0.403-inspection.md`), unrelated to this change — those
  tests exercise the Codex upstream, which this change does not touch.
- Regression tests assert the identity is sent for the Claude upstream and not for the others,
  both through `relayHeaders()` and through the signed `headersFor()` path, and that a caller's
  arbitrary `User-Agent` is replaced rather than forwarded.
- Live: see the verification note in this session. A successful model reply was not guaranteed
  by the fix — removing the client-identity refusal restores reachability, not upstream
  capacity. A `503 platform_queue_full` after the fix means the request was admitted and the
  upstream was overloaded; it no longer carries the `403 client is not supported` classification.

## Follow-up: model health is a pure quota check (same day)

Claude model health had first been moved to the installed Claude Code CLI as a workaround for
this same `403`. The client identity removed the refusal, but the native generation probe still
needed the relay's agent-identity declaration (`400 the request was rejected as invalid` without
it, measured live) and spent allowance on every check. Model health is therefore now a uniform
`GET /v1/limits` reading for **every** model — the same check DeepSeek, Kimi, GLM and GPT rows
already used:

- No model sends a generation request; a check consumes no allowance and depends on no Messages
  admission. A healthy result means the model is reported available, not that inference ran.
- The result is one canonical row per model: status, HTTP status, latency, check time and message
  all come from that single limits reading.

Removed along the way: the `mode` query parameter, the separate `probeClaude` generation path
(and its body/identity/size helpers), the `mode: "claude-code"` markers, the
`MIRASIM_CLAUDE_CODE_*` settings, and `src/claude-code-health.js` with its three test files. The
UI shows one action, **重新检测**, for every row. Claude entries stored by the retired probes
(`mode: "claude-code"`, or an older native-generation result) are reset to pending on load — a
generation result is not a limits reading — and the next check replaces them. Regression tests
cover the reset and the limits-only request shape.
