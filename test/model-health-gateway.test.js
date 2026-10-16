import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../src/server.js";

// The model-health check route is uniform: a Claude model is checked with the same
// `GET /v1/limits` reading as every other model, and no generation request is sent.
test("the model-health check route reads limits for a Claude model and never sends a generation request", async () => {
  const root = mkdtempSync(join(tmpdir(), "panel-limits-"));
  writeFileSync(join(root, "setting.json"), JSON.stringify({ auth: { token: "fixture-token", exp: 4102444800 } }));
  const paths = [];
  let messages = 0;
  const server = createGateway({ homes: [root], databaseFile: join(root, "state.sqlite"), relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test", webAuth: { username: "test", password: "test-password" }, models: ["claude-test"] }, {
    fetchImpl: async (url, options) => {
      paths.push(`${options.method} ${url.pathname}`);
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "claude-test" }] });
      if (url.pathname === "/v1/messages") { messages++; return Response.json({}, { status: 500 }); }
      if (url.pathname === "/v1/limits") return Response.json({ models: { "claude-test": { available: true } } });
      return Response.json({});
    }, logger: { error() {} }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const path = "/api/model-health/claude-test/check";
  try {
    assert.equal((await fetch(base + path, { method: "POST" })).status, 401);
    const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "test", password: "test-password" }) });
    const headers = { cookie: login.headers.get("set-cookie").split(";")[0] };
    const response = await fetch(base + path, { method: "POST", headers });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.health.models[0].status, "healthy");
    assert.equal(result.health.models[0].httpStatus, 200);
    assert.equal(result.health.models[0].mode, undefined);
    assert.equal(messages, 0);
    assert.ok(paths.includes("GET /v1/limits"));
    assert.ok(!paths.some(p => p.includes("/v1/messages")));
    const readback = await fetch(base + "/api/model-health", { headers }).then(r => r.json());
    assert.equal(readback.models[0].status, "healthy");
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});
