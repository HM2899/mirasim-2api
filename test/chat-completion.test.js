import assert from "node:assert/strict";
import test from "node:test";
import { ensureChatCompletionStream, normalizeChatUpstream, readChatCompletion } from "../src/chat-completion.js";

for (const stream of [false, true]) {
  for (const [name, counters, expected] of [
    ["native cache hits", { prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 }, 80],
    ["zero cache hits", { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 }, 0],
    ["standard zero wins", { prompt_cache_hit_tokens: 80, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 3 } }, 0],
    ["existing details survive", { prompt_cache_hit_tokens: 80, prompt_tokens_details: { audio_tokens: 3 } }, 80],
    ["invalid standard count", { prompt_cache_hit_tokens: 80, prompt_tokens_details: { cached_tokens: -1 } }, 80],
    ["cache misses alone", { prompt_cache_miss_tokens: 100 }, undefined],
    ["negative native count", { prompt_cache_hit_tokens: -1 }, undefined],
    ["non-numeric native count", { prompt_cache_hit_tokens: "80" }, undefined]
  ]) {
    test(`chat usage normalizes ${name} (stream=${stream})`, async () => {
      const usage = { prompt_tokens: 100, completion_tokens: 2, ...counters };
      const upstream = stream ? sse([
        { choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] },
        { choices: [], usage }, "[DONE]"
      ]) : Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage });
      const completion = await readChatCompletion(await normalizeChatUpstream(upstream));
      assert.equal(completion.usage.prompt_tokens_details?.cached_tokens, expected);
      assert.equal(completion.usage.prompt_tokens_details?.audio_tokens, counters.prompt_tokens_details?.audio_tokens);
      if (!stream || Number.isFinite(counters.prompt_cache_hit_tokens) && counters.prompt_cache_hit_tokens >= 0) {
        assert.equal(completion.usage.prompt_cache_hit_tokens, counters.prompt_cache_hit_tokens);
      }
      assert.equal(completion.usage.prompt_cache_miss_tokens, counters.prompt_cache_miss_tokens);
      assert.equal(completion.usage.prompt_tokens, 100);
      assert.equal(completion.usage.cache_creation_input_tokens, undefined);
    });
  }
}

test("a completed chat stream returns and cancels without waiting for transport EOF", { timeout: 1000 }, async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":80}}}\n\ndata: [DONE]\n\ndata: {"error":{"message":"ignored after terminal"}}\n\n'));
    },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } });
  const completion = await readChatCompletion(await normalizeChatUpstream(upstream));
  assert.equal(completion.choices[0].message.content, "OK");
  assert.equal(completion.usage.prompt_tokens_details.cached_tokens, 80);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("SSE is collected with reasoning, tool fragments and cumulative usage", async () => {
  const completion = await readChatCompletion(sse([
    { id: "chat-1", model: "kimi-k3", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "先思考。" } }], usage: { prompt_tokens: 200, completion_tokens: 10 } },
    { choices: [{ index: 0, delta: { content: "答案" } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-read", function: { name: "read_file", arguments: '{"path":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"main.js"}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 0, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 8 }, prompt_tokens_details: { cached_tokens: 150 } } },
    "[DONE]"
  ]));
  assert.equal(completion.model, "kimi-k3");
  assert.equal(completion.choices[0].message.reasoning_content, "先思考。");
  assert.equal(completion.choices[0].message.content, "答案");
  assert.equal(completion.choices[0].message.tool_calls[0].function.arguments, '{"path":"main.js"}');
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
  assert.equal(completion.usage.prompt_tokens, 200);
  assert.equal(completion.usage.completion_tokens, 20);
  assert.equal(completion.usage.completion_tokens_details.reasoning_tokens, 8);
});

test("SSE accepts CRLF, multiline data, final unterminated frames and split Unicode", async () => {
  const wire = ': heartbeat\r\n\r\nevent: chunk\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"你好"},"finish_reason":"stop"}]}';
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const byte of new TextEncoder().encode(wire)) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
  assert.equal((await readChatCompletion(response)).choices[0].message.content, "你好");
});

for (const [name, chunks, message] of [
  ["empty", ["[DONE]"], /no completion choices/],
  ["role only", [{ choices: [{ delta: { role: "assistant" }, finish_reason: "stop" }] }, "[DONE]"], /without text/],
  ["truncated", [{ choices: [{ delta: { content: "partial" } }] }], /before it completed/],
  ["error", [{ error: { message: "capacity exhausted" } }], /capacity exhausted/]
]) {
  test(`${name} SSE does not become a successful empty completion`, async () => {
    await assert.rejects(readChatCompletion(sse(chunks)), message);
  });
}

test("reasoning-only length-limited responses are preserved, not labeled empty", async () => {
  const completion = await readChatCompletion(sse([{ choices: [{ delta: { reasoning_content: "Thinking" }, finish_reason: "length" }] }, "[DONE]"]));
  assert.equal(completion.choices[0].finish_reason, "length");
  assert.equal(completion.choices[0].message.reasoning_content, "Thinking");
});

test("ordinary JSON responses are unchanged even when usage is zero", async () => {
  const body = { choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0 } };
  assert.deepEqual(await readChatCompletion(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })), body);
});

test("a JSON chat fallback is emitted as valid SSE for a streaming caller", async () => {
  const upstream = new Response(JSON.stringify({
    id: "chat_json",
    object: "chat.completion",
    model: "deepseek-v4-pro",
    choices: [{ index: 0, message: { role: "assistant", reasoning_content: "先想。", content: "答案" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 3 }
  }), { headers: { "content-type": "application/json" } });
  const streamed = await ensureChatCompletionStream(upstream);
  assert.match(streamed.headers.get("content-type"), /text\/event-stream/);
  const wire = await streamed.text();
  assert.match(wire, /"reasoning_content":"先想。"/);
  assert.match(wire, /"content":"答案"/);
  assert.match(wire, /"finish_reason":"stop"/);
  assert.match(wire, /data: \[DONE\]/);
});

test("fragmented native reasoning markers never leak into a chat stream", async () => {
  const completion = await readChatCompletion(await normalizeChatUpstream(sse([
    { choices: [{ index: 0, delta: { reasoning_content: "<TH" } }] },
    { choices: [{ index: 0, delta: { reasoning_content: "INK>先分析" } }] },
    { choices: [{ index: 0, delta: { reasoning_content: "</THINK>" } }] },
    { choices: [{ index: 0, delta: { content: "答案" }, finish_reason: "stop" }] },
    "[DONE]"
  ])));
  assert.equal(completion.choices[0].message.reasoning_content, "先分析");
  assert.equal(completion.choices[0].message.content, "答案");
});

function sse(chunks) {
  return new Response(chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("chat JSON isolates inline reasoning without changing tools, usage or literal tags", async () => {
  const completion = { choices: [
    { index: 0, message: { content: "<think>思考</think>答案", reasoning: "前置。" }, finish_reason: "stop" },
    { index: 1, message: { content: "Example: <think>literal</think>" }, finish_reason: "stop" },
    { index: 2, message: { content: null, tool_calls: [{ id: "tool", function: { name: "read", arguments: "{}" } }] }, finish_reason: "tool_calls" }
  ], usage: { completion_tokens: 15 } };
  const upstream = new Response(JSON.stringify(completion), { headers: { "content-type": "application/json", "content-length": "999", "x-request-id": "trace" } });
  const normalized = await normalizeChatUpstream(upstream);
  const body = await normalized.json();
  assert.deepEqual(body.choices[0].message, { content: "答案", reasoning_content: "前置。思考" });
  assert.deepEqual(body.choices.slice(1), completion.choices.slice(1));
  assert.deepEqual(body.usage, completion.usage);
  assert.equal(normalized.headers.get("content-length"), null);
  assert.equal(normalized.headers.get("x-request-id"), "trace");
});

test("chat SSE separates fragmented UTF-8 thinking independently for every choice", async () => {
  const chunks = [
    { id: "chat", choices: [{ index: 0, delta: { content: "<th" } }, { index: 1, delta: { content: "Plain " } }] },
    { choices: [{ index: 0, delta: { content: "ink>想。</thi" } }, { index: 1, delta: { content: "<think>literal</think>" } }] },
    { choices: [{ index: 0, delta: { content: "nk>答", reasoning: "额外。" }, finish_reason: "stop" }, { index: 1, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 8 } }
  ];
  const wire = ": ping\r\n\r\n" + chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("") + "data: [DONE]";
  const upstream = new Response(new ReadableStream({ start(controller) {
    for (const byte of new TextEncoder().encode(wire)) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
  const completion = await readChatCompletion(await normalizeChatUpstream(upstream));
  assert.equal(completion.choices[0].message.content, "答");
  assert.equal(completion.choices[0].message.reasoning_content, "想。额外。");
  assert.equal(completion.choices[1].message.content, "Plain <think>literal</think>");
  assert.equal(completion.usage.completion_tokens, 8);
});

for (const tail of ["", "[DONE]"]) {
  test(`chat SSE flushes an unfinished opening tag before ${tail || "EOF"}`, async () => {
    const upstream = sse([{ id: "partial", choices: [{ index: 0, delta: { content: "<th" } }] }, ...(tail ? [tail] : [])]);
    const wire = await (await normalizeChatUpstream(upstream)).text();
    assert.ok(wire.includes('"content":"<th"'));
    if (tail) assert.ok(wire.indexOf('"content":"<th"') < wire.indexOf("[DONE]"));
    else assert.ok(!wire.includes("[DONE]"));
  });
}

test("normalization preserves HTTP error responses", async () => {
  const upstream = new Response("Rejected", { status: 400 });
  assert.equal(await normalizeChatUpstream(upstream), upstream);
});

test("completed message snapshots inside SSE become readable chat deltas", async () => {
  const upstream = sse([{
    object: "chat.completion",
    choices: [{ index: 0, message: {
      role: "assistant", content: "Answer", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }]
    }, finish_reason: "tool_calls" }]
  }, "[DONE]"]);
  const wire = await (await normalizeChatUpstream(upstream)).text();
  const chunk = JSON.parse(wire.split("\n")[0].slice(5));
  assert.equal(chunk.object, "chat.completion.chunk");
  assert.equal(chunk.choices[0].message, undefined);
  assert.equal(chunk.choices[0].delta.content, "Answer");
  assert.equal(chunk.choices[0].delta.tool_calls[0].index, 0);
});
