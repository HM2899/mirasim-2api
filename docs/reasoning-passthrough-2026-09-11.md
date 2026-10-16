# Reasoning passthrough — September 11, 2026

## Failure

Kimi requests could show a requested `high` level but an outgoing level of `off`.
The Messages-to-Chat bridge omitted thinking and effort fields, while the
Responses-to-Chat allowlist discarded them. Request logging also treated missing
settings as evidence of disabled thinking. Separately, managed reasoning policies
normalized or raised Claude/GPT levels and disabled some translated Claude turns
when signed thinking history was unavailable.

## Change

The default `MIRASIM_REASONING_MODE=passthrough` preserves explicit native settings
and does not inject defaults, enforce minimum effort, or silently disable thinking
because of history. Existing default/floor environment variables only take effect
with `MIRASIM_REASONING_MODE=managed`, the explicit compatibility rollback.

Cross-protocol bridges map effort fields to the target protocol. They keep effort
names instead of guessing a supported rung. Budget-based Claude models still need
a budget mapping; an unconvertible name produces a descriptive local error rather
than silently dropping the request's thinking preference.

Kimi Chat reasoning survives JSON/SSE translation and tool-history replay. Bridged
Messages thinking blocks do not fabricate Anthropic signatures. Responses summaries
are replayed as Chat reasoning, while native GPT encrypted reasoning stays on the
native Responses path. UTF-8 fragments are retained across SSE chunks.

The UI now says “上游思考参数”. Missing outgoing settings are “未指定（上游默认）”,
not “关闭”; the displayed setting is not proof of the provider's actual effort.

## Validation

Local integration tests cover native Claude/GPT/Kimi/DeepSeek settings, cross-protocol
effort mapping, explicit disabling, defaults/floors remaining inactive, request-log
accuracy, tool-history replay, and fragmented UTF-8 reasoning streams. Legacy managed
mode and the previous Kimi timeout fix retain regression coverage.

An approved, single-account live probe sent `reasoning_effort: "high"` together with
`thinking: { type: "enabled" }` to the Kimi relay. It returned HTTP 200 in 4223 ms,
with 51 reasoning characters and a three-character answer. Request ID:
`186fad29d98bec6a5eaa85ffcd1d20fc`. There was no retry or account switch.
This establishes acceptance and returned reasoning for that parameter combination,
not a guarantee that every effort name is supported or that `high` increases compute.
