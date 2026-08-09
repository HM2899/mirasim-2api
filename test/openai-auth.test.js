import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGateway } from "../src/server.js";

test("console-generated API Keys protect OpenAI endpoints and can be revoked", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-openai-auth-"));
  const server = createGateway({
    host: "127.0.0.1",
    port: 0,
    homes: [],
    apiKeyFile: join(root, "api-keys.json"),
    relayUrl: "https://relay.example.test",
    loginUrl: "https://login.example.test",
    webAuth: { username: "console", password: "correct-password", secureCookie: false },
    models: ["gpt-5"],
    timeoutMs: 30_000,
    cooldownMs: 30_000
  }, { logger: { error() {} } });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const denied = await fetch(`${baseUrl}/v1/models`);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error.code, "invalid_api_key");

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "console", password: "correct-password" })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];

    const created = await fetch(`${baseUrl}/api/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Test client" })
    });
    assert.equal(created.status, 201);
    const key = await created.json();
    assert.match(key.key, /^msk_/);
    assert.equal(key.record.name, "Test client");

    const listed = await fetch(`${baseUrl}/api/keys`, { headers: { Cookie: cookie } });
    const listedBody = await listed.json();
    assert.equal(JSON.stringify(listedBody).includes(key.key), false);
    assert.equal(listedBody.keys.length, 1);

    const allowed = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${key.key}` } });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).data[0].id, "gpt-5");

    const revoked = await fetch(`${baseUrl}/api/keys/${encodeURIComponent(key.record.id)}`, { method: "DELETE", headers: { Cookie: cookie } });
    assert.equal(revoked.status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${key.key}` } })).status, 401);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
