import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGateway } from "../src/server.js";
import { OpenAIKeyStore } from "../src/api-keys.js";

function fixture(fetchImpl, count = 1) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-client-metadata-"));
  const homes = [];
  for (let i = 0; i < count; i++) {
    const home = join(root, `profile-${i}`);
    mkdirSync(home);
    writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: `user-${i}`, token: `fixture-${i}`, exp: 4102444800 } }));
    homes.push(home);
  }
  const apiKeyFile = join(root, "state.sqlite");
  const server = createGateway({ host: "127.0.0.1", port: 0, homes, apiKeyFile,
    relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test",
    webAuth: { username: "test", password: "test-only-password", secureCookie: false },
    models: [], timeoutMs: 3000, cooldownMs: 1000, defaultReasoningEffort: "none"
  }, { fetchImpl, logger: { error() {} } });
  const key = new OpenAIKeyStore(apiKeyFile).create("test-only").key;
  return { server, async start() { server.listen(0, "127.0.0.1"); await once(server, "listening"); },
    async ask(path, headers = {}) {
      const native = path.startsWith("/v1/messages");
      return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
        body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 32,
          messages: [{ role: "user", content: "Reply OK" }], ...(native ? {} : { reasoning_effort: "none" }) })
      });
    }, close() { server.close(); rmSync(root, { recursive: true, force: true }); } };
}

const sdkMetadata = {
  "x-stainless-lang": "js",
  "x-stainless-package-version": "test-sdk-version",
  "x-stainless-os": "Linux",
  "x-stainless-arch": "arm64",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v22.22.3",
  "x-stainless-retry-count": "0",
  "x-stainless-timeout": "600"
};

function success() {
  return new Response(JSON.stringify({ type: "message", id: "msg_test", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { "content-type": "application/json" } });
}

test("native Messages preserves caller SDK metadata but states the gateway's client identity", async () => {
  let captured;
  const f = fixture(async (url, options) => { captured = { url: url.href, headers: options.headers }; return success(); });
  try {
    await f.start();
    const response = await f.ask("/v1/messages?beta=true", {
      "user-agent": "original-client/1.0", "x-app": "original-app", ...sdkMetadata,
      "x-stainless-unlisted": "do-not-forward", "x-unlisted": "do-not-forward"
    });
    assert.equal(response.status, 200); await response.text();
    assert.equal(captured.url, "https://relay.example.test/v1/messages?beta=true");
    // The relay admits Claude traffic only from a client it recognizes, so the caller's
    // arbitrary User-Agent is replaced by this gateway's Mirasim identity; x-app is not sent.
    assert.equal(captured.headers["user-agent"], "Mirasim/0.0.516");
    assert.equal(captured.headers["x-app"], undefined);
    for (const [name, value] of Object.entries(sdkMetadata)) assert.equal(captured.headers[name], value);
    assert.equal(captured.headers["x-stainless-unlisted"], undefined);
    assert.equal(captured.headers["x-unlisted"], undefined);
  } finally { f.close(); }
});

for (const [label, value, expected] of [
  ["missing", undefined, undefined],
  ["empty", "", undefined],
  ["512 characters", "a".repeat(512), "a".repeat(512)],
  ["513 characters", "a".repeat(513), undefined]
]) {
  test(`native Messages SDK metadata handles ${label} without generating defaults`, async () => {
    let captured;
    const f = fixture(async (_url, options) => { captured = options.headers; return success(); });
    try {
      await f.start();
      const headers = value === undefined ? {} : Object.fromEntries(Object.keys(sdkMetadata).map(name => [name, value]));
      const response = await f.ask("/v1/messages", headers);
      assert.equal(response.status, 200); await response.text();
      for (const name of Object.keys(sdkMetadata)) assert.equal(captured[name], expected, name);
      assert.equal(captured["x-app"], undefined);
    } finally { f.close(); }
  });
}

for (const [name, body, contentType] of [
  ["plain text", "this client is not supported; use the mirasim client or Claude Code", "text/plain"],
  ["JSON", JSON.stringify({ error: { type: "permission_error", message: "this client is not supported; use the mirasim client or Claude Code" } }), "application/json"]
]) {
  test(`a ${name} client-policy refusal stops without trying other accounts`, async () => {
    let attempts = 0;
    const f = fixture(async () => { attempts++; return new Response(body, { status: 403, headers: { "content-type": contentType, "x-request-id": "upstream-denial-id" } }); }, 3);
    try {
      await f.start();
      const response = await f.ask("/v1/messages");
      assert.equal(response.status, 403);
      assert.equal(await response.text(), body);
      assert.equal(response.headers.get("x-request-id"), "upstream-denial-id");
      assert.equal(attempts, 1);
      const health = await fetch(`http://127.0.0.1:${f.server.address().port}/healthz`).then(r => r.json());
      assert.equal(health.profiles.filter(p => p.healthy).length, 3);
    } finally { f.close(); }
  });
}

test("a slowly closing permission denial reaches the client without buffering or account hopping", async () => {
  let attempts = 0;
  const body = "Account permission denied; prior diagnostic: this client is not supported; use the mirasim client or Claude Code";
  const f = fixture(async () => {
    attempts++;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        const timer = setTimeout(() => { try { controller.close(); } catch {} }, 300);
        timer.unref();
      }
    }), { status: 403, headers: { "content-type": "text/plain", "x-request-id": "slow-denial-id" } });
  }, 3);
  try {
    await f.start();
    const started = Date.now();
    const response = await f.ask("/v1/messages");
    assert.equal(response.status, 403);
    assert.ok(Date.now() - started < 200, "permission denial headers should not wait for EOF");
    assert.equal(await response.text(), body);
    assert.equal(attempts, 1);
    assert.equal(response.headers.get("x-request-id"), "slow-denial-id");
  } finally { f.close(); }
});

test("protocol conversion never manufactures or borrows client metadata", async () => {
  let captured;
  const f = fixture(async (_url, options) => { captured = options.headers; return success(); });
  try {
    await f.start();
    const response = await f.ask("/v1/chat/completions", { "user-agent": "original-client/1.0", "x-app": "original-app", ...sdkMetadata });
    assert.equal(response.status, 200); await response.text();
    assert.equal(captured["x-app"], undefined);
    for (const name of Object.keys(sdkMetadata)) assert.equal(captured[name], undefined, name);
    // A translated Claude request carries this gateway's own client identity, which is what the
    // relay's client gate requires — not the OpenAI caller's, and not a borrowed Claude Code one.
    assert.equal(captured["user-agent"], "Mirasim/0.0.516");
  } finally { f.close(); }
});
