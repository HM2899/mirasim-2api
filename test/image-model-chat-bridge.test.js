import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { createGateway } from "../src/server.js";

// The relay refuses every model on /v1/images/* with `404 图片生成不支持这个模型 / Image generation
// is not available for this model` — including the gemini image models this account is entitled
// to. Those models are served on chat completions, so an image request for one is bridged to the
// endpoint it is actually served on and the answer is translated back into the images API shape.
// Every other model keeps the raw passthrough it had: no model substitution is invented.

const IMAGE = "data:image/jpeg;base64,YWJj";

const chatImage = (content) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "gemini-3-pro-image",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 7 }
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (...frames) => new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

test("a gemini image generation reaches the endpoint the relay serves it on", async () => {
  let sent = null;
  const fixture = gatewayFixture(async (url, options) => {
    sent = { href: url.href, agent: options.headers["x-mirasim-agent"], body: JSON.parse(options.body) };
    return json(chatImage(`Here you go.\n\n![Generated image 1](${IMAGE})`));
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("image bridge").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini-3-pro-image", prompt: "A cat on a windowsill", size: "1024x1024" })
    });

    assert.equal(response.status, 200);
    assert.equal(sent.href, "https://relay.example.test/v1/chat/completions");
    assert.equal(sent.agent, "codex");
    assert.deepEqual(sent.body, {
      model: "gemini-3-pro-image",
      messages: [{ role: "user", content: "A cat on a windowsill" }],
      stream: false,
      size: "1024x1024"
    });

    const body = await response.json();
    assert.equal(body.model, "gemini-3-pro-image");
    assert.equal(typeof body.created, "number");
    assert.deepEqual(body.data, [{ b64_json: "YWJj" }]);
  } finally {
    fixture.close();
  }
});

test("the edits endpoint bridges source images as chat image parts", async () => {
  let sent = null;
  const fixture = gatewayFixture(async (url, options) => {
    sent = { href: url.href, body: JSON.parse(options.body) };
    return json(chatImage(`![Edited image 1](${IMAGE})`));
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("image edit bridge").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.1-flash-image",
        prompt: "Put the cat on a starry night",
        images: [{ image_url: "data:image/png;base64,YQ==" }]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(sent.href, "https://relay.example.test/v1/chat/completions");
    assert.deepEqual(sent.body.messages, [{
      role: "user",
      content: [
        { type: "text", text: "Put the cat on a starry night" },
        { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }
      ]
    }]);
    assert.deepEqual((await response.json()).data, [{ b64_json: "YWJj" }]);
  } finally {
    fixture.close();
  }
});

test("a streamed chat answer is collected before the image payload is written", async () => {
  const fixture = gatewayFixture(async () => sse(
    { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
    { choices: [{ index: 0, delta: { content: "![Generated image 1](data:image/jpeg;base64,YWJj)" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
  ));

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("image stream bridge").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini-3-pro-image", prompt: "A cat" })
    });

    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, [{ b64_json: "YWJj" }]);
  } finally {
    fixture.close();
  }
});

test("an upstream answer without an image is an error, not a fabricated one", async () => {
  const fixture = gatewayFixture(async () => json(chatImage("I cannot draw that.")));

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("image refusal").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini-3-pro-image", prompt: "A cat" })
    });

    assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /no image/i);
  } finally {
    fixture.close();
  }
});

test("an upstream failure keeps its own status instead of becoming a success", async () => {
  const fixture = gatewayFixture(async () => json({ error: { message: "quota exhausted" } }, 429));

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("image upstream failure").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini-3-pro-image", prompt: "A cat" })
    });

    assert.equal(response.status, 429);
  } finally {
    fixture.close();
  }
});

test("a gpt-image model and a non-image model keep the raw upstream route", async () => {
  const seen = [];
  const fixture = gatewayFixture(async (url) => {
    seen.push(url.href);
    return json({ created: 1, data: [{ b64_json: "cmF3" }] });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("raw image route").key;
    await fixture.start();
    for (const model of ["gpt-image-1", "gemini-3.1-pro-preview"]) {
      const response = await fetch(`${fixture.baseUrl}/v1/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: "A cat" })
      });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data, [{ b64_json: "cmF3" }]);
    }
    assert.deepEqual(seen, ["https://relay.example.test/v1/images/generations", "https://relay.example.test/v1/images/generations"]);
  } finally {
    fixture.close();
  }
});

test("options the bridge cannot translate are refused before any upstream request", async () => {
  let calls = 0;
  const fixture = gatewayFixture(async () => {
    calls += 1;
    return json(chatImage(`![Generated image 1](${IMAGE})`));
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("untranslatable options").key;
    await fixture.start();
    for (const extra of [{ n: 2 }, { response_format: "url" }, { stream: true }, { output_format: "webp" }, { tools: [] }]) {
      const response = await fetch(`${fixture.baseUrl}/v1/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gemini-3-pro-image", prompt: "A cat", ...extra })
      });
      assert.equal(response.status, 400, JSON.stringify(extra));
    }
    assert.equal(calls, 0);
  } finally {
    fixture.close();
  }
});

function gatewayFixture(fetchImpl, { accountCount = 1, ...overrides } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-image-bridge-"));
  const home = join(root, "account-a");
  const apiKeyFile = join(root, "api-keys.json");
  const homes = [];
  for (let index = 0; index < accountCount; index += 1) {
    const accountHome = index === 0 ? home : join(root, `account-${String.fromCharCode(97 + index)}`);
    const suffix = String.fromCharCode(97 + index);
    mkdirSync(accountHome, { recursive: true });
    writeFileSync(join(accountHome, "setting.json"), JSON.stringify({ auth: { userId: `user-${suffix}`, token: `mirasim-token-${suffix}`, exp: 4_102_444_800 } }));
    homes.push(accountHome);
  }
  const server = createGateway({
    host: "127.0.0.1",
    port: 0,
    homes,
    apiKeyFile,
    relayUrl: "https://relay.example.test",
    loginUrl: "https://login.example.test",
    webAuth: { username: "console", password: "correct-password", secureCookie: false },
    models: [],
    timeoutMs: 30_000,
    cooldownMs: 30_000,
    reasoningMode: "managed",
    ...overrides
  }, { fetchImpl, logger: { error() {} } });
  let baseUrl;
  return {
    apiKeyFile,
    async start() {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    },
    get baseUrl() { return baseUrl; },
    close() {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
