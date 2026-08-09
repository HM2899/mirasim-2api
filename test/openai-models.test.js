import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { createGateway } from "../src/server.js";

test("lists the active Mirasim profile's upstream models through the authenticated OpenAI endpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-openai-models-"));
  const home = join(root, "account-a");
  const apiKeyFile = join(root, "api-keys.json");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: "user-a", token: "mirasim-token", exp: 4_102_444_800 } }));
  const server = createGateway({
    host: "127.0.0.1",
    port: 0,
    homes: [home],
    apiKeyFile,
    relayUrl: "https://relay.example.test",
    loginUrl: "https://login.example.test",
    webAuth: { username: "console", password: "correct-password", secureCookie: false },
    models: ["fallback-model"],
    timeoutMs: 30_000,
    cooldownMs: 30_000
  }, {
    fetchImpl: async (url, options) => {
      assert.equal(url.href, "https://relay.example.test/v1/models");
      assert.equal(options.method, undefined);
      assert.equal(options.headers.Authorization, "Bearer mirasim-token");
      return json({ data: [
        { id: "claude-opus-5", object: "model", created: 123, owned_by: "mirasim", max_input_tokens: 1_000_000, max_output_tokens: 128_000 },
        { id: "gpt-5.6", max_input_tokens: 1_050_000 },
        { id: "claude-opus-5" },
        { id: "*" },
        { id: "" }
      ] });
    },
    logger: { error() {} }
  });

  try {
    const { key } = new OpenAIKeyStore(apiKeyFile).create("Model list test");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      object: "list",
      data: [
        { id: "claude-opus-5", object: "model", created: 123, owned_by: "mirasim", max_input_tokens: 1_000_000, max_output_tokens: 128_000 },
        { id: "gpt-5.6", object: "model", created: 0, owned_by: "mirasim-relay", max_input_tokens: 1_050_000 }
      ]
    });
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
