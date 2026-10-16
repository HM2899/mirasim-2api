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

test("Kimi header timeout has an independent default, override and hard cap", () => {
  const env = { MIRASIM_HOME: "/tmp/mirasim-timeout-config", WEB_AUTH_PASSWORD: "password" };
  assert.equal(loadConfig(env).kimiFirstByteTimeoutMs, 120_000);
  assert.equal(loadConfig({ ...env, MIRASIM_FIRST_BYTE_TIMEOUT_MS: "1000" }).kimiFirstByteTimeoutMs, 120_000);
  assert.equal(loadConfig({ ...env, MIRASIM_KIMI_FIRST_BYTE_TIMEOUT_MS: "180000" }).kimiFirstByteTimeoutMs, 180_000);
  assert.equal(loadConfig({ ...env, MIRASIM_TIMEOUT_MS: "60000" }).kimiFirstByteTimeoutMs, 60_000);
  assert.equal(loadConfig({ ...env, MIRASIM_KIMI_FIRST_BYTE_TIMEOUT_MS: "1000" }).modelListTimeoutMs, 10_000);
  assert.throws(() => loadConfig({ ...env, MIRASIM_KIMI_FIRST_BYTE_TIMEOUT_MS: "invalid" }), /MIRASIM_KIMI_FIRST_BYTE_TIMEOUT_MS/);
});

test("top-rung thinking header timeout has an independent default, override and hard cap", () => {
  const env = { MIRASIM_HOME: "/tmp/mirasim-timeout-config", WEB_AUTH_PASSWORD: "password" };
  assert.equal(loadConfig(env).thinkingFirstByteTimeoutMs, 120_000);
  assert.equal(loadConfig({ ...env, MIRASIM_FIRST_BYTE_TIMEOUT_MS: "1000" }).thinkingFirstByteTimeoutMs, 120_000);
  assert.equal(loadConfig({ ...env, MIRASIM_THINKING_FIRST_BYTE_TIMEOUT_MS: "180000" }).thinkingFirstByteTimeoutMs, 180_000);
  assert.equal(loadConfig({ ...env, MIRASIM_TIMEOUT_MS: "60000" }).thinkingFirstByteTimeoutMs, 60_000);
  assert.throws(() => loadConfig({ ...env, MIRASIM_THINKING_FIRST_BYTE_TIMEOUT_MS: "invalid" }), /MIRASIM_THINKING_FIRST_BYTE_TIMEOUT_MS/);
});

test("body idle and size limits have independent defaults and bounded overrides", () => {
  const env = { MIRASIM_HOME: "/tmp/mirasim-timeout-config", WEB_AUTH_PASSWORD: "password" };
  const defaults = loadConfig(env);
  assert.equal(defaults.maxRequestBytes, 16 * 1024 * 1024);
  assert.equal(loadConfig({ ...env, MIRASIM_MAX_REQUEST_BYTES: "1024" }).maxRequestBytes, 1024);
  assert.equal(loadConfig({ ...env, MIRASIM_MAX_REQUEST_BYTES: "999999999" }).maxRequestBytes, 64 * 1024 * 1024);
  assert.throws(() => loadConfig({ ...env, MIRASIM_MAX_REQUEST_BYTES: "bad" }), /MIRASIM_MAX_REQUEST_BYTES/);
  assert.equal(defaults.streamIdleTimeoutMs, 300_000);
  assert.equal(defaults.maxStreamBytes, 16 * 1024 * 1024);
  assert.equal(defaults.maxSseFrameBytes, 2 * 1024 * 1024);
  const overridden = loadConfig({ ...env, MIRASIM_STREAM_IDLE_TIMEOUT_MS: "2500", MIRASIM_MAX_STREAM_BYTES: "1000", MIRASIM_MAX_SSE_FRAME_BYTES: "500" });
  assert.equal(overridden.streamIdleTimeoutMs, 2500);
  assert.equal(overridden.maxStreamBytes, 1000);
  assert.equal(overridden.maxSseFrameBytes, 500);
  assert.equal(loadConfig({ ...env, MIRASIM_MAX_STREAM_BYTES: "999999999" }).maxStreamBytes, defaults.maxStreamBytes);
  assert.equal(loadConfig({ ...env, MIRASIM_MAX_SSE_FRAME_BYTES: "999999999" }).maxSseFrameBytes, defaults.maxSseFrameBytes);
  assert.throws(() => loadConfig({ ...env, MIRASIM_STREAM_IDLE_TIMEOUT_MS: "bad" }), /MIRASIM_STREAM_IDLE_TIMEOUT_MS/);
});

for (const [path, model] of [["/v1/messages", "kimi-k3"], ["/v1/responses", "kimi-code/k3"], ["/v1/chat/completions", "k3"]]) {
  test(`slow Kimi headers survive the generic timeout through ${path}`, async () => {
    const fixture = await gatewayFixture(async (url, options) => {
      assert.equal(url.pathname, "/v1/chat/completions");
      assert.equal(JSON.parse(options.body).model, "kimi-k3");
      await delay(120, undefined, { signal: options.signal });
      return chatResponse();
    });
    try {
      const response = await fixture.ask(path, model);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /OK/);
    } finally {
      await fixture.close();
    }
  });
}

test("other agents retain the shorter generic header timeout", async () => {
  const fixture = await gatewayFixture(async (url, options) => {
    await delay(120, undefined, { signal: options.signal });
    return chatResponse();
  });
  try {
    const response = await fixture.ask("/v1/chat/completions", "gpt-4o-mini");
    assert.equal(response.status, 504);
    await response.text();
  } finally {
    await fixture.close();
  }
});

test("a slow max-effort request survives the generic timeout and keeps its warm account", async () => {
  let attempts = 0;
  const fixture = await gatewayFixture(async (url, options) => {
    attempts += 1;
    await delay(120, undefined, { signal: options.signal });
    return anthropicResponse();
  }, {}, 2);
  try {
    // 120 ms is past the 40 ms generic header wait but inside the top-rung allowance (120000
    // ms, here capped to the fixture's 1000 ms MIRASIM_TIMEOUT_MS). Without it the attempt
    // would be abandoned and retried on the second account — whose prompt cache is cold —
    // while the timeout cooled the cache-warm account down as faulty.
    const response = await fixture.ask("/v1/messages", "claude-opus-5", false, {
      thinking: { type: "adaptive" },
      output_config: { effort: "max" }
    });
    assert.equal(response.status, 200);
    assert.equal(attempts, 1, "the first account answered instead of failing over");
    assert.match(await response.text(), /OK/);
  } finally {
    await fixture.close();
  }
});

test("xhigh effort gets the same header allowance", async () => {
  const fixture = await gatewayFixture(async (url, options) => {
    await delay(120, undefined, { signal: options.signal });
    return anthropicResponse();
  });
  try {
    const response = await fixture.ask("/v1/messages", "claude-opus-5", false, {
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" }
    });
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    await fixture.close();
  }
});

test("budget-shaped thinking at the top rung gets the header allowance", async () => {
  const fixture = await gatewayFixture(async (url, options) => {
    await delay(120, undefined, { signal: options.signal });
    return anthropicResponse();
  });
  try {
    const response = await fixture.ask("/v1/messages", "claude-haiku-4-5", false, {
      thinking: { type: "enabled", budget_tokens: 32768 },
      max_tokens: 40960
    });
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    await fixture.close();
  }
});

// Codex runs GPT at xhigh by default, and a GPT request carries its rung as `reasoning.effort`
// (`reasoning_effort` on chat) — a field the allowance used to be blind to, so the longest
// thinkers were the ones held to the shortest wait and moved to a cold account for it.
test("an xhigh GPT Responses request gets the top-rung header allowance", async () => {
  let attempts = 0;
  const fixture = await gatewayFixture(async (url, options) => {
    attempts += 1;
    await delay(120, undefined, { signal: options.signal });
    return responsesStream();
  }, {}, 2);
  try {
    const response = await fixture.ask("/v1/responses", "gpt-test", false, { reasoning: { effort: "xhigh" } });
    assert.equal(response.status, 200);
    assert.equal(attempts, 1, "the first account answered instead of failing over");
    assert.match(await response.text(), /OK/);
  } finally {
    await fixture.close();
  }
});

test("a max reasoning_effort chat stream to GPT gets the top-rung wait for its first content", async () => {
  let attempts = 0;
  const fixture = await gatewayFixture(async () => {
    attempts += 1;
    return responsesStream(120);
  }, {}, 2);
  try {
    const response = await fixture.ask("/v1/chat/completions", "gpt-test", true, { reasoning_effort: "max" });
    assert.equal(response.status, 200);
    assert.equal(attempts, 1, "the first account answered instead of failing over");
    assert.match(await response.text(), /OK/);
  } finally {
    await fixture.close();
  }
});

test("a slow low-effort request still fails over at the generic timeout", async () => {
  let attempts = 0;
  const fixture = await gatewayFixture(async (url, options) => {
    attempts += 1;
    await delay(120, undefined, { signal: options.signal });
    return anthropicResponse();
  }, {}, 2);
  try {
    const response = await fixture.ask("/v1/messages", "claude-opus-5", false, {
      thinking: { type: "adaptive" },
      output_config: { effort: "low" }
    });
    assert.equal(response.status, 504);
    assert.equal(attempts, 2, "the generic budget still applies to low effort");
    await response.text();
  } finally {
    await fixture.close();
  }
});

for (const effort of ["medium", "high"]) {
  for (const path of ["/v1/messages", "/v1/responses", "/v1/chat/completions"]) {
    test(`${effort} reasoning survives the generic header deadline through ${path}`, async () => {
      let attempts = 0;
      const fixture = await gatewayFixture(async (url, options) => {
        attempts += 1;
        await delay(120, undefined, { signal: options.signal });
        return url.pathname === "/v1/messages" ? anthropicResponse() : responsesStream();
      }, { MIRASIM_THINKING_FIRST_BYTE_TIMEOUT_MS: "400" }, 2);
      try {
        const extra = path === "/v1/messages" ? { thinking: { type: "adaptive" }, output_config: { effort } }
          : path === "/v1/responses" ? { reasoning: { effort } } : { reasoning_effort: effort };
        const response = await fixture.ask(path, path === "/v1/messages" ? "claude-sonnet-5-5" : "gpt-test", true, extra);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /OK/);
        assert.equal(attempts, 1);
      } finally { await fixture.close(); }
    });
  }
}

test("medium reasoning can recover from a slow 503 within its thinking budget", async () => {
  let attempts = 0;
  const fixture = await gatewayFixture(async (url, options) => {
    attempts += 1;
    await delay(attempts === 1 ? 80 : 120, undefined, { signal: options.signal });
    return attempts === 1
      ? new Response(JSON.stringify({ error: { type: "server_error", message: "Temporarily unavailable" } }), { status: 503 })
      : anthropicResponse();
  }, { MIRASIM_THINKING_FIRST_BYTE_TIMEOUT_MS: "400" }, 2);
  try {
    const response = await fixture.ask("/v1/messages", "claude-opus-5-5", true, {
      thinking: { type: "adaptive" }, output_config: { effort: "medium" }
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /OK/);
    assert.equal(attempts, 2);
  } finally { await fixture.close(); }
});

test("high reasoning still obeys the hard timeout without restarting its budget", async () => {
  let attempts = 0;
  const fixture = await gatewayFixture(async (url, options) => {
    attempts += 1;
    await delay(1000, undefined, { signal: options.signal });
    return anthropicResponse();
  }, { MIRASIM_TIMEOUT_MS: "90", MIRASIM_FAILOVER_BUDGET_MS: "40", MIRASIM_THINKING_FIRST_BYTE_TIMEOUT_MS: "400" }, 2);
  try {
    const response = await fixture.ask("/v1/messages", "claude-sonnet-5-5", true, {
      thinking: { type: "adaptive" }, output_config: { effort: "high" }
    });
    assert.equal(response.status, 504);
    assert.match(await response.text(), /response headers/);
    assert.equal(attempts, 1);
  } finally { await fixture.close(); }
});

test("no thinking at all retains the shorter generic header timeout", async () => {
  const fixture = await gatewayFixture(async (url, options) => {
    await delay(120, undefined, { signal: options.signal });
    return anthropicResponse();
  });
  try {
    const response = await fixture.ask("/v1/messages", "claude-opus-5");
    assert.equal(response.status, 504);
    await response.text();
  } finally {
    await fixture.close();
  }
});

test("Claude waits through the relay queue beyond the generic header timeout", async () => {
  let attempts = 0;
  const fixture = await gatewayFixture(async (url, options) => {
    attempts += 1;
    await delay(120, undefined, { signal: options.signal });
    return anthropicResponse();
  }, { MIRASIM_CLAUDE_FIRST_BYTE_TIMEOUT_MS: "400" }, 2);
  try {
    const response = await fixture.ask("/v1/messages", "claude-opus-5");
    assert.equal(response.status, 200);
    assert.match(await response.text(), /OK/);
    assert.equal(attempts, 1, "a queued attempt is not abandoned for a second account");
  } finally { await fixture.close(); }
});

const QUEUE_HOLD = { MIRASIM_CLAUDE_FIRST_BYTE_TIMEOUT_MS: "600", MIRASIM_QUEUE_HOLD_DELAY_MS: "20", MIRASIM_QUEUE_HOLD_INTERVAL_MS: "30" };

test("a queued Claude stream is committed early and kept alive with ping events", async () => {
  let answeredAt = 0;
  const fixture = await gatewayFixture(async (url, options) => {
    await delay(200, undefined, { signal: options.signal });
    answeredAt = Date.now();
    return anthropicStream();
  }, QUEUE_HOLD);
  try {
    const response = await fixture.ask("/v1/messages", "claude-opus-5", true);
    const headersAt = Date.now();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const body = await response.text();
    assert.ok(answeredAt === 0 || headersAt < answeredAt, "headers reach the caller before the upstream answers");
    const firstStart = body.indexOf("event: message_start");
    assert.ok(firstStart > 0);
    assert.match(body.slice(0, firstStart), /^(event: ping\ndata: \{"type":"ping"\}\n\n)+$/);
    assert.match(body, /"text":"OK"/);
    assert.match(body, /event: message_stop/);
  } finally { await fixture.close(); }
});

for (const [path, pattern] of [
  ["/v1/messages", /^(event: ping\n[^\n]*\n\n)+event: error\ndata: \{"type":"error","error":\{"type":"overloaded_error","message":"Capacity is full"\}\}\n\n$/],
  ["/v1/chat/completions", /^(: keepalive\n\n)+data: \{"error":\{"message":"Capacity is full","type":"overloaded_error","param":null,"code":"model_capacity_exhausted"\}\}\n\ndata: \[DONE\]\n\n$/],
  ["/v1/responses", /^(: keepalive\n\n)+event: error\ndata: \{"type":"error","code":"model_capacity_exhausted","message":"Capacity is full","param":null\}\n\n$/]
]) {
  test(`a queued Claude stream that is finally refused ends with an in-stream error through ${path}`, async () => {
    let attempts = 0;
    const fixture = await gatewayFixture(async (url, options) => {
      attempts += 1;
      await delay(80, undefined, { signal: options.signal });
      return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", code: "model_capacity_exhausted", message: "Capacity is full" } }), { status: 503, headers: { "content-type": "application/json" } });
    }, { ...QUEUE_HOLD, MIRASIM_FAILOVER_BUDGET_MS: "100" }, 2);
    try {
      const response = await fixture.ask(path, path === "/v1/messages" ? "claude-opus-5" : "claude-opus-5-5", true);
      assert.equal(response.status, 200);
      assert.match(await response.text(), pattern);
      assert.equal(attempts, 2);
    } finally { await fixture.close(); }
  });
}

test("a fast Claude refusal keeps its real status instead of being held open", async () => {
  const fixture = await gatewayFixture(async () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad request" } }), {
    status: 400, headers: { "content-type": "application/json" }
  }), { ...QUEUE_HOLD, MIRASIM_QUEUE_HOLD_DELAY_MS: "500" });
  try {
    const response = await fixture.ask("/v1/messages", "claude-opus-5", true);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /bad request/);
  } finally { await fixture.close(); }
});

test("a stalled Kimi request gets one full wait, not another full wait on a second account", async () => {
  let attempts = 0;
  const fixture = await gatewayFixture(async (url, options) => {
    attempts += 1;
    await delay(1000, undefined, { signal: options.signal });
    return chatResponse();
  }, {}, 2);
  try {
    const response = await fixture.ask("/v1/messages", "kimi-k3");
    assert.equal(response.status, 504);
    assert.equal(attempts, 1);
    assert.match(await response.text(), /response headers/);
  } finally {
    await fixture.close();
  }
});

test("fast Kimi failures can still retry within the header budget", async () => {
  let attempts = 0;
  const fixture = await gatewayFixture(async (url, options) => {
    attempts += 1;
    if (attempts === 1) throw new Error("connection reset");
    await delay(120, undefined, { signal: options.signal });
    return chatResponse();
  }, {}, 2);
  try {
    const response = await fixture.ask("/v1/messages", "kimi-k3");
    assert.equal(response.status, 200);
    assert.equal(attempts, 2);
    await response.text();
  } finally {
    await fixture.close();
  }
});

test("a retry is aborted at the remaining budget instead of receiving a fresh timeout", async () => {
  const waits = [];
  const fixture = await gatewayFixture(async (url, options) => {
    const started = Date.now();
    try {
      await delay(1000, undefined, { signal: options.signal });
      return chatResponse();
    } finally {
      waits.push(Date.now() - started);
    }
  }, { MIRASIM_FIRST_BYTE_TIMEOUT_MS: "200", MIRASIM_FAILOVER_BUDGET_MS: "300" }, 2);
  try {
    const response = await fixture.ask("/v1/chat/completions", "gpt-4o-mini");
    assert.equal(response.status, 504);
    assert.equal(waits.length, 2);
    assert.ok(waits[1] < 175, `retry waited ${waits[1]} ms instead of the remaining ~100 ms`);
    await response.text();
  } finally {
    await fixture.close();
  }
});

// The relay answers a non-streaming Messages request only once the whole answer is generated,
// and a stream straight away. A non-streaming OpenAI-protocol caller used to be translated into
// the former, so any answer longer than the header wait was abandoned, failed over to a cold
// account, abandoned again and returned as a 504.
for (const path of ["/v1/chat/completions", "/v1/responses"]) {
  test(`a non-streaming ${path} call to a Claude model is not held to the whole generation's header wait`, async () => {
    const attempts = [];
    const fixture = await gatewayFixture(async (url, options) => {
      const body = JSON.parse(options.body);
      attempts.push({ path: url.pathname, stream: body.stream, accept: options.headers.Accept });
      if (body.stream !== true) {
        await delay(120, undefined, { signal: options.signal });
        return anthropicResponse();
      }
      return new Response(new ReadableStream({
        async start(controller) {
          const send = (type, data) => controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
          send("message_start", { message: { id: "msg_slow", model: "claude-opus-5", usage: { input_tokens: 1 } } });
          send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "O" } });
          // Well past the 40 ms header wait: the rest of the answer takes as long as it takes.
          await delay(120);
          send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "K" } });
          send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
          send("message_stop", {});
          controller.close();
        }
      }), { headers: { "content-type": "text/event-stream" } });
    }, {}, 2);
    try {
      const response = await fixture.ask(path, "claude-opus-5");
      assert.equal(response.status, 200);
      assert.deepEqual(attempts, [{ path: "/v1/messages", stream: true, accept: "text/event-stream" }]);
      assert.match(response.headers.get("content-type"), /^application\/json/);
      const body = await response.json();
      if (path === "/v1/responses") {
        assert.equal(body.object, "response");
        assert.equal(body.status, "completed");
        assert.equal(body.output.find((item) => item.type === "message").content[0].text, "OK");
      } else {
        assert.equal(body.object, "chat.completion");
        assert.deepEqual(body.choices, [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }]);
        assert.deepEqual(body.usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
      }
    } finally {
      await fixture.close();
    }
  });
}

test("Kimi response bodies can continue streaming after the header deadline", async () => {
  const fixture = await gatewayFixture(async (url, options) => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'));
      await delay(320);
      assert.equal(options.signal.aborted, false);
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } }));
  try {
    const response = await fixture.ask("/v1/chat/completions", "kimi-k3", true);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /\[DONE\]/);
  } finally {
    await fixture.close();
  }
});

for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses"]) {
  test(`permanent request errors on ${path} do not rotate accounts even under HTTP 503`, async () => {
    let attempts = 0;
    const fixture = await gatewayFixture(async () => {
      attempts++;
      return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "unsupported_parameter", param: "quality", message: "Unsupported quality parameter" } }), { status: 503, headers: { "content-type": "application/json", "x-request-id": "request-preserved" } });
    }, { MIRASIM_FAILOVER_BUDGET_MS: "1000" }, 3);
    try {
      const response = await fixture.ask(path, "gpt-6-astra");
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.message, "Unsupported quality parameter");
      assert.equal(attempts, 1);
    } finally { await fixture.close(); }
  });
}

test("unknown server errors still fail over rather than being classified from message substrings", async () => {
  let attempts = 0;
  const fixture = await gatewayFixture(async () => {
    attempts++;
    if (attempts === 1) return new Response(JSON.stringify({ error: { type: "server_error", message: "unsupported temporary backend unavailable" } }), { status: 503 });
    return chatResponse();
  }, { MIRASIM_FAILOVER_BUDGET_MS: "1000" }, 3);
  try {
    const response = await fixture.ask("/v1/chat/completions", "kimi-k3");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "OK");
    assert.equal(attempts, 2);
  } finally { await fixture.close(); }
});

async function gatewayFixture(fetchImpl, env = {}, accountCount = 1) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-timeouts-"));
  const homes = Array.from({ length: accountCount }, (_, index) => {
    const home = join(root, `account-${index}`);
    mkdirSync(home);
    writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: `user-${index}`, token: `token-${index}`, exp: 4_102_444_800 } }));
    return home;
  });
  const config = loadConfig({
    MIRASIM_HOME: root,
    MIRASIM_HOMES: homes.join(","),
    MIRASIM_RELAY_URL: "https://relay.example.test",
    MIRASIM_LOGIN_URL: "https://login.example.test",
    WEB_AUTH_PASSWORD: "password",
    MIRASIM_TIMEOUT_MS: "1000",
    MIRASIM_FIRST_BYTE_TIMEOUT_MS: "40",
    MIRASIM_KIMI_FIRST_BYTE_TIMEOUT_MS: "240",
    MIRASIM_CLAUDE_FIRST_BYTE_TIMEOUT_MS: "40",
    MIRASIM_FAILOVER_BUDGET_MS: "100",
    ...env
  });
  const server = createGateway(config, { fetchImpl, logger: { error() {} } });
  const { key } = new OpenAIKeyStore(config.databaseFile).create("Timeout regression");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    ask(path, model, stream = false, extra = {}) {
      return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "x-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 1024, stream, ...(path === "/v1/responses"
          ? { input: "Hello" }
          : { messages: [{ role: "user", content: "Hello" }] }), ...extra })
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function chatResponse() {
  return new Response(JSON.stringify({
    id: "chatcmpl-timeout",
    object: "chat.completion",
    model: "kimi-k3",
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }]
  }), { headers: { "content-type": "application/json" } });
}

function responsesStream(contentDelayMs = 0) {
  const encode = (...events) => new TextEncoder().encode(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  const message = { id: "msg_timeout", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
  return new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(encode({ type: "response.created", response: { id: "resp_timeout", object: "response", model: "gpt-test", status: "in_progress", output: [] } }));
      if (contentDelayMs) await delay(contentDelayMs);
      controller.enqueue(encode(
        { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: message.id, delta: "OK" },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.completed", response: { id: "resp_timeout", object: "response", model: "gpt-test", status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
      ));
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

function anthropicStream() {
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_queue", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }]
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function anthropicResponse() {
  return new Response(JSON.stringify({
    id: "msg_timeout",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text: "OK" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 }
  }), { headers: { "content-type": "application/json" } });
}
