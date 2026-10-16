import assert from "node:assert/strict";
import test from "node:test";
import { RelayRequestLog } from "../src/request-log.js";

test("image streams report image protocol, first output and completion without storing image data", async () => {
  let now = 1000;
  const log = new RelayRequestLog({ now: () => now });
  const entry = log.open("/v1/images/edits", '{"model":"gpt-image-1","stream":true}');
  now = 1100;
  log.recordFirstOutput(entry, 'data: {"type":"image_edit.partial_image","b64_json":"private-image"}');
  const tracked = log.observe(entry, new Response('data: {"type":"image_edit.completed","b64_json":"private-image","usage":{"input_tokens":3,"output_tokens":7}}\n\n', { headers: { "content-type": "text/event-stream" } }));
  await tracked.text();
  assert.equal(entry.firstOutputMs, 100);
  assert.equal(entry.protocol, "OpenAI Images");
  assert.equal(entry.stage, "completed");
  assert.equal(entry.outputTokens, 7);
  assert.doesNotMatch(JSON.stringify(log.snapshot()), /private-image/);
});

test("preflight stream errors retain the HTTP rejection status", () => {
  for (const status of [400, 401, 429, 502]) {
    const log = new RelayRequestLog();
    const entry = log.open("/v1/chat/completions", '{"model":"claude-opus-5-5","stream":true}');
    entry.streamError = "upstream_stream_error";
    entry.stage = "failed";
    log.fail(entry, status);
    assert.equal(log.snapshot()[0].status, status);
  }
});

test("raw GPT timings survive delayed preflight and separate reasoning from visible text", async () => {
  let now = 1000;
  const log = new RelayRequestLog({ now: () => now });
  const entry = log.open("/v1/chat/completions", '{"model":"gpt-test","stream":true}');
  now = 1020;
  log.recordFirstByte(entry);
  log.recordFirstOutput(entry, 'data: {"type":"response.created"}');
  assert.equal(entry.firstOutputMs, null);
  now = 1100;
  log.recordFirstOutput(entry, 'data: {"type":"response.reasoning_summary_text.delta","delta":"private reasoning"}');
  assert.equal(entry.firstOutputMs, 100);
  assert.equal(entry.firstTextMs, null);
  now = 1200;
  const frame = 'data: {"type":"response.output_text.done","text":"private answer"}\n\n';
  log.recordFirstOutput(entry, frame);
  now = 1900;
  await log.observe(entry, new Response(frame, { headers: { "content-type": "text/event-stream" } })).text();
  assert.equal(entry.ttfbMs, 20);
  assert.equal(entry.firstOutputMs, 100);
  assert.equal(entry.firstTextMs, 200);
  assert.equal(entry.durationMs, 900);
  assert.doesNotMatch(JSON.stringify(log.snapshot()), /private reasoning|private answer/);
});

test("timing probes ignore malformed frame shapes and heartbeats", () => {
  const log = new RelayRequestLog();
  const entry = log.open("/v1/responses", "{}");
  for (const frame of [": ping", "data: [DONE]", "data: {", 'data: {"choices":{},"response":{"output":{}}}', 'data: {"type":123,"item":{"type":123,"summary":{}}}']) {
    assert.doesNotThrow(() => log.recordFirstOutput(entry, frame));
  }
  assert.equal(entry.firstOutputMs, null);
  assert.equal(entry.firstTextMs, null);
});

test("request logs separate incoming and upstream protocols without retaining request contents", () => {
  const log = new RelayRequestLog();
  const entry = log.open("/backend-api/codex/responses", JSON.stringify({ model: "claude-test", input: "private prompt" }), "{}", { upstreamPath: "/v1/messages", requestId: "req_local" });
  assert.equal(entry.path, "/backend-api/codex/responses");
  assert.equal(entry.clientPath, entry.path);
  assert.equal(entry.protocol, "OpenAI Responses");
  assert.equal(entry.upstreamProtocol, "Anthropic");
  assert.equal(entry.upstreamPath, "/v1/messages");
  assert.equal(entry.requestId, "req_local");
  assert.doesNotMatch(JSON.stringify(log.snapshot()), /private prompt/);
});

test("GPT request logs retain bounded title diagnostics but no prompt text", () => {
  const log = new RelayRequestLog();
  log.open("/v1/messages", JSON.stringify({ model: "gpt-6-astra", messages: [{ role: "user", content: "private prompt" }] }));
  const [entry] = log.snapshot();
  assert.equal(entry.codexTitleDiagnostics.messageCount, 1);
  assert.equal(entry.codexTitleDiagnostics.messages[0].text[0].titleMarkerOffset, -1);
  assert.doesNotMatch(JSON.stringify(entry), /private prompt/);
});

test("an upstream JSON refusal records its request ID without retaining prompts or raw errors", async () => {
  const log = new RelayRequestLog();
  const entry = log.open("/v1/messages", JSON.stringify({ model: "claude-opus-4-6", messages: [{ role: "user", content: "private prompt" }] }));
  const payload = { error: { message: "private upstream error", type: "invalid_request_error" }, request_id: "a7151a92d5568ed5e5b48df5e4aa3981", type: "error" };
  const response = log.observe(entry, Response.json(payload, { status: 400 }));
  assert.deepEqual(await response.json(), payload);
  const [snapshot] = log.snapshot();
  assert.equal(snapshot.status, 400);
  assert.equal(snapshot.upstreamRequestId, payload.request_id);
  assert.deepEqual(snapshot.upstreamError, { type: "invalid_request_error" });
  assert.doesNotMatch(JSON.stringify(snapshot), /private prompt|private upstream error/);
});

for (const format of ["JSON", "plain text"]) {
  test(`a ${format} permission refusal records sanitized details without changing the response`, async () => {
    const log = new RelayRequestLog();
    const entry = log.open("/v1/messages", "{}");
    const message = "this client is not supported; Bearer private-token sk-private-key sess-private-session\nuse the supported client";
    const error = { type: "permission_error", code: "client_not_supported", message, credentials: "private extra field" };
    const body = format === "JSON" ? JSON.stringify({ error }) : message;
    const headers = { "content-type": format === "JSON" ? "application/json" : "text/plain; charset=utf-8", "x-request-id": "req_denial" };
    const observed = log.observe(entry, new Response(body, { status: 403, headers }));
    assert.equal(observed.status, 403);
    assert.equal(await observed.text(), body);
    const [snapshot] = log.snapshot();
    assert.equal(snapshot.upstreamStatus, 403);
    assert.equal(snapshot.upstreamRequestId, "req_denial");
    assert.equal(snapshot.upstreamError.message, "this client is not supported; Bearer [redacted] [redacted] [redacted] use the supported client");
    if (format === "JSON") {
      assert.equal(snapshot.upstreamError.type, error.type);
      assert.equal(snapshot.upstreamError.code, error.code);
    }
    assert.doesNotMatch(JSON.stringify(snapshot), /private-token|sk-private-key|sess-private-session|private extra field/);
  });
}

test("permission refusal messages are bounded", async () => {
  const log = new RelayRequestLog();
  const entry = log.open("/v1/messages", "{}");
  const body = "x".repeat(2000);
  const observed = log.observe(entry, new Response(body, { status: 403, headers: { "content-type": "text/plain" } }));
  assert.equal(await observed.text(), body);
  assert.equal(log.snapshot()[0].upstreamError.message.length, 1000);
});

test("oversized permission errors pass through without being retained", async () => {
  for (const chunked of [false, true]) {
    const log = new RelayRequestLog();
    const entry = log.open("/v1/messages", "{}");
    const body = "x".repeat(64 * 1024 + 1);
    const source = chunked ? new ReadableStream({
      start(controller) {
        const bytes = new TextEncoder().encode(body);
        controller.enqueue(bytes.slice(0, 32 * 1024));
        controller.enqueue(bytes.slice(32 * 1024));
        controller.close();
      }
    }) : body;
    const observed = log.observe(entry, new Response(source, { status: 403, headers: { "content-type": "text/plain" } }));
    assert.equal(await observed.text(), body);
    assert.equal(log.snapshot()[0].upstreamError, null);
  }
});

test("HTML errors and successful plain text are not retained as error details", async () => {
  for (const [status, contentType] of [[403, "text/html"], [200, "text/plain"]]) {
    const log = new RelayRequestLog();
    const entry = log.open("/v1/messages", "{}");
    const body = "private response content";
    const observed = log.observe(entry, new Response(body, { status, headers: { "content-type": contentType } }));
    assert.equal(await observed.text(), body);
    assert.equal(log.snapshot()[0].upstreamError, null);
    assert.doesNotMatch(JSON.stringify(log.snapshot()), /private response content/);
  }
});

test("request log prefers a response header request ID and rejects malformed identifiers", async () => {
  for (const header of ["req_header-123", "not an identifier", "x".repeat(129)]) {
    const log = new RelayRequestLog();
    const entry = log.open("/v1/messages", "{}");
    const response = log.observe(entry, Response.json({ request_id: "req_body-456" }, { headers: { "x-request-id": header } }));
    await response.json();
    assert.equal(log.snapshot()[0].upstreamRequestId, header === "req_header-123" ? header : "req_body-456");
  }
});

function sseUpstream(frames, contentType = "text/event-stream") {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    body: new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      }
    })
  };
}

test("active Responses requests expose stages without retaining arguments or reasoning text", async () => {
  let upstreamController;
  const log = new RelayRequestLog();
  const entry = log.open("/v1/responses", JSON.stringify({ model: "gpt-test", input: "private prompt" }));
  assert.equal(log.snapshot()[0].stage, "waiting_headers");
  const upstream = new Response(new ReadableStream({ start(controller) { upstreamController = controller; } }), { headers: { "content-type": "text/event-stream" } });
  const observed = log.observe(entry, upstream);
  const reader = observed.body.getReader();
  const send = async (event) => {
    upstreamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    await reader.read();
    return log.snapshot()[0];
  };
  let snapshot = await send({ type: "response.output_item.added", item: { id: "rs_1", type: "reasoning", encrypted_content: "private encrypted thought" } });
  assert.equal(snapshot.pending, true);
  assert.equal(snapshot.stage, "reasoning");
  snapshot = await send({ type: "response.reasoning_summary_text.delta", delta: "private summary" });
  assert.equal(snapshot.reasoningCharacters, 15);
  snapshot = await send({ type: "response.output_item.added", item: { id: "fc_1", type: "function_call", name: "read_file", arguments: "private arguments" } });
  assert.equal(snapshot.stage, "tool_call");
  assert.deepEqual(snapshot.calledTools, ["read_file"]);
  assert.equal(snapshot.lastEvent, "response.output_item.added");
  assert.equal(snapshot.eventCounts["response.output_item.added"], 2);
  assert.ok(snapshot.elapsedMs >= 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /private prompt|private encrypted|private summary|private arguments/);
  await send({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3 } } });
  upstreamController.close();
  await reader.read();
  assert.equal(log.snapshot().length, 1);
  assert.equal(log.snapshot()[0].pending, false);
  assert.equal(log.snapshot()[0].stage, "completed");
});

test("a body timeout is logged as a stream failure rather than HTTP 200 success", async () => {
  const log = new RelayRequestLog();
  const entry = log.open("/v1/responses", "{}");
  const observed = log.observe(entry, new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error("private failure"), { code: "upstream_stream_timeout" })); } }), { headers: { "content-type": "text/event-stream" } }));
  await assert.rejects(observed.text(), /private failure/);
  log.fail(entry, 200);
  const snapshot = log.snapshot()[0];
  assert.equal(snapshot.status, 502);
  assert.equal(snapshot.streamError, "upstream_stream_timeout");
  assert.equal(snapshot.stage, "failed");
  assert.equal(snapshot.pending, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /private failure/);
});

test("upstream cancellation after a terminal event does not overwrite successful usage", async () => {
  let upstreamController;
  const log = new RelayRequestLog();
  const entry = log.open("/v1/messages", "{}");
  const upstream = new Response(new ReadableStream({ start(controller) { upstreamController = controller; } }), { headers: { "content-type": "text/event-stream" } });
  const reader = log.observe(entry, upstream).body.getReader();
  upstreamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3 } } })}\n\n`));
  await reader.read();
  upstreamController.error(new Error("Upstream cancelled after terminal"));
  assert.equal((await reader.read()).done, true);
  const [snapshot] = log.snapshot();
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.stage, "completed");
  assert.equal(snapshot.streamError, null);
  assert.equal(snapshot.outputTokens, 3);
  assert.equal(snapshot.pending, false);
});

test("normal cleanup after a terminal Chat chunk is not logged as cancelled HTTP 200", async () => {
  let upstreamController;
  const log = new RelayRequestLog();
  const entry = log.open("/v1/chat/completions", "{}");
  const observed = log.observe(entry, new Response(new ReadableStream({
    start(controller) { upstreamController = controller; }
  }), { headers: { "content-type": "text/event-stream" } }));
  const reader = observed.body.getReader();

  upstreamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }]
  })}\n\n`));
  await reader.read();
  await reader.cancel();

  const [snapshot] = log.snapshot();
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.stage, "completed");
  assert.equal(snapshot.finishReason, "stop");
  assert.equal(snapshot.pending, false);
});

test("normal cleanup after an incomplete terminal event keeps the incomplete outcome", async () => {
  let upstreamController;
  const log = new RelayRequestLog();
  const entry = log.open("/v1/responses", "{}");
  const observed = log.observe(entry, new Response(new ReadableStream({
    start(controller) { upstreamController = controller; }
  }), { headers: { "content-type": "text/event-stream" } }));
  const reader = observed.body.getReader();

  upstreamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
    type: "response.incomplete", response: { usage: { input_tokens: 1, output_tokens: 1 } }
  })}\n\n`));
  await reader.read();
  await reader.cancel();

  const [snapshot] = log.snapshot();
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.stage, "incomplete");
  assert.equal(snapshot.pending, false);
});

for (const [event, stage] of [
  [{ type: "message_stop" }, "completed"],
  [{ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } }, "completed"],
  [{ type: "response.incomplete", response: { usage: { input_tokens: 10, output_tokens: 2 } } }, "incomplete"],
  [{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }, "completed"]
]) {
  test(`downstream close after ${event.type || "Chat completion"} does not change the terminal outcome to 499`, async () => {
    const log = new RelayRequestLog();
    const entry = log.open("/v1/messages", "{}");
    const reader = log.observe(entry, new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`)); }
    }), { headers: { "content-type": "text/event-stream" } })).body.getReader();
    await reader.read();
    log.fail(entry, 499);
    await reader.cancel();
    log.fail(entry, 499);
    const [snapshot] = log.snapshot();
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.stage, stage);
    assert.equal(snapshot.streamError, null);
    assert.equal(snapshot.pending, false);
  });
}

test("a real mid-stream disconnect remains 499 after abort errors arrive", async () => {
  const log = new RelayRequestLog();
  const entry = log.open("/v1/messages", "{}");
  let source;
  const reader = log.observe(entry, new Response(new ReadableStream({
    start(controller) { source = controller; }
  }), { headers: { "content-type": "text/event-stream" } })).body.getReader();
  source.enqueue(Buffer.from('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n'));
  await reader.read();
  log.fail(entry, 499);
  source.error(new DOMException("Disconnected", "AbortError"));
  await reader.read();
  const [snapshot] = log.snapshot();
  assert.equal(snapshot.status, 499);
  assert.equal(snapshot.stage, "client_disconnected");
  assert.equal(snapshot.streamError, null);
  assert.equal(snapshot.pending, false);
});

test("late frames cannot overwrite an already finalized real disconnect", async () => {
  const log = new RelayRequestLog();
  const entry = log.open("/v1/messages", "{}");
  let source;
  const reader = log.observe(entry, new Response(new ReadableStream({ start(controller) { source = controller; } }), {
    headers: { "content-type": "text/event-stream" }
  })).body.getReader();
  log.fail(entry, 499);
  source.enqueue(Buffer.from('data: {"type":"message_stop"}\n\n'));
  source.close();
  while (!(await reader.read()).done) {}
  const [snapshot] = log.snapshot();
  assert.equal(snapshot.status, 499);
  assert.equal(snapshot.stage, "client_disconnected");
  assert.equal(snapshot.lastEvent, null);
});

test("request log captures model, reasoning effort and anthropic stream usage with timings", async () => {
  // now() is consumed in call order: open, first body chunk, finalize.
  const times = [1_000, 1_000, 1_400, 1_900];
  const log = new RelayRequestLog({ now: () => (times.length > 1 ? times.shift() : times[0]) });
  const body = Buffer.from(JSON.stringify({ model: "claude-fable-5", stream: true, thinking: { type: "enabled", budget_tokens: 8192 } }));
  const entry = log.open("/v1/messages", body);
  assert.equal(entry.model, "claude-fable-5");
  assert.equal(entry.reasoningEffort, "budget:8192");
  assert.equal(entry.stream, true);
  assert.equal(log.snapshot()[0].pending, true);

  const wrapped = log.observe(entry, sseUpstream([
    `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 120, cache_read_input_tokens: 90, cache_creation_input_tokens: 30 } } })}\n\n`,
    // Anthropic repeats the usage object on the delta and zeroes the counts it already sent.
    `data: ${JSON.stringify({ type: "message_delta", usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 60 } })}\n\n`
  ]), { id: "user-a" });
  await new Response(wrapped.body).text();

  const [snapshot] = log.snapshot();
  assert.equal(snapshot.account, "user-a");
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.pending, false);
  assert.equal(snapshot.inputTokens, 120);
  assert.equal(snapshot.outputTokens, 60);
  assert.equal(snapshot.cacheReadTokens, 90);
  assert.equal(snapshot.cacheWriteTokens, 30);
  assert.equal(snapshot.inputTokenSemantics, "exclusive_cache");
  assert.equal(snapshot.uncachedInputTokens, 120);
  assert.equal(snapshot.ttfbMs, 400);
  assert.equal(snapshot.durationMs, 900);
  assert.equal("outputTokensPerSecond" in snapshot, false);
  assert.equal("startedAt" in snapshot, false);
});

test("request log parses non-stream chat completion usage and openai effort", async () => {
  const times = [0, 250, 300];
  const log = new RelayRequestLog({ now: () => (times.length > 1 ? times.shift() : times[0]) });
  const entry = log.open("/v1/chat/completions", Buffer.from(JSON.stringify({ model: "gpt-5", reasoning_effort: "high" })));
  assert.equal(entry.reasoningEffort, "high");
  assert.equal(entry.stream, false);

  const payload = { usage: { prompt_tokens: 200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 150 } } };
  const wrapped = log.observe(entry, sseUpstream([JSON.stringify(payload)], "application/json"), { id: "user-b" });
  assert.deepEqual(await wrapped.json(), payload);

  const [snapshot] = log.snapshot();
  assert.equal(snapshot.inputTokens, 200);
  assert.equal(snapshot.outputTokens, 40);
  assert.equal(snapshot.cacheReadTokens, 150);
  assert.equal(snapshot.cacheWriteTokens, null);
  assert.equal(snapshot.inputTokenSemantics, "inclusive_cache");
  assert.equal(snapshot.uncachedInputTokens, 50);
  assert.equal(snapshot.ttfbMs, 250);
  assert.equal(snapshot.durationMs, 300);
});

for (const path of ["/v1/messages", "/v1/chat/completions", "/v1/responses"]) {
  for (const stream of [false, true]) {
    test(`request log counts native DeepSeek cache hits on ${path} (stream=${stream})`, async () => {
      const log = new RelayRequestLog();
      const entry = log.open(path, Buffer.from(JSON.stringify({ model: "deepseek-flash", stream })));
      const payload = { usage: { prompt_tokens: 100, completion_tokens: 2, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } };
      const frames = stream ? [
        `data: ${JSON.stringify(payload)}\n\n`,
        'data: {"usage":{"prompt_tokens":0,"completion_tokens":3,"prompt_cache_hit_tokens":0}}\n\n',
        "data: [DONE]\n\n"
      ] : [JSON.stringify(payload)];
      const wrapped = log.observe(entry, sseUpstream(frames, stream ? "text/event-stream" : "application/json"), { id: "account-a" });
      await wrapped.text();
      const [snapshot] = log.snapshot();
      assert.equal(snapshot.inputTokens, 100);
      assert.equal(snapshot.cacheReadTokens, 80);
      assert.equal(snapshot.uncachedInputTokens, 20);
      assert.equal(snapshot.cacheWriteTokens, null);
      assert.equal(snapshot.inputTokenSemantics, "inclusive_cache");
      assert.equal(snapshot.outputTokens, stream ? 3 : 2);
    });
  }
}

test("a tool call is logged whether the upstream answered in Anthropic or OpenAI shape", async () => {
  // DeepSeek and Kimi are served on chat completions whichever protocol the client spoke, so
  // an answer on the bridged path names its calls under `function` rather than on a block.
  // Without this the console cannot tell a model that never reached for a tool from one whose
  // call was dropped on the way back — the symptom looks identical from outside.
  const streamed = new RelayRequestLog();
  const entry = streamed.open("/v1/messages", Buffer.from(JSON.stringify({ model: "kimi-k3", stream: true })));
  const wrapped = streamed.observe(entry, sseUpstream([
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read_file", arguments: "" } }] } }] })}\n\n`,
    // The fragments that follow carry arguments and no name, so the tool is counted once.
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] })}\n\n`
  ]));
  await new Response(wrapped.body).text();
  assert.deepEqual(streamed.snapshot()[0].calledTools, ["read_file"]);

  const whole = new RelayRequestLog();
  const wholeEntry = whole.open("/v1/messages", Buffer.from(JSON.stringify({ model: "kimi-k3" })));
  const completion = { choices: [{ message: { tool_calls: [{ id: "call_b", function: { name: "list_dir" } }] } }] };
  const answered = whole.observe(wholeEntry, sseUpstream([JSON.stringify(completion)], "application/json"));
  await answered.json();
  assert.deepEqual(whole.snapshot()[0].calledTools, ["list_dir"]);
});

test("request log records failures and keeps only the newest entries", () => {
  const log = new RelayRequestLog({ maxEntries: 2, now: () => 0 });
  const first = log.open("/v1/messages", Buffer.from("{}"));
  log.fail(first, 400);
  const failed = log.open("/v1/messages", Buffer.from("not json"));
  log.fail(failed, 503);
  const third = log.open("/v1/messages", Buffer.from(JSON.stringify({ model: "claude-fable-5" })));

  const snapshot = log.snapshot();
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0].pending, true);
  assert.equal(snapshot[0].id, third.id);
  assert.equal(snapshot[1].status, 503);
  assert.equal(snapshot.some((entry) => entry.id === first.id), false);
});

test("request log keeps every priority-aware failover attempt", async () => {
  const log = new RelayRequestLog({ now: () => 0 });
  const entry = log.open("/v1/messages", Buffer.from(JSON.stringify({ model: "claude-sonnet-5" })));
  log.attempt(entry, { id: "priority-100-a" }, 100, 503);
  log.attempt(entry, { id: "priority-100-b" }, 100, 503);
  log.attempt(entry, { id: "priority-60" }, 60, 200);
  await log.observe(entry, sseUpstream([JSON.stringify({ content: [] })], "application/json"), { id: "priority-60" }).json();

  const [snapshot] = log.snapshot();
  assert.deepEqual(snapshot.attempts.map(({ account, priority, status }) => ({ account, priority, status })), [
    { account: "priority-100-a", priority: 100, status: 503 },
    { account: "priority-100-b", priority: 100, status: 503 },
    { account: "priority-60", priority: 60, status: 200 }
  ]);
});

test("a thinking budget, a disabled request and a model-chosen effort all normalise", () => {
  const log = new RelayRequestLog({ now: () => 0 });
  const effortOf = (payload) => log.open("/v1/messages", Buffer.from(JSON.stringify(payload))).reasoningEffort;
  assert.equal(effortOf({ thinking: { type: "disabled" } }), "none");
  assert.equal(effortOf({ thinking: { type: "adaptive" } }), "adaptive");
  assert.equal(effortOf({ thinking: { type: "enabled" } }), "enabled");
  assert.equal(effortOf({ reasoning: { effort: "High" } }), "high");
  assert.equal(effortOf({}), null);
});

test("the logged thinking level is the one the model was told, not the one the caller asked for", () => {
  const log = new RelayRequestLog({ now: () => 0 });
  const json = (payload) => Buffer.from(JSON.stringify(payload));
  const levelOf = (client, upstream) => log.open("/v1/messages", json(client), upstream ? json(upstream) : null).thinkingLevel;

  // A current model carries its rung beside the adaptive type; an older one carries a budget.
  assert.equal(levelOf({}, { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "xhigh" } }), "xhigh");
  assert.equal(levelOf({}, { thinking: { type: "enabled", budget_tokens: 16_384 } }), "budget:16384");
  assert.equal(levelOf({}, { thinking: { type: "adaptive" } }), "adaptive");
  assert.equal(levelOf({}, { thinking: { type: "disabled" } }), "off");
  assert.equal(levelOf({ reasoning_effort: "high" }, { model: "claude-opus-5" }), null);
  // An untranslated OpenAI turn never grows a thinking object and states its level itself.
  assert.equal(levelOf({}, { model: "gpt-5.6-sol", reasoning_effort: "High" }), "high");
  assert.equal(levelOf({}, { model: "kimi-k3", reasoning_effort: "high", thinking: { type: "enabled" } }), "high");
  assert.equal(levelOf({}, { model: "kimi-k3", thinking: { type: "disabled" }, output_config: { effort: "high" } }), "off");
  assert.equal(levelOf({}, { model: "gpt-5.6-sol", reasoning: { effort: "none" } }), "off");

  // The caller's own ask is still recorded, which is what makes the two comparable: this is the
  // request that asked for medium and was carried to the rung its budget was reaching for.
  const converted = log.open("/v1/messages", json({ thinking: { type: "enabled", budget_tokens: 8192 } }), json({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "medium" } }));
  assert.equal(converted.reasoningEffort, "budget:8192");
  assert.equal(converted.thinkingLevel, "medium");

  // With no upstream body to read, the level falls back to the request as it arrived.
  assert.equal(log.open("/v1/messages", json({ thinking: { type: "adaptive" }, output_config: { effort: "max" } })).thinkingLevel, "max");

  // Claude Code states its level in output_config beside a bare adaptive type. Read from the
  // thinking object alone it would log as "adaptive", and a level the client chose would be
  // indistinguishable from one this gateway filled in.
  const claudeCode = log.open("/v1/messages",
    json({ model: "claude-opus-5", thinking: { type: "adaptive" }, output_config: { effort: "high" } }),
    json({ model: "claude-opus-5", thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } }));
  assert.equal(claudeCode.reasoningEffort, "high");
  assert.equal(claudeCode.thinkingLevel, "high");
});

test("the usage chunk this gateway asked for is counted and then hidden from the client", async () => {
  const log = new RelayRequestLog({ now: () => 0 });
  const entry = log.open("/v1/chat/completions", Buffer.from(JSON.stringify({ model: "gpt-5", stream: true })));
  const usageChunk = { choices: [], usage: { prompt_tokens: 300, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 250 } } };
  const wrapped = log.observe(entry, sseUpstream([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`,
    `data: ${JSON.stringify(usageChunk)}\n\n`,
    "data: [DONE]\n\n"
  ]), { id: "user-c" }, { dropUsageOnlyFrames: true });
  const streamed = await new Response(wrapped.body).text();

  assert.match(streamed, /"content":"hi"/);
  assert.doesNotMatch(streamed, /usage/);
  assert.match(streamed, /data: \[DONE\]/);
  const [snapshot] = log.snapshot();
  assert.equal(snapshot.inputTokens, 300);
  assert.equal(snapshot.outputTokens, 20);
  assert.equal(snapshot.cacheReadTokens, 250);
});

test("a client that asked for usage itself still receives the usage chunk", async () => {
  const log = new RelayRequestLog({ now: () => 0 });
  const entry = log.open("/v1/chat/completions", Buffer.from(JSON.stringify({ model: "gpt-5", stream: true })));
  const wrapped = log.observe(entry, sseUpstream([
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 6 } })}\n\n`
  ]), { id: "user-d" });

  assert.match(await new Response(wrapped.body).text(), /"usage"/);
  assert.equal(log.snapshot()[0].inputTokens, 5);
});

test("Anthropic protocol logs top-level OpenAI usage counters from GPT relays", async () => {
  const log = new RelayRequestLog({ now: () => 0 });
  const entry = log.open("/v1/messages", Buffer.from(JSON.stringify({ model: "gpt-5" })));
  const wrapped = log.observe(entry, sseUpstream([
    `data: ${JSON.stringify({ input_tokens: 321, output_tokens: 17, cached_input_tokens: 8 })}`
  ], "text/event-stream"), { id: "gpt-account" });
  await new Response(wrapped.body).text();
  const [result] = log.snapshot();
  assert.equal(result.inputTokens, 321);
  assert.equal(result.outputTokens, 17);
  assert.equal(result.cacheReadTokens, 8);
});

test("zero token usage remains distinguishable from empty upstream content", async () => {
  const log = new RelayRequestLog();
  const entry = log.open("/v1/messages", Buffer.from(JSON.stringify({ model: "kimi-k3", stream: false })));
  const raw = JSON.stringify({ choices: [{ message: { content: "OK", reasoning_content: "思考" }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0 } });
  const observed = log.observe(entry, new Response(raw, { headers: { "content-type": "application/json" } }));
  await observed.text();
  const snapshot = log.snapshot()[0];
  assert.equal(snapshot.outputTokens, 0);
  assert.equal(snapshot.textCharacters, 2);
  assert.equal(snapshot.reasoningCharacters, 2);
  assert.equal(snapshot.responseBytes, Buffer.byteLength(raw));
  assert.equal(snapshot.finishReason, "stop");
  assert.equal(snapshot.upstreamStream, false);
  assert.equal(snapshot.upstreamStatus, 200);
});

test("the log records unexpected SSE separately from the non-streaming client request", async () => {
  const log = new RelayRequestLog();
  const entry = log.open("/v1/messages", Buffer.from(JSON.stringify({ model: "kimi-k3", stream: false })));
  const observed = log.observe(entry, sseUpstream([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "OK", reasoning_content: "Reason" }, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ]));
  await observed.text();
  const snapshot = log.snapshot()[0];
  assert.equal(snapshot.stream, false);
  assert.equal(snapshot.upstreamStream, true);
  assert.equal(snapshot.textCharacters, 2);
  assert.equal(snapshot.reasoningCharacters, 6);
  assert.equal(snapshot.outputTokens, null);
});
