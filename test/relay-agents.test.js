import assert from "node:assert/strict";
import test from "node:test";
import { RELAY_AGENT_MODELS, relayAgentFor, relayModelFor, relayWireFor } from "../src/relay-agents.js";
import { loadConfig } from "../src/config.js";

test("every advertised model routes to the agent that advertises it", () => {
  for (const [agent, models] of Object.entries(RELAY_AGENT_MODELS)) {
    for (const id of models) assert.equal(relayAgentFor(id), agent, id);
  }
});

test("a vendor's own namespace routes a model the table has not caught up with", () => {
  assert.equal(relayAgentFor("deepseek-v5-pro"), "dsh");
  assert.equal(relayAgentFor("deepseek/anything"), "dsh");
  assert.equal(relayAgentFor("kimi-code/k4"), "kimi");
  assert.equal(relayAgentFor("moonshot-v2"), "kimi");
  assert.equal(relayAgentFor("glm-5.4"), "zcode");
  assert.equal(relayAgentFor("zcode/next"), "zcode");
  // Case and surrounding whitespace are the client's, not the relay's.
  assert.equal(relayAgentFor("  DeepSeek-V4-Pro  "), "dsh");
});

test("0.0.264 signs Claude and Codex agent metadata explicitly", () => {
  for (const id of ["claude-opus-5", "claude-fable-5"]) assert.equal(relayAgentFor(id), "claude", id);
  for (const id of ["gpt-5.6", "gpt-5.6-sol"]) assert.equal(relayAgentFor(id), "codex", id);
  assert.equal(relayAgentFor("o3-mini"), null);
  assert.equal(relayAgentFor(""), null);
  assert.equal(relayAgentFor("   "), null);
  assert.equal(relayAgentFor(undefined), null);
  assert.equal(relayAgentFor(null), null);
  assert.equal(relayAgentFor({ id: "deepseek-v4-pro" }), null);
});

test("the model names the endpoint its upstream is served on", () => {
  // Each agent answers on one format, so the client's own protocol cannot decide the route:
  // a Kimi request sent to Messages or Responses is a 400 whatever it contains.
  assert.equal(relayWireFor("claude-opus-5"), "anthropic-messages");
  assert.equal(relayWireFor("gpt-5.6-sol"), "responses");
  assert.equal(relayWireFor("kimi-k3"), "chat-completions");
  assert.equal(relayWireFor("kimi-code/k3"), "chat-completions");
  assert.equal(relayWireFor("moonshot-v2"), "chat-completions");
  assert.equal(relayWireFor("deepseek-v4-pro"), "chat-completions");
  assert.equal(relayWireFor("glm-5.3-flash"), "anthropic-messages");
  // An alias routes as what it stands for; nothing in `k3` says which vendor it belongs to.
  assert.equal(relayAgentFor("k3"), "kimi");
  assert.equal(relayWireFor("k3"), "chat-completions");
  // A model no agent claims is left where it arrived.
  assert.equal(relayWireFor("o3-mini"), null);
  assert.equal(relayWireFor(""), null);
});

test("legacy desktop labels resolve to the current relay model id", () => {
  for (const id of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    assert.equal(relayModelFor(id), "deepseek-flash", id);
  }
  for (const id of ["kimi-code/k3", "kimi-code/k3-256k", "kimi-code/kimi-for-coding", "kimi-code/kimi-for-coding-highspeed", "k3"]) {
    assert.equal(relayModelFor(id), "kimi-k3", id);
  }
  assert.equal(relayModelFor("  kimi-code/k3  "), "kimi-k3");
  // A name the relay already answers to is nobody's alias, and neither is anything else.
  assert.equal(relayModelFor("kimi-k3"), null);
  assert.equal(relayModelFor("claude-opus-5"), null);
  assert.equal(relayModelFor("deepseek-flash"), null);
  assert.equal(relayModelFor("deepseek-v4-pro"), null);
  assert.equal(relayModelFor(""), null);
  assert.equal(relayModelFor(undefined), null);
  // Not a lookup that can be walked into Object.prototype.
  assert.equal(relayModelFor("toString"), null);
  assert.equal(relayModelFor("constructor"), null);
});

test("relay agents are configurable, and an unknown one is a typo rather than a silent no-op", () => {
  const base = { MIRASIM_HOMES: "/tmp/mirasim-agents-test" };
  // Off unless asked for: the list only adds ids the relay's own directory leaves out, and
  // the one it leaves out today — DeepSeek — is still refused when asked for.
  assert.deepEqual(loadConfig(base).relayAgents, []);
  assert.deepEqual(loadConfig({ ...base, MIRASIM_RELAY_AGENTS: "dsh,kimi,zcode" }).relayAgents, ["dsh", "kimi", "zcode"]);
  assert.deepEqual(loadConfig({ ...base, MIRASIM_RELAY_AGENTS: "dsh" }).relayAgents, ["dsh"]);
  assert.deepEqual(loadConfig({ ...base, MIRASIM_RELAY_AGENTS: " KIMI , dsh ,kimi" }).relayAgents, ["kimi", "dsh"]);
  // Nothing but what the relay itself advertises.
  assert.deepEqual(loadConfig({ ...base, MIRASIM_RELAY_AGENTS: "none" }).relayAgents, []);
  assert.throws(
    () => loadConfig({ ...base, MIRASIM_RELAY_AGENTS: "dsh,gemini" }),
    /unknown agents: gemini/
  );
});
