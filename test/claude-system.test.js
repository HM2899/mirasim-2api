import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClaudeSystem } from "../src/claude-system.js";

const codeIdentity = "You are Claude Code, Anthropic's official CLI for Claude.";
const agentIdentity = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

test("bridged Claude Code identity is normalized without guessing the client's product", () => {
  const request = { system: [{ type: "text", text: `${codeIdentity}\nFollow the external client's tool instructions.`, cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [
    { role: "system", content: `${codeIdentity}\nKeep this turn scoped.` },
    { role: "user", content: codeIdentity }
  ] };
  assert.equal(normalizeClaudeSystem(request, { bridged: true }), true);
  assert.deepEqual(request.system, [
    { type: "text", text: agentIdentity },
    { type: "text", text: "Follow the external client's tool instructions.", cache_control: { type: "ephemeral", ttl: "1h" } }
  ]);
  assert.deepEqual(request.messages[0].content, [{ type: "text", text: agentIdentity }, { type: "text", text: "Keep this turn scoped." }]);
  assert.equal(request.messages[1].content, codeIdentity);
  assert.equal(normalizeClaudeSystem(request, { bridged: true }), false);
});

test("bridged normalization leaves quoted and fenced Claude Code examples untouched", () => {
  const system = `> ${codeIdentity}\n\`\`\`text\n${codeIdentity}\n\`\`\``;
  const request = { system };
  assert.equal(normalizeClaudeSystem(request, { bridged: true }), false);
  assert.equal(request.system, system);
});

for (const separator of [" ", "\n", "\r\n"]) {
  test(`bridged identity is isolated without rewriting product context (${JSON.stringify(separator)})`, () => {
    const instructions = "Codex CLI is an open source project led by OpenAI. Within this context, Codex refers to the open-source agentic coding interface. Keep user changes safe.";
    const request = { system: `${agentIdentity}${separator}${instructions}` };
    assert.equal(normalizeClaudeSystem(request, { bridged: true }), true);
    assert.deepEqual(request.system, [{ type: "text", text: agentIdentity }, { type: "text", text: instructions }]);
    assert.equal(normalizeClaudeSystem(request, { bridged: true }), false);
  });
}

test("identity separation retains indentation and handles repeated leading identities in one pass", () => {
  const instructions = "    Keep this indented instruction.\n\n> You are Codex.";
  const request = { system: [{ type: "text", text: `${agentIdentity}\n${agentIdentity}\n${instructions}`, cache_control: { type: "ephemeral" } }] };
  normalizeClaudeSystem(request, { bridged: true });
  assert.deepEqual(request.system, [
    { type: "text", text: agentIdentity },
    { type: "text", text: agentIdentity },
    { type: "text", text: instructions, cache_control: { type: "ephemeral" } }
  ]);
  assert.equal(normalizeClaudeSystem(request, { bridged: true }), false);
});

for (const declaration of ["You are Codex, based on GPT-5.", "You are Codex, based on GPT-5.6.", "You are ChatGPT.", "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.", "You are an AI assistant powered by GPT-5."]) {
  test(`Claude system removes conflicting declaration: ${declaration}`, () => {
    const request = { system: `${codeIdentity}\n${declaration} Keep all edits scoped.\nNever expose secrets.`, messages: [] };
    assert.equal(normalizeClaudeSystem(request), true);
    assert.deepEqual(request.system, [
      { type: "text", text: agentIdentity },
      { type: "text", text: "You are an AI coding assistant. Keep all edits scoped.\nNever expose secrets." }
    ]);
    assert.equal(normalizeClaudeSystem(request), false);
  });
}

test("same-line wrapper and legacy masking cannot retain the foreign declaration", () => {
  const request = { system: [
    { type: "text", text: `${codeIdentity} You are Codex. Keep instructions.`, cache_control: { type: "ephemeral", ttl: "1h" } },
    { type: "text", text: "Follow the client instructions below.\nYou are Codex, based on GPT-5.\nUse exec_command." }
  ] };
  normalizeClaudeSystem(request);
  assert.equal(request.system[0].text, agentIdentity);
  assert.equal(request.system[1].text, "You are an AI coding assistant. Keep instructions.");
  assert.deepEqual(request.system[1].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(request.system[2].text, "You are an AI coding assistant.\nUse exec_command.");
});

test("constraints attached to an identity declaration are preserved, not discarded with the sentence", () => {
  const request = { system: "You are Codex, never delete existing files without permission.\nYou are ChatGPT and must preserve user edits." };
  normalizeClaudeSystem(request);
  assert.equal(request.system, "You are an AI coding assistant, never delete existing files without permission.\nYou are an AI coding assistant and must preserve user edits.");
});

test("native identities, product documentation, quotations and fenced examples remain untouched", () => {
  const system = `${codeIdentity}\nFix the Codex integration.\nUse GPT-5.6 in the configuration.\n> You are Codex.\n\`\`\`text\nYou are Codex.\n\`\`\``;
  const request = { system, messages: [] };
  assert.equal(normalizeClaudeSystem(request), true);
  assert.deepEqual(request.system, [
    { type: "text", text: agentIdentity },
    { type: "text", text: `Fix the Codex integration.\nUse GPT-5.6 in the configuration.\n> You are Codex.\n\`\`\`text\nYou are Codex.\n\`\`\`` }
  ]);
});

test("only system instructions are adapted, never user text, tool content or signed thinking", () => {
  const user = { role: "user", content: "You are Codex." };
  const assistant = { role: "assistant", content: [{ type: "thinking", thinking: "You are Codex.", signature: "signed" }, { type: "tool_use", id: "tool", name: "Read", input: { text: "You are Codex." } }] };
  const request = { system: codeIdentity, messages: [user, assistant, { role: "system", content: [{ type: "text", text: "You are Codex. Keep safety rules.", cache_control: { type: "ephemeral" } }], clear_at: "never" }] };
  normalizeClaudeSystem(request);
  assert.equal(request.system, agentIdentity);
  assert.equal(request.messages[0], user);
  assert.equal(request.messages[1], assistant);
  assert.equal(request.messages[2].content[0].text, "You are an AI coding assistant. Keep safety rules.");
  assert.equal(request.messages[2].clear_at, "never");
});
