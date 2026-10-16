# GPT commentary through Anthropic — September 27, 2026

## Scope

Keep the existing chain: Codex Responses client → unchanged sub2api Anthropic account → this gateway's `/v1/messages` → GPT Responses upstream. No sub2api source, image, database settings, model routes, or account bindings are changed by this fix.

## Observed failure

A synthetic live comparison requested a brief progress message followed by a simulated function call. The native Responses route returned the progress message with `phase: "commentary"`. The Anthropic round trip returned an ordinary assistant message without `phase`. Both routes subsequently returned the function call and a terminal event: the observation was loss of progress-message semantics, not premature network termination.

The previously discovered HTTP 413 request-size issue is separate and does not explain this protocol-specific symptom.

## Gateway-only compatibility behavior

For GPT upstream responses delivered through `/v1/messages`, explicit `commentary` output text is translated into Anthropic `thinking` / `thinking_delta` progress content. An unchanged Anthropic-to-Responses bridge can then represent it as reasoning progress instead of an ordinary assistant answer. `final_answer` and unclassified text remain text. Tool calls, tool results, stop reasons, cancellation, and terminal-event handling are unchanged. Native `/v1/responses` and GPT Chat Completions retain their original behavior.

This is a presentation adaptation, not lossless transmission of the Responses `phase` field. Progress words may appear in the client's thinking/progress area rather than the assistant transcript; they are not newly generated private reasoning. The gateway does not insert fake tool calls, retry completed turns, or manufacture a final answer. It only redirects text whose upstream message is explicitly classified as commentary. If an upstream does not classify the message until after its text has already been streamed, the gateway cannot retroactively reclassify bytes already delivered.

## Regression coverage

- Streaming deltas, text-done, content-part events, output-item snapshots, terminal snapshots, and JSON upstream responses.
- No duplicate commentary when both incremental and final snapshots are present.
- Progress is delivered while the upstream remains open, before a delayed function call.
- Streaming and non-streaming Anthropic tool turns, tool-result continuation, and final text answers.
- Existing native Responses, Chat Completions, Anthropic error, heartbeat, and cancellation tests.

The protocol tests do not replace an interactive Codex UI check. A real-chain probe can verify that the unchanged sub2api returns reasoning for the progress message, preserves the function call, and returns ordinary text for the final answer.

## Deployment and real-chain check

The gateway-only change passed 447 focused tests and syntax/whitespace checks. Only `mirasim-2api.service` was restarted; its health check succeeded. A two-turn synthetic probe through the existing Anthropic group 13 then passed with `gpt-6-astra`:

- Progress/tool turn: HTTP 200 in approximately 3.62 seconds; output types `reasoning`, `function_call`; reasoning-summary and function-argument deltas; no assistant-answer text deltas.
- Tool-result/final turn: HTTP 200 in approximately 2.69 seconds; output type `message`; final text exactly `STATUS_PROBE_OK`.

The tool was simulated, with no generated commands executed. No sub2api changes or route changes were required. Interactive Codex status-row rendering remains a client-side verification step.
