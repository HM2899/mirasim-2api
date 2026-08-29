import assert from "node:assert/strict";
import test from "node:test";
import { MirasimModelHealth } from "../src/model-health.js";

test("discovers models then checks only the selected model", async () => {
  const calls = [];
  const pool = {
    pick() { return { home: "/profile-a", token: "mirasim-token" }; }
  };
  const health = new MirasimModelHealth({
    homes: ["/profile-a"],
    relayUrl: "https://relay.example.test",
    models: ["configured-model"],
    modelHealthTimeoutMs: 500
  }, pool, {
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
  assert.equal(calls[0].url, "https://relay.example.test/v1/models");
  assert.equal(calls[1].url, "https://relay.example.test/v1/limits");
  assert.equal(calls[1].options.method, "GET");
  assert.equal(calls.some((call) => call.options?.body?.includes('"model":"*"')), false);
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
  // The probe is a shared account-level limits check, so the rotation is only visible in the
  // snapshot: one more model leaves "pending" per scan.
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

test("health probes send no chat completion body upstream", async () => {
  const calls = [];
  const health = new MirasimModelHealth({ homes: [], relayUrl: "https://relay.example.test", models: ["kimi-k3"] }, {
    pick() { return { home: "/profile-a", token: "mirasim-token" }; }
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ pathname: url.pathname, method: options.method, body: options.body });
      if (url.pathname === "/v1/models") return json({ data: [] });
      return json({ models: { "kimi-k3": { available: true } } });
    }
  });
  await health.discover();
  const snapshot = await health.runOne("kimi-k3");
  assert.deepEqual(calls.map(({ pathname, method }) => ({ pathname, method })), [
    { pathname: "/v1/models", method: "GET" },
    { pathname: "/v1/limits", method: "GET" }
  ]);
  assert.equal(calls.every(({ body }) => body === undefined), true);
  assert.equal(snapshot.models[0].status, "healthy");
});

test("keeps saved probe results while refreshing the model directory", async () => {
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
