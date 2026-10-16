import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { createGateway } from "../src/server.js";

// The relay routes DeepSeek and Kimi over the same OpenAI-shaped path everything else uses,
// while ZCode uses Anthropic Messages. The agent header is what says which upstream a request is
// for; a request that arrives under the default agent is not a slower DeepSeek request.
test("the model decides the relay agent, and the path stays the one the relay already serves", async () => {
  const seen = [];
  const fixture = gatewayFixture(async (url, options) => {
    seen.push({
      href: url.href,
      agent: options.headers["x-mirasim-agent"],
      client: options.headers["x-mirasim-client"],
      body: JSON.parse(options.body)
    });
    if (url.pathname === "/v1/messages") {
      return json({ id: "msg_1", type: "message", role: "assistant", model: options.headers["x-mirasim-agent"] === "zcode" ? "glm-5.3-flash" : "claude-opus-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    }
    return json({ id: "cmpl_1", object: "chat.completion", model: "deepseek-v4-pro", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Agent routing test").key;
    await fixture.start();
    for (const model of ["deepseek-v4-pro", "deepseek-v4-flash", "kimi-code/k3", "claude-opus-5", "glm-5.3-flash"]) {
      const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply exactly OK." }] })
      });
      assert.equal(response.status, 200);
    }

    assert.deepEqual(seen.map((request) => [request.href, request.agent]), [
      ["https://relay.example.test/v1/chat/completions", "dsh"],
      ["https://relay.example.test/v1/chat/completions", "dsh"],
      ["https://relay.example.test/v1/chat/completions", "kimi"],
      ["https://relay.example.test/v1/messages", "claude"],
      ["https://relay.example.test/v1/messages", "zcode"]
    ]);
    // And every one of them reports the client version the config carries.
    assert.deepEqual([...new Set(seen.map((request) => request.client))], ["0.0.338"]);
    // The official legacy Flash label is translated before signing. ZCode shares the Messages
    // wire protocol but not Claude's required identity/system block.
    assert.equal(seen[1].body.model, "deepseek-flash");
    assert.equal(seen[4].body.model, "glm-5.3-flash");
    assert.equal(seen[4].body.system, undefined);
  } finally {
    fixture.close();
  }
});

test("unrecognized OpenAI models do not fall back to the Anthropic agent", async () => {
  const seen = [];
  const fixture = gatewayFixture(async (url, options) => {
    seen.push({ path: url.pathname, agent: options.headers["x-mirasim-agent"] });
    return new Response(JSON.stringify({ error: { message: "Unknown model" } }), { status: 400, headers: { "content-type": "application/json" } });
  });
  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Fallback routing").key;
    await fixture.start();
    for (const path of ["/v1/chat/completions", "/v1/responses", "/backend-api/codex/responses"]) {
      const response = await fetch(`${fixture.baseUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "custom-model", ...(path === "/v1/chat/completions" ? { messages: [{ role: "user", content: "Hello" }] } : { input: "Hello" }) })
      });
      assert.equal(response.status, 400);
      await response.json();
    }
    assert.deepEqual(seen, [
      { path: "/v1/chat/completions", agent: "codex" },
      { path: "/v1/responses", agent: "codex" },
      { path: "/v1/responses", agent: "codex" }
    ]);
  } finally {
    fixture.close();
  }
});

test("the model list advertises what the relay will serve, not only what it announces", async () => {
  // The relay answers /v1/models for the agent that asked, so a DeepSeek, Kimi or ZCode id
  // need not appear in it — they are reachable all the same, once a request reaches that agent.
  const fixture = gatewayFixture(async () => json({ data: [{ id: "claude-opus-5", created: 123 }, { id: "deepseek-v4-pro" }] }), {
    relayAgents: ["dsh", "kimi", "zcode"]
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Agent models test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
    const body = await response.json();

    assert.deepEqual(body.data.map((model) => [model.id, model.owned_by]), [
      ["claude-opus-5", "mirasim-relay"],
      // Already announced by the relay itself, so it keeps the relay's own entry rather than
      // being listed twice under the agent that would serve it.
      ["deepseek-v4-pro", "mirasim-relay"],
      ["deepseek-flash", "mirasim-relay:dsh"],
      // One Kimi id, because the relay serves one. `kimi-code/k3` is the desktop client's
      // label for it and stays reachable as an alias; it is not a second model.
      ["kimi-k3", "mirasim-relay:kimi"],
      ["glm-5.3-flash", "mirasim-relay:zcode"],
      ["glm-5.3", "mirasim-relay:zcode"]
    ]);
  } finally {
    fixture.close();
  }
});

test("a gateway with no relay agents configured lists exactly what the relay announced", async () => {
  const fixture = gatewayFixture(async () => json({ data: [{ id: "claude-opus-5" }] }));

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("No agents test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
    assert.deepEqual((await response.json()).data.map((model) => model.id), ["claude-opus-5"]);
  } finally {
    fixture.close();
  }
});

test("image routes preserve JSON and convert multipart bytes to signed JSON image references", async () => {
  const seen = [];
  const fixture = gatewayFixture(async (url, options) => {
    seen.push({ path: url.pathname, body: Buffer.from(options.body), headers: options.headers });
    return json({ created: 123, data: [{ b64_json: "aW1hZ2U=" }] });
  }, { clientVersion: "0.0.383" });
  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Image routes").key;
    await fixture.start();
    const rawJson = JSON.stringify({ model: "gpt-image-1", prompt: "A tree", size: "1024x1024" });
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]);
    const form = new FormData();
    form.append("model", "gpt-6-astra");
    form.append("prompt", "Make it blue");
    form.append("image[]", new Blob([png], { type: "image/png" }), "test.png");
    const encoded = new Response(form);
    const multipart = Buffer.from(await encoded.arrayBuffer());
    const multipartType = encoded.headers.get("content-type");
    for (const [path, body, contentType] of [
      ["/v1/images/generations", rawJson, "application/json"],
      ["/backend-api/codex/images/generations", rawJson, "application/json"],
      ["/v1/images/edits", multipart, multipartType],
      ["/backend-api/codex/images/edits", multipart, multipartType]
    ]) {
      const response = await fetch(fixture.baseUrl + path, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": contentType }, body });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).data[0].b64_json, "aW1hZ2U=");
      const upstream = seen.at(-1);
      assert.equal(upstream.path, path.replace("/backend-api/codex/", "/v1/"));
      if (contentType === "application/json") assert.deepEqual(upstream.body, Buffer.from(body));
      else assert.deepEqual(JSON.parse(upstream.body), { model: "gpt-6-astra", prompt: "Make it blue", images: [{ image_url: `data:image/png;base64,${png.toString("base64")}` }] });
      assert.equal(upstream.headers["x-mirasim-agent"], "codex");
      assert.equal(upstream.headers["x-mirasim-client"], "0.0.383");
      assert.equal(upstream.headers["Content-Type"], "application/json");
    }
    assert.equal(seen.length, 4);
  } finally {
    fixture.close();
  }
});

test("image aliases require API authentication and reject malformed bodies before forwarding", async () => {
  const fixture = gatewayFixture(() => assert.fail("invalid requests must not reach relay"));
  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Image auth").key;
    await fixture.start();
    for (const path of ["/v1/images/generations", "/v1/images/edits", "/backend-api/codex/images/generations", "/backend-api/codex/images/edits"]) {
      const unauthenticated = await fetch(fixture.baseUrl + path, { method: "POST", body: "{}" });
      assert.equal(unauthenticated.status, 401);
      await unauthenticated.text();
      const invalid = await fetch(fixture.baseUrl + path, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: "[]" });
      assert.equal(invalid.status, 400);
      await invalid.text();
    }
  } finally {
    fixture.close();
  }
});

test("account feature APIs require console login and reject retired invitation generation", async () => {
  const seen = [];
  const fixture = gatewayFixture(async (url, options) => {
    seen.push({ path: url.pathname, method: options.method });
    if (url.pathname === "/v1/pay/campaign/my-link") return json({ slug: "go-gateway", sold: 1, cap: 3, rewarded: false });
    if (url.pathname === "/v1/reset-cards") return json({ cards: [], history: [] });
    if (url.pathname === "/v1/reset-cards/test-card/redeem") return json({ outcome: "nothingToReset", windows: [], cards: [], history: [] });
    assert.fail(`Unexpected upstream ${url.pathname}`);
  });
  try {
    await fixture.start();
    const unauthorized = await fetch(fixture.baseUrl + "/api/reset-cards?account=account-1");
    assert.equal(unauthorized.status, 401);
    await unauthorized.text();
    const login = await fetch(fixture.baseUrl + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "console", password: "correct-password" }) });
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    await login.text();
    for (const path of ["/api/campaign-link?account=account-1", "/api/reset-cards?account=account-1"]) {
      const response = await fetch(fixture.baseUrl + path, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      await response.json();
    }
    const redeem = await fetch(fixture.baseUrl + "/api/reset-cards/redeem", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ account: "account-1", cardId: "test-card" }) });
    assert.equal((await redeem.json()).outcome, "nothingToReset");
    const retired = await fetch(fixture.baseUrl + "/api/referral", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ account: "account-1" }) });
    assert.equal(retired.status, 410);
    await retired.text();
    assert.deepEqual(seen.map((request) => request.path), ["/v1/pay/campaign/my-link", "/v1/reset-cards", "/v1/reset-cards/test-card/redeem"]);
  } finally {
    fixture.close();
  }
});

for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses"]) {
  for (const stream of [false, true]) {
    test(`image-model generation bridges ${path} stream=${stream}`, async () => {
      const seen = [];
      const fixture = gatewayFixture(async (url, options) => {
        seen.push(url.pathname);
        assert.equal(options.headers["x-mirasim-agent"], "codex");
        const body = JSON.parse(options.body);
        assert.equal(body.prompt, "Draw a tree");
        assert.equal(body.stream, undefined);
        return json({ data: [{ b64_json: "aW1hZ2U=" }], usage: { input_tokens: 4, output_tokens: 9, total_tokens: 13 } });
      });
      try {
        const key = new OpenAIKeyStore(fixture.apiKeyFile).create("image bridge").key;
        await fixture.start();
        const response = await fetch(fixture.baseUrl + path, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-image-1", stream, ...(path === "/v1/responses" ? { input: "Draw a tree" } : { messages: [{ role: "user", content: "Draw a tree" }] }) }) });
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.match(text, /aW1hZ2U=/);
        if (stream) assert.match(text, path === "/v1/messages" ? /message_stop/ : path === "/v1/responses" ? /response.completed/ : /\[DONE\]/);
        else assert.equal(JSON.parse(text).model, "gpt-image-1");
        assert.deepEqual(seen, ["/v1/images/generations"]);
      } finally { fixture.close(); }
    });
  }
}

test("chat image editing maps source URLs without downloading them", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.pathname, "/v1/images/edits");
    const body = JSON.parse(options.body);
    assert.deepEqual(body.images, [{ image_url: "https://example.test/source.png" }]);
    assert.equal(body.input_fidelity, "high");
    return json({ data: [{ b64_json: "YQ==" }] });
  });
  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("edit bridge").key;
    await fixture.start();
    const response = await fetch(fixture.baseUrl + "/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-image-1", image_options: { input_fidelity: "high" }, messages: [{ role: "user", content: [{ type: "text", text: "Make it blue" }, { type: "image_url", image_url: { url: "https://example.test/source.png" } }] }] }) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data:image\/png;base64,YQ==/);
  } finally { fixture.close(); }
});

test("disabled compact aliases return 410 without any upstream or fallback request", async () => {
  const fixture = gatewayFixture(async () => { assert.fail("Disabled compaction must not contact upstream"); });
  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("disabled compact").key;
    await fixture.start();
    for (const path of ["/v1/responses/compact", "/backend-api/codex/responses/compact"]) {
      assert.equal((await fetch(fixture.baseUrl + path, { method: "POST", body: "{}" })).status, 401);
      for (const body of [{ model: "gpt-6-astra", input: "History" }, { stream: true }, {}]) {
        const response = await fetch(fixture.baseUrl + path, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(response.status, 410);
        assert.match((await response.json()).error.message, /disabled/);
        assert.equal(response.headers.get("x-mirasim-compaction-mode"), null);
      }
    }
  } finally { fixture.close(); }
});

test("native Responses image tools preserve large image results beyond text-frame limits", async () => {
  const image = "a".repeat(3 * 1024 * 1024);
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.pathname, "/v1/responses");
    assert.deepEqual(JSON.parse(options.body).tools, [{ type: "image_generation", action: "edit", quality: "high" }]);
    const item = { type: "image_generation_call", id: "ig_test", result: image, status: "completed" };
    return new Response(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_image", status: "completed", output: [item] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("image tools").key;
    await fixture.start();
    for (const stream of [false, true]) {
      const response = await fetch(fixture.baseUrl + "/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-6-astra", input: "Edit the image", stream, store: false, tools: [{ type: "image_generation", action: "edit", quality: "high" }] }) });
      assert.equal(response.status, 200);
      if (!stream) assert.equal((await response.json()).output[0].result.length, image.length);
      else { const text = await response.text(); assert.match(text, /response.completed/); assert.ok(text.includes(image)); assert.doesNotMatch(text, /upstream_stream_error/); }
    }
  } finally { fixture.close(); }
});

test("configured image models are advertised without claiming automatic model discovery", async () => {
  const fixture = gatewayFixture(async () => json({ data: [{ id: "gpt-6-astra" }] }), { imageModels: ["gpt-image-1"] });
  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("image models").key;
    await fixture.start();
    const response = await fetch(fixture.baseUrl + "/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    assert.deepEqual((await response.json()).data.map((model) => model.id), ["gpt-6-astra", "gpt-image-1"]);
  } finally { fixture.close(); }
});

test("raw alpha search aliases retain JSON bytes, query and Codex identity", async () => {
  const body = '{ "query": "native search", "opaque_option": true }';
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.pathname, "/v1/alpha/search");
    assert.equal(url.search, "?version=1");
    assert.equal(options.headers["x-mirasim-agent"], "codex");
    assert.equal(Buffer.from(options.body).toString(), body);
    return json({ opaque_results: [{ title: "Source" }] });
  });
  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("search").key;
    await fixture.start();
    for (const path of ["/v1/alpha/search", "/backend-api/codex/alpha/search"]) {
      assert.equal((await fetch(fixture.baseUrl + path, { method: "POST", body })).status, 401);
      const response = await fetch(fixture.baseUrl + path + "?version=1", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { opaque_results: [{ title: "Source" }] });
    }
  } finally { fixture.close(); }
});

for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses"]) {
  for (const stream of [false, true]) {
    test(`native search through ${path}, stream=${stream}, preserves answers and sources`, async () => {
      const annotation = { type: "url_citation", url: "https://example.com/source", title: "Verified source", start_index: 0, end_index: 6 };
      const output = [{ type: "web_search_call", id: "ws_test", status: "completed", action: { type: "search", query: "news" } }, { type: "message", id: "msg_search", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Answer", annotations: [annotation] }] }];
      const fixture = gatewayFixture(async (url, options) => {
        assert.equal(url.pathname, "/v1/responses");
        assert.equal(options.headers["x-mirasim-agent"], "codex");
        const upstream = JSON.parse(options.body);
        assert.deepEqual(upstream.tools, [{ type: "web_search", search_context_size: "high" }]);
        assert.equal(upstream.web_search_options, undefined);
        assert.equal(upstream.tool_choice, "required");
        const events = [{ type: "response.output_item.done", output_index: 1, item: output[1] }, { type: "response.completed", response: { id: "resp_search", status: "completed", model: "gpt-6-astra", output, usage: { input_tokens: 5, output_tokens: 2 } } }];
        return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      });
      try {
        const key = new OpenAIKeyStore(fixture.apiKeyFile).create("search protocols").key;
        await fixture.start();
        const body = { model: "gpt-6-astra", stream, web_search_options: { search_context_size: "high" }, tool_choice: path === "/v1/messages" ? { type: "any" } : "required", ...(path === "/v1/responses" ? { input: "Find news", store: false } : { messages: [{ role: "user", content: "Find news" }], max_tokens: 200 }) };
        const response = await fetch(fixture.baseUrl + path, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.match(text, /Answer/);
        assert.match(text, /https:\/\/example.com\/source/);
        if (path === "/v1/responses") { assert.match(text, /web_search_call/); assert.match(text, /url_citation/); }
        else assert.equal((text.match(/Verified source/g) || []).length, 1);
        if (stream) assert.match(text, path === "/v1/messages" ? /message_stop/ : path === "/v1/responses" ? /response.completed/ : /\[DONE\]/);
      } finally { fixture.close(); }
    });
  }
}

test("native search tool declarations bridge from Chat and Anthropic with forced choice", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(url.pathname, "/v1/responses");
    assert.deepEqual(body.tools, [{ type: "web_search", filters: { allowed_domains: ["example.com"] } }]);
    assert.deepEqual(body.tool_choice, { type: "web_search" });
    return json({ id: "resp_search", status: "completed", output: [{ type: "message", id: "msg_search", role: "assistant", content: [{ type: "output_text", text: "Found", annotations: [] }] }] });
  });
  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("native tools").key;
    await fixture.start();
    for (const path of ["/v1/chat/completions", "/v1/messages"]) {
      const anthropic = path === "/v1/messages";
      const body = { model: "gpt-6-astra", messages: [{ role: "user", content: "Search" }], max_tokens: 100, tools: [anthropic ? { type: "web_search_20250305", name: "web_search", allowed_domains: ["example.com"] } : { type: "web_search", filters: { allowed_domains: ["example.com"] } }], tool_choice: anthropic ? { type: "tool", name: "web_search" } : { type: "web_search" } };
      const response = await fetch(fixture.baseUrl + path, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Found/);
    }
  } finally { fixture.close(); }
});

test("unsupported search requests fail locally with protocol-specific errors", async () => {
  const fixture = gatewayFixture(async () => { assert.fail("No upstream request expected"); });
  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("invalid search").key;
    await fixture.start();
    for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses"]) {
      const body = { model: "deepseek-flash", web_search_options: {}, input: "Search", messages: [{ role: "user", content: "Search" }], max_tokens: 100 };
      const response = await fetch(fixture.baseUrl + path, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.match(payload.error.message, /Responses-backed text model/);
      if (path === "/v1/messages") assert.equal(payload.type, "error");
    }
  } finally { fixture.close(); }
});



for (const path of ["/v1/chat/completions", "/v1/messages"]) for (const stream of [false, true]) {
  test(`hosted image tools work on ${path} stream=${stream} without prompt changes`, async () => {
    const image = "a".repeat(3 * 1024 * 1024);
    const fixture = gatewayFixture(async (url, options) => {
      assert.equal(url.pathname, "/v1/responses");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "gpt-6-astra");
      assert.equal(body.instructions, "EXACT SYSTEM TEXT");
      assert.deepEqual(body.tools, [{ type: "image_generation", action: "edit", quality: "low" }]);
      assert.deepEqual(body.tool_choice, { type: "image_generation" });
      assert.equal(body.input.at(-1).content[1].image_url, "data:image/png;base64,YQ==");
      const item = { id: "ig_big", type: "image_generation_call", status: "completed", output_format: "png", result: image };
      const events = [{ type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id: "resp_image", status: "completed", output: [item] } }];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    });
    try {
      const key = new OpenAIKeyStore(fixture.apiKeyFile).create("hosted image").key;
      await fixture.start();
      const anthropic = path === "/v1/messages";
      const body = { model: "gpt-6-astra", stream, max_tokens: 300, tools: [{ type: "image_generation", action: "edit", quality: "low" }], tool_choice: anthropic ? { type: "tool", name: "image_generation" } : { type: "image_generation" }, ...(anthropic ? { system: "EXACT SYSTEM TEXT" } : {}), messages: [...(anthropic ? [] : [{ role: "system", content: "EXACT SYSTEM TEXT" }]), { role: "user", content: [{ type: "text", text: "Edit" }, anthropic ? { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } } : { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }] }] };
      const response = await fetch(fixture.baseUrl + path, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      const wire = await response.text();
      assert.doesNotMatch(wire, /upstream_stream_error|"type":"error"/);
      assert.equal((wire.match(/Generated image/g) || []).length, 1);
      if (!stream) {
        const result = JSON.parse(wire);
        const text = anthropic ? result.content[0].text : result.choices[0].message.content;
        assert.ok(text.includes(image));
      } else assert.match(wire, anthropic ? /message_stop/ : /\[DONE\]/);
    } finally { fixture.close(); }
  });
}

for (const path of ["/v1/images/generations", "/backend-api/codex/images/edits"]) {
  test(`streaming image route ${path} maps native previews and preserves prompt`, async () => {
    const edit = path.endsWith("/edits");
    const fixture = gatewayFixture(async (url, options) => {
      assert.equal(url.pathname, "/v1/responses");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "gpt-6-astra");
      assert.equal(body.instructions, undefined);
      assert.equal(body.input[0].content[0].text, "EXACT IMAGE PROMPT");
      assert.equal(body.tools[0].action, edit ? "edit" : "generate");
      const item = { id: "ig", type: "image_generation_call", status: "completed", result: "YQ==", output_format: "png" };
      return new Response([{ type: "response.image_generation_call.partial_image", partial_image_b64: "Yg==", partial_image_index: 0 }, { type: "response.completed", response: { status: "completed", output: [item] } }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    });
    try {
      const key = new OpenAIKeyStore(fixture.apiKeyFile).create("image events").key;
      await fixture.start();
      const response = await fetch(fixture.baseUrl + path, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-6-astra", prompt: "EXACT IMAGE PROMPT", stream: true, partial_images: 1, ...(edit ? { images: [{ image_url: "data:image/png;base64,YQ==" }] } : {}) }) });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      const text = await response.text();
      assert.match(text, new RegExp(`${edit ? "image_edit" : "image_generation"}.partial_image`));
      assert.match(text, new RegExp(`${edit ? "image_edit" : "image_generation"}.completed`));
      assert.doesNotMatch(text, /event: error/);
    } finally { fixture.close(); }
  });
}

function gatewayFixture(fetchImpl, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-agent-routing-"));
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
    clientVersion: "0.0.338",
    webAuth: { username: "console", password: "correct-password", secureCookie: false },
    models: [],
    timeoutMs: 30_000,
    cooldownMs: 30_000,
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

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
