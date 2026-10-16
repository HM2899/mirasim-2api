import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/server.js";

for (const path of ["/v1/messages", "/v1/models", "/healthz"]) {
  test(`${path} does not wait for an unrelated account's login refresh`, async (context) => {
    const stalled = Promise.withResolvers();
    let refreshCalls = 0;
    const fixture = await gatewayFixture(context, [4_102_444_800, 1], async (url) => {
      if (url.pathname === "/auth/refresh") {
        refreshCalls += 1;
        return stalled.promise;
      }
      return relayResponse(url);
    });
    await assertNotBlocked(fixture.request(path), stalled);
    assert.equal(refreshCalls, 1);
  });
}

test("an expired pool resumes requests as soon as one account refreshes", async (context) => {
  const stalled = Promise.withResolvers();
  const authorizations = [];
  const fixture = await gatewayFixture(context, [1, 1], async (url, options) => {
    if (url.pathname === "/auth/refresh") {
      if (JSON.parse(options.body).refresh_token === "refresh-1") return stalled.promise;
      return Response.json({ access_token: token(4_102_444_800) });
    }
    authorizations.push(options.headers.Authorization);
    return relayResponse(url);
  });
  await assertNotBlocked(fixture.request("/v1/messages"), stalled);
  assert.deepEqual(authorizations, [`Bearer ${token(4_102_444_800)}`]);
});

test("an expired pool never sends stale credentials when every refresh fails", async (context) => {
  let refreshCalls = 0;
  let relayCalls = 0;
  const fixture = await gatewayFixture(context, [1, 1], async (url) => {
    if (url.pathname === "/auth/refresh") {
      refreshCalls += 1;
      return Response.json({ detail: "invalid refresh token" }, { status: 401 });
    }
    relayCalls += 1;
    return relayResponse(url);
  });
  const response = await fixture.request("/v1/messages");
  assert.equal(response.status, 503);
  await response.text();
  assert.equal(refreshCalls, 2);
  assert.equal(relayCalls, 0);
});

test("an entirely expired pool does not block requests on stalled renewal", async (context) => {
  const stalled = Promise.withResolvers();
  let refreshCalls = 0;
  let relayCalls = 0;
  const fixture = await gatewayFixture(context, [1, 1], async (url) => {
    if (url.pathname === "/auth/refresh") {
      refreshCalls += 1;
      return stalled.promise;
    }
    relayCalls += 1;
    return relayResponse(url);
  });
  await assertNotBlocked(Promise.all([
    fixture.request("/v1/messages"), fixture.request("/v1/messages")
  ]).then(([first, second]) => {
    assert.equal(second.status, 503);
    return first;
  }), stalled, 503);
  assert.equal(refreshCalls, 2);
  assert.equal(relayCalls, 0);
});

for (const [path, status] of [["/v1/messages", 504], ["/v1/models", 200]]) {
  test(`${path} applies its header deadline while a device ticket mint is pending`, async (context) => {
    const stalled = Promise.withResolvers();
    let mintCalls = 0;
    let relayCalls = 0;
    const fixture = await gatewayFixture(context, [4_102_444_800], async (url) => {
      if (url.pathname === "/v1/device/session") {
        mintCalls += 1;
        return stalled.promise;
      }
      relayCalls += 1;
      return relayResponse(url);
    }, {
      MIRASIM_RELAY_URL: "https://relay.mirasim.ai",
      MIRASIM_FIRST_BYTE_TIMEOUT_MS: "100",
      MIRASIM_CLAUDE_FIRST_BYTE_TIMEOUT_MS: "100",
      MIRASIM_MODEL_LIST_TIMEOUT_MS: "100"
    });
    await assertNotBlocked(fixture.request(path), stalled, status);
    assert.equal(mintCalls, 1);
    assert.equal(relayCalls, 0);
  });
}

async function assertNotBlocked(request, stalled, status = 200) {
  let released = false;
  const timer = setTimeout(() => {
    released = true;
    stalled.resolve(Response.json({ detail: "unavailable" }, { status: 503 }));
  }, 1000);
  try {
    const response = await request;
    assert.equal(response.status, status);
    await response.text();
    assert.equal(released, false, "the request should not wait for an unrelated refresh or an overdue ticket mint");
  } finally {
    clearTimeout(timer);
    stalled.resolve(Response.json({ detail: "unavailable" }, { status: 503 }));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function gatewayFixture(context, expiries, fetchImpl, env = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-latency-"));
  const homes = expiries.map((expiry, index) => {
    const home = join(root, `account-${index}`);
    mkdirSync(home);
    writeFileSync(join(home, "setting.json"), JSON.stringify({
      auth: { userId: `user-${index}`, token: token(expiry), exp: expiry, refreshToken: `refresh-${index}` }
    }));
    return home;
  });
  const config = loadConfig({
    MIRASIM_HOME: root,
    MIRASIM_HOMES: homes.join(","),
    MIRASIM_RELAY_URL: "https://relay.example.test",
    MIRASIM_LOGIN_URL: "https://login.example.test",
    WEB_AUTH_PASSWORD: "password",
    ...env
  });
  const server = createGateway(config, { fetchImpl, logger: { error() {} } });
  const { key } = new OpenAIKeyStore(config.databaseFile).create("Latency regression");
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    request(path) {
      return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: path === "/v1/messages" ? "POST" : "GET",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(path === "/v1/messages" ? { body: JSON.stringify({
          model: "claude-sonnet-4-5", max_tokens: 16, messages: [{ role: "user", content: "Hi" }]
        }) } : {}),
        signal: AbortSignal.timeout(5000)
      });
    }
  };
}

function relayResponse(url) {
  return url.pathname === "/v1/models"
    ? Response.json({ object: "list", data: [{ id: "claude-sonnet-4-5", object: "model" }] })
    : Response.json({ type: "message", role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
}

function token(exp) {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp, sub: "user" })).toString("base64url")}.signature`;
}
