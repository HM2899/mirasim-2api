import assert from "node:assert/strict";
import { Readable, Transform } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { endMessageStream, frameHasThinkingEstimate, guardUpstreamResponse, pipeWithCancellation } from "../src/stream-lifecycle.js";

for (const type of ["message_stop", "error"]) {
  test(`Messages ${type} survives split UTF-8/CRLF and closes before transport EOF`, { timeout: 1000 }, async () => {
    let cancelled = false;
    const prefix = 'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"text":"你好，message_stop 不是结束事件"}}\r\n\r\n';
    const terminal = `event: ${type}\r\ndata: {"type":\r\ndata: "${type}"}\r\n\r\n`;
    const upstream = new Response(new ReadableStream({
      start(controller) {
        for (const byte of Buffer.from(prefix + terminal)) controller.enqueue(Uint8Array.of(byte));
        controller.enqueue(Buffer.from('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"discard after terminal"}}\n\n'));
      },
      cancel() { cancelled = true; }
    }), { headers: { "content-type": "text/event-stream", "content-length": "9999", "x-request-id": "req_terminal" } });
    const response = endMessageStream(upstream);
    assert.equal(await response.text(), prefix + terminal);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("x-request-id"), "req_terminal");
  });
}

test("Messages terminal cleanup does not wait for a stalled source cancellation", { timeout: 1000 }, async () => {
  const upstream = new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('data: {"type":"message_stop"}\n\n')); },
    cancel() { return new Promise(() => {}); }
  }), { headers: { "content-type": "text/event-stream" } });
  assert.match(await endMessageStream(upstream).text(), /message_stop/);
});

test("Messages framing reports truncation without inventing a successful terminal event", async () => {
  const partial = 'event: message_stop\ndata: {"type":"content_block_delta","delta":{"text":"not terminal"}}\n\ndata: {"type":"message_st';
  const body = await endMessageStream(new Response(partial, { headers: { "content-type": "text/event-stream" } })).text();
  assert.match(body, /upstream_stream_incomplete/);
  assert.doesNotMatch(body, /"type":"message_stop"/);
  for (const frame of body.trim().split("\n\n")) JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5));
});

test("Messages preserves a terminal frame without its trailing separator", async () => {
  const body = await endMessageStream(new Response('data: {"type":"message_stop"}', { headers: { "content-type": "text/event-stream" } })).text();
  assert.match(body, /"type":"message_stop"/);
  assert.doesNotMatch(body, /event: error/);
});

test("Messages transport failure yields a readable protocol error instead of resetting HTTP", async () => {
  let source;
  const upstream = new Response(new ReadableStream({ start(controller) { source = controller; } }), { headers: { "content-type": "text/event-stream" } });
  const result = endMessageStream(upstream).text();
  source.error(new Error("connection reset"));
  assert.match(await result, /upstream_stream_error/);
});

test("Messages heartbeats do not corrupt split frames or extend upstream deadlines", async () => {
  let source;
  let cancelled = false;
  const upstream = new Response(new ReadableStream({
    start(controller) { source = controller; controller.enqueue(Buffer.from('data: {"type":"message_')); },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } });
  const reader = endMessageStream(guardUpstreamResponse(upstream, { idleTimeoutMs: 100 }), { heartbeatIntervalMs: 5 }).body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"type":"ping"/);
  source.enqueue(Buffer.from('start","message":{"id":"msg_1"}}\n\n'));
  let body = first;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    body += new TextDecoder().decode(result.value);
  }
  assert.match(body, /upstream_stream_timeout/);
  assert.match(body, /"type":"message_start"/);
  for (const frame of body.trim().split("\n\n")) JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5));
  assert.equal(cancelled, true);
});

test("Messages cleanup preserves JSON and non-success responses unchanged", async () => {
  for (const upstream of [Response.json({ type: "message", content: [] }), new Response('data: {"type":"error"}\n\n', { status: 503, headers: { "content-type": "text/event-stream" } })]) {
    assert.equal(endMessageStream(upstream), upstream);
  }
});

test("a stalled response body times out and cancels its upstream", async () => {
  let cancelled = false;
  let cleaned = false;
  const upstream = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const guarded = guardUpstreamResponse(upstream, { idleTimeoutMs: 20, onDone() { cleaned = true; } });
  await assert.rejects(guarded.text(), /idle timeout/);
  assert.equal(cancelled, true);
  assert.equal(cleaned, true);
});

test("consumer cancellation propagates through multiple transforms to the fetch abort", async () => {
  let cancelled = false;
  let aborted = false;
  const upstream = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const guarded = guardUpstreamResponse(upstream, { onCancel() { aborted = true; } });
  const first = pipeWithCancellation(Readable.fromWeb(guarded.body), new Transform({ transform(chunk, encoding, callback) { callback(null, chunk); } }));
  const second = pipeWithCancellation(first, new Transform({ transform(chunk, encoding, callback) { callback(null, chunk); } }));
  await Readable.toWeb(second).cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(aborted, true);
});

test("abort during a pending read closes the body even when a mock fetch ignores its signal", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const guarded = guardUpstreamResponse(new Response(new ReadableStream({ cancel() { cancelled = true; } })), { signal: controller.signal });
  const pending = guarded.text();
  controller.abort(new Error("Disconnected"));
  await assert.rejects(pending, /Disconnected/);
  assert.equal(cancelled, true);
});

for (const [label, body, options] of [
  ["total bytes", "123456789", { maxBytes: 8 }],
  ["unterminated SSE frame", "data: 123456789", { maxFrameBytes: 8 }],
  ["terminated SSE frame", "data: 123456789\n\n", { maxFrameBytes: 8 }]
]) {
  test(`upstream guard bounds ${label}`, async () => {
    const guarded = guardUpstreamResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), options);
    await assert.rejects(guarded.text(), /size limit/);
  });
}

test("idle timeout resets after each chunk and allows a longer active stream", async () => {
  let step = 0;
  const upstream = new Response(new ReadableStream({ async pull(controller) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (step++ < 5) controller.enqueue(new TextEncoder().encode("data: OK\r\n\r\n"));
    else controller.close();
  } }));
  const guarded = guardUpstreamResponse(upstream, { idleTimeoutMs: 60 });
  assert.equal(await guarded.text(), "data: OK\r\n\r\n".repeat(5));
});

for (const event of [
  { choices: [{ delta: { content: "Hello" } }] },
  { choices: [{ delta: { reasoning_content: "Thinking" } }] },
  { choices: [{ delta: { tool_calls: [{ id: "call_read", function: { name: "Read" } }] } }] },
  { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Thinking" } },
  { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "", estimated_tokens: 64 } },
  { type: "content_block_start", content_block: { type: "tool_use", id: "tool_read", name: "Read" } },
  { type: "response.reasoning_summary_text.delta", delta: "Thinking" },
  { type: "response.output_item.added", item: { type: "function_call", id: "call_read", name: "Read" } },
  { type: "response.output_item.added", item: { type: "web_search_call", id: "search_1", status: "in_progress" } },
  { type: "response.content_part.added", part: { type: "output_text", text: "Hello" } }
]) {
  test(`first content releases its deadline for active ${event.type || JSON.stringify(event.choices)} streams`, async () => {
    let source;
    const upstream = new Response(new ReadableStream({ start(controller) {
      source = controller;
      controller.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
    } }), { headers: { "content-type": "text/event-stream" } });
    const guarded = guardUpstreamResponse(upstream, { firstContentTimeoutMs: 40, idleTimeoutMs: 1000 });
    const result = guarded.text();
    await delay(100);
    source.enqueue(Buffer.from("data: [DONE]\n\n"));
    source.close();
    assert.match(await result, /\[DONE\]/);
  });
}

for (const event of [
  { type: "image_generation.partial_image", b64_json: "image" },
  { type: "image_edit.partial_image", b64_json: "image" },
  { type: "response.image_generation_call.partial_image", partial_image_b64: "image" }
]) {
  test(`${event.type} counts as real progress rather than a heartbeat`, async () => {
    let source;
    const upstream = new Response(new ReadableStream({ start(controller) {
      source = controller;
      controller.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
    } }), { headers: { "content-type": "text/event-stream" } });
    const result = guardUpstreamResponse(upstream, { firstContentTimeoutMs: 40, idleTimeoutMs: 1000 }).text();
    await delay(100);
    source.close();
    assert.match(await result, /image/);
  });
}

for (const contentType of ["text/event-stream", "application/json", "text/plain"]) {
  test(`${contentType} heartbeat, role and usage frames cannot extend the content deadline`, async () => {
    let interval;
    let cancelled = false;
    const upstream = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from("eve"));
        controller.enqueue(Buffer.from('nt: ping\r\ndata: {"type":"ping"}\r\n\r\n'));
        interval = setInterval(() => controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"role":"assistant","content":""}}],"usage":{"prompt_tokens":1}}\n\n')), 5);
      },
      cancel() { clearInterval(interval); cancelled = true; }
    }), { headers: { "content-type": contentType } });
    try {
      await assert.rejects(guardUpstreamResponse(upstream, { firstContentTimeoutMs: 40, idleTimeoutMs: 1000 }).text(), { code: "upstream_stream_timeout" });
      assert.equal(cancelled, true);
    } finally { clearInterval(interval); }
  });
}

test("JSON trickles remain bounded until the complete object arrives", async () => {
  let interval;
  const upstream = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('{"text":"'));
      interval = setInterval(() => controller.enqueue(Buffer.from("x")), 5);
    },
    cancel() { clearInterval(interval); }
  }), { headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(guardUpstreamResponse(upstream, { firstContentTimeoutMs: 40, idleTimeoutMs: 1000 }).text(), { code: "upstream_stream_timeout" });
  } finally { clearInterval(interval); }
});

for (const event of [
  { type: "response.reasoning_summary_text.delta", delta: "Thinking" },
  { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "", estimated_tokens: 64 } },
  { choices: [{ delta: { reasoning_content: "Thinking" } }] }
]) {
  test(`heartbeat-only stall after reasoning is cancelled: ${event.type || "chat"}`, async () => {
    let interval;
    let cancelled = false;
    const upstream = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
        interval = setInterval(() => controller.enqueue(Buffer.from(": ping\n\n")), 5);
      },
      cancel() { clearInterval(interval); cancelled = true; }
    }), { headers: { "content-type": "text/event-stream" } });
    try {
      await assert.rejects(guardUpstreamResponse(upstream, { firstContentTimeoutMs: 100, idleTimeoutMs: 60 }).text(), { code: "upstream_stream_timeout" });
      assert.equal(cancelled, true);
    } finally { clearInterval(interval); }
  });
}

test("continued reasoning renews the progress deadline without capping total thinking time", async () => {
  let step = 0;
  const upstream = new Response(new ReadableStream({ async pull(controller) {
    await delay(15);
    if (step++ < 10) controller.enqueue(Buffer.from('data: {"type":"response.reasoning_summary_text.delta","delta":"Thinking"}\n\n'));
    else controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
  const result = await guardUpstreamResponse(upstream, { firstContentTimeoutMs: 100, idleTimeoutMs: 100 }).text();
  assert.equal(result.match(/Thinking/g).length, 10);
});

test("redacted thinking token increments keep a live generation beyond its initial deadline", async () => {
  let step = 0;
  const upstream = new Response(new ReadableStream({ async pull(controller) {
    await delay(20);
    if (step++ < 12) controller.enqueue(Buffer.from('data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"","estimated_tokens":64}}\n\n'));
    else controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
  const result = await guardUpstreamResponse(upstream, { firstContentTimeoutMs: 100, idleTimeoutMs: 100 }).text();
  assert.equal(result.match(/estimated_tokens/g).length, 12);
});

for (const delta of [
  { type: "thinking_delta", thinking: "", estimated_tokens: 0 },
  { type: "thinking_delta", thinking: "", estimated_tokens: -1 },
  { type: "thinking_delta", thinking: "", estimated_tokens: "64" },
  { type: "thinking_delta", thinking: "", estimated_tokens: null },
  { type: "thinking_delta", thinking: "" },
  { type: "text_delta", text: "", estimated_tokens: 64 }
]) {
  test(`non-progress deltas cannot extend deadlines: ${JSON.stringify(delta)}`, async () => {
    let interval;
    const upstream = new Response(new ReadableStream({
      start(controller) {
        interval = setInterval(() => controller.enqueue(Buffer.from(`data: ${JSON.stringify({ type: "content_block_delta", delta })}\n\n`)), 5);
      },
      cancel() { clearInterval(interval); }
    }), { headers: { "content-type": "text/event-stream" } });
    try {
      await assert.rejects(guardUpstreamResponse(upstream, { firstContentTimeoutMs: 50, idleTimeoutMs: 1000 }).text(), { code: "upstream_stream_timeout" });
    } finally { clearInterval(interval); }
  });
}

test("only a raw thinking_delta with a positive integer estimate reports hidden thinking", () => {
  const frame = (delta, type = "content_block_delta") => `event: ${type}\ndata: ${JSON.stringify({ type, index: 0, delta })}`;
  assert.equal(frameHasThinkingEstimate(frame({ type: "thinking_delta", thinking: "", estimated_tokens: 64 })), true);
  assert.equal(frameHasThinkingEstimate('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"","estimated\\u005ftokens":64}}'), true);
  assert.equal(frameHasThinkingEstimate(frame({ type: "thinking_delta", thinking: "", estimated_tokens: 1 })), true);
  for (const estimated_tokens of [0, -1, 1.5, "64", null, 2 ** 53, Number.NaN, Infinity]) {
    assert.equal(frameHasThinkingEstimate(frame({ type: "thinking_delta", thinking: "", estimated_tokens })), false, String(estimated_tokens));
  }
  for (const value of [
    frame({ type: "thinking_delta", thinking: "" }),
    frame({ type: "text_delta", text: "", estimated_tokens: 64 }),
    frame({ type: "thinking_delta", thinking: "", estimated_tokens: 64 }, "message_delta"),
    'event: ping\ndata: {"type":"ping"}',
    'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":64,"estimated_tokens":64}}',
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"","estimated_tokens":64}}]}',
    ": estimated_tokens 64",
    'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","estimated_tokens":64',
    "data: [DONE]"
  ]) assert.equal(frameHasThinkingEstimate(value), false, value);
});

test("native search work renews the progress deadline", async () => {
  let step = 0;
  const upstream = new Response(new ReadableStream({ async pull(controller) {
    await delay(20);
    if (step++ < 12) controller.enqueue(Buffer.from('data: {"type":"response.web_search_call.searching","item_id":"ws_active"}\n\n'));
    else controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
  const result = await guardUpstreamResponse(upstream, { firstContentTimeoutMs: 100, idleTimeoutMs: 100 }).text();
  assert.equal(result.match(/ws_active/g).length, 12);
});

test("progress timeout pauses while downstream backpressure prevents reading", async () => {
  const frame = 'data: {"type":"response.reasoning_summary_text.delta","delta":"Thinking"}\n\n';
  const guarded = guardUpstreamResponse(new Response(frame.repeat(2), { headers: { "content-type": "text/event-stream" } }), { firstContentTimeoutMs: 100, idleTimeoutMs: 40 });
  await delay(120);
  assert.equal(await guarded.text(), frame.repeat(2));
});
