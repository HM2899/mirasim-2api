import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { holdStreamOpen } from "../src/queue-keepalive.js";

const DELAY_MS = 50;
const INTERVAL_MS = 100;
const PING = 'event: ping\ndata: {"type":"ping"}\n\n';
const COMMENT = ": keepalive\n\n";
const OWNED_EVENTS = ["close", "finish", "error", "drain"];

class FakeResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  closed = false;
  statusCode = 200;
  headers = {};
  headCalls = [];
  writes = [];
  ends = [];
  writeResult = true;
  socket = { setNoDelay: (value) => { this.noDelay = value; } };

  writeHead(statusCode, headers) {
    assert.equal(this.headersSent, false, "headers must only be committed once");
    this.statusCode = statusCode;
    Object.assign(this.headers, headers);
    this.headersSent = true;
    this.headCalls.push({ statusCode, headers });
    return this;
  }

  setHeader(name, value) {
    assert.equal(this.headersSent, false);
    this.headers[name] = value;
    return this;
  }

  removeHeader(name) {
    assert.equal(this.headersSent, false);
    delete this.headers[name];
  }

  write(chunk) {
    assert.equal(this.writableEnded || this.destroyed || this.closed, false);
    this.writes.push(chunk);
    return this.writeResult;
  }

  end(chunk) {
    assert.equal(this.writableEnded || this.destroyed || this.closed, false);
    this.ends.push(chunk);
    this.writableEnded = true;
    this.emit("finish");
    return this;
  }
}

function fixture(context, options = {}, response = new FakeResponse()) {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const timeout = context.mock.method(globalThis, "setTimeout");
  const interval = context.mock.method(globalThis, "setInterval");
  const clearTimeout = context.mock.method(globalThis, "clearTimeout");
  const clearInterval = context.mock.method(globalThis, "clearInterval");
  const listeners = new Map(OWNED_EVENTS.map((event) => [event, response.listeners(event)]));
  const hold = holdStreamOpen(response, { delayMs: DELAY_MS, intervalMs: INTERVAL_MS, ...options });
  context.after(() => hold.stop());
  return {
    response,
    hold,
    tick: (ms) => context.mock.timers.tick(ms),
    assertStopped() {
      for (const event of OWNED_EVENTS) {
        assert.deepEqual(response.listeners(event), listeners.get(event), `${event} listeners must be restored`);
      }
      for (const [created, cleared] of [[timeout, clearTimeout], [interval, clearInterval]]) {
        for (const call of created.mock.calls) {
          assert.ok(cleared.mock.calls.some(({ arguments: [handle] }) => handle === call.result), "every timer must be cleared");
        }
      }
    }
  };
}

for (const [protocol, path, heartbeat] of [
  ["anthropic", "/v1/messages", PING],
  ["openai", "/v1/chat/completions", COMMENT],
  ["openai", "/v1/responses", COMMENT]
]) {
  test(`${path} delays the SSE 200 and uses the protocol's heartbeat`, (context) => {
    const { hold, response, tick, assertStopped } = fixture(context, { protocol, path });
    tick(DELAY_MS - 1);
    assert.equal(hold.committed, false);
    assert.equal(response.headersSent, false);
    assert.deepEqual(response.writes, []);

    tick(1);
    assert.equal(hold.committed, true);
    assert.deepEqual(response.headCalls, [{ statusCode: 200, headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    } }]);
    assert.equal(response.noDelay, true);
    assert.deepEqual(response.writes, [heartbeat]);
    tick(INTERVAL_MS - 1);
    assert.equal(response.writes.length, 1);
    tick(1);
    assert.deepEqual(response.writes, [heartbeat, heartbeat]);

    hold.stop();
    assertStopped();
    tick(INTERVAL_MS * 10);
    assert.equal(response.writes.length, 2);
    // The upstream forwarding code still calls these after the hold has stopped.
    assert.equal(response.writeHead(503, { "Content-Type": "application/json" }), response);
    assert.equal(response.setHeader("X-Upstream", "late"), response);
    response.removeHeader("Content-Type");
    assert.equal(response.headCalls.length, 1);
    assert.equal(response.headers["Content-Type"], "text/event-stream; charset=utf-8");
    assert.equal(response.headers["X-Upstream"], undefined);
  });
}

test("a quick refusal retains the real HTTP status and original header methods", (context) => {
  const response = new FakeResponse();
  const originals = [response.writeHead, response.setHeader, response.removeHeader];
  const { hold, tick, assertStopped } = fixture(context, {}, response);
  tick(DELAY_MS - 1);
  hold.stop();
  hold.stop();
  assertStopped();
  assert.equal(hold.committed, false);
  assert.deepEqual([response.writeHead, response.setHeader, response.removeHeader], originals);
  response.setHeader("X-Test", "kept");
  response.writeHead(429, { "Content-Type": "application/json" });
  response.end('{"error":{"message":"Too many requests"}}');
  tick(DELAY_MS + INTERVAL_MS * 10);
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["Content-Type"], "application/json");
  assert.equal(response.headers["X-Test"], "kept");
  assert.deepEqual(response.writes, []);
  assert.equal(response.ends.length, 1);
});

for (const backpressureAt of [1, 2]) {
  test(`write(false) on heartbeat ${backpressureAt} pauses until drain without buffering more heartbeats`, (context) => {
    const { hold, response, tick, assertStopped } = fixture(context);
    if (backpressureAt === 1) response.writeResult = false;
    tick(DELAY_MS);
    if (backpressureAt === 2) {
      response.writeResult = false;
      tick(INTERVAL_MS);
    }
    assert.equal(response.writes.length, backpressureAt);
    assert.equal(response.listenerCount("drain"), 1);
    for (let index = 0; index < 20; index += 1) tick(INTERVAL_MS);
    assert.equal(response.writes.length, backpressureAt);
    assert.equal(response.listenerCount("drain"), 1);

    response.writeResult = true;
    response.emit("drain");
    assert.equal(response.listenerCount("drain"), 0);
    tick(INTERVAL_MS);
    assert.equal(response.writes.length, backpressureAt + 1);

    response.writeResult = false;
    tick(INTERVAL_MS);
    assert.equal(response.listenerCount("drain"), 1, "backpressure can recur without accumulating listeners");
    hold.stop();
    hold.stop();
    assertStopped();
    response.emit("drain");
    tick(INTERVAL_MS * 10);
    assert.equal(response.writes.length, backpressureAt + 2);
  });
}

for (const phase of ["before commit", "after commit", "backpressured"]) {
  test(`stop ${phase} removes only owned listeners and clears all timers`, (context) => {
    const response = new FakeResponse();
    const external = () => {};
    for (const event of OWNED_EVENTS) response.on(event, external);
    const { hold, tick, assertStopped } = fixture(context, {}, response);
    if (phase === "backpressured") response.writeResult = false;
    if (phase !== "before commit") tick(DELAY_MS);
    const writes = response.writes.length;
    hold.stop();
    hold.stop();
    assertStopped();
    for (const event of OWNED_EVENTS) response.emit(event);
    tick(DELAY_MS + INTERVAL_MS * 10);
    assert.equal(response.writes.length, writes);
    assert.deepEqual(response.ends, []);
  });
}

for (const event of ["close", "finish", "error"]) {
  for (const afterCommit of [false, true]) {
    test(`${event} ${afterCommit ? "after" : "before"} commit stops all writes and cleans up`, (context) => {
      const { hold, response, tick, assertStopped } = fixture(context);
      response.writeResult = false;
      if (afterCommit) tick(DELAY_MS);
      // Observe the event itself, without relying on flags being updated first.
      response.emit(event, event === "error" ? new Error("socket failed") : undefined);
      assertStopped();
      hold.fail(503, { message: "Late upstream failure" });
      hold.stop();
      response.emit("drain");
      tick(DELAY_MS + INTERVAL_MS * 10);
      assert.equal(hold.committed, afterCommit);
      assert.equal(response.writes.length, afterCommit ? 1 : 0);
      assert.deepEqual(response.ends, []);
    });
  }
}

for (const property of ["headersSent", "writableEnded", "destroyed", "closed"]) {
  test(`a response with ${property} set is not taken over and leaves no resources`, (context) => {
    const { hold, response, tick, assertStopped } = fixture(context);
    response[property] = true;
    tick(DELAY_MS);
    assert.equal(hold.committed, false);
    assert.deepEqual(response.headCalls, []);
    assert.deepEqual(response.writes, []);
    assertStopped();
  });
}

for (const property of ["writableEnded", "destroyed", "closed"]) {
  test(`a committed response that becomes ${property} stops on the next beat`, (context) => {
    const { hold, response, tick, assertStopped } = fixture(context);
    tick(DELAY_MS);
    response[property] = true;
    tick(INTERVAL_MS);
    assertStopped();
    hold.fail(504);
    assert.equal(response.writes.length, 1);
    assert.deepEqual(response.ends, []);
  });
}

for (const phase of ["writeHead", "first write", "later write"]) {
  test(`a thrown ${phase} cleans up without escaping the timer callback`, (context) => {
    const { hold, response, tick, assertStopped } = fixture(context);
    if (phase === "later write") tick(DELAY_MS);
    context.mock.method(response, phase === "writeHead" ? "writeHead" : "write", () => { throw new Error("socket failed"); });
    assert.doesNotThrow(() => tick(phase === "later write" ? INTERVAL_MS : DELAY_MS));
    assertStopped();
    hold.fail(503);
    assert.deepEqual(response.ends, []);
  });
}

test("a close emitted during the first write cannot leave a timer or drain listener behind", (context) => {
  const { hold, response, tick, assertStopped } = fixture(context);
  context.mock.method(response, "write", () => {
    response.emit("close");
    return false;
  });
  tick(DELAY_MS);
  assertStopped();
  hold.fail(503);
  tick(INTERVAL_MS * 10);
  assert.equal(response.write.mock.callCount(), 1);
  assert.deepEqual(response.ends, []);
});

for (const [protocol, path, expected] of [
  ["anthropic", "/v1/messages", 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Capacity is full"}}\n\n'],
  ["openai", "/v1/responses", 'event: error\ndata: {"type":"error","code":"model_capacity_exhausted","message":"Capacity is full","param":null}\n\n'],
  ["openai", "/v1/chat/completions", 'data: {"error":{"message":"Capacity is full","type":"overloaded_error","param":null,"code":"model_capacity_exhausted"}}\n\ndata: [DONE]\n\n']
]) {
  test(`${path} failure after commit keeps the SSE 200 and original error shape`, (context) => {
    const { hold, response, tick, assertStopped } = fixture(context, { protocol, path });
    response.writeResult = false;
    tick(DELAY_MS);
    hold.fail(503, { type: "overloaded_error", message: "Capacity is full", code: "model_capacity_exhausted" });
    assertStopped();
    assert.equal(response.headCalls[0].statusCode, 200, "the already-sent HTTP status remains 200");
    assert.equal(response.statusCode, 503, "request logs retain the actual failure status");
    assert.deepEqual(response.ends, [expected]);
    hold.fail(504);
    response.emit("drain");
    tick(INTERVAL_MS * 10);
    assert.equal(response.writes.length, 1);
    assert.equal(response.ends.length, 1);
  });
}

for (const [status, anthropicType, openaiType] of [
  [400, "invalid_request_error", "invalid_request_error"],
  [429, "rate_limit_error", "rate_limit_exceeded"],
  [500, "api_error", "server_error"],
  [503, "overloaded_error", "server_error"],
  [504, "timeout_error", "server_error"],
  [529, "overloaded_error", "server_error"]
]) {
  for (const protocol of ["anthropic", "openai"]) {
    test(`${protocol} failure ${status} retains its fallback error type and message`, (context) => {
      const { hold, response, tick, assertStopped } = fixture(context, { protocol });
      tick(DELAY_MS);
      hold.fail(status);
      const payload = JSON.parse(response.ends[0].split("\n").find((line) => line.startsWith("data: ")).slice(6));
      assert.equal(payload.error.type, protocol === "anthropic" ? anthropicType : openaiType);
      assert.equal(payload.error.message, `The upstream returned HTTP ${status}.`);
      if (protocol === "openai") assert.equal(payload.error.code, null);
      assertStopped();
    });
  }
}

test("failure cleans up even when ending the response throws", (context) => {
  const { hold, response, tick, assertStopped } = fixture(context);
  response.writeResult = false;
  tick(DELAY_MS);
  context.mock.method(response, "end", () => { throw new Error("end failed"); });
  assert.throws(() => hold.fail(503), /end failed/);
  assertStopped();
  response.emit("drain");
  tick(INTERVAL_MS * 10);
  assert.equal(response.writes.length, 1);
});
