// Mirasim signs the agent header as relay metadata. The endpoint no longer supplies a reliable
// default: Claude and Codex must be explicit, just as DeepSeek, Kimi and ZCode already are.
// The 0.0.338 official table also includes Pi and GUI integrations, but neither declares a
// stable cloud-model ID and wire protocol that an API proxy can safely expose. Do not invent a
// model alias for either of them.
export const RELAY_AGENT_MODELS = {
  dsh: ["deepseek-flash", "deepseek-v4-pro"],
  // One id, because the relay serves exactly one. `kimi-code/k3` is the name the desktop
  // client shows and the name its own catalog lists, but it is not the name that goes on the
  // wire: the client rewrites it before the request leaves the machine. See RELAY_MODEL_ALIASES.
  kimi: ["kimi-k3"],
  zcode: ["glm-5.3-flash", "glm-5.3"]
};

// The wire format the relay serves each agent on, from the official client's own table.
// Claude answers Anthropic Messages, Codex the Responses API, and DeepSeek and Kimi are
// served on OpenAI chat completions. ZCode uses the Anthropic Messages contract, matching its
// official `https://api.z.ai/api/anthropic` upstream shape. An agent asked on any other
// endpoint answers `400 The request was rejected as invalid.` whatever the request says.
export const RELAY_AGENT_WIRE = {
  claude: "anthropic-messages",
  codex: "responses",
  dsh: "chat-completions",
  kimi: "chat-completions",
  zcode: "anthropic-messages"
};

// The relay knows Kimi by one name. The desktop client offers `kimi-code/k3` and maps it to
// `kimi-k3` before it sends anything; the unmapped id is refused exactly the way a made-up
// name is. This gateway advertised the unmapped ids until now, so they are kept as aliases
// rather than dropped — a client already configured with one keeps working.
const RELAY_MODEL_ALIASES = {
  // 0.0.338 renamed its cloud V4 Flash slot to `deepseek-flash` (label: v4.1-flash).
  // Retain the desktop's prior labels as aliases so configured clients keep working.
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
  "kimi-code/k3": "kimi-k3",
  "kimi-code/k3-256k": "kimi-k3",
  "kimi-code/kimi-for-coding": "kimi-k3",
  "kimi-code/kimi-for-coding-highspeed": "kimi-k3",
  k3: "kimi-k3"
};

// A vendor shipping a model this file has not caught up with still routes correctly: an id keeps
// its vendor's own namespace, which is what the desktop client keys on as well. The patterns are
// deliberately anchored to that namespace so nothing else can fall into them.
const AGENT_PATTERNS = [
  ["dsh", /^deepseek[-/]/i],
  ["kimi", /^(?:kimi[-/]|moonshot[-/])/i],
  ["zcode", /^(?:glm[-/]|zcode[-/])/i]
];

// The agent this model has to be requested under. `claude` and `codex` used to be implicit in
// the path, but current official clients include this signed metadata in every relay request.
export function relayAgentFor(model) {
  const requested = typeof model === "string" ? model.trim() : "";
  if (!requested) return null;
  // An alias routes to the agent that serves what it stands for rather than to whatever its
  // own spelling suggests: `k3` names a Kimi model and nothing about the string says so.
  const id = relayModelFor(requested) || requested;
  if (/^claude[-/]/i.test(id)) return "claude";
  if (/^gpt[-/]/i.test(id)) return "codex";
  for (const [agent, models] of Object.entries(RELAY_AGENT_MODELS)) {
    if (models.includes(id)) return agent;
  }
  for (const [agent, pattern] of AGENT_PATTERNS) {
    if (pattern.test(id)) return agent;
  }
  return null;
}

// The endpoint this model's upstream is served on, or null for a model no agent claims.
// Which downstream protocol the client speaks does not decide this — the upstream does.
export function relayWireFor(model) {
  const agent = relayAgentFor(model);
  return agent ? RELAY_AGENT_WIRE[agent] || null : null;
}

export function relayAgentForPath(path) {
  const pathname = new URL(path, "http://localhost").pathname;
  if (["/v1/responses", "/backend-api/codex/responses", "/v1/chat/completions", "/v1/images/generations", "/v1/images/edits"].includes(pathname)) return "codex";
  return "claude";
}

// The name this model goes upstream under, or null for a name that is already the relay's own.
export function relayModelFor(model) {
  const id = typeof model === "string" ? model.trim() : "";
  return id && Object.hasOwn(RELAY_MODEL_ALIASES, id) ? RELAY_MODEL_ALIASES[id] : null;
}
