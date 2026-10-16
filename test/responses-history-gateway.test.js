import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";
import { createGateway } from "../src/server.js";

const responsesPath = "/v1/responses";
const codexPath = "/backend-api/codex/responses";
const tools = [{ type: "namespace", name: "functions", tools: [
  { type: "function", name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, strict: true },
  { type: "custom", name: "apply_patch", format: { type: "text" } }
] }];
const firstInput = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Read then patch 中文.txt" }] }];
const firstOutput = [
  { type: "reasoning", id: "rs_first", summary: [{ type: "summary_text", text: "Inspect the file first." }], encrypted_content: "opaque-encrypted-reasoning==" },
  { type: "message", id: "msg_first", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "Checking 中文.txt", annotations: [] }] },
  { type: "function_call", id: "fc_first", call_id: "call_read", name: "functions__read_file", arguments: '{"path":"中文.txt"}', status: "completed" },
  { type: "custom_tool_call", id: "ctc_first", call_id: "call_patch", name: "functions__apply_patch", input: "*** Begin Patch\n*** End Patch", status: "completed" }
];
const restoredFirstOutput = firstOutput.map((item) => item.name?.startsWith("functions__")
  ? { ...item, name: item.name.slice("functions__".length), namespace: "functions" } : item);
const toolResults = [
  { type: "function_call_output", call_id: "call_read", output: "Original 中文 contents" },
  { type: "custom_tool_call_output", call_id: "call_patch", output: "Success" }
];

// Both client representations use the same upstream SSE protocol and local history store.
for (const firstStream of [false, true]) {
  for (const secondStream of [false, true]) {
    test(`native Responses expands a two-turn history with lossless output (JSON/SSE=${firstStream}/${secondStream})`, async () => {
      const secondOutput = [message("second", "Patched", "final_answer")];
      const fixture = gatewayFixture([
        () => completed("resp_first", firstOutput, { emptyTerminalOutput: true }),
        () => completed("resp_second", secondOutput)
      ]);
      try {
        await fixture.start();
        const first = await request(fixture, {
          input: firstInput, tools, stream: firstStream, instructions: "Only this first turn's instruction.",
          include: ["message.output_text.logprobs"]
        }, { path: firstStream ? codexPath : responsesPath });
        assertCompleted(first, "resp_first", null);
        assert.deepEqual(first.envelope.output, restoredFirstOutput);
        if (firstStream) {
          assert.deepEqual(first.events.filter((event) => event.type === "response.output_item.done").map((event) => event.item), restoredFirstOutput);
        }
        const second = await request(fixture, {
          previous_response_id: first.envelope.id, input: toolResults, tools, stream: secondStream, store: true
        }, { path: firstStream ? responsesPath : codexPath });
        assertCompleted(second, "resp_second", "resp_first");
        assert.deepEqual(second.envelope.output, secondOutput);
        assert.equal(fixture.sent.length, 2);
        const [sentFirst, sentSecond] = fixture.sent.map((sent) => sent.body);
        assert.deepEqual(sentFirst.input, firstInput);
        assert.deepEqual(sentSecond.input, [...firstInput, ...firstOutput, ...toolResults]);
        assert.equal(sentFirst.instructions, "Only this first turn's instruction.");
        assert.equal(Object.hasOwn(sentSecond, "instructions"), false, "top-level instructions must not enter history");
        assert.deepEqual(sentFirst.include, ["message.output_text.logprobs", "reasoning.encrypted_content"]);
        assert.deepEqual(sentSecond.include, ["reasoning.encrypted_content"]);
        for (const sent of fixture.sent) {
          assertNativeUpstream(sent);
          assert.deepEqual(sent.body.tools, tools[0].tools.map((tool) => ({ ...tool, name: `functions__${tool.name}` })));
          assert.equal(sent.body.input.some((item) => Object.hasOwn(item, "namespace")), false);
        }
      } finally { fixture.close(); }
    });
  }
}

for (const stream of [false, true]) {
  test(`native Responses stores full three-turn snapshots without polluting sibling branches (stream=${stream})`, async () => {
    const outputs = ["root", "left", "third", "right", "right-child"].map((id) => [message(id, id)]);
    const fixture = gatewayFixture(outputs.map((output, index) => () => completed(`resp_${index + 1}`, output)));
    try {
      await fixture.start();
      const root = await request(fixture, { input: "Root question", stream });
      assertCompleted(root, "resp_1", null);
      const left = await request(fixture, { input: "Left turn", previous_response_id: root.envelope.id, stream });
      assertCompleted(left, "resp_2", "resp_1");
      const third = await request(fixture, { input: "Third turn", previous_response_id: left.envelope.id, stream });
      assertCompleted(third, "resp_3", "resp_2");
      const right = await request(fixture, { input: "Right turn", previous_response_id: root.envelope.id, stream });
      assertCompleted(right, "resp_4", "resp_1");
      const rightChild = await request(fixture, { input: "Right child", previous_response_id: right.envelope.id, stream });
      assertCompleted(rightChild, "resp_5", "resp_4");
      const rootInput = [userMessage("Root question")];
      const leftInput = [...rootInput, ...outputs[0], userMessage("Left turn")];
      const rightInput = [...rootInput, ...outputs[0], userMessage("Right turn")];
      assert.deepEqual(fixture.sent.map((sent) => sent.body.input), [
        rootInput, leftInput, [...leftInput, ...outputs[1], userMessage("Third turn")],
        rightInput, [...rightInput, ...outputs[3], userMessage("Right child")]
      ]);
      fixture.sent.forEach(assertNativeUpstream);
    } finally { fixture.close(); }
  });

  test(`store:false can use a saved parent but neither saves its child nor damages its parent (stream=${stream})`, async () => {
    const parentOutput = [message("parent", "Saved parent")];
    const fixture = gatewayFixture([
      () => completed("resp_parent", parentOutput),
      () => completed("resp_ephemeral", [message("ephemeral", "Not saved")]),
      () => completed("resp_sibling", [message("sibling", "Still usable")]),
      () => completed("resp_standalone", [message("standalone", "Also not saved")])
    ]);
    try {
      await fixture.start();
      const parent = await request(fixture, { input: "Parent", store: true, stream, instructions: "Old instruction", include: ["reasoning.encrypted_content"] });
      assertCompleted(parent, "resp_parent", null);
      const child = await request(fixture, {
        input: "Transient child", previous_response_id: "resp_parent", store: false, stream,
        instructions: "Replacement instruction", include: ["message.output_text.logprobs"]
      });
      assertCompleted(child, "resp_ephemeral", "resp_parent", false);
      assert.deepEqual(fixture.sent[1].body.input, [userMessage("Parent"), ...parentOutput, userMessage("Transient child")]);
      assert.equal(fixture.sent[1].body.instructions, "Replacement instruction");
      assert.deepEqual(fixture.sent[0].body.include, ["reasoning.encrypted_content"], "include must be deduplicated");
      assert.deepEqual(fixture.sent[1].body.include, ["message.output_text.logprobs"], "store:false must not add encrypted reasoning inclusion");
      await assertMissing(fixture, "resp_ephemeral");
      const sibling = await request(fixture, { input: "Saved sibling", previous_response_id: "resp_parent", stream });
      assertCompleted(sibling, "resp_sibling", "resp_parent");
      assert.deepEqual(fixture.sent[2].body.input, [userMessage("Parent"), ...parentOutput, userMessage("Saved sibling")]);
      assert.equal(Object.hasOwn(fixture.sent[2].body, "instructions"), false);
      const standalone = await request(fixture, { input: "No parent", store: false, stream });
      assertCompleted(standalone, "resp_standalone", null, false);
      assert.equal(Object.hasOwn(fixture.sent[3].body, "include"), false);
      await assertMissing(fixture, "resp_standalone");
      fixture.sent.forEach(assertNativeUpstream);
    } finally { fixture.close(); }
  });
}

test("both Responses entrypoints enforce API keys before touching upstream or history", async () => {
  const fixture = gatewayFixture([]);
  try {
    await fixture.start();
    for (const path of [responsesPath, codexPath]) {
      for (const key of [null, "invalid-api-key"]) {
        const result = await request(fixture, { input: "Unauthorized", previous_response_id: "resp_unknown" }, { key, path });
        assert.equal(result.status, 401, `${path}: ${key ?? "missing key"}`);
        assert.ok(result.envelope.error);
      }
    }
    assert.equal(fixture.sent.length, 0);
  } finally { fixture.close(); }
});

test("history rejects unknown ids, other API keys and other models without an upstream request", async () => {
  const fixture = gatewayFixture([() => completed("resp_private", [message("private", "Private output")])]);
  try {
    const otherKey = new OpenAIKeyStore(fixture.apiKeyFile).create("Other history owner").key;
    await fixture.start();
    const first = await request(fixture, { input: "Private input" });
    assertCompleted(first, "resp_private", null);
    for (const path of [responsesPath, codexPath]) {
      await assertMissing(fixture, "resp_private", { path, key: otherKey });
      await assertMissing(fixture, "resp_private", { path, model: "gpt-other" });
      await assertMissing(fixture, "resp_unknown", { path });
    }
    assert.equal(fixture.sent.length, 1);
  } finally { fixture.close(); }
});

test("native GPT keeps prompt-cache sessions stable for continuations and isolated by API key", async () => {
  const fixture = gatewayFixture([
    () => completed("resp_parent", [message("parent", "Parent")]),
    () => completed("resp_child", [message("child", "Child")]),
    () => completed("resp_same_cache", [message("same-cache", "Same cache")]),
    () => completed("resp_other_owner", [message("other-owner", "Other owner")]),
    () => completed("resp_no_cache", [message("no-cache", "No cache")])
  ]);
  try {
    const otherKey = new OpenAIKeyStore(fixture.apiKeyFile).create("Other GPT cache owner").key;
    await fixture.start();
    const parent = await request(fixture, { input: "Parent", prompt_cache_key: "codex-thread-a" });
    assertCompleted(parent, "resp_parent", null);
    const child = await request(fixture, { input: "Child", previous_response_id: "resp_parent" });
    assertCompleted(child, "resp_child", "resp_parent");
    const sameCache = await request(fixture, { input: "Another branch", prompt_cache_key: "codex-thread-a", store: false });
    assertCompleted(sameCache, "resp_same_cache", null, false);
    const otherOwner = await request(fixture, { input: "Other owner", prompt_cache_key: "codex-thread-a", store: false }, { key: otherKey });
    assertCompleted(otherOwner, "resp_other_owner", null, false);
    const noCache = await request(fixture, { input: "No explicit cache key", store: false });
    assertCompleted(noCache, "resp_no_cache", null, false);

    const sessions = fixture.sent.map((sent) => sent.headers["x-mirasim-session"]);
    assert.equal(sessions[1], sessions[0], "previous_response_id must retain the session that wrote the cache");
    assert.equal(fixture.sent[1].body.prompt_cache_key, "codex-thread-a");
    assert.equal(sessions[2], sessions[0], "the same explicit prompt_cache_key must reuse its cache session");
    assert.notEqual(sessions[3], sessions[0], "API keys must never share a prompt-cache session");
    assert.notEqual(sessions[4], sessions[0], "requests without an explicit cache binding remain isolated");
    for (const session of sessions) assert.match(session, /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally { fixture.close(); }
});

for (const model of ["kimi-k3", "deepseek-v3", "claude-sonnet-5"]) {
  test(`non-native ${model} continues to reject previous_response_id before upstream`, async () => {
    const fixture = gatewayFixture([]);
    try {
      await fixture.start();
      for (const path of [responsesPath, codexPath]) {
        const result = await request(fixture, { model, input: "Continue", previous_response_id: "resp_native" }, { path });
        assert.equal(result.status, 400);
        assert.match(result.envelope.error.message, /previous_response_id/);
      }
      assert.equal(fixture.sent.length, 0);
    } finally { fixture.close(); }
  });
}

for (const [field, values] of [["previous_response_id", ["", " ", "\t\n", false, 42, {}]], ["store", [null, "true", "false", 0, 1, []]]]) {
  test(`native Responses rejects invalid ${field} values without calling upstream`, async () => {
    const fixture = gatewayFixture([]);
    try {
      await fixture.start();
      for (const path of [responsesPath, codexPath]) {
        for (const value of values) {
          const result = await request(fixture, { input: "Invalid history option", [field]: value }, { path });
          assert.equal(result.status, 400, `${path}: ${field}=${JSON.stringify(value)}: ${result.wire}`);
          assert.equal(result.envelope.error.type, "invalid_request_error");
          assert.match(result.envelope.error.message, new RegExp(field));
          assert.equal(fixture.sent.length, 0);
        }
      }
    } finally { fixture.close(); }
  });
}

test("native nonstream Responses caches an upstream JSON fallback and expands it on the next turn", async () => {
  const output = [message("json-fallback", "JSON fallback output")];
  const fixture = gatewayFixture([
    () => new Response(JSON.stringify({
      id: "resp_json_fallback", object: "response", model: "gpt-test", status: "completed",
      output, store: false, previous_response_id: null
    }), { headers: { "content-type": "application/json" } }),
    () => completed("resp_after_json", [message("after-json", "Next turn")])
  ]);
  try {
    await fixture.start();
    const first = await request(fixture, { input: "JSON first turn", stream: false, include: ["message.output_text.logprobs"] });
    assertCompleted(first, "resp_json_fallback", null);
    assert.deepEqual(first.envelope.output, output);
    assert.deepEqual(fixture.sent[0].body.include, ["message.output_text.logprobs", "reasoning.encrypted_content"]);
    const second = await request(fixture, { input: "Continue JSON", stream: false, previous_response_id: first.envelope.id }, { path: codexPath });
    assertCompleted(second, "resp_after_json", "resp_json_fallback");
    assert.deepEqual(fixture.sent[1].body.input, [userMessage("JSON first turn"), ...output, userMessage("Continue JSON")]);
    fixture.sent.forEach(assertNativeUpstream);
  } finally { fixture.close(); }
});

const failures = [
  ["HTTP error", () => new Response(JSON.stringify({ error: { message: "Rejected upstream", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } })],
  ["error event", () => responsesSse([
    created("resp_unsaved"),
    { type: "response.output_item.done", output_index: 0, item: message("partial", "Partial") },
    { type: "error", code: "server_error", message: "Upstream failed", param: null }
  ])],
  ["failed", () => responsesSse([
    created("resp_unsaved"),
    { type: "response.failed", response: { id: "resp_unsaved", status: "failed", output: [message("partial", "Partial")], error: { code: "server_error", message: "Failed" }, store: true } }
  ])],
  ["incomplete", () => responsesSse([
    created("resp_unsaved"),
    { type: "response.incomplete", response: { id: "resp_unsaved", status: "incomplete", output: [message("partial", "Partial")], incomplete_details: { reason: "max_output_tokens" }, store: true } }
  ])],
  ["truncated stream", () => responsesSse([
    created("resp_unsaved"),
    { type: "response.output_item.done", output_index: 0, item: message("partial", "Partial but not completed") }
  ])],
  ["broken upstream body", () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(encodeEvents([created("resp_unsaved")])); },
    pull(controller) { controller.error(new Error("Mock upstream socket disconnected")); }
  }), { headers: { "content-type": "text/event-stream" } })]
];

for (const stream of [false, true]) {
  for (const [name, upstream] of failures) {
    test(`native Responses ${name} never creates reusable history (stream=${stream})`, async () => {
      const fixture = gatewayFixture([upstream]);
      try {
        await fixture.start();
        const result = await request(fixture, { input: "Unsuccessful turn", stream });
        assert.ok(result.status >= 400 || ["failed", "incomplete"].includes(result.envelope?.status)
          || result.events.some((event) => ["error", "response.failed", "response.incomplete"].includes(event.type)),
          `an unsuccessful upstream must not look completed: ${result.wire}`);
        assert.equal(result.events.some((event) => event.type === "response.completed"), false);
        if (result.envelope?.status) assert.equal(result.envelope.store, false);
        await assertMissing(fixture, "resp_unsaved");
        assert.equal(fixture.sent.length, 1);
      } finally { fixture.close(); }
    });
  }

  test(`completed output without a real response id is returned but not saved (stream=${stream})`, async () => {
    const output = [message("missing-id", "No upstream response id")];
    const fixture = gatewayFixture([() => completed(undefined, output, { emptyTerminalOutput: true })]);
    try {
      await fixture.start();
      const result = await request(fixture, { input: "No id", stream });
      assert.equal(result.status, 200);
      assert.equal(result.envelope.status, "completed");
      assert.equal(result.envelope.store, false);
      assert.equal(result.envelope.previous_response_id, null);
      assert.deepEqual(result.envelope.output, output);
      if (result.envelope.id) await assertMissing(fixture, result.envelope.id);
      await assertMissing(fixture, "resp_missing");
      assert.equal(fixture.sent.length, 1);
    } finally { fixture.close(); }
  });
}

test("cancelling an unfinished native Responses stream cancels upstream and leaves no history", async () => {
  let cancelled = false;
  let resolveCancellation;
  const cancellation = new Promise((resolve) => { resolveCancellation = resolve; });
  const fixture = gatewayFixture([() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encodeEvents([
        created("resp_cancelled"),
        { type: "response.output_item.done", output_index: 0, item: message("cancelled", "Unfinished output") }
      ]));
    },
    cancel() { cancelled = true; resolveCancellation(); }
  }), { headers: { "content-type": "text/event-stream" } })], { streamIdleTimeoutMs: 5000 });
  const controller = new AbortController();
  let timer;
  try {
    await fixture.start();
    const response = await fetch(`${fixture.baseUrl}${responsesPath}`, {
      method: "POST", headers: { Authorization: `Bearer ${fixture.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", input: "Cancel me", stream: true }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let wire = "";
    while (!wire.includes("response.output_item.done")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      wire += new TextDecoder().decode(chunk.value);
    }
    assert.equal(wire.includes("response.completed"), false);
    controller.abort();
    await Promise.race([cancellation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Upstream stream was not cancelled")), 2000); })]);
    assert.equal(cancelled, true);
    await assertMissing(fixture, "resp_cancelled");
    assert.equal(fixture.sent.length, 1);
  } finally { clearTimeout(timer); controller.abort(); fixture.close(); }
});

for (const path of [responsesPath, codexPath]) {
  test(`Codex tool continuation over 4 MiB survives ${path}`, async () => {
    const fixture = gatewayFixture([
      () => completed("resp_large_first", firstOutput),
      () => completed("resp_large_second", [message("large_second", "Done")])
    ]);
    try {
      await fixture.start();
      const first = await request(fixture, { input: firstInput, tools, stream: true }, { path });
      assertCompleted(first, "resp_large_first", null);
      assert.deepEqual(first.envelope.output, restoredFirstOutput);
      const results = toolResults.map((item, index) => index === 0 ? { ...item, output: "x".repeat(5 * 1024 * 1024) } : item);
      const second = await request(fixture, { previous_response_id: first.envelope.id, input: results, tools, stream: true }, { path });
      assertCompleted(second, "resp_large_second", "resp_large_first");
      assert.deepEqual(fixture.sent[1].body.input, [...firstInput, ...firstOutput, ...results]);
    } finally { fixture.close(); }
  });

  test(`oversized ${path} request returns JSON 413 instead of disconnecting`, async () => {
    const fixture = gatewayFixture([], { maxRequestBytes: 1024 });
    try {
      await fixture.start();
      const result = await request(fixture, { input: "x".repeat(2048), stream: true }, { path });
      assert.equal(result.status, 413);
      assert.match(result.envelope.error.message, /limit: 1024 bytes/);
      assert.equal(fixture.sent.length, 0);
    } finally { fixture.close(); }
  });
}

function message(id, text, phase = "final_answer") {
  return { id: `msg_${id}`, type: "message", role: "assistant", status: "completed", phase, content: [{ type: "output_text", text, annotations: [] }] };
}

function userMessage(text) {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function created(id) {
  return { type: "response.created", response: { id, object: "response", model: "gpt-test", status: "in_progress", output: [], store: false } };
}

function completed(id, output, { emptyTerminalOutput = false } = {}) {
  return responsesSse([
    ...(id === undefined ? [] : [created(id)]),
    ...output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
    { type: "response.completed", response: { ...(id === undefined ? {} : { id }), object: "response", model: "gpt-test", status: "completed", output: emptyTerminalOutput ? [] : output, store: false, previous_response_id: null, usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } } }
  ]);
}

function encodeEvents(events) {
  return Buffer.from(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

function responsesSse(events) {
  return new Response(encodeEvents(events), { headers: { "content-type": "text/event-stream" } });
}

function assertNativeUpstream(sent) {
  assert.equal(sent.href, "https://relay.example.test/v1/responses");
  assert.equal(sent.body.model, "gpt-test");
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.stream, true);
  assert.equal(Object.hasOwn(sent.body, "previous_response_id"), false);
}

function assertCompleted(result, id, previous, stored = true) {
  assert.equal(result.status, 200, result.wire);
  assert.equal(result.envelope.id, id);
  assert.equal(result.envelope.status, "completed");
  assert.equal(result.envelope.store, stored);
  assert.equal(result.envelope.previous_response_id, previous);
  if (result.events.length) assert.equal(result.events.filter((event) => event.type === "response.completed").length, 1);
}

async function assertMissing(fixture, id, { model = "gpt-test", ...options } = {}) {
  const before = fixture.sent.length;
  const result = await request(fixture, { model, previous_response_id: id, input: "Must not reach upstream" }, options);
  assert.equal(result.status, 400, result.wire);
  assert.equal(result.envelope.error.type, "invalid_request_error");
  assert.match(result.envelope.error.message, /previous_response_id/);
  assert.equal(fixture.sent.length, before, "history lookup errors must not call upstream");
}

async function request(fixture, body, { path = responsesPath, key = fixture.key } = {}) {
  const response = await fetch(`${fixture.baseUrl}${path}`, {
    method: "POST", headers: { ...(key === null ? {} : { Authorization: `Bearer ${key}` }), "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-test", ...body }), signal: AbortSignal.timeout(5000)
  });
  const wire = await response.text();
  const isStream = /text\/event-stream/.test(response.headers.get("content-type") || "");
  const events = isStream ? wire.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return [];
    const event = JSON.parse(data);
    const name = frame.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim();
    if (name) assert.equal(name, event.type);
    return [event];
  }) : [];
  const envelope = isStream ? events.findLast((event) => ["response.completed", "response.failed", "response.incomplete"].includes(event.type))?.response : JSON.parse(wire);
  return { status: response.status, wire, events, envelope };
}

// Local copy of relay-chat-bridge's gatewayFixture: real localhost HTTP downstream,
// scripted fetch upstream, and temporary accounts/keys only; no real relay credentials.
function gatewayFixture(upstreams, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-responses-history-"));
  const home = join(root, "account-a");
  const apiKeyFile = join(root, "api-keys.json");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: "user-a", token: "mirasim-token", exp: 4_102_444_800 } }));
  const sent = [];
  const server = createGateway({
    host: "127.0.0.1", port: 0, homes: [home], apiKeyFile,
    relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test",
    webAuth: { username: "console", password: "correct-password", secureCookie: false },
    models: [], timeoutMs: 30_000, cooldownMs: 30_000, reasoningMode: "managed", ...overrides
  }, {
    fetchImpl: async (url, options) => {
      const index = sent.length;
      sent.push({ href: url.href, headers: options.headers, body: JSON.parse(options.body) });
      if (!upstreams[index]) throw new Error(`Unexpected upstream request ${index + 1}`);
      return upstreams[index](url, options);
    },
    logger: { error() {} }
  });
  const key = new OpenAIKeyStore(apiKeyFile).create("Responses history HTTP test").key;
  let baseUrl;
  return {
    apiKeyFile, key, sent,
    async start() {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    },
    get baseUrl() { return baseUrl; },
    close() {
      server.closeAllConnections();
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
