import assert from "node:assert/strict";
import test from "node:test";
import { MirasimModelHealth } from "../src/model-health.js";

test("discovers models before the sequential health pass and records each outcome", async () => {
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
      const model = JSON.parse(options.body).model;
      if (model === "healthy-model") return json({ choices: [] });
      if (model === "limited-model") return json({ error: { message: "Rate limit exceeded" } }, 429);
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

  const snapshot = await health.run();
  assert.equal(snapshot.running, false);
  assert.deepEqual(snapshot.models.map(({ id, status, httpStatus }) => ({ id, status, httpStatus })), [
    { id: "configured-model", status: "unavailable", httpStatus: 404 },
    { id: "healthy-model", status: "healthy", httpStatus: 200 },
    { id: "limited-model", status: "limited", httpStatus: 429 }
  ]);
  assert.equal(calls[0].url, "https://relay.example.test/v1/models");
  assert.equal(calls[1].url, "https://relay.example.test/v1/models");
  assert.equal(calls[2].options.headers.Authorization, "Bearer mirasim-token");
  assert.equal(JSON.parse(calls[2].options.body).max_tokens, 1);
  assert.equal(calls.some((call) => call.options?.body?.includes('"model":"*"')), false);
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
