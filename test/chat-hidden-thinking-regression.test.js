import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { createGateway } from "../src/server.js";

// A Claude model thinking with its thinking hidden sends nothing but empty thinking_deltas that
// carry a token estimate. Every bridge has to keep that generation alive for as long as the
// estimates keep coming, past the first-content deadline, without passing any of it on.
const opening = [
  { type: "message_start", message: { id: "msg_sonnet", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }
];
const hidden = { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "", estimated_tokens: 64 } };
const closeThinking = [
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
  { type: "content_block_stop", index: 0 }
];
const textAnswer = [
  ...closeThinking,
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "OK" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } },
  { type: "message_stop" }
];
const toolAnswer = [
  ...closeThinking,
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_hidden", name: "read_file", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.txt\"}" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 100 } },
  { type: "message_stop" }
];
const timing = { firstByteTimeoutMs: 100, streamIdleTimeoutMs: 150 };

test("Claude Chat stream keeps a valid estimate that arrived in the first coalesced frame", async (context) => {
  const upstream = scriptedUpstream([textAnswer], [...opening, hidden], 180, 0);
  const fixture = await gatewayFixture(context, upstream.fetch, { firstByteTimeoutMs: 100, streamIdleTimeoutMs: 400 });
  const response = await fixture.ask("/v1/chat/completions", "claude-sonnet-5-5", true);
  const wire = await response.text();
  assert.equal(response.status, 200, wire);
  assert.match(wire, /OK/);
  assert.equal(upstream.cancelled, true);
});

test("non-Claude Anthropic bridges do not use Claude hidden-thinking renewal", async (context) => {
  const upstream = scriptedUpstream([...Array(4).fill(hidden), ...Array(20).fill({ type: "ping" }), textAnswer]);
  const fixture = await gatewayFixture(context, upstream.fetch, timing);
  const response = await fixture.ask("/v1/chat/completions", "glm-5.3-flash", true);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "upstream_stream_timeout");
  assert.equal(upstream.cancelled, true);
});

for (const [path, stream] of ["/v1/messages", "/v1/chat/completions", "/v1/responses"].flatMap((path) => [false, true].map((stream) => [path, stream]))) {
  test(`${path} hidden thinking stays active until the answer (stream=${stream})`, async (context) => {
    const upstream = scriptedUpstream([...Array(12).fill(hidden), textAnswer]);
    const fixture = await gatewayFixture(context, upstream.fetch, timing);
    const response = await fixture.ask(path, "claude-sonnet-5-5", stream);
    const wire = await response.text();
    assert.equal(response.status, 200, wire);
    assert.match(wire, /OK/);
    assert.doesNotMatch(wire, /upstream_stream_timeout/);
    assert.equal(upstream.cancelled, true);
  });
}

test("Claude Chat stream keeps estimates, signatures and invented reasoning off the wire and out of usage", async (context) => {
  const upstream = scriptedUpstream([...Array(12).fill(hidden), textAnswer]);
  const fixture = await gatewayFixture(context, upstream.fetch, timing);
  const response = await fixture.ask("/v1/chat/completions", "claude-sonnet-5-5", true, { stream_options: { include_usage: true } });
  const wire = await response.text();
  assert.equal(response.status, 200, wire);
  assert.doesNotMatch(wire, /estimated_tokens|signature|signed|reasoning_content|reasoning"|thinking|progress/);
  const chunks = wire.split(/\r?\n\r?\n/).filter((frame) => frame.startsWith("data: {")).map((frame) => JSON.parse(frame.slice(6)));
  assert.deepEqual(chunks.flatMap((chunk) => chunk.choices.map((choice) => choice.delta.content)).filter(Boolean), ["OK"]);
  const { usage } = chunks.find((chunk) => chunk.usage);
  assert.equal(usage.prompt_tokens, 10);
  assert.equal(usage.completion_tokens, 100);
  assert.equal(usage.total_tokens, 110);
  assert.match(wire, /data: \[DONE\]\n\n$/);
});

test("Claude Chat stream delivers a tool call that follows long hidden thinking", async (context) => {
  const upstream = scriptedUpstream([...Array(12).fill(hidden), toolAnswer]);
  const fixture = await gatewayFixture(context, upstream.fetch, timing);
  const response = await fixture.ask("/v1/chat/completions", "claude-sonnet-5-5", true);
  const wire = await response.text();
  assert.equal(response.status, 200, wire);
  assert.match(wire, /"name":"read_file"/);
  assert.match(wire, /"finish_reason":"tool_calls"/);
  assert.doesNotMatch(wire, /estimated_tokens|signed/);
});

test("Claude Chat stream still times out and cancels once hidden progress stops behind pings", async (context) => {
  const upstream = scriptedUpstream([...Array(4).fill(hidden), ...Array(60).fill({ type: "ping" }), textAnswer]);
  const fixture = await gatewayFixture(context, upstream.fetch, timing);
  const startedAt = Date.now();
  const response = await fixture.ask("/v1/chat/completions", "claude-sonnet-5-5", true);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "upstream_stream_timeout");
  assert.ok(Date.now() - startedAt < 1000, `took ${Date.now() - startedAt}ms`);
  assert.equal(upstream.cancelled, true);
});

test("Claude Chat stream does not renew its deadline for pings, usage, comments or invalid estimates", async (context) => {
  const invalid = [0, -1, 1.5, "64", null, 2 ** 53, Number.NaN].map((estimated_tokens) => ({
    type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "", estimated_tokens }
  }));
  const noise = [
    ...invalid,
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "", estimated_tokens: 64 } },
    { type: "ping" },
    { type: "message_delta", delta: {}, usage: { output_tokens: 64 } },
    ": keepalive estimated_tokens 64"
  ];
  const upstream = scriptedUpstream([...noise, ...noise, ...noise, textAnswer]);
  const fixture = await gatewayFixture(context, upstream.fetch, timing);
  const startedAt = Date.now();
  const response = await fixture.ask("/v1/chat/completions", "claude-sonnet-5-5", true);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "upstream_stream_timeout");
  assert.ok(Date.now() - startedAt < 600, `took ${Date.now() - startedAt}ms`);
  assert.equal(upstream.cancelled, true);
});

test("Claude Chat stream keeps a refusal after hidden thinking as the relay's 400 on the same account", async (context) => {
  let attempts = 0;
  const fixture = await gatewayFixture(context, (...args) => {
    attempts += 1;
    return scriptedUpstream([...Array(6).fill(hidden), { type: "error", error: { type: "invalid_request_error", message: "Request rejected by upstream" } }]).fetch(...args);
  }, { ...timing, accountCount: 2 });
  const response = await fixture.ask("/v1/chat/completions", "claude-sonnet-5-5", true);
  assert.equal(response.status, 400);
  const { error } = await response.json();
  assert.equal(error.type, "invalid_request_error");
  assert.equal(error.message, "Request rejected by upstream");
  assert.equal(attempts, 1);
});

for (const [name, ending, code] of [
  ["message_stop", [...closeThinking, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } }, { type: "message_stop" }], "upstream_empty_stream"],
  ["EOF", [], "upstream_stream_incomplete"]
]) {
  test(`Claude Chat stream does not turn hidden thinking followed by ${name} into an answer`, async (context) => {
    const upstream = scriptedUpstream([...Array(6).fill(hidden), ending]);
    const fixture = await gatewayFixture(context, upstream.fetch, timing);
    const response = await fixture.ask("/v1/chat/completions", "claude-sonnet-5-5", true);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, code);
  });
}

test("Claude Chat stream cancels its upstream when the caller leaves during hidden thinking", async (context) => {
  const upstream = scriptedUpstream(Array(200).fill(hidden));
  const fixture = await gatewayFixture(context, upstream.fetch, timing);
  const caller = new AbortController();
  const pending = fixture.ask("/v1/chat/completions", "claude-sonnet-5-5", true, {}, caller.signal);
  await delay(250);
  assert.equal(upstream.cancelled, false, "hidden progress should still be holding the stream open");
  caller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  for (let waited = 0; !upstream.cancelled && waited < 1000; waited += 20) await delay(20);
  assert.equal(upstream.cancelled, true);
});

// Each script step is one event, a raw SSE line, or a list of events sent together, 30ms apart.
function scriptedUpstream(script, initial = opening, stepDelayMs = 30, initialDelayMs = 0) {
  const result = { cancelled: false };
  result.fetch = async () => {
    let step = 0;
    return new Response(new ReadableStream({
      async start(controller) {
        if (initialDelayMs) await delay(initialDelayMs);
        controller.enqueue(Buffer.from(sse(initial)));
      },
      async pull(controller) {
        await delay(stepDelayMs);
        if (result.cancelled) return;
        if (step >= script.length) return controller.close();
        const next = script[step++];
        controller.enqueue(Buffer.from(typeof next === "string" ? `${next}\n\n` : sse(Array.isArray(next) ? next : [next])));
      },
      cancel() { result.cancelled = true; }
    }), { headers: { "content-type": "text/event-stream" } });
  };
  return result;
}

function sse(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function gatewayFixture(context, fetchImpl, { accountCount = 1, ...overrides } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-hidden-thinking-"));
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
  const key = new OpenAIKeyStore(apiKeyFile).create("Hidden thinking regression").key;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    ask(path, model, stream, extra = {}, signal = AbortSignal.timeout(1500)) {
      return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, signal,
        body: JSON.stringify({ model, stream, max_tokens: 64, ...extra, ...(path === "/v1/responses" ? { input: "Hello" } : { messages: [{ role: "user", content: "Hello" }] }) })
      });
    }
  };
}
