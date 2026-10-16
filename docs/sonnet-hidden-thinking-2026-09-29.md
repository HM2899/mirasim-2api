# Sonnet 5.5 hidden-thinking timeout

## Observed failure

On September 29, 2026, native `/v1/messages` traffic for
`claude-sonnet-5-5` included successful requests as well as a long-running
request ending at 300,011 ms with a stream error. That failed request had
211 content-block deltas but no visible output. This was not evidence of
an unknown model or a routing failure.

A bounded, same-account diagnostic confirmed the upstream emits
`thinking_delta` events with an empty `thinking` string and an
`estimated_tokens` field. The short reasoning request completed successfully
with seven such deltas, followed by a signature and visible text. The
diagnostic recorded event metadata and lengths, not private prompt contents,
credentials or thinking signatures. No generated tools were executed.

## Root cause and fix

The transport guard recognized text, signatures and tool activity as progress,
but ignored positive token estimates in hidden-thinking deltas. Until a
signature or visible answer arrived, the first-content deadline stayed armed,
even when the upstream was reporting active generation.

The guard now recognizes a positive safe integer `estimated_tokens` on an
Anthropic `content_block_delta` / `thinking_delta` event as progress. This
renews the existing idle/progress allowance rather than imposing a total
generation-time limit. It does not modify the request's model, thinking
effort, display preference, tool definitions or billing counters.

Pings, missing/zero/negative/string estimates and unrelated delta types
remain non-progress. If valid thinking progress stops and only heartbeats
continue, the normal timeout still applies. Visible-output latency remains
separate from hidden generation activity.

## Regression verification

- Before the fix, both new hidden-thinking lifecycle reproductions failed
  with `upstream_stream_timeout`.
- After the fix, 89 targeted lifecycle, stalled-request and aggregation tests
  passed, including native Sonnet streaming and non-streaming responses.
- The native endpoint tests preserve the thinking signature, final text and
  actual usage while generation exceeds its initial deadline.

The production long-context request was not replayed. The live short-request
check establishes the upstream event shape, while deterministic tests establish
the timeout fix; neither guarantees that an upstream outage cannot occur.
