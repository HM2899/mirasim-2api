import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { createGateway } from "../src/server.js";

function messageFrames(terminal = true) {
  return [
    { type: "message_start", message: { id: "msg_close", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    ...(terminal ? [
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" }
    ] : [])
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

for (const path of ["/v1/messages", "/v1/chat/completions", "/v1/responses", "/backend-api/codex/responses"]) {
  test(`${path} closes a completed Anthropic upstream without waiting for EOF or logging 499`, async (context) => {
    let cancelled = false;
    const fixture = await gatewayFixture(context, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(messageFrames())); },
      cancel() { cancelled = true; }
    }), { headers: { "content-type": "text/event-stream" } }));
    const response = await fixture.ask(path);
    assert.equal(response.status, 200);
    const wire = await response.text();
    assert.match(wire, /OK/);
    assert.match(wire, /cached_tokens":80|cache_read_input_tokens":80/);
    assert.equal(cancelled, true);
    const entry = await fixture.finishedLog();
    assert.equal(entry.status, 200);
    assert.equal(entry.stage, "completed");
    assert.equal(entry.streamError, null);
    assert.equal(entry.outputTokens, 2);
    assert.equal(entry.cacheReadTokens, 80);
  });

  test(`${path} keeps a genuine client cancellation as 499 and cancels upstream`, async (context) => {
    let cancelled = false;
    let signal;
    let attempts = 0;
    const fixture = await gatewayFixture(context, async (url, options) => {
      signal = options.signal;
      attempts += 1;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(Buffer.from(messageFrames(false))); },
        cancel() { cancelled = true; }
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const response = await fixture.ask(path);
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    const entry = await fixture.finishedLog();
    assert.equal(entry.status, 499);
    assert.equal(entry.stage, "client_disconnected");
    assert.equal(entry.streamError, null);
    assert.equal(cancelled, true);
    assert.equal(signal.aborted, true);
    assert.equal(attempts, 1);
  });
}

for (const path of ["/v1/chat/completions", "/v1/responses", "/backend-api/codex/responses"]) {
  test(`${path} non-streaming Anthropic conversion completes without cancellation or lost usage`, async (context) => {
    let cancelled = false;
    const fixture = await gatewayFixture(context, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(messageFrames())); },
      cancel() { cancelled = true; }
    }), { headers: { "content-type": "text/event-stream" } }));
    const response = await fixture.ask(path, false);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const payload = await response.json();
    assert.match(JSON.stringify(payload), /OK/);
    assert.equal(payload.usage.prompt_tokens_details?.cached_tokens ?? payload.usage.input_tokens_details?.cached_tokens, 80);
    const entry = await fixture.finishedLog();
    assert.equal(entry.status, 200);
    assert.equal(entry.stage, "completed");
    assert.equal(entry.outputTokens, 2);
    assert.equal(cancelled, true);
  });
}

test("a body transport failure remains 502 rather than becoming a client cancellation", async (context) => {
  let source;
  const fixture = await gatewayFixture(context, async () => new Response(new ReadableStream({
    start(controller) {
      source = controller;
      controller.enqueue(Buffer.from(messageFrames(false)));
    }
  }), { headers: { "content-type": "text/event-stream" } }));
  const response = await fixture.ask("/v1/messages");
  const reader = response.body.getReader();
  await reader.read();
  source.error(new Error("Upstream connection reset"));
  let wire = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    wire += new TextDecoder().decode(result.value);
  }
  assert.match(wire, /event: error/);
  assert.match(wire, /upstream_stream_error/);
  assert.doesNotMatch(wire, /message_stop/);
  const entry = await fixture.finishedLog();
  assert.equal(entry.status, 502);
  assert.equal(entry.stage, "failed");
  assert.equal(entry.streamError, "upstream_error_event");
});

test("an Anthropic error frame ends the connection as failure, not 499", async (context) => {
  let cancelled = false;
  let attempts = 0;
  const fixture = await gatewayFixture(context, async () => {
    attempts += 1;
    return new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from(messageFrames(false) + 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"upstream failed"}}\n\n')); },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } });
  }, 2);
  const response = await fixture.ask("/v1/messages");
  assert.match(await response.text(), /upstream failed/);
  const entry = await fixture.finishedLog();
  assert.equal(entry.status, 502);
  assert.equal(entry.stage, "failed");
  assert.equal(entry.streamError, "upstream_error_event");
  assert.equal(cancelled, true);
  assert.equal(attempts, 1);
  assert.equal(entry.upstreamError.type, "overloaded_error");
  assert.equal(entry.upstreamError.message, "upstream failed");
});

async function gatewayFixture(context, fetchImpl, accountCount = 1) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-disconnect-"));
  const home = join(root, "account");
  mkdirSync(home);
  writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: "test", token: "local-token", exp: 4_102_444_800 } }));
  const homes = [home];
  for (let index = 1; index < accountCount; index += 1) {
    const extraHome = join(root, `account-${index}`);
    mkdirSync(extraHome);
    writeFileSync(join(extraHome, "setting.json"), JSON.stringify({ auth: { userId: `test-${index}`, token: "local-token", exp: 4_102_444_800 } }));
    homes.push(extraHome);
  }
  const apiKeyFile = join(root, "keys.sqlite");
  const server = createGateway({
    host: "127.0.0.1", port: 0, homes, apiKeyFile,
    relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test", models: [],
    webAuth: { username: "console", password: "local-password", secureCookie: false }, reasoningMode: "managed",
    timeoutMs: 5000, firstByteTimeoutMs: 2000, streamIdleTimeoutMs: 5000
  }, { fetchImpl, logger: { error() {} } });
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const key = new OpenAIKeyStore(apiKeyFile).create("Disconnect regression").key;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "console", password: "local-password" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await login.text();
  return {
    ask(path, stream = true) {
      return fetch(`${baseUrl}${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(1000),
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 128, stream, ...(path.endsWith("/responses") ? { input: "Hello" } : { messages: [{ role: "user", content: "Hello" }] }) })
      });
    },
    async finishedLog() {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await fetch(`${baseUrl}/api/usage-log`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(1000) });
        const [entry] = (await response.json()).entries;
        if (entry && !entry.pending) return entry;
        await delay(10);
      }
      assert.fail("Request log did not finalize");
    }
  };
}

for (const metadata of [false, true]) {
  test(`native Anthropic retries an early overload with metadata=${metadata}`, async (context) => {
    let attempts = 0;
    const fixture = await gatewayFixture(context, async () => {
      attempts += 1;
      const prefix = metadata ? 'data: {"type":"message_start","message":{"id":"failed"}}\n\ndata: {"type":"ping"}\n\n' : "";
      return new Response(attempts === 1 ? prefix + 'data: {"type":"error","error":{"type":"overloaded_error","message":"Busy"}}\n\n' : messageFrames(), { headers: { "content-type": "text/event-stream" } });
    }, 2);
    const response = await fixture.ask("/v1/messages");
    const wire = await response.text();
    assert.equal(attempts, 2);
    assert.match(wire, /OK/);
    assert.doesNotMatch(wire, /Busy|failed/);
    const entry = await fixture.finishedLog();
    assert.equal(entry.status, 200);
    assert.equal(entry.streamError, null);
    assert.deepEqual(entry.attempts.map((attempt) => attempt.status), [502, 200]);
  });
}

test("native Anthropic does not retry permanent errors and preserves error details", async (context) => {
  let attempts = 0;
  const fixture = await gatewayFixture(context, async () => {
    attempts += 1;
    return new Response('data: {"type":"error","error":{"type":"invalid_request_error","message":"Invalid schema"}}\n\n', { headers: { "content-type": "text/event-stream" } });
  }, 2);
  const response = await fixture.ask("/v1/messages");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Invalid schema/);
  assert.equal(attempts, 1);
  const entry = await fixture.finishedLog();
  assert.equal(entry.upstreamError.type, "invalid_request_error");
  assert.equal(entry.upstreamError.message, "Invalid schema");
});
