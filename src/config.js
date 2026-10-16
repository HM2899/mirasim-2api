import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { MIRASIM_CLIENT_VERSION } from "./mirasim-release.js";
import { DEFAULT_ROTATION_MODE, ROTATION_MODES, normalizeRotationMode } from "./pool.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 45_000;
const DEFAULT_KIMI_FIRST_BYTE_TIMEOUT_MS = 120_000;
const DEFAULT_THINKING_FIRST_BYTE_TIMEOUT_MS = 120_000;
// The Claude relay queues a request before it answers and sends nothing — not even headers —
// until a slot frees (`x-router-throttle-wait-ms` measured 24–37s on an idle pool). Abandoning
// that wait only rejoins the same queue from the back on another account.
const DEFAULT_CLAUDE_FIRST_BYTE_TIMEOUT_MS = 180_000;
const DEFAULT_MODEL_LIST_TIMEOUT_MS = 10_000;
const DEFAULT_MODEL_HEALTH_INTERVAL_MS = 1_800_000;
const DEFAULT_MODEL_HEALTH_TIMEOUT_MS = 12_000;
const DEFAULT_COOLDOWN_MS = 30_000;
// How long one request may spend failing over between accounts before it gives the caller the
// last upstream answer instead of trying the next account. Bounds the wait, not the fan-out.
const DEFAULT_FAILOVER_BUDGET_MS = 60_000;
const DEFAULT_MOEMAIL_EXPIRY_MS = 3_600_000;
const DEFAULT_MOEMAIL_CODE_TIMEOUT_MS = 120_000;
const DEFAULT_MOEMAIL_POLL_MS = 2_500;
// Matches the login service compiled into the official Mirasim desktop app.
const DEFAULT_LOGIN_URL = "https://auth.mirasim.ai";
const DEFAULT_CLIENT_VERSION = MIRASIM_CLIENT_VERSION;

// The relay upstreams this gateway is willing to advertise models for. They are the agents the
// relay itself routes — claude and codex are reached by their own paths and need no entry here.
const RELAY_AGENTS = new Set(["dsh", "kimi", "zcode"]);
// Off by default, because this list only adds what the relay's own directory leaves out.
// Kimi no longer needs an entry: `kimi-k3` now comes back from GET /v1/models and /v1/limits
// reports it available, so it is both listed and routed without this setting. DeepSeek is
// still absent from every directory measured, and a completion for one of its ids is refused
// exactly the way a made-up model name is, so advertising it would hand clients ids that can
// only fail. Set MIRASIM_RELAY_AGENTS=dsh,kimi,zcode to list them anyway — the routing is in place
// either way, and it does not depend on this setting.
const DEFAULT_RELAY_AGENTS = [];

// `xhigh` and `max` are the two opt-in rungs the current models add on top of the classic three.
// They only reach an adaptive model, which is steered by the rung rather than a token budget.
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]);
// A floor rather than a default: it lifts a level that came in below it and never lowers one
// that came in above, and it never turns thinking on for a request that asked for none.
const DEFAULT_MIN_REASONING_EFFORT = "none";
const DEFAULT_REASONING_EFFORT = "medium";

export function loadConfig(env = process.env) {
  const relayUrl = requiredUrl(env.MIRASIM_RELAY_URL || "https://relay.mirasim.ai", "MIRASIM_RELAY_URL");
  const loginUrl = requiredUrl(env.MIRASIM_LOGIN_URL || DEFAULT_LOGIN_URL, "MIRASIM_LOGIN_URL");
  const homes = splitList(env.MIRASIM_HOMES);
  const defaultHome = env.MIRASIM_HOME?.trim() || join(homedir(), ".mirasim");
  const databaseFile = resolveFile(env.MIRASIM_DATABASE_FILE || env.MIRASIM_API_KEYS_FILE, join(defaultHome, "mirasim.sqlite"));
  const configuredWebPassword = env.WEB_AUTH_PASSWORD?.trim();
  const generatedWebPassword = !configuredWebPassword;
  const timeoutMs = parsePositiveInt(env.MIRASIM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "MIRASIM_TIMEOUT_MS");
  const firstByteTimeoutMs = Math.min(
    timeoutMs,
    parsePositiveInt(env.MIRASIM_FIRST_BYTE_TIMEOUT_MS, DEFAULT_FIRST_BYTE_TIMEOUT_MS, "MIRASIM_FIRST_BYTE_TIMEOUT_MS")
  );
  const kimiFirstByteTimeoutMs = Math.min(
    timeoutMs,
    parsePositiveInt(env.MIRASIM_KIMI_FIRST_BYTE_TIMEOUT_MS, DEFAULT_KIMI_FIRST_BYTE_TIMEOUT_MS, "MIRASIM_KIMI_FIRST_BYTE_TIMEOUT_MS")
  );
  const thinkingFirstByteTimeoutMs = Math.min(
    timeoutMs,
    parsePositiveInt(env.MIRASIM_THINKING_FIRST_BYTE_TIMEOUT_MS, DEFAULT_THINKING_FIRST_BYTE_TIMEOUT_MS, "MIRASIM_THINKING_FIRST_BYTE_TIMEOUT_MS")
  );
  const claudeFirstByteTimeoutMs = Math.min(
    timeoutMs,
    parsePositiveInt(env.MIRASIM_CLAUDE_FIRST_BYTE_TIMEOUT_MS, DEFAULT_CLAUDE_FIRST_BYTE_TIMEOUT_MS, "MIRASIM_CLAUDE_FIRST_BYTE_TIMEOUT_MS")
  );
  const modelListTimeoutMs = Math.min(
    firstByteTimeoutMs,
    parsePositiveInt(env.MIRASIM_MODEL_LIST_TIMEOUT_MS, DEFAULT_MODEL_LIST_TIMEOUT_MS, "MIRASIM_MODEL_LIST_TIMEOUT_MS")
  );

  return {
    host: env.HOST || "127.0.0.1",
    port: parsePositiveInt(env.PORT, 8787, "PORT"),
    homes: homes.length > 0 ? homes : [defaultHome],
    databaseFile,
    accountRoot: resolveFile(env.MIRASIM_ACCOUNT_ROOT, join(defaultHome, "profiles")),
    moemail: {
      url: optionalUrl(env.MOEMAIL_URL, "MOEMAIL_URL"),
      apiKey: env.MOEMAIL_API_KEY?.trim() || "",
      domain: env.MOEMAIL_DOMAIN?.trim().toLowerCase() || "",
      expiryTimeMs: parsePositiveInt(env.MOEMAIL_EXPIRY_MS, DEFAULT_MOEMAIL_EXPIRY_MS, "MOEMAIL_EXPIRY_MS"),
      codeTimeoutMs: parsePositiveInt(env.MOEMAIL_CODE_TIMEOUT_MS, DEFAULT_MOEMAIL_CODE_TIMEOUT_MS, "MOEMAIL_CODE_TIMEOUT_MS"),
      pollMs: parsePositiveInt(env.MOEMAIL_POLL_MS, DEFAULT_MOEMAIL_POLL_MS, "MOEMAIL_POLL_MS")
    },
    relayUrl,
    loginUrl,
    clientVersion: env.MIRASIM_CLIENT_VERSION?.trim() || DEFAULT_CLIENT_VERSION,
    webAuth: {
      username: env.WEB_AUTH_USERNAME?.trim() || "admin",
      password: configuredWebPassword || randomBytes(18).toString("base64url"),
      generatedPassword: generatedWebPassword,
      secureCookie: env.WEB_AUTH_SECURE_COOKIE === "true"
    },
    models: splitList(env.MIRASIM_MODELS),
    imageModels: splitList(env.MIRASIM_IMAGE_MODELS),
    imageTimeoutMs: Math.min(timeoutMs, parsePositiveInt(env.MIRASIM_IMAGE_TIMEOUT_MS, 180_000, "MIRASIM_IMAGE_TIMEOUT_MS")),
    localCodexTitles: env.MIRASIM_LOCAL_CODEX_TITLES !== "false",
    relayAgents: parseRelayAgents(env.MIRASIM_RELAY_AGENTS),
    rotationMode: parseRotationMode(env.MIRASIM_ROTATION_MODE),
    timeoutMs,
    streamIdleTimeoutMs: parsePositiveInt(env.MIRASIM_STREAM_IDLE_TIMEOUT_MS, 300_000, "MIRASIM_STREAM_IDLE_TIMEOUT_MS"),
    // Once an answer has reached the caller it cannot be retried on another account, so cutting
    // it at the idle timeout only throws away what was already said. A silent upstream is covered
    // by heartbeats toward the caller instead, and only a stall this long ends the stream.
    streamStallTimeoutMs: parsePositiveInt(env.MIRASIM_STREAM_STALL_TIMEOUT_MS, 1_800_000, "MIRASIM_STREAM_STALL_TIMEOUT_MS"),
    streamHeartbeatIntervalMs: parsePositiveInt(env.MIRASIM_STREAM_HEARTBEAT_MS, 15_000, "MIRASIM_STREAM_HEARTBEAT_MS"),
    maxRequestBytes: Math.min(64 * 1024 * 1024, parsePositiveInt(env.MIRASIM_MAX_REQUEST_BYTES, 16 * 1024 * 1024, "MIRASIM_MAX_REQUEST_BYTES")),
    maxStreamBytes: Math.min(16 * 1024 * 1024, parsePositiveInt(env.MIRASIM_MAX_STREAM_BYTES, 16 * 1024 * 1024, "MIRASIM_MAX_STREAM_BYTES")),
    maxSseFrameBytes: Math.min(2 * 1024 * 1024, parsePositiveInt(env.MIRASIM_MAX_SSE_FRAME_BYTES, 2 * 1024 * 1024, "MIRASIM_MAX_SSE_FRAME_BYTES")),
    firstByteTimeoutMs,
    kimiFirstByteTimeoutMs,
    thinkingFirstByteTimeoutMs,
    claudeFirstByteTimeoutMs,
    modelListTimeoutMs,
    modelHealthIntervalMs: parsePositiveInt(env.MIRASIM_MODEL_HEALTH_INTERVAL_MS, DEFAULT_MODEL_HEALTH_INTERVAL_MS, "MIRASIM_MODEL_HEALTH_INTERVAL_MS"),
    modelHealthTimeoutMs: parsePositiveInt(env.MIRASIM_MODEL_HEALTH_TIMEOUT_MS, DEFAULT_MODEL_HEALTH_TIMEOUT_MS, "MIRASIM_MODEL_HEALTH_TIMEOUT_MS"),
    cooldownMs: parsePositiveInt(env.MIRASIM_COOLDOWN_MS, DEFAULT_COOLDOWN_MS, "MIRASIM_COOLDOWN_MS"),
    // How long a streaming request may wait on the relay's queue in silence before the
    // gateway commits the stream and starts sending heartbeats, and how often it sends them.
    queueHoldDelayMs: parsePositiveInt(env.MIRASIM_QUEUE_HOLD_DELAY_MS, 5_000, "MIRASIM_QUEUE_HOLD_DELAY_MS"),
    queueHoldIntervalMs: parsePositiveInt(env.MIRASIM_QUEUE_HOLD_INTERVAL_MS, 10_000, "MIRASIM_QUEUE_HOLD_INTERVAL_MS"),
    failoverBudgetMs: parsePositiveInt(env.MIRASIM_FAILOVER_BUDGET_MS, DEFAULT_FAILOVER_BUDGET_MS, "MIRASIM_FAILOVER_BUDGET_MS"),
    reasoningMode: parseReasoningMode(env.MIRASIM_REASONING_MODE),
    defaultReasoningEffort: parseReasoningEffort(env.MIRASIM_DEFAULT_REASONING_EFFORT, DEFAULT_REASONING_EFFORT),
    minReasoningEffort: parseReasoningEffort(env.MIRASIM_MIN_REASONING_EFFORT, DEFAULT_MIN_REASONING_EFFORT, "MIRASIM_MIN_REASONING_EFFORT")
  };
}

// Most OpenAI-protocol clients never send reasoning_effort, so without a default the upstream
// model answers with thinking off. Set MIRASIM_DEFAULT_REASONING_EFFORT=none to opt back out.
function parseReasoningMode(value) {
  const mode = value?.trim().toLowerCase() || "passthrough";
  if (mode !== "passthrough" && mode !== "managed") throw new Error("MIRASIM_REASONING_MODE must be passthrough or managed");
  return mode;
}

function parseReasoningEffort(value, fallback, name = "MIRASIM_DEFAULT_REASONING_EFFORT") {
  const effort = value === undefined ? "" : String(value).trim().toLowerCase();
  if (!effort) return fallback;
  if (!REASONING_EFFORTS.has(effort)) {
    throw new Error(`${name} must be one of ${[...REASONING_EFFORTS].join(", ")}`);
  }
  return effort === "ultra" ? "max" : effort === "ultracode" ? "xhigh" : effort;
}

// Which relay upstreams beyond the default one this gateway offers. `none` turns the extras off
// and leaves nothing but what the relay itself advertises; an unknown name is a typo worth
// failing on rather than a silently ignored setting that quietly serves nothing.
function parseRelayAgents(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return [...DEFAULT_RELAY_AGENTS];
  if (raw.toLowerCase() === "none") return [];
  const requested = splitList(raw.toLowerCase());
  const unknown = requested.filter((agent) => !RELAY_AGENTS.has(agent));
  if (unknown.length > 0) {
    throw new Error(`MIRASIM_RELAY_AGENTS contains unknown agents: ${unknown.join(", ")}. Choose from ${[...RELAY_AGENTS].join(", ")}, or none.`);
  }
  return [...new Set(requested)];
}

// The rotation mode a fresh pool starts on. Only the seed: once an operator picks one in the
// console it is stored, and the stored choice wins at every later start.
function parseRotationMode(value) {
  const mode = typeof value === "string" ? value.trim() : "";
  if (!mode) return DEFAULT_ROTATION_MODE;
  const normalized = normalizeRotationMode(mode);
  if (!normalized) {
    throw new Error(`MIRASIM_ROTATION_MODE must be one of ${[...ROTATION_MODES].join(", ")}`);
  }
  return normalized;
}

function resolveFile(value, fallback) {
  const file = value?.trim() || fallback;
  return isAbsolute(file) ? file : resolve(file);
}

function requiredUrl(value, name) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return url.toString().replace(/\/+$/, "");
}

function optionalUrl(value, name) {
  if (!value?.trim()) return "";
  return requiredUrl(value, name);
}

function splitList(value) {
  return (value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parsePositiveInt(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
