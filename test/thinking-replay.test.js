import assert from "node:assert/strict";
import test from "node:test";
import { ThinkingReplayStore, isReplayableThinking, toolUseIdsOf } from "../src/thinking-replay.js";

const signed = (text) => [{ type: "thinking", thinking: text, signature: "sig" }];

test("a turn is recalled by any one of its tool_use ids", () => {
  const store = new ThinkingReplayStore();
  store.remember(["toolu_1", "toolu_2"], signed("Consider it."));
  assert.deepEqual(store.recall(["toolu_2"]), signed("Consider it."));
  assert.deepEqual(store.recall(["toolu_missing", "toolu_1"]), signed("Consider it."));
  assert.equal(store.recall(["toolu_missing"]), null);
});

test("only signed thinking is remembered", () => {
  const store = new ThinkingReplayStore();
  store.remember(["toolu_1"], [{ type: "thinking", thinking: "Unsigned.", signature: "" }]);
  assert.equal(store.size, 0);
  assert.equal(store.recall(["toolu_1"]), null);
});

test("a turn expires once its conversation stops replaying it", () => {
  let clock = 0;
  const store = new ThinkingReplayStore({ ttlMs: 100, now: () => clock });
  store.remember(["toolu_1"], signed("Consider it."));
  clock = 150;
  assert.equal(store.recall(["toolu_1"]), null);
});

test("replaying a turn keeps it alive past its original expiry", () => {
  let clock = 0;
  const store = new ThinkingReplayStore({ ttlMs: 100, now: () => clock });
  store.remember(["toolu_1"], signed("Consider it."));
  clock = 80;
  assert.deepEqual(store.recall(["toolu_1"]), signed("Consider it."));
  clock = 150; // Past the original expiry, inside the refreshed one.
  assert.deepEqual(store.recall(["toolu_1"]), signed("Consider it."));
});

// Losing a turn costs its conversation thinking for the rest of its life, because
// chatToAnthropicRequest will not switch thinking back on once a transcript contains a
// tool_use turn it cannot restore. So the cap has to drop turns nobody is replaying, not
// whichever turn happens to be oldest.
test("the turn cap evicts the least recently replayed turn, not the first one stored", () => {
  const store = new ThinkingReplayStore({ maxTurns: 3, now: () => 0 });
  store.remember(["toolu_1"], signed("First."));
  store.remember(["toolu_2"], signed("Second."));
  store.remember(["toolu_3"], signed("Third."));

  // An old conversation is still going: it replays its first turn on every request.
  assert.deepEqual(store.recall(["toolu_1"]), signed("First."));

  store.remember(["toolu_4"], signed("Fourth."));
  assert.equal(store.size, 3);
  assert.deepEqual(store.recall(["toolu_1"]), signed("First."), "the replayed turn survives");
  assert.equal(store.recall(["toolu_2"]), null, "the idle turn is the one dropped");
  assert.deepEqual(store.recall(["toolu_4"]), signed("Fourth."));
});

test("toolUseIdsOf and isReplayableThinking pick out what has to be replayed", () => {
  const content = [
    { type: "thinking", thinking: "Consider it.", signature: "sig" },
    { type: "redacted_thinking", data: "encrypted" },
    { type: "text", text: "Checking." },
    { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
    { type: "tool_use", name: "Read", input: {} }
  ];
  assert.deepEqual(toolUseIdsOf(content), ["toolu_1"]);
  assert.deepEqual(content.filter(isReplayableThinking), [content[0], content[1]]);
  assert.equal(isReplayableThinking({ type: "redacted_thinking", data: "" }), false);
});
