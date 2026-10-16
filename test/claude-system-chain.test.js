import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/server.js";

const identity = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const identityBlock = { type: "text", text: identity, cache_control: { type: "ephemeral" } };
const paths = ["/v1/messages", "/v1/chat/completions", "/v1/responses", "/backend-api/codex/responses"];

for (const model of ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "claude-fable-5"]) {
  for (const path of paths) {
    for (const stream of [false, true]) {
      test(`${model} identity, headers and reasoning survive ${path} stream=${stream}`, async () => {
        const fixture = await gatewayFixture();
        try {
          const response = await fixture.ask(path, { model, stream });
          assert.equal(response.status, 200);
          const sent = fixture.sent[0];
          assert.equal(sent.path, "/v1/messages");
          assert.equal(sent.headers["anthropic-version"], "2023-06-01");
          assert.match(sent.headers["anthropic-beta"], /prompt-caching/);
          assert.equal(sent.headers["x-mirasim-agent"], "claude");
          assert.deepEqual(sent.body.system[0], identityBlock);
          assert.equal(sent.body.system[1].text, "Keep the client instructions.");
          assert.ok(cacheBlocks(sent.body).length <= 4);
          let answer;
          let reasoning;
          if (stream) {
            const events = (await response.text()).split(/\r?\n/).filter((line) => line.startsWith("data:") && !line.includes("[DONE]")).map((line) => JSON.parse(line.slice(5)));
            answer = events.map((event) => event.choices?.[0]?.delta?.content || (event.delta?.type === "text_delta" ? event.delta.text : event.type === "response.output_text.delta" ? event.delta : "")).join("");
            reasoning = events.map((event) => event.choices?.[0]?.delta?.reasoning_content || (event.delta?.type === "thinking_delta" ? event.delta.thinking : event.type === "response.reasoning_summary_text.delta" ? event.delta : "")).join("");
          } else {
            const body = await response.json();
            if (path === "/v1/chat/completions") {
              answer = body.choices[0].message.content;
              reasoning = body.choices[0].message.reasoning_content;
            } else if (path === "/v1/messages") {
              answer = body.content.filter((part) => part.type === "text").map((part) => part.text).join("");
              reasoning = body.content.filter((part) => part.type === "thinking").map((part) => part.thinking).join("");
            } else {
              answer = body.output.filter((item) => item.type === "message").flatMap((item) => item.content).map((part) => part.text).join("");
              reasoning = body.output.filter((item) => item.type === "reasoning").flatMap((item) => item.summary).map((part) => part.text).join("");
            }
          }
          assert.equal(answer, "Answer");
          assert.equal(reasoning, "Reasoning");
        } finally { await fixture.close(); }
      });
    }
  }
}

for (const path of paths) {
  test(`caller identity stays unique and its cache preference survives ${path}`, async () => {
    const fixture = await gatewayFixture();
    try {
      const system = [{ ...identityBlock, cache_control: { type: "ephemeral", ttl: "1h" } }];
      const response = await fixture.ask(path, { system });
      assert.equal(response.status, 200);
      await response.text();
      const sent = fixture.sent[0].body;
      assert.deepEqual(sent.system[0], system[0]);
      assert.equal(sent.system.filter((block) => block.text === identity).length, 1);
      // The caller's one-hour marker stays exactly where it was put; the breakpoints beyond
      // it are the gateway filling the slots the caller left spare.
      assert.ok(cacheBlocks(sent).length > 1);
      assert.ok(cacheBlocks(sent).length <= 4);
    } finally { await fixture.close(); }
  });
}

for (const path of ["/v1/chat/completions", "/v1/responses"]) {
  test(`${path} keeps mid-conversation system instructions in their original position`, async () => {
    const fixture = await gatewayFixture();
    try {
      const messages = [
        { role: "system", content: "Initial instruction" },
        { role: "user", content: "First turn" },
        { role: "assistant", content: "First answer" },
        { role: "developer", content: "New instruction for the next turn" },
        { role: "user", content: "Next turn" }
      ];
      const response = await fixture.ask(path, path.endsWith("/responses") ? { instructions: "", input: messages } : { messages });
      assert.equal(response.status, 200);
      await response.text();
      const body = fixture.sent[0].body;
      assert.deepEqual(body.system.map((block) => block.text), [identity, "Initial instruction"]);
      assert.deepEqual(body.messages.map((message) => message.role), ["user", "assistant", "system", "user"]);
      assert.equal(body.messages[2].content[0].text, "New instruction for the next turn");
    } finally { await fixture.close(); }
  });

  test(`${path} preserves system, developer and tool cache controls`, async () => {
    const fixture = await gatewayFixture();
    try {
      const longCache = { type: "ephemeral", ttl: "1h" };
      const shortCache = { type: "ephemeral" };
      const fields = path === "/v1/chat/completions" ? {
        messages: [
          { role: "system", content: [{ type: "text", text: "System", cache_control: longCache }] },
          { role: "developer", content: [{ type: "text", text: "Developer", cache_control: shortCache }] },
          { role: "user", content: "Hello" }
        ],
        tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" }, cache_control: longCache } }]
      } : {
        instructions: [{ type: "text", text: "System", cache_control: longCache }],
        input: [{ role: "developer", content: [{ type: "input_text", text: "Developer", cache_control: shortCache }] }, { role: "user", content: "Hello" }],
        tools: [{ type: "function", name: "Read", parameters: { type: "object" }, cache_control: longCache }]
      };
      const response = await fixture.ask(path, fields);
      assert.equal(response.status, 200);
      await response.text();
      const body = fixture.sent[0].body;
      assert.deepEqual(body.system, [
        { type: "text", text: identity },
        { type: "text", text: "System", cache_control: longCache },
        { type: "text", text: "Developer", cache_control: shortCache }
      ]);
      assert.deepEqual(body.tools[0].cache_control, longCache);
      assert.equal(cacheBlocks(body).length, 4);
      assert.deepEqual(body.messages[0].content, [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }]);
    } finally { await fixture.close(); }
  });

  test(`${path} rejects malformed Claude system extensions before forwarding`, async () => {
    const fixture = await gatewayFixture();
    try {
      const response = await fixture.ask(path, { system: { text: "not a block array" } });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error.message, /system:/);
      assert.equal(fixture.sent.length, 0);
    } finally { await fixture.close(); }
  });
}

test("four caller-owned tool breakpoints never become a fifth identity breakpoint", async () => {
  const fixture = await gatewayFixture();
  try {
    const tools = Array.from({ length: 4 }, (_, index) => ({ name: `Tool${index}`, input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }));
    const response = await fixture.ask("/v1/messages", { tools });
    assert.equal(response.status, 200);
    await response.text();
    const body = fixture.sent[0].body;
    assert.deepEqual(body.tools, tools);
    assert.equal(body.system[0].text, identity);
    assert.equal(body.system[0].cache_control, undefined);
    assert.equal(cacheBlocks(body).length, 4);
    // No slot is spare, so no marker is added — but the string shorthand still becomes a
    // block, the one shape the upstream ever sees a turn in.
    assert.deepEqual(body.messages[0].content, [{ type: "text", text: "Hello" }]);
  } finally { await fixture.close(); }
});

test("splitting a mixed identity block preserves an already full cache budget", async () => {
  const fixture = await gatewayFixture();
  try {
    const instructions = "Keep all client instructions and their original cache boundary.";
    const cache = { type: "ephemeral", ttl: "1h" };
    const tools = Array.from({ length: 3 }, (_, index) => ({ type: "function", name: `Tool${index}`, parameters: { type: "object" }, cache_control: cache }));
    const response = await fixture.ask("/v1/responses", {
      instructions: [{ type: "text", text: `${identity}\n${instructions}`, cache_control: cache }], tools
    });
    assert.equal(response.status, 200);
    await response.text();
    const body = fixture.sent[0].body;
    assert.deepEqual(body.system, [
      { type: "text", text: identity },
      { type: "text", text: instructions, cache_control: cache }
    ]);
    assert.equal(cacheBlocks(body).length, 4);
    const replay = await fixture.ask("/v1/messages", body);
    assert.equal(replay.status, 200);
    await replay.text();
    assert.deepEqual(fixture.sent[1].body, body);
  } finally { await fixture.close(); }
});

test("Claude identity and cache preparation are idempotent across protocol conversions", async () => {
  const fixture = await gatewayFixture();
  try {
    const first = await fixture.ask("/v1/chat/completions");
    assert.equal(first.status, 200);
    await first.text();
    const prepared = structuredClone(fixture.sent[0].body);
    const second = await fixture.ask("/v1/messages", prepared);
    assert.equal(second.status, 200);
    await second.text();
    assert.deepEqual(fixture.sent[1].body, prepared);
  } finally { await fixture.close(); }
});

for (const model of ["gpt-5.6-sol", "deepseek-v4-pro"]) {
  for (const path of paths) {
    test(`${model} does not receive Claude identity or protocol headers from ${path}`, async () => {
      const fixture = await gatewayFixture();
      try {
        const response = await fixture.ask(path, { model }, { "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31" });
        assert.equal(response.status, 200);
        await response.text();
        const sent = fixture.sent[0];
        assert.equal(sent.headers["anthropic-version"], undefined);
        assert.equal(sent.headers["anthropic-beta"], undefined);
        assert.ok(!JSON.stringify(sent.body).includes(identity));
        assert.equal(sent.path, model.startsWith("gpt") ? "/v1/responses" : "/v1/chat/completions");
      } finally { await fixture.close(); }
    });
  }
}

function cacheBlocks(body) {
  return [body, ...(body.tools || []), ...(body.system || []), ...(body.messages || []).flatMap((message) => Array.isArray(message.content) ? message.content : [])].filter((block) => block.cache_control);
}

async function gatewayFixture(respond = null) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-claude-system-"));
  const home = join(root, "account");
  mkdirSync(home);
  writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: "user", token: "token", exp: 4_102_444_800 } }));
  const config = loadConfig({ MIRASIM_HOME: root, MIRASIM_HOMES: home, MIRASIM_RELAY_URL: "https://relay.example.test", WEB_AUTH_PASSWORD: "password" });
  const sent = [];
  const server = createGateway(config, { logger: { error() {} }, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    sent.push({ path: url.pathname, headers: options.headers, body });
    const override = respond?.(url, body);
    if (override) return override;
    if (url.pathname === "/v1/responses") return json({ id: "resp", output: [{ type: "message", content: [{ type: "output_text", text: "Answer" }] }] });
    if (url.pathname === "/v1/chat/completions") return json({ choices: [{ message: { content: "Answer" }, finish_reason: "stop" }] });
    const content = [{ type: "thinking", thinking: "Reasoning", signature: "test-upstream-signature" }, { type: "text", text: "Answer" }];
    const message = { id: "msg", type: "message", role: "assistant", model: body.model, content, stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } };
    if (!body.stream) return json(message);
    const events = [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Reasoning" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "test-upstream-signature" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: message.usage },
      { type: "message_stop" }
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  const { key } = new OpenAIKeyStore(config.databaseFile).create("Claude system regression");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    sent,
    ask(path, fields = {}, headers = {}) {
      const instructions = "Keep the client instructions.";
      const input = path.endsWith("/responses") ? { instructions, input: "Hello" }
        : path === "/v1/messages" ? { system: instructions, messages: [{ role: "user", content: "Hello" }] }
        : { messages: [{ role: "system", content: instructions }, { role: "user", content: "Hello" }] };
      return fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "x-api-key": key, "Content-Type": "application/json", ...headers }, body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 1024, ...input, ...fields }) });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function json(body) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

for (const path of paths) {
  for (const stream of [false, true]) {
    test(`Claude Code identity follows the actual protocol boundary ${path} stream=${stream}`, async () => {
      const codeIdentity = "You are Claude Code, Anthropic's official CLI for Claude.";
      const fixture = await gatewayFixture();
      try {
        const instructions = `${codeIdentity}\nFollow the external client's tool instructions. Never delete user changes.`;
        const fields = path === "/v1/messages" ? { system: instructions }
          : path.endsWith("/responses") ? { instructions }
          : { messages: [{ role: "system", content: instructions }, { role: "user", content: "Hello" }] };
        const response = await fixture.ask(path, { ...fields, model: "claude-fable-5-1", stream });
        assert.equal(response.status, 200);
        const wire = await response.text();
        const sent = fixture.sent[0];
        assert.equal(sent.path, "/v1/messages");
        const expected = [identity, instructions.slice(codeIdentity.length + 1)];
        assert.deepEqual(sent.body.system.map((block) => block.text), expected);
        assert.ok(cacheBlocks(sent.body).length <= 4);
        assert.match(wire, /Answer/);
        assert.match(wire, /Reasoning/);
        assert.equal(fixture.sent.length, 1);
      } finally { await fixture.close(); }
    });
  }
}

for (const path of paths.filter((path) => path !== "/v1/messages")) {
  for (const stream of [false, true]) {
    for (const source of ["instructions", "system-extension"]) {
      test(`mixed identity block is separated before signing ${path} stream=${stream} source=${source}`, async () => {
        const instructions = "Codex CLI is an open source project led by OpenAI. Within this context, Codex refers to the open-source agentic coding interface. Keep user changes safe.";
        const fixture = await gatewayFixture((url, body) => {
          if (body.system.some((block) => block.text.includes(identity) && block.text.includes(instructions))) {
            return new Response(JSON.stringify({ error: { message: "system prompt must not present another product's instructions behind Claude Code's identity line" } }), { status: 400, headers: { "content-type": "application/json" } });
          }
        });
        try {
          const content = [{ type: "text", text: `${identity}\n${instructions}`, cache_control: { type: "ephemeral", ttl: "1h" } }];
          const fields = source === "system-extension" ? { system: content }
            : path.endsWith("/responses") ? { instructions: content }
            : { messages: [{ role: "developer", content }, { role: "user", content: "Hello" }] };
          const response = await fixture.ask(path, { ...fields, model: "claude-fable-5-1", stream });
          const wire = await response.text();
          assert.equal(response.status, 200, wire);
          const sent = fixture.sent[0];
          assert.equal(sent.path, "/v1/messages");
          assert.deepEqual(sent.body.system.slice(0, 2), [
            { type: "text", text: identity },
            { type: "text", text: instructions, cache_control: { type: "ephemeral", ttl: "1h" } }
          ]);
          assert.ok(cacheBlocks(sent.body).length <= 4);
          assert.match(wire, /Answer/);
          assert.match(wire, /Reasoning/);
          assert.equal(fixture.sent.length, 1);
        } finally { await fixture.close(); }
      });
    }
  }
}

for (const path of paths) {
  for (const stream of [false, true]) {
    test(`foreign identity conflict is corrected before forwarding ${path} stream=${stream}`, async () => {
      const fixture = await gatewayFixture((url, body) => {
        const text = JSON.stringify([body.system, ...body.messages.filter((message) => message.role === "system")]);
        if (text.includes("You are Codex") || text.includes("coding agent running in the Codex CLI")) {
          return new Response(JSON.stringify({ error: { message: "system prompt must not present another product's instructions behind Claude Code's identity line" } }), { status: 400, headers: { "content-type": "application/json" } });
        }
      });
      try {
        const code = "You are Claude Code, Anthropic's official CLI for Claude.";
        const instructions = "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.\nNever delete user changes. Use exec_command for shell tasks.";
        const system = [{ type: "text", text: code, cache_control: { type: "ephemeral", ttl: "1h" } }];
        const fields = path === "/v1/messages" ? { system: [...system, { type: "text", text: instructions }] }
          : path.endsWith("/responses") ? { system, instructions }
          : { system, messages: [{ role: "developer", content: instructions }, { role: "user", content: "Hello" }] };
        const response = await fixture.ask(path, { ...fields, stream });
        const wire = await response.text();
        assert.equal(response.status, 200, wire);
        assert.equal(fixture.sent.length, 1);
        const sent = fixture.sent[0].body;
        assert.equal(sent.system[0].text, identity);
        assert.deepEqual(sent.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
        assert.equal(sent.system[1].text, "You are an AI coding assistant.\nNever delete user changes. Use exec_command for shell tasks.");
        assert.match(wire, /Answer/);
        assert.match(wire, /Reasoning/);
      } finally { await fixture.close(); }
    });
  }
}

for (const model of ["gpt-5.6-sol", "deepseek-v4-pro"]) {
  test(`${model} retains original client identity instructions`, async () => {
    const fixture = await gatewayFixture();
    try {
      const instructions = "You are Codex, based on GPT-5.6.\nKeep all edits scoped.";
      const response = await fixture.ask("/v1/chat/completions", { model, messages: [{ role: "system", content: instructions }, { role: "user", content: "Hello" }] });
      assert.equal(response.status, 200);
      await response.text();
      const sent = fixture.sent[0].body;
      assert.equal(model.startsWith("gpt") ? sent.instructions : sent.messages[0].content, instructions);
    } finally { await fixture.close(); }
  });
}

test("an unrelated upstream 400 is preserved without replaying the request", async () => {
  const fixture = await gatewayFixture(() => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Unsupported tool schema" } }), { status: 400, headers: { "content-type": "application/json" } }));
  try {
    const response = await fixture.ask("/v1/chat/completions", { messages: [{ role: "system", content: "You are Codex." }, { role: "user", content: "Hello" }] });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Unsupported tool schema/);
    assert.equal(fixture.sent.length, 1);
  } finally { await fixture.close(); }
});
