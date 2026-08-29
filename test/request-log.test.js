import assert from "node:assert/strict";
import test from "node:test";
import { RelayRequestLog } from "../src/request-log.js";

function sseUpstream(frames, contentType = "text/event-stream") {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    body: new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      }
    })
  };
}

test("request log captures model, reasoning effort and anthropic stream usage with timings", async () => {
  // now() is consumed in call order: open, first body chunk, finalize.
  const times = [1_000, 1_400, 1_900];
  const log = new RelayRequestLog({ now: () => (times.length > 1 ? times.shift() : times[0]) });
  const body = Buffer.from(JSON.stringify({ model: "claude-fable-5", stream: true, thinking: { type: "enabled", budget_tokens: 8192 } }));
  const entry = log.open("/v1/messages", body);
  assert.equal(entry.model, "claude-fable-5");
  assert.equal(entry.reasoningEffort, "budget:8192");
  assert.equal(entry.stream, true);
  assert.deepEqual(log.snapshot(), []);

  const wrapped = log.observe(entry, sseUpstream([
    `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 120, cache_read_input_tokens: 90, cache_creation_input_tokens: 30 } } })}\n\n`,
    // Anthropic repeats the usage object on the delta and zeroes the counts it already sent.
    `data: ${JSON.stringify({ type: "message_delta", usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 60 } })}\n\n`
  ]), { id: "user-a" });
  await new Response(wrapped.body).text();

  const [snapshot] = log.snapshot();
  assert.equal(snapshot.account, "user-a");
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.pending, false);
  assert.equal(snapshot.inputTokens, 120);
  assert.equal(snapshot.outputTokens, 60);
  assert.equal(snapshot.cacheReadTokens, 90);
  assert.equal(snapshot.cacheWriteTokens, 30);
  assert.equal(snapshot.ttfbMs, 400);
  assert.equal(snapshot.durationMs, 900);
  assert.equal("outputTokensPerSecond" in snapshot, false);
  assert.equal("startedAt" in snapshot, false);
});

test("request log parses non-stream chat completion usage and openai effort", async () => {
  const times = [0, 250, 300];
  const log = new RelayRequestLog({ now: () => (times.length > 1 ? times.shift() : times[0]) });
  const entry = log.open("/v1/chat/completions", Buffer.from(JSON.stringify({ model: "gpt-5", reasoning_effort: "high" })));
  assert.equal(entry.reasoningEffort, "high");
  assert.equal(entry.stream, false);

  const payload = { usage: { prompt_tokens: 200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 150 } } };
  const wrapped = log.observe(entry, sseUpstream([JSON.stringify(payload)], "application/json"), { id: "user-b" });
  assert.deepEqual(await wrapped.json(), payload);

  const [snapshot] = log.snapshot();
  assert.equal(snapshot.inputTokens, 200);
  assert.equal(snapshot.outputTokens, 40);
  assert.equal(snapshot.cacheReadTokens, 150);
  assert.equal(snapshot.cacheWriteTokens, null);
  assert.equal(snapshot.ttfbMs, 250);
  assert.equal(snapshot.durationMs, 300);
});

test("request log records failures and keeps only the newest entries", () => {
  const log = new RelayRequestLog({ maxEntries: 2, now: () => 0 });
  const first = log.open("/v1/messages", Buffer.from("{}"));
  log.fail(first, 400);
  const failed = log.open("/v1/messages", Buffer.from("not json"));
  log.fail(failed, 503);
  const third = log.open("/v1/messages", Buffer.from(JSON.stringify({ model: "claude-fable-5" })));

  const snapshot = log.snapshot();
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0].status, 503);
  assert.equal(snapshot[1].status, 400);
  assert.equal(snapshot.some((entry) => entry.id === third.id), false);
});

test("a thinking budget, a disabled request and a model-chosen effort all normalise", () => {
  const log = new RelayRequestLog({ now: () => 0 });
  const effortOf = (payload) => log.open("/v1/messages", Buffer.from(JSON.stringify(payload))).reasoningEffort;
  assert.equal(effortOf({ thinking: { type: "disabled" } }), "none");
  assert.equal(effortOf({ thinking: { type: "adaptive" } }), "adaptive");
  assert.equal(effortOf({ thinking: { type: "enabled" } }), "enabled");
  assert.equal(effortOf({ reasoning: { effort: "High" } }), "high");
  assert.equal(effortOf({}), null);
});

test("the usage chunk this gateway asked for is counted and then hidden from the client", async () => {
  const log = new RelayRequestLog({ now: () => 0 });
  const entry = log.open("/v1/chat/completions", Buffer.from(JSON.stringify({ model: "gpt-5", stream: true })));
  const usageChunk = { choices: [], usage: { prompt_tokens: 300, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 250 } } };
  const wrapped = log.observe(entry, sseUpstream([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`,
    `data: ${JSON.stringify(usageChunk)}\n\n`,
    "data: [DONE]\n\n"
  ]), { id: "user-c" }, { dropUsageOnlyFrames: true });
  const streamed = await new Response(wrapped.body).text();

  assert.match(streamed, /"content":"hi"/);
  assert.doesNotMatch(streamed, /usage/);
  assert.match(streamed, /data: \[DONE\]/);
  const [snapshot] = log.snapshot();
  assert.equal(snapshot.inputTokens, 300);
  assert.equal(snapshot.outputTokens, 20);
  assert.equal(snapshot.cacheReadTokens, 250);
});

test("a client that asked for usage itself still receives the usage chunk", async () => {
  const log = new RelayRequestLog({ now: () => 0 });
  const entry = log.open("/v1/chat/completions", Buffer.from(JSON.stringify({ model: "gpt-5", stream: true })));
  const wrapped = log.observe(entry, sseUpstream([
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 6 } })}\n\n`
  ]), { id: "user-d" });

  assert.match(await new Response(wrapped.body).text(), /"usage"/);
  assert.equal(log.snapshot()[0].inputTokens, 5);
});

test("Anthropic protocol logs top-level OpenAI usage counters from GPT relays", async () => {
  const log = new RelayRequestLog({ now: () => 0 });
  const entry = log.open("/v1/messages", Buffer.from(JSON.stringify({ model: "gpt-5" })));
  const wrapped = log.observe(entry, sseUpstream([
    `data: ${JSON.stringify({ input_tokens: 321, output_tokens: 17, cached_input_tokens: 8 })}`
  ], "text/event-stream"), { id: "gpt-account" });
  await new Response(wrapped.body).text();
  const [result] = log.snapshot();
  assert.equal(result.inputTokens, 321);
  assert.equal(result.outputTokens, 17);
  assert.equal(result.cacheReadTokens, 8);
});
