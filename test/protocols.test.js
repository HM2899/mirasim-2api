import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/server.js";

test("Anthropic Messages uses x-api-key and preserves native protocol headers", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.href, "https://relay.example.test/v1/messages");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer mirasim-token");
    assert.equal(options.headers["anthropic-version"], "2023-06-01");
    assert.equal(options.headers["anthropic-beta"], "prompt-caching-2024-07-31");
    assert.equal(options.headers["x-api-key"], undefined);
    assert.deepEqual(JSON.parse(options.body), { model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "Reply exactly OK." }] });
    return json({ id: "msg_123", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Anthropic test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31"
      },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "Reply exactly OK." }] })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, "OK");

    const denied = await fetch(`${fixture.baseUrl}/v1/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { type: "error", error: { type: "authentication_error", message: "Missing or invalid API key." } });
  } finally {
    fixture.close();
  }
});

test("Responses requests translate to upstream chat completions and back", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.href, "https://relay.example.test/v1/chat/completions");
    assert.deepEqual(JSON.parse(options.body), {
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: "Be concise." }, { role: "user", content: "Reply exactly OK." }],
      stream: false,
      max_tokens: 1
    });
    return json({
      id: "chatcmpl_123",
      object: "chat.completion",
      created: 1_725_000_000,
      model: "gpt-4o-mini",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
      usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 }
    });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Responses test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", instructions: "Be concise.", input: "Reply exactly OK.", max_output_tokens: 1 })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: "resp_chatcmpl_123",
      object: "response",
      created_at: 1_725_000_000,
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: "Be concise.",
      max_output_tokens: 1,
      model: "gpt-4o-mini",
      output: [{ type: "message", id: "msg_chatcmpl_123", status: "completed", role: "assistant", content: [{ type: "output_text", text: "OK", annotations: [] }] }],
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: { effort: null, summary: null },
      store: false,
      temperature: 1,
      text: { format: { type: "text" } },
      tool_choice: "auto",
      tools: [],
      top_p: 1,
      usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 }
    });
  } finally {
    fixture.close();
  }
});

test("Responses streaming emits Responses SSE events", async () => {
  const fixture = gatewayFixture(async () => new Response([
    'data: {"id":"chatcmpl_123","model":"gpt-4o-mini","choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl_123","model":"gpt-4o-mini","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } }));

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Response stream test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", input: "Reply exactly OK.", stream: true })
    });
    const body = await response.text();
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.match(body, /event: response.created/);
    assert.match(body, /event: response.output_text.delta/);
    assert.match(body, /"delta":"OK"/);
    assert.match(body, /event: response.completed/);
  } finally {
    fixture.close();
  }
});

test("upstream first-byte timeout returns 504 promptly", async () => {
  const fixture = gatewayFixture((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }), { firstByteTimeoutMs: 20 });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Timeout test").key;
    await fixture.start();
    const started = Date.now();
    const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.type, "server_error");
    assert.ok(Date.now() - started < 1_000);
  } finally {
    fixture.close();
  }
});

test("timeout defaults keep streams responsive while bounding model discovery", () => {
  const config = loadConfig({ MIRASIM_HOME: "/tmp/mirasim-test", WEB_AUTH_PASSWORD: "password" });
  assert.equal(config.timeoutMs, 300_000);
  assert.equal(config.firstByteTimeoutMs, 45_000);
  assert.equal(config.modelListTimeoutMs, 10_000);
  assert.equal(config.modelHealthIntervalMs, 60_000);
  assert.equal(config.modelHealthTimeoutMs, 12_000);
  assert.equal(config.loginUrl, "https://admin.test.mirofish.ai");
});

function gatewayFixture(fetchImpl, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-protocols-"));
  const home = join(root, "account-a");
  const apiKeyFile = join(root, "api-keys.json");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: "user-a", token: "mirasim-token", exp: 4_102_444_800 } }));
  const server = createGateway({
    host: "127.0.0.1",
    port: 0,
    homes: [home],
    apiKeyFile,
    relayUrl: "https://relay.example.test",
    loginUrl: "https://login.example.test",
    webAuth: { username: "console", password: "correct-password", secureCookie: false },
    models: [],
    timeoutMs: 30_000,
    cooldownMs: 30_000,
    ...overrides
  }, { fetchImpl, logger: { error() {} } });
  let baseUrl;
  return {
    apiKeyFile,
    async start() {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    },
    get baseUrl() { return baseUrl; },
    close() {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
