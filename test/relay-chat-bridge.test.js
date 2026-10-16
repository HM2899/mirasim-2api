import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { createGateway } from "../src/server.js";

// The relay serves DeepSeek and Kimi on chat completions and nothing else. Claude Code speaks
// Anthropic Messages and Codex speaks Responses, so both used to send a Kimi request to an
// endpoint its agent is not served on and get back the relay's bare
// `400 The request was rejected as invalid.` — every time, for every prompt.

test("a Claude Code request for a Kimi model reaches the endpoint the relay serves it on", async () => {
  let sent = null;
  const fixture = gatewayFixture(async (url, options) => {
    sent = { href: url.href, agent: options.headers["x-mirasim-agent"], body: JSON.parse(options.body) };
    return json({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "kimi-k3",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } }
    });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Kimi messages test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kimi-k3",
        max_tokens: 256,
        system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
        // Claude Code sends both of these on every turn, and neither has a chat-completions form.
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
        metadata: { user_id: "someone" },
        messages: [{ role: "user", content: [{ type: "text", text: "Reply exactly OK.", cache_control: { type: "ephemeral" } }] }]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(sent.href, "https://relay.example.test/v1/chat/completions");
    assert.equal(sent.agent, "kimi");
    assert.deepEqual(sent.body, {
      model: "kimi-k3",
      messages: [
        { role: "system", content: "You are Claude Code." },
        { role: "user", content: "Reply exactly OK." }
      ],
      max_tokens: 256,
      // A chat-completions upstream is always asked for a stream: a non-streaming request
      // gets its response headers only when the whole completion is done, which outlasts the
      // header wait on a slow generation. The caller still gets its one object back.
      stream: true,
      stream_options: { include_usage: true }
    });

    const body = await response.json();
    assert.equal(body.type, "message");
    assert.equal(body.role, "assistant");
    assert.equal(body.model, "kimi-k3");
    assert.deepEqual(body.content, [{ type: "text", text: "OK" }]);
    assert.equal(body.stop_reason, "end_turn");
    // OpenAI counts the cached tokens inside prompt_tokens; Anthropic reports them beside it.
    assert.deepEqual(body.usage, { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 4 });
  } finally {
    fixture.close();
  }
});

test("a streamed Kimi answer comes back as the Anthropic events Claude Code reads", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.href, "https://relay.example.test/v1/chat/completions");
    // The stream has to be asked for, or the relay reports no token counts at all.
    assert.deepEqual(JSON.parse(options.body).stream_options, { include_usage: true });
    return sse(
      { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      { choices: [{ index: 0, delta: { content: "Hello" } }] },
      { choices: [{ index: 0, delta: { content: " there" } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read_file", arguments: "{\"path\":" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"a.txt\"}" } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 7 } }
    );
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Kimi stream test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kimi-k3",
        max_tokens: 256,
        stream: true,
        messages: [{ role: "user", content: "Read a.txt" }]
      })
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const events = parseAnthropicStream(await response.text());

    assert.deepEqual(events.map((event) => event.type), [
      "message_start",
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
      "message_delta", "message_stop"
    ]);
    assert.equal(events[0].message.model, "kimi-k3");
    assert.equal(events[2].delta.text + events[3].delta.text, "Hello there");
    assert.deepEqual(events[5].content_block, { type: "tool_use", id: "call_a", name: "read_file", input: {} });
    assert.equal(events[6].delta.partial_json + events[7].delta.partial_json, "{\"path\":\"a.txt\"}");
    assert.equal(events[9].delta.stop_reason, "tool_use");
    assert.deepEqual(events[9].usage, { input_tokens: 20, output_tokens: 7 });
  } finally {
    fixture.close();
  }
});

// A chat-completions upstream holds the response headers of a non-streaming request until the
// whole completion is done — a slow DeepSeek generation outlasts the header wait and fails over
// for nothing. So the upstream is always asked for a stream, and a caller that wanted one
// object gets the stream folded back into one.
test("a non-streaming Messages caller still gets one object, from an upstream stream", async () => {
  let sent = null;
  const fixture = gatewayFixture(async (url, options) => {
    sent = { href: url.href, body: JSON.parse(options.body) };
    return sse(
      { choices: [{ index: 0, delta: { role: "assistant", content: "OK" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }
    );
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("DeepSeek fold test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-flash", max_tokens: 256, messages: [{ role: "user", content: "Reply exactly OK." }] })
    });

    assert.equal(response.status, 200);
    assert.equal(sent.href, "https://relay.example.test/v1/chat/completions");
    assert.equal(sent.body.stream, true);
    assert.deepEqual(sent.body.stream_options, { include_usage: true });
    assert.match(response.headers.get("content-type"), /application\/json/);
    const body = await response.json();
    assert.equal(body.type, "message");
    assert.deepEqual(body.content, [{ type: "text", text: "OK" }]);
    assert.deepEqual(body.usage, { input_tokens: 12, output_tokens: 3 });
  } finally {
    fixture.close();
  }
});

test("a non-streaming chat-completions caller gets its completion folded out of the upstream stream", async () => {
  let sent = null;
  const fixture = gatewayFixture(async (url, options) => {
    sent = { href: url.href, accept: options.headers.Accept, body: JSON.parse(options.body) };
    return sse(
      { choices: [{ index: 0, delta: { role: "assistant", content: "OK" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }
    );
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("DeepSeek chat fold test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST",
      // A normal non-streaming OpenAI caller explicitly asks for JSON. The relay request is
      // nevertheless an internal SSE request and must advertise that fact upstream.
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-pro", max_tokens: 256, messages: [{ role: "user", content: "Reply exactly OK." }] })
    });

    assert.equal(response.status, 200);
    assert.equal(sent.body.stream, true);
    assert.equal(sent.accept, "text/event-stream");
    assert.match(response.headers.get("content-type"), /application\/json/);
    const body = await response.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "OK");
    assert.equal(body.choices[0].finish_reason, "stop");
  } finally {
    fixture.close();
  }
});

for (const stream of [false, undefined, true]) {
  test(`native Messages preserves the caller response mode (stream=${stream})`, async () => {
    const events = [
      { type: "message_start", message: { id: "msg_native", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" }
    ];
    const fixture = gatewayFixture(async (url, options) => {
      assert.equal(JSON.parse(options.body).stream, true);
      assert.equal(options.headers.Accept, "text/event-stream");
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    });
    try {
      const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Native non-stream test").key;
      await fixture.start();
      const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": key, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", stream, max_tokens: 256, messages: [{ role: "user", content: "Hello" }] })
      });
      assert.equal(response.status, 200);
      if (stream) {
        assert.match(response.headers.get("content-type"), /text\/event-stream/);
        assert.match(await response.text(), /event: message_stop/);
      } else {
        assert.match(response.headers.get("content-type"), /application\/json/);
        const body = await response.json();
        assert.deepEqual(body.content, [{ type: "text", text: "OK" }]);
        assert.equal(body.stop_reason, "end_turn");
        assert.deepEqual(body.usage, { input_tokens: 12, output_tokens: 3 });
      }
    } finally {
      fixture.close();
    }
  });
}

for (const failure of ["truncated", "error"]) {
  test(`native non-streaming Messages rejects an upstream ${failure}`, async () => {
    const events = [{ type: "message_start", message: { id: "msg_broken", type: "message", role: "assistant", content: [] } }];
    if (failure === "error") events.push({ type: "error", error: { type: "overloaded_error", message: "upstream overloaded" } });
    const fixture = gatewayFixture(async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
    try {
      const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Native stream error test").key;
      await fixture.start();
      const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", stream: false, max_tokens: 256, messages: [{ role: "user", content: "Hello" }] })
      });
      assert.equal(response.status, 502);
      assert.match(response.headers.get("content-type"), /application\/json/);
      const body = await response.json();
      assert.equal(body.type, "error");
      assert.match(body.error.message, failure === "error" ? /upstream overloaded/ : /incomplete/);
    } finally {
      fixture.close();
    }
  });
}

test("a streaming DeepSeek caller stays on SSE when the upstream falls back to JSON", async () => {
  const fixture = gatewayFixture(async () => json({
    id: "chat_json",
    object: "chat.completion",
    model: "deepseek-v4-pro",
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 3 }
  }));

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("DeepSeek JSON stream fallback").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-pro", stream: true, max_tokens: 256, messages: [{ role: "user", content: "Reply exactly OK." }] })
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const wire = await response.text();
    assert.match(wire, /"content":"OK"/);
    assert.match(wire, /"finish_reason":"stop"/);
    assert.match(wire, /data: \[DONE\]/);
  } finally {
    fixture.close();
  }
});

test("DeepSeek aliases keep a prompt-cache conversation on the same account", async () => {
  const accounts = [];
  const fixture = gatewayFixture(async (url, options) => {
    accounts.push(options.headers["x-mirasim-account"]);
    assert.equal(url.pathname, "/v1/chat/completions");
    return sse(
      { choices: [{ index: 0, delta: { content: "OK" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
    );
  }, { accountCount: 2 });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("DeepSeek cache affinity").key;
    await fixture.start();
    for (const model of ["deepseek-v4-flash", "deepseek-flash"]) {
      const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 64,
          system: "Keep this prefix cached.",
          messages: [{ role: "user", content: "Continue the same conversation." }]
        })
      });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal(accounts.length, 2);
    assert.equal(accounts[1], accounts[0]);
  } finally {
    fixture.close();
  }
});

test("relay session state is isolated per generation and preserved across its failover", async () => {
  const attempts = [];
  const fixture = gatewayFixture(async (url, options) => {
    attempts.push({
      account: options.headers["x-mirasim-account"],
      session: options.headers["x-mirasim-session"]
    });
    if (attempts.length === 1) {
      return new Response(JSON.stringify({ error: { message: "Try another account." } }), {
        status: 429,
        headers: { "content-type": "application/json" }
      });
    }
    return json({
      id: `msg_${attempts.length}`,
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn"
    });
  }, { accountCount: 2 });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Relay session isolation").key;
    await fixture.start();
    const post = () => fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "Content-Type": "application/json",
        // Caller-controlled relay metadata must never become an upstream identity.
        "x-mirasim-session": "caller-injection"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply exactly OK." }]
      })
    });

    for (let request = 0; request < 2; request += 1) {
      const response = await post();
      assert.equal(response.status, 200);
      await response.text();
    }

    assert.equal(attempts.length, 3);
    assert.notEqual(attempts[0].account, attempts[1].account, "the first request must fail over");
    assert.equal(attempts[0].session, attempts[1].session, "failover attempts are one logical generation");
    assert.notEqual(attempts[2].session, attempts[0].session, "independent generations must not share relay state");
    for (const attempt of attempts) {
      assert.match(attempt.session, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.notEqual(attempt.session, "caller-injection");
      assert.notEqual(attempt.session, "user-a");
      assert.notEqual(attempt.session, "user-b");
    }
  } finally {
    fixture.close();
  }
});

test("GPT Chat prompt_cache_key keeps a stable relay cache session per API key", async () => {
  const sessions = [];
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.pathname, "/v1/responses");
    sessions.push(options.headers["x-mirasim-session"]);
    return Response.json({
      id: `resp_${sessions.length}`,
      object: "response",
      model: "gpt-test",
      status: "completed",
      output: [{ id: `msg_${sessions.length}`, type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }]
    });
  });

  try {
    const firstKey = new OpenAIKeyStore(fixture.apiKeyFile).create("GPT Chat cache owner").key;
    const secondKey = new OpenAIKeyStore(fixture.apiKeyFile).create("Other GPT Chat cache owner").key;
    await fixture.start();
    const post = (key, prompt_cache_key) => fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        ...(prompt_cache_key ? { prompt_cache_key } : {}),
        messages: [{ role: "user", content: "Reply exactly OK." }]
      })
    });

    for (const [key, cacheKey] of [[firstKey, "chat-thread"], [firstKey, "chat-thread"], [secondKey, "chat-thread"], [firstKey, null]]) {
      const response = await post(key, cacheKey);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).choices[0].message.content, "OK");
    }

    assert.equal(sessions[1], sessions[0], "the same API key and prompt_cache_key must reuse the GPT cache session");
    assert.notEqual(sessions[2], sessions[0], "another API key must receive an isolated GPT cache session");
    assert.notEqual(sessions[3], sessions[0], "GPT requests without a cache key remain isolated");
  } finally {
    fixture.close();
  }
});

test("GPT Messages preserves explicit prompt_cache_key and the GPT relay session", async () => {
  const { fixture, sent } = gptMessagesCacheFixture();
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("GPT Messages explicit cache");
    await fixture.start();
    for (const metadata of [{ user_id: "first-user" }, { user_id: "different-user" }]) {
      await postGptCacheMessage(fixture, key, { prompt_cache_key: "explicit-thread", metadata });
    }
    assert.equal(sent[0].body.prompt_cache_key, "explicit-thread");
    assert.equal(sent[1].body.prompt_cache_key, "explicit-thread");
    assert.equal(sent[1].session, sent[0].session);
    assert.equal(sent[1].account, sent[0].account);
    assert.equal(sent[0].body.metadata, undefined);
  } finally {
    fixture.close();
  }
});

for (const marker of ["system", "tools", "messages", "request"]) {
  for (const stream of [false, true]) {
    test(`GPT Messages ${marker} cache_control survives growing history (stream=${stream})`, async () => {
      const { fixture, sent } = gptMessagesCacheFixture();
      try {
        const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("GPT Messages cache boundary");
        await fixture.start();
        const cache = { type: "ephemeral" };
        const original = {
          system: [{ type: "text", text: "Keep the reusable instructions.", ...(marker === "system" ? { cache_control: cache } : {}) }],
          tools: [{ name: "Read", input_schema: { type: "object" }, ...(marker === "tools" ? { cache_control: cache } : {}) }],
          messages: [{ role: "user", content: [{ type: "text", text: "Start the task.", ...(marker === "messages" ? { cache_control: cache } : {}) }] }],
          ...(marker === "request" ? { cache_control: cache } : {}),
          stream
        };
        await postGptCacheMessage(fixture, key, original);
        await postGptCacheMessage(fixture, key, {
          ...original,
          messages: [
            { role: "user", content: "Start the task." },
            { role: "assistant", content: "OK" },
            { role: "user", content: [{ type: "text", text: "Continue the task.", cache_control: { type: "ephemeral", ttl: "1h" } }] }
          ]
        });
        assert.ok(sent[0].body.prompt_cache_key, "Anthropic cache markers must bind the GPT cache key");
        assert.equal(sent[1].body.prompt_cache_key, sent[0].body.prompt_cache_key);
        assert.equal(sent[1].session, sent[0].session);
        assert.equal(sent[1].account, sent[0].account);
        assert.equal(sent[0].body.instructions, "Keep the reusable instructions.");
        assert.equal(sent[1].body.instructions, sent[0].body.instructions);
        assert.deepEqual(sent[1].body.input.slice(0, 1), sent[0].body.input);
        assert.deepEqual(sent[1].body.tools, sent[0].body.tools);
        assert.equal(JSON.stringify(sent.map((entry) => entry.body)).includes("cache_control"), false);
      } finally {
        fixture.close();
      }
    });
  }
}

test("GPT Messages derived caches remain isolated by API key, model and conversation", async () => {
  const { fixture, sent } = gptMessagesCacheFixture();
  try {
    const firstKey = new OpenAIKeyStore(fixture.apiKeyFile).create("GPT Messages cache owner").key;
    const secondKey = new OpenAIKeyStore(fixture.apiKeyFile).create("Other GPT Messages cache owner").key;
    await fixture.start();
    const cached = { system: [{ type: "text", text: "Shared instructions.", cache_control: { type: "ephemeral" } }] };
    await postGptCacheMessage(fixture, firstKey, cached);
    await postGptCacheMessage(fixture, firstKey, cached);
    await postGptCacheMessage(fixture, secondKey, cached);
    await postGptCacheMessage(fixture, firstKey, { ...cached, model: "gpt-other" });
    await postGptCacheMessage(fixture, firstKey, { ...cached, messages: [{ role: "user", content: "Another conversation." }] });
    await postGptCacheMessage(fixture, firstKey, { metadata: { user_id: "same-user-without-a-session" } });
    await postGptCacheMessage(fixture, firstKey, { metadata: { user_id: "same-user-without-a-session" } });
    assert.ok(sent[0].body.prompt_cache_key);
    assert.equal(sent[1].session, sent[0].session);
    for (const index of [2, 3, 4]) {
      assert.notEqual(sent[index].body.prompt_cache_key, sent[0].body.prompt_cache_key);
      assert.notEqual(sent[index].session, sent[0].session);
    }
    assert.ok(sent[5].body.prompt_cache_key);
    assert.equal(sent[6].body.prompt_cache_key, sent[5].body.prompt_cache_key);
    assert.equal(sent[6].session, sent[5].session);
  } finally {
    fixture.close();
  }
});

for (const format of ["legacy", "json"]) {
  test(`GPT Messages ${format} metadata sessions retain account affinity after compaction`, async () => {
    const { fixture, sent } = gptMessagesCacheFixture();
    const sessionId = "12345678-1234-4234-9234-123456789abc";
    const metadataFor = (session) => ({ user_id: format === "legacy"
      ? `user_device_account_account-id_session_${session}`
      : JSON.stringify({ device_id: "device", account_uuid: "account-id", session_id: session }) });
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("GPT Messages metadata session");
      await fixture.start();
      await postGptCacheMessage(fixture, key, { metadata: metadataFor(sessionId), system: "Initial instructions." });
      await postGptCacheMessage(fixture, key, {
        metadata: metadataFor(sessionId), system: "Compacted instructions.",
        messages: [{ role: "user", content: "Compacted conversation." }]
      });
      await postGptCacheMessage(fixture, key, { metadata: metadataFor("22345678-1234-4234-9234-123456789abc") });
      assert.ok(sent[0].body.prompt_cache_key);
      assert.equal(sent[1].body.prompt_cache_key, sent[0].body.prompt_cache_key);
      assert.equal(sent[1].session, sent[0].session);
      assert.equal(sent[1].account, sent[0].account);
      assert.notEqual(sent[2].session, sent[0].session);
      assert.equal(sent[0].body.metadata, undefined);
      assert.equal(sent[0].body.prompt_cache_key.includes(sessionId), false);
    } finally {
      fixture.close();
    }
  });
}

for (const path of ["/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
  test(`GPT ${path} automatically binds unmarked growing transcripts to one cache and account`, async () => {
    const { fixture, sent } = gptMessagesCacheFixture();
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Automatic GPT cache");
      const otherKey = new OpenAIKeyStore(fixture.apiKeyFile).create("Other cache owner").key;
      await fixture.start();
      const initial = [{ role: "user", content: "Start the task." }];
      const growing = [...initial, { role: "assistant", content: "OK" }, { role: "user", content: "Continue." }];
      for (const [owner, model, messages] of [
        [key, "gpt-test", initial], [key, "gpt-test", growing],
        [otherKey, "gpt-test", initial], [key, "gpt-other", initial],
        [key, "gpt-test", [{ role: "user", content: "Another task." }]],
        [key, "gpt-test", growing]
      ]) {
        const response = await fetch(`${fixture.baseUrl}${path}`, {
          method: "POST", headers: { Authorization: `Bearer ${owner}`, "x-api-key": owner, "Content-Type": "application/json" },
          body: JSON.stringify({ model, stream: false,
            ...(path === "/v1/responses" ? { input: messages, instructions: "Stable prefix", store: false }
              : path === "/v1/messages" ? { messages, system: "Stable prefix", max_tokens: 32 }
                : { messages: [{ role: "system", content: "Stable prefix" }, ...messages] }) })
        });
        assert.equal(response.status, 200);
        await response.text();
      }
      assert.ok(sent[0].body.prompt_cache_key);
      for (const index of [1, 5]) {
        assert.equal(sent[index].body.prompt_cache_key, sent[0].body.prompt_cache_key);
        assert.equal(sent[index].session, sent[0].session);
        assert.equal(sent[index].account, sent[0].account);
      }
      for (const index of [2, 3, 4]) {
        assert.notEqual(sent[index].body.prompt_cache_key, sent[0].body.prompt_cache_key);
        assert.notEqual(sent[index].session, sent[0].session);
      }
    } finally { fixture.close(); }
  });
}

function gptMessagesCacheFixture() {
  const sent = [];
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.pathname, "/v1/responses");
    sent.push({ session: options.headers["x-mirasim-session"], account: options.headers.Authorization, body: JSON.parse(options.body) });
    return Response.json({
      id: `resp_cache_${sent.length}`, object: "response", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
      usage: { input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 80 } }
    });
  }, { accountCount: 2 });
  return { fixture, sent };
}

async function postGptCacheMessage(fixture, key, extra = {}) {
  const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
    method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-test", max_tokens: 32, messages: [{ role: "user", content: "Start the task." }], ...extra })
  });
  assert.equal(response.status, 200);
  const wire = await response.text();
  const payload = extra.stream ? wire.split(/\r?\n\r?\n/).filter(Boolean)
    .map((frame) => JSON.parse(frame.split(/\r?\n/).find((line) => line.startsWith("data:")).slice(5)))
    .find((event) => event.type === "message_delta") : JSON.parse(wire);
  assert.deepEqual(payload.usage, { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 80 });
}

test("Chat-backed models reuse an explicit prompt cache session without forwarding its local key", async () => {
  const sent = [];
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.pathname, "/v1/chat/completions");
    const body = JSON.parse(options.body);
    sent.push({ session: options.headers["x-mirasim-session"], body });
    assert.equal(Object.hasOwn(body, "prompt_cache_key"), false, "only Codex Responses accepts this field upstream");
    return sse(
      { choices: [{ index: 0, delta: { content: "OK" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
    );
  });

  try {
    const firstKey = new OpenAIKeyStore(fixture.apiKeyFile).create("Chat cache owner").key;
    const secondKey = new OpenAIKeyStore(fixture.apiKeyFile).create("Other chat cache owner").key;
    await fixture.start();
    const post = (key, model, prompt_cache_key) => fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        ...(prompt_cache_key ? { prompt_cache_key } : {}),
        messages: [{ role: "system", content: "Keep this large prefix cached." }, { role: "user", content: "Reply exactly OK." }]
      })
    });

    for (const [key, model, cacheKey] of [
      [firstKey, "deepseek-v4-pro", "shared-thread"],
      [firstKey, "deepseek-v4-pro", "shared-thread"],
      [secondKey, "deepseek-v4-pro", "shared-thread"],
      [firstKey, "deepseek-v4-pro", null],
      [firstKey, "kimi-k3", "shared-thread"]
    ]) {
      const response = await post(key, model, cacheKey);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).choices[0].message.content, "OK");
    }

    assert.equal(sent[1].session, sent[0].session, "the same owner/model/key must reuse the relay cache session");
    assert.notEqual(sent[2].session, sent[0].session, "API keys must remain isolated");
    assert.notEqual(sent[3].session, sent[0].session, "an unbound request must remain isolated");
    assert.notEqual(sent[4].session, sent[0].session, "models must remain isolated");
  } finally {
    fixture.close();
  }
});

test("Messages-wire cache_control creates a stable relay cache session for non-Codex agents", async () => {
  const sent = [];
  const fixture = gatewayFixture(async (url, options) => {
    assert.equal(url.pathname, "/v1/messages");
    sent.push({ session: options.headers["x-mirasim-session"], agent: options.headers["x-mirasim-agent"], body: JSON.parse(options.body) });
    return json({
      id: `msg_${sent.length}`,
      type: "message",
      role: "assistant",
      model: "glm-5.3",
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn"
    });
  });

  try {
    const firstKey = new OpenAIKeyStore(fixture.apiKeyFile).create("Messages cache owner").key;
    const secondKey = new OpenAIKeyStore(fixture.apiKeyFile).create("Other messages cache owner").key;
    await fixture.start();
    const post = (key, cache) => fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "glm-5.3",
        max_tokens: 64,
        ...(cache ? { system: [{ type: "text", text: "Cache this stable instruction.", cache_control: { type: "ephemeral" } }] } : { system: "Do not bind a cache session." }),
        messages: [
          { role: "user", content: "Start the task." },
          ...(cache ? [{ role: "assistant", content: "OK" }, { role: "user", content: "Continue the task." }] : [])
        ]
      })
    });

    for (const [key, cache] of [[firstKey, true], [firstKey, true], [secondKey, true], [firstKey, false]]) {
      const response = await post(key, cache);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).content[0].text, "OK");
    }

    assert.equal(sent[0].agent, "zcode");
    assert.equal(sent[1].session, sent[0].session, "later turns with the same explicit cache boundary must reuse its session");
    assert.notEqual(sent[2].session, sent[0].session, "API keys must remain isolated");
    assert.notEqual(sent[3].session, sent[0].session, "requests without cache_control must remain isolated");
  } finally {
    fixture.close();
  }
});

for (const [model, alias] of [
  ["deepseek-flash", "deepseek-v4-flash"],
  ["kimi-k3", "kimi-code/k3"],
  ["glm-5.3", "glm-5.3"],
  ["claude-opus-4-6", "claude-opus-4-6"]
]) {
  for (const path of ["/v1/messages", "/v1/chat/completions", "/v1/responses", "/backend-api/codex/responses"]) {
    for (const binding of ["explicit", "json", "legacy"]) {
      test(`${model} ${path} retains ${binding} cache session and account after compaction`, async () => {
        const { fixture, sent } = relayCacheFixture();
        try {
          const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Relay cache owner").key;
          const otherKey = new OpenAIKeyStore(fixture.apiKeyFile).create("Other relay cache owner").key;
          await fixture.start();
          const metadataFor = (session) => ({ user_id: binding === "legacy"
            ? `user_example_account_example_session_${session}`
            : JSON.stringify({ user_id: "example", session_id: session }) });
          const session = "12345678-1234-4234-9234-123456789abc";
          const otherSession = "22345678-1234-4234-9234-123456789abc";
          const cache = { metadata: metadataFor(session), ...(binding === "explicit" ? { prompt_cache_key: "stable-thread" } : {}) };
          const post = (owner, requested, text, extra) => postRelayCacheRequest(fixture, owner, path, requested, text, extra);
          await post(key, alias, "Original conversation", cache);
          await post(key, model, "Compacted conversation", {
            ...cache, ...(binding === "explicit" ? { metadata: metadataFor(otherSession) } : {})
          });
          assert.equal(sent[1].session, sent[0].session);
          assert.equal(sent[1].account, sent[0].account);
          assert.equal(sent[0].body.model, model);
          assert.equal(sent[0].body.prompt_cache_key, undefined);
          assert.equal(sent[1].body.prompt_cache_key, undefined);
          assert.match(sent[0].session, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
          await post(otherKey, model, "Original conversation", cache);
          assert.notEqual(sent[2].session, sent[0].session);
          await post(key, model, "Original conversation", {
            metadata: metadataFor(otherSession), ...(binding === "explicit" ? { prompt_cache_key: "different-thread" } : {})
          });
          assert.notEqual(sent[3].session, sent[0].session);
          await post(key, model, "Original conversation", { metadata: { user_id: "not-a-conversation" } });
          await post(key, model, "Original conversation", { metadata: { user_id: "not-a-conversation" } });
          assert.notEqual(sent[5].session, sent[4].session);
          await post(key, model, "Another compacted conversation", cache);
          assert.equal(sent[6].session, sent[0].session);
          assert.equal(sent[6].account, sent[0].account);
        } finally {
          fixture.close();
        }
      });
    }
  }
}

for (const model of ["deepseek-flash", "kimi-k3", "glm-5.3", "claude-opus-4-6"]) {
  for (const path of ["/v1/messages", "/v1/chat/completions", "/v1/responses"]) {
    test(`${model} ${path} preserves cache binding when boundaries move`, async () => {
      const { fixture, sent } = relayCacheFixture();
      try {
        const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Moving cache boundary").key;
        await fixture.start();
        const initial = [{ role: "user", content: [{ type: "text", text: "Start", cache_control: { type: "ephemeral" } }] }];
        const continued = [
          { role: "user", content: "Start" }, { role: "assistant", content: "OK" },
          { role: "user", content: [{ type: "text", text: "Continue", cache_control: { type: "ephemeral", ttl: "1h" } }] }
        ];
        for (const history of [initial, continued]) {
          await postRelayCacheRequest(fixture, key, path, model, "Stable instructions", path === "/v1/responses" ? { input: history } : { messages: history });
        }
        assert.equal(sent[1].session, sent[0].session);
        assert.equal(sent[1].account, sent[0].account);
      } finally {
        fixture.close();
      }
    });
  }
}

test("Chat function cache controls bind other models without explicit keys", async () => {
  const { fixture, sent } = relayCacheFixture();
  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Tool cache owner").key;
    await fixture.start();
    for (const ttl of [undefined, "1h"]) {
      await postRelayCacheRequest(fixture, key, "/v1/chat/completions", "glm-5.3", "Same conversation", {
        tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" }, cache_control: { type: "ephemeral", ...(ttl ? { ttl } : {}) } } }]
      });
    }
    assert.equal(sent[1].session, sent[0].session);
    assert.equal(sent[1].account, sent[0].account);
  } finally {
    fixture.close();
  }
});

function relayCacheFixture() {
  const sent = [];
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    sent.push({ body, session: options.headers["x-mirasim-session"], account: options.headers.Authorization });
    if (url.pathname === "/v1/messages") {
      return json({
        id: `msg_cache_${sent.length}`, type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 }
      });
    }
    assert.equal(url.pathname, "/v1/chat/completions");
    return sse(
      { choices: [{ index: 0, delta: { content: "OK" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
    );
  }, { accountCount: 2 });
  return { fixture, sent };
}

async function postRelayCacheRequest(fixture, key, path, model, text, extra) {
  const body = path.endsWith("/responses")
    ? { model, instructions: text, input: text, max_output_tokens: 64, ...extra }
    : { model, max_tokens: 64, messages: [{ role: "user", content: text }], ...extra };
  const response = await fetch(`${fixture.baseUrl}${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.text();
  assert.equal(response.status, 200, payload);
  assert.match(payload, /OK/);
}

for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses"]) {
  for (const stream of [false, true]) {
    test(`DeepSeek native cache usage reaches ${path} (stream=${stream})`, async () => {
      const fixture = gatewayFixture(async () => sse(
        { choices: [{ index: 0, delta: { content: "OK" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } }
      ));
      try {
        const key = new OpenAIKeyStore(fixture.apiKeyFile).create("DeepSeek usage").key;
        await fixture.start();
        const response = await fetch(`${fixture.baseUrl}${path}`, {
          method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "deepseek-flash", stream, max_tokens: 64,
            ...(path === "/v1/responses" ? { input: "Hello" } : { messages: [{ role: "user", content: "Hello" }] }),
            ...(path === "/v1/chat/completions" && stream ? { stream_options: { include_usage: true } } : {})
          })
        });
        assert.equal(response.status, 200);
        const wire = await response.text();
        const payloads = stream ? wire.split(/\r?\n/).filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
          .map((line) => JSON.parse(line.slice(5))) : [JSON.parse(wire)];
        const usage = payloads.map((payload) => payload.response?.usage || payload.usage).filter(Boolean).at(-1);
        if (path === "/v1/messages") {
          assert.deepEqual(usage, { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 80 });
        } else if (path === "/v1/responses") {
          assert.deepEqual(usage, { input_tokens: 100, output_tokens: 2, total_tokens: 102, input_tokens_details: { cached_tokens: 80 } });
        } else {
          assert.equal(usage.prompt_tokens_details.cached_tokens, 80);
          assert.equal(usage.prompt_cache_hit_tokens, 80);
        }
      } finally {
        fixture.close();
      }
    });
  }
}

test("a non-streaming Responses caller for a DeepSeek model gets its response folded out of the upstream stream", async () => {
  let sent = null;
  const fixture = gatewayFixture(async (url, options) => {
    sent = { href: url.href, body: JSON.parse(options.body) };
    return sse(
      { choices: [{ index: 0, delta: { role: "assistant", content: "OK" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }
    );
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("DeepSeek responses fold test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-flash", max_output_tokens: 256, input: "Reply exactly OK." })
    });

    assert.equal(response.status, 200);
    assert.equal(sent.href, "https://relay.example.test/v1/chat/completions");
    assert.equal(sent.body.stream, true);
    const body = await response.json();
    assert.equal(body.object, "response");
    assert.equal(body.status, "completed");
    assert.equal(body.output.find((item) => item.type === "message").content[0].text, "OK");
  } finally {
    fixture.close();
  }
});

test("a native non-streaming Messages caller also accepts an upstream JSON fallback", async () => {
  let sent = null;
  const fixture = gatewayFixture(async (url, options) => {
    sent = { href: url.href, body: JSON.parse(options.body) };
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Claude non-stream test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5", max_tokens: 256, messages: [{ role: "user", content: "Reply exactly OK." }] })
    });

    assert.equal(response.status, 200);
    assert.equal(sent.href, "https://relay.example.test/v1/messages");
    assert.equal(sent.body.stream, true);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.deepEqual((await response.json()).content, [{ type: "text", text: "OK" }]);
  } finally {
    fixture.close();
  }
});

test("a Codex request for a Kimi model is bridged to chat completions and answered as a response", async () => {
  let sent = null;
  const fixture = gatewayFixture(async (url, options) => {
    sent = { href: url.href, agent: options.headers["x-mirasim-agent"], body: JSON.parse(options.body) };
    return sse(
      { choices: [{ index: 0, delta: { content: "OK" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
    );
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Kimi responses test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kimi-k3",
        stream: true,
        store: false,
        instructions: "You are Codex.",
        // Codex names its level on every request, and `xhigh` is not a rung this upstream knows.
        reasoning: { effort: "xhigh" },
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Reply exactly OK." }] }]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(sent.href, "https://relay.example.test/v1/chat/completions");
    assert.equal(sent.agent, "kimi");
    assert.deepEqual(sent.body, {
      model: "kimi-k3",
      messages: [
        { role: "system", content: "You are Codex." },
        { role: "user", content: "Reply exactly OK." }
      ],
      stream: true,
      stream_options: { include_usage: true }
    });

    const events = (await response.text()).split("\n\n").filter(Boolean).map((frame) => frame.split("\n").find((line) => line.startsWith("data:")));
    const types = events.map((line) => JSON.parse(line.slice(5)).type);
    assert.ok(types.includes("response.created"), types.join(","));
    assert.ok(types.includes("response.completed"), types.join(","));
  } finally {
    fixture.close();
  }
});

test("the desktop client's Kimi id reaches the relay under the name the relay answers to", async () => {
  let sentModel = null;
  const fixture = gatewayFixture(async (url, options) => {
    sentModel = JSON.parse(options.body).model;
    return json({ id: "chatcmpl-2", object: "chat.completion", model: "kimi-k3", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Kimi alias test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kimi-code/k3", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] })
    });

    assert.equal(response.status, 200);
    assert.equal(sentModel, "kimi-k3");
    // The client hears back the name it asked with; the alias is this gateway's business.
    assert.equal((await response.json()).model, "kimi-code/k3");
  } finally {
    fixture.close();
  }
});

test("a tool round trip survives both crossings of the bridge", async () => {
  let sent = null;
  const fixture = gatewayFixture(async (url, options) => {
    sent = JSON.parse(options.body);
    return json({
      id: "chatcmpl-3",
      object: "chat.completion",
      model: "kimi-k3",
      choices: [{
        index: 0,
        message: { role: "assistant", content: null, tool_calls: [{ id: "call_b", type: "function", function: { name: "read_file", arguments: "{\"path\":\"b.txt\"}" } }] },
        finish_reason: "tool_calls"
      }]
    });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Kimi tools test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kimi-k3",
        max_tokens: 256,
        tools: [
          { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }
        ],
        tool_choice: { type: "auto" },
        messages: [
          { role: "user", content: [{ type: "text", text: "Read a.txt" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "call_a", name: "read_file", input: { path: "a.txt" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: [{ type: "text", text: "hello" }] }] }
        ]
      })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(sent.tools, [{
      type: "function",
      function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }
    }]);
    assert.equal(sent.tool_choice, "auto");
    assert.deepEqual(sent.messages, [
      { role: "user", content: "Read a.txt" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }] },
      { role: "tool", tool_call_id: "call_a", content: "hello" }
    ]);

    const body = await response.json();
    assert.deepEqual(body.content, [{ type: "tool_use", id: "call_b", name: "read_file", input: { path: "b.txt" } }]);
    assert.equal(body.stop_reason, "tool_use");
  } finally {
    fixture.close();
  }
});

test("a pasted image and a forced tool cross in the shapes chat completions spells them with", async () => {
  let sent = null;
  const fixture = gatewayFixture(async (url, options) => {
    sent = JSON.parse(options.body);
    return json({ id: "chatcmpl-4", object: "chat.completion", model: "kimi-k3", choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }] });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Kimi image test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kimi-k3",
        max_tokens: 64,
        tools: [{ name: "describe", input_schema: { type: "object", properties: {} } }],
        tool_choice: { type: "tool", name: "describe" },
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }
          ]
        }]
      })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(sent.tool_choice, { type: "function", function: { name: "describe" } });
    assert.deepEqual(sent.messages, [{
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
      ]
    }]);
    // A turn that produced nothing still has to come back as a well-formed message.
    assert.deepEqual((await response.json()).content, [{ type: "text", text: "" }]);
  } finally {
    fixture.close();
  }
});

test("an upstream refusal reaches Claude Code as an Anthropic error rather than an OpenAI one", async () => {
  const fixture = gatewayFixture(async () => new Response(
    JSON.stringify({ error: { message: "The request was rejected as invalid.", type: "invalid_request_error" } }),
    { status: 400, headers: { "content-type": "application/json" } }
  ));

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Kimi error test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] })
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      type: "error",
      error: { type: "invalid_request_error", message: "The request was rejected as invalid." }
    });
  } finally {
    fixture.close();
  }
});

test("a Claude model still goes to the Messages endpoint untranslated", async () => {
  let href = null;
  const fixture = gatewayFixture(async (url) => {
    href = url.href;
    return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
  });

  try {
    const key = new OpenAIKeyStore(fixture.apiKeyFile).create("Claude passthrough test").key;
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] })
    });

    assert.equal(response.status, 200);
    assert.equal(href, "https://relay.example.test/v1/messages");
    assert.equal((await response.json()).type, "message");
  } finally {
    fixture.close();
  }
});

test("the usage log names the API key behind each request without keeping the key", async () => {
  const fixture = gatewayFixture(async () => sse({ choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] }));
  try {
    const store = new OpenAIKeyStore(fixture.apiKeyFile);
    const { key, record } = store.create("Production app");
    await fixture.start();
    const ok = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3", stream: false, messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(ok.status, 200);
    await ok.text();
    const rejected = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: "Bearer msk_not_a_real_key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3", messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(rejected.status, 401);
    await rejected.text();
    const entries = await requestLogs(fixture);
    const served = entries.find((entry) => entry.status === 200);
    assert.deepEqual(served.apiKey, { id: record.id, name: "Production app", prefix: record.prefix });
    assert.equal(entries.find((entry) => entry.status === 401).apiKey, null);
    assert.doesNotMatch(JSON.stringify(entries), new RegExp(key));
  } finally {
    fixture.close();
  }
});

for (const path of ["/v1/messages", "/v1/responses", "/v1/chat/completions"]) {
  test(`non-streaming ${path} folds unexpected upstream SSE into JSON`, async () => {
    const fixture = gatewayFixture(async () => sse(
      { id: "chat-nonstream", model: "kimi-k3", choices: [{ index: 0, delta: { reasoning_content: "先检查。" } }] },
      { choices: [{ index: 0, delta: { content: "OK" } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-read", function: { name: "read_file", arguments: '{"path":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"main.js"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 24, prompt_tokens_details: { cached_tokens: 100 } } }
    ));
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Non-stream SSE regression");
      await fixture.start();
      const response = await fetch(`${fixture.baseUrl}${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "x-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "kimi-k3", stream: false, max_tokens: 2112, ...(path === "/v1/responses" ? { input: "Hello" } : { messages: [{ role: "user", content: "Hello" }] }) })
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /application\/json/);
      const body = await response.json();
      assert.match(JSON.stringify(body), /先检查。/);
      assert.match(JSON.stringify(body), /OK/);
      assert.match(JSON.stringify(body), /read_file/);
      if (path === "/v1/messages") {
        assert.equal(body.type, "message");
        assert.equal(body.stop_reason, "tool_use");
        assert.deepEqual(body.content[2].input, { path: "main.js" });
        assert.equal(body.usage.input_tokens, 20);
        assert.equal(body.usage.output_tokens, 24);
        assert.equal(body.usage.cache_read_input_tokens, 100);
      } else if (path === "/v1/responses") {
        assert.equal(body.object, "response");
        assert.equal(body.output[0].type, "reasoning");
      } else {
        assert.equal(body.object, "chat.completion");
        assert.equal(body.choices[0].message.content, "OK");
      }
    } finally {
      fixture.close();
    }
  });

  test(`non-streaming ${path} rejects an empty upstream stream`, async () => {
    const fixture = gatewayFixture(async () => sse({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Empty SSE regression");
      await fixture.start();
      const response = await fetch(`${fixture.baseUrl}${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "x-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "kimi-k3", stream: false, ...(path === "/v1/responses" ? { input: "Hello" } : { messages: [{ role: "user", content: "Hello" }] }) })
      });
      assert.equal(response.status, 502);
      assert.ok((await response.json()).error);
      const login = await fetch(`${fixture.baseUrl}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "console", password: "correct-password" })
      });
      const cookie = login.headers.get("set-cookie").split(";")[0];
      await login.text();
      const logs = await (await fetch(`${fixture.baseUrl}/api/usage-log`, { headers: { Cookie: cookie } })).json();
      assert.equal(logs.entries[0].status, 502);
      assert.equal(logs.entries[0].upstreamStatus, 200);
    } finally {
      fixture.close();
    }
  });
}

for (const stream of [false, true]) {
  test(`GPT Anthropic commentary stays progress while tools and final answers continue (stream=${stream})`, async () => {
    const progress = { id: "msg_progress", type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Checking the file." }] };
    const tool = { id: "fc_check", type: "function_call", call_id: "call_check", name: "Read", arguments: '{"path":"example.txt"}' };
    let turns = 0;
    const fixture = gatewayFixture(async (url, options) => {
      assert.equal(url.pathname, "/v1/responses");
      const sent = JSON.parse(options.body);
      turns += 1;
      if (turns === 2) {
        assert.equal(sent.input.find((item) => item.type === "function_call_output").output, "FILE_OK");
        return responsesSse([{ type: "response.completed", response: { output: [{ id: "msg_final", type: "message", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] }] } }]);
      }
      return responsesSse([
        { type: "response.output_item.added", output_index: 0, item: { ...progress, content: [] } },
        { type: "response.output_text.delta", item_id: progress.id, output_index: 0, delta: "Checking the file." },
        { type: "response.output_item.done", output_index: 0, item: progress },
        { type: "response.output_item.done", output_index: 1, item: tool },
        { type: "response.completed", response: { output: [progress, tool] } }
      ]);
    });
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("GPT commentary compatibility");
      await fixture.start();
      const messages = [{ role: "user", content: "Check the file." }];
      const post = () => fetch(`${fixture.baseUrl}/v1/messages`, {
        method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", stream, max_tokens: 1024, tools: [{ name: "Read", input_schema: { type: "object" } }], messages })
      });
      const response = await post();
      assert.equal(response.status, 200);
      if (stream) {
        const events = parseAnthropicStream(await response.text());
        assert.equal(events.some((event) => event.delta?.type === "text_delta"), false);
        assert.equal(events.filter((event) => event.delta?.type === "thinking_delta").map((event) => event.delta.thinking).join(""), "Checking the file.");
        assert.equal(events.find((event) => event.content_block?.type === "tool_use").content_block.id, tool.call_id);
        assert.equal(events.find((event) => event.type === "message_delta").delta.stop_reason, "tool_use");
        assert.equal(events.filter((event) => event.type === "message_stop").length, 1);
      } else {
        const result = await response.json();
        assert.deepEqual(result.content, [{ type: "thinking", thinking: "Checking the file." }, { type: "tool_use", id: tool.call_id, name: tool.name, input: { path: "example.txt" } }]);
        assert.equal(result.stop_reason, "tool_use");
      }
      messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "Checking the file." }, { type: "tool_use", id: tool.call_id, name: tool.name, input: { path: "example.txt" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: tool.call_id, content: "FILE_OK" }] });
      const final = await post();
      assert.equal(final.status, 200);
      if (stream) {
        const events = parseAnthropicStream(await final.text());
        assert.equal(events.filter((event) => event.delta?.type === "text_delta").map((event) => event.delta.text).join(""), "Done.");
        assert.equal(events.find((event) => event.type === "message_delta").delta.stop_reason, "end_turn");
      } else {
        const result = await final.json();
        assert.deepEqual(result.content, [{ type: "text", text: "Done." }]);
        assert.equal(result.stop_reason, "end_turn");
      }
      assert.equal(turns, 2);
    } finally { fixture.close(); }
  });
}

for (const stream of [false, true]) {
  for (const protocol of ["messages", "chat/completions"]) {
    test(`GPT ${protocol} preserves parallel tools and tool results (stream=${stream})`, async () => {
      const sent = [];
      const calls = [
        { type: "function_call", id: "fc_read", call_id: "call_read", name: "Read", arguments: '{"path":"中文.txt"}', status: "completed" },
        { type: "function_call", id: "fc_shell", call_id: "call_shell", name: "Bash", arguments: '{"command":"pwd"}', status: "completed" }
      ];
      const fixture = gatewayFixture(async (url, options) => {
        assert.equal(url.pathname, "/v1/responses");
        assert.equal(options.headers["x-mirasim-agent"], "codex");
        const body = JSON.parse(options.body);
        sent.push(body);
        if (sent.length === 2) {
          assert.deepEqual(body.input.filter((item) => item.type === "function_call"), calls.map(({ id, status, ...item }) => item));
          assert.deepEqual(body.input.filter((item) => item.type === "function_call_output"), [
            { type: "function_call_output", call_id: "call_read", output: "file content" },
            { type: "function_call_output", call_id: "call_shell", output: "/workspace" }
          ]);
          return responsesSse([
            { type: "response.output_item.done", output_index: 0, item: { id: "msg_done", type: "message", role: "assistant", content: [{ type: "output_text", text: "完成" }] } },
            { type: "response.completed", response: { id: "resp_done", output: [] } }
          ]);
        }
        return responsesSse([
          { type: "response.created", response: { id: "resp_tools" } },
          ...calls.map((item, output_index) => ({ type: "response.output_item.added", output_index, item: { ...item, arguments: "", status: "in_progress" } })),
          ...calls.map((item, output_index) => ({ type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments.slice(0, 5) })),
          ...calls.map((item, output_index) => ({ type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments.slice(5) })),
          ...calls.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
          { type: "response.completed", response: { id: "resp_tools", output: [], usage: { input_tokens: 20, output_tokens: 8, input_tokens_details: { cached_tokens: 5 } } } }
        ]);
      }, { reasoningMode: "passthrough" });
      try {
        const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("GPT tools");
        await fixture.start();
        const anthropic = protocol === "messages";
        const tools = ["Read", "Bash"].map((name) => anthropic
          ? { name, input_schema: { type: "object", properties: {} } }
          : { type: "function", function: { name, parameters: { type: "object", properties: {} } } });
        const messages = [{ role: "user", content: "Read the file and run pwd" }];
        const request = {
          model: "gpt-5.6-sol", stream, tools, messages,
          ...(anthropic ? { system: "You are Claude Code.", max_tokens: 1024, thinking: { type: "adaptive" }, output_config: { effort: "high" }, tool_choice: { type: "auto", disable_parallel_tool_use: true } } : { reasoning_effort: "high", parallel_tool_calls: false, tool_choice: "auto" })
        };
        const post = () => fetch(`${fixture.baseUrl}/v1/${protocol}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "x-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(request) });
        const response = await post();
        assert.equal(response.status, 200);
        const wire = await response.text();
        let returned;
        if (anthropic && stream) {
          const events = parseAnthropicStream(wire);
          returned = events.filter((event) => event.content_block?.type === "tool_use").map((event) => ({ ...event.content_block, input: JSON.parse(events.filter((entry) => entry.type === "content_block_delta" && entry.index === event.index).map((entry) => entry.delta.partial_json).join("")) }));
          assert.equal(events.find((event) => event.type === "message_delta").delta.stop_reason, "tool_use");
        } else if (anthropic) {
          const result = JSON.parse(wire);
          returned = result.content;
          assert.equal(result.stop_reason, "tool_use");
          assert.equal(result.usage.cache_read_input_tokens, 5);
        } else {
          const chunks = stream ? wire.split("\n\n").filter((frame) => frame.startsWith("data:") && !frame.includes("[DONE]")).map((frame) => JSON.parse(frame.slice(5))) : [];
          returned = stream ? calls.map((call, index) => {
            const deltas = chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls || []).filter((delta) => delta.index === index);
            return { id: deltas[0].id, type: "function", function: { name: deltas[0].function.name, arguments: deltas.map((delta) => delta.function.arguments || "").join("") } };
          }) : JSON.parse(wire).choices[0].message.tool_calls;
          assert.equal(stream ? chunks.at(-1).choices[0].finish_reason : JSON.parse(wire).choices[0].finish_reason, "tool_calls");
        }
        assert.deepEqual(returned, calls.map((call) => anthropic ? { type: "tool_use", id: call.call_id, name: call.name, input: JSON.parse(call.arguments) } : { id: call.call_id, type: "function", function: { name: call.name, arguments: call.arguments } }));
        assert.equal(sent[0].store, false);
        assert.equal(sent[0].stream, true);
        assert.equal(sent[0].parallel_tool_calls, false);
        assert.deepEqual(sent[0].reasoning, { effort: "high", summary: "auto" });
        assert.equal(sent[0].tools.length, 2);
        assert.equal(sent[0].tools[0].name, "Read");
        assert.equal(sent[0].tools[0].strict, false);
        assert.equal(sent[0].max_tokens, undefined);
        if (anthropic) {
          messages.push({ role: "assistant", content: returned }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_read", content: "file content" }, { type: "tool_result", tool_use_id: "call_shell", content: "/workspace" }] });
        } else {
          messages.push({ role: "assistant", content: null, tool_calls: returned }, { role: "tool", tool_call_id: "call_read", content: "file content" }, { role: "tool", tool_call_id: "call_shell", content: "/workspace" });
        }
        const final = await post();
        assert.equal(final.status, 200);
        assert.match(await final.text(), /完成/);
        assert.equal(sent.length, 2);
      } finally {
        fixture.close();
      }
    });
  }
}

for (const stream of [false, true]) {
  test(`native GPT Responses retains Codex custom tools and repairs empty output (stream=${stream})`, async () => {
    const tool = { type: "custom", name: "apply_patch", format: { type: "text" } };
    const call = { type: "custom_tool_call", id: "ctc_1", call_id: "call_patch", name: "apply_patch", input: "*** 中文 patch ***", status: "completed" };
    const fixture = gatewayFixture(async (url, options) => {
      assert.equal(url.pathname, "/v1/responses");
      const body = JSON.parse(options.body);
      assert.deepEqual(body.tools, [tool]);
      assert.deepEqual(body.input.slice(1), [call, { type: "custom_tool_call_output", call_id: "call_patch", output: "Success" }]);
      return responsesSse([
        { type: "response.output_item.done", output_index: 0, item: call },
        { type: "response.completed", response: { id: "resp_patch", status: "completed", output: [] } }
      ], true);
    });
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Codex native tools");
      await fixture.start();
      const response = await fetch(`${fixture.baseUrl}/backend-api/codex/responses`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", stream, tools: [tool], input: [{ role: "user", content: "Edit" }, call, { type: "custom_tool_call_output", call_id: "call_patch", output: "Success" }] })
      });
      assert.equal(response.status, 200);
      const wire = await response.text();
      const result = stream ? wire.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5))).at(-1).response : JSON.parse(wire);
      assert.deepEqual(result.output, [call]);
    } finally {
      fixture.close();
    }
  });
}

for (const stream of [false, true]) {
  for (const contentType of ["application/json", "text/plain", null]) {
    test(`GPT Messages detects mislabeled Responses SSE (${contentType}, stream=${stream})`, async () => {
      const tool = { id: "fc_detected", type: "function_call", call_id: "call_detected", name: "Read", arguments: '{"path":"中文.txt"}' };
      const fixture = gatewayFixture(async (url, options) => {
        assert.equal(url.pathname, "/v1/responses");
        assert.equal(JSON.parse(options.body).stream, true);
        assert.equal(options.headers.Accept, "text/event-stream");
        const upstream = responsesSse([
          { type: "response.created", response: { id: "resp_detected" } },
          { type: "response.output_text.delta", item_id: "msg_detected", output_index: 0, delta: "读取文件" },
          { type: "response.output_item.done", output_index: 1, item: tool },
          { type: "response.completed", response: { id: "resp_detected", output: [], usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } } } }
        ], true);
        if (contentType) upstream.headers.set("content-type", contentType);
        else upstream.headers.delete("content-type");
        return upstream;
      });
      try {
        const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("GPT mislabeled SSE");
        await fixture.start();
        const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
          method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-test", stream, max_tokens: 1024, tools: [{ name: "Read", input_schema: { type: "object" } }], messages: [{ role: "user", content: "Read the file" }] })
        });
        assert.equal(response.status, 200);
        if (stream) {
          assert.match(response.headers.get("content-type"), /text\/event-stream/);
          const events = parseAnthropicStream(await response.text());
          assert.equal(events.some((event) => event.type === "error"), false);
          assert.equal(events.filter((event) => event.delta?.type === "text_delta").map((event) => event.delta.text).join(""), "读取文件");
          assert.equal(events.find((event) => event.content_block?.type === "tool_use").content_block.id, tool.call_id);
          assert.equal(events.filter((event) => event.delta?.type === "input_json_delta").map((event) => event.delta.partial_json).join(""), tool.arguments);
          const final = events.find((event) => event.type === "message_delta");
          assert.equal(final.delta.stop_reason, "tool_use");
          assert.equal(final.usage.output_tokens, 4);
          assert.equal(events.at(-1).type, "message_stop");
        } else {
          assert.match(response.headers.get("content-type"), /application\/json/);
          const message = await response.json();
          assert.equal(message.type, "message");
          assert.deepEqual(message.content, [{ type: "text", text: "读取文件" }, { type: "tool_use", id: tool.call_id, name: tool.name, input: { path: "中文.txt" } }]);
          assert.equal(message.stop_reason, "tool_use");
          assert.deepEqual(message.usage, { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 3 });
        }
      } finally { fixture.close(); }
    });
  }
}

test("GPT Messages managed reasoning honors client effort and removes foreign fields", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.reasoning, { effort: "xhigh", summary: "auto" });
    for (const field of ["thinking", "output_config", "reasoning_effort", "max_tokens", "temperature", "top_p"]) assert.equal(body[field], undefined);
    return responsesSse([{ type: "response.completed", response: { output: [{ id: "msg_1", type: "message", content: [{ type: "output_text", text: "OK" }] }] } }]);
  }, { reasoningMode: "managed", defaultReasoningEffort: "low", minReasoningEffort: "xhigh" });
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("GPT managed reasoning");
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", max_tokens: 1024, thinking: { type: "adaptive" }, output_config: { effort: "high" }, messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, "OK");
  } finally {
    fixture.close();
  }
});

test("GPT upstream validation errors remain Anthropic errors for Claude Code", async () => {
  let attempts = 0;
  const fixture = gatewayFixture(async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: { message: "Invalid tool schema" } }), { status: 400, headers: { "content-type": "application/json" } });
  });
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("GPT error mapping");
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { type: "error", error: { type: "invalid_request_error", message: "Invalid tool schema" } });
    assert.equal(attempts, 1);
  } finally {
    fixture.close();
  }
});

for (const [path, body, errorPath] of [
  ["/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: [null] }] }, "messages[0].content[0]"],
  ["/v1/responses", { model: "gpt-test", input: "Continue", previous_response_id: "resp_previous" }, "previous_response_id"],
  ["/v1/responses", { model: "kimi-k3", input: "Edit", tools: [{ type: "custom", name: "apply_patch" }] }, "tools[0].type"],
  ["/v1/responses", { model: "claude-sonnet-5", input: [{ role: "user", content: [{ type: "input_file", file_id: "file_1" }] }] }, "input[0].content[0].type"],
  ["/v1/messages", { model: "gpt-test", messages: [{ role: "user", content: [{ type: "document", source: { file_id: "file_1" } }] }] }, "messages[0].content[0].type"],
  ["/v1/messages", { model: "kimi-k3", messages: [{ role: "user", content: "Search" }], tools: [{ type: "web_search_20250305", name: "web_search" }] }, "tools[0]"]
]) {
  test(`protocol validation rejects ${errorPath} before contacting ${path}`, async () => {
    let attempts = 0;
    const fixture = gatewayFixture(async () => { attempts += 1; return json({}); });
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Validation test");
      await fixture.start();
      const response = await fetch(`${fixture.baseUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
      const result = await response.json();
      assert.ok(result.error.message.startsWith(errorPath));
      if (path === "/v1/messages") assert.equal(result.type, "error");
      assert.equal(attempts, 0);
    } finally { fixture.close(); }
  });
}

test("Responses image input and tool-result images survive a Chat-backed model crossing", async () => {
  let sent;
  const fixture = gatewayFixture(async (url, options) => {
    sent = JSON.parse(options.body);
    return json({ id: "chat_1", choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
  });
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Image bridge");
    await fixture.start();
    const image = { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" };
    const response = await fetch(`${fixture.baseUrl}/v1/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3", input: [
        { role: "user", content: [{ type: "input_text", text: "Inspect" }, image] },
        { type: "function_call", name: "Read", call_id: "call_1", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: [{ type: "input_text", text: "Screenshot" }, image] }
      ] })
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(sent.messages[0].content[1].image_url.url, image.image_url);
    assert.equal(sent.messages[2].content, "Screenshot");
    assert.equal(sent.messages[3].content[1].image_url.detail, "high");
  } finally { fixture.close(); }
});

test("tool JSON deltas reach Claude Code before the upstream turn finishes", async () => {
  let upstreamController;
  const fixture = gatewayFixture(async () => new Response(new ReadableStream({ start(controller) { upstreamController = controller; } }), { headers: { "content-type": "text/event-stream" } }));
  const encode = (data) => new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Incremental tools");
    await fixture.start();
    const pending = fetch(`${fixture.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ model: "kimi-k3", stream: true, messages: [{ role: "user", content: "Read" }] }) });
    for (let attempt = 0; !upstreamController && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(upstreamController);
    upstreamController.enqueue(encode({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: '{"path":' } }] } }] }));
    const response = await pending;
    const reader = response.body.getReader();
    let text = "";
    while (!text.includes("input_json_delta")) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /tool_use/);
    assert.doesNotMatch(text, /message_stop/);
    upstreamController.enqueue(encode({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: "tool_calls" }] }));
    upstreamController.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    upstreamController.close();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    const events = parseAnthropicStream(text);
    assert.equal(events.filter((event) => event.delta?.type === "input_json_delta").map((event) => event.delta.partial_json).join(""), '{"path":"a.txt"}');
    assert.equal(events.at(-1).type, "message_stop");
  } finally { fixture.close(); }
});

for (const [path, model] of [["/v1/messages", "gpt-test"], ["/v1/responses", "gpt-test"], ["/v1/responses", "kimi-k3"], ["/v1/chat/completions", "claude-sonnet-5"]]) {
  test(`client disconnect cancels the upstream across ${model} ${path}`, async () => {
    let cancelled = false;
    let upstreamSignal;
    let notifyCancelled;
    const cancellation = new Promise((resolve) => { notifyCancelled = resolve; });
    const fixture = gatewayFixture(async (url, options) => {
      upstreamSignal = options.signal;
      const event = url.pathname === "/v1/responses" ? { type: "response.created", response: { id: "resp_1" } }
        : url.pathname === "/v1/messages" ? { type: "message_start", message: { id: "msg_1", model, usage: { input_tokens: 1 } } }
          : { choices: [{ delta: { content: "Hello" } }] };
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          if (url.pathname === "/v1/responses") controller.enqueue(Buffer.from(`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" })}\n\n`));
          if (url.pathname === "/v1/messages") controller.enqueue(Buffer.from(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}\n\n`));
        },
        cancel() { cancelled = true; notifyCancelled(); }
      }), { headers: { "content-type": "text/event-stream" } });
    });
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Disconnect test");
      await fixture.start();
      const response = await fetch(`${fixture.baseUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, stream: true, ...(path === "/v1/responses" ? { input: "Hello" } : { messages: [{ role: "user", content: "Hello" }] }) }) });
      const reader = response.body.getReader();
      await reader.read();
      await reader.cancel();
      let timer;
      try { await Promise.race([cancellation, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("upstream cancellation did not propagate")), 1000); })]); }
      finally { clearTimeout(timer); }
      assert.equal(cancelled, true);
      assert.equal(upstreamSignal.aborted, true);
    } finally { fixture.close(); }
  });
}

for (const stream of [false, true]) {
  test(`native GPT merges partial completed output and deduplicates tool events (stream=${stream})`, async () => {
    const message = { id: "msg_1", type: "message", content: [{ type: "output_text", text: "Checking" }] };
    const call = { id: "fc_1", type: "function_call", call_id: "call_1", name: "Read", arguments: "{}" };
    const fixture = gatewayFixture(async () => responsesSse([
      { type: "response.output_item.done", output_index: 1, item: call },
      { type: "response.output_item.done", output_index: 1, item: call },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response: { id: "resp_1", output: [message] } }
    ]));
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Partial output test");
      await fixture.start();
      const response = await fetch(`${fixture.baseUrl}/v1/responses`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-test", stream, input: "Read" }) });
      assert.equal(response.status, 200);
      const wire = await response.text();
      const result = stream ? JSON.parse(wire.trim().split("\n").at(-1).slice(5)).response : JSON.parse(wire);
      assert.deepEqual(result.output, [message, call]);
    } finally { fixture.close(); }
  });
}

test("a truncated tool argument stream never emits a successful Anthropic stop", async () => {
  const fixture = gatewayFixture(async () => sse({ choices: [{ delta: { tool_calls: [{ id: "call_1", index: 0, function: { name: "Read", arguments: '{"path":' } }] }, finish_reason: "tool_calls" }] }));
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Invalid arguments");
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ model: "kimi-k3", stream: true, messages: [{ role: "user", content: "Read" }] }) });
    const events = parseAnthropicStream(await response.text());
    assert.ok(events.some((event) => event.type === "error"));
    assert.ok(!events.some((event) => event.type === "message_stop"));
  } finally { fixture.close(); }
});

for (const path of ["/v1/messages", "/v1/responses", "/v1/chat/completions"]) {
  test(`body idle timeout terminates a non-streaming GPT request through ${path}`, async () => {
    let cancelled = false;
    const fixture = gatewayFixture(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }), { streamIdleTimeoutMs: 20 });
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Idle timeout");
      await fixture.start();
      const response = await fetch(`${fixture.baseUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-test", ...(path === "/v1/responses" ? { input: "Hello" } : { messages: [{ role: "user", content: "Hello" }] }) }) });
      assert.equal(response.status, 502);
      assert.match((await response.json()).error.message, /idle timeout/);
      assert.equal(cancelled, true);
    } finally { fixture.close(); }
  });
}

for (const model of ["gpt-test", "kimi-k3", "claude-sonnet-5"]) {
  test(`Messages preserves system history and turn scope for ${model}`, async () => {
    const messages = [
      { role: "user", content: "Inspect" },
      { role: "system", clear_at: "next_user_message", content: "Expired reminder" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_read", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_read", content: "file content" }] },
      { role: "system", content: [{ type: "text", text: "Permanent instruction" }] },
      { role: "system", clear_at: "next_user_message", content: "Current reminder" }
    ];
    const fixture = gatewayFixture(async (url, options) => {
      const sent = JSON.parse(options.body);
      if (model.startsWith("claude")) {
        // History and turn scope survive untouched; on top of them the cache preparation
        // rewrites the string shorthand into blocks and spends the spare breakpoints on the
        // recent user turns.
        assert.deepEqual(sent.messages, [
          { role: "user", content: [{ type: "text", text: "Inspect", cache_control: { type: "ephemeral" } }] },
          { role: "system", clear_at: "next_user_message", content: [{ type: "text", text: "Expired reminder" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "call_read", name: "Read", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_read", content: "file content", cache_control: { type: "ephemeral" } }] },
          { role: "system", content: [{ type: "text", text: "Permanent instruction" }] },
          { role: "system", clear_at: "next_user_message", content: [{ type: "text", text: "Current reminder" }] }
        ]);
        return json({ type: "message", role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
      }
      const history = sent.input || sent.messages;
      assert.equal(JSON.stringify(history).includes("Expired reminder"), false);
      assert.deepEqual(history.slice(-2).map((item) => item.role), sent.input ? ["developer", "developer"] : ["system", "system"]);
      if (sent.input) {
        assert.equal(sent.instructions, "Initial instruction");
        assert.equal(history.at(-1).content[0].text, "Current reminder");
        return responsesSse([{ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] } }]);
      }
      assert.equal(history.at(-1).content, "Current reminder");
      return json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
    }, { reasoningMode: "passthrough" });
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("System history");
      await fixture.start();
      const system = model.startsWith("claude") ? [{ type: "text", text: "Initial instruction", cache_control: { type: "ephemeral" } }] : "Initial instruction";
      const response = await fetch(`${fixture.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ model, system, max_tokens: 1024, messages }) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).content[0].text, "OK");
    } finally { fixture.close(); }
  });
}

test("native GPT Responses translates inline system roles without moving instructions", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    const sent = JSON.parse(options.body);
    assert.deepEqual(sent.input.map((item) => item.role), ["user", "developer", "assistant", "developer"]);
    assert.equal(sent.input[1].content, "Middle instruction");
    assert.equal(sent.instructions, "Initial instruction");
    return responsesSse([{ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] } }]);
  });
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Native system normalization");
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/responses`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-test", instructions: "Initial instruction", input: [
      { role: "user", content: "Continue" }, { role: "system", content: "Middle instruction" },
      { role: "assistant", content: "Working" }, { type: "message", role: "system", content: [{ type: "input_text", text: "Final instruction" }] }
    ] }) });
    assert.equal(response.status, 200);
    await response.text();
  } finally { fixture.close(); }
});

test("GPT Messages applies mid-conversation client tool additions and removals", async () => {
  const fixture = gatewayFixture(async (url, options) => {
    const sent = JSON.parse(options.body);
    assert.deepEqual(sent.tools.map((tool) => tool.name), ["Edit"]);
    assert.deepEqual(sent.tool_choice, { type: "function", name: "Edit" });
    return responsesSse([{ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] } }]);
  });
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Tool availability");
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-test", tools: [
      { name: "Read", input_schema: { type: "object" } }, { name: "Edit", input_schema: { type: "object" }, defer_loading: true }
    ], tool_choice: { type: "tool", name: "Edit" }, messages: [{ role: "user", content: "Edit" }, { role: "system", content: [
      { type: "tool_removal", tool: { type: "tool_reference", name: "Read" } }, { type: "tool_addition", tool: { type: "tool_reference", name: "Edit" } }
    ] }] }) });
    assert.equal(response.status, 200);
    await response.text();
  } finally { fixture.close(); }
});

for (const model of ["gpt-test", "kimi-k3"]) {
  test(`${model} silent translated streams receive local heartbeats and still cancel upstream`, async (context) => {
    const originalSetInterval = globalThis.setInterval;
    context.mock.method(globalThis, "setInterval", (callback, interval, ...args) => originalSetInterval(callback, interval === 15_000 ? 10 : interval, ...args));
    let cancelled = false;
    const fixture = gatewayFixture(async () => new Response(new ReadableStream({
      cancel() { cancelled = true; }
    }), { headers: { "content-type": "text/event-stream" } }), { streamIdleTimeoutMs: 5000 });
    const controller = new AbortController();
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Local heartbeat");
      await fixture.start();
      const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
        method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "Continue" }] }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)])
      });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.match(new TextDecoder().decode(first.value), /event: ping/);
      assert.doesNotMatch(new TextDecoder().decode(first.value), /event: message_stop/);
      controller.abort();
      for (let attempt = 0; attempt < 50 && !cancelled; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(cancelled, true);
    } finally { controller.abort(); fixture.close(); }
  });
}

test("GPT heartbeats reach Anthropic before the upstream finishes and cancellation propagates", async () => {
  let cancelled = false;
  const fixture = gatewayFixture(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(": upstream heartbeat\n\n")); },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } }), { streamIdleTimeoutMs: 5000 });
  const controller = new AbortController();
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Heartbeat forwarding");
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Continue" }] }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]) });
    const reader = response.body.getReader();
    let wire = "";
    while (!wire.includes("event: ping")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      wire += new TextDecoder().decode(chunk.value);
    }
    assert.equal(wire.includes("event: message_stop"), false);
    assert.equal(wire.includes("event: content_block_delta"), false);
    controller.abort();
    for (let attempt = 0; attempt < 50 && !cancelled; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cancelled, true);
  } finally { controller.abort(); fixture.close(); }
});

for (const stream of [true, false]) {
  test(`native Codex namespace custom tools survive a full history round-trip (stream=${stream})`, async () => {
    const call = { type: "custom_tool_call", id: "ctc_patch", call_id: "call_patch", name: "functions__apply_patch", input: "*** Begin Patch\n*** End Patch" };
    const expected = { ...call, name: "apply_patch", namespace: "functions" };
    let turns = 0;
    const fixture = gatewayFixture(async (url, options) => {
      const sent = JSON.parse(options.body);
      assert.equal(sent.tools[0].type, "custom");
      assert.equal(sent.tools[0].name, "functions__apply_patch");
      assert.deepEqual(sent.tools[0].format, { type: "text" });
      turns += 1;
      if (turns === 2) {
        assert.deepEqual(sent.input[1], call);
        assert.deepEqual(sent.input[2], { type: "custom_tool_call_output", call_id: "call_patch", output: "Success" });
      }
      return responsesSse([
        { type: "response.output_item.added", output_index: 0, item: { ...call, input: "" } },
        { type: "response.custom_tool_call_input.delta", item_id: call.id, output_index: 0, delta: call.input },
        { type: "response.custom_tool_call_input.done", item_id: call.id, output_index: 0, name: call.name, input: call.input },
        { type: "response.output_item.done", output_index: 0, item: call },
        { type: "response.completed", response: { output: [] } }
      ]);
    });
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Codex namespace roundtrip");
      await fixture.start();
      const input = [{ role: "user", content: "Patch" }];
      for (let turn = 0; turn < 2; turn += 1) {
        const response = await fetch(`${fixture.baseUrl}/v1/responses`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-test", stream, tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "apply_patch", format: { type: "text" } }] }], input }) });
        assert.equal(response.status, 200);
        const wire = await response.text();
        if (stream) {
          const events = wire.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5)));
          assert.equal(events[0].item.namespace, "functions");
          assert.equal(events[1].delta, call.input);
          assert.deepEqual(events.find((event) => event.type === "response.output_item.done").item, expected);
          assert.deepEqual(events.at(-1).response.output, [expected]);
        } else assert.deepEqual(JSON.parse(wire).output, [expected]);
        input.push(expected, { type: "custom_tool_call_output", call_id: "call_patch", output: "Success" });
      }
      assert.equal(turns, 2);
    } finally { fixture.close(); }
  });
}

for (const contentType of ["application/json", "text/plain; charset=utf-8", null]) {
  for (const stream of [true, false]) {
    for (const terminal of ["completed", "incomplete"]) {
      test(`GPT Anthropic logs usage and ${terminal} with ${contentType || "missing content type"} (stream=${stream})`, async () => {
        let cancelled = false;
        const fixture = gatewayFixture(async (url, options) => {
          assert.equal(url.pathname, "/v1/responses");
          assert.equal(JSON.parse(options.body).stream, true);
          const events = [
            { type: "response.created", response: { id: "resp_gpt_log", output: [] } },
            { type: "response.output_text.delta", item_id: "msg_log", output_index: 0, content_index: 0, delta: "Hello" },
            { type: `response.${terminal}`, response: {
              id: "resp_gpt_log", status: terminal, output: [],
              usage: { input_tokens: 80, output_tokens: 9, input_tokens_details: { cached_tokens: 60 } }
            } }
          ];
          const bytes = Buffer.from(`: heartbeat\r\n\r\n${events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("")}`);
          return new Response(new ReadableStream({
            start(controller) {
              for (let offset = 0; offset < bytes.length; offset += 11) controller.enqueue(bytes.subarray(offset, offset + 11));
            },
            cancel() { cancelled = true; }
          }), { headers: { ...(contentType ? { "content-type": contentType } : {}), "x-request-id": "req_gpt_log" } });
        });
        try {
          const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("GPT Anthropic logging");
          await fixture.start();
          const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
            method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
            body: JSON.stringify({ model: "gpt-test", max_tokens: 256, stream, messages: [{ role: "user", content: "Hello" }] }),
            signal: AbortSignal.timeout(3000)
          });
          assert.equal(response.status, 200);
          const wire = await response.text();
          const payload = stream ? wire.split(/\r?\n\r?\n/).filter(Boolean)
            .map((frame) => JSON.parse(frame.split(/\r?\n/).find((line) => line.startsWith("data:")).slice(5)))
            .find((event) => event.type === "message_delta") : JSON.parse(wire);
          assert.deepEqual(payload.usage, { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 60 });
          assert.equal(stream ? payload.delta.stop_reason : payload.stop_reason, terminal === "incomplete" ? "max_tokens" : "end_turn");
          assert.equal(cancelled, true);

          const [entry] = await requestLogs(fixture);
          assert.equal(entry.protocol, "Anthropic");
          assert.equal(entry.model, "gpt-test");
          assert.equal(entry.stage, terminal);
          assert.equal(entry.status, 200);
          assert.equal(entry.upstreamStatus, 200);
          assert.equal(entry.upstreamStream, true);
          assert.equal(entry.pending, false);
          assert.equal(entry.lastEvent, `response.${terminal}`);
          assert.equal(entry.eventCounts[`response.${terminal}`], 1);
          assert.equal(entry.upstreamRequestId, "req_gpt_log");
          assert.equal(entry.inputTokens, 80);
          assert.equal(entry.outputTokens, 9);
          assert.equal(entry.cacheReadTokens, 60);
          assert.equal(entry.inputTokenSemantics, "inclusive_cache");
          assert.equal(entry.uncachedInputTokens, 20);
          assert.equal(entry.streamError, null);
        } finally { fixture.close(); }
      });
    }
  }
}

test("GPT Anthropic logs failed events in mislabeled streams without claiming success", async () => {
  const fixture = gatewayFixture(async () => new Response([
    { type: "response.created", response: { id: "resp_failed", output: [] } },
    { type: "response.failed", response: { error: { message: "Upstream failed" } } }
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "application/json" } }));
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("GPT failed logging");
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.message, "Upstream failed");
    const [entry] = await requestLogs(fixture);
    assert.equal(entry.upstreamStatus, 200);
    assert.equal(entry.stage, "failed");
    assert.equal(entry.status, 502);
    assert.equal(entry.streamError, "upstream_stream_error");
    assert.equal(entry.inputTokens, null);
    assert.equal(entry.outputTokens, null);
    assert.equal(entry.pending, false);
  } finally { fixture.close(); }
});

for (const model of ["kimi-k3", "claude-sonnet-5", "gpt-test"]) {
  test(`streaming chat rejects empty ${model} output before sending successful headers`, async () => {
    const fixture = gatewayFixture(async (url) => emptyChatUpstream(url.pathname));
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Empty chat stream");
      await fixture.start();
      const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "Hello" }] })
      });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, "upstream_empty_stream");
      const login = await fetch(`${fixture.baseUrl}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "console", password: "correct-password" })
      });
      const cookie = login.headers.get("set-cookie").split(";")[0];
      await login.text();
      const logs = await (await fetch(`${fixture.baseUrl}/api/usage-log`, { headers: { Cookie: cookie } })).json();
      assert.equal(logs.entries[0].status, 502);
      assert.equal(logs.entries[0].upstreamStatus, 200);
      assert.equal(logs.entries[0].streamError, "upstream_empty_stream");
    } finally { fixture.close(); }
  });
}

for (const stream of [true, false]) {
  test(`GPT Messages rejects empty Responses output (stream=${stream})`, async () => {
    const fixture = gatewayFixture(async () => emptyChatUpstream("/v1/responses"));
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Empty GPT Messages");
      await fixture.start();
      const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
        method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", max_tokens: 256, stream, messages: [{ role: "user", content: "Hello" }] })
      });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).type, "error");
      const [entry] = await requestLogs(fixture);
      assert.equal(entry.protocol, "Anthropic");
      assert.equal(entry.upstreamProtocol, "OpenAI Responses");
      assert.equal(entry.streamError, "upstream_empty_stream");
    } finally { fixture.close(); }
  });
}

test("GPT Messages reports delayed empty output as an error without a successful stop", async () => {
  let timer;
  const fixture = gatewayFixture(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(": heartbeat\n\n"));
      timer = setTimeout(() => {
        controller.enqueue(Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_empty", output: [] } })}\n\n`));
        controller.close();
      }, 400);
    },
    cancel() { clearTimeout(timer); }
  }), { headers: { "content-type": "text/event-stream" } }));
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Delayed empty GPT Messages");
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", max_tokens: 256, stream: true, messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(response.status, 200);
    const wire = await response.text();
    assert.match(wire, /event: error/);
    assert.doesNotMatch(wire, /event: message_stop/);
    const [entry] = await requestLogs(fixture);
    assert.equal(entry.status, 502);
    assert.equal(entry.stage, "failed");
  } finally { clearTimeout(timer); fixture.close(); }
});

test("GPT Messages retries empty Responses output before sending Anthropic frames", async () => {
  const accounts = [];
  const fixture = gatewayFixture(async (url, options) => {
    accounts.push(options.headers.Authorization);
    if (accounts.length === 1) return emptyChatUpstream("/v1/responses");
    return responsesSse([
      { type: "response.output_text.delta", item_id: "msg_recovered", output_index: 0, content_index: 0, delta: "Recovered" },
      { type: "response.completed", response: { id: "resp_recovered", output: [] } }
    ]);
  }, { accountCount: 2 });
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("GPT Messages retry");
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
      method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", max_tokens: 256, stream: true, messages: [{ role: "user", content: "Hello" }] })
    });
    const wire = await response.text();
    assert.equal(response.status, 200);
    assert.match(wire, /Recovered/);
    assert.match(wire, /message_stop/);
    assert.doesNotMatch(wire, /resp_empty/);
    assert.equal(accounts.length, 2);
    assert.notEqual(accounts[0], accounts[1]);
  } finally { fixture.close(); }
});

test("streaming chat retries an empty account without leaking its frames", async () => {
  const accounts = [];
  const fixture = gatewayFixture(async (url, options) => {
    accounts.push(options.headers.Authorization);
    if (accounts.length === 1) return sse({ id: "empty_attempt", choices: [{ delta: { role: "assistant" }, finish_reason: "stop" }] });
    return sse({ choices: [{ delta: { content: "Recovered" }, finish_reason: "stop" }] });
  }, { accountCount: 2 });
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Empty stream retry");
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3", stream: true, messages: [{ role: "user", content: "Hello" }] })
    });
    const wire = await response.text();
    assert.equal(response.status, 200);
    assert.match(wire, /Recovered/);
    assert.doesNotMatch(wire, /empty_attempt/);
    assert.equal(accounts.length, 2);
    assert.notEqual(accounts[0], accounts[1]);
  } finally { fixture.close(); }
});

test("Claude chat preserves text supplied in content_block_start", async () => {
  const fixture = gatewayFixture(async () => responsesSse([
    { type: "message_start", message: { id: "msg_initial", model: "claude-sonnet-5" } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "Initial answer" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" }
  ]));
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Initial Claude content");
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Initial answer/);
  } finally { fixture.close(); }
});

test("empty chat retries stop at the existing server-fault attempt cap", async () => {
  let attempts = 0;
  const fixture = gatewayFixture(async () => { attempts += 1; return sse(); }, { accountCount: 5 });
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Bounded empty retries");
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3", stream: true, messages: [{ role: "user", content: "Hello" }] })
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "upstream_empty_stream");
    assert.equal(attempts, 3);
  } finally { fixture.close(); }
});

for (const [name, createUpstream, code] of [
  ["JSON empty completion", () => json({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }), "upstream_empty_stream"],
  ["bodyless success", () => new Response(null, { status: 204 }), "upstream_empty_stream"],
  ["SSE error", () => sse({ error: { code: "capacity_exhausted", message: "No capacity" } }), "capacity_exhausted"],
  ["non-JSON response", () => new Response("upstream unavailable"), "upstream_invalid_stream"]
]) {
  test(`streaming chat rejects ${name} without claiming success`, async () => {
    const fixture = gatewayFixture(async () => createUpstream());
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Invalid stream regression");
      await fixture.start();
      const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "kimi-k3", stream: true, messages: [{ role: "user", content: "Hello" }] })
      });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, code);
    } finally { fixture.close(); }
  });
}

function emptyChatUpstream(path) {
  if (path === "/v1/messages") return responsesSse([
    { type: "message_start", message: { id: "msg_empty" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" }
  ]);
  if (path === "/v1/responses") return responsesSse([
    { type: "response.created", response: { id: "resp_empty" } },
    { type: "response.completed", response: { id: "resp_empty", output: [] } }
  ]);
  return sse({ choices: [{ delta: { role: "assistant", content: "" }, finish_reason: "stop" }] });
}

function responsesSse(events, splitBytes = false) {
  const bytes = Buffer.from(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  const body = splitBytes ? new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }) : bytes;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function requestLogs(fixture) {
  const login = await fetch(`${fixture.baseUrl}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "console", password: "correct-password" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await login.text();
  const response = await fetch(`${fixture.baseUrl}/api/usage-log`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  return (await response.json()).entries;
}

for (const path of ["/v1/messages", "/v1/chat/completions", "/v1/responses", "/backend-api/codex/responses"]) {
  for (const stream of [false, true]) {
    test(`Codex automatic titles on ${path} (stream=${stream}) do not call upstream`, async () => {
      let upstreamCalls = 0;
      const fixture = gatewayFixture(async () => {
        upstreamCalls += 1;
        throw new Error("local title must not call upstream");
      });
      try {
        const key = new OpenAIKeyStore(fixture.apiKeyFile).create("local title test").key;
        await fixture.start();
        const prompt = "Generate a concise, single-line task title of at most 36 characters and under five words where possible. Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.\n\nUser prompt:\nFix duplicate requests";
        const body = {
          model: "gpt-6-astra", stream, max_tokens: 8192,
          ...(path.endsWith("responses") ? { input: prompt, store: false } : { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] })
        };
        const response = await fetch(`${fixture.baseUrl}${path}`, {
          method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        assert.equal(response.headers.get("x-mirasim-local-response"), "codex-title");
        assert.match(text, /Fix duplicate requests/);
        assert.equal(upstreamCalls, 0);
        if (stream) {
          assert.match(response.headers.get("content-type"), /text\/event-stream/);
          assert.match(text, path.endsWith("responses") ? /response.completed/ : path.endsWith("messages") ? /message_stop/ : /\[DONE\]/);
        } else assert.equal(JSON.parse(text).usage.total_tokens ?? JSON.parse(text).usage.output_tokens, 0);
      } finally { fixture.close(); }
    });
  }
}

for (const stream of [false, true]) {
  test(`real-world merged Codex title blocks avoid upstream (stream=${stream})`, async () => {
    let upstreamCalls = 0;
    const fixture = gatewayFixture(async () => {
      upstreamCalls += 1;
      throw new Error("merged automatic title must not call upstream");
    });
    try {
      const key = new OpenAIKeyStore(fixture.apiKeyFile).create("merged title regression").key;
      await fixture.start();
      const prompt = "Generate a concise, single-line task title of at most 36 characters and under five words where possible. Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.\n\nUser prompt:\n只回复 OK";
      const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-6-astra", max_tokens: 8192, stream, system: "Follow project instructions.",
          tools: Array.from({ length: 9 }, (_, index) => ({ name: `tool_${index}`, description: "tool", input_schema: { type: "object", properties: {} } })),
          messages: [{ role: "user", content: [
            { type: "text", text: "# AGENTS.md instructions for /home/test\n\nFollow project rules." },
            { type: "text", text: "<environment_context>\n<cwd>/home/test</cwd>\n</environment_context>" },
            { type: "text", text: prompt }
          ] }]
        })
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.equal(response.headers.get("x-mirasim-local-response"), "codex-title");
      assert.match(text, /只回复 OK/);
      assert.equal(upstreamCalls, 0);
      if (stream) {
        const events = parseAnthropicStream(text);
        assert.equal(events.at(-1).type, "message_stop");
        assert.equal(events.find((event) => event.type === "message_start").message.usage.input_tokens, 0);
        assert.equal(events.find((event) => event.type === "message_delta").usage.output_tokens, 0);
      } else assert.deepEqual(JSON.parse(text).usage, { input_tokens: 0, output_tokens: 0 });
    } finally { fixture.close(); }
  });
}

test("disabling local titles restores the upstream path and ordinary GPT requests still forward", async () => {
  for (const localCodexTitles of [true, false]) {
    let upstreamCalls = 0;
    const fixture = gatewayFixture(async () => {
      upstreamCalls += 1;
      return responsesSse([{ type: "response.completed", response: { id: "resp_forwarded", output: [{ type: "message", content: [{ type: "output_text", text: "From upstream" }] }] } }]);
    }, { localCodexTitles });
    try {
      const key = new OpenAIKeyStore(fixture.apiKeyFile).create("title forwarding test").key;
      await fixture.start();
      const prompt = localCodexTitles ? "Explain how to fix duplicate requests" : "Generate a concise, single-line task title of at most 36 characters and under five words where possible. Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.\n\nUser prompt:\nFix duplicate requests";
      const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-6-astra", max_tokens: 8192, messages: [{ role: "user", content: prompt }] })
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-mirasim-local-response"), null);
      assert.match(await response.text(), /From upstream/);
      assert.equal(upstreamCalls, 1);
    } finally { fixture.close(); }
  }
});

for (const path of ["/v1/responses", "/backend-api/codex/responses", "/v1/chat/completions"]) {
  for (const { model, stream } of ["gpt-test", "claude-haiku-4-5", "kimi-k3"].flatMap((model) => [false, true].map((stream) => ({ model, stream })))) {
    test(`client protocol logging preserves ${path} when forwarding ${model} (stream=${stream})`, async () => {
      const fixture = gatewayFixture(async (url) => {
        assert.equal(url.pathname, model === "gpt-test" ? "/v1/responses" : model === "kimi-k3" ? "/v1/chat/completions" : "/v1/messages");
        if (model === "kimi-k3") return sse({ choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] });
        if (model === "gpt-test") return responsesSse([{ type: "response.completed", response: {
          id: "resp_protocol", object: "response", status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }]
        } }]);
        return json({ id: "msg_protocol", type: "message", role: "assistant", model,
          content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
      });
      try {
        const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Client protocol regression");
        await fixture.start();
        const response = await fetch(`${fixture.baseUrl}${path}`, {
          method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, stream, ...(path.endsWith("responses")
            ? { input: "Hello", store: false } : { messages: [{ role: "user", content: "Hello" }] }) })
        });
        assert.equal(response.status, 200);
        const wire = await response.text();
        if (stream) {
          assert.match(response.headers.get("content-type"), /text\/event-stream/);
          assert.match(wire, path.endsWith("responses") ? /response\.completed/ : /\[DONE\]/);
        } else {
          assert.match(response.headers.get("content-type"), /application\/json/);
          assert.equal(JSON.parse(wire).object, path.endsWith("responses") ? "response" : "chat.completion");
        }
        const [entry] = await requestLogs(fixture);
        assert.equal(entry.path, path);
        assert.equal(entry.clientPath, path);
        assert.equal(entry.protocol, path.endsWith("responses") ? "OpenAI Responses" : "OpenAI Chat");
        assert.equal(entry.upstreamProtocol, model === "gpt-test" ? "OpenAI Responses" : model === "kimi-k3" ? "OpenAI Chat" : "Anthropic");
        assert.equal(entry.requestId, response.headers.get("x-mirasim-request-id"));
        assert.match(entry.requestId, /^[a-f0-9-]{36}$/);
        assert.equal(entry.model, model);
        assert.equal(entry.stream, stream);
      } finally { fixture.close(); }
    });
  }
}

for (const path of ["/v1/responses", "/backend-api/codex/responses", "/v1/chat/completions"]) {
  for (const model of ["gpt-test", "claude-haiku-4-5", "kimi-k3"]) {
    test(`OpenAI error envelope survives ${path} forwarding ${model}`, async () => {
      const fixture = gatewayFixture(async () => new Response(JSON.stringify({ type: "error", error: { type: "vendor_error", message: "Invalid tool schema", param: "tools", code: "invalid_schema" } }), { status: 400, headers: { "content-type": "application/json", "x-request-id": "upstream_error_id" } }));
      try {
        const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Error regression");
        await fixture.start();
        const response = await fetch(`${fixture.baseUrl}${path}`, {
          method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, stream: true, ...(path.endsWith("responses") ? { input: "Hi" } : { messages: [{ role: "user", content: "Hi" }] }) })
        });
        assert.equal(response.status, 400);
        assert.match(response.headers.get("content-type"), /application\/json/);
        assert.deepEqual(await response.json(), { error: { type: "invalid_request_error", message: "Invalid tool schema", param: "tools", code: "invalid_schema" } });
        const [entry] = await requestLogs(fixture);
        assert.equal(entry.requestId, response.headers.get("x-mirasim-request-id"));
        assert.equal(entry.upstreamStatus, 400);
        assert.equal(entry.upstreamRequestId, "upstream_error_id");
      } finally { fixture.close(); }
    });
  }
}

for (const stream of [false, true]) {
  test(`Responses structured output reaches Chat upstream (stream=${stream})`, async () => {
    const format = { type: "json_schema", name: "answer", strict: true, schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } };
    const fixture = gatewayFixture(async (url, options) => {
      assert.equal(url.pathname, "/v1/chat/completions");
      const { type, ...schema } = format;
      assert.deepEqual(JSON.parse(options.body).response_format, { type, json_schema: schema });
      return sse({ choices: [{ index: 0, delta: { content: '{"answer":"OK"}' }, finish_reason: "stop" }] });
    });
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Structured output regression");
      await fixture.start();
      const response = await fetch(`${fixture.baseUrl}/v1/responses`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "kimi-k3", input: "Reply as JSON", text: { format }, stream })
      });
      assert.equal(response.status, 200);
      if (stream) {
        const events = (await response.text()).split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5)));
        assert.deepEqual(events.find((event) => event.type === "response.completed").response.text.format, format);
      } else assert.deepEqual((await response.json()).text.format, format);
    } finally { fixture.close(); }
  });
}

test("unsupported structured Messages output is rejected rather than silently discarded", async () => {
  let calls = 0;
  const fixture = gatewayFixture(async () => { calls += 1; return json({}); });
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Unsupported format regression");
    await fixture.start();
    for (const path of ["/v1/chat/completions", "/v1/responses"]) {
      const response = await fetch(`${fixture.baseUrl}${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5", ...(path.endsWith("responses") ? { input: "Hi", text: { format: { type: "json_object" } } } : { messages: [{ role: "user", content: "Hi" }], response_format: { type: "json_object" } }) })
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error.message, /structured output is not supported/);
    }
    assert.equal(calls, 0);
  } finally { fixture.close(); }
});

for (const path of ["/v1/chat/completions", "/v1/responses", "/backend-api/codex/responses"]) {
  test(`rejected OpenAI requests remain visible with their incoming protocol on ${path}`, async () => {
    let calls = 0;
    const fixture = gatewayFixture(async () => { calls += 1; return json({}); });
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Rejected request regression");
      await fixture.start();
      for (const [authorization, body, status] of [
        [`Bearer ${key}`, JSON.stringify({ model: "gpt-test", stream: "true", input: "private input", messages: [{ role: "user", content: "private input" }] }), 400],
        [`Bearer ${key}`, "{", 400],
        ["Bearer invalid", "{}", 401]
      ]) {
        const response = await fetch(`${fixture.baseUrl}${path}`, { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body });
        assert.equal(response.status, status);
        assert.ok((await response.json()).error);
        const [entry] = await requestLogs(fixture);
        assert.equal(entry.requestId, response.headers.get("x-mirasim-request-id"));
        assert.equal(entry.clientPath, path);
        assert.equal(entry.protocol, path.endsWith("responses") ? "OpenAI Responses" : "OpenAI Chat");
        assert.equal(entry.status, status);
        assert.equal(entry.upstreamPath, null);
        assert.equal(entry.upstreamStatus, null);
        assert.equal(entry.pending, false);
        assert.equal(entry.stage, "failed");
        assert.doesNotMatch(JSON.stringify(entry), /private input/);
      }
      assert.equal(calls, 0);
    } finally { fixture.close(); }
  });
}

test("non-JSON upstream errors stay OpenAI JSON errors and preserve retry headers", async () => {
  const fixture = gatewayFixture(async () => new Response("<html>private provider error</html>", { status: 429, headers: { "content-type": "text/html", "retry-after": "30" } }));
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Plain error regression");
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}/v1/responses`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-test", input: "Hi" }) });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "30");
    assert.deepEqual(await response.json(), { error: { message: "The upstream request failed with HTTP 429.", type: "rate_limit_error", param: null, code: null } });
  } finally { fixture.close(); }
});

for (const path of ["/v1/responses", "/backend-api/codex/responses", "/v1/chat/completions", "/v1/messages"]) {
  for (const type of ["response.output_text.delta", "response.output_text.done"]) {
    test(`GPT delivers ${type} before completion through ${path}`, { timeout: 5000 }, async () => {
      let source;
      let timer;
      const encode = (event) => Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
      const fixture = gatewayFixture(async () => new Response(new ReadableStream({
        start(controller) {
          source = controller;
          controller.enqueue(encode({ type: "response.created", response: { id: "resp_latency", output: [] } }));
          timer = setTimeout(() => controller.enqueue(encode({ type, item_id: "msg_latency", output_index: 0, content_index: 0, ...(type.endsWith(".delta") ? { delta: "EARLY_TEXT" } : { text: "EARLY_TEXT" }) })), 100);
        },
        cancel() { clearTimeout(timer); }
      }), { headers: { "content-type": "application/json" } }));
      let reader;
      try {
        const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("GPT latency regression");
        await fixture.start();
        const response = await fetch(`${fixture.baseUrl}${path}`, {
          method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-test", stream: true, ...(path.endsWith("responses") ? { input: "Hi", store: false } : { messages: [{ role: "user", content: "Hi" }] }) }),
          signal: AbortSignal.timeout(3500)
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /text\/event-stream/);
        reader = response.body.getReader();
        let wire = "";
        while (!wire.includes("EARLY_TEXT")) {
          const result = await reader.read();
          assert.equal(result.done, false);
          wire += Buffer.from(result.value).toString();
        }
        const [active] = await requestLogs(fixture);
        assert.equal(active.pending, true);
        assert.equal(active.durationMs, null);
        assert.ok(active.ttfbMs < active.firstTextMs, JSON.stringify(active));
        assert.equal(active.firstOutputMs, active.firstTextMs);
        await new Promise((resolve) => setTimeout(resolve, 100));
        source.enqueue(encode({ type: "response.completed", response: { id: "resp_latency", object: "response", status: "completed", output: [{ id: "msg_latency", type: "message", role: "assistant", content: [{ type: "output_text", text: "EARLY_TEXT" }] }] } }));
        source.close();
        while (!(await reader.read()).done) {}
        const [completed] = await requestLogs(fixture);
        assert.equal(completed.pending, false);
        assert.equal(completed.firstTextMs, active.firstTextMs);
        assert.ok(completed.durationMs >= completed.firstTextMs + 80);
      } finally {
        clearTimeout(timer);
        await reader?.cancel().catch(() => {});
        fixture.close();
      }
    });
  }
}

for (const path of ["/v1/messages", "/v1/responses"]) {
  for (const named of [false, true]) {
    test(`GPT permanent stream errors survive ${path} without retrying (${named ? "named" : "typed"})`, async () => {
      let attempts = 0;
      const fixture = gatewayFixture(async () => {
        attempts += 1;
        const error = { ...(named ? {} : { type: "error" }), code: "context_length_exceeded", message: "Input exceeds the context window", param: "input" };
        return new Response(`${named ? "event: error\n" : ""}data: ${JSON.stringify(error)}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }, { accountCount: 3 });
      try {
        const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Stream error classification");
        await fixture.start();
        const response = await fetch(`${fixture.baseUrl}${path}`, {
          method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-test", stream: false, ...(path.endsWith("responses") ? { input: "Hi" } : { max_tokens: 32, messages: [{ role: "user", content: "Hi" }] }) })
        });
        assert.equal(response.status, 400);
        const result = await response.json();
        assert.equal(result.error.message, "Input exceeds the context window");
        assert.equal(result.error.type, "invalid_request_error");
        assert.equal(attempts, 1);
        const [entry] = await requestLogs(fixture);
        assert.equal(entry.streamError, "context_length_exceeded");
        assert.equal(entry.upstreamStatus, 200);
      } finally { fixture.close(); }
    });
  }
}

for (const path of ["/v1/messages", "/v1/responses", "/v1/chat/completions"]) {
  for (const failure of ["truncated", "error"]) {
    test(`non-streaming GPT retries ${failure} output before delivering ${path}`, async () => {
      let attempts = 0;
      const fixture = gatewayFixture(async () => {
        attempts += 1;
        if (attempts === 1) return responsesSse([
          { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Discard this partial answer" },
          ...(failure === "error" ? [{ type: "response.failed", response: { error: { type: "server_error", code: "upstream_unavailable", message: "Temporary failure" } } }] : [])
        ]);
        return responsesSse([{ type: "response.completed", response: {
          id: "resp_recovered", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Recovered answer" }] }]
        } }]);
      }, { accountCount: 2 });
      try {
        const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Non-streaming recovery");
        await fixture.start();
        const response = await fetch(`${fixture.baseUrl}${path}`, {
          method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-test", stream: false, ...(path.endsWith("responses") ? { input: "Hi" } : { max_tokens: 32, messages: [{ role: "user", content: "Hi" }] }) })
        });
        assert.equal(response.status, 200);
        const wire = await response.text();
        assert.match(wire, /Recovered answer/);
        assert.doesNotMatch(wire, /Discard this partial answer/);
        assert.equal(attempts, 2);
        const [entry] = await requestLogs(fixture);
        assert.equal(entry.status, 200);
        assert.equal(entry.stage, "completed");
        assert.equal(entry.streamError, null);
        assert.deepEqual(entry.attempts.map((attempt) => attempt.status), [502, 200]);
      } finally { fixture.close(); }
    });
  }
}

for (const stream of [true, false]) {
  for (const shape of ["typed", "named", "nested", "failed", "mislabeled"]) {
    test(`gpt-6.1-sol Chat keeps ${shape} parameter errors permanent (stream=${stream})`, async () => {
      let attempts = 0;
      const detail = {
        code: shape === "failed" ? "context_length_exceeded" : "unsupported_parameter",
        message: "Rejected parameter Bearer diagnostic-secret sk-diagnostic sess-diagnostic",
        param: shape === "failed" ? "input" : "text.format", status: 503
      };
      const fixture = gatewayFixture(async (url, options) => {
        attempts += 1;
        assert.equal(url.pathname, "/v1/responses");
        assert.equal(JSON.parse(options.body).model, "gpt-6.1-sol");
        const event = ["nested", "mislabeled"].includes(shape) ? { type: "error", error: { ...detail, type: shape === "mislabeled" ? "server_error" : "invalid_request_error" } }
          : shape === "failed" ? { type: "response.failed", response: { error: { ...detail, type: "invalid_request_error" } } }
          : { ...detail, ...(shape === "named" ? {} : { type: "error" }) };
        return shape === "named" ? new Response(`event: error\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } }) : responsesSse([event]);
      }, { accountCount: 4 });
      try {
        const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Sol parameter regression");
        await fixture.start();
        const response = await solChatRequest(fixture, key, stream);
        assert.equal(response.status, 400);
        const { error } = await response.json();
        assert.equal(error.type, "invalid_request_error");
        assert.equal(error.code, detail.code);
        assert.equal(error.param, detail.param);
        assert.equal(attempts, 1);
        const [entry] = await requestLogs(fixture);
        assert.equal(entry.model, "gpt-6.1-sol");
        assert.equal(entry.stage, "failed");
        assert.equal(entry.status, 400);
        assert.equal(entry.upstreamStatus, 200);
        assert.equal(entry.upstreamStream, true);
        assert.equal(entry.streamError, detail.code);
        assert.equal(entry.upstreamError.type, "invalid_request_error");
        assert.equal(entry.upstreamError.code, detail.code);
        assert.equal(entry.upstreamError.param, detail.param);
        assert.equal(entry.upstreamError.status, 400);
        assert.doesNotMatch(JSON.stringify(entry), /diagnostic-secret|sk-diagnostic|sess-diagnostic/);
      } finally { fixture.close(); }
    });
  }
}

for (const explicitStatus of [false, true]) {
  test(`sol streaming Chat recovers on attempt four from type-only overload (status=${explicitStatus})`, async () => {
    let attempts = 0;
    const fixture = gatewayFixture(async () => {
      attempts += 1;
      if (attempts <= 3) return responsesSse([{ type: "error", error: { type: "overloaded_error", message: "Try again", ...(explicitStatus ? { status: 503 } : {}) } }]);
      return responsesSse([{ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "Recovered answer" }] }] } }]);
    }, { accountCount: 5 });
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Sol congestion recovery");
      await fixture.start();
      const response = await solChatRequest(fixture, key);
      const wire = await response.text();
      assert.equal(response.status, 200);
      assert.equal(attempts, 4);
      assert.match(wire, /Recovered answer/);
      assert.match(wire, /"finish_reason":"stop"/);
      assert.doesNotMatch(wire, /Try again|overloaded_error/);
      const [entry] = await requestLogs(fixture);
      assert.equal(entry.stage, "completed");
      assert.equal(entry.streamError, null);
      assert.deepEqual(entry.attempts.map((attempt) => attempt.status), [explicitStatus ? 503 : 502, explicitStatus ? 503 : 502, explicitStatus ? 503 : 502, 200]);
    } finally { fixture.close(); }
  });
}

for (const explicitStatus of [false, true]) {
  test(`sol exhausted type-only overload reaches the caller unchanged (status=${explicitStatus})`, async () => {
    const fixture = gatewayFixture(async () => responsesSse([{ type: "response.failed", response: { error: { type: "overloaded_error", message: "Capacity unavailable", ...(explicitStatus ? { status: 503 } : {}) } } }]));
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Sol overload envelope");
      await fixture.start();
      const response = await solChatRequest(fixture, key);
      assert.equal(response.status, explicitStatus ? 503 : 502);
      assert.equal((await response.json()).error.type, "overloaded_error");
    } finally { fixture.close(); }
  });
}

test("sol ordinary stream faults retain the existing three-attempt budget", async () => {
  let attempts = 0;
  const fixture = gatewayFixture(async () => {
    attempts += 1;
    return responsesSse([{ type: "error", error: { type: "server_error", message: "Temporary failure" } }]);
  }, { accountCount: 5 });
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Sol ordinary fault budget");
    await fixture.start();
    const response = await solChatRequest(fixture, key);
    assert.equal(response.status, 502);
    await response.text();
    assert.equal(attempts, 3);
  } finally { fixture.close(); }
});

test("sol Chat waits for a delayed permanent error without committing or retrying", async () => {
  let attempts = 0;
  let timer;
  const fixture = gatewayFixture(async () => {
    attempts += 1;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('data: {"type":"response.created","response":{"id":"resp_delayed"}}\n\n'));
        timer = setTimeout(() => {
          controller.enqueue(Buffer.from('data: {"type":"error","code":"unsupported_value","message":"Unsupported value","param":"text.format"}\n\n'));
          controller.close();
        }, 300);
      },
      cancel() { clearTimeout(timer); }
    }), { headers: { "content-type": "text/event-stream" } });
  }, { accountCount: 3 });
  try {
    const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Sol delayed error");
    await fixture.start();
    const response = await solChatRequest(fixture, key);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.param, "text.format");
    assert.equal(attempts, 1);
  } finally { clearTimeout(timer); fixture.close(); }
});

for (const type of ["invalid_request_error", "overloaded_error"]) {
  test(`sol ${type} after delivered content never replays or emits successful finish`, async () => {
    let source;
    let attempts = 0;
    const fixture = gatewayFixture(async () => {
      attempts += 1;
      return new Response(new ReadableStream({ start(controller) {
        source = controller;
        controller.enqueue(Buffer.from('data: {"type":"response.output_text.delta","delta":"Partial answer"}\n\n'));
      } }), { headers: { "content-type": "text/event-stream" } });
    }, { accountCount: 4 });
    let reader;
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Sol committed error");
      await fixture.start();
      const response = await solChatRequest(fixture, key);
      assert.equal(response.status, 200);
      reader = response.body.getReader();
      let wire = "";
      while (!wire.includes("Partial answer")) {
        const result = await reader.read();
        assert.equal(result.done, false);
        wire += Buffer.from(result.value).toString();
      }
      const code = type === "invalid_request_error" ? "unsupported_value" : "model_capacity_exhausted";
      source.enqueue(Buffer.from(`data: ${JSON.stringify({ type: "response.failed", response: { error: { type, code, param: "model", message: "Failed Bearer late-secret sk-late", status: type === "invalid_request_error" ? 400 : 503 } } })}\n\n`));
      source.close();
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        wire += Buffer.from(result.value).toString();
      }
      assert.equal(attempts, 1);
      assert.match(wire, new RegExp(`"type":"${type}"`));
      assert.match(wire, new RegExp(`"code":"${code}"`));
      assert.match(wire, /"param":"model"/);
      assert.doesNotMatch(wire, /"finish_reason":"stop"/);
      assert.equal(wire.match(/data: \[DONE\]/g).length, 1);
      const [entry] = await requestLogs(fixture);
      assert.equal(entry.stage, "failed");
      assert.equal(entry.status, 502);
      assert.equal(entry.upstreamStatus, 200);
      assert.equal(entry.upstreamError.code, code);
      assert.equal(entry.upstreamError.param, "model");
      assert.doesNotMatch(JSON.stringify(entry), /late-secret|sk-late/);
    } finally { await reader?.cancel().catch(() => {}); fixture.close(); }
  });
}

for (const source of ["http", "stream"]) {
  test(`sol ${source} 403 remains terminal even with a permanent parameter code`, async () => {
    let attempts = 0;
    const fixture = gatewayFixture(async () => {
      attempts += 1;
      const error = { type: "invalid_request_error", code: "unsupported_parameter", param: "model", message: "Permission denied", status: 400 };
      return source === "http"
        ? new Response(JSON.stringify({ error }), { status: 403, headers: { "content-type": "application/json" } })
        : responsesSse([{ type: "error", status: 403, error }]);
    }, { accountCount: 4 });
    try {
      const { key } = new OpenAIKeyStore(fixture.apiKeyFile).create("Sol permission boundary");
      await fixture.start();
      const response = await solChatRequest(fixture, key);
      assert.equal(response.status, 403);
      const { error } = await response.json();
      assert.equal(error.type, "permission_error");
      assert.equal(error.code, "unsupported_parameter");
      assert.equal(attempts, 1);
      const [entry] = await requestLogs(fixture);
      assert.equal(entry.status, 403);
      assert.equal(entry.attempts.length, 1);
    } finally { fixture.close(); }
  });
}

function solChatRequest(fixture, key, stream = true) {
  return fetch(`${fixture.baseUrl}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-6.1-sol", stream, messages: [{ role: "user", content: "Hello" }] }),
    signal: AbortSignal.timeout(5000)
  });
}

function gatewayFixture(fetchImpl, { accountCount = 1, ...overrides } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-chat-bridge-"));
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

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

// A chat-completions stream, as the relay sends one.
function sse(...chunks) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify({ id: "chatcmpl-s", object: "chat.completion.chunk", model: "kimi-k3", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// Anthropic names every event twice — once on the `event:` line the SDK reads, once inside the
// payload — and a mismatch between the two is exactly the kind of break a client sees and this
// gateway would not.
function parseAnthropicStream(text) {
  return text.split("\n\n").filter(Boolean).map((frame) => {
    const name = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5));
    assert.equal(name, data.type, frame);
    return data;
  });
}
