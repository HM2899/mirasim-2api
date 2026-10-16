# Hermes Claude investigation — September 29, 2026

## Observed production chain

Hermes sends streamed Chat Completions requests to the local deployment's sub2api
ingress. At 13:18:10 China Standard Time, sub2api accepted a request for
`claude-opus-5-5` with 25 tools and forwarded it through its OpenAI account route.
This gateway recorded a matching `/v1/responses` request at 05:18:10 UTC.
At 13:18:27, sub2api returned HTTP 400 with an upstream message requiring extra
usage for third-party applications. The same pattern appears at 13:06 and 13:14.

The gateway's same-account `/v1/messages` traffic succeeded during that period.
Therefore neither a separate provider nor exhaustion of the entire account is a
supported diagnosis. Successful native requests do not establish that the failing
request is eligible for the same upstream billing or authorization treatment.
The original upstream refusal must remain visible, not be rewritten or bypassed.

The private Hermes request snapshot contains 196 messages and 25 function tools.
It passes the gateway's Chat request validator. Prompts, tool results, keys, and
the snapshot itself are not included in this document or committed tests.

## Confirmed stream error-handling defect

Independently of the production Responses route, direct streamed Chat requests
lost the `invalid_request_error` classification during Anthropic-to-Chat
translation and preflight. An upstream HTTP 200 SSE error became HTTP 502, which
could retry other accounts for a request that should have stopped at HTTP 400.
Regression tests reproduced this with an error as the first event, after a ping,
and after `message_start` but before content.

The fix preserves that classification and returns HTTP 400 before delivery,
without account failover. Errors after delivery remain readable SSE errors with
their original classification rather than successful completions. Overload
failover is unchanged. Request logs now retain an explicit HTTP rejection instead
of overwriting it with 502 merely because the refusal originated in a stream.

This fix improves compatibility and diagnosis; it does not itself resolve the
upstream refusal observed on the production Responses route.

## Verification and remaining blocker

- 214 tests pass across Chat stream, stalled-request, request-log, protocol, and
  Claude system-chain suites, using simulated upstreams.
- Two bounded live checks used one recently successful account, with no account
  rotation. Both minimal Chat baselines returned HTTP 503 with
  `no upstream available for model "claude-opus-5-5"`.
- Both checks stopped at the baseline. The private Hermes snapshot was not sent,
  and no returned tools were executed.
- End-to-end recovery is **not verified**. Once that same upstream can answer a
  baseline, compare the unchanged Hermes request through direct Chat and the
  actual Chat-to-Responses intermediary, retaining identity and access controls.

## Follow-up: 14:42 failure reproduced without sub2api

Hermes failed again at 14:42:14 CST with the same HTTP 400 error. A single
controlled replay used that latest private request snapshot and the same upstream
account recorded for the failed production request. It bypassed sub2api and used
this gateway's `/v1/chat/completions` directly, preserving the client's prompts,
tools, history, and generation parameters. Streaming was enabled as in Hermes's
actual SDK call; no alternative identity or account was tried.

The translated upstream request had 158 messages and 25 tools, adaptive thinking,
and `output_config.effort: xhigh`. The upstream returned HTTP 200 SSE containing an
`invalid_request_error` with the same third-party extra-usage requirement. The
patched gateway correctly returned HTTP 400 before delivering any content or tool
calls. No tools were executed.

This disproves the intermediary conversion as a necessary cause of this failure.
It also distinguishes an explicit upstream refusal from a broken transport or an
unparseable stream. The exact upstream eligibility/classification rule is not
known, and successful native requests do not explain that rule. Further streaming
changes alone cannot make this rejected request succeed. Resolution requires
upstream confirmation of authorized third-party access for this request, not
masking its identity or changing the refusal into a successful response.
