import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/server.js";

test("reasoning passthrough is the default with an explicit managed rollback", () => {
  const env = { MIRASIM_HOME: "/tmp/mirasim-reasoning-config", WEB_AUTH_PASSWORD: "password" };
  assert.equal(loadConfig(env).reasoningMode, "passthrough");
  assert.equal(loadConfig({ ...env, MIRASIM_REASONING_MODE: "managed" }).reasoningMode, "managed");
  assert.throws(() => loadConfig({ ...env, MIRASIM_REASONING_MODE: "invalid" }), /MIRASIM_REASONING_MODE/);
});

const nativeCases = [
  ...["low", "medium", "high", "xhigh", "max"].map((effort) => ["/v1/messages", "claude-opus-4-6", {
    thinking: { type: "adaptive" }, output_config: { effort, format: { type: "text" } }
  }]),
  ...["low", "medium", "xhigh", "max", "future-effort"].map((effort) => ["/v1/responses", "gpt-5.6-sol", { reasoning: { effort } }]),
  ["/v1/messages", "claude-opus-4-6", { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high", format: { type: "text" } } }],
  ["/v1/messages", "claude-haiku-4-5", { thinking: { type: "enabled", budget_tokens: 4096 } }],
  ["/v1/messages", "claude-opus-4-6", { thinking: { type: "disabled" } }],
  ["/v1/messages", "claude-opus-4-6", {}],
  ["/v1/responses", "gpt-5.6-sol", { reasoning: { effort: "high", summary: "auto" } }],
  ["/v1/responses", "gpt-5.6-sol", { reasoning: { effort: "high", summary: null } }],
  ["/v1/responses", "gpt-5.6-sol", { reasoning: { effort: "none" } }],
  ["/v1/responses", "gpt-5.6-sol", {}],
  ["/v1/chat/completions", "kimi-k3", { reasoning_effort: "high", thinking: { type: "enabled" } }],
  ["/v1/chat/completions", "kimi-k3", { thinking: { type: "disabled" } }],
  ["/v1/chat/completions", "kimi-k3", {}],
  ["/v1/chat/completions", "deepseek-v4", { reasoning_effort: "low", thinking: { type: "enabled" } }]
];

for (const mode of ["passthrough", "managed"]) {
  test(`Astra maps disabled reasoning to its minimum supported effort in ${mode} mode`, async () => {
    const fixture = await gatewayFixture(null, { reasoningMode: mode });
    try {
      const response = await fixture.ask("/v1/responses", "gpt-6-astra", { reasoning: { effort: "none", summary: null } });
      await response.text();
      assert.deepEqual(fixture.sent[0].body.reasoning, { effort: "low", summary: null });
      const [entry] = await fixture.logs();
      assert.equal(entry.reasoningEffort, "none");
      assert.equal(entry.thinkingLevel, "low");
    } finally { await fixture.close(); }
  });
}

test("native parameter errors return 400 without retrying accounts", async () => {
  const fixture = await gatewayFixture(() => new Response(`data: ${JSON.stringify({ type: "error", error: { type: "invalid_request_error", code: "unsupported_value", message: "Unsupported reasoning effort", param: "reasoning.effort" }, status: 400 }, null, 2)}\n\n`, { headers: { "content-type": "text/event-stream" } }));
  try {
    const response = await fixture.ask("/v1/responses", "gpt-5.6-sol", { reasoning: { effort: "invalid" } });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, "unsupported_value");
    assert.equal(payload.error.param, "reasoning.effort");
    assert.equal(fixture.sent.length, 1);
  } finally { await fixture.close(); }
});

test("managed reasoning configuration accepts ultra as max", () => {
  for (const name of ["MIRASIM_DEFAULT_REASONING_EFFORT", "MIRASIM_MIN_REASONING_EFFORT"]) {
    const key = name.includes("DEFAULT") ? "defaultReasoningEffort" : "minReasoningEffort";
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", " Ultra "]) {
      const config = loadConfig({ [name]: effort });
      assert.equal(config[key], effort.trim().toLowerCase() === "ultra" ? "max" : effort);
    }
    assert.throws(() => loadConfig({ [name]: "invalid" }), new RegExp(name));
  }
});

test("managed reasoning configuration distinguishes ultracode from ultra", () => {
  const config = loadConfig({ MIRASIM_DEFAULT_REASONING_EFFORT: " Ultracode ", MIRASIM_MIN_REASONING_EFFORT: "ultracode" });
  assert.equal(config.defaultReasoningEffort, "xhigh");
  assert.equal(config.minReasoningEffort, "xhigh");
});

for (const mode of ["passthrough", "managed"]) {
  for (const effort of ["ultracode", " Ultracode "]) {
    test(`Claude Code session mode maps to xhigh: ${mode} ${effort}`, async () => {
      const fixture = await gatewayFixture(null, { reasoningMode: mode, minReasoningEffort: "none" });
      try {
        const response = await fixture.ask("/v1/messages", "claude-opus-4-6", {
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort, format: { type: "text" } }
        });
        assert.equal(response.status, 200);
        await response.text();
        assert.deepEqual(fixture.sent[0].body.output_config, { effort: "xhigh", format: { type: "text" } });
        assert.deepEqual(fixture.sent[0].body.thinking, { type: "adaptive", display: "summarized" });
        const entry = (await fixture.logs())[0];
        assert.equal(entry.reasoningEffort, "ultracode");
        assert.equal(entry.thinkingLevel, "xhigh");
      } finally {
        await fixture.close();
      }
    });
  }
}

for (const mode of ["passthrough", "managed"]) {
  for (const [path, fields] of [
    ["/v1/responses", { reasoning: { effort: "ultra", summary: null } }],
    ["/v1/responses", { reasoning: { effort: " Ultra ", summary: "detailed" } }],
    ["/v1/chat/completions", { reasoning_effort: "ultra" }],
    ["/v1/messages", { thinking: { type: "adaptive" }, output_config: { effort: "ultra" } }]
  ]) {
    test(`Codex ultra maps to max with original effort logged: ${mode} ${path} ${JSON.stringify(fields)}`, async () => {
      const fixture = await gatewayFixture(() => new Response([
        { type: "response.created", response: { id: "resp-ultra", model: "gpt-5.6-sol" } },
        { type: "response.output_text.delta", delta: "OK" },
        { type: "response.completed", response: { id: "resp-ultra", status: "completed", output: [] } }
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" }
      }), { reasoningMode: mode });
      try {
        const response = await fixture.ask(path, "gpt-5.6-sol", fields);
        assert.equal(response.status, 200);
        await response.text();
        assert.equal(fixture.sent[0].body.reasoning.effort, "max");
        if (fields.reasoning) assert.equal(fixture.sent[0].body.reasoning.summary, fields.reasoning.summary);
        const entry = (await fixture.logs())[0];
        assert.equal(entry.reasoningEffort, "ultra");
        assert.equal(entry.thinkingLevel, "max");
      } finally {
        await fixture.close();
      }
    });
  }
}

for (const [path, model, fields] of nativeCases) {
  test(`native reasoning survives default and floor settings: ${model} ${JSON.stringify(fields)}`, async () => {
    const fixture = await gatewayFixture();
    try {
      const response = await fixture.ask(path, model, fields);
      assert.equal(response.status, 200);
      await response.text();
      const sent = fixture.sent.at(-1).body;
      const expected = model.startsWith("gpt-") && fields.reasoning?.effort !== "none"
        ? { ...fields, reasoning: { summary: "auto", ...fields.reasoning } } : fields;
      for (const key of ["reasoning", "reasoning_effort", "thinking", "output_config"]) assert.deepEqual(sent[key], expected[key]);
    } finally {
      await fixture.close();
    }
  });
}

for (const [path, model, fields, expected] of [
  ["/v1/messages", "kimi-code/k3", { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } }, { effort: "high", thinking: { type: "enabled" } }],
  ["/v1/responses", "kimi-k3", { reasoning: { effort: "xhigh" } }, { effort: "xhigh", thinking: undefined }],
  ["/v1/responses", "deepseek-v4", { reasoning: { effort: "high" } }, { effort: "high", thinking: undefined }],
  ["/v1/messages", "kimi-k3", { thinking: { type: "disabled" }, output_config: { effort: "high" } }, { effort: "none", thinking: { type: "disabled" } }]
]) {
  test(`bridged reasoning reaches the chat upstream: ${path} ${model} ${expected.effort}`, async () => {
    const fixture = await gatewayFixture();
    try {
      const response = await fixture.ask(path, model, fields);
      assert.equal(response.status, 200);
      await response.text();
      const sent = fixture.sent.at(-1);
      assert.equal(sent.path, "/v1/chat/completions");
      assert.equal(sent.body.reasoning_effort, expected.effort);
      assert.deepEqual(sent.body.thinking, expected.thinking);
      assert.equal(sent.body.output_config, undefined);
      assert.equal(sent.body.reasoning, undefined);
      const entry = (await fixture.logs())[0];
      assert.equal(entry.thinkingLevel, expected.effort === "none" ? "off" : expected.effort);
    } finally {
      await fixture.close();
    }
  });
}

test("bridged Claude reasoning keeps the requested rung despite a max floor and unsigned tool history", async () => {
  const fixture = await gatewayFixture();
  try {
    const response = await fixture.ask("/v1/chat/completions", "claude-opus-4-6", {
      reasoning_effort: "high",
      messages: [
        { role: "user", content: "Read it" },
        { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call-1", content: "file contents" }
      ]
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(fixture.sent[0].body.output_config.effort, "high");
    assert.equal(fixture.sent[0].body.thinking.type, "adaptive");
  } finally {
    await fixture.close();
  }
});

test("bridged explicit none is not replaced by the default or max floor", async () => {
  const fixture = await gatewayFixture();
  try {
    const response = await fixture.ask("/v1/responses", "claude-opus-4-6", { reasoning: { effort: "none" } });
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(fixture.sent[0].body.thinking, { type: "disabled" });
    assert.equal(fixture.sent[0].body.output_config, undefined);
  } finally {
    await fixture.close();
  }
});

test("unknown upstream thinking is not logged as off", async () => {
  const fixture = await gatewayFixture();
  try {
    await (await fixture.ask("/v1/messages", "kimi-k3", {})).text();
    const entry = (await fixture.logs())[0];
    assert.equal(entry.reasoningEffort, null);
    assert.equal(entry.thinkingLevel, null);
  } finally {
    await fixture.close();
  }
});

test("Responses reasoning summaries stay attached to replayed Kimi tool calls", async () => {
  const fixture = await gatewayFixture();
  try {
    const response = await fixture.ask("/v1/responses", "kimi-k3", {
      reasoning: { effort: "high" },
      input: [
        { role: "user", content: "Read" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "先读文件。" }] },
        { type: "function_call", call_id: "call-read", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "call-read", output: "file" }
      ]
    });
    assert.equal(response.status, 200);
    await response.text();
    const assistant = fixture.sent[0].body.messages.find((message) => message.role === "assistant");
    assert.equal(assistant.reasoning_content, "先读文件。");
    assert.equal(assistant.tool_calls[0].id, "call-read");
  } finally {
    await fixture.close();
  }
});

test("an unconvertible effort for a budget-based Claude model fails explicitly", async () => {
  const fixture = await gatewayFixture();
  try {
    const response = await fixture.ask("/v1/chat/completions", "claude-haiku-4-5", { reasoning_effort: "future-level" });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Use thinking.budget_tokens explicitly/);
    assert.equal(fixture.sent.length, 0);
  } finally {
    await fixture.close();
  }
});

test("Kimi JSON thinking and tool history round-trip without fabricated signatures", async () => {
  const fixture = await gatewayFixture(() => json({
    id: "chat-thinking", choices: [{ message: { content: null, reasoning_content: "先检查文件。", tool_calls: [{ id: "call-read", function: { name: "read", arguments: "{}" } }] }, finish_reason: "tool_calls" }]
  }));
  try {
    const response = await fixture.ask("/v1/messages", "kimi-k3", { stream: false, output_config: { effort: "high" } });
    const body = await response.json();
    assert.deepEqual(body.content[0], { type: "thinking", thinking: "先检查文件。" });
    const next = await fixture.ask("/v1/messages", "kimi-k3", {
      stream: false,
      messages: [{ role: "user", content: "Read" }, { role: "assistant", content: body.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call-read", content: "file" }] }]
    });
    await next.text();
    const assistant = fixture.sent[1].body.messages.find((message) => message.role === "assistant");
    assert.equal(assistant.reasoning_content, "先检查文件。");
    assert.equal(assistant.tool_calls[0].id, "call-read");
    assert.equal(assistant.signature, undefined);
  } finally {
    await fixture.close();
  }
});

for (const path of ["/v1/messages", "/v1/responses"]) {
  test(`Kimi SSE thinking survives fragmented UTF-8 through ${path}`, async () => {
    const wire = [
      { choices: [{ delta: { reasoning_content: "先思考。" } }] },
      { choices: [{ delta: { content: "答案" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    const fixture = await gatewayFixture(() => new Response(new ReadableStream({
      start(controller) {
        for (const byte of new TextEncoder().encode(wire)) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      }
    }), { headers: { "content-type": "text/event-stream" } }));
    try {
      const response = await fixture.ask(path, "kimi-k3", {});
      const events = (await response.text()).split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5)));
      if (path === "/v1/responses") {
        assert.equal(events.find((event) => event.type === "response.reasoning_summary_text.delta").delta, "先思考。");
        assert.equal(events.find((event) => event.type === "response.output_text.delta").delta, "答案");
        assert.equal(events.at(-1).type, "response.completed");
        return;
      }
      assert.equal(events.find((event) => event.delta?.type === "thinking_delta").delta.thinking, "先思考。");
      assert.equal(events.find((event) => event.delta?.type === "text_delta").delta.text, "答案");
      assert.deepEqual(events.filter((event) => event.type === "content_block_start").map((event) => event.content_block.type), ["thinking", "text"]);
      assert.equal(events.filter((event) => event.type === "content_block_stop").length, 2);
      assert.equal(events.at(-1).type, "message_stop");
      assert.ok(!events.some((event) => event.delta?.type === "signature_delta"));
    } finally {
      await fixture.close();
    }
  });
}

async function gatewayFixture(respond = null, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-reasoning-"));
  const home = join(root, "account");
  mkdirSync(home);
  writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: "user", token: "token", exp: 4_102_444_800 } }));
  const config = loadConfig({ MIRASIM_HOME: root, MIRASIM_HOMES: home, MIRASIM_RELAY_URL: "https://relay.example.test", WEB_AUTH_PASSWORD: "password", MIRASIM_DEFAULT_REASONING_EFFORT: "medium", MIRASIM_MIN_REASONING_EFFORT: "max" });
  Object.assign(config, overrides);
  const sent = [];
  const server = createGateway(config, {
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      sent.push({ path: url.pathname, body });
      if (respond) return respond(url, options);
      return json(url.pathname === "/v1/messages"
        ? { id: "msg-1", type: "message", model: body.model, role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
        : { id: "chat-1", model: body.model, choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
    },
    logger: { error() {} }
  });
  const { key } = new OpenAIKeyStore(config.databaseFile).create("Reasoning regression");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    sent,
    ask(path, model, fields) {
      return fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${key}`, "x-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ model, stream: true, max_tokens: 8192, ...(path.endsWith("/responses") ? { input: "Hello" } : { messages: [{ role: "user", content: "Hello" }] }), ...fields }) });
    },
    async logs() {
      const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "password" }) });
      const cookie = login.headers.get("set-cookie").split(";")[0];
      await login.text();
      return (await (await fetch(base + "/api/usage-log", { headers: { Cookie: cookie } })).json()).entries;
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

for (const model of ["deepseek-v4-pro", "gpt-5.6-sol"]) {
  for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses", "/backend-api/codex/responses"]) {
    for (const stream of [false, true]) {
      test(`${model} isolates reasoning through ${path} stream=${stream}`, async () => {
        const fixture = await gatewayFixture((url) => {
          if (model.startsWith("deepseek")) {
            assert.equal(url.pathname, "/v1/chat/completions");
            const chunks = [
              { choices: [{ index: 0, delta: { content: "<th" } }] },
              { choices: [{ index: 0, delta: { content: "ink>秘密思考</thi" } }] },
              { choices: [{ index: 0, delta: { content: "nk>最终答案" }, finish_reason: "stop" }] }
            ];
            return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
          }
          assert.equal(url.pathname, "/v1/responses");
          return new Response([
            { type: "response.reasoning_summary_text.delta", item_id: "rs", output_index: 0, summary_index: 0, delta: "秘密思考" },
            { type: "response.output_text.delta", item_id: "msg", output_index: 1, content_index: 0, delta: "最终答案" },
            { type: "response.completed", response: { id: "resp", output: [] } }
          ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
        });
        try {
          const response = await fixture.ask(path, model, { stream });
          assert.equal(response.status, 200);
          let answer = "";
          let reasoning = "";
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
          assert.equal(answer, "最终答案");
          assert.equal(reasoning, "秘密思考");
        } finally { await fixture.close(); }
      });
    }
  }
}

for (const model of ["deepseek-v4-pro", "gpt-5.6-sol"]) {
  for (const mode of ["passthrough", "managed"]) {
    for (const [fields, expected] of [
      [{ thinking: { type: "enabled", budget_tokens: 16384 } }, mode === "managed" ? "max" : "high"],
      [{ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "ultra" } }, "max"],
      [{ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "ultracode" } }, mode === "managed" ? "max" : "xhigh"],
      [{ thinking: { type: "disabled" }, reasoning: { effort: "high" } }, "none"]
    ]) {
      test(`${model} ${mode} maps Messages thinking ${JSON.stringify(fields)}`, async () => {
        const fixture = await gatewayFixture(null, { reasoningMode: mode });
        try {
          await (await fixture.ask("/v1/messages", model, fields)).text();
          const body = fixture.sent[0].body;
          assert.equal(model.startsWith("deepseek") ? body.reasoning_effort : body.reasoning.effort, expected);
          if (model.startsWith("deepseek")) {
            assert.deepEqual(body.thinking, { type: expected === "none" ? "disabled" : "enabled" });
            assert.equal(body.output_config, undefined);
            assert.equal(body.reasoning, undefined);
          }
        } finally { await fixture.close(); }
      });
    }
  }
}
