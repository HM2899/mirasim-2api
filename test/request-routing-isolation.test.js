import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createGateway } from "../src/server.js";

const MODEL = "claude-opus-5-5";
const PUBLIC_STREAM_PATHS = ["/v1/messages", "/v1/chat/completions", "/v1/responses"];

test("identical native Claude conversations retain independent account affinity for two API keys", { timeout: 10_000 }, async (context) => {
  const accounts = [];
  const fixture = await gatewayFixture(context, async (url, options) => {
    assert.equal(url.pathname, "/v1/messages");
    accounts.push(new Headers(options.headers).get("x-mirasim-account"));
    return messageResponse();
  });
  const [clientA, clientB] = fixture.keys;
  assert.notEqual(clientA.record.id, clientB.record.id);
  const body = {
    model: MODEL,
    max_tokens: 128,
    stream: false,
    system: "Answer the shared fixture question briefly.",
    messages: [{ role: "user", content: "The same first message for both clients." }]
  };

  // Deliberately no prompt_cache_key, cache_control or client session metadata: this tests the
  // generic system/first-message affinity keys, not the separately scoped relay-session keys.
  // The extra B repeat distinguishes real affinity from coincidental round-robin A/B/A/B.
  const clients = [clientA, clientB, clientA, clientB, clientB, clientA];
  const expected = ["acct1", "acct2", "acct1", "acct2", "acct2", "acct1"];
  for (const [index, client] of clients.entries()) {
    const response = await fixture.ask("/v1/messages", body, client);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, "OK");
    assert.deepEqual(accounts, expected.slice(0, index + 1));
    const entry = await fixture.finishedLog(response.headers.get("x-mirasim-request-id"));
    assert.equal(entry.apiKey.id, client.record.id);
    assert.equal(entry.account, expected[index]);
    assert.equal(entry.status, 200);
  }
});

for (const [startingMode, nextMode, firstAccount, laterAccount] of [
  ["spread", "waterfall", "acct1", "acct3"],
  ["waterfall", "spread", "acct3", "acct1"]
]) {
  test(`${startingMode} retries retain their starting mode after a live switch to ${nextMode}`, { timeout: 10_000 }, async (context) => {
    const quota = { acct1: 0.1, acct2: 0.4, acct3: 0.8 };
    const accounts = [];
    const heldAttempt = Promise.withResolvers();
    let phase = "seed";
    const fixture = await gatewayFixture(context, async (url, options) => {
      assert.equal(url.pathname, "/v1/messages");
      const account = new Headers(options.headers).get("x-mirasim-account");
      accounts.push(account);
      if (phase === "switch" && accounts.length === 1) {
        // Keep the first attempt genuinely in flight until the console confirms the change.
        await heldAttempt.promise;
        return new Response(JSON.stringify({ error: { type: "server_error", message: "Temporary backend failure" } }), {
          status: 503,
          headers: { "content-type": "application/json" }
        });
      }
      return messageResponse({ "anthropic-ratelimit-unified-5h-utilization": String(quota[account]) });
    }, { accountCount: 3 });
    context.after(() => heldAttempt.resolve());

    // Seed the real pool's quota observations through relay responses. Fresh first messages
    // prevent affinity from masking the mode under test; unknown accounts start at zero used.
    for (let index = 0; index < 3; index += 1) {
      const response = await fixture.ask("/v1/messages", messageRequest(`Seed account ${index}`));
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.deepEqual(accounts, ["acct1", "acct2", "acct3"]);
    await fixture.setMode(startingMode);
    accounts.length = 0;
    phase = "switch";

    const inFlight = fixture.ask("/v1/messages", messageRequest("In-flight mode-switch request"));
    // Attach a rejection handler immediately, including on a failed assertion/cleanup path.
    void inFlight.catch(() => {});
    try {
      await waitFor(() => accounts.length === 1, "The first upstream attempt did not start");
      assert.equal(accounts[0], firstAccount);
      await fixture.setMode(nextMode);
    } finally {
      heldAttempt.resolve();
    }
    const response = await inFlight;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, "OK");
    assert.deepEqual(accounts, [firstAccount, "acct2"], "retry must use the old mode, not the newly configured opposite ordering");
    const entry = await fixture.finishedLog(response.headers.get("x-mirasim-request-id"));
    assert.deepEqual(entry.attempts.map(({ account, status }) => ({ account, status })), [
      { account: firstAccount, status: 503 },
      { account: "acct2", status: 200 }
    ]);

    phase = "later";
    const later = await fixture.ask("/v1/messages", messageRequest("New request after the mode switch"));
    assert.equal(later.status, 200);
    await later.text();
    assert.deepEqual(accounts, [firstAccount, "acct2", laterAccount], "a subsequent request must honor the new mode");
  });
}

for (const path of PUBLIC_STREAM_PATHS) {
  test(`${path} disconnects during a pre-header queue hold without retrying or counting local heartbeats as TTFB`, { timeout: 10_000 }, async (context) => {
    let attempts = 0;
    let upstreamSignal;
    let upstreamAborted = false;
    const fixture = await gatewayFixture(context, async (url, options) => {
      assert.equal(url.pathname, "/v1/messages");
      attempts += 1;
      upstreamSignal = options.signal;
      // Never return upstream headers or a body. Only the gateway's local queue heartbeat can
      // reach the client, and a real downstream disconnect must interrupt this wait itself.
      return new Promise((resolve, reject) => {
        const abort = () => {
          upstreamAborted = true;
          reject(options.signal.reason);
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
      });
    }, { config: { queueHoldDelayMs: 20, queueHoldIntervalMs: 30 } });
    const response = await fixture.ask(path, streamRequest(path));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const requestId = response.headers.get("x-mirasim-request-id");
    const reader = response.body.getReader();
    try {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      assert.match(new TextDecoder().decode(chunk.value), path === "/v1/messages"
        ? /^(event: ping\ndata: \{"type":"ping"\}\n\n)+$/
        : /^(: keepalive\n\n)+$/);
      assert.equal(attempts, 1);
      assert.equal(upstreamSignal.aborted, false);
      const waiting = await fixture.log(requestId);
      assert.equal(waiting.pending, true);
      assert.equal(waiting.stage, "waiting_headers");
      assert.equal(waiting.ttfbMs, null, "locally generated heartbeat is not an upstream first byte");
      assert.equal(waiting.firstOutputMs, null);
      assert.equal(waiting.firstTextMs, null);
      assert.equal(waiting.responseBytes, 0);
    } finally {
      await reader.cancel();
    }

    await waitFor(() => upstreamAborted, "Client disconnect did not abort the pending upstream fetch");
    assert.equal(upstreamSignal.aborted, true);
    const entry = await fixture.finishedLog(requestId);
    assert.equal(entry.status, 499);
    assert.equal(entry.stage, "client_disconnected");
    assert.equal(entry.streamError, null);
    assert.equal(entry.ttfbMs, null);
    assert.equal(entry.firstOutputMs, null);
    assert.equal(entry.firstTextMs, null);
    // Let the rejected mock fetch and failover loop settle, so an early 499 log cannot hide a
    // retry on the other eligible account or a later overwrite of the cancellation outcome.
    await delay(50);
    assert.equal(attempts, 1);
    const settled = await fixture.log(requestId);
    assert.equal(settled.status, 499);
    assert.equal(settled.stage, "client_disconnected");
    assert.equal(settled.pending, false);
  });
}

for (const evidence of ["structured error code", "queue-class header"]) {
  test(`platform queue refusal identified by ${evidence} retries the same account after the one-second minimum`, { timeout: 10_000 }, async (context) => {
    const attempts = [];
    const fixture = await gatewayFixture(context, async (url, options) => {
      const headers = new Headers(options.headers);
      attempts.push({
        account: headers.get("x-mirasim-account"),
        session: headers.get("x-mirasim-session"),
        at: Date.now()
      });
      return attempts.length === 1 ? platformQueueResponse(evidence) : messageResponse();
    });
    const response = await fixture.ask("/v1/messages", messageRequest("Retry after platform admission refusal."));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, "OK");
    assert.deepEqual(attempts.map(({ account }) => account), ["acct1", "acct1"]);
    assert.equal(attempts[0].session, attempts[1].session, "admission retry belongs to the same logical request");
    // Retry-After: 0.001 is valid but below the minimum; allow a few ms of clock granularity.
    assert.ok(attempts[1].at - attempts[0].at >= 990, `retried after only ${attempts[1].at - attempts[0].at} ms`);
    const entry = await fixture.finishedLog(response.headers.get("x-mirasim-request-id"));
    assert.equal(entry.status, 200);
    assert.deepEqual(entry.attempts.map(({ account, status }) => ({ account, status })), [
      { account: "acct1", status: 503 },
      { account: "acct1", status: 200 }
    ]);
    if (evidence === "queue-class header") {
      assert.deepEqual(entry.attempts[0].queue, {
        queueClass: "platform", cause: "refused", position: 7, etaMs: 1200, waitMs: 25
      });
    } else {
      assert.equal(entry.attempts[0].queue, undefined, "do not invent queue observations absent relay headers");
    }
  });
}

test("an exhausted pool costs one 429 per account once, then answers locally with Retry-After", { timeout: 10_000 }, async (context) => {
  const accounts = [];
  const resetAt = Math.floor(Date.now() / 1000) + 7200;
  const fixture = await gatewayFixture(context, async (url, options) => {
    accounts.push(new Headers(options.headers).get("x-mirasim-account"));
    return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "quota used" } }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-5h-utilization": "1",
        "anthropic-ratelimit-unified-5h-reset": String(resetAt)
      }
    });
  });
  const first = await fixture.ask("/v1/messages", messageRequest("Pool is spent."));
  assert.equal(first.status, 429);
  assert.deepEqual(accounts, ["acct1", "acct2"]);

  // Every account is now known to be out until the window resets: no further upstream traffic.
  for (const path of ["/v1/messages", "/v1/chat/completions"]) {
    const body = path === "/v1/messages" ? messageRequest("Pool is still spent.") : { model: MODEL, messages: [{ role: "user", content: "Pool is still spent." }] };
    const response = await fixture.ask(path, body);
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("retry-after")) > 0);
    assert.match((await response.json()).error.message, /reached their rate limit/);
  }
  assert.deepEqual(accounts, ["acct1", "acct2"]);
});

for (const code of ["overloaded_error", "model_capacity_exhausted"]) {
  test(`ordinary ${code} still fails over instead of retrying the same account`, { timeout: 10_000 }, async (context) => {
    const accounts = [];
    const fixture = await gatewayFixture(context, async (url, options) => {
      accounts.push(new Headers(options.headers).get("x-mirasim-account"));
      return accounts.length === 1
        ? new Response(JSON.stringify({ error: { type: "overloaded_error", code, message: "Capacity is full" } }), {
          status: 503, headers: { "content-type": "application/json", "retry-after": "0.001" }
        })
        : messageResponse();
    });
    const response = await fixture.ask("/v1/messages", messageRequest("Ordinary capacity failure."));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, "OK");
    assert.deepEqual(accounts, ["acct1", "acct2"]);
    const entry = await fixture.finishedLog(response.headers.get("x-mirasim-request-id"));
    assert.deepEqual(entry.attempts.map(({ account, status }) => ({ account, status })), [
      { account: "acct1", status: 503 },
      { account: "acct2", status: 200 }
    ]);
  });
}

for (const path of PUBLIC_STREAM_PATHS) {
  test(`${path} cancellation during waiting_queue clears the retry wait and remains 499`, { timeout: 10_000 }, async (context) => {
    const accounts = [];
    const fixture = await gatewayFixture(context, async (url, options) => {
      accounts.push(new Headers(options.headers).get("x-mirasim-account"));
      return platformQueueResponse("queue-class header");
    }, { config: { queueHoldDelayMs: 20, queueHoldIntervalMs: 30 } });
    const response = await fixture.ask(path, streamRequest(path));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const requestId = response.headers.get("x-mirasim-request-id");
    const reader = response.body.getReader();
    try {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      assert.match(new TextDecoder().decode(chunk.value), /event: ping|: keepalive/);
      await waitFor(async () => (await fixture.log(requestId)).stage === "waiting_queue", "Request did not enter the platform retry wait");
      const waiting = await fixture.log(requestId);
      assert.equal(waiting.pending, true);
      assert.deepEqual(waiting.attempts.map(({ account, status }) => ({ account, status })), [{ account: "acct1", status: 503 }]);
    } finally {
      await reader.cancel();
    }
    const entry = await fixture.finishedLog(requestId);
    assert.equal(entry.status, 499);
    assert.equal(entry.stage, "client_disconnected");
    assert.equal(entry.streamError, null);
    // Observe past the one-second retry timer, not merely until the close listener logs 499.
    await delay(1_100);
    assert.deepEqual(accounts, ["acct1"]);
    const settled = await fixture.log(requestId);
    assert.equal(settled.pending, false);
    assert.equal(settled.status, 499);
    assert.equal(settled.stage, "client_disconnected");
    assert.equal(settled.attempts.length, 1);
  });
}

test("a platform queue retry that cannot fit the short budget returns one 503 instead of walking the account pool", { timeout: 10_000 }, async (context) => {
  const accounts = [];
  const fixture = await gatewayFixture(context, async (url, options) => {
    accounts.push(new Headers(options.headers).get("x-mirasim-account"));
    return platformQueueResponse("structured error code");
  }, {
    accountCount: 21,
    config: {
      timeoutMs: 250, firstByteTimeoutMs: 250, claudeFirstByteTimeoutMs: 250,
      thinkingFirstByteTimeoutMs: 250, failoverBudgetMs: 250
    }
  });
  const response = await fixture.ask("/v1/messages", messageRequest("A budget shorter than the queue retry interval."));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "platform_queue_full");
  assert.deepEqual(accounts, ["acct1"]);
  const entry = await fixture.finishedLog(response.headers.get("x-mirasim-request-id"));
  assert.equal(entry.status, 503);
  assert.deepEqual(entry.attempts.map(({ account, status }) => ({ account, status })), [{ account: "acct1", status: 503 }]);
});

test("x-should-retry false keeps a cloud-unavailable 503 final even when its error is overloaded_error", { timeout: 10_000 }, async (context) => {
  const accounts = [];
  const fixture = await gatewayFixture(context, async (url, options) => {
    accounts.push(new Headers(options.headers).get("x-mirasim-account"));
    return new Response(JSON.stringify({
      error: { type: "overloaded_error", code: "cloud_unavailable", message: "Cloud relay is unavailable" }
    }), {
      status: 503,
      headers: { "content-type": "application/json", "x-should-retry": "false", "retry-after": "0.001" }
    });
  });
  const response = await fixture.ask("/v1/messages", messageRequest("Do not retry the relay's explicit final refusal."));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-should-retry"), "false");
  assert.equal((await response.json()).error.code, "cloud_unavailable");
  assert.deepEqual(accounts, ["acct1"]);
  const entry = await fixture.finishedLog(response.headers.get("x-mirasim-request-id"));
  assert.equal(entry.status, 503);
  assert.deepEqual(entry.attempts.map(({ account, status }) => ({ account, status })), [{ account: "acct1", status: 503 }]);
});

function platformQueueResponse(evidence) {
  const queueHeaders = evidence === "queue-class header" ? {
    "x-router-queue-class": "platform", "x-router-queue-cause": "refused",
    "x-router-queue-position": "7", "x-router-queue-eta-ms": "1200", "x-router-throttle-wait-ms": "25"
  } : {};
  return new Response(JSON.stringify({
    type: "error",
    error: { type: "overloaded_error", code: evidence === "structured error code" ? "platform_queue_full" : "overloaded_error", message: "Admission queue is full" }
  }), {
    status: 503,
    headers: { "content-type": "application/json", "retry-after": "0.001", ...queueHeaders }
  });
}

function streamRequest(path) {
  return {
    model: MODEL, max_tokens: 128, stream: true,
    ...(path === "/v1/responses" ? { input: "Wait in the relay queue." } : { messages: [{ role: "user", content: "Wait in the relay queue." }] })
  };
}

function messageRequest(content) {
  return { model: MODEL, max_tokens: 128, stream: false, messages: [{ role: "user", content }] };
}

function messageResponse(headers = {}) {
  return new Response(JSON.stringify({
    id: "msg_routing_fixture",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text: "OK" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 }
  }), { headers: { "content-type": "application/json", ...headers } });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3_000;
  do {
    if (await predicate()) return;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(message);
}

async function gatewayFixture(context, fetchImpl, { accountCount = 2, config = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-routing-isolation-"));
  const homes = Array.from({ length: accountCount }, (_, index) => {
    const home = join(root, `account-${index + 1}`);
    mkdirSync(home);
    writeFileSync(join(home, "setting.json"), JSON.stringify({
      auth: { userId: `acct${index + 1}`, token: `local-fixture-token-${index + 1}`, exp: 4_102_444_800 }
    }));
    return home;
  });
  const server = createGateway({
    host: "127.0.0.1", port: 0, homes, apiKeyFile: join(root, "keys.sqlite"),
    // These URLs are intercepted, not contacted. Even an unintended request remains loopback.
    relayUrl: "http://127.0.0.1:1", loginUrl: "http://127.0.0.1:1", models: [],
    webAuth: { username: "console", password: "local-fixture-password", secureCookie: false },
    reasoningMode: "managed", rotationMode: "spread", timeoutMs: 10_000,
    firstByteTimeoutMs: 5_000, claudeFirstByteTimeoutMs: 5_000,
    failoverBudgetMs: 5_000, streamIdleTimeoutMs: 10_000,
    ...config
  }, { fetchImpl, logger: { error() {} } });
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(5_000),
    body: JSON.stringify({ username: "console", password: "local-fixture-password" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  await login.text();
  const consoleRequest = (path, options = {}) => fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(5_000)
  });
  const keys = [];
  for (const name of ["Client A", "Client B"]) {
    const response = await consoleRequest("/api/keys", { method: "POST", body: JSON.stringify({ name }) });
    assert.equal(response.status, 201);
    keys.push(await response.json());
  }
  const log = async (requestId) => {
    const response = await consoleRequest("/api/usage-log");
    assert.equal(response.status, 200);
    const { entries } = await response.json();
    const entry = entries.find((item) => item.requestId === requestId);
    assert.ok(entry, `Missing request log for ${requestId}`);
    return entry;
  };
  return {
    keys,
    log,
    ask(path, body, client = keys[0]) {
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${client.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5_000)
      });
    },
    async setMode(mode) {
      const response = await consoleRequest("/api/rotation-mode", { method: "PUT", body: JSON.stringify({ mode }) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).mode, mode);
      const current = await consoleRequest("/api/rotation-mode");
      assert.equal(current.status, 200);
      assert.equal((await current.json()).mode, mode);
    },
    async finishedLog(requestId) {
      let entry;
      await waitFor(async () => {
        entry = await log(requestId);
        return !entry.pending;
      }, "Request log did not finalize");
      return entry;
    }
  };
}
