import assert from "node:assert/strict";
import test from "node:test";
import { createProgressSignal, primeChatCompletionStream } from "../src/chat-stream.js";

function sse(...events) {
  return new Response(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" }
  });
}

for (const [name, events] of [
  ["empty body", []],
  ["DONE only", ["[DONE]"]],
  ["usage only", [{ choices: [], usage: { completion_tokens: 0 } }, "[DONE]"]],
  ["role only", [{ choices: [{ delta: { role: "assistant" }, finish_reason: "stop" }] }, "[DONE]"]],
  ["whitespace only", [{ choices: [{ delta: { content: " \n " }, finish_reason: "stop" }] }, "[DONE]"]]
]) {
  test(`chat preflight rejects ${name}`, async () => {
    await assert.rejects(primeChatCompletionStream(sse(...events)), { code: "upstream_empty_stream" });
  });
}

for (const delta of [
  { content: "Answer" },
  { reasoning_content: "Thinking" },
  { refusal: "Cannot comply" },
  { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{}" } }] }
]) {
  test(`chat preflight accepts ${Object.keys(delta)[0]} without waiting for EOF`, async () => {
    let cancelled = false;
    const upstream = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(`: ping\n\ndata: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
      },
      cancel() { cancelled = true; }
    }), { headers: { "content-type": "text/event-stream" } });
    const response = await primeChatCompletionStream(upstream, { firstContentTimeoutMs: 100 });
    const reader = response.body.getReader();
    let text = "";
    while (!text.includes(JSON.stringify(delta))) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.equal(cancelled, true);
  });
}

test("chat preflight cancels a stream that never produces content", async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from(": ping\n\n")); },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(primeChatCompletionStream(upstream, { firstContentTimeoutMs: 20 }), { code: "upstream_stream_timeout" });
  assert.equal(cancelled, true);
});

test("chat preflight honors a progress timestamp reported before subscription", async () => {
  const progress = createProgressSignal();
  progress.report(Date.now());
  const upstream = heldUpstream(() => {}, JSON.stringify({ choices: [{ delta: { content: "Late" } }] }), 180);
  const response = await primeChatCompletionStream(upstream, { firstContentTimeoutMs: 50, progress, progressTimeoutMs: 250 });
  assert.ok(response);
  await response.body.cancel();
});

function heldUpstream(onCancel, content = null, contentAfterMs = 0) {
  let timer;
  let ping;
  return new Response(new ReadableStream({
    start(controller) {
      ping = setInterval(() => controller.enqueue(Buffer.from(": ping\n\n")), 5);
      if (content) timer = setTimeout(() => controller.enqueue(Buffer.from(`data: ${content}\n\n`)), contentAfterMs);
    },
    cancel() { clearInterval(ping); clearTimeout(timer); onCancel(); }
  }), { headers: { "content-type": "text/event-stream" } });
}

function trackedProgress() {
  const target = new EventTarget();
  const listeners = new Set();
  return {
    listeners,
    addEventListener(type, listener) { listeners.add(listener); target.addEventListener(type, listener); },
    removeEventListener(type, listener) { listeners.delete(listener); target.removeEventListener(type, listener); },
    report() { target.dispatchEvent(new Event("progress")); }
  };
}

test("chat preflight keeps waiting for content while out-of-band progress continues", async () => {
  let cancelled = false;
  const progress = trackedProgress();
  const ticker = setInterval(() => progress.report(), 20);
  try {
    const response = await primeChatCompletionStream(heldUpstream(() => { cancelled = true; }, JSON.stringify({ choices: [{ delta: { content: "Late" } }] }), 200), {
      firstContentTimeoutMs: 50, progress, progressTimeoutMs: 60
    });
    assert.equal(progress.listeners.size, 0);
    const reader = response.body.getReader();
    let text = "";
    while (!text.includes("Late")) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.equal(cancelled, true);
  } finally { clearInterval(ticker); }
});

test("chat preflight times out and cancels once out-of-band progress stops", async () => {
  let cancelled = false;
  const progress = trackedProgress();
  let reports = 0;
  const ticker = setInterval(() => { if (reports++ < 3) progress.report(); }, 20);
  const startedAt = Date.now();
  try {
    await assert.rejects(primeChatCompletionStream(heldUpstream(() => { cancelled = true; }), {
      firstContentTimeoutMs: 30, progress, progressTimeoutMs: 60
    }), { code: "upstream_stream_timeout" });
  } finally { clearInterval(ticker); }
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 100 && elapsed < 500, `took ${elapsed}ms`);
  assert.equal(cancelled, true);
  assert.equal(progress.listeners.size, 0);
});

test("chat preflight never takes out-of-band progress for content", async () => {
  const progress = trackedProgress();
  const upstream = new Response(new ReadableStream({
    async start(controller) {
      progress.report();
      await new Promise((resolve) => setTimeout(resolve, 20));
      progress.report();
      controller.enqueue(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(primeChatCompletionStream(upstream, { firstContentTimeoutMs: 100, progress, progressTimeoutMs: 100 }), { code: "upstream_empty_stream" });
  assert.equal(progress.listeners.size, 0);
});

test("chat preflight progress never shortens the first-content deadline", async () => {
  const progress = trackedProgress();
  const ticker = setInterval(() => progress.report(), 5);
  try {
    const response = await primeChatCompletionStream(heldUpstream(() => {}, JSON.stringify({ choices: [{ delta: { content: "OK" } }] }), 80), {
      firstContentTimeoutMs: 200, progress, progressTimeoutMs: 10
    });
    await response.body.cancel();
  } finally { clearInterval(ticker); }
});

for (const progressTimeoutMs of [Infinity, 0, -1, Number.NaN]) {
  test(`chat preflight ignores progress without a finite positive budget (${progressTimeoutMs})`, async () => {
    const progress = trackedProgress();
    const ticker = setInterval(() => progress.report(), 5);
    try {
      await assert.rejects(primeChatCompletionStream(heldUpstream(() => {}), { firstContentTimeoutMs: 40, progress, progressTimeoutMs }), { code: "upstream_stream_timeout" });
    } finally { clearInterval(ticker); }
    assert.equal(progress.listeners.size, 0);
  });
}

test("chat preflight rejects upstream SSE errors before content", async () => {
  await assert.rejects(primeChatCompletionStream(sse({ error: { message: "Capacity exhausted", code: "overloaded" } })), {
    code: "overloaded", message: "Capacity exhausted"
  });
});

for (const shape of ["typed", "named", "nested", "failed"]) {
  test(`chat preflight retains ${shape} permanent error fields`, async () => {
    const detail = { code: "unsupported_value", message: "Unsupported value", param: "reasoning.effort", status: 503 };
    const event = shape === "nested" ? { error: { ...detail, type: "invalid_request_error" } }
      : shape === "failed" ? { type: "response.failed", response: { error: detail } }
      : { ...detail, ...(shape === "named" ? {} : { type: "error" }) };
    const upstream = shape === "named" ? new Response(`event: error\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } }) : sse(event);
    await assert.rejects(primeChatCompletionStream(upstream), {
      code: detail.code, message: detail.message, type: "invalid_request_error", statusCode: 400, param: detail.param
    });
  });
}

for (const status of [403, 503]) {
  test(`chat preserves HTTP ${status} and error details after content without a successful finish`, async () => {
    const response = await primeChatCompletionStream(sse(
      { choices: [{ delta: { content: "Partial" } }] },
      { error: { type: "overloaded_error", code: "model_capacity_exhausted", message: "Unavailable", param: "model", status } },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ));
    const wire = await response.text();
    assert.match(wire, /Partial/);
    assert.match(wire, new RegExp(`"type":"${status === 403 ? "permission_error" : "overloaded_error"}"`));
    assert.match(wire, /"code":"model_capacity_exhausted"/);
    assert.match(wire, /"param":"model"/);
    assert.match(wire, new RegExp(`"status":${status}`));
    assert.doesNotMatch(wire, /"finish_reason":"stop"/);
    assert.equal(wire.match(/data: \[DONE\]/g).length, 1);
  });
}

test("chat preflight retains a non-retryable invalid request status", async () => {
  await assert.rejects(primeChatCompletionStream(sse({ error: { type: "invalid_request_error", message: "Request rejected" } })), {
    code: "upstream_stream_error", message: "Request rejected", type: "invalid_request_error", statusCode: 400
  });
});

test("a request error after content retains its type without a successful finish", async () => {
  const response = await primeChatCompletionStream(sse(
    { choices: [{ delta: { content: "Partial" } }] },
    { error: { type: "invalid_request_error", message: "Request rejected" } }
  ));
  const wire = await response.text();
  assert.match(wire, /"type":"invalid_request_error"/);
  assert.match(wire, /Request rejected/);
  assert.doesNotMatch(wire, /"finish_reason":"stop"/);
  assert.equal(wire.match(/data: \[DONE\]/g).length, 1);
});

test("truncated chat output reports an SSE error instead of a successful stop", async () => {
  const response = await primeChatCompletionStream(sse({ choices: [{ delta: { content: "Partial" } }] }));
  const wire = await response.text();
  assert.match(wire, /Partial/);
  assert.match(wire, /upstream_stream_incomplete/);
  assert.doesNotMatch(wire, /"finish_reason":"stop"/);
  assert.equal(wire.match(/data: \[DONE\]/g).length, 1);
});

test("chat streams with finish reasons get a missing DONE marker at EOF", async () => {
  const response = await primeChatCompletionStream(sse({ choices: [{ delta: { content: "Complete" }, finish_reason: "stop" }] }));
  const wire = await response.text();
  assert.match(wire, /Complete/);
  assert.doesNotMatch(wire, /"error"/);
  assert.match(wire, /data: \[DONE\]/);
});

test("chat preflight preserves fragmented UTF-8, CRLF and unterminated final frames", async () => {
  const wire = 'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]';
  const upstream = new Response(new ReadableStream({
    start(controller) {
      for (const byte of Buffer.from(wire)) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
  const response = await primeChatCompletionStream(upstream);
  const text = await response.text();
  assert.match(text, /你好/);
  assert.equal(text.match(/data: \[DONE\]/g).length, 1);
});

test("chat DONE releases an upstream connection that stays open", async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } });
  const response = await primeChatCompletionStream(upstream);
  assert.match(await response.text(), /Answer/);
  assert.equal(cancelled, true);
});

test("a transport failure after the first content frame is a readable SSE error", async () => {
  const upstream = new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n')); },
    pull(controller) { controller.error(new Error("Connection reset")); }
  }), { headers: { "content-type": "text/event-stream" } });
  const response = await primeChatCompletionStream(upstream);
  const wire = await response.text();
  assert.match(wire, /Partial/);
  assert.match(wire, /upstream_stream_error/);
  assert.match(wire, /Connection reset/);
});
