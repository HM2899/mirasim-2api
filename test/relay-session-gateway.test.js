import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { createGateway } from "../src/server.js";

async function gatewayFixture(context, fetchImpl) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-session-gateway-"));
  const homes = ["account-a", "account-b"].map((account) => {
    const home = join(root, account);
    mkdirSync(home);
    writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: account, token: `secret-${account}`, exp: 4_102_444_800 } }));
    return home;
  });
  const apiKeyFile = join(root, "api-keys.json");
  const server = createGateway({
    homes, apiKeyFile, relayUrl: "https://relay.mirasim.ai", loginUrl: "https://login.example.test",
    webAuth: { username: "console", password: "test-password", secureCookie: false },
    models: [], timeoutMs: 1000, cooldownMs: 30_000
  }, { fetchImpl, logger: { error() {} } });
  const key = new OpenAIKeyStore(apiKeyFile).create("session test").key;
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return ({ path = "/v1/messages", headers = {}, body = {} } = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      "x-mirasim-device": "caller-injection", "x-mirasim-enc": "caller-injection",
      "x-mirasim-call": "caller-injection",
      ...headers
    },
    body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 16, messages: [{ role: "user", content: "Hi" }], ...body })
  });
}

for (const status of [403, 429]) {
  test(`mint HTTP ${status} stops the request without unsigned fallback or account hopping`, async (context) => {
    const requests = [];
    const send = await gatewayFixture(context, async (url) => {
      requests.push(url.pathname);
      return new Response("sensitive upstream refusal", { status, headers: { "retry-after": "7200" } });
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await send();
      assert.equal(response.status, 503);
      assert.ok(Number(response.headers.get("retry-after")) >= 7199);
      const body = await response.text();
      assert.match(body, /relay_session_unavailable/);
      assert.doesNotMatch(body, /secret-account|sensitive upstream/);
      assert.equal(requests.length, Math.min(attempt + 1, 2));
    }
    assert.deepEqual(requests, ["/v1/device/session", "/v1/device/session"]);
  });
}

test("the official relay receives a ticket and sealed metadata, never caller credentials or metadata", async (context) => {
  const seen = [];
  const send = await gatewayFixture(context, async (url, options) => {
    seen.push({ path: url.pathname, headers: options.headers });
    if (url.pathname === "/v1/device/session") return Response.json({ ticket: "device-ticket", expiresIn: 3600 });
    return Response.json({ id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const response = await send();
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(seen.map((entry) => entry.path), ["/v1/device/session", "/v1/messages"]);
  const headers = seen[1].headers;
  assert.equal(headers.Authorization, "Bearer device-ticket");
  assert.equal(headers["x-mirasim-client"], "0.0.516");
  assert.ok(headers["x-mirasim-enc"]);
  assert.deepEqual(Object.keys(headers).filter((name) => name.startsWith("x-mirasim-")).sort(), ["x-mirasim-client", "x-mirasim-enc"]);
  assert.doesNotMatch(JSON.stringify(headers), /secret-account|caller-injection/);
});

test("an upstream 400 is preserved and never retried on another account", async (context) => {
  const seen = [];
  const payload = { error: { message: "the request was rejected as invalid", type: "invalid_request_error" }, request_id: "a7151a92d5568ed5e5b48df5e4aa3981", type: "error" };
  const send = await gatewayFixture(context, async (url) => {
    seen.push(url.pathname);
    return url.pathname === "/v1/device/session"
      ? Response.json({ ticket: "device-ticket", expiresIn: 3600 })
      : Response.json(payload, { status: 400 });
  });
  const response = await send();
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), payload);
  assert.deepEqual(seen, ["/v1/device/session", "/v1/messages"]);
});

test("official image aliases use a device ticket and sealed metadata without altering image fields", async (context) => {
  const seen = [];
  const send = await gatewayFixture(context, async (url, options) => {
    seen.push(url.pathname);
    if (url.pathname === "/v1/device/session") return Response.json({ ticket: "image-device-ticket", expiresIn: 3600 });
    assert.equal(url.pathname, "/v1/images/generations");
    assert.equal(options.headers.Authorization, "Bearer image-device-ticket");
    assert.equal(options.headers["x-mirasim-client"], "0.0.516");
    assert.ok(options.headers["x-mirasim-enc"]);
    assert.doesNotMatch(JSON.stringify(options.headers), /secret-account|caller-injection/);
    const body = JSON.parse(options.body);
    assert.equal(body.model, "gpt-image-1");
    assert.equal(body.prompt, "A tree");
    assert.equal(body.size, "1024x1024");
    assert.equal(body.store, undefined);
    assert.equal(body.stream, undefined);
    return Response.json({ data: [{ b64_json: "aW1hZ2U=" }] });
  });
  const response = await send({ path: "/backend-api/codex/images/generations", body: { model: "gpt-image-1", prompt: "A tree", size: "1024x1024" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].b64_json, "aW1hZ2U=");
  assert.deepEqual(seen, ["/v1/device/session", "/v1/images/generations"]);
});

for (const [label, beta, expected] of [
  ["API-key", "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14", "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14"],
  ["OAuth beta filtering", "claude-code-20250219, oauth-2025-04-20 , interleaved-thinking-2025-05-14", "claude-code-20250219,interleaved-thinking-2025-05-14"],
  ["OAuth-only beta removal", "oauth-2025-04-20", undefined]
]) {
  test(`sub2api-shaped streaming tests preserve payload/query and apply official ${label} headers`, async (context) => {
    const metadata = { user_id: "sub2api-local-test-session" };
    const system = [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } }];
    const send = await gatewayFixture(context, async (url, options) => {
      if (url.pathname === "/v1/device/session") return Response.json({ ticket: "device-ticket", expiresIn: 3600 });
      assert.equal(url.pathname, "/v1/messages");
      assert.equal(url.search, "?beta=true");
      assert.equal(options.headers["anthropic-beta"], expected);
      assert.equal(options.headers["anthropic-version"], "2023-06-01");
      assert.equal(options.headers.Authorization, "Bearer device-ticket");
      assert.ok(options.headers["x-mirasim-enc"]);
      assert.equal(options.headers["x-mirasim-call"], undefined);
      const body = JSON.parse(options.body);
      assert.equal(body.model, "claude-opus-4-6");
      assert.equal(body.max_tokens, 1024);
      assert.equal(Object.hasOwn(body, "temperature"), false);
      assert.equal(body.stream, true);
      assert.deepEqual(body.metadata, metadata);
      assert.deepEqual(body.system, system);
      return new Response('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_local","type":"message","role":"assistant","content":[],"model":"claude-opus-4-6","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', {
        headers: { "content-type": "text/event-stream" }
      });
    });
    const response = await send({
      path: "/v1/messages?beta=true",
      headers: { "anthropic-beta": beta, "anthropic-version": "2023-06-01" },
      body: {
        model: "claude-opus-4-6", max_tokens: 1024, temperature: 1, stream: true,
        metadata, system,
        messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }]
      }
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /event: message_stop/);
  });
}

for (const [path, model] of [
  ["/v1/messages?beta=true", "claude-opus-4-6"],
  ["/v1/messages?beta=true", "claude-opus-4-8"],
  ["/v1/chat/completions", "claude-opus-4-8"],
  ["/v1/responses", "claude-opus-4-8"]
]) {
  test(`official relay removes temperature:1 before sending ${model} through ${path}`, async (context) => {
    let attempts = 0;
    const send = await gatewayFixture(context, async (url, options) => {
      if (url.pathname === "/v1/device/session") return Response.json({ ticket: "device-ticket", expiresIn: 3600 });
      attempts += 1;
      assert.equal(url.pathname, "/v1/messages");
      const body = JSON.parse(options.body);
      if (Object.hasOwn(body, "temperature")) {
        return Response.json({ error: { message: "the request was rejected as invalid", type: "invalid_request_error" } }, { status: 400 });
      }
      assert.equal(body.model, model);
      assert.equal(body.max_tokens, 1024);
      assert.equal(body.thinking?.type === "enabled" || body.thinking?.type === "adaptive", false);
      assert.ok(options.headers["x-mirasim-enc"]);
      return Response.json({
        id: "msg_temperature", type: "message", role: "assistant", model,
        content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }
      });
    });
    const response = await send({
      path,
      body: {
        model, max_tokens: 1024, max_output_tokens: 1024, temperature: 1, stream: false,
        reasoning_effort: "none", thinking: { type: "disabled" },
        ...(path === "/v1/responses" ? { input: "hi" } : {})
      }
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /OK/);
    assert.equal(attempts, 1);
  });
}

test("a Chat-backed OpenAI request keeps its temperature on the official relay", async (context) => {
  const send = await gatewayFixture(context, async (url, options) => {
    if (url.pathname === "/v1/device/session") return Response.json({ ticket: "device-ticket", expiresIn: 3600 });
    assert.equal(url.pathname, "/v1/chat/completions");
    assert.equal(JSON.parse(options.body).temperature, 1);
    return Response.json({ id: "chat_temperature", object: "chat.completion", model: "deepseek-v4-pro", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
  });
  const response = await send({ path: "/v1/chat/completions", body: { model: "deepseek-v4-pro", temperature: 1 } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /OK/);
});

test("GPT Chat requests use signed Responses transport without rejected sampling fields", async (context) => {
  const send = await gatewayFixture(context, async (url, options) => {
    if (url.pathname === "/v1/device/session") return Response.json({ ticket: "device-ticket", expiresIn: 3600 });
    assert.equal(url.pathname, "/v1/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.temperature, undefined);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.ok(options.headers["x-mirasim-enc"]);
    return Response.json({ id: "resp_temperature", output: [{ id: "msg_temperature", type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }] });
  });
  const response = await send({ path: "/v1/chat/completions", body: { model: "gpt-5.6-luna", temperature: 1 } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "OK");
});
