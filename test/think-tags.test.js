import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { createGateway } from "../src/server.js";
import { ThinkTagFilter, splitThinkTags } from "../src/think-tags.js";

// DeepSeek thinking models are served on chat completions alone, and an upstream that has no
// reasoning_content field for them inlines the reasoning at the head of the content, wrapped
// in <think>…</think>. Forwarded as-is, the whole thought lands in the visible answer — the
// "thinking dumped into the body" a Claude Code session shows for DeepSeek.

test("plain text passes the tag filter untouched", () => {
  const filter = new ThinkTagFilter();
  assert.deepEqual(filter.push("Hello"), [{ type: "text", text: "Hello" }]);
  assert.deepEqual(filter.push(" world"), [{ type: "text", text: " world" }]);
  assert.deepEqual(filter.end(), []);
  assert.deepEqual(splitThinkTags("Hello world"), { thinking: "", text: "Hello world" });
});

test("a leading think span splits into reasoning and answer", () => {
  assert.deepEqual(splitThinkTags("<think>让我想想。</think>答案"), { thinking: "让我想想。", text: "答案" });
  assert.deepEqual(splitThinkTags("<THINK>想。</THINK>答"), { thinking: "想。", text: "答" });
  // Leading whitespace before the tag does not turn it into literal text.
  assert.deepEqual(splitThinkTags("\n<think>想。</think>\n\n答"), { thinking: "想。", text: "\n\n答" });
});

test("tags straddling chunk boundaries still split", () => {
  const filter = new ThinkTagFilter();
  assert.deepEqual(filter.push("<th"), []);
  assert.deepEqual(filter.push("ink>让"), [{ type: "thinking", text: "让" }]);
  assert.deepEqual(filter.push("我想。</th"), [{ type: "thinking", text: "我想。" }]);
  assert.deepEqual(filter.push("ink>答"), [{ type: "text", text: "答" }]);
  assert.deepEqual(filter.end(), []);
});

test("a stream that ends inside the span was reasoning to the last byte", () => {
  const filter = new ThinkTagFilter();
  assert.deepEqual(filter.push("<think>一直在想"), [{ type: "thinking", text: "一直在想" }]);
  assert.deepEqual(filter.end(), []);
  assert.deepEqual(splitThinkTags("<think>一直在想"), { thinking: "一直在想", text: "" });
});

test("a tag that shows up after visible text is literal text", () => {
  assert.deepEqual(splitThinkTags("先说。<think>这不是思考</think>"), { thinking: "", text: "先说。<think>这不是思考</think>" });
});

test("an unfinished opening tag at the end of the stream was never a tag", () => {
  const filter = new ThinkTagFilter();
  assert.deepEqual(filter.push("答<th"), [{ type: "text", text: "答<th" }]);
  assert.deepEqual(filter.end(), []);
  assert.deepEqual(splitThinkTags("<th"), { thinking: "", text: "<th" });
});

test("a streamed DeepSeek answer with inlined thinking comes back as Anthropic thinking blocks", async () => {
  const fixture = gatewayFixture(async () => sse(
    { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
    { choices: [{ index: 0, delta: { content: "<th" } }] },
    { choices: [{ index: 0, delta: { content: "ink>让我想想。" } }] },
    { choices: [{ index: 0, delta: { content: "先读文件。</think>" } }] },
    { choices: [{ index: 0, delta: { content: "答案" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }
  ));

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("DeepSeek think test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-pro", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] })
    });

    assert.equal(response.status, 200);
    const events = parseAnthropicStream(await response.text());
    assert.deepEqual(events.map((event) => event.type), [
      "message_start",
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_stop",
      "message_delta", "message_stop"
    ]);
    assert.equal(events[1].content_block.type, "thinking");
    assert.equal(events[2].delta.thinking + events[3].delta.thinking, "让我想想。先读文件。");
    assert.equal(events[5].content_block.type, "text");
    assert.equal(events[6].delta.text, "答案");
    assert.equal(events[8].delta.stop_reason, "end_turn");
  } finally {
    fixture.close();
  }
});

test("a non-streamed DeepSeek answer with inlined thinking comes back as a thinking block", async () => {
  const fixture = gatewayFixture(async () => json({
    id: "chatcmpl-think",
    object: "chat.completion",
    model: "deepseek-v4-pro",
    choices: [{ index: 0, message: { role: "assistant", content: "<think>让我想想。</think>答案" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  }));

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("DeepSeek think test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-pro", max_tokens: 1024, messages: [{ role: "user", content: "hi" }] })
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.content, [{ type: "thinking", thinking: "让我想想。" }, { type: "text", text: "答案" }]);
  } finally {
    fixture.close();
  }
});

test("inlined thinking joins the reasoning item on the Responses bridge, streamed or not", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    return JSON.parse(options.body).stream
      ? sse(
        { choices: [{ index: 0, delta: { content: "<think>让我想想。</th" } }] },
        { choices: [{ index: 0, delta: { content: "ink>答案" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      )
      : json({
        id: "chatcmpl-think",
        object: "chat.completion",
        model: "deepseek-v4-pro",
        choices: [{ index: 0, message: { role: "assistant", content: "<think>让我想想。</think>答案" }, finish_reason: "stop" }]
      });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("DeepSeek think test").key;
    await fixture.start();
    for (const stream of [true, false]) {
      const response = await fetch(`${fixture.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          stream,
          store: false,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]
        })
      });

      assert.equal(response.status, 200);
      const output = stream
        ? parseStreamEvents(await response.text()).find((event) => event.type === "response.completed").response.output
        : (await response.json()).output;
      assert.deepEqual(output.map((item) => item.type), ["reasoning", "message"]);
      assert.equal(output[0].summary[0].text, "让我想想。");
      assert.equal(output[1].content[0].text, "答案");
    }
  } finally {
    fixture.close();
  }
});

function gatewayFixture(fetchImpl, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-think-tags-"));
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

function sse(...chunks) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify({ id: "chatcmpl-s", object: "chat.completion.chunk", model: "deepseek-v4-pro", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function parseAnthropicStream(text) {
  return text.split("\n\n").filter(Boolean).map((frame) => {
    const name = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5));
    assert.equal(name, data.type, frame);
    return data;
  });
}

function parseStreamEvents(text) {
  return text.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5)));
}
