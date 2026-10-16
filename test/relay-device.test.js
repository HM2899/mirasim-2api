import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MirasimRelaySessions, MirasimRelaySessionError } from "../src/relay-device.js";
import { signMirasimRelayRequest } from "../src/relay-crypto.js";

test("official 0.0.303 relay requests seal metadata and reuse a persisted device key and ticket", async () => {
  const home = mkdtempSync(join(tmpdir(), "mirasim-device-"));
  writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { token: "login-token" } }));
  let requests = 0;
  const sessions = new MirasimRelaySessions({ relayUrl: "https://relay.mirasim.ai", clientVersion: "0.0.303" }, {
    fetchImpl: async (url, options) => {
      requests += 1;
      assert.equal(url.pathname, "/v1/device/session");
      assert.equal(options.headers.Authorization, "Bearer login-token");
      assert.ok(options.headers["x-mirasim-device"]);
      assert.ok(options.headers["x-mirasim-sig"]);
      assert.equal(options.headers["x-mirasim-client"], "0.0.303");
      assert.equal(options.headers["x-mirasim-enc"], undefined);
      assert.equal(options.headers["x-mirasim-call"], undefined);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(JSON.stringify({ ticket: "device-ticket", expiresIn: 3600 }), { status: 200 });
    }
  });

  try {
    const profile = { home, token: "login-token" };
    const first = await sessions.headersFor(profile, { method: "POST", path: "/v1/chat/completions", body: "{}" });
    const second = await sessions.headersFor(profile, { method: "POST", path: "/v1/chat/completions", body: "{}" });
    assert.equal(first.Authorization, "Bearer device-ticket");
    assert.equal(second.Authorization, "Bearer device-ticket");
    assert.equal(requests, 1);
    assert.ok(first["x-mirasim-enc"]);
    assert.notEqual(first["x-mirasim-enc"], second["x-mirasim-enc"]);
    assert.deepEqual(Object.keys(first).filter((name) => name.startsWith("x-mirasim-")).sort(), ["x-mirasim-client", "x-mirasim-enc"]);
    const setting = JSON.parse(readFileSync(join(home, "setting.json"), "utf8"));
    assert.equal(typeof setting.device.privateKey, "string");
    assert.equal(statSync(join(home, "setting.json")).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(setting).includes("device-ticket"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a rate-limited ticket mint is backed off instead of retried on every request", async () => {
  const home = mkdtempSync(join(tmpdir(), "mirasim-device-backoff-"));
  writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { token: "login-token" } }));
  let requests = 0;
  let now = 1_000_000;
  const sessions = new MirasimRelaySessions({ relayUrl: "https://relay.mirasim.ai", clientVersion: "0.0.264" }, {
    now: () => now,
    fetchImpl: async () => {
      requests += 1;
      return new Response("busy", { status: 429, headers: { "retry-after": "120" } });
    }
  });
  try {
    const profile = { home, token: "login-token" };
    await assert.rejects(sessions.headersFor(profile, { method: "GET", path: "/v1/models" }), MirasimRelaySessionError);
    await assert.rejects(sessions.headersFor(profile, { method: "GET", path: "/v1/models" }), (error) => error.retryAfterMs === 120_000);
    assert.equal(requests, 1);
    now += 121_000;
    await assert.rejects(sessions.headersFor(profile, { method: "GET", path: "/v1/models" }), MirasimRelaySessionError);
    assert.equal(requests, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function deviceFixture(context, fetchImpl, options = {}) {
  const home = mkdtempSync(join(tmpdir(), "mirasim-device-303-"));
  writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { token: "login-token" } }));
  context.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    home,
    profile: { home, token: "login-token" },
    sessions: new MirasimRelaySessions({ relayUrl: "https://relay.mirasim.ai" }, { fetchImpl, ...options })
  };
}

const modelRequest = { method: "GET", path: "/v1/models" };

test("concurrent requests mint only one ticket", async (context) => {
  let requests = 0;
  const { sessions, profile } = deviceFixture(context, async () => {
    requests += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return Response.json({ ticket: "ticket", expiresIn: 3600 });
  });
  const headers = await Promise.all(Array.from({ length: 8 }, () => sessions.headersFor(profile, modelRequest)));
  assert.equal(requests, 1);
  assert.ok(headers.every((value) => value.Authorization === "Bearer ticket"));
  assert.equal(new Set(headers.map((value) => value["x-mirasim-enc"])).size, 8);
});

test("concurrent requests use a valid ticket while one background renewal is pending", async (context) => {
  let now = 1_000_000;
  let requests = 0;
  const renewal = Promise.withResolvers();
  const { sessions, profile } = deviceFixture(context, async () => {
    requests += 1;
    return requests === 1 ? Response.json({ ticket: "old-ticket", expiresIn: 600 }) : renewal.promise;
  }, { now: () => now });
  await sessions.headersFor(profile, modelRequest);
  now += 301_000;
  let completed;
  const pending = Promise.all(Array.from({ length: 8 }, () => sessions.headersFor(profile, modelRequest)))
    .then((headers) => { completed = headers; });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed?.length, 8, "valid tickets must not wait for renewal");
    assert.ok(completed.every((headers) => headers.Authorization === "Bearer old-ticket"));
    assert.equal(requests, 2);
  } finally {
    renewal.resolve(Response.json({ ticket: "new-ticket", expiresIn: 600 }));
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal((await sessions.headersFor(profile, modelRequest)).Authorization, "Bearer new-ticket");
});

test("a ticket that expires during background renewal waits for the replacement", async (context) => {
  let now = 1_000_000;
  let requests = 0;
  const renewal = Promise.withResolvers();
  const { sessions, profile } = deviceFixture(context, async () => {
    requests += 1;
    return requests === 1 ? Response.json({ ticket: "old-ticket", expiresIn: 600 }) : renewal.promise;
  }, { now: () => now });
  await sessions.headersFor(profile, modelRequest);
  now += 301_000;
  const warm = sessions.headersFor(profile, modelRequest);
  await new Promise((resolve) => setImmediate(resolve));
  now += 300_000;
  let completed = false;
  const expired = sessions.headersFor(profile, modelRequest).then((headers) => {
    completed = true;
    return headers;
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    assert.equal(requests, 2);
  } finally {
    renewal.resolve(Response.json({ ticket: "new-ticket", expiresIn: 600 }));
    await warm;
  }
  assert.equal((await expired).Authorization, "Bearer new-ticket");
});

test("cancelling a ticket wait returns promptly without cancelling the shared mint", async (context) => {
  const mint = Promise.withResolvers();
  let requests = 0;
  const { sessions, profile } = deviceFixture(context, async () => {
    requests += 1;
    return mint.promise;
  });
  const controller = new AbortController();
  let failure;
  const cancelled = sessions.headersFor(profile, { ...modelRequest, signal: controller.signal })
    .catch((error) => { failure = error; });
  const surviving = sessions.headersFor(profile, modelRequest);
  controller.abort();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failure?.name, "AbortError");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    mint.resolve(Response.json({ ticket: "ticket", expiresIn: 600 }));
    await cancelled;
  }
  assert.equal((await surviving).Authorization, "Bearer ticket");
  assert.equal(requests, 1);
});

test("an already cancelled request never starts minting a ticket", async (context) => {
  let requests = 0;
  const { sessions, profile } = deviceFixture(context, async () => {
    requests += 1;
    return Response.json({ ticket: "ticket", expiresIn: 600 });
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sessions.headersFor(profile, { ...modelRequest, signal: controller.signal }), { name: "AbortError" });
  assert.equal(requests, 0);
});

test("a renewed login does not reuse a previous token's ticket or backoff", async (context) => {
  const tokens = [];
  const { sessions, profile } = deviceFixture(context, async (url, options) => {
    tokens.push(options.headers.Authorization);
    if (tokens.length === 2) return new Response("denied", { status: 403 });
    return Response.json({ ticket: `ticket-${tokens.length}`, expiresIn: 3600 });
  });
  assert.equal((await sessions.headersFor(profile, modelRequest)).Authorization, "Bearer ticket-1");
  await assert.rejects(sessions.headersFor({ ...profile, token: "renewed-token" }, modelRequest), MirasimRelaySessionError);
  assert.equal((await sessions.headersFor({ ...profile, token: "third-token" }, modelRequest)).Authorization, "Bearer ticket-3");
  assert.deepEqual(tokens, ["Bearer login-token", "Bearer renewed-token", "Bearer third-token"]);
});

test("a changed device key cannot reuse a ticket bound to the previous device", async (context) => {
  let requests = 0;
  const devices = [];
  const { sessions, profile, home } = deviceFixture(context, async (url, options) => {
    requests += 1;
    devices.push(JSON.parse(options.body).deviceId);
    return Response.json({ ticket: `ticket-${requests}`, expiresIn: 3600 });
  });
  await sessions.headersFor(profile, modelRequest);
  writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { token: profile.token } }));
  assert.equal((await sessions.headersFor(profile, modelRequest)).Authorization, "Bearer ticket-2");
  assert.notEqual(devices[0], devices[1]);
});

test("Retry-After HTTP dates are respected even beyond one hour", async (context) => {
  const now = Date.parse("2026-09-09T00:00:00Z");
  const { sessions, profile } = deviceFixture(context, async () => new Response(null, {
    status: 429, headers: { "retry-after": "Wed, 09 Sep 2026 02:00:00 GMT" }
  }), { now: () => now });
  await assert.rejects(sessions.headersFor(profile, modelRequest), (error) => error.retryAfterMs === 7_200_000 && error.upstreamStatus === 429);
});

test("an unexpired ticket survives a transient renewal failure, but is never used after expiry", async (context) => {
  let now = 1_000_000;
  let requests = 0;
  const { sessions, profile } = deviceFixture(context, async () => {
    requests += 1;
    return requests === 1 ? Response.json({ ticket: "ticket", expiresIn: 600 }) : new Response(null, { status: 429 });
  }, { now: () => now });
  await sessions.headersFor(profile, modelRequest);
  now += 301_000;
  assert.equal((await sessions.headersFor(profile, modelRequest)).Authorization, "Bearer ticket");
  now += 300_000;
  await assert.rejects(sessions.headersFor(profile, modelRequest), MirasimRelaySessionError);
  assert.equal(requests, 2);
});

test("an authorization refusal invalidates an otherwise unexpired ticket", async (context) => {
  let now = 1_000_000;
  let requests = 0;
  const { sessions, profile } = deviceFixture(context, async () => {
    requests += 1;
    return requests === 1 ? Response.json({ ticket: "ticket", expiresIn: 600 }) : new Response(null, { status: 401 });
  }, { now: () => now });
  await sessions.headersFor(profile, modelRequest);
  now += 301_000;
  await assert.rejects(sessions.headersFor(profile, modelRequest), (error) => error.upstreamStatus === 401);
});

for (const status of [401, 403]) {
  test(`background renewal HTTP ${status} invalidates the ticket as soon as the refusal arrives`, async (context) => {
    let now = 1_000_000;
    let requests = 0;
    const renewal = Promise.withResolvers();
    const { sessions, profile } = deviceFixture(context, async () => {
      requests += 1;
      return requests === 1 ? Response.json({ ticket: "ticket", expiresIn: 600 }) : renewal.promise;
    }, { now: () => now });
    await sessions.headersFor(profile, modelRequest);
    now += 301_000;
    try {
      assert.equal((await sessions.headersFor(profile, modelRequest)).Authorization, "Bearer ticket");
    } finally {
      renewal.resolve(new Response(null, { status }));
      await new Promise((resolve) => setImmediate(resolve));
    }
    await assert.rejects(sessions.headersFor(profile, modelRequest), (error) => error.upstreamStatus === status);
    assert.equal(requests, 2);
  });
}

test("short-lived tickets are reused instead of being minted on every request", async (context) => {
  let now = 1_000_000;
  let requests = 0;
  const { sessions, profile } = deviceFixture(context, async () => {
    requests += 1;
    return Response.json({ ticket: `ticket-${requests}`, expiresIn: 120 });
  }, { now: () => now });
  await sessions.headersFor(profile, modelRequest);
  now += 50_000;
  assert.equal((await sessions.headersFor(profile, modelRequest)).Authorization, "Bearer ticket-1");
  assert.equal(requests, 1);
  now += 11_000;
  assert.equal((await sessions.headersFor(profile, modelRequest)).Authorization, "Bearer ticket-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await sessions.headersFor(profile, modelRequest)).Authorization, "Bearer ticket-2");
});

test("a ticket without expiry fields uses the official ten-minute fallback", async (context) => {
  let now = 1_000_000;
  let requests = 0;
  const { sessions, profile } = deviceFixture(context, async () => {
    requests += 1;
    return requests === 1 ? Response.json({ ticket: "ticket" }) : new Response(null, { status: 429 });
  }, { now: () => now });
  await sessions.headersFor(profile, modelRequest);
  now += 601_000;
  await assert.rejects(sessions.headersFor(profile, modelRequest), MirasimRelaySessionError);
  assert.equal(requests, 2);
});

for (const failure of ["network", "invalid-json", "missing-ticket", "expired-ticket", "forbidden"]) {
  test(`mint ${failure} fails closed and is backed off without exposing credentials`, async (context) => {
    let requests = 0;
    const { sessions, profile } = deviceFixture(context, async () => {
      requests += 1;
      if (failure === "network") throw new Error("secret login-token");
      if (failure === "invalid-json") return new Response("invalid");
      if (failure === "forbidden") return new Response("secret login-token", { status: 403 });
      if (failure === "expired-ticket") return Response.json({ ticket: "ticket", expiresIn: -1 });
      return Response.json({});
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(sessions.headersFor(profile, modelRequest), (error) => {
        assert.ok(error instanceof MirasimRelaySessionError);
        assert.ok(!error.message.includes("login-token"));
        assert.ok(error.retryAfterMs > 0);
        return true;
      });
    }
    assert.equal(requests, 1);
  });
}

test("an unreadable device profile fails closed without a network request", async (context) => {
  const { sessions, profile, home } = deviceFixture(context, async () => assert.fail("unexpected mint"));
  writeFileSync(join(home, "setting.json"), "invalid JSON");
  await assert.rejects(sessions.headersFor(profile, modelRequest), MirasimRelaySessionError);
});

test("existing device settings are made owner-only without rotating the key", async (context) => {
  const { sessions, profile, home } = deviceFixture(context, async () => Response.json({ ticket: "ticket", expiresIn: 3600 }));
  await sessions.headersFor(profile, modelRequest);
  const before = readFileSync(join(home, "setting.json"), "utf8");
  chmodSync(join(home, "setting.json"), 0o644);
  await sessions.headersFor(profile, modelRequest);
  assert.equal(readFileSync(join(home, "setting.json"), "utf8"), before);
  assert.equal(statSync(join(home, "setting.json")).mode & 0o777, 0o600);
});

test("custom relay hosts retain unsigned compatibility while the official host requires TLS", async () => {
  assert.throws(() => new MirasimRelaySessions({ relayUrl: "http://relay.mirasim.ai" }), /HTTPS/);
  const sessions = new MirasimRelaySessions({ relayUrl: "http://127.0.0.1:9999" }, { fetchImpl: async () => assert.fail("unexpected mint") });
  const headers = await sessions.headersFor({ home: "/missing", token: "custom-token" }, modelRequest);
  assert.equal(headers.Authorization, "Bearer custom-token");
  assert.equal(headers["x-mirasim-client"], "0.0.516");
  assert.equal(headers["x-mirasim-collect"], "off");
});

test("the Mirasim client identity is stated for the Claude upstream only", async () => {
  const sessions = new MirasimRelaySessions({ relayUrl: "http://127.0.0.1:9999" }, { fetchImpl: async () => assert.fail("unexpected mint") });
  const profile = { home: "/missing", token: "custom-token" };
  // An Anthropic Messages request — the endpoint the relay gates on the client — names the
  // Mirasim client, because the relay refuses every other User-Agent with 403.
  const messages = await sessions.headersFor(profile, { method: "POST", path: "/v1/messages" });
  assert.equal(messages["user-agent"], "Mirasim/0.0.516");
  // A chat-completions request reaches the Codex upstream, which is not gated on the client,
  // so it keeps the User-Agent Node's fetch would otherwise supply.
  const chat = await sessions.headersFor(profile, { method: "POST", path: "/v1/chat/completions" });
  assert.equal(chat["user-agent"], undefined);
});

test("OpenAI paths never inherit the profile's Claude agent", async () => {
  const sessions = new MirasimRelaySessions({ relayUrl: "http://127.0.0.1:9999" });
  const profile = { token: "local-token", agent: "claude" };
  for (const path of ["/v1/chat/completions", "/v1/responses", "/backend-api/codex/responses"]) {
    const headers = await sessions.headersFor(profile, { method: "POST", path });
    assert.equal(headers["x-mirasim-agent"], "codex", path);
  }
  for (const agent of ["dsh", "kimi", "zcode", "claude"]) {
    const headers = await sessions.headersFor(profile, { method: "POST", path: "/v1/chat/completions", agent });
    assert.equal(headers["x-mirasim-agent"], agent);
  }
  const headers = await sessions.headersFor(profile, { method: "POST", path: "/v1/messages" });
  assert.equal(headers["x-mirasim-agent"], "claude");
  assert.equal(profile.agent, "claude");
});

test("relay calls get a distinct correlation ID for metadata signing without changing a profile session", async () => {
  const sessions = new MirasimRelaySessions({ relayUrl: "http://127.0.0.1:9999" });
  const profile = { token: "local-token", sessionId: "stable-local-session" };
  const first = await sessions.headersFor(profile, modelRequest);
  const second = await sessions.headersFor(profile, modelRequest);
  assert.match(first["x-mirasim-call"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first["x-mirasim-call"], second["x-mirasim-call"]);
  assert.equal(first["x-mirasim-session"], "stable-local-session");
  assert.equal(second["x-mirasim-session"], "stable-local-session");
});

test("0.0.264 device signatures bind the credential, metadata, and body with the official crypto core", () => {
  const signature = signMirasimRelayRequest(Buffer.from("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", "base64"), {
    method: "POST",
    path: "/v1/responses",
    ts: "1700000000000",
    nonce: "test-nonce",
    deviceId: "device-test",
    clientVersion: "0.0.264",
    credential: "ticket-test",
    metadata: {
      "x-mirasim-session": "session-test",
      "x-mirasim-agent": "codex",
      "x-mirasim-account": "account-test",
      "x-mirasim-locale": "en-US"
    },
    body: Buffer.from('{"model":"gpt-5.6-luna"}')
  });
  assert.equal(signature.toString("base64url"), "pmh8tqyRSpiiUGZCsXHLURALw4O6fHPIfKzJBYpZNFepRJsnQFkKn6ZkjaHzZAWVZm5DgEDZji4I5mn6XPf3Dg");
});
