import assert from "node:assert/strict";
import test from "node:test";
import { relayHeaders } from "../src/server.js";

test("replaces caller authorization with the logged-in Mirasim credential", () => {
  const headers = relayHeaders({ accept: "text/event-stream", authorization: "Bearer caller-value", "anthropic-version": "2023-06-01" }, "mirasim-login-token");
  assert.equal(headers.Authorization, "Bearer mirasim-login-token");
  assert.equal(headers.Accept, "text/event-stream");
  assert.equal(headers["x-mirasim-client"], "0.0.516");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["x-mirasim-call"], undefined);
});

// The relay answers every unrecognized User-Agent with `403 this client is not supported; use
// the mirasim client or Claude Code`, and Node's default is one of them. A Claude request only
// has to name the client it is; a request to an agent that is not gated on it must not.
test("states the Mirasim client identity on the Claude upstream only", () => {
  const claude = relayHeaders({ accept: "application/json" }, "token", { agent: "claude" });
  assert.equal(claude["user-agent"], "Mirasim/0.0.516");
  // The default agent is Claude (an Anthropic Messages request), so it is gated too.
  assert.equal(relayHeaders({ accept: "application/json" }, "token")["user-agent"], "Mirasim/0.0.516");
  // A configured version names the same client at that version.
  assert.equal(relayHeaders({ accept: "application/json" }, "token", { clientVersion: "0.0.383", agent: "claude" })["user-agent"], "Mirasim/0.0.383");
  // Codex, DeepSeek and Kimi are not gated on the client, so they are left as they were.
  for (const agent of ["codex", "dsh", "kimi"]) {
    assert.equal(relayHeaders({ accept: "application/json" }, "token", { agent })["user-agent"], undefined, agent);
  }
});
