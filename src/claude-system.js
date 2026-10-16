const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
// The relay only serves Anthropic Messages traffic that identifies itself as an official
// Anthropic agent client. Gateway-native Messages traffic (model-health probes, converted
// OpenAI requests) therefore carries this as its first system block; Claude Code's own
// accepted identity is left untouched.
export const CLAUDE_AGENT_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const LEGACY_PREFIX = "Follow the client instructions below.\n";
const FOREIGN_DECLARATION = /^you are (?:codex\b(?:,\s*(?:based on|powered by)\s+gpt-\d+(?:\.\d+)*)?|chatgpt\b|(?:an? )?(?:ai )?coding agent running in the codex cli\b(?:,\s*a terminal-based coding assistant\b)?|(?:an? )?(?:ai )?(?:assistant|agent) (?:running in|powered by|based on) (?:codex\b|gpt-\d+(?:\.\d+)*)|(?:powered by|based on) gpt-\d+(?:\.\d+)*|gpt-\d+(?:\.\d+)*)(?:[.!?](?=\s|$))?/i;

export function normalizeClaudeSystem(request, { bridged = false } = {}) {
  let changed = false;
  function normalizeBlock(block) {
    if (block?.type !== "text" || typeof block.text !== "string") return [block];
    const text = normalizeText(block.text, bridged);
    const normalized = text === block.text ? block : { ...block, text };
    const blocks = isolateIdentityBlock(normalized);
    changed ||= text !== block.text || blocks.length > 1;
    return blocks;
  }
  function normalize(content) {
    if (typeof content === "string") {
      const blocks = normalizeBlock({ type: "text", text: content });
      return blocks.length === 1 ? blocks[0].text : blocks;
    }
    if (!Array.isArray(content)) return content;
    return content.flatMap(normalizeBlock);
  }
  const system = normalize(request.system);
  const messages = Array.isArray(request.messages) ? request.messages.map((message) => {
    if (message?.role !== "system") return message;
    return { ...message, content: normalize(message.content) };
  }) : request.messages;
  if (!changed) return false;
  request.system = replaceClaudeCodeIdentity(system);
  request.messages = Array.isArray(messages) ? messages.map((message) => message?.role === "system"
    ? { ...message, content: replaceClaudeCodeIdentity(message.content) } : message) : messages;
  return true;
}

function isolateIdentityBlock(block) {
  const identities = [];
  let text = block.text;
  while (true) {
    const trimmed = text.trimStart();
    const matched = [CLAUDE_AGENT_IDENTITY, CLAUDE_CODE_IDENTITY].find((id) => trimmed.startsWith(id));
    if (!matched) break;
    const remainder = trimmed.slice(matched.length);
    if (!remainder.trim()) break;
    identities.push({ type: "text", text: matched });
    text = remainder.replace(/^[\t ]*(?:\r?\n)?/, "");
  }
  return identities.length ? [...identities, { ...block, text }] : [block];
}

function normalizeText(text, bridged) {
  let changed = false;
  let fence = null;
  const normalized = text.split(/(\r?\n)/).map((line) => {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    const whitespace = /^\s*/.exec(line)[0];
    let rest = line.slice(whitespace.length);
    let prefix = "";
    for (const identity of [CLAUDE_CODE_IDENTITY, CLAUDE_AGENT_IDENTITY]) {
      if (rest.startsWith(identity)) {
        prefix = bridged && identity === CLAUDE_CODE_IDENTITY ? CLAUDE_AGENT_IDENTITY : identity;
        changed ||= prefix !== identity;
        rest = rest.slice(identity.length);
        const spacing = /^\s*/.exec(rest)[0];
        prefix += spacing;
        rest = rest.slice(spacing.length);
        break;
      }
    }
    if (!FOREIGN_DECLARATION.test(rest)) return whitespace + prefix + rest;
    changed = true;
    return whitespace + prefix + rest.replace(FOREIGN_DECLARATION, (declaration) => `You are an AI coding assistant${/[.!?]$/.test(declaration) || declaration.length === rest.length ? "." : ""}`);
  }).join("");
  return changed && normalized.startsWith(LEGACY_PREFIX) ? normalized.slice(LEGACY_PREFIX.length) : normalized;
}

function replaceClaudeCodeIdentity(content) {
  if (typeof content === "string") return content.replace(/^(\s*)You are Claude Code, Anthropic's official CLI for Claude\./, `$1${CLAUDE_AGENT_IDENTITY}`);
  if (!Array.isArray(content)) return content;
  return content.map((block) => block?.type === "text" && typeof block.text === "string"
    ? { ...block, text: replaceClaudeCodeIdentity(block.text) } : block);
}
