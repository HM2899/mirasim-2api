import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/server.js";

const AGENT_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

test("Anthropic Messages uses x-api-key and preserves native protocol headers", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.href, "https://relay.example.test/v1/messages");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer mirasim-token");
    assert.equal(options.headers["anthropic-version"], "2023-06-01");
    assert.equal(options.headers["anthropic-beta"], "prompt-caching-2024-07-31");
    assert.equal(options.headers["x-api-key"], undefined);
    assert.deepEqual(JSON.parse(options.body), {
      model: "claude-haiku-4-5",
      max_tokens: 1,
      // A caller that marks no cache breakpoint of its own gets this gateway's, and the
      // string shorthand becomes a block so the breakpoint has somewhere to hang.
      messages: [{ role: "user", content: [{ type: "text", text: "Reply exactly OK.", cache_control: { type: "ephemeral" } }] }],
      system: [{ type: "text", text: AGENT_IDENTITY, cache_control: { type: "ephemeral" } }]
    });
    return json({ id: "msg_123", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Anthropic test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31"
      },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "Reply exactly OK." }] })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, "OK");

    const denied = await fetch(`${fixture.baseUrl}/v1/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { type: "error", error: { type: "authentication_error", message: "Missing or invalid API key." } });
  } finally {
    fixture.close();
  }
});

test("Anthropic Messages from a non-Claude-Code client keeps its own system prompt after the agent identity", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    assert.deepEqual(JSON.parse(options.body).system, [
      { type: "text", text: AGENT_IDENTITY },
      { type: "text", text: "Answer in French.", cache_control: { type: "ephemeral" } }
    ]);
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Third party client test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 16,
        system: "Answer in French.",
        messages: [{ role: "user", content: "Hello" }]
      })
    });
    assert.equal(response.status, 200);
  } finally {
    fixture.close();
  }
});

test("Anthropic Messages from Claude Code forwards its system blocks unchanged", async () => {
  const claudeCodeSystem = [
    { type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: { type: "ephemeral" } },
    { type: "text", text: "# Environment" }
  ];
  const fixture = gatewayFixture(async (url, options) => {
    assert.deepEqual(JSON.parse(options.body).system, claudeCodeSystem);
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Claude Code test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 16, system: claudeCodeSystem, messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(response.status, 200);
  } finally {
    fixture.close();
  }
});

// A converting gateway (sub2api, new-api) reaches /v1/messages with an already-Anthropic
// body it built from an OpenAI one, so it carries no cache_control: that protocol cannot
// express one. Nothing here translates such a request, so before this gateway wrote the
// breakpoints itself every turn of the conversation was billed as a full cold prefix.
test("Anthropic Messages converted from OpenAI upstream get cache breakpoints that carry across turns", async () => {
  const sent = [];
  const fixture = gatewayFixture(async (url, options) => {
    sent.push(JSON.parse(options.body));
    return json({
      id: `msg_${sent.length}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "tool_use", id: `toolu_${sent.length}`, name: "Read", input: {} }],
      stop_reason: "tool_use",
      usage: { input_tokens: 8, output_tokens: 1 }
    });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Converted gateway test").key;
    await fixture.start();
    const messages = [{ role: "user", content: "Fix the bug." }];
    for (let turn = 0; turn < 4; turn += 1) {
      const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 16,
          system: CLAUDE_CODE_IDENTITY,
          tools: [{ name: "Read", description: "Read a file.", input_schema: { type: "object", properties: {} } }],
          // The converting gateway rebuilds the body from its own history every turn, so it
          // never echoes back the breakpoints this gateway wrote on the previous one.
          messages: structuredClone(messages)
        })
      });
      assert.equal(response.status, 200);
      const message = await response.json();
      messages.push({ role: "assistant", content: message.content });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.content[0].id, content: "ok" }] });
    }

    // Anthropic allows four breakpoints: one pins tools and system at the last system block,
    // the rest roll along the newest user turns.
    for (const body of sent) {
      assert.deepEqual(body.system.at(-1).cache_control, { type: "ephemeral" });
      assert.ok(cacheBreakpointsOf(body).length > 1, "every turn marks the newest user turn");
      assert.ok(cacheBreakpointsOf(body).length <= 4, "Anthropic rejects a fifth breakpoint");
    }

    for (let turn = 1; turn < sent.length; turn += 1) {
      const previous = sent[turn - 1];
      const current = sent[turn];
      // A breakpoint only ever reads a prefix that is byte-identical to the one it was
      // written against, so any drift in tools, system, or the earlier turns silently costs
      // the whole cache.
      assert.deepEqual(withoutCacheControl(current.tools), withoutCacheControl(previous.tools));
      assert.deepEqual(withoutCacheControl(current.system), withoutCacheControl(previous.system));
      assert.deepEqual(
        withoutCacheControl(current.messages.slice(0, previous.messages.length)),
        withoutCacheControl(previous.messages)
      );
      // Re-marking a position the previous turn already wrote is what turns that write into
      // this turn's read; without the overlap every breakpoint would be a cold write.
      const carried = cacheBreakpointsOf(previous).filter((mark) => cacheBreakpointsOf(current).includes(mark));
      assert.ok(carried.length > 0, `turn ${turn + 1} shares no breakpoint with turn ${turn}`);
    }
  } finally {
    fixture.close();
  }
});

// The OpenAI protocol cannot express extended thinking, so a converted /v1/messages request
// arrives with no `thinking` and the relay answers with it off — which also makes Claude write
// tool calls into its visible text instead of emitting tool_use blocks, so tools stop firing.
test("Anthropic Messages converted from OpenAI get adaptive thinking on a current model", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    // Current models reject a fixed budget outright; adaptive is their only on-mode.
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.equal(body.max_tokens, 16_000, "an adaptive default must not rewrite max_tokens");
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  }, { defaultReasoningEffort: "medium" });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Adaptive default test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 16_000,
        tools: [{ name: "Read", description: "Read a file.", input_schema: { type: "object", properties: {} } }],
        messages: [{ role: "user", content: "Read server.js" }]
      })
    });
    assert.equal(response.status, 200);
  } finally {
    fixture.close();
  }
});

test("Anthropic Messages converted from OpenAI get a thinking budget on a model without adaptive", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    // claude-haiku-4-5 predates adaptive thinking and takes a fixed budget instead.
    assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 8192 });
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  }, { defaultReasoningEffort: "medium" });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Budget default test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 16_000, messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(response.status, 200);
  } finally {
    fixture.close();
  }
});

// The turn that breaks with thinking off is the one that declares tools, so a small budget
// must not cost it thinking — that is how "ask Codex to look something up and it never calls
// search" happens. Room for the thinking is made instead.
test("a tool-bearing turn gets thinking even when the caller budgeted almost no tokens", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.ok(body.max_tokens >= 2048, `max_tokens must leave room for thinking, got ${body.max_tokens}`);
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  }, { defaultReasoningEffort: "medium" });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Agent turn test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 512,
        tools: [{ name: "web_search", description: "Search the web.", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
        messages: [{ role: "user", content: "Look up today's release notes." }]
      })
    });
    assert.equal(response.status, 200);
  } finally {
    fixture.close();
  }
});

// Offering a search tool is not enough: with a foreign system prompt in front of it Claude
// answers from memory instead of reaching for search. Naming the cases that need current
// information is what gets it used.
test("a request offering a server-side search tool is told when to search", async () => {
  const seen = [];
  const fixture = gatewayFixture(async (url, options) => {
    seen.push(JSON.parse(options.body).system);
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  }, { defaultReasoningEffort: "medium" });

  const send = (tools) => fetch(`${fixture.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": fixture.key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-opus-5", max_tokens: 16_000, system: "You are Codex, based on GPT-5.", tools, messages: [{ role: "user", content: "What shipped recently?" }] })
  });

  try {
    fixture.key = new OpenAIKeyStore(fixture.apiKeyFile).create("Search guidance test").key;
    await fixture.start();
    await send([{ type: "web_search_20250305", name: "web_search" }]);
    // A client-side tool of the same name is Claude Code's own, and carries its own prompt.
    await send([{ name: "WebSearch", description: "Search.", input_schema: { type: "object", properties: {} } }]);

    const guided = seen[0].some((block) => block.text.includes("<search_first>"));
    const untouched = seen[1].every((block) => !block.text.includes("<search_first>"));
    assert.ok(guided, "a server-side search tool must come with guidance on when to use it");
    assert.ok(untouched, "a client-side tool belongs to a client that brought its own prompt");
  } finally {
    fixture.close();
  }
});

// Anthropic runs a server tool itself and reports it as server_tool_use, which the OpenAI
// protocols cannot describe — a converting gateway drops the block and the search becomes
// invisible to the client even though it ran. Carrying it through as text survives that.
test("a server tool the relay ran is surfaced as text the client can see", async () => {
  const upstream = [
    'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5","usage":{"input_tokens":5}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srv_1","name":"web_search","input":{}}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"new songs\\"}"}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Two new songs."}}\n\n',
    'data: {"type":"content_block_stop","index":1}\n\n',
    'data: {"type":"message_stop"}\n\n'
  ].join("");
  const fixture = gatewayFixture(async () => new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }));

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Server tool surface test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-opus-5", max_tokens: 4096, stream: true,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: "What is new?" }]
      })
    });
    const body = await response.text();
    // Every frame still parses, and the block kept its index — only its type changed.
    for (const line of body.split("\n").filter((entry) => entry.startsWith("data:"))) {
      JSON.parse(line.slice(5).trim());
    }
    assert.match(body, /"type":"text","text":"🔍 web_search /, "the call is carried through as text");
    assert.match(body, /"type":"text_delta","text":"\{\\"query/, "its input becomes that text");
    assert.doesNotMatch(body, /"content_block":\{"type":"server_tool_use"/, "nothing downstream can read that type");
    assert.match(body, /Two new songs\./, "the answer itself is untouched");
  } finally {
    fixture.close();
  }
});

test("a caller's own thinking choice is never overridden on Anthropic Messages", async () => {
  const seen = [];
  const fixture = gatewayFixture(async (url, options) => {
    seen.push(JSON.parse(options.body).thinking);
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  }, { defaultReasoningEffort: "medium" });

  const sent = [
    { type: "disabled" },
    { type: "adaptive" },
    { type: "enabled", budget_tokens: 4096 }
  ];

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Explicit thinking test").key;
    await fixture.start();
    for (const thinking of sent) {
      const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-opus-5", max_tokens: 16_000, thinking, messages: [{ role: "user", content: "Hello" }] })
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(seen, sent, "an explicit choice — including disabled — must survive untouched");
  } finally {
    fixture.close();
  }
});

test("the thinking default stays off for short turns, non-claude models, and MIRASIM_DEFAULT_REASONING_EFFORT=none", async () => {
  const seen = [];
  const fixture = gatewayFixture(async (url, options) => {
    seen.push(JSON.parse(options.body).thinking);
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  }, { defaultReasoningEffort: "medium" });

  const offFixture = gatewayFixture(async (url, options) => {
    seen.push(JSON.parse(options.body).thinking);
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  }, { defaultReasoningEffort: "none" });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Thinking default off test").key;
    await fixture.start();
    // A title or classification call has no room for thinking and an answer both.
    await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-opus-5", max_tokens: 64, messages: [{ role: "user", content: "Title this." }] })
    });

    const offKey = new OpenAIKeyStore(offFixture.apiKeyFile).create("Effort none test").key;
    await offFixture.start();
    await fetch(`${offFixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": offKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-opus-5", max_tokens: 16_000, messages: [{ role: "user", content: "Hello" }] })
    });

    assert.deepEqual(seen, [undefined, undefined]);
  } finally {
    fixture.close();
    offFixture.close();
  }
});

test("Anthropic Messages carrying the caller's own cache breakpoints are left alone", async () => {
  const system = [{ type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: { type: "ephemeral" } }];
  const messages = [
    { role: "user", content: [{ type: "text", text: "First." }] },
    { role: "assistant", content: [{ type: "text", text: "Ack." }] },
    { role: "user", content: "Second." }
  ];
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    // The caller is managing its own four breakpoints; adding more would exceed the limit,
    // and rewriting the string shorthand would move bytes the caller cached against.
    assert.deepEqual(body.system, system);
    assert.deepEqual(body.messages, messages);
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Own breakpoints test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 16, system, messages })
    });
    assert.equal(response.status, 200);
  } finally {
    fixture.close();
  }
});

test("OpenAI chat completions with a claude model translate to upstream Anthropic Messages and back", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.href, "https://relay.example.test/v1/messages");
    assert.deepEqual(JSON.parse(options.body), {
      model: "claude-sonnet-5",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "text", text: "Reply exactly OK.", cache_control: { type: "ephemeral" } }] }],
      system: [{ type: "text", text: AGENT_IDENTITY }, { type: "text", text: "Be concise.", cache_control: { type: "ephemeral" } }]
      // No temperature: the relay validates sampling params against the exact values the
      // official client sends, so the caller's 0.5 is dropped rather than bounced as a 400.
    });
    return json({
      id: "msg_123",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 8, output_tokens: 1 }
    });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Claude chat test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 16,
        temperature: 0.5,
        messages: [{ role: "system", content: "Be concise." }, { role: "user", content: "Reply exactly OK." }]
      })
    });
    assert.equal(response.status, 200);
    const completion = await response.json();
    assert.equal(completion.id, "chatcmpl_msg_123");
    assert.equal(completion.object, "chat.completion");
    assert.equal(completion.model, "claude-sonnet-5");
    assert.deepEqual(completion.choices, [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }]);
    assert.deepEqual(completion.usage, { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 });
  } finally {
    fixture.close();
  }
});

test("claude chat completions streaming translates Anthropic SSE into chat completion chunks", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.href, "https://relay.example.test/v1/messages");
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","model":"claude-sonnet-5","usage":{"input_tokens":8}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Claude stream test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [{ role: "user", content: "Reply exactly OK." }] })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const body = await response.text();
    assert.match(body, /"object":"chat\.completion\.chunk"/);
    assert.match(body, /"delta":\{"role":"assistant","content":""\}/);
    assert.match(body, /"delta":\{"content":"OK"\}/);
    assert.match(body, /"finish_reason":"stop"/);
    assert.match(body, /"usage":\{"prompt_tokens":8,"completion_tokens":1,"total_tokens":9\}/);
    assert.match(body, /data: \[DONE\]/);
  } finally {
    fixture.close();
  }
});

test("claude chat completions translate Anthropic errors into OpenAI error format", async () => {
  const fixture = gatewayFixture(async () => new Response(
    JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens is too large." } }),
    { status: 400, headers: { "content-type": "application/json" } }
  ));

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Claude error test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { message: "max_tokens is too large.", type: "invalid_request_error", param: null, code: null }
    });
  } finally {
    fixture.close();
  }
});

test("claude tool calls round-trip between chat completions and Anthropic Messages", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.tools, [{
      name: "get_weather",
      description: "Get the weather.",
      input_schema: { type: "object", properties: { city: { type: "string" } } }
    }]);
    assert.deepEqual(body.messages.at(-1), {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Sunny", cache_control: { type: "ephemeral" } }]
    });
    assert.deepEqual(body.messages.at(-2), {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Tokyo" } }]
    });
    return json({
      id: "msg_tool",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "tool_use", id: "toolu_2", name: "get_weather", input: { city: "Osaka" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 5 }
    });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Claude tools test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        messages: [
          { role: "user", content: "Weather in Tokyo?" },
          { role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }] },
          { role: "tool", tool_call_id: "toolu_1", content: "Sunny" }
        ],
        tools: [{ type: "function", function: { name: "get_weather", description: "Get the weather.", parameters: { type: "object", properties: { city: { type: "string" } } } } }]
      })
    });
    assert.equal(response.status, 200);
    const completion = await response.json();
    assert.equal(completion.choices[0].finish_reason, "tool_calls");
    assert.deepEqual(completion.choices[0].message.tool_calls, [
      { id: "toolu_2", type: "function", function: { name: "get_weather", arguments: '{"city":"Osaka"}' } }
    ]);
  } finally {
    fixture.close();
  }
});

test("reasoning_effort maps to an Anthropic thinking budget and drops incompatible sampling params", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 16_384 });
    assert.equal(body.max_tokens, 17_408);
    assert.equal(body.temperature, undefined);
    assert.equal(body.top_p, undefined);
    return json({
      id: "msg_123",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [
        { type: "thinking", thinking: "Consider the question.", signature: "sig" },
        { type: "text", text: "OK" }
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 8, output_tokens: 40 }
    });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Thinking test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        reasoning_effort: "high",
        temperature: 0.7,
        top_p: 0.9,
        messages: [{ role: "user", content: "Reply exactly OK." }]
      })
    });
    assert.equal(response.status, 200);
    const completion = await response.json();
    assert.equal(completion.choices[0].message.content, "OK");
    assert.equal(completion.choices[0].message.reasoning_content, "Consider the question.");
  } finally {
    fixture.close();
  }
});

// Toggling `thinking` invalidates the whole message cache upstream, so the decision has to
// hold for the life of a conversation. A client whose tool-call ids this gateway never issued
// (a restart, or a converting gateway that mints its own) can never have its signed thinking
// restored, and deciding from the newest turn alone would switch thinking off on every tool
// round and back on for every plain answer.
test("a conversation whose thinking cannot be restored keeps thinking off instead of flipping", async () => {
  const budgets = [];
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    budgets.push(body.thinking?.budget_tokens ?? null);
    // A forced tool choice is dropped only while thinking is on, so it flips with it.
    assert.deepEqual(body.tool_choice, { type: "tool", name: "get_weather" });
    return json({
      id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5",
      content: [{ type: "text", text: "OK" }], stop_reason: "end_turn"
    });
  }, { defaultReasoningEffort: "medium" });

  const tools = [{ type: "function", function: { name: "get_weather", description: "Get the weather.", parameters: { type: "object", properties: {} } } }];
  // A tool round this gateway cannot restore thinking for, then a plain answer, then another
  // tool round — the alternation that used to flip `thinking` on every request.
  const toolRound = [
    { role: "assistant", content: null, tool_calls: [{ id: "foreign_1", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "foreign_1", content: "Sunny" }
  ];
  const histories = [
    [{ role: "user", content: "Weather?" }, ...toolRound],
    [{ role: "user", content: "Weather?" }, ...toolRound, { role: "assistant", content: "Sunny in Tokyo." }],
    [{ role: "user", content: "Weather?" }, ...toolRound, { role: "assistant", content: "Sunny in Tokyo." }, { role: "user", content: "And Osaka?" }, ...toolRound]
  ];

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Thinking stability test").key;
    await fixture.start();
    for (const messages of histories) {
      const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages, tools, tool_choice: { type: "function", function: { name: "get_weather" } } })
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(budgets, [null, null, null], "thinking must not switch back on mid-conversation");
  } finally {
    fixture.close();
  }
});

test("a conversation whose thinking is restored keeps thinking on across tool rounds", async () => {
  const budgets = [];
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    budgets.push(body.thinking?.budget_tokens ?? null);
    return json({
      id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5",
      content: [
        { type: "thinking", thinking: "Look it up.", signature: "sig" },
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} }
      ],
      stop_reason: "tool_use"
    });
  }, { defaultReasoningEffort: "medium" });

  const tools = [{ type: "function", function: { name: "get_weather", description: "Get the weather.", parameters: { type: "object", properties: {} } } }];

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Thinking replay test").key;
    await fixture.start();
    const messages = [{ role: "user", content: "Weather?" }];
    for (let turn = 0; turn < 3; turn += 1) {
      const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, messages, tools })
      });
      assert.equal(response.status, 200);
      const message = (await response.json()).choices[0].message;
      // The gateway issued these ids, so it can restore the signed thinking behind them.
      messages.push({ role: "assistant", content: message.content, tool_calls: message.tool_calls });
      messages.push({ role: "tool", tool_call_id: message.tool_calls[0].id, content: "Sunny" });
    }
    assert.deepEqual(budgets, [8192, 8192, 8192], "restored thinking must not switch off");
  } finally {
    fixture.close();
  }
});

test("a -thinking model suffix enables a medium thinking budget and strips the suffix upstream", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, "claude-sonnet-5");
    assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 8_192 });
    assert.equal(body.max_tokens, 9_216);
    return json({
      id: "msg_123", type: "message", role: "assistant", model: "claude-sonnet-5",
      content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 8, output_tokens: 1 }
    });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Thinking suffix test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-thinking", max_tokens: 512, messages: [{ role: "user", content: "Reply exactly OK." }] })
    });
    assert.equal(response.status, 200);
  } finally {
    fixture.close();
  }
});

test("streaming thinking deltas surface as reasoning_content chunks", async () => {
  const fixture = gatewayFixture(async () => new Response([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","model":"claude-sonnet-5","usage":{"input_tokens":8}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Hmm."}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"OK"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } }));

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Thinking stream test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", reasoning_effort: "low", stream: true, messages: [{ role: "user", content: "Reply exactly OK." }] })
    });
    const body = await response.text();
    assert.match(body, /"delta":\{"reasoning_content":"Hmm\."\}/);
    assert.match(body, /"delta":\{"content":"OK"\}/);
    assert.match(body, /"finish_reason":"stop"/);
  } finally {
    fixture.close();
  }
});

test("Responses reasoning effort feeds the Anthropic thinking budget and echoes back", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 2_048 });
    return json({
      id: "msg_123", type: "message", role: "assistant", model: "claude-sonnet-5",
      content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 8, output_tokens: 1 }
    });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Responses reasoning test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", reasoning: { effort: "low" }, input: "Reply exactly OK." })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.reasoning, { effort: "low", summary: null });
  } finally {
    fixture.close();
  }
});

test("Responses requests with a claude model translate through Anthropic Messages", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.href, "https://relay.example.test/v1/messages");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "claude-sonnet-5");
    assert.deepEqual(body.system, [{ type: "text", text: AGENT_IDENTITY }, { type: "text", text: "Be concise.", cache_control: { type: "ephemeral" } }]);
    return json({
      id: "msg_123",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 8, output_tokens: 1 }
    });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Claude responses test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", instructions: "Be concise.", input: "Reply exactly OK." })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.object, "response");
    assert.equal(result.status, "completed");
    assert.equal(result.output[0].content[0].text, "OK");
    assert.deepEqual(result.usage, { input_tokens: 8, output_tokens: 1, total_tokens: 9 });
  } finally {
    fixture.close();
  }
});

// The relay serves GPT models only on its native Codex endpoint — /v1/chat/completions
// answers 404 for them — and a Responses request is already in that endpoint's wire format,
// so it is passed through untouched rather than translated. That is also what keeps
// prompt_cache_key and the Codex identity intact, which is what the upstream cache keys on.
test("Responses requests for a GPT model pass through to the Codex endpoint untouched", async () => {
  const responsesPayload = {
    id: "resp_123",
    object: "response",
    created_at: 1_725_000_000,
    status: "completed",
    model: "gpt-4o-mini",
    output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "OK", annotations: [] }] }],
    usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 }
  };
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.href, "https://relay.example.test/backend-api/codex/responses");
    assert.deepEqual(JSON.parse(options.body), {
      model: "gpt-4o-mini",
      instructions: "Be concise.",
      input: "Reply exactly OK.",
      max_output_tokens: 1
    });
    return json(responsesPayload);
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Responses test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", instructions: "Be concise.", input: "Reply exactly OK.", max_output_tokens: 1 })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), responsesPayload);
  } finally {
    fixture.close();
  }
});

test("Responses streaming for a GPT model forwards the Codex SSE stream verbatim", async () => {
  // The upstream already speaks the Responses event vocabulary, so the stream is relayed
  // rather than rebuilt — including its content-type.
  const upstreamStream = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_123"}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_123"}}\n\n'
  ].join("");
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.href, "https://relay.example.test/backend-api/codex/responses");
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response(upstreamStream, { status: 200, headers: { "content-type": "text/event-stream" } });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Response stream test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", input: "Reply exactly OK.", stream: true })
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), upstreamStream);
  } finally {
    fixture.close();
  }
});

test("upstream first-byte timeout returns 504 promptly", async () => {
  const fixture = gatewayFixture((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }), { firstByteTimeoutMs: 20 });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Timeout test").key;
    await fixture.start();
    const started = Date.now();
    const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.type, "server_error");
    assert.ok(Date.now() - started < 1_000);
  } finally {
    fixture.close();
  }
});

test("permission-denied model requests retry the next logged-in account without cooling the first", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-permission-retry-"));
  const firstHome = join(root, "account-a");
  const secondHome = join(root, "account-b");
  const apiKeyFile = join(root, "api-keys.json");
  mkdirSync(firstHome, { recursive: true });
  mkdirSync(secondHome, { recursive: true });
  writeFileSync(join(firstHome, "setting.json"), JSON.stringify({ auth: { userId: "account-a", token: "token-a", exp: 4_102_444_800 } }));
  writeFileSync(join(secondHome, "setting.json"), JSON.stringify({ auth: { userId: "account-b", token: "token-b", exp: 4_102_444_800 } }));
  const attempts = [];
  const server = createGateway({
    host: "127.0.0.1", port: 0, homes: [firstHome, secondHome], apiKeyFile,
    relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test",
    webAuth: { username: "console", password: "correct-password", secureCookie: false },
    models: [], timeoutMs: 30_000, cooldownMs: 30_000
  }, {
    fetchImpl: async (url, options) => {
      attempts.push(options.headers.Authorization);
      return options.headers.Authorization === "Bearer token-a"
        ? new Response(JSON.stringify({ error: { message: "This request was not authorized." } }), { status: 403, headers: { "content-type": "application/json" } })
        : json({ choices: [{ message: { content: "OK" } }] });
    },
    logger: { error() {} }
  });

  try {
    const { key } = new OpenAIKeyStore(apiKeyFile).create("Permission retry test");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3", messages: [{ role: "user", content: "OK" }] })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-b"]);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("timeout defaults keep streams responsive while bounding model discovery", () => {
  const config = loadConfig({ MIRASIM_HOME: "/tmp/mirasim-test", WEB_AUTH_PASSWORD: "password" });
  assert.equal(config.timeoutMs, 300_000);
  assert.equal(config.firstByteTimeoutMs, 45_000);
  assert.equal(config.modelListTimeoutMs, 10_000);
  assert.equal(config.modelHealthIntervalMs, 1_800_000);
  assert.equal(config.modelHealthTimeoutMs, 12_000);
  assert.equal(config.loginUrl, "https://auth.mirasim.ai");
});

function gatewayFixture(fetchImpl, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-protocols-"));
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

// Where a request marks its cache breakpoints, as positions that can be compared between
// two turns of the same conversation.
function cacheBreakpointsOf(body) {
  const marks = [];
  (Array.isArray(body.system) ? body.system : []).forEach((block, index) => {
    if (block?.cache_control) marks.push(`system[${index}]`);
  });
  body.messages.forEach((message, index) => {
    (Array.isArray(message.content) ? message.content : []).forEach((block, block_index) => {
      if (block?.cache_control) marks.push(`messages[${index}][${block_index}]`);
    });
  });
  return marks;
}

// The breakpoints move from turn to turn by design; the prefix they cache must not.
function withoutCacheControl(value) {
  return JSON.parse(JSON.stringify(value, (key, entry) => key === "cache_control" ? undefined : entry));
}
