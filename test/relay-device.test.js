import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MirasimRelaySessions } from "../src/relay-device.js";

test("official relay requests use a persisted device key and reuse a short-lived ticket", async () => {
  const home = mkdtempSync(join(tmpdir(), "mirasim-device-"));
  writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { token: "login-token" } }));
  let requests = 0;
  const sessions = new MirasimRelaySessions({ relayUrl: "https://mirasim-relay.mirofish.ai" }, {
    fetchImpl: async (url, options) => {
      requests += 1;
      assert.equal(url.pathname, "/v1/device/session");
      assert.equal(options.headers.Authorization, "Bearer login-token");
      assert.ok(options.headers["x-mirasim-device"]);
      assert.ok(options.headers["x-mirasim-sig"]);
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
    assert.ok(first["x-mirasim-device"]);
    assert.ok(first["x-mirasim-sig"]);
    const setting = JSON.parse(readFileSync(join(home, "setting.json"), "utf8"));
    assert.equal(typeof setting.device.privateKey, "string");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a rate-limited ticket mint is backed off instead of retried on every request", async () => {
  const home = mkdtempSync(join(tmpdir(), "mirasim-device-backoff-"));
  writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { token: "login-token" } }));
  let requests = 0;
  let now = 1_000_000;
  const sessions = new MirasimRelaySessions({ relayUrl: "https://mirasim-relay.mirofish.ai" }, {
    now: () => now,
    fetchImpl: async () => {
      requests += 1;
      return new Response("busy", { status: 429, headers: { "retry-after": "120" } });
    }
  });
  try {
    const profile = { home, token: "login-token" };
    await sessions.headersFor(profile, { method: "GET", path: "/v1/models" });
    await sessions.headersFor(profile, { method: "GET", path: "/v1/models" });
    assert.equal(requests, 1);
    now += 121_000;
    await sessions.headersFor(profile, { method: "GET", path: "/v1/models" });
    assert.equal(requests, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
