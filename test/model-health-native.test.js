import assert from "node:assert/strict";
import test from "node:test";
import { MirasimModelHealth } from "../src/model-health.js";

const id = "Claude-Exact-Alias";
const profile = { home: "/test-profile", token: "test-only-token" };

function fixture(fetchImpl, overrides = {}) {
  return new MirasimModelHealth({ homes: [], relayUrl: "https://relay.example.test", modelHealthTimeoutMs: 500, ...overrides }, {
    pick() { return profile; }
  }, {
    database: { getModelHealth() { return { models: [{ id, status: "pending" }] }; } },
    fetchImpl
  });
}

// Claude is checked the same way every other model is: one `GET /v1/limits` reading. No
// generation request is sent, so a check consumes no allowance and depends on no Messages
// admission. A healthy result means the model is offered, not that inference ran.
test("a Claude model check reads limits and never sends a generation request", async () => {
  const calls = [];
  const health = fixture(async (url, options) => {
    calls.push({ path: url.pathname, options });
    return Response.json({ models: { [id]: { available: true } } });
  });
  const checked = (await health.runOne(id)).models[0];
  assert.deepEqual(calls.map(call => call.path), ["/v1/limits"]);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.body, undefined);
  assert.equal(checked.status, "healthy");
  assert.equal(checked.httpStatus, 200);
  assert.equal(checked.message, "可正常响应。");
});

test("a limited Claude model is surfaced without a generation request", async () => {
  const calls = [];
  const health = fixture(async (url) => {
    calls.push(url.pathname);
    return Response.json({ models: { [id]: { available: false, status: "limited", message: "模型额度已用尽。" } } });
  });
  const checked = (await health.runOne(id)).models[0];
  assert.deepEqual(calls, ["/v1/limits"]);
  assert.equal(checked.status, "limited");
  assert.equal(checked.httpStatus, 200);
  assert.equal(checked.message, "模型额度已用尽。");
});

for (const [status, expected] of [[403, "unauthorized"], [429, "limited"], [503, "unavailable"]]) {
  test(`a Claude limits check HTTP ${status} is recorded without another account or fallback`, async () => {
    let calls = 0;
    const health = fixture(async () => { calls++; return Response.json({ error: { message: "上游返回。" } }, { status }); });
    const checked = (await health.runOne(id)).models[0];
    assert.equal(checked.status, expected);
    assert.equal(checked.httpStatus, status);
    assert.equal(calls, 1);
  });
}

test("a Claude result saved by the removed Claude Code probe resets to pending", async () => {
  const saved = { models: [
    { id: "claude-haiku-4-5", status: "unavailable", httpStatus: 503, message: "platform_queue_full", mode: "claude-code" },
    { id: "claude/earlier-native", status: "healthy", httpStatus: 200, message: "原生 Messages 生成成功。" },
    { id: "kimi-k3", status: "healthy", httpStatus: 200, message: "可正常响应。" }
  ] };
  const health = new MirasimModelHealth({ homes: [], relayUrl: "https://relay.example.test" }, { pick: () => null }, {
    database: { getModelHealth: () => saved }
  });
  assert.deepEqual(health.snapshot().models, [
    { id: "claude-haiku-4-5", status: "pending", checkedAt: null, latencyMs: null, httpStatus: null, message: "尚未检测。" },
    { id: "claude/earlier-native", status: "healthy", checkedAt: null, latencyMs: null, httpStatus: 200, message: "原生 Messages 生成成功。" },
    { id: "kimi-k3", status: "healthy", checkedAt: null, latencyMs: null, httpStatus: 200, message: "可正常响应。" }
  ]);
});
