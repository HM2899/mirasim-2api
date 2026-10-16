import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MirasimModelHealth } from "../src/model-health.js";
import { MirasimProfilePool } from "../src/pool.js";
import { MirasimSessionRefresher } from "../src/session-refresh.js";

test("discovers models and checks only the selected model", async () => {
  const calls = [];
  const health = new MirasimModelHealth({
    homes: ["/profile-a"],
    relayUrl: "https://relay.example.test",
    models: ["configured-model"],
    modelHealthTimeoutMs: 500
  }, {
    pick() { return { home: "/profile-a", token: "mirasim-token" }; }
  }, {
    now: () => 1_725_000_000_000,
    sessionRefresher: { async refreshAll(homes) { assert.deepEqual(homes, ["/profile-a"]); } },
    fetchImpl: async (url, options) => {
      calls.push({ url: url.href, options });
      if (url.pathname === "/v1/models") return json({ data: [{ id: "healthy-model" }, { id: "limited-model" }, { id: "*" }] });
      if (url.pathname === "/v1/limits") return json({ models: { "healthy-model": { available: true } } });
      return json({ error: { message: "Unknown model" } }, 404);
    }
  });

  const discovered = await health.discover();
  assert.deepEqual(discovered, ["configured-model", "healthy-model", "limited-model"]);
  assert.deepEqual(health.snapshot().models.map(({ id, status }) => ({ id, status })), [
    { id: "configured-model", status: "pending" },
    { id: "healthy-model", status: "pending" },
    { id: "limited-model", status: "pending" }
  ]);

  const snapshot = await health.runOne("healthy-model");
  assert.equal(snapshot.running, false);
  assert.deepEqual(snapshot.models.map(({ id, status, httpStatus }) => ({ id, status, httpStatus })), [
    { id: "configured-model", status: "pending", httpStatus: null },
    { id: "healthy-model", status: "healthy", httpStatus: 200 },
    { id: "limited-model", status: "pending", httpStatus: null }
  ]);
  assert.deepEqual(calls.map(({ url, options }) => [url, options.method, options.body]), [
    ["https://relay.example.test/v1/models", "GET", undefined],
    ["https://relay.example.test/v1/limits", "GET", undefined]
  ]);
});

test("scheduled scans rotate one model at a time", async () => {
  const calls = [];
  const health = new MirasimModelHealth({ homes: [], relayUrl: "https://relay.example.test", models: ["model-a", "model-b"] }, {
    pick() { return { token: "mirasim-token" }; }
  }, {
    fetchImpl: async (url) => {
      calls.push(url.pathname);
      if (url.pathname === "/v1/models") return json({ data: [] });
      return json({ models: {} });
    }
  });
  await health.discover();
  assert.deepEqual((await health.scanNext()).models.map(({ id, status }) => ({ id, status })), [
    { id: "model-a", status: "healthy" },
    { id: "model-b", status: "pending" }
  ]);
  assert.deepEqual((await health.scanNext()).models.map(({ id, status }) => ({ id, status })), [
    { id: "model-a", status: "healthy" },
    { id: "model-b", status: "healthy" }
  ]);
  assert.deepEqual(calls, ["/v1/models", "/v1/limits", "/v1/limits"]);
});

test("a limited model is surfaced without a generation request", async () => {
  const health = new MirasimModelHealth({ homes: [], relayUrl: "https://relay.example.test", models: ["kimi-k3"] }, {
    pick() { return { token: "mirasim-token" }; }
  }, {
    now: () => 1_725_000_000_000,
    fetchImpl: async (url, options) => {
      assert.equal(options.method, "GET");
      assert.equal(options.body, undefined);
      if (url.pathname === "/v1/models") return json({ data: [] });
      return json({ models: { "kimi-k3": { available: false, status: "limited", message: "模型额度已用尽。" } } });
    }
  });
  await health.discover();
  const snapshot = await health.runOne("kimi-k3");
  assert.deepEqual(snapshot.models[0], {
    id: "kimi-k3",
    status: "limited",
    checkedAt: "2024-08-30T06:40:00.000Z",
    latencyMs: 0,
    httpStatus: 200,
    message: "模型额度已用尽。"
  });
});

test("keeps saved model results while refreshing the model directory", async () => {
  const saved = [];
  const database = {
    getModelHealth() {
      return {
        lastFinishedAt: "2026-08-09T00:00:00.000Z",
        models: [{ id: "known-model", status: "healthy", checkedAt: "2026-08-09T00:00:00.000Z", latencyMs: 120, httpStatus: 200, message: "可正常响应。" }]
      };
    },
    saveModelHealth(value) { saved.push(value); }
  };
  const health = new MirasimModelHealth({ homes: ["/profile-a"], relayUrl: "https://relay.example.test", models: [] }, {
    pick() { return { token: "mirasim-token" }; }
  }, {
    database,
    fetchImpl: async () => json({ data: [{ id: "known-model" }, { id: "new-model" }] })
  });

  assert.equal(health.snapshot().models[0].status, "healthy");
  await health.discover();
  assert.deepEqual(health.snapshot().models.map(({ id, status }) => ({ id, status })), [
    { id: "known-model", status: "healthy" },
    { id: "new-model", status: "pending" }
  ]);
  assert.equal(saved.at(-1).models[0].status, "healthy");
});

for (const mode of ["manual", "scheduled"]) {
  test(`${mode} checks refresh expired accounts after an idle scan interval`, async (context) => {
    const home = mkdtempSync(join(tmpdir(), "mirasim-health-refresh-"));
    context.after(() => rmSync(home, { recursive: true, force: true }));
    let now = 1_725_000_000_000;
    let token = jwt(Math.floor(now / 1000) + 900);
    writeFileSync(join(home, "setting.json"), JSON.stringify({
      auth: { token, refreshToken: "refresh-token", exp: Math.floor(now / 1000) + 900 }
    }));
    const config = {
      homes: [home],
      loginUrl: "https://login.example.test",
      relayUrl: "https://relay.example.test",
      models: ["model-a", "model-b"]
    };
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push(url.pathname);
      if (url.pathname === "/auth/refresh") {
        assert.equal(options.method, "POST");
        assert.deepEqual(JSON.parse(options.body), { refresh_token: "refresh-token" });
        token = jwt(Math.floor(now / 1000) + 900);
        return json({ access_token: token });
      }
      assert.equal(options.method, "GET");
      assert.equal(options.body, undefined);
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      if (url.pathname === "/v1/models") return json({ data: [] });
      assert.equal(url.pathname, "/v1/limits");
      return json({ models: {} });
    };
    const pool = new MirasimProfilePool(config.homes, { now: () => now });
    const sessionRefresher = new MirasimSessionRefresher(config, { fetchImpl, now: () => now });
    const health = new MirasimModelHealth(config, pool, { fetchImpl, sessionRefresher, now: () => now });
    await health.discover();
    assert.deepEqual(calls, ["/v1/models"]);

    for (const id of config.models) {
      now += health.scanIntervalMs;
      assert.equal(pool.pick(), null);
      const snapshot = mode === "manual" ? await health.runOne(id) : await health.scanNext();
      assert.equal(snapshot.models.find((model) => model.id === id).status, "healthy");
      assert.equal(snapshot.lastError, null);
      assert.equal(snapshot.running, false);
      assert.equal(pool.pick().token, token);
    }
    assert.deepEqual(calls, ["/v1/models", "/auth/refresh", "/v1/limits", "/auth/refresh", "/v1/limits"]);
  });
}

test("checking a saved model awaits account refresh before relay session headers", async () => {
  const calls = [];
  const profile = { home: "/profile-a", token: "renewed-token" };
  let refreshed = false;
  const health = new MirasimModelHealth({ homes: [profile.home], relayUrl: "https://relay.example.test" }, {
    pick() { calls.push("pick"); return refreshed ? profile : null; }
  }, {
    database: { getModelHealth: () => ({ models: [{ id: "known-model", status: "unavailable" }] }) },
    sessionRefresher: { async refreshAll(homes) {
      assert.deepEqual(homes, [profile.home]);
      await Promise.resolve();
      calls.push("refresh");
      refreshed = true;
    } },
    relaySessions: { async headersFor(selected, request) {
      assert.equal(selected, profile);
      assert.deepEqual(request, { method: "GET", path: "/v1/limits", body: "" });
      calls.push("headers");
      return { Authorization: "Bearer relay-session-token" };
    } },
    fetchImpl: async (url, options) => {
      assert.equal(url.pathname, "/v1/limits");
      assert.equal(options.headers.Authorization, "Bearer relay-session-token");
      calls.push("limits");
      return json({ models: {} });
    }
  });

  assert.equal((await health.runOne("known-model")).models[0].status, "healthy");
  assert.deepEqual(calls, ["refresh", "pick", "headers", "limits"]);
});

for (const reason of ["refresh rejected", "disabled account"]) {
  test(`a ${reason} remains unavailable after health refresh`, async (context) => {
    const home = mkdtempSync(join(tmpdir(), "mirasim-health-unavailable-"));
    context.after(() => rmSync(home, { recursive: true, force: true }));
    const now = 1_725_000_000_000;
    writeFileSync(join(home, "setting.json"), JSON.stringify({
      auth: { token: jwt(1), refreshToken: "refresh-token", exp: 1 }
    }));
    const config = { homes: [home], loginUrl: "https://login.example.test", relayUrl: "https://relay.example.test" };
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url.pathname);
      assert.equal(url.pathname, "/auth/refresh");
      return reason === "refresh rejected"
        ? json({ detail: "invalid refresh token" }, 401)
        : json({ access_token: jwt(Math.floor(now / 1000) + 3600) });
    };
    const pool = new MirasimProfilePool(config.homes, { now: () => now });
    if (reason === "disabled account") pool.disable(home);
    const sessionRefresher = new MirasimSessionRefresher(config, { fetchImpl, now: () => now });
    const health = new MirasimModelHealth(config, pool, {
      fetchImpl,
      sessionRefresher,
      now: () => now,
      database: { getModelHealth: () => ({ models: [{ id: "known-model", status: "healthy" }] }) }
    });

    const snapshot = await health.runOne("known-model");
    assert.equal(snapshot.models[0].status, "unavailable");
    assert.equal(snapshot.models[0].httpStatus, 0);
    assert.match(snapshot.models[0].message, /没有可用的已登录账号/);
    assert.equal(pool.pick(), null);
    assert.deepEqual(calls, ["/auth/refresh"]);
  });
}

function jwt(exp) {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp, sub: "health-user" })).toString("base64url")}.signature`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
