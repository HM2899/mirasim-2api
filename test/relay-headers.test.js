import assert from "node:assert/strict";
import test from "node:test";
import { relayHeaders } from "../src/server.js";

test("replaces caller authorization with the logged-in Mirasim credential", () => {
  const headers = relayHeaders({ accept: "text/event-stream", authorization: "Bearer caller-value", "anthropic-version": "2023-06-01" }, "mirasim-login-token");
  assert.equal(headers.Authorization, "Bearer mirasim-login-token");
  assert.equal(headers.Accept, "text/event-stream");
  assert.equal(headers["x-mirasim-client"], "0.0.147");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.match(headers["x-mirasim-call"], /^[0-9a-f-]{36}$/);
});
