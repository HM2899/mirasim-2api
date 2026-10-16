import assert from "node:assert/strict";
import test from "node:test";
import { readAnthropicCompletion } from "../src/anthropic-completion.js";

const start = { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude", content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 8 } } };
const finish = { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 7 } };
const stop = { type: "message_stop" };
const events = [
  start,
  { type: "ping" },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "思考" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "你好" } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_1", name: "read", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"main.js"}' } },
  { type: "content_block_stop", index: 2 },
  finish, stop
];

function upstream(values, options = {}) {
  const wire = values.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("");
  return new Response(new ReadableStream({
    start(controller) {
      for (const byte of Buffer.from(wire)) controller.enqueue(Uint8Array.of(byte));
      if (!options.holdOpen) controller.close();
    },
    cancel: options.cancel
  }), { headers: { "content-type": "text/event-stream" } });
}

test("native message aggregation preserves thinking signatures, tools, Unicode and usage", async () => {
  const message = await readAnthropicCompletion(upstream(events));
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: "思考", signature: "signed" },
    { type: "text", text: "你好" },
    { type: "tool_use", id: "call_1", name: "read", input: { path: "main.js" } }
  ]);
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.usage, { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 8 });
});

test("message_stop completes and cancels an upstream that stays open", async () => {
  let cancelled = false;
  await readAnthropicCompletion(upstream(events, { holdOpen: true, cancel() { cancelled = true; } }));
  assert.equal(cancelled, true);
});

for (const [name, values, expected] of [
  ["truncated", events.slice(0, -1), /ended before/],
  ["upstream error", [start, { type: "error", error: { message: "overloaded" } }], /overloaded/],
  ["unfinished block", [start, events[2], finish, stop], /before it completed/],
  ["missing start", [finish, stop], /missing its message start/],
  ["invalid tool JSON", [...events.slice(0, 11), events[12], finish, stop], /JSON/]
]) {
  test(`native message aggregation rejects ${name}`, async () => {
    await assert.rejects(readAnthropicCompletion(upstream(values)), expected);
  });
}
