import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { RelayRequestLog } from "../src/request-log.js";
import { isPlatformQueueRefusal, platformQueueRetryMs, relayQueueInfo, waitForPlatformQueue } from "../src/relay-queue.js";

// A get-only fake permits malformed values that the real Headers constructor rejects.
const headers = (values = {}) => ({ get: (name) => values[name] ?? null });
const emptyInfo = { queueClass: null, cause: null, position: null, etaMs: null, waitMs: null };
const numericFields = [
  ["x-router-queue-position", "position"],
  ["x-router-queue-eta-ms", "etaMs"],
  ["x-router-throttle-wait-ms", "waitMs"]
];

test("relay queue headers become a bounded, normalized observation", () => {
  assert.deepEqual(relayQueueInfo(new Headers({
    "X-Router-Queue-Class": " shared ",
    "X-Router-Queue-Cause": " refused ",
    "X-Router-Queue-Position": " 12 ",
    "X-Router-Queue-Eta-Ms": "2500.9",
    "X-Router-Throttle-Wait-Ms": "0",
    "Authorization": "Bearer never-log-this",
    "X-Unrelated": "ignored"
  })), { queueClass: "shared", cause: "refused", position: 12, etaMs: 2500, waitMs: 0 });
});

test("missing, unrelated, and empty headers contain no queue observation", () => {
  for (const value of [undefined, null, {}, headers(), new Headers(), headers({
    "x-router-queue-class": " \t ",
    "x-router-queue-cause": "unknown",
    "x-router-queue-position": "",
    "x-router-queue-eta-ms": " ",
    "x-router-throttle-wait-ms": "not a number",
    "retry-after": "5"
  })]) assert.equal(relayQueueInfo(value), null);
});

test("only the documented refused cause is recorded", () => {
  assert.deepEqual(relayQueueInfo(headers({ "x-router-queue-cause": "refused" })), { ...emptyInfo, cause: "refused" });
  for (const value of ["Refused", "REFUSED", "queued", "busy", "refused, refused"]) {
    assert.equal(relayQueueInfo(headers({ "x-router-queue-cause": value })), null);
  }
});

for (const [header, field] of numericFields) {
  test(`${header} accepts finite, nonnegative safe numbers and floors fractions`, () => {
    for (const [value, expected] of [["0", 0], [" 7 ", 7], ["3.9", 3], ["1e3", 1000], [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER]]) {
      assert.deepEqual(relayQueueInfo(headers({ [header]: value })), { ...emptyInfo, [field]: expected }, value);
    }
  });

  test(`${header} rejects invalid, negative, unsafe, and oversized values`, () => {
    for (const value of ["", " ", "-1", "-0.5", "NaN", "Infinity", "1e309", "12ms", "1, 2", String(Number.MAX_SAFE_INTEGER + 1), "0".repeat(81), "1\n2", "1\r2", "1\u00002"]) {
      assert.equal(relayQueueInfo(headers({ [header]: value })), null, JSON.stringify(value));
    }
  });
}

test("queue class text is capped at 80 characters and ignores invalid fields independently", () => {
  const queueClass = "x".repeat(80);
  assert.deepEqual(relayQueueInfo(headers({ "x-router-queue-class": queueClass })), { ...emptyInfo, queueClass });
  assert.equal(relayQueueInfo(headers({ "x-router-queue-class": "x".repeat(81) })), null);
  assert.deepEqual(relayQueueInfo(headers({
    "x-router-queue-class": "x".repeat(81),
    "x-router-queue-position": "-1",
    "x-router-queue-eta-ms": "NaN",
    "x-router-throttle-wait-ms": "42"
  })), { ...emptyInfo, waitMs: 42 });
});

test("queue class rejects embedded control characters", () => {
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    assert.equal(relayQueueInfo(headers({ "x-router-queue-class": `shared${String.fromCharCode(code)}pool` })), null, `control character ${code}`);
  }
});

test("only HTTP 503 plus explicit platform queue evidence is a queue refusal", () => {
  const evidence = [
    { headers: headers({ "x-router-queue-class": "shared" }) },
    { refusalBody: JSON.stringify({ code: "platform_queue_full", message: "queue full" }) },
    { refusalBody: JSON.stringify({ error: { code: "platform_queue_full", message: "queue full" } }) },
    { refusalBody: 'event: error\r\ndata: {"error":{"code":"platform_queue_full"}}\r\n\r\n' }
  ];
  for (const details of evidence) {
    assert.equal(isPlatformQueueRefusal({ status: 503, ...details }), true);
    assert.equal(isPlatformQueueRefusal({ status: 503, ...details, refusalComplete: true }), true);
    assert.equal(isPlatformQueueRefusal({ status: 503, ...details, refusalComplete: false }), false, "an incomplete refusal must not be retried, even with explicit queue evidence");
    for (const status of [200, 400, 403, 429, 500, 502, 504, 529]) {
      assert.equal(isPlatformQueueRefusal({ status, ...details }), false, `HTTP ${status} must not trigger platform queue retry`);
    }
  }
});

test("legacy overloads, partial observations, and malformed errors do not trigger queue retries", () => {
  for (const upstream of [
    undefined,
    null,
    {},
    { status: 503 },
    { status: 503, headers: headers({ "x-router-queue-position": "5", "x-router-queue-cause": "refused", "retry-after": "2" }) },
    { status: 503, headers: headers({ "x-router-queue-class": "x".repeat(81) }) },
    ...["", "not json", "null", "[]", "503", '{"error":"platform_queue_full"}',
      JSON.stringify({ error: { type: "overloaded_error", message: "platform queue is full" } }),
      JSON.stringify({ error: { code: "model_capacity_exhausted", type: "overloaded_error" } }),
      JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
      JSON.stringify({ error: { code: "PLATFORM_QUEUE_FULL" } })
    ].map((refusalBody) => ({ status: 503, refusalBody }))
  ]) assert.equal(isPlatformQueueRefusal(upstream), false, JSON.stringify(upstream));
});

test("numeric Retry-After uses the first segment with a one-second floor and 60-second ceiling", () => {
  for (const [value, expected] of [["0.001", 1000], ["0.9", 1000], ["1", 1000], ["1.5", 1500], [" 12 ", 12000], ["60", 60000], ["120", 60000], ["1e308", 60000], ["3, 50", 3000], [" 2 , invalid", 2000]]) {
    assert.equal(platformQueueRetryMs(headers({ "retry-after": value })), expected, value);
  }
});

test("missing, invalid, date, zero, and negative Retry-After use five seconds", () => {
  for (const value of [undefined, null, {}, headers()]) assert.equal(platformQueueRetryMs(value), 5000);
  for (const value of ["", " ", "0", "-0", "-1", "NaN", "Infinity", "1e309", "soon", "5 seconds", "Wed, 21 Oct 2015 07:28:00 GMT", "invalid, 2", "0, 2", ", 2"]) {
    assert.equal(platformQueueRetryMs(headers({ "retry-after": value })), 5000, value);
  }
});

function waitFixture(context) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const setTimer = context.mock.method(globalThis, "setTimeout");
  const clearTimer = context.mock.method(globalThis, "clearTimeout");
  const request = Object.assign(new EventEmitter(), { aborted: false });
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false });
  const external = () => {};
  const events = [[request, "aborted"], [response, "close"], [response, "finish"]];
  for (const [emitter, event] of events) emitter.on(event, external);
  return {
    request,
    response,
    setTimer,
    tick: (ms) => context.mock.timers.tick(ms),
    assertPending() {
      for (const [emitter, event] of events) assert.equal(emitter.listenerCount(event), 2, event);
    },
    assertClean() {
      for (const [emitter, event] of events) assert.deepEqual(emitter.listeners(event), [external], event);
      for (const call of setTimer.mock.calls) {
        assert.ok(clearTimer.mock.calls.some(({ arguments: [handle] }) => handle === call.result), "wait timer must be cleared");
      }
    }
  };
}

test("queue wait resolves true only after its requested delay and then removes owned listeners", async (context) => {
  const { request, response, setTimer, tick, assertPending, assertClean } = waitFixture(context);
  let settled = false;
  const waiting = waitForPlatformQueue(request, response, 5000).then((result) => { settled = true; return result; });
  assertPending();
  tick(4999);
  await Promise.resolve();
  assert.equal(settled, false);
  tick(1);
  assert.equal(await waiting, true);
  assertClean();
  request.emit("aborted");
  response.emit("close");
  response.emit("finish");
  tick(10000);
  assert.equal(await waiting, true);
  assert.equal(setTimer.mock.callCount(), 1, "completion must not schedule polling or another wait");
  assertClean();
});

for (const [target, event] of [["request", "aborted"], ["response", "close"], ["response", "finish"]]) {
  test(`${target} ${event} cancels the queue wait and cleans up before the timer expires`, async (context) => {
    const fixture = waitFixture(context);
    const { request, response, tick, assertPending, assertClean } = fixture;
    const waiting = waitForPlatformQueue(request, response, 5000);
    assertPending();
    tick(2000);
    fixture[target].emit(event);
    assertClean();
    assert.equal(await waiting, false);
    fixture[target].emit(event);
    tick(10000);
    assert.equal(await waiting, false);
    assertClean();
  });
}

for (const [target, property] of [["request", "aborted"], ["response", "destroyed"], ["response", "writableEnded"]]) {
  test(`an already ${property} ${target} never installs a wait timer or listeners`, async (context) => {
    const fixture = waitFixture(context);
    fixture[target][property] = true;
    assert.equal(await waitForPlatformQueue(fixture.request, fixture.response, 5000), false);
    assert.equal(fixture.setTimer.mock.callCount(), 0);
    fixture.assertClean();
  });
}

test("attempt logging retains the default shape when optional headers contain no queue info", () => {
  const log = new RelayRequestLog({ now: () => 0 });
  const entry = log.open("/v1/messages", Buffer.from("{}"));
  log.attempt(entry);
  for (const value of [null, new Headers(), headers({ "retry-after": "5" }), headers({
    "x-router-queue-class": "x".repeat(81),
    "x-router-queue-position": "-1",
    "x-router-queue-eta-ms": "NaN",
    "x-router-throttle-wait-ms": "Infinity",
    "x-router-queue-cause": "unknown"
  })]) log.attempt(entry, { id: "account-a" }, 100, 503, value);
  for (const [index, attempt] of entry.attempts.entries()) {
    assert.deepEqual(Object.keys(attempt).sort(), ["account", "at", "priority", "status"]);
    const { at, ...fields } = attempt;
    assert.ok(Number.isFinite(Date.parse(at)));
    assert.deepEqual(fields, index === 0 ? { account: null, priority: null, status: 0 } : { account: "account-a", priority: 100, status: 503 });
  }
});

test("attempt logging adds only bounded queue information actually reported by the relay", () => {
  const log = new RelayRequestLog({ now: () => 0 });
  const entry = log.open("/v1/messages", Buffer.from("{}"));
  const queueClass = "x".repeat(80);
  const values = {
    "x-router-queue-class": queueClass,
    "x-router-queue-cause": "refused",
    "x-router-queue-position": String(Number.MAX_SAFE_INTEGER),
    "x-router-queue-eta-ms": "10.8",
    "x-router-throttle-wait-ms": "0",
    "authorization": "Bearer secret",
    "retry-after": "5"
  };
  log.attempt(entry, { id: "account-a" }, 100, 503, headers(values));
  log.attempt(entry, { id: "account-a" }, 100, 200, headers({ "x-router-throttle-wait-ms": "1234" }));
  assert.deepEqual(entry.attempts[0].queue, { queueClass, cause: "refused", position: Number.MAX_SAFE_INTEGER, etaMs: 10, waitMs: 0 });
  assert.deepEqual(entry.attempts[1].queue, { ...emptyInfo, waitMs: 1234 });
  assert.deepEqual(Object.keys(entry.attempts[0]).sort(), ["account", "at", "priority", "queue", "status"]);
  assert.doesNotMatch(JSON.stringify(entry.attempts), /secret|authorization|retry-after/);
  values["x-router-queue-class"] = "mutated";
  assert.equal(entry.attempts[0].queue.queueClass, queueClass, "attempts retain their original observation");
  const [snapshot] = log.snapshot();
  assert.deepEqual(snapshot.attempts, entry.attempts);
});
