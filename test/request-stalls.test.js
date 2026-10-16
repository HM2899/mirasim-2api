import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { createGateway } from "../src/server.js";

const completeChat = 'data: {"id":"chat_stall","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":80}}}\n\ndata: [DONE]\n\n';

for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses"]) {
  test(`${path} non-streaming completes at DONE without upstream EOF`, async (context) => {
    let cancelled = false;
    const fixture = await gatewayFixture(context, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(completeChat)); },
      cancel() { cancelled = true; }
    }), { headers: { "content-type": "text/event-stream" } }));
    const response = await fixture.ask(path, "deepseek-flash", false);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /OK/);
    assert.equal(cancelled, true);
  });
}

for (const stream of [false, true]) {
  test(`Sonnet 5.5 hidden thinking stays active until the answer (stream=${stream})`, async (context) => {
    let step = 0;
    let cancelled = false;
    const fixture = await gatewayFixture(context, async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from([
          { type: "message_start", message: { id: "msg_sonnet", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
      },
      async pull(controller) {
        await delay(30);
        if (cancelled) return;
        if (step++ < 12) {
          controller.enqueue(Buffer.from('data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"","estimated_tokens":64}}\n\n'));
        } else {
          controller.enqueue(Buffer.from([
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "OK" } },
            { type: "content_block_stop", index: 1 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } },
            { type: "message_stop" }
          ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
        }
      },
      cancel() { cancelled = true; }
    }), { headers: { "content-type": "text/event-stream" } }), { firstByteTimeoutMs: 100, streamIdleTimeoutMs: 150 });
    const response = await fixture.ask("/v1/messages", "claude-sonnet-5-5", stream);
    assert.equal(response.status, 200);
    if (stream) {
      const wire = await response.text();
      assert.match(wire, /message_stop/);
      assert.match(wire, /"text":"OK"/);
      assert.doesNotMatch(wire, /upstream_stream_timeout/);
    } else {
      const message = await response.json();
      assert.deepEqual(message.content, [{ type: "thinking", thinking: "", signature: "signed" }, { type: "text", text: "OK" }]);
      assert.deepEqual(message.usage, { input_tokens: 10, output_tokens: 100 });
    }
    assert.equal(cancelled, true);
  });
}

test("an oversized error body is cancelled at the byte cap and fails over before EOF", async (context) => {
  let attempts = 0;
  let cancelled = false;
  const fixture = await gatewayFixture(context, async () => {
    if (++attempts > 1) return new Response(completeChat, { headers: { "content-type": "text/event-stream" } });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(JSON.stringify({ error: { message: "x".repeat(70 * 1024) } }))); },
      cancel() { cancelled = true; }
    }), { status: 503, headers: { "content-type": "application/json", "content-length": "100000" } });
  }, { accountCount: 2 });
  const response = await fixture.ask("/v1/chat/completions", "deepseek-flash", false);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /OK/);
  assert.equal(attempts, 2);
  assert.equal(cancelled, true);
});

test("a stalled error body cannot spend beyond the failover deadline", async (context) => {
  let cancelled = false;
  let attempts = 0;
  const fixture = await gatewayFixture(context, async () => {
    attempts += 1;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
  }, { firstByteTimeoutMs: 100, failoverBudgetMs: 100, accountCount: 2 });
  const response = await fixture.ask("/v1/messages", "glm-5.3", false);
  assert.equal(response.status, 503);
  assert.ok((await response.json()).error);
  assert.equal(cancelled, true);
  assert.equal(attempts, 1);
});

test("a small stalled error body leaves time for a healthy fallback account", async (context) => {
  let attempts = 0;
  let cancelled = false;
  const fixture = await gatewayFixture(context, async () => {
    if (++attempts > 1) return new Response(completeChat, { headers: { "content-type": "text/event-stream" } });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('{"error":')); },
      cancel() { cancelled = true; }
    }), { status: 503 });
  }, { accountCount: 2, firstByteTimeoutMs: 2500, failoverBudgetMs: 2500 });
  const response = await fixture.ask("/v1/chat/completions", "deepseek-flash", false);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /OK/);
  assert.equal(cancelled, true);
  assert.equal(attempts, 2);
});

test("partial error JSON retains its status and request id without stale lengths", async (context) => {
  let cancelled = false;
  const fixture = await gatewayFixture(context, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('{"error":{"message":"partial')); },
    cancel() { cancelled = true; }
  }), { status: 503, headers: { "content-type": "application/json", "content-length": "99999", "x-request-id": "req_partial", "retry-after": "1" } }), { firstByteTimeoutMs: 100, failoverBudgetMs: 100 });
  const response = await fixture.ask("/v1/messages", "glm-5.3", false);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-request-id"), "req_partial");
  assert.equal(response.headers.get("retry-after"), "1");
  assert.notEqual(response.headers.get("content-length"), "99999");
  assert.ok((await response.json()).error);
  assert.equal(cancelled, true);
});

test("a small complete upstream error keeps its original payload", async (context) => {
  const error = { error: { type: "overloaded_error", message: "Try again later", request_id: "req_original" } };
  const fixture = await gatewayFixture(context, async () => Response.json(error, { status: 503 }));
  const response = await fixture.ask("/v1/messages", "glm-5.3", false);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), error);
});

test("error-body cancellation does not wait for an uncooperative source", async (context) => {
  const fixture = await gatewayFixture(context, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.alloc(70 * 1024, 120)); },
    cancel() { return new Promise(() => {}); }
  }), { status: 503 }), { firstByteTimeoutMs: 100, failoverBudgetMs: 100 });
  const response = await fixture.ask("/v1/messages", "glm-5.3", false);
  assert.equal(response.status, 503);
  assert.ok((await response.json()).error);
});

test("header and first-content waits share one attempt deadline", async (context) => {
  let cancelled = false;
  const fixture = await gatewayFixture(context, async (url, options) => {
    await delay(120, undefined, { signal: options.signal });
    return timedResponse("", completeChat, 140, "text/event-stream", () => { cancelled = true; });
  }, { firstByteTimeoutMs: 200, failoverBudgetMs: 200 });
  const response = await fixture.ask("/v1/chat/completions", "deepseek-flash", true);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "upstream_stream_timeout");
  assert.equal(cancelled, true);
});

test("a JSON upstream cannot bypass the first-content deadline during normalization", async (context) => {
  let cancelled = false;
  const fixture = await gatewayFixture(context, async () => timedResponse("", JSON.stringify({
    choices: [{ index: 0, message: { content: "OK" }, finish_reason: "stop" }]
  }), 400, "application/json", () => { cancelled = true; }), { firstByteTimeoutMs: 100, failoverBudgetMs: 100 });
  const response = await fixture.ask("/v1/chat/completions", "deepseek-flash", true);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "upstream_stream_timeout");
  assert.equal(cancelled, true);
});

for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses"]) {
  test(`${path} continues a healthy generation beyond its initial deadline`, async (context) => {
    const first = 'data: {"id":"chat_stall","choices":[{"index":0,"delta":{"content":"OK"}}]}\n\n';
    const last = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":80}}}\n\ndata: [DONE]\n\n';
    const fixture = await gatewayFixture(context, async () => timedResponse(first, last, 250, "text/event-stream", () => {}), {
      firstByteTimeoutMs: 100, failoverBudgetMs: 100
    });
    const response = await fixture.ask(path, "deepseek-flash", true);
    assert.equal(response.status, 200);
    const wire = await response.text();
    assert.match(wire, /OK/);
    assert.doesNotMatch(wire, /upstream_stream_timeout/);
    assert.match(wire, /cached_tokens":80|cache_read_input_tokens":80/);
  });
}

// The header wait is not a wait for the answer. A model still reading a long prompt, or thinking
// before its first summary, holds its stream open with heartbeats; and once that stream is on its
// way to the caller no other account can take over, so ending it at the header deadline only hands
// the caller a broken answer to start again from the top — on a cache that never got written.
const events = (...list) => list.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const heartbeatHeld = {
  anthropic: {
    opening: events({ type: "message_start", message: { id: "msg_held", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    ping: events({ type: "ping" }),
    content: events({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Considering." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" })
  },
  chat: {
    opening: 'data: {"id":"chat_held","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
    ping: ": ping\n\n",
    content: completeChat
  },
  responses: {
    opening: events({ type: "response.created", response: { id: "resp_held", object: "response", model: "gpt-test", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { id: "rs_held", type: "reasoning", summary: [] } }),
    ping: ": keepalive\n\n",
    content: events({ type: "response.output_item.done", output_index: 0, item: { id: "rs_held", type: "reasoning", summary: [], encrypted_content: "opaque" } },
      { type: "response.output_item.added", output_index: 1, item: { id: "msg_held", type: "message", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.output_text.delta", output_index: 1, content_index: 0, item_id: "msg_held", delta: "OK" },
      { type: "response.output_item.done", output_index: 1, item: { id: "msg_held", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] } },
      { type: "response.completed", response: { id: "resp_held", object: "response", model: "gpt-test", status: "completed", output: [
        { id: "rs_held", type: "reasoning", summary: [], encrypted_content: "opaque" },
        { id: "msg_held", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] }
      ], usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } } })
  }
};

for (const [path, model, wire] of [
  ["/v1/messages", "claude-sonnet-5", "anthropic"],
  ["/v1/messages", "deepseek-flash", "chat"],
  ["/v1/responses", "claude-sonnet-5", "anthropic"],
  ["/v1/responses", "gpt-test", "responses"]
]) {
  test(`${path} ${model} keeps a forwarded stream whose first content comes after the header deadline`, async (context) => {
    let attempts = 0;
    let cancelled = false;
    const { opening, ping, content } = heartbeatHeld[wire];
    const fixture = await gatewayFixture(context, async () => {
      attempts += 1;
      let interval;
      let timer;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(opening));
          interval = setInterval(() => controller.enqueue(Buffer.from(ping)), 20);
          timer = setTimeout(() => {
            clearInterval(interval);
            controller.enqueue(Buffer.from(content));
            controller.close();
          }, 400);
        },
        cancel() { clearInterval(interval); clearTimeout(timer); cancelled = true; }
      }), { headers: { "content-type": "text/event-stream" } });
    }, { firstByteTimeoutMs: 100, failoverBudgetMs: 100 });
    const response = await fixture.ask(path, model, true);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /OK/);
    assert.doesNotMatch(text, /upstream_stream_timeout/);
    assert.equal(attempts, 1);
    assert.equal(cancelled, false);
  });
}

for (const [path, model] of [
  ["/v1/chat/completions", "deepseek-flash"],
  ["/v1/messages", "glm-5.3"],
  ["/v1/messages", "deepseek-flash"],
  ["/v1/responses", "deepseek-flash"],
  ["/v1/responses", "gpt-test"]
]) {
  test(`${path} ${model} cannot wait forever on heartbeat-only streams`, async (context) => {
    let cancelled = false;
    let interval;
    context.after(() => clearInterval(interval));
    // A stream that is already the caller's gets the idle allowance for its first content, not the
    // header wait; heartbeats every 10 ms still cannot keep it open past that allowance.
    const fixture = await gatewayFixture(context, async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(": ping\n\n"));
        interval = setInterval(() => controller.enqueue(Buffer.from(": ping\n\n")), 10);
      },
      cancel() { clearInterval(interval); cancelled = true; }
    }), { headers: { "content-type": "text/event-stream" } }), { firstByteTimeoutMs: 100, failoverBudgetMs: 100, streamIdleTimeoutMs: 300 });
    try {
      const response = await fixture.ask(path, model, true);
      await response.text();
    } catch (error) {
      assert.notEqual(error.name, "TimeoutError", "the gateway, not the client deadline, must close the stream");
    }
    assert.equal(cancelled, true);
  });
}

test("native GPT streams deliver opening events without waiting for generated output", async (context) => {
  let source;
  let attempts = 0;
  const { opening, content } = heartbeatHeld.responses;
  const fixture = await gatewayFixture(context, async () => {
    attempts += 1;
    return new Response(new ReadableStream({
      start(controller) {
        source = controller;
        controller.enqueue(Buffer.from(opening));
      }
    }), { headers: { "content-type": "text/event-stream" } });
  });
  const response = await fixture.ask("/v1/responses", "gpt-test", true);
  const reader = response.body.getReader();
  try {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    assert.match(Buffer.from((await reader.read()).value).toString(), /response.created/);
    source.enqueue(Buffer.from(content));
    source.close();
    let remaining = "";
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      remaining += Buffer.from(result.value).toString();
    }
    assert.match(remaining, /OK/);
    assert.match(remaining, /response.completed/);
    assert.equal(attempts, 1);
  } finally {
    await reader.cancel();
  }
});

for (const stream of [true, false]) {
  for (const empty of ["", ": ping\n\ndata: [DONE]\n\n", 'data: {"type":"response.completed","response":{"id":"empty","output":[]}}\n\n']) {
    test(`native Responses retries empty output before delivery (stream=${stream}, prefix=${empty.length})`, async (context) => {
      let attempts = 0;
      const fixture = await gatewayFixture(context, async () => {
        attempts += 1;
        const body = attempts === 1 ? empty : 'data: {"type":"response.completed","response":{"id":"good","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OK"}]}]}}\n\n';
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }, { accountCount: 2 });
      const response = await fixture.ask("/v1/responses", "gpt-test", stream);
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /OK/);
      assert.doesNotMatch(body, /"id":"empty"/);
      assert.equal(attempts, 2);
    });
  }
}

test("native Responses returns 502 when every account returns an empty stream", async (context) => {
  let attempts = 0;
  const fixture = await gatewayFixture(context, async () => {
    attempts += 1;
    return new Response("", { headers: { "content-type": "text/event-stream" } });
  }, { accountCount: 2 });
  const response = await fixture.ask("/v1/responses", "gpt-test", true);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /upstream_empty_stream/);
  assert.equal(attempts, 2);
});

// What the relay answers a Claude request it will not serve: a 200 whose only event is an `error`.
const anthropicRefusal = anthropicSse([{ type: "error", error: { type: "invalid_request_error", message: "Third-party apps now draw from extra usage, not plan limits." } }]);
const anthropicOverloaded = anthropicSse([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]);
const anthropicAnswer = anthropicSse([
  { type: "message_start", message: { id: "msg_ok", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" }
]);

for (const prefix of [[], [{ type: "ping" }], [{ type: "message_start", message: { id: "msg_rejected", usage: {} } }]]) {
  test(`Claude Chat preserves invalid request errors before content (${prefix[0]?.type || "first event"})`, async (context) => {
    let attempts = 0;
    const fixture = await gatewayFixture(context, async () => {
      attempts += 1;
      return new Response(anthropicSse([
        ...prefix,
        { type: "error", error: { type: "invalid_request_error", message: "Request rejected by upstream" } }
      ]), { headers: { "content-type": "text/event-stream" } });
    }, { accountCount: 2 });
    const response = await fixture.ask("/v1/chat/completions", "claude-opus-5-5", true);
    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.equal(error.type, "invalid_request_error");
    assert.equal(error.message, "Request rejected by upstream");
    assert.equal(attempts, 1);
  });
}

test("Claude Chat still fails over an overloaded stream before content", async (context) => {
  let attempts = 0;
  const fixture = await gatewayFixture(context, async () => {
    attempts += 1;
    return new Response(attempts === 1 ? anthropicOverloaded : anthropicAnswer, { headers: { "content-type": "text/event-stream" } });
  }, { accountCount: 2 });
  const response = await fixture.ask("/v1/chat/completions", "claude-opus-5-5", true);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /OK/);
  assert.equal(attempts, 2);
});

test("Claude on Responses fails over an account whose 200 stream opens with an error", async (context) => {
  let attempts = 0;
  const fixture = await gatewayFixture(context, async () => {
    attempts += 1;
    return new Response(attempts === 1 ? anthropicOverloaded : anthropicAnswer, { headers: { "content-type": "text/event-stream" } });
  }, { accountCount: 2 });
  const response = await fixture.ask("/v1/responses", "claude-sonnet-5", true);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /"delta":"OK"/);
  assert.match(body, /response\.completed/);
  assert.doesNotMatch(body, /Overloaded/);
  assert.equal(attempts, 2);
});

test("Claude on Responses answers a refusal inside a 200 stream with the relay's words, not an empty answer", async (context) => {
  let attempts = 0;
  const fixture = await gatewayFixture(context, async () => {
    attempts += 1;
    return new Response(anthropicRefusal, { headers: { "content-type": "text/event-stream" } });
  }, { accountCount: 2 });
  const response = await fixture.ask("/v1/responses", "claude-sonnet-5", true);
  assert.equal(response.status, 400);
  const { error } = await response.json();
  assert.equal(error.message, "Third-party apps now draw from extra usage, not plan limits.");
  assert.equal(attempts, 1);
});

test("Claude on Messages still hands an Anthropic client the relay's own error event", async (context) => {
  const fixture = await gatewayFixture(context, async () => new Response(anthropicRefusal, { headers: { "content-type": "text/event-stream" } }));
  const response = await fixture.ask("/v1/messages", "claude-sonnet-5", true);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), anthropicRefusal);
});

test("Claude on Responses ends a stream that fails after its first content as response.failed", async (context) => {
  const fixture = await gatewayFixture(context, async () => new Response(anthropicSse([
    { type: "message_start", message: { id: "msg_partial", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial" } },
    { type: "error", error: { type: "overloaded_error", message: "upstream failed" } }
  ]), { headers: { "content-type": "text/event-stream" } }));
  const response = await fixture.ask("/v1/responses", "claude-sonnet-5", true);
  assert.equal(response.status, 200);
  const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean)
    .map((frame) => JSON.parse(frame.split(/\r?\n/).find((line) => line.startsWith("data:")).slice(5)));
  assert.deepEqual(events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta), ["Partial"]);
  const failed = events.at(-1);
  assert.equal(failed.type, "response.failed");
  assert.equal(failed.response.status, "failed");
  assert.equal(failed.response.error.message, "upstream failed");
  assert.equal(events.some((event) => event.type === "response.completed"), false);
});

function anthropicSse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function timedResponse(first, last, waitMs, contentType, onCancel) {
  let timer;
  return new Response(new ReadableStream({
    start(controller) {
      if (first) controller.enqueue(Buffer.from(first));
      timer = setTimeout(() => { controller.enqueue(Buffer.from(last)); controller.close(); }, waitMs);
    },
    cancel() { clearTimeout(timer); onCancel(); }
  }), { headers: { "content-type": contentType } });
}

async function gatewayFixture(context, fetchImpl, { accountCount = 1, ...overrides } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-stall-regression-"));
  const homes = Array.from({ length: accountCount }, (_, index) => {
    const home = join(root, `account-${index}`);
    mkdirSync(home);
    writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: `user-${index}`, token: `token-${index}`, exp: 4_102_444_800 } }));
    return home;
  });
  const apiKeyFile = join(root, "keys.sqlite");
  const server = createGateway({
    host: "127.0.0.1", port: 0, homes, apiKeyFile,
    relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test",
    webAuth: { username: "console", password: "local-test", secureCookie: false }, models: [], reasoningMode: "managed",
    timeoutMs: 3000, firstByteTimeoutMs: 500, failoverBudgetMs: 500, streamIdleTimeoutMs: 5000, cooldownMs: 1000,
    ...overrides
  }, { fetchImpl, logger: { error() {} } });
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const key = new OpenAIKeyStore(apiKeyFile).create("Stall regression").key;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    ask(path, model, stream) {
      return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(1500),
        body: JSON.stringify({ model, stream, max_tokens: 64, ...(path === "/v1/responses" ? { input: "Hello" } : { messages: [{ role: "user", content: "Hello" }] }) })
      });
    }
  };
}
