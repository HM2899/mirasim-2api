import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/server.js";
import { sseHeartbeat } from "../src/stream-lifecycle.js";

const PING = 'event: ping\ndata: {"type":"ping"}\n\n';
const COMMENT = ": keepalive\n\n";
const events = (...values) => values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");

// Each upstream answers in two halves with a silence between them; the first half already
// carries content, so by the silence the caller holds part of the answer.
const upstreams = {
  claude: {
    first: events(
      { type: "message_start", message: { id: "msg_quiet", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
    rest: events(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" })
  },
  gpt: {
    first: events(
      { type: "response.created", response: { id: "resp_quiet", object: "response", model: "gpt-test", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_quiet", type: "message", role: "assistant", status: "in_progress", content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_quiet", delta: "Hel" }),
    rest: events(
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_quiet", delta: "lo" },
      { type: "response.output_item.done", output_index: 0, item: { id: "msg_quiet", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] } },
      { type: "response.completed", response: { id: "resp_quiet", object: "response", model: "gpt-test", status: "completed", output: [{ id: "msg_quiet", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } })
  }
};

function quietUpstream(kind, silenceMs) {
  return async () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(Buffer.from(upstreams[kind].first));
      await delay(silenceMs);
      try {
        controller.enqueue(Buffer.from(upstreams[kind].rest));
        controller.close();
      } catch {}
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

const routes = [
  ["/v1/messages", "claude-sonnet-5-5", "claude", PING],
  ["/v1/chat/completions", "claude-sonnet-5-5", "claude", COMMENT],
  ["/v1/responses", "claude-sonnet-5-5", "claude", COMMENT],
  ["/v1/responses", "gpt-test", "gpt", COMMENT],
  ["/v1/chat/completions", "gpt-test", "gpt", COMMENT],
  ["/v1/messages", "gpt-test", "gpt", PING]
];

for (const [path, model, kind, heartbeat] of routes) {
  test(`${path} ${model}: a silence past the idle timeout is bridged with heartbeats, not cut`, async (context) => {
    const fixture = await gatewayFixture(context, quietUpstream(kind, 600), {
      streamIdleTimeoutMs: 150, streamStallTimeoutMs: 5_000, streamHeartbeatIntervalMs: 50
    });
    const response = await fixture.ask(path, model);
    assert.equal(response.status, 200);
    const wire = await response.text();
    assert.ok(wire.includes(heartbeat), "the caller must see heartbeats during the silence");
    assert.match(wire, /lo/);
    assert.match(wire, /message_stop|response\.completed|\[DONE\]/);
    assert.doesNotMatch(wire, /upstream_stream_timeout|upstream_stream_error/);
    // A heartbeat only ever goes between two frames.
    for (const frame of wire.split(/\n\n/)) assert.doesNotMatch(frame, /.:\s?keepalive|.event: ping/s);
  });
}

for (const [path, model, kind] of [["/v1/messages", "claude-sonnet-5-5", "claude"], ["/v1/responses", "gpt-test", "gpt"]]) {
  test(`${path} ${model}: a stall past the stall timeout still ends with an error event`, async (context) => {
    const fixture = await gatewayFixture(context, quietUpstream(kind, 3_000), {
      streamIdleTimeoutMs: 100, streamStallTimeoutMs: 300, streamHeartbeatIntervalMs: 50
    });
    const started = Date.now();
    const response = await fixture.ask(path, model);
    const wire = await response.text();
    assert.ok(Date.now() - started < 2_000, "the gateway, not the upstream, must end the stall");
    assert.match(wire, /upstream_stream_timeout|upstream_stream_error/);
    assert.doesNotMatch(wire, /"lo"/);
  });
}

for (const [path, model, kind, heartbeat] of [
  ["/v1/responses", "gpt-test", "gpt", COMMENT],
  ["/v1/chat/completions", "gpt-test", "gpt", COMMENT],
  ["/v1/messages", "gpt-test", "gpt", PING]
]) {
  test(`${path} ${model}: a GPT request queued before its headers is held open like a Claude one`, async (context) => {
    const fixture = await gatewayFixture(context, async () => {
      await delay(250);
      return new Response(upstreams[kind].first + upstreams[kind].rest, { headers: { "content-type": "text/event-stream" } });
    }, { queueHoldDelayMs: 20, queueHoldIntervalMs: 30, firstByteTimeoutMs: 2_000 });
    const response = await fixture.ask(path, model);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = Buffer.from((await reader.read()).value).toString();
    assert.ok(first.startsWith(heartbeat), `the first bytes must be a heartbeat, got ${JSON.stringify(first.slice(0, 40))}`);
    let wire = first;
    for (let result = await reader.read(); !result.done; result = await reader.read()) wire += Buffer.from(result.value).toString();
    assert.match(wire, /lo/);
  });
}

test("a GPT request refused after the hold committed reports the refusal in-stream", async (context) => {
  const fixture = await gatewayFixture(context, async () => {
    await delay(150);
    return Response.json({ error: { type: "invalid_request_error", message: "nope" } }, { status: 400 });
  }, { queueHoldDelayMs: 20, queueHoldIntervalMs: 30, firstByteTimeoutMs: 2_000 });
  const response = await fixture.ask("/v1/responses", "gpt-test");
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.match(wire, /^: keepalive/);
  assert.match(wire, /event: error/);
  assert.match(wire, /nope/);
});

test("a fast GPT answer keeps its real status: the hold only commits after a silence", async (context) => {
  const fixture = await gatewayFixture(context, async () => Response.json({ error: { type: "invalid_request_error", message: "nope" } }, { status: 400 }), {
    queueHoldDelayMs: 1_000, queueHoldIntervalMs: 30
  });
  const response = await fixture.ask("/v1/responses", "gpt-test");
  assert.equal(response.status, 400);
  await response.text();
});

test("sseHeartbeat never splits a frame that arrives in pieces", async () => {
  const source = Readable.from((async function* () {
    yield Buffer.from("data: {\"a\"");
    await delay(120);
    yield Buffer.from(":1}\n");
    await delay(120);
    yield Buffer.from("\ndata: {\"b\":2}\n\n");
    await delay(120);
  })());
  let wire = "";
  for await (const chunk of sseHeartbeat(source, { heartbeat: COMMENT, intervalMs: 30 })) wire += chunk.toString();
  assert.ok(wire.startsWith('data: {"a":1}\n\ndata: {"b":2}\n\n'), JSON.stringify(wire));
  assert.ok(wire.endsWith(COMMENT), "a heartbeat follows once the stream is between frames");
});

test("sseHeartbeat sends nothing while frames keep arriving", async () => {
  const source = Readable.from((async function* () {
    for (let index = 0; index < 8; index += 1) {
      yield Buffer.from(`data: ${index}\n\n`);
      await delay(10);
    }
  })());
  let wire = "";
  for await (const chunk of sseHeartbeat(source, { heartbeat: COMMENT, intervalMs: 200 })) wire += chunk.toString();
  assert.doesNotMatch(wire, /keepalive/);
});

test("stream stall and heartbeat settings have defaults and overrides", () => {
  const env = { MIRASIM_HOME: "/tmp/mirasim-keepalive-config", WEB_AUTH_PASSWORD: "password" };
  assert.equal(loadConfig(env).streamStallTimeoutMs, 1_800_000);
  assert.equal(loadConfig(env).streamHeartbeatIntervalMs, 15_000);
  assert.equal(loadConfig({ ...env, MIRASIM_STREAM_STALL_TIMEOUT_MS: "60000" }).streamStallTimeoutMs, 60_000);
  assert.equal(loadConfig({ ...env, MIRASIM_STREAM_HEARTBEAT_MS: "5000" }).streamHeartbeatIntervalMs, 5_000);
  assert.throws(() => loadConfig({ ...env, MIRASIM_STREAM_STALL_TIMEOUT_MS: "bad" }), /MIRASIM_STREAM_STALL_TIMEOUT_MS/);
});

async function gatewayFixture(context, fetchImpl, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-stream-keepalive-"));
  const home = join(root, "account-0");
  mkdirSync(home);
  writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: "user-0", token: "token-0", exp: 4_102_444_800 } }));
  const apiKeyFile = join(root, "keys.sqlite");
  const server = createGateway({
    host: "127.0.0.1", port: 0, homes: [home], apiKeyFile,
    relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test",
    webAuth: { username: "console", password: "local-test", secureCookie: false }, models: [], reasoningMode: "managed",
    timeoutMs: 5000, firstByteTimeoutMs: 500, failoverBudgetMs: 500, streamIdleTimeoutMs: 5000, cooldownMs: 1000,
    ...overrides
  }, { fetchImpl, logger: { error() {} } });
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const key = new OpenAIKeyStore(apiKeyFile).create("Stream keepalive").key;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    ask(path, model) {
      return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ model, stream: true, max_tokens: 64, ...(path === "/v1/responses" ? { input: "Hello" } : { messages: [{ role: "user", content: "Hello" }] }) })
      });
    }
  };
}
