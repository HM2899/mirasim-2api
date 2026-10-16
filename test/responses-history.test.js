import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesHistoryStore } from "../src/responses-history.js";

const response = (id, output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }], status = "completed") => ({ id, status, output });

function clock() {
  let time = 0;
  return { now: () => time, advance: (ms) => { time += ms; } };
}

test("normalizes string input and remembers a complete snapshot", () => {
  const store = new ResponsesHistoryStore();
  assert.equal(store.remember("owner", "model", "hello", response("resp_1")), true);
  const request = { model: "model", input: "follow up", previous_response_id: "resp_1", temperature: 0.2 };
  const expanded = store.expand("owner", "model", request);
  assert.deepEqual(expanded.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    response("ignored").output[0],
    { type: "message", role: "user", content: [{ type: "input_text", text: "follow up" }] }
  ]);
  assert.equal("previous_response_id" in expanded, false);
  assert.equal(request.previous_response_id, "resp_1");
  expanded.input[0].content[0].text = "mutated";
  assert.equal(store.expand("owner", "model", { input: "branch", previous_response_id: "resp_1" }).input[0].content[0].text, "hello");
});

test("stores complete output only and ignores response.store", () => {
  const store = new ResponsesHistoryStore();
  assert.equal(store.remember("o", "m", [], { id: "bad", status: "incomplete", output: [], store: true }), false);
  assert.equal(store.remember("o", "m", [], { id: "", status: "completed", output: [], store: true }), false);
  assert.equal(store.remember("o", "m", [], { id: "no-output", status: "completed", store: true }), false);
  assert.equal(store.remember("o", "m", "input", { id: "ok", status: "completed", output: [], store: false }), true);
  assert.equal(store.size, 1);
});

test("missing, expired, cross-owner and model histories use the same protocol error", () => {
  const time = clock();
  const store = new ResponsesHistoryStore({ now: time.now, ttlMs: 10 });
  assert.throws(() => store.expand("o", "m", { input: "x", previous_response_id: "missing" }), (error) => error.statusCode === 400 && error.code === "previous_response_not_found" && error.param === "previous_response_id" && error.message.startsWith("previous_response_id"));
  assert.equal(store.remember("o", "m", "x", response("r")), true);
  for (const args of [["other", "m"], ["o", "other-model"]]) {
    assert.throws(() => store.expand(...args, { input: "x", previous_response_id: "r" }), (error) => error.statusCode === 400 && error.code === "previous_response_not_found" && error.param === "previous_response_id");
  }
  time.advance(10);
  assert.throws(() => store.expand("o", "m", { input: "x", previous_response_id: "r" }), (error) => error.statusCode === 400 && error.code === "previous_response_not_found");
  assert.equal(store.size, 0);
});

test("previous_response_id type errors carry its parameter", () => {
  const store = new ResponsesHistoryStore();
  for (const previous_response_id of [1, "", "   "]) {
    assert.throws(() => store.expand("o", "m", { input: "x", previous_response_id }), (error) => error.statusCode === 400 && error.code === "invalid_request_error" && error.param === "previous_response_id");
  }
});

test("enforces item and byte limits with 413 response_history_limit", () => {
  const items = new ResponsesHistoryStore({ maxItems: 1 });
  assert.throws(() => items.expand("o", "m", { input: [{ type: "message" }, { type: "message" }] }), (error) => error.statusCode === 413 && error.code === "response_history_limit");
  const bytes = new ResponsesHistoryStore({ maxEntryBytes: 20 });
  assert.throws(() => bytes.expand("o", "m", { input: "this is too long" }), (error) => error.statusCode === 413 && error.code === "response_history_limit");
  assert.throws(() => bytes.remember("o", "m", "this is too long", response("r")), (error) => error.statusCode === 413 && error.code === "response_history_limit");
});

test("fixed TTL does not extend on expand and size/bytes are observable", () => {
  const time = clock();
  const store = new ResponsesHistoryStore({ now: time.now, ttlMs: 10 });
  assert.equal(store.remember("o", "m", "x", response("r")), true);
  const initialBytes = store.bytes;
  assert.ok(initialBytes > 0);
  time.advance(5);
  store.expand("o", "m", { input: "y", previous_response_id: "r" });
  assert.equal(store.size, 1);
  assert.equal(store.bytes, initialBytes);
  time.advance(5);
  assert.equal(store.size, 0);
  assert.equal(store.bytes, 0);
});

test("owner and global entry limits evict LRU entries without evicting another owner unnecessarily", () => {
  const store = new ResponsesHistoryStore({ maxEntries: 2, maxOwnerEntries: 2 });
  assert.equal(store.remember("a", "m", "a1", response("a1", [])), true);
  assert.equal(store.remember("b", "m", "b1", response("b1", [])), true);
  store.expand("a", "m", { input: "branch", previous_response_id: "a1" });
  assert.equal(store.remember("a", "m", "a2", response("a2", [])), true);
  assert.throws(() => store.expand("b", "m", { input: "x", previous_response_id: "b1" }), /previous_response_id/);
  assert.equal(store.expand("a", "m", { input: "x", previous_response_id: "a1" }).input.length, 2);
  assert.equal(store.remember("a", "m", "a3", response("a3", [])), true);
  assert.throws(() => store.expand("a", "m", { input: "x", previous_response_id: "a2" }), /previous_response_id/);
});

test("owner byte budget evicts only that owner's oldest entry", () => {
  const store = new ResponsesHistoryStore({ maxOwnerBytes: 300, maxBytes: 1000 });
  assert.equal(store.remember("a", "m", "first", response("first", [])), true);
  assert.equal(store.remember("a", "m", "second", response("second", [])), true);
  assert.equal(store.remember("b", "m", "other", response("other", [])), true);
  assert.throws(() => store.expand("a", "m", { input: "x", previous_response_id: "first" }), /previous_response_id/);
  assert.doesNotThrow(() => store.expand("b", "m", { input: "x", previous_response_id: "other" }));
});

test("global byte budget evicts the least recently read snapshot across owners", () => {
  const probe = new ResponsesHistoryStore();
  probe.remember("a", "m", "x", response("r1", []));
  const entryBytes = probe.bytes;
  const store = new ResponsesHistoryStore({ maxBytes: entryBytes * 2 });
  store.remember("a", "m", "x", response("r1", []));
  store.remember("b", "m", "x", response("r2", []));
  store.expand("a", "m", { input: [], previous_response_id: "r1" });
  store.remember("c", "m", "x", response("r3", []));
  assert.equal(store.size, 2);
  assert.equal(store.bytes, entryBytes * 2);
  assert.throws(() => store.expand("b", "m", { input: [], previous_response_id: "r2" }), /previous_response_id/);
  assert.doesNotThrow(() => store.expand("a", "m", { input: [], previous_response_id: "r1" }));
  assert.doesNotThrow(() => store.expand("c", "m", { input: [], previous_response_id: "r3" }));
});

test("child snapshots survive parent eviction and support independent branches", () => {
  const store = new ResponsesHistoryStore({ maxEntries: 2 });
  store.remember("o", "m", "root", response("parent"));
  const childInput = store.expand("o", "m", { input: "child question", previous_response_id: "parent" }).input;
  store.remember("o", "m", childInput, response("child"));
  const siblingInput = store.expand("o", "m", { input: "sibling question", previous_response_id: "parent" }).input;
  // Read the child last so inserting its sibling evicts only the parent.
  store.expand("o", "m", { input: [], previous_response_id: "child" });
  store.remember("o", "m", siblingInput, response("sibling"));
  assert.throws(() => store.expand("o", "m", { input: [], previous_response_id: "parent" }), /previous_response_id/);
  const child = store.expand("o", "m", { input: "child followup", previous_response_id: "child" }).input;
  const sibling = store.expand("o", "m", { input: "sibling followup", previous_response_id: "sibling" }).input;
  assert.equal(child[0].content[0].text, "root");
  assert.equal(sibling[0].content[0].text, "root");
  assert.equal(child[2].content[0].text, "child question");
  assert.equal(sibling[2].content[0].text, "sibling question");
  assert.equal(child.length, 5);
  assert.equal(sibling.length, 5);
});

test("mutating input, output, and expanded request fields cannot change stored snapshots", () => {
  const store = new ResponsesHistoryStore();
  const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "original" }] }];
  const completed = response("r");
  store.remember("o", "m", input, completed);
  const bytes = store.bytes;
  input[0].content[0].text = "changed input";
  completed.output[0].content[0].text = "changed output";
  completed.output.push({ type: "reasoning" });
  const request = { input: [], previous_response_id: "r", metadata: { nested: ["original"] } };
  const expanded = store.expand("o", "m", request);
  assert.equal(expanded.input[0].content[0].text, "original");
  assert.equal(expanded.input[1].content[0].text, "answer");
  expanded.input[1].content[0].text = "changed read";
  expanded.metadata.nested.push("changed");
  assert.deepEqual(request.metadata, { nested: ["original"] });
  assert.equal(store.expand("o", "m", { input: [], previous_response_id: "r" }).input[1].content[0].text, "answer");
  assert.equal(store.bytes, bytes);
});

test("metadata consumes cache budgets while expanded input has an independent limit", () => {
  const probe = new ResponsesHistoryStore();
  probe.remember("o", "m", [], response("r", []));
  const baseBytes = probe.bytes;
  const longer = new ResponsesHistoryStore();
  longer.remember("o", "m中文", [], response("r中文", []));
  assert.equal(longer.bytes - baseBytes, Buffer.byteLength("中文中文"));
  for (const budget of ["maxBytes", "maxOwnerBytes", "maxEntryBytes"]) {
    const store = new ResponsesHistoryStore({ [budget]: baseBytes });
    assert.equal(store.remember("o", "m", [], response("r", [])), true);
    for (const [model, id] of [["m".repeat(500), "r"], ["m", "r".repeat(500)]]) {
      assert.throws(() => store.remember("o", model, [], response(id, [])), (error) => error.statusCode === 413 && error.code === "response_history_limit");
    }
    assert.equal(store.bytes, baseBytes);
    assert.equal(store.size, 1);
    assert.deepEqual(store.expand("o", "m", { input: [], previous_response_id: "r" }).input, []);
  }
  const tiny = new ResponsesHistoryStore({ maxEntryBytes: 2 });
  assert.deepEqual(tiny.expand("o", "m", { input: [] }).input, []);
  assert.throws(() => tiny.remember("o", "m", [], response("r", [])), (error) => error.statusCode === 413);
});

test("same response ids in different owners do not overwrite each other", () => {
  const store = new ResponsesHistoryStore();
  store.remember("a", "m", "first", response("shared", []));
  store.remember("b", "m", "second", response("shared", []));
  assert.equal(store.size, 2);
  assert.equal(store.expand("a", "m", { input: [], previous_response_id: "shared" }).input[0].content[0].text, "first");
  assert.equal(store.expand("b", "m", { input: [], previous_response_id: "shared" }).input[0].content[0].text, "second");
});

test("relay session metadata is private and follows only the matching owner/model response", () => {
  const store = new ResponsesHistoryStore();
  store.remember("owner", "gpt-test", "hello", response("resp", []), { sessionId: "relay-session", promptCacheKey: "cache-key" });
  assert.equal(store.sessionFor("owner", "gpt-test", "resp"), "relay-session");
  assert.equal(store.sessionFor("other-owner", "gpt-test", "resp"), null);
  assert.equal(store.sessionFor("owner", "other-model", "resp"), null);
  assert.equal(store.sessionFor("owner", "gpt-test", "missing"), null);
  assert.equal(store.promptCacheKeyFor("owner", "gpt-test", "resp"), "cache-key");
  assert.equal(store.promptCacheKeyFor("other-owner", "gpt-test", "resp"), null);
  assert.equal(store.promptCacheKeyFor("owner", "other-model", "resp"), null);
  assert.equal(store.promptCacheKeyFor("owner", "gpt-test", "missing"), null);
});
