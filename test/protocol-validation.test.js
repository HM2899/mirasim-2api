import assert from "node:assert/strict";
import test from "node:test";
import { validateAnthropicRequest, validateChatRequest, validateResponsesRequest } from "../src/protocol-validation.js";
import { chatToResponsesRequest } from "../src/responses-bridge.js";

for (const [field, value] of [["stream", "true"], ["parallel_tool_calls", 1], ["max_tokens", 0], ["max_completion_tokens", 1.5], ["n", 2], ["stream_options", []], ["stream_options", { include_usage: "true" }], ["response_format", { type: "json_schema" }]]) {
  test(`Chat rejects invalid ${field} before bridging`, () => {
    assert.match(validateChatRequest({ model: "gpt-test", messages: [{ role: "user", content: "Hi" }], [field]: value }), new RegExp(`^${field}`));
  });
}

for (const [field, value] of [["stream", "false"], ["parallel_tool_calls", "true"], ["max_output_tokens", -1], ["store", "false"], ["background", true], ["tool_choice", "invalid"], ["tool_choice", { type: "function" }], ["text", []], ["text", { format: { type: "json_schema" } }]]) {
  test(`Responses rejects invalid ${field} before forwarding`, () => {
    for (const bridge of [false, true]) {
      assert.match(validateResponsesRequest({ model: "gpt-test", input: "Hi", [field]: value }, { bridge }), new RegExp(`^${field}`));
    }
  });
}

test("valid OpenAI structured formats and native multiple choices remain accepted", () => {
  const schema = { name: "answer", schema: { type: "object", properties: {} }, strict: true };
  assert.equal(validateChatRequest({ model: "kimi-k3", messages: [{ role: "user", content: "Hi" }], n: 2, response_format: { type: "json_schema", json_schema: schema } }, { bridge: false }), null);
  assert.equal(validateResponsesRequest({ model: "gpt-test", input: "Hi", text: { format: { type: "json_schema", ...schema } } }), null);
});

test("Anthropic accepts mid-conversation system messages and validates their scope", () => {
  const request = (message) => ({ model: "gpt-test", messages: [{ role: "user", content: "Continue" }, message] });
  for (const bridge of [false, true]) {
    assert.equal(validateAnthropicRequest(request({ role: "system", content: "Reminder" }), { bridge }), null);
    assert.equal(validateAnthropicRequest(request({ role: "system", clear_at: "next_user_message", content: [{ type: "text", text: "Reminder" }] }), { bridge }), null);
    assert.match(validateAnthropicRequest(request({ role: "user", clear_at: "never", content: "Invalid" }), { bridge }), /clear_at/);
    assert.match(validateAnthropicRequest(request({ role: "system", clear_at: "invalid", content: "Invalid" }), { bridge }), /clear_at/);
    assert.match(validateAnthropicRequest(request({ role: "system", clear_at: "next_user_message", content: [{ type: "text", text: "Invalid", cache_control: { type: "ephemeral" } }] }), { bridge }), /cache_control/);
    assert.match(validateAnthropicRequest(request({ role: "tool", content: "Invalid" }), { bridge }), /messages\[1\]/);
  }
  const change = { role: "system", content: [{ type: "tool_addition", tool: { type: "tool_reference", name: "Read" } }] };
  assert.match(validateAnthropicRequest(request(change), { bridge: true }), /not declared/);
  assert.equal(validateAnthropicRequest({ ...request(change), tools: [{ name: "Read", input_schema: { type: "object" } }] }, { bridge: true }), null);
});

for (const [message, path] of [
  [null, "messages[0]"],
  [{ role: "user", content: [null] }, "messages[0].content[0]"],
  [{ role: "user", content: [{ type: "image_url" }] }, "messages[0].content[0].image_url.url"],
  [{ role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] }, "messages[0].tool_calls[0].function.name"],
  [{ role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: "{" } }] }, "messages[0].tool_calls[0].function.arguments"],
  [{ role: "tool", content: "output" }, "messages[0].tool_call_id"],
  [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }, "messages[0].content[0].type"]
]) {
  test(`invalid Chat input returns a field error rather than throwing: ${path}`, () => {
    const request = { model: "gpt-test", messages: [message] };
    assert.ok(validateChatRequest(request).startsWith(path));
    assert.equal(chatToResponsesRequest(request).ok, false);
  });
}

test("stateless Responses rejects stored state while accepting full native custom-tool history", () => {
  const base = { model: "gpt-test", input: "Hello" };
  assert.match(validateResponsesRequest({ ...base, previous_response_id: "resp_secret" }), /previous_response_id.*complete input history/);
  assert.match(validateResponsesRequest({ ...base, conversation: "conv_secret" }), /conversation/);
  assert.match(validateResponsesRequest({ ...base, input: [{ type: "item_reference", id: "msg_secret" }] }), /input\[0\].type/);
  assert.equal(validateResponsesRequest({ ...base, previous_response_id: null }), null);
  const native = { ...base, tools: [{ type: "custom", name: "apply_patch" }], input: [{ type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "apply_patch", input: "patch" }, { type: "custom_tool_call_output", call_id: "call_1", output: "OK" }] };
  assert.equal(validateResponsesRequest(native), null);
  assert.match(validateResponsesRequest(native, { bridge: true }), /input\[0\].type/);
  assert.match(validateResponsesRequest({ ...native, input: "Hello" }, { bridge: true }), /tools\[0\].type/);
});

test("cross-provider Responses supports URL images but rejects unresolved files and unknown items", () => {
  const request = (part) => ({ model: "kimi-k3", input: [{ role: "user", content: [part] }] });
  assert.equal(validateResponsesRequest(request({ type: "input_image", image_url: "data:image/png;base64,AAAA" }), { bridge: true }), null);
  assert.match(validateResponsesRequest(request({ type: "input_image", file_id: "file_1" }), { bridge: true }), /file_id/);
  assert.match(validateResponsesRequest(request({ type: "input_file", file_id: "file_1" }), { bridge: true }), /content\[0\].type/);
  assert.match(validateResponsesRequest({ model: "claude-test", input: [{ type: "reasoning", encrypted_content: "secret" }] }, { bridge: true }), /encrypted reasoning/);
});

test("Anthropic cross-provider requests explicitly reject hosted tools and documents", () => {
  const base = { model: "gpt-test", messages: [{ role: "user", content: "Hello" }] };
  assert.match(validateAnthropicRequest({ ...base, tools: [{ type: "web_search_20250305", name: "web_search" }] }, { bridge: true }), /tools\[0\]/);
  assert.match(validateAnthropicRequest({ ...base, messages: [{ role: "user", content: [{ type: "document", source: { file_id: "file_1" } }] }] }, { bridge: true }), /content\[0\].type/);
  assert.equal(validateAnthropicRequest({ ...base, tools: [{ type: "web_search_20250305", name: "web_search" }] }), null);
});

test("function declarations and forced tool choices are validated before conversion", () => {
  const base = { model: "gpt-test", messages: [{ role: "user", content: "Hello" }] };
  assert.match(validateChatRequest({ ...base, tools: [{ type: "function" }] }), /tools\[0\].function.name/);
  assert.match(validateChatRequest({ ...base, tool_choice: { type: "function" } }), /tool_choice/);
  assert.match(validateChatRequest({ ...base, tools: [{ type: "custom", name: "apply_patch" }] }), /tools\[0\].type/);
});
