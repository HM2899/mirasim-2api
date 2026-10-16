import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/server.js";

const AGENT_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

test("a custom upstream keeps its own beta header policy and query parameters", async () => {
  const beta = "oauth-2025-04-20,interleaved-thinking-2025-05-14";
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.href, "https://relay.example.test/v1/messages?beta=true");
    assert.equal(options.headers["anthropic-beta"], beta);
    assert.equal(JSON.parse(options.body).temperature, 1);
    return json({ type: "message", content: [] });
  });
  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Custom beta test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json", "anthropic-beta": beta },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 16, temperature: 1, messages: [{ role: "user", content: "Hi" }] })
    });
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    fixture.close();
  }
});

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
      stream: true,
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
      { type: "text", text: AGENT_IDENTITY, cache_control: { type: "ephemeral" } },
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

test("Anthropic Messages from Claude Code forwards its system blocks with their texts unchanged", async () => {
  const claudeCodeSystem = [
    { type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: { type: "ephemeral" } },
    { type: "text", text: "# Environment" }
  ];
  const fixture = gatewayFixture(async (url, options) => {
    // The caller's own marker stays where it was put; the unmarked last block gets one of the
    // spare slots, so the whole static prefix — not just the identity line — has a breakpoint.
    assert.deepEqual(JSON.parse(options.body).system, [
      claudeCodeSystem[0],
      { type: "text", text: "# Environment", cache_control: { type: "ephemeral" } }
    ]);
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

// Claude Code manages its own breakpoints and marks only its newest user turn, so the
// history reads depend on the upstream walking back from that mark to a previous one. An
// upstream that does no such lookback reads the static prefix on every turn and nothing
// else — cache_read_input_tokens flatlines — so the gateway spends the spare slots on the
// recent unmarked user turns, and the previous turn's mark is the one this turn can read.
test("caller breakpoints that mark only the newest turn still read the history across turns", async () => {
  const sent = [];
  const fixture = gatewayFixture(async (url, options) => {
    sent.push(JSON.parse(options.body));
    return json({
      id: `msg_${sent.length}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: `answer ${sent.length}` }],
      stop_reason: "end_turn",
      usage: { input_tokens: 8, output_tokens: 1 }
    });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Caller breakpoints test").key;
    await fixture.start();
    const messages = [];
    for (let turn = 0; turn < 4; turn += 1) {
      messages.push({ role: "user", content: `question ${turn}` });
      const body = structuredClone(messages);
      // The caller's own mark: only the newest user turn, with a one-hour TTL. Older turns
      // go back to the string shorthand, the flip a client that rebuilds its history produces.
      const newest = body.at(-1);
      newest.content = [{ type: "text", text: newest.content, cache_control: { type: "ephemeral", ttl: "1h" } }];
      const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16, system: CLAUDE_CODE_IDENTITY, messages: body })
      });
      assert.equal(response.status, 200);
      const message = await response.json();
      messages.push({ role: "assistant", content: message.content });
    }

    for (const body of sent) {
      assert.ok(cacheBreakpointsOf(body).length <= 4, "Anthropic rejects a fifth breakpoint");
      // The caller's own marker is never rewritten — its one-hour TTL is deliberate.
      assert.deepEqual(body.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral", ttl: "1h" });
    }

    for (let turn = 1; turn < sent.length; turn += 1) {
      const previous = sent[turn - 1];
      const current = sent[turn];
      // The gateway's normalization, not the caller's shape, decides what the upstream sees:
      // a turn sent as a string after being sent as a marked block keeps the prefix stable.
      assert.deepEqual(withoutCacheControl(current.system), withoutCacheControl(previous.system));
      assert.deepEqual(
        withoutCacheControl(current.messages.slice(0, previous.messages.length)),
        withoutCacheControl(previous.messages)
      );
      // The overlap that turns a write into a read must reach the history, not stop at the
      // static prefix: the previous turn's newest-turn mark is still marked this turn.
      const carried = cacheBreakpointsOf(previous).filter((mark) => cacheBreakpointsOf(current).includes(mark));
      assert.ok(carried.some((mark) => mark.startsWith("messages[")), `turn ${turn + 1} reads only the static prefix`);
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
    // A current model is steered by a rung, not a budget, and returns no reasoning at all
    // unless a display is asked for.
    assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(body.output_config, { effort: "medium" });
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
    assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(body.output_config, { effort: "medium" });
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

// The budget an older model gets when the floor is xhigh.
const REASONING_BUDGET_XHIGH = 24_576;

test("a level the relay would refuse is restated as the nearest one it honours", async () => {
  const sent = [];
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    sent.push({ thinking: body.thinking, effort: body.output_config?.effort ?? null, hasOutputConfig: body.output_config !== undefined });
    return json({ id: "msg_1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  }, { defaultReasoningEffort: "medium" });

  const requests = [
    { model: "claude-opus-5", thinking: { type: "adaptive" }, output_config: { effort: "ultracode" } },
    // Case and padding are the client's, not the relay's.
    { model: "claude-opus-5", thinking: { type: "adaptive" }, output_config: { effort: "  MAX  " } },
    // A name nothing can place counts as unsaid, so the configured level applies rather than a
    // request the relay is certain to refuse.
    { model: "claude-opus-5", thinking: { type: "adaptive" }, output_config: { effort: "turbo" } },
    // Only `summarized` is served; `raw` is refused, and the caller wanted its reasoning shown.
    { model: "claude-opus-5", thinking: { type: "adaptive", display: "raw" }, output_config: { effort: "high" } },
    // An older model is refused outright for carrying a rung.
    { model: "claude-haiku-4-5", thinking: { type: "enabled", budget_tokens: 4096 }, output_config: { effort: "high" } },
    // ...and for being asked to think adaptively, so it gets the budget that level means.
    { model: "claude-haiku-4-5", thinking: { type: "adaptive" } }
  ];

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Rung normalisation test").key;
    await fixture.start();
    for (const body of requests) {
      const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ max_tokens: 16_000, messages: [{ role: "user", content: "Hello" }], ...body })
      });
      assert.equal(response.status, 200);
    }

    assert.deepEqual(sent, [
      { thinking: { type: "adaptive", display: "summarized" }, effort: "xhigh", hasOutputConfig: true },
      { thinking: { type: "adaptive", display: "summarized" }, effort: "max", hasOutputConfig: true },
      { thinking: { type: "adaptive", display: "summarized" }, effort: "medium", hasOutputConfig: true },
      { thinking: { type: "adaptive", display: "summarized" }, effort: "high", hasOutputConfig: true },
      { thinking: { type: "enabled", budget_tokens: 4096 }, effort: null, hasOutputConfig: false },
      { thinking: { type: "enabled", budget_tokens: 8192 }, effort: null, hasOutputConfig: false }
    ]);
  } finally {
    fixture.close();
  }
});

test("the effort floor lifts a level below it and leaves a higher one, and never turns thinking on", async () => {
  const sent = [];
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    sent.push({ thinking: body.thinking?.type ?? null, effort: body.output_config?.effort ?? null, budget: body.thinking?.budget_tokens ?? null });
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  }, { defaultReasoningEffort: "medium", minReasoningEffort: "xhigh" });

  const requests = [
    { model: "claude-opus-5", thinking: { type: "adaptive" }, output_config: { effort: "high" } },
    // Already above the floor — untouched, because a floor never lowers anything.
    { model: "claude-opus-5", thinking: { type: "adaptive" }, output_config: { effort: "max" } },
    // Thinking off is a choice about whether, not how hard, so the floor leaves it alone.
    { model: "claude-opus-5", thinking: { type: "disabled" } },
    // An older model has no rung, so the floor arrives as the budget that rung means.
    { model: "claude-haiku-4-5", thinking: { type: "enabled", budget_tokens: 2048 } }
  ];

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Effort floor test").key;
    await fixture.start();
    for (const body of requests) {
      const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ max_tokens: 16_000, messages: [{ role: "user", content: "Hello" }], ...body })
      });
      assert.equal(response.status, 200);
    }

    assert.deepEqual(sent, [
      { thinking: "adaptive", effort: "xhigh", budget: null },
      { thinking: "adaptive", effort: "max", budget: null },
      { thinking: "disabled", effort: null, budget: null },
      { thinking: "enabled", effort: null, budget: REASONING_BUDGET_XHIGH }
    ]);
  } finally {
    fixture.close();
  }
});

test("a caller's own thinking choice is never overridden on Anthropic Messages", async () => {
  const seen = [];
  const efforts = [];
  const fixture = gatewayFixture(async (url, options) => {
    const sentBody = JSON.parse(options.body);
    seen.push(sentBody.thinking);
    efforts.push(sentBody.output_config);
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  }, { defaultReasoningEffort: "medium" });

  const sent = [
    { type: "disabled" },
    { type: "adaptive" },
    { type: "enabled", budget_tokens: 4096 }
  ];
  // Two of these are silences rather than choices, and both are filled in. A bare `adaptive`
  // says thinking is on and nothing about how hard, so it gets the configured rung; a fixed
  // budget is a choice a current model answers 200 to and then ignores, so it is carried over
  // to the rung it was reaching for. Neither would otherwise return any reasoning at all,
  // which is what the display is for. `disabled` is a real choice and survives untouched.
  const expected = [
    { type: "disabled" },
    { type: "adaptive", display: "summarized" },
    { type: "adaptive", display: "summarized" }
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
    assert.deepEqual(seen, expected, "a real choice survives; a silence about the rung is filled in");
    // The rung reaches the model beside the adaptive type, never inside it.
    assert.deepEqual(efforts, [undefined, { effort: "medium" }, { effort: "low" }]);
  } finally {
    fixture.close();
  }
});

test("the thinking default stays off for short turns, non-claude models, and MIRASIM_DEFAULT_REASONING_EFFORT=none", async () => {
  const seen = [];
  const efforts = [];
  const fixture = gatewayFixture(async (url, options) => {
    const sentBody = JSON.parse(options.body);
    seen.push(sentBody.thinking);
    efforts.push(sentBody.output_config);
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

for (const ttl of [undefined, "1h"]) {
  test(`billing-first system preserves history cache breakpoints with TTL ${ttl || "default"}`, async () => {
    const sent = [];
    const cache = { type: "ephemeral", ...(ttl ? { ttl } : {}) };
    const system = [
      { type: "text", text: "x-anthropic-billing-header: synthetic stable header;" },
      { type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: cache },
      { type: "text", text: "Keep the project instructions stable.", cache_control: cache }
    ];
    const fixture = gatewayFixture(async (url, options) => {
      sent.push(JSON.parse(options.body));
      return json({ id: "msg_cache", type: "message", role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
    }, { reasoningMode: "passthrough" });
    try {
      const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Billing-first cache regression").key;
      await fixture.start();
      const messages = [];
      for (let turn = 0; turn < 4; turn += 1) {
        messages.push({ role: "user", content: [{ type: "text", text: `Question ${turn}` }] });
        const history = structuredClone(messages);
        history.at(-1).content.at(-1).cache_control = cache;
        const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": key },
          body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 16, system, messages: history })
        });
        assert.equal(response.status, 200);
        await response.json();
        const current = sent.at(-1);
        assert.equal(current.system[0].text, AGENT_IDENTITY);
        assert.equal(current.system[0].cache_control, undefined);
        assert.deepEqual(current.system.slice(1), system);
        assert.deepEqual(current.messages.at(-1).content.at(-1).cache_control, cache);
        assert.ok(cacheBreakpointsOf(current).length <= 4);
        if (sent.length > 1) {
          const previous = sent.at(-2);
          assert.deepEqual(withoutCacheControl(current.system), withoutCacheControl(previous.system));
          assert.deepEqual(withoutCacheControl(current.messages.slice(0, previous.messages.length)), withoutCacheControl(previous.messages));
          assert.ok(current.messages[previous.messages.length - 1].content.at(-1).cache_control);
        }
        messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
      }
    } finally {
      fixture.close();
    }
  });
}

test("Anthropic Messages carrying the caller's own cache breakpoints keep them and fill the spare slots", async () => {
  const system = [{ type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: { type: "ephemeral" } }];
  const messages = [
    { role: "user", content: [{ type: "text", text: "First." }] },
    { role: "assistant", content: [{ type: "text", text: "Ack." }] },
    { role: "user", content: "Second." }
  ];
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    // The caller's own breakpoint stays exactly where it was put. The slots it left spare go
    // on the most recent unmarked user turns — a caller that marks only the static prefix
    // would otherwise read none of the history on an upstream that does no lookback of its
    // own — and the string shorthand becomes blocks, the one shape the upstream ever sees.
    assert.deepEqual(body.system, system);
    assert.deepEqual(body.messages, [
      { role: "user", content: [{ type: "text", text: "First.", cache_control: { type: "ephemeral" } }] },
      { role: "assistant", content: [{ type: "text", text: "Ack." }] },
      { role: "user", content: [{ type: "text", text: "Second.", cache_control: { type: "ephemeral" } }] }
    ]);
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
      system: [{ type: "text", text: AGENT_IDENTITY, cache_control: { type: "ephemeral" } }, { type: "text", text: "Be concise.", cache_control: { type: "ephemeral" } }],
      // A non-streaming caller still gets a stream asked for upstream: the relay sends the
      // headers of a non-streaming answer only once all of it is generated.
      stream: true
      // No temperature: the relay validates sampling params against the exact values the
      // official client sends, so the caller's 0.5 is dropped rather than bounced as a 400.
    });
    assert.equal(options.headers.Accept, "text/event-stream");
    return new Response([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","model":"claude-sonnet-5","usage":{"input_tokens":8}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
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
    assert.match(response.headers.get("content-type"), /^application\/json/);
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

test("a non-streaming claude tool call is folded out of the upstream stream in the shape a JSON answer had", async () => {
  const events = [
    ["message_start", { message: { id: "msg_fold", model: "claude-sonnet-5", usage: { input_tokens: 20, cache_read_input_tokens: 100 } } }],
    ["content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
    ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Need the weather." } }],
    ["content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig" } }],
    ["content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_2", name: "get_weather", input: {} } }],
    ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "{\"city\":" } }],
    ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "\"Osaka\"}" } }],
    ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }],
    ["message_stop", {}]
  ];
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(""), {
      status: 200, headers: { "content-type": "text/event-stream" }
    });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Claude tool fold test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "Weather in Osaka?" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }]
      })
    });
    assert.equal(response.status, 200);
    const completion = await response.json();
    assert.equal(completion.id, "chatcmpl_msg_fold");
    assert.equal(completion.object, "chat.completion");
    assert.deepEqual(completion.choices, [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        reasoning_content: "Need the weather.",
        tool_calls: [{ id: "toolu_2", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Osaka\"}" } }]
      },
      finish_reason: "tool_calls"
    }]);
    assert.deepEqual(completion.usage, { prompt_tokens: 120, completion_tokens: 5, total_tokens: 125, prompt_tokens_details: { cached_tokens: 100 } });
  } finally {
    fixture.close();
  }
});

test("reasoning_effort becomes the rung an adaptive model is steered by, and drops incompatible sampling params", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    // Not a budget: a current model answers 200 to one and returns no reasoning at all.
    assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(body.output_config, { effort: "high" });
    assert.ok(body.max_tokens >= 2048, `max_tokens must leave room for thinking, got ${body.max_tokens}`);
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
  const efforts = [];
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    efforts.push(body.thinking ? body.output_config?.effort ?? body.thinking.budget_tokens : null);
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
    assert.deepEqual(efforts, [null, null, null], "thinking must not switch back on mid-conversation");
  } finally {
    fixture.close();
  }
});

test("a conversation whose thinking is restored keeps thinking on across tool rounds", async () => {
  const efforts = [];
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    efforts.push(body.thinking ? body.output_config?.effort ?? body.thinking.budget_tokens : null);
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
    assert.deepEqual(efforts, ["medium", "medium", "medium"], "restored thinking must not switch off");
  } finally {
    fixture.close();
  }
});

test("a -thinking model suffix enables medium thinking and strips the suffix upstream", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, "claude-sonnet-5");
    assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(body.output_config, { effort: "medium" });
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

test("Responses reasoning effort feeds the adaptive rung and echoes back", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(body.output_config, { effort: "low" });
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
    assert.deepEqual(body.system, [{ type: "text", text: AGENT_IDENTITY, cache_control: { type: "ephemeral" } }, { type: "text", text: "Be concise.", cache_control: { type: "ephemeral" } }]);
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
test("a Responses request for a GPT model is settled into the shape the relay accepts", async () => {
  // Measured against the live relay: it serves GPT models on /v1/responses (chat/completions
  // answers 404 naming that endpoint), requires store:false and stream:true, takes `input` only
  // as an array, and refuses max_output_tokens, temperature, top_p and metadata with a bare 400.
  const upstreamStream = [
    'data: {"type":"response.created","response":{"id":"resp_123"}}\n\n',
    'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[]}]}}\n\n',
    // The relay's own completed event arrives with an EMPTY output array — the items are only
    // ever announced as output_item.done, so a fold that trusts this envelope answers with nothing.
    'data: {"type":"response.completed","response":{"id":"resp_123","object":"response","status":"completed","model":"gpt-5.6-sol","output":[],"usage":{"input_tokens":8,"output_tokens":1,"total_tokens":9}}}\n\n'
  ].join("");
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.href, "https://relay.example.test/v1/responses");
    const { prompt_cache_key, ...body } = JSON.parse(options.body);
    assert.match(prompt_cache_key, /^[0-9a-f]{64}$/);
    assert.deepEqual(body, {
      model: "gpt-5.6-sol",
      instructions: "Be concise.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Reply exactly OK." }] }],
      include: ["reasoning.encrypted_content"],
      store: false,
      stream: true,
      reasoning: { effort: "high", summary: "auto" }
    });
    return new Response(upstreamStream, { status: 200, headers: { "content-type": "text/event-stream" } });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Responses test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol", instructions: "Be concise.", input: "Reply exactly OK.",
        reasoning: { effort: "high" },
        // Each of these is refused by the relay, and none of them is worth failing the turn over.
        max_output_tokens: 1, temperature: 0.7, metadata: { a: "b" }
      })
    });

    assert.equal(response.status, 200);
    // The caller asked for one object, so the stream it never wanted is folded back into one —
    // with the output items put back into the envelope that arrived without them.
    assert.deepEqual(await response.json(), {
      id: "resp_123", object: "response", status: "completed", model: "gpt-5.6-sol",
      store: true, previous_response_id: null,
      output: [{ id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "OK", annotations: [] }] }],
      usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 }
    });
  } finally {
    fixture.close();
  }
});

test("Responses streaming preserves deltas and repairs the terminal envelope", async () => {
  // Deltas remain intact; the terminal envelope reflects repaired status and local storage.
  const upstreamStream = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_123"}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_123"}}\n\n'
  ].join("");
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.href, "https://relay.example.test/v1/responses");
    const sent = JSON.parse(options.body);
    assert.equal(sent.stream, true);
    assert.equal(sent.store, false);
    return new Response(upstreamStream, { status: 200, headers: { "content-type": "text/event-stream" } });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Response stream test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "Reply exactly OK.", stream: true })
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), upstreamStream.replace(
      '"type":"response.completed","response":{"id":"resp_123"}',
      '"type":"response.completed","response":{"id":"resp_123","status":"completed","store":false,"previous_response_id":null}'
    ));
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

const clientDenialMessage = "this client is not supported; use the mirasim client or Claude Code";
const genericDenialMessage = "The upstream request failed with HTTP 403.";
const permissionDenials = [
  { name: "JSON", body: JSON.stringify({ error: { type: "permission_error", message: clientDenialMessage, code: "client_not_supported", param: "client" } }), contentType: "application/json", message: clientDenialMessage, code: "client_not_supported", param: "client" },
  { name: "plain text", body: clientDenialMessage, contentType: "text/plain; charset=utf-8", message: clientDenialMessage },
  ...["JSON", "plain text"].map(name => {
    const message = "Bearer fixture-secret sk-private sess-private\n" + "x".repeat(2000);
    return { name: `bounded and redacted ${name}`, body: name === "JSON" ? JSON.stringify({ error: { message } }) : message,
      contentType: name === "JSON" ? "application/json" : "text/plain", redacted: true };
  }),
  { name: "HTML", body: "<html><body>Bearer fixture-secret</body></html>", contentType: "text/html", message: genericDenialMessage },
  { name: "empty plain text", body: "", contentType: "text/plain", message: genericDenialMessage },
  { name: "whitespace plain text", body: "\r\n  \t", contentType: "text/plain", message: genericDenialMessage },
  { name: "unknown content type", body: clientDenialMessage, contentType: "application/octet-stream", message: genericDenialMessage },
  { name: "oversized plain text", body: "x".repeat(64 * 1024 + 1), contentType: "text/plain", message: genericDenialMessage }
];

for (const path of ["/v1/chat/completions", "/v1/responses"]) {
  for (const denial of permissionDenials) {
    test(`${path} preserves a ${denial.name} permission denial without switching accounts or cooling the first`, async () => {
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
            ? new Response(denial.body, { status: 403, headers: { "content-type": denial.contentType, "x-request-id": "upstream-denial-id", "request-id": "relay-denial-id" } })
            : json({ choices: [{ message: { content: "OK" } }] });
        },
        logger: { error() {} }
      });

      try {
        const { key } = new OpenAIKeyStore(apiKeyFile).create("Permission retry test");
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 32,
            ...(path === "/v1/responses" ? { input: "OK" } : { messages: [{ role: "user", content: "OK" }] }) })
        });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get("x-request-id"), "upstream-denial-id");
        assert.equal(response.headers.get("request-id"), "relay-denial-id");
        const { error } = await response.json();
        assert.equal(error.type, "permission_error");
        assert.equal(error.code, denial.code ?? null);
        assert.equal(error.param, denial.param ?? null);
        if (denial.redacted) {
          assert.equal(error.message.length, 1000);
          assert.doesNotMatch(error.message, /fixture-secret|sk-private|sess-private|[\u0000-\u001f]/);
          assert.match(error.message, /Bearer \[redacted\]/);
        } else {
          assert.equal(error.message, denial.message);
        }
        assert.deepEqual(attempts, ["Bearer token-a"]);
        const status = await (await fetch(`http://127.0.0.1:${server.address().port}/healthz`)).json();
        assert.equal(status.profiles.every(profile => profile.healthy), true);
      } finally {
        server.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("a 503 tries a few accounts, cools none of them, and still lets the next one serve the model", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-model-outage-"));
  const apiKeyFile = join(root, "api-keys.json");
  const homes = [];
  for (const id of ["a", "b", "c", "d", "e", "f"]) {
    const home = join(root, `account-${id}`);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: `account-${id}`, token: `token-${id}`, exp: 4_102_444_800 } }));
    homes.push(home);
  }
  const outage = JSON.stringify({
    type: "error",
    error: { type: "api_error", message: 'no upstream available for model "claude-fable-5"' },
    request_id: "9a06e5dc8a1b0c5288b59c481e9953af"
  });
  // The relay's capacity for a model varies between accounts, so one account's 503 says nothing
  // about the next: here only account-a is refused, and failover is what serves the request.
  let refuse = new Set(["Bearer token-a"]);
  const attempts = [];
  const server = createGateway({
    host: "127.0.0.1", port: 0, homes, apiKeyFile,
    relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test",
    webAuth: { username: "console", password: "correct-password", secureCookie: false },
    models: [], timeoutMs: 30_000, cooldownMs: 30_000
  }, {
    fetchImpl: async (url, options) => {
      attempts.push(options.headers.Authorization);
      return refuse.has(options.headers.Authorization)
        ? new Response(outage, { status: 503, headers: { "content-type": "application/json" } })
        : json({ id: "msg_1", type: "message", role: "assistant", model: "claude-fable-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
    },
    logger: { error() {} }
  });

  try {
    const { key } = new OpenAIKeyStore(apiKeyFile).create("Model outage test");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    const fable = async () => fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-fable-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] })
    });

    const served = await fable();
    assert.equal(served.status, 200);
    assert.equal((await served.json()).content[0].text, "OK");
    assert.deepEqual(attempts, ["Bearer token-a", "Bearer token-b"]);
    // The refused account keeps its place in the rotation: a 503 is the relay's fault, not its own.
    const pool = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(pool.profiles.filter((entry) => entry.cooldownUntil).length, 0);

    // Now the model is out everywhere. A handful of accounts confirm that; the rest of the pool
    // is not spent re-asking, and still none of them are cooled.
    refuse = new Set(homes.map((_, index) => `Bearer token-${"abcdef"[index]}`));
    attempts.length = 0;
    const unavailable = await fable();
    assert.equal(unavailable.status, 503);
    // The relay's own body reaches the client, request_id included, naming the model that is out.
    assert.deepEqual(await unavailable.json(), JSON.parse(outage));
    assert.equal(attempts.length, 3, `expected three attempts, got ${attempts.length}`);
    const after = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(after.profiles.filter((entry) => entry.cooldownUntil).length, 0);
    assert.equal(after.profiles.filter((entry) => entry.healthy).length, homes.length);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// The relay's own congestion is the one 5xx that three accounts cannot settle: it is a draw
// against the capacity that exists at that instant, so the next account really may be served
// where the last one was refused, and the three-attempt budget that is right for a model being
// out is what turns a survivable spell into a dead request.
test("a congestion 503 keeps failing over past the model-outage budget and is served by a later account", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-congestion-"));
  const apiKeyFile = join(root, "api-keys.json");
  const homes = [];
  const ids = Array.from({ length: 24 }, (_, index) => `a${index}`);
  for (const id of ids) {
    const home = join(root, `account-${id}`);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: `account-${id}`, token: `token-${id}`, exp: 4_102_444_800 } }));
    homes.push(home);
  }
  // Verbatim from the relay, which states in the message itself that the refusal costs the
  // account nothing — the reason it must not be read as the account's own fault.
  const congested = JSON.stringify({
    type: "error",
    error: {
      code: "model_capacity_exhausted",
      type: "overloaded_error",
      message: "claude-opus-5 当前可用容量已满，本次请求未被服务；这是云端的资源紧张，不计费、也不影响你的账号额度。"
    },
    request_id: "6b192d0150027b979eeaf8507aa6faac"
  });
  let refuse = () => true;
  const attempts = [];
  const server = createGateway({
    host: "127.0.0.1", port: 0, homes, apiKeyFile,
    relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test",
    webAuth: { username: "console", password: "correct-password", secureCookie: false },
    models: [], timeoutMs: 30_000, cooldownMs: 30_000
  }, {
    fetchImpl: async (url, options) => {
      attempts.push(options.headers.Authorization);
      return refuse(attempts.length)
        ? new Response(congested, { status: 503, headers: { "content-type": "application/json", "retry-after": "60" } })
        : json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
    },
    logger: { error() {} }
  });

  try {
    const { key } = new OpenAIKeyStore(apiKeyFile).create("Congestion test");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    const ask = async () => fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-opus-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] })
    });

    // Five accounts refused in a row — two past the budget a model outage gets — and the sixth
    // serves. Under the old cap this request was answered 503 on its third attempt.
    refuse = (attempt) => attempt <= 5;
    const served = await ask();
    assert.equal(served.status, 200);
    assert.equal((await served.json()).content[0].text, "OK");
    assert.equal(attempts.length, 6, `expected six attempts, got ${attempts.length}`);
    // Congestion is the relay's, so no account pays for it — the whole pool is still rotating.
    const pool = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(pool.profiles.filter((entry) => entry.cooldownUntil).length, 0);

    // A spell wide enough to refuse everything still terminates: the congestion cap stops it
    // well short of the 24 accounts available, and the relay's own words reach the caller.
    refuse = () => true;
    attempts.length = 0;
    const refused = await ask();
    assert.equal(refused.status, 503);
    assert.deepEqual(await refused.json(), JSON.parse(congested));
    assert.equal(attempts.length, 20, `expected the congestion cap of 20 attempts, got ${attempts.length}`);
    const after = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(after.profiles.filter((entry) => entry.cooldownUntil).length, 0);
    assert.equal(after.profiles.filter((entry) => entry.healthy).length, homes.length);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failover stops spending accounts once it has spent the caller's time budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-failover-budget-"));
  const apiKeyFile = join(root, "api-keys.json");
  const homes = [];
  for (const id of ["a", "b", "c", "d", "e"]) {
    const home = join(root, `account-${id}`);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: `account-${id}`, token: `token-${id}`, exp: 4_102_444_800 } }));
    homes.push(home);
  }
  const attempts = [];
  const server = createGateway({
    host: "127.0.0.1", port: 0, homes, apiKeyFile,
    relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test",
    webAuth: { username: "console", password: "correct-password", secureCookie: false },
    models: [], timeoutMs: 30_000, cooldownMs: 30_000,
    firstByteTimeoutMs: 200,
    failoverBudgetMs: 300
  }, {
    fetchImpl: async (url, options) => {
      attempts.push(options.headers.Authorization);
      await delay(120, undefined, { signal: options.signal });
      return new Response(JSON.stringify({ error: { message: "Rate limit reached. Please retry shortly." } }), {
        status: 429, headers: { "content-type": "application/json" }
      });
    },
    logger: { error() {} }
  });

  try {
    const { key } = new OpenAIKeyStore(apiKeyFile).create("Failover budget test");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal(response.status, 504);
    await response.text();
    assert.ok(attempts.length >= 2 && attempts.length < homes.length, `expected a bounded sweep, got ${attempts.length} of ${homes.length}`);
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
  assert.equal(config.failoverBudgetMs, 60_000);
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
