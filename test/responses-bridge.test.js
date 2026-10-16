import assert from "node:assert/strict";
import test from "node:test";

test("native preflight preserves pretty-printed relay parameter errors", async () => {
  const event = { type: "error", error: { type: "invalid_request_error", code: "unsupported_value", message: "Unsupported reasoning effort", param: "reasoning.effort" }, status: 400 };
  const upstream = new Response(`data: ${JSON.stringify(event, null, 2)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(primeResponsesStream(upstream), { code: "unsupported_value", statusCode: 400, param: "reasoning.effort", message: event.error.message });
});
import { readChatCompletion } from "../src/chat-completion.js";
import { chatToResponsesRequest, normalizeResponsesStream, primeResponsesStream, responseEvents, responsesUpstreamAsChat } from "../src/responses-bridge.js";
import { ResponseState } from "../src/response-state.js";
import { guardUpstreamResponse } from "../src/stream-lifecycle.js";

for (const named of [false, true]) {
  test(`native preflight preserves ${named ? "named" : "typed"} top-level upstream errors`, async () => {
    const event = { ...(named ? {} : { type: "error" }), code: "context_length_exceeded", message: "Input exceeds the context window", param: "input" };
    const upstream = new Response(`${named ? "event: error\n" : ""}data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    await assert.rejects(primeResponsesStream(upstream), {
      code: "context_length_exceeded", statusCode: 400, message: event.message, param: "input"
    });
  });
}

test("named response events retain their output during preflight", async () => {
  const wire = 'event: response.output_text.delta\ndata: {"delta":"OK"}\n\nevent: response.completed\ndata: {"response":{"output":[]}}\n\n';
  const upstream = new Response(wire, { headers: { "content-type": "text/event-stream" } });
  const primed = await primeResponsesStream(upstream);
  assert.equal(await primed.text(), wire);
});

function streamResponse(events) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

for (const shape of ["typed", "named", "nested", "failed"]) {
  test(`Responses preflight and Chat bridge preserve ${shape} parameter error fields`, async () => {
    const detail = { code: "unsupported_parameter", message: "Unsupported parameter", param: "text.format", status: 503 };
    const event = shape === "nested" ? { type: "error", error: { ...detail, type: "invalid_request_error" } }
      : shape === "failed" ? { type: "response.failed", response: { error: { ...detail, type: "invalid_request_error" } } }
      : { ...detail, ...(shape === "named" ? {} : { type: "error" }) };
    const upstream = () => shape === "named"
      ? new Response(`event: error\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : streamResponse([event]);
    await assert.rejects(primeResponsesStream(upstream()), {
      code: detail.code, type: "invalid_request_error", param: detail.param, statusCode: 400
    });
    const wire = await responsesUpstreamAsChat(upstream(), "gpt-6.1-sol").text();
    const payload = wire.split("\n\n").find((frame) => frame.includes('"error"'));
    assert.deepEqual(JSON.parse(payload.slice(6)).error, { ...detail, type: "invalid_request_error", status: 400 });
    assert.doesNotMatch(wire, /"finish_reason":"stop"/);
    assert.equal(wire.match(/data: \[DONE\]/g).length, 1);
  });
}

for (const status of [403, 503]) {
  test(`Responses errors retain nested HTTP ${status} with permission denial taking precedence`, async () => {
    const event = { type: "response.failed", response: { error: { type: "overloaded_error", message: "Unavailable", status } } };
    const type = status === 403 ? "permission_error" : "overloaded_error";
    await assert.rejects(primeResponsesStream(streamResponse([event])), { type, statusCode: status });
    const wire = await responsesUpstreamAsChat(streamResponse([event]), "gpt-6.1-sol").text();
    assert.match(wire, new RegExp(`"type":"${type}"`));
    assert.match(wire, new RegExp(`"status":${status}`));
  });
}

test("complete preflight releases a terminal response without waiting for transport cancellation", { timeout: 1000 }, async () => {
  let cancelled = false;
  const terminal = { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] } };
  const upstream = new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from(`data: ${JSON.stringify(terminal)}\n\n`)); },
    cancel() { cancelled = true; return new Promise(() => {}); }
  }), { headers: { "content-type": "text/event-stream" } });
  const response = await primeResponsesStream(upstream, { waitForCompletion: true });
  assert.match(await response.text(), /OK/);
  assert.equal(cancelled, true);
});

test("complete preflight permits multiple frames beyond the prefix limit but bounds total buffering", async () => {
  const events = [
    ...Array.from({ length: 6 }, () => ({ type: "response.output_text.delta", delta: "A".repeat(70) })),
    { type: "response.completed", response: { output: [] } }
  ];
  const options = { waitForCompletion: true, maxFrameBytes: 200, maxBytes: 2048 };
  const response = await primeResponsesStream(streamResponse(events), options);
  assert.match(await response.text(), /response.completed/);
  await assert.rejects(primeResponsesStream(streamResponse(events), { ...options, maxBytes: 300 }), { code: "upstream_invalid_stream" });
});

test("complete preflight preserves explicit incomplete responses", async () => {
  const event = { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } };
  const response = await primeResponsesStream(streamResponse([event]), { waitForCompletion: true });
  assert.equal(await response.text(), `data: ${JSON.stringify(event)}\n\n`);
});

for (const ending of [[], [{ type: "response.completed", response: { output: [] } }]]) {
  test(`complete preflight still rejects truly empty streams (${ending.length})`, async () => {
    await assert.rejects(primeResponsesStream(streamResponse(ending), { waitForCompletion: true }), { code: "upstream_empty_stream" });
  });
}

test("complete preflight retains permanent errors after partial output", async () => {
  await assert.rejects(primeResponsesStream(streamResponse([
    { type: "response.output_text.delta", delta: "Partial" },
    { type: "error", code: "context_length_exceeded", message: "Input too long", param: "input" }
  ]), { waitForCompletion: true }), { code: "context_length_exceeded", statusCode: 400, message: "Input too long", param: "input" });
});

test("complete preflight rejects DONE without a terminal response", async () => {
  const upstream = new Response('data: {"type":"response.output_text.delta","delta":"Partial"}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(primeResponsesStream(upstream, { waitForCompletion: true }), { code: "upstream_stream_incomplete" });
});

for (const commentaryAsReasoning of [false, true]) {
  for (const representation of ["delta", "text_done", "part_added", "part_done", "item_done", "terminal", "json"]) {
    test(`commentary routing is opt-in and deduplicated (${representation}, enabled=${commentaryAsReasoning})`, async () => {
      const progress = { id: "msg_progress", type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Checking the file." }] };
      const final = { id: "msg_final", type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] };
      const output = [progress, final];
      const envelope = { id: "resp_phases", status: "completed", output };
      const events = [];
      if (!["terminal", "json"].includes(representation)) {
        events.push({ type: "response.output_item.added", output_index: 0, item: { ...progress, content: [] } });
        const common = { item_id: progress.id, output_index: 0, content_index: 0 };
        if (representation === "delta") events.push({ type: "response.output_text.delta", ...common, delta: "Checking the file." });
        if (representation === "text_done") events.push({ type: "response.output_text.done", ...common, text: "Checking the file." });
        if (representation.startsWith("part_")) events.push({ type: `response.content_part.${representation.slice(5)}`, ...common, part: progress.content[0] });
        events.push({ type: "response.output_item.done", output_index: 0, item: progress });
      }
      events.push({ type: "response.completed", response: envelope });
      const upstream = representation === "json" ? new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json" } }) : streamResponse(events);
      const completion = await readChatCompletion(responsesUpstreamAsChat(upstream, "gpt-test", { commentaryAsReasoning }));
      assert.equal(completion.choices[0].message.content, commentaryAsReasoning ? "Done." : "Checking the file.Done.");
      assert.equal(completion.choices[0].message.reasoning_content, commentaryAsReasoning ? "Checking the file." : undefined);
      assert.equal(completion.choices[0].finish_reason, "stop");
    });
  }
}

test("commentary is delivered as progress before a delayed tool without finishing the turn", { timeout: 2000 }, async () => {
  let source;
  const upstream = new Response(new ReadableStream({ start(controller) { source = controller; } }), { headers: { "content-type": "text/event-stream" } });
  const events = responseEvents(responsesUpstreamAsChat(upstream, "gpt-test", { commentaryAsReasoning: true }).body);
  const push = (event) => source.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
  try {
    push({ type: "response.output_item.added", output_index: 0, item: { id: "msg_progress", type: "message", phase: "commentary", content: [] } });
    push({ type: "response.output_text.delta", output_index: 0, item_id: "msg_progress", delta: "Checking." });
    assert.equal((await events.next()).value.choices[0].delta.role, "assistant");
    const progress = (await events.next()).value.choices[0];
    assert.deepEqual(progress.delta, { reasoning_content: "Checking." });
    assert.equal(progress.finish_reason, null);
    const tool = { id: "fc_check", type: "function_call", call_id: "call_check", name: "check", arguments: "{}" };
    push({ type: "response.output_item.done", output_index: 1, item: tool });
    push({ type: "response.completed", response: { output: [] } });
    source.close();
    const remaining = [];
    for await (const event of events) remaining.push(event);
    assert.equal(remaining.some((event) => event.choices[0].delta.tool_calls?.[0]?.id === "call_check"), true);
    assert.equal(remaining.at(-1).choices[0].finish_reason, "tool_calls");
    assert.equal(remaining.some((event) => event.choices[0].delta.content), false);
  } finally { await events.return(); }
});

for (const type of ["response.output_text.done", "response.content_part.added", "response.content_part.done", "response.refusal.done"]) {
  test(`GPT ${type} is delivered before the final response without duplicate text`, { timeout: 2000 }, async () => {
    let source;
    const refusal = type === "response.refusal.done";
    const part = refusal ? { type: "refusal", refusal: "Early" } : { type: "output_text", text: "Early" };
    const event = { type, item_id: "msg_early", output_index: 0, content_index: 0,
      ...(type.includes("content_part") ? { part } : refusal ? { refusal: "Early" } : { text: "Early" }) };
    const upstream = new Response(new ReadableStream({ start(controller) { source = controller; } }), { headers: { "content-type": "text/event-stream" } });
    const events = responseEvents(responsesUpstreamAsChat(upstream, "gpt-test").body);
    try {
      source.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
      assert.equal((await events.next()).value.choices[0].delta.role, "assistant");
      assert.equal((await events.next()).value.choices[0].delta[refusal ? "refusal" : "content"], "Early");
      source.enqueue(Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_early", output: [{ id: "msg_early", type: "message", content: [part] }] } })}\n\n`));
      source.close();
      const remaining = [];
      for await (const event of events) remaining.push(event);
      assert.equal(remaining.filter((event) => event.choices?.[0]?.delta?.content || event.choices?.[0]?.delta?.refusal).length, 0);
      assert.equal(remaining.at(-1).choices[0].finish_reason, "stop");
    } finally { await events.return(); }
  });
}

test("native preflight releases opening events before output and preserves the pending read", { timeout: 2000 }, async () => {
  let source;
  const opening = 'data: {"type":"response.created","response":{"id":"resp_slow","output":[]}}\n\n';
  const upstream = new Response(new ReadableStream({
    start(controller) {
      source = controller;
      controller.enqueue(Buffer.from(opening));
    }
  }), { headers: { "content-type": "text/event-stream" } });
  const primed = await primeResponsesStream(upstream, { maxWaitMs: 20 });
  const reader = primed.body.getReader();
  try {
    assert.equal(Buffer.from((await reader.read()).value).toString(), opening);
    const delta = 'data: {"type":"response.output_text.delta","delta":"OK"}\n\n';
    source.enqueue(Buffer.from(delta));
    source.close();
    assert.equal(Buffer.from((await reader.read()).value).toString(), delta);
    assert.equal((await reader.read()).done, true);
  } finally {
    await reader.cancel();
  }
});

test("native preflight can cancel a pending read after releasing headers", { timeout: 2000 }, async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } });
  const primed = await primeResponsesStream(upstream, { maxWaitMs: 20 });
  await primed.body.cancel();
  assert.equal(cancelled, true);
});

test("native preflight preserves late upstream failures after releasing headers", { timeout: 2000 }, async () => {
  let source;
  const upstream = new Response(new ReadableStream({
    start(controller) { source = controller; }
  }), { headers: { "content-type": "text/event-stream" } });
  const primed = await primeResponsesStream(upstream, { maxWaitMs: 20 });
  source.error(new Error("late upstream failure"));
  await assert.rejects(primed.text(), /late upstream failure/);
});

for (const ending of ["", "data: [DONE]\n\n", 'data: {"type":"response.completed","response":{"output":[]}}\n\n']) {
  test(`native preflight rejects late empty output (${ending.length})`, { timeout: 2000 }, async () => {
    let source;
    const upstream = new Response(new ReadableStream({
      start(controller) { source = controller; }
    }), { headers: { "content-type": "text/event-stream" } });
    const primed = await primeResponsesStream(upstream, { maxWaitMs: 20 });
    if (ending) source.enqueue(Buffer.from(ending));
    source.close();
    await assert.rejects(primed.text(), { code: "upstream_empty_stream" });
  });
}

test("native preflight cancels a DONE-only stream without waiting for EOF", async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from("data: [DONE]\n\n")); },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(primeResponsesStream(upstream), { code: "upstream_empty_stream" });
  assert.equal(cancelled, true);
});

test("native preflight rejects an empty body even without an SSE content type", async () => {
  await assert.rejects(primeResponsesStream(new Response("")), { code: "upstream_empty_stream" });
  await assert.rejects(primeResponsesStream(new Response(" \n")), { code: "upstream_empty_stream" });
  const body = JSON.stringify({ id: "resp_json", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] });
  assert.equal(await (await primeResponsesStream(new Response(body, { headers: { "content-type": "application/json" } }))).text(), body);
});

for (const item of [
  { type: "message", content: [{ type: "output_text", text: "OK" }] },
  { type: "function_call", id: "fc_1", call_id: "call_1", name: "Read", arguments: "{}" },
  { type: "custom_tool_call", id: "ct_1", call_id: "call_2", name: "patch", input: "patch" },
  { type: "reasoning", encrypted_content: "encrypted" }
]) {
  test(`native preflight preserves ${item.type} and cancels after completion`, async () => {
    let cancelled = false;
    const upstream = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", output: [item] } })}\n\n`));
      },
      cancel() { cancelled = true; }
    }), { headers: { "content-type": "text/event-stream" } });
    const events = [];
    for await (const event of responseEvents(normalizeResponsesStream(await primeResponsesStream(upstream)).body)) events.push(event);
    assert.deepEqual(events.at(-1).response.output, [item]);
    assert.equal(cancelled, true);
  });
}

for (const contentType of ["application/json", "text/plain; charset=utf-8", null]) {
  for (const prefix of ["event: response.completed\r\n", "", ": heartbeat\r\n\r\n"]) {
    test(`Responses bridge detects SSE with ${contentType || "no content type"} and ${prefix || "data-only frames"}`, async () => {
      const event = { type: "response.completed", response: { id: "resp_detected", output: [{ id: "msg_detected", type: "message", content: [{ type: "output_text", text: "你好" }] }] } };
      const bytes = Buffer.from(`\uFEFF\r\n${prefix}data: ${JSON.stringify(event)}\r\n\r\n`);
      const upstream = new Response(new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        }
      }), { headers: contentType ? { "content-type": contentType } : {} });
      const completion = await readChatCompletion(responsesUpstreamAsChat(upstream, "gpt-test"));
      assert.equal(completion.choices[0].message.content, "你好");
      assert.equal(completion.choices[0].finish_reason, "stop");
    });
  }
}

test("Responses bridge still accepts a JSON response containing SSE-looking text", async () => {
  const payload = { id: "resp_json", output: [{ id: "msg_json", type: "message", content: [{ type: "output_text", text: "event: response.completed\ndata: example" }] }] };
  const upstream = new Response(` \n${JSON.stringify(payload)}`, { headers: { "content-type": "application/json" } });
  const completion = await readChatCompletion(responsesUpstreamAsChat(upstream, "gpt-test"));
  assert.equal(completion.choices[0].message.content, payload.output[0].content[0].text);
});

test("mislabeled Responses streams forward deltas before completion and cancel after the terminal event", { timeout: 1000 }, async () => {
  let source;
  let cancelled = false;
  const upstream = new Response(new ReadableStream({
    start(controller) {
      source = controller;
      controller.enqueue(Buffer.from('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_live","delta":"Live"}\n\n'));
    },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "application/json" } });
  const events = responseEvents(responsesUpstreamAsChat(upstream, "gpt-test").body);
  assert.equal((await events.next()).value.choices[0].delta.role, "assistant");
  assert.equal((await events.next()).value.choices[0].delta.content, "Live");
  source.enqueue(Buffer.from('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_live","output":[]}}\n\n'));
  assert.equal((await events.next()).value.choices[0].finish_reason, "stop");
  assert.equal((await events.next()).done, true);
  assert.equal(cancelled, true);
});

test("mislabeled Responses prefix detection respects idle timeout and cancellation", async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from("eve")); },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "application/json" } });
  const guarded = guardUpstreamResponse(upstream, { idleTimeoutMs: 20 });
  await assert.rejects(readChatCompletion(responsesUpstreamAsChat(guarded, "gpt-test")), /idle timeout/);
  assert.equal(cancelled, true);
});

test("mislabeled Responses streams still reject incomplete output", async () => {
  const upstream = new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_partial","delta":"Partial"}\n\n', { headers: { "content-type": "application/json" } });
  await assert.rejects(readChatCompletion(responsesUpstreamAsChat(upstream, "gpt-test")), /without a final response/);
});

test("GPT raw reasoning deltas and snapshots stay separate from the answer", async () => {
  const upstream = streamResponse([
    { type: "response.reasoning_text.delta", item_id: "rs_raw", output_index: 0, content_index: 0, delta: "Think " },
    { type: "response.reasoning_text.done", item_id: "rs_raw", output_index: 0, content_index: 0, text: "Think carefully" },
    { type: "response.output_text.delta", item_id: "msg", output_index: 1, content_index: 0, delta: "Answer" },
    { type: "response.completed", response: { id: "resp", output: [] } }
  ]);
  const completion = await readChatCompletion(responsesUpstreamAsChat(upstream, "gpt-test"));
  assert.equal(completion.choices[0].message.reasoning_content, "Think carefully");
  assert.equal(completion.choices[0].message.content, "Answer");
});

test("GPT bridge requests summaries unless disabled or explicitly configured", () => {
  const base = { model: "gpt-test", messages: [{ role: "user", content: "Hello" }] };
  assert.deepEqual(chatToResponsesRequest(base).request.reasoning, { summary: "auto" });
  assert.equal(chatToResponsesRequest({ ...base, thinking: { type: "disabled" } }).request.reasoning, undefined);
  assert.equal(chatToResponsesRequest({ ...base, reasoning_effort: "none" }).request.reasoning, undefined);
  assert.deepEqual(chatToResponsesRequest({ ...base, reasoning: { effort: "high", summary: null } }).request.reasoning, { effort: "high", summary: null });
});

test("Responses preserves mid-conversation instruction roles and ordering", () => {
  const result = chatToResponsesRequest({ model: "gpt-test", messages: [
    { role: "system", content: "Initial" },
    { role: "user", content: "Continue" },
    { role: "system", content: "New system instruction" },
    { role: "developer", content: [{ type: "text", text: "New developer instruction" }] }
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.request.instructions, "Initial");
  assert.deepEqual(result.request.input.map((item) => item.role), ["user", "system", "developer"]);
  assert.equal(result.request.input[1].content[0].text, "New system instruction");
});

test("Chat requests flatten function tools, choices, images and instructions for Responses", () => {
  const converted = chatToResponsesRequest({
    model: "gpt-test", stream: true,
    messages: [
      { role: "system", content: "System" },
      { role: "developer", content: [{ type: "text", text: "Developer" }] },
      { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } }] },
      { role: "assistant", content: "Checking", tool_calls: [{ id: "call_1", type: "function", function: { name: "inspect", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "Result" }
    ],
    tools: [{ type: "function", function: { name: "inspect", description: "Inspect the image" } }],
    tool_choice: { type: "function", function: { name: "inspect" } },
    parallel_tool_calls: false,
    response_format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" }, strict: true } }
  });
  assert.equal(converted.ok, true);
  assert.equal(converted.request.instructions, "System\n\nDeveloper");
  assert.deepEqual(converted.request.tools, [{ type: "function", name: "inspect", description: "Inspect the image", parameters: { type: "object", properties: {} }, strict: false }]);
  assert.deepEqual(converted.request.tool_choice, { type: "function", name: "inspect" });
  assert.equal(converted.request.parallel_tool_calls, false);
  assert.deepEqual(converted.request.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "What is this?" }, { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "high" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking" }] },
    { type: "function_call", call_id: "call_1", name: "inspect", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "Result" }
  ]);
  assert.deepEqual(converted.request.text.format, { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true });
});

test("Responses deltas and final snapshots do not duplicate text, reasoning or tool arguments", async () => {
  const reasoning = { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "Think carefully" }] };
  const message = { id: "msg_1", type: "message", content: [{ type: "output_text", text: "Checking" }] };
  const tool = { id: "fc_1", type: "function_call", call_id: "call_1", name: "Read", arguments: '{"path":"文档"}' };
  const upstream = streamResponse([
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.reasoning_summary_text.delta", item_id: reasoning.id, summary_index: 0, delta: "Think " },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_text.delta", item_id: message.id, content_index: 0, delta: "Checking" },
    { type: "response.output_item.done", output_index: 1, item: message },
    { type: "response.output_item.added", output_index: 2, item: { ...tool, arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: tool.id, output_index: 2, delta: '{"path":' },
    { type: "response.function_call_arguments.done", item_id: tool.id, output_index: 2, arguments: tool.arguments },
    { type: "response.output_item.done", output_index: 2, item: tool },
    { type: "response.completed", response: { id: "resp_1", output: [reasoning, message, tool], usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } } } }
  ]);
  const completion = await readChatCompletion(responsesUpstreamAsChat(upstream, "gpt-test"));
  assert.equal(completion.id, "resp_1");
  assert.equal(completion.model, "gpt-test");
  assert.deepEqual(completion.choices[0], {
    index: 0,
    message: { role: "assistant", content: "Checking", reasoning_content: "Think carefully", tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: tool.arguments } }] },
    finish_reason: "tool_calls"
  });
  assert.equal(completion.usage.total_tokens, 15);
  assert.equal(completion.usage.completion_tokens_details.reasoning_tokens, 3);
});

for (const events of [
  [],
  [{ type: "response.output_text.delta", item_id: "msg_1", delta: "Partial" }],
  [{ type: "error", message: "Upstream error" }],
  [{ type: "response.failed", response: { error: { message: "Failed" } } }]
]) {
  test(`Responses bridge rejects a failed or unfinished stream: ${events[0]?.type || "empty"}`, async () => {
    await assert.rejects(readChatCompletion(responsesUpstreamAsChat(streamResponse(events), "gpt-test")), /final response|Upstream error|Failed/);
  });
}

test("Responses incomplete output reports a length stop and preserves partial text", async () => {
  const completion = await readChatCompletion(responsesUpstreamAsChat(streamResponse([
    { type: "response.incomplete", response: { output: [{ type: "message", id: "msg_1", content: [{ type: "output_text", text: "Partial" }] }] } }
  ]), "gpt-test"));
  assert.equal(completion.choices[0].finish_reason, "length");
  assert.equal(completion.choices[0].message.content, "Partial");
});

test("Responses errors retain their original HTTP status and body", async () => {
  const upstream = new Response('{"error":{"message":"Rejected"}}', { status: 400 });
  assert.equal(responsesUpstreamAsChat(upstream, "gpt-test"), upstream);
  assert.equal(normalizeResponsesStream(upstream), upstream);
});

test("native completion repair orders final items by output index and retains custom tools", async () => {
  const first = { id: "fc_1", type: "function_call", name: "Read", call_id: "call_1", arguments: "{}" };
  const second = { id: "ctc_2", type: "custom_tool_call", name: "apply_patch", call_id: "call_2", input: "patch" };
  const events = [
    { type: "response.output_item.done", output_index: 1, item: second },
    { type: "response.output_item.done", output_index: 0, item: first },
    { type: "response.completed", sequence_number: 10, response: { id: "resp_1", output: [] } }
  ];
  const normalized = [];
  for await (const event of responseEvents(normalizeResponsesStream(streamResponse(events)).body)) normalized.push(event);
  assert.deepEqual(normalized.slice(0, 2), events.slice(0, 2));
  assert.deepEqual(normalized.at(-1).response.output, [first, second]);
  assert.equal(normalized.at(-1).sequence_number, 10);
});

test("native history finalization runs once after output restoration and before completion", async () => {
  let committed = 0;
  const item = { id: "fc_1", type: "function_call", call_id: "call_1", name: "functions__Read", arguments: "{}" };
  const completed = { type: "response.completed", response: { id: "resp_1", output: [] } };
  const upstream = streamResponse([
    { type: "response.output_item.done", output_index: 0, item }, completed, completed
  ]);
  const normalized = normalizeResponsesStream(upstream, {
    restoreEvent(event) {
      if (!event.response) return event;
      return { ...event, response: { ...event.response, output: event.response.output.map((entry) => ({ ...entry, name: "Read", namespace: "functions" })) } };
    },
    finalize(envelope, type) {
      assert.equal(type, "response.completed");
      assert.equal(envelope.output[0].namespace, "functions");
      committed++;
      return { ...envelope, store: true };
    }
  });
  for await (const event of responseEvents(normalized.body)) {
    if (event.type === "response.completed") {
      assert.equal(committed, 1);
      assert.equal(event.response.store, true);
    }
  }
  assert.equal(committed, 1);
});

test("history capacity failure emits an explicit error instead of a successful completion", async () => {
  const normalized = normalizeResponsesStream(streamResponse([
    { type: "response.completed", response: { id: "resp_1", output: [] } }
  ]), { finalize() { throw Object.assign(new Error("Too large"), { code: "response_history_limit" }); } });
  const events = [];
  for await (const event of responseEvents(normalized.body)) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].code, "response_history_limit");
  assert.match(events[0].message, /cache limit/);
});

test("SSE parser accepts CRLF, multiline data and an unterminated last frame", async () => {
  const upstream = new Response('event: response.created\r\ndata: {"type":\r\ndata: "response.created"}\r\n\r\ndata: {"type":"response.completed"}');
  const events = [];
  for await (const event of responseEvents(upstream.body)) events.push(event);
  assert.deepEqual(events, [{ type: "response.created" }, { type: "response.completed" }]);
});

test("partial final output merges, orders and deduplicates completed tool items", async () => {
  const message = { id: "msg_1", type: "message", content: [{ type: "output_text", text: "Checking" }] };
  const tool = { id: "fc_1", type: "function_call", call_id: "call_1", name: "Read", arguments: "{}" };
  const events = [
    { type: "response.output_item.done", output_index: 1, item: tool },
    { type: "response.output_item.done", output_index: 1, item: tool },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { id: "resp_1", output: [message] } }
  ];
  const collected = [];
  for await (const event of responseEvents(normalizeResponsesStream(streamResponse(events)).body)) collected.push(event);
  assert.deepEqual(collected.at(-1).response.output, [message, tool]);
  const completion = await readChatCompletion(responsesUpstreamAsChat(streamResponse(events), "gpt-test"));
  assert.equal(completion.choices[0].message.content, "Checking");
  assert.equal(completion.choices[0].message.tool_calls.length, 1);
});

test("response state ignores events after a terminal event and preserves incomplete status", () => {
  const state = new ResponseState();
  const first = state.accept({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } });
  assert.equal(first.response.status, "incomplete");
  assert.equal(first.response.incomplete_details.reason, "max_output_tokens");
  assert.equal(state.accept({ type: "response.completed", response: { output: [] } }), null);
  assert.equal(state.accept({ type: "response.output_item.done", item: { id: "late" } }), null);
});

test("response state enforces item and aggregate limits", () => {
  const bounded = new ResponseState({ maxBytes: 32 });
  assert.throws(() => bounded.accept({ type: "response.output_item.done", output_index: 0, item: { id: "tool", arguments: "x".repeat(40) } }), /aggregate size limit/);
  const items = new ResponseState({ maxItems: 1 });
  items.accept({ type: "response.output_item.done", output_index: 0, item: { id: "first" } });
  assert.throws(() => items.accept({ type: "response.output_item.done", output_index: 1, item: { id: "second" } }), /too many output items/);
});

test("native Responses normalization detects a truncated stream", async () => {
  const normalized = normalizeResponsesStream(streamResponse([{ type: "response.created", response: { id: "resp_1" } }]));
  const body = await normalized.text();
  assert.match(body, /"code":"upstream_stream_incomplete"/);
  assert.doesNotMatch(body, /response.completed/);
});

test("Responses frame parser rejects over-limit incomplete frames", async () => {
  const read = async () => {
    for await (const event of responseEvents(new Response("data: " + "x".repeat(80)).body, { maxFrameBytes: 16 })) assert.fail(JSON.stringify(event));
  };
  await assert.rejects(read(), /frame exceeds/);
});

test("native Responses ends at its terminal event even when the upstream stays open", async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"resp_1","output":[]}}\n\n')); },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } });
  assert.match(await normalizeResponsesStream(upstream).text(), /response.completed/);
  assert.equal(cancelled, true);
});

test("native Responses idle timeout returns an explicit SSE error and cancels upstream", async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n')); },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } });
  const normalized = normalizeResponsesStream(guardUpstreamResponse(upstream, { idleTimeoutMs: 20 }));
  const events = [];
  for await (const event of responseEvents(normalized.body)) events.push(event);
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).code, "upstream_stream_timeout");
  assert.ok(!events.some((event) => event.type === "response.completed"));
  assert.equal(cancelled, true);
});
