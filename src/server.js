import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { OpenAIKeyStore, normalizeApiKeyName } from "./api-keys.js";
import { MirasimDashboard, RelayUsageLedger } from "./dashboard.js";
import { ConversationAffinity, MirasimProfilePool } from "./pool.js";
import { WebAuth } from "./web-auth.js";
import { StateDatabase } from "./database.js";
import { MirasimSessionRefresher } from "./session-refresh.js";
import { MirasimModelHealth } from "./model-health.js";
import { MirasimRelaySessions } from "./relay-device.js";
import { RelayRequestLog } from "./request-log.js";
import { ThinkingReplayStore, isReplayableThinking, toolUseIdsOf } from "./thinking-replay.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
// The Mirasim relay only serves claude-* models on the Anthropic Messages API.
const ANTHROPIC_ONLY_MODEL = /^claude/i;
const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;
// The Mirasim relay validates /v1/messages sampling params against the exact values the
// official client sends and answers anything else with a bare 400 ("The request was
// rejected as invalid."): temperature may only be 1, top_p only 0.99, top_k never.
const RELAY_ACCEPTED_TEMPERATURE = 1;
const RELAY_ACCEPTED_TOP_P = 0.99;
// A translated OpenAI or Responses request carries no Anthropic protocol headers of its own,
// so the cache_control blocks this gateway writes reach the relay on a request the official
// client would never send. Default to what that client sends; a caller's own values still win.
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_BETA = "prompt-caching-2024-07-31";
const THINKING_MODEL_SUFFIX = /[-:](?:thinking|think)$/i;
// OpenAI reasoning_effort levels mapped to Anthropic thinking budgets (tokens).
const REASONING_BUDGET_TOKENS = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
// Anthropic requires max_tokens to exceed the thinking budget; keep this much room for the reply.
const THINKING_ANSWER_HEADROOM_TOKENS = 1024;
// The relay only serves Anthropic Messages traffic that identifies itself as an official
// Anthropic agent client, so requests from every other caller need the agent identity as
// their first system block. Claude Code already sends its own accepted identity.
const RELAY_AGENT_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const ACCEPTED_AGENT_IDENTITIES = [RELAY_AGENT_IDENTITY, "You are Claude Code, Anthropic's official CLI for Claude."];
const RESPONSE_HEADERS = new Set(["content-type", "cache-control", "retry-after", "x-request-id", "openai-processing-ms"]);
const PROXY_PATHS = new Set(["/v1/chat/completions", "/v1/messages", "/backend-api/codex/responses"]);
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/login", { file: "login.html", type: "text/html; charset=utf-8" }],
  ["/assets/dashboard.css", { file: "dashboard.css", type: "text/css; charset=utf-8" }],
  ["/assets/dashboard.js", { file: "dashboard.js", type: "text/javascript; charset=utf-8" }],
  ["/assets/login.js", { file: "login.js", type: "text/javascript; charset=utf-8" }]
]);

export function createGateway(config, { fetchImpl = fetch, logger = console } = {}) {
  const database = new StateDatabase(config.databaseFile || config.apiKeyFile, { seedHomes: config.homes });
  config.homes = database.homes();
  const pool = new MirasimProfilePool(config.homes, { cooldownMs: config.cooldownMs });
  for (const home of database.disabledHomes()) pool.disable(home);
  for (const { home, priority } of database.homePriorities()) pool.setPriority(home, priority);
  const usage = new RelayUsageLedger(database);
  const sessions = new MirasimSessionRefresher(config, { fetchImpl });
  const relaySessions = new MirasimRelaySessions(config, { fetchImpl });
  const modelHealth = new MirasimModelHealth(config, pool, { fetchImpl, sessionRefresher: sessions, relaySessions, database });
  const dashboard = new MirasimDashboard(config, pool, usage, { fetchImpl, database, sessionRefresher: sessions });
  const webAuth = new WebAuth(config.webAuth, { database });
  const apiKeys = new OpenAIKeyStore(database, { secret: config.webAuth.password });
  const requestLog = new RelayRequestLog();
  const affinity = new ConversationAffinity();
  const thinkingReplay = new ThinkingReplayStore();
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, config, pool, usage, dashboard, sessions, relaySessions, modelHealth, webAuth, apiKeys, fetchImpl, requestLog, affinity, thinkingReplay);
    } catch (error) {
      logger.error?.("mirasim relay proxy failed", error);
      if (!response.headersSent) sendProtocolError(response, protocolForRequest(request, request.url), error.statusCode || 502, error.message || "The relay request failed.");
      else response.destroy(error);
    }
  });
  server.startModelHealth = () => modelHealth.start();
  server.on("close", () => modelHealth.stop());
  return server;
}

async function handleRequest(request, response, config, pool, usage, dashboard, sessions, relaySessions, modelHealth, webAuth, apiKeys, fetchImpl, requestLog, affinity = null, thinkingReplay = null) {
  const thinking = { defaultEffort: config.defaultReasoningEffort, replay: thinkingReplay };
  const url = new URL(request.url || "/", "http://gateway.local");
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(request);
    const session = webAuth.login(body.username, body.password);
    if (!session) return sendError(response, 401, "用户名或密码不正确。");
    return sendJson(response, 200, { ok: true, expiresAt: new Date(session.expiresAt).toISOString() }, { "Set-Cookie": session.cookie });
  }
  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const cookie = webAuth.logout(request);
    return sendJson(response, 200, { ok: true }, { "Set-Cookie": cookie });
  }
  if (requiresWebAuth(url.pathname) && !webAuth.isAuthenticated(request)) {
    if (url.pathname.startsWith("/api/")) return sendError(response, 401, "请先登录 Web 控制台。");
    return redirectToLogin(response);
  }
  if (request.method === "GET" && STATIC_FILES.has(url.pathname)) {
    return serveStatic(response, STATIC_FILES.get(url.pathname));
  }
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    return sendJson(response, 200, await dashboard.snapshot());
  }
  if (request.method === "GET" && url.pathname === "/api/usage-log") {
    return sendJson(response, 200, { entries: requestLog.snapshot() });
  }
  if (request.method === "GET" && url.pathname === "/api/model-health") {
    return sendJson(response, 200, await modelHealth.current());
  }
  if (request.method === "POST" && url.pathname === "/api/model-health/discover") {
    await modelHealth.discover();
    return sendJson(response, 200, { health: modelHealth.snapshot() });
  }
  const modelCheck = /^\/api\/model-health\/([^/]+)\/check$/.exec(url.pathname);
  if (request.method === "POST" && modelCheck) {
    return sendJson(response, 200, { health: await modelHealth.runOne(decodeURIComponent(modelCheck[1])) });
  }
  if (request.method === "POST" && url.pathname === "/api/referral") {
    const body = await readJson(request);
    return sendJson(response, 200, { referral: await dashboard.createReferral(body.account) });
  }
  if (request.method === "POST" && url.pathname === "/api/invites/redeem") {
    const body = await readJson(request);
    return sendJson(response, 200, await dashboard.redeemInvite(body.account, body.code));
  }
  if (request.method === "POST" && url.pathname === "/api/invites/preview") {
    const body = await readJson(request);
    return sendJson(response, 200, await dashboard.previewRedeemCode(body.account, body.code));
  }
  if (request.method === "POST" && url.pathname === "/api/mirasim/login/code") {
    const body = await readJson(request);
    return sendJson(response, 200, await dashboard.requestLoginCode(body.account, body.email));
  }
  if (request.method === "POST" && url.pathname === "/api/moemail/register") {
    const body = await readJson(request);
    const result = await dashboard.registerMoeMailBatch(body.inviteCode, body.count ?? 1);
    return sendJson(response, result.stopped ? 207 : 201, result);
  }
  if (request.method === "GET" && url.pathname === "/api/moemail/config") {
    return sendJson(response, 200, dashboard.moeMailSettings());
  }
  if (request.method === "POST" && url.pathname === "/api/moemail/domains") {
    const body = await readJson(request);
    return sendJson(response, 200, await dashboard.discoverMoeMailDomains(body));
  }
  if (request.method === "PUT" && url.pathname === "/api/moemail/config") {
    const body = await readJson(request);
    return sendJson(response, 200, dashboard.configureMoeMail(body));
  }
  const accountCooldown = /^\/api\/accounts\/([^/]+)\/cooldown$/.exec(url.pathname);
  if (request.method === "POST" && accountCooldown) {
    return sendJson(response, 200, dashboard.disableAccount(decodeURIComponent(accountCooldown[1])));
  }
  const accountRecover = /^\/api\/accounts\/([^/]+)\/recover$/.exec(url.pathname);
  if (request.method === "POST" && accountRecover) {
    return sendJson(response, 200, dashboard.recoverAccount(decodeURIComponent(accountRecover[1])));
  }
  const accountPriority = /^\/api\/accounts\/([^/]+)\/priority$/.exec(url.pathname);
  if (request.method === "PUT" && accountPriority) {
    const body = await readJson(request);
    return sendJson(response, 200, dashboard.setAccountPriority(decodeURIComponent(accountPriority[1]), body?.priority));
  }
  const renewAccount = /^\/api\/accounts\/([^/]+)\/refresh$/.exec(url.pathname);
  if (request.method === "POST" && renewAccount) {
    return sendJson(response, 200, await dashboard.renewAccount(decodeURIComponent(renewAccount[1])));
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/accounts/")) {
    const key = decodeURIComponent(url.pathname.slice("/api/accounts/".length));
    await dashboard.deleteAccount(key);
    return sendJson(response, 200, { deleted: true });
  }
  if (request.method === "POST" && url.pathname === "/api/accounts/restore") {
    return sendJson(response, 200, await dashboard.restoreAccounts());
  }
  if (request.method === "GET" && url.pathname === "/api/accounts/export") {
    return sendJson(response, 200, dashboard.exportAccounts(), {
      "Content-Disposition": `attachment; filename="mirasim-accounts-${new Date().toISOString().slice(0, 10)}.json"`
    });
  }
  if (request.method === "POST" && url.pathname === "/api/accounts/import") {
    return sendJson(response, 201, dashboard.importAccounts(await readJson(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/mirasim/login/verify") {
    const body = await readJson(request);
    return sendJson(response, 200, await dashboard.verifyLoginCode(body.account, body.email, body.code));
  }
  if (request.method === "GET" && url.pathname === "/api/keys") {
    return sendJson(response, 200, { keys: apiKeys.list() });
  }
  if (request.method === "POST" && url.pathname === "/api/keys") {
    const body = await readJson(request);
    try {
      return sendJson(response, 201, apiKeys.create(normalizeApiKeyName(body.name)));
    } catch (error) {
      return sendError(response, error instanceof RangeError ? 400 : 500, error.message || "无法创建 API Key。");
    }
  }
  const revealApiKey = /^\/api\/keys\/([^/]+)\/reveal$/.exec(url.pathname);
  if (request.method === "POST" && revealApiKey) {
    const key = apiKeys.reveal(decodeURIComponent(revealApiKey[1]));
    if (!key) return sendError(response, 409, "该历史 API Key 未保存完整值，无法恢复。请新建一个密钥后替换。" );
    return sendJson(response, 200, { key });
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/keys/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/keys/".length));
    if (!id) return sendError(response, 400, "缺少 API Key 标识。");
    if (!apiKeys.revoke(id)) return sendError(response, 404, "未找到该 API Key。");
    return sendJson(response, 200, { revoked: true });
  }
  if (request.method === "GET" && url.pathname === "/healthz") {
    await sessions.refreshAll(config.homes);
    return sendJson(response, 200, { status: "ok", profiles: pool.status() });
  }
  const protocol = protocolForRequest(request, url.pathname);
  if (url.pathname.startsWith("/v1/")) {
    if (!apiKeys.authenticate(clientApiKey(request, protocol))) return sendProtocolError(response, protocol, 401, "Missing or invalid API key.");
  }
  if (request.method === "GET" && url.pathname === "/v1/models") {
    const models = await modelList(config, pool, fetchImpl, sessions, relaySessions);
    return sendJson(response, 200, protocol === "anthropic" ? anthropicModelList(models) : models);
  }
  if (request.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/backend-api/codex/responses")) {
    const body = await readBody(request);
    // The relay serves GPT models only on its native Codex endpoint — /v1/chat/completions
    // answers 404 for them — and a Responses request is already in that endpoint's wire
    // format. Passing it through untouched also keeps prompt_cache_key and the Codex
    // identity intact, which is what the upstream prompt cache keys on.
    if (!anthropicOnlyModel(parseJsonObject(body)?.model)) {
      return relayRequest(
        request,
        response,
        config,
        pool,
        usage,
        fetchImpl,
        new URL("/backend-api/codex/responses", url),
        body,
        "openai",
        forwardResponse,
        sessions,
        relaySessions,
        requestLog,
        { path: url.pathname, body },
        affinity
      );
    }
    const translated = responseToChatRequest(body);
    if (!translated.ok) return sendError(response, 400, translated.message);
    const anthropic = chatToAnthropicRequest(translated.chat, thinking);
    if (!anthropic.ok) return sendError(response, 400, anthropic.message);
    return relayRequest(
      request,
      response,
      config,
      pool,
      usage,
      fetchImpl,
      new URL("/v1/messages", url),
      Buffer.from(JSON.stringify(anthropic.request)),
      "openai",
      async (downstream, upstream) => {
        const chatUpstream = await anthropicUpstreamAsChat(upstream, translated.chat, thinkingReplay);
        return translated.stream
          ? forwardResponsesStream(downstream, chatUpstream, translated.request)
          : forwardResponsesResponse(downstream, chatUpstream, translated.request);
      },
      sessions,
      relaySessions,
      requestLog,
      { path: url.pathname, body },
      affinity
    );
  }
  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    const body = await readBody(request);
    const chat = parseJsonObject(body);
    if (chat && anthropicOnlyModel(chat.model)) {
      const anthropic = chatToAnthropicRequest(chat, thinking);
      if (!anthropic.ok) return sendError(response, 400, anthropic.message);
      return relayRequest(
        request,
        response,
        config,
        pool,
        usage,
        fetchImpl,
        new URL("/v1/messages", url),
        Buffer.from(JSON.stringify(anthropic.request)),
        "openai",
        async (downstream, upstream) => forwardResponse(downstream, await anthropicUpstreamAsChat(upstream, chat, thinkingReplay)),
        sessions,
        relaySessions,
        requestLog,
        { path: url.pathname, body },
        affinity
      );
    }
    return relayRequest(request, response, config, pool, usage, fetchImpl, url, body, "openai", forwardResponse, sessions, relaySessions, requestLog, null, affinity);
  }
  if (request.method !== "POST" || !PROXY_PATHS.has(url.pathname)) {
    return sendProtocolError(response, protocol, 404, "Use /, /api/dashboard, /healthz, /v1/models, /v1/chat/completions, /v1/responses, /backend-api/codex/responses, or /v1/messages.");
  }

  const body = await readBody(request);
  return relayRequest(request, response, config, pool, usage, fetchImpl, url, body, protocol, forwardResponse, sessions, relaySessions, requestLog, null, affinity);
}

async function relayRequest(request, response, config, pool, usage, fetchImpl, url, body, protocol = "openai", responseHandler = forwardResponse, sessions = null, relaySessions = null, requestLog = null, clientRequest = null, affinity = null) {
  const prepared = prepareRelayBody(body, url, config.defaultReasoningEffort);
  body = prepared.body;
  // The console reports the request the client sent, not the shape this gateway translated it into.
  const logEntry = requestLog?.open(clientRequest?.path || url.pathname, clientRequest?.body || body);
  const affinityKeys = affinity ? affinityKeysFor(parseJsonObject(clientRequest?.body || body)) : [];
  await sessions?.refreshAll(config.homes);
  const excluded = new Set();
  let profile;
  let usedProfile = null;
  let upstream;

  while ((profile = pool.pick(excluded, preferredHome(affinity, affinityKeys)))) {
    usedProfile = profile;
    upstream = await fetchRelay(request, config, profile, fetchImpl, url, body, relaySessions);
    const retryWithAnotherProfile = upstream.networkError || retryableStatus(upstream.status) || upstream.status === 403;
    if (retryWithAnotherProfile) {
      excluded.add(profile.home);
      if (upstream.networkError || retryableStatus(upstream.status)) {
        pool.failure(profile, retryAfterMs(upstream.headers?.get?.("retry-after")));
      }
      if (upstream.networkError) usage.failure(profile);
      else usage.record(profile, upstream);
      if (pool.hasCandidate(excluded)) {
        await upstream.body?.cancel?.();
        continue;
      }
      break;
    }
    pool.success(profile);
    for (const key of affinityKeys) affinity?.remember(key, profile.home);
    usage.record(profile, upstream);
    break;
  }

  if (!upstream || upstream.networkError) {
    const statusCode = upstream?.timedOut ? 504 : 503;
    const message = upstream?.timedOut
      ? "The Mirasim upstream did not return response headers before the configured timeout."
      : "No logged-in Mirasim relay profile is available. Run `npm run login -- email` or `npm run login -- github`.";
    if (logEntry) {
      logEntry.account = usedProfile?.id || null;
      requestLog.fail(logEntry, statusCode);
    }
    return sendProtocolError(response, protocol, statusCode, message);
  }
  if (logEntry) {
    upstream = requestLog.observe(logEntry, upstream, usedProfile, {
      // Only a pass-through has to hide the usage chunk again; a translating handler
      // needs it to report token counts of its own.
      dropUsageOnlyFrames: prepared.injectedUsage && responseHandler === forwardResponse
    });
  }
  if (prepared.surfaceServerTools) upstream = surfaceServerToolActivity(upstream);
  return responseHandler(response, upstream);
}

// A conversation is identified by what stays byte-stable across its turns: the model, the
// system prompt (or Responses instructions) and the first user message. Later turns append
// to the transcript without touching any of these, so every turn maps to the same key —
// and therefore to the same account, whose prompt cache holds the conversation's prefix.
// The system prompt alone is the second, weaker key: a NEW conversation from the same
// client shares no transcript but does share the (often long) system prefix, so routing it
// to the account its siblings warmed still turns that prefix into a cache read.
function affinityKeysFor(value) {
  if (!value || typeof value !== "object") return [];
  const keys = [];
  const system = affinitySystemText(value);
  const first = firstUserMessage(value);
  if (first !== null) keys.push(hashKey({ model: value.model ?? null, system, first }));
  if (system) keys.push(hashKey({ model: value.model ?? null, system }));
  return keys;
}

// Anthropic carries the system prompt in `system`, Responses in `instructions`, and chat
// completions as leading system/developer messages.
function affinitySystemText(value) {
  const direct = affinityText(value.system ?? value.instructions);
  if (direct) return direct;
  if (!Array.isArray(value.messages)) return null;
  const parts = value.messages
    .filter((message) => message && (message.role === "system" || message.role === "developer"))
    .map((message) => affinityText(message.content))
    .filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

// The first key that resolves wins: the conversation's own account beats the account that
// merely shares the system prompt.
function preferredHome(affinity, keys) {
  for (const key of keys) {
    const home = affinity?.preferred(key);
    if (home) return home;
  }
  return null;
}

function hashKey(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function firstUserMessage(value) {
  if (typeof value.input === "string") return value.input;
  const items = Array.isArray(value.messages) ? value.messages : Array.isArray(value.input) ? value.input : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.role === "user" && item.content !== undefined) return affinityText(item.content);
    if ((item.type === "input_text" || item.type === "text") && typeof item.text === "string") return item.text;
  }
  return null;
}

// Clients flip between the string shorthand and structured content parts from one turn to
// the next, so only the text decides the key: shape changes must not break the binding.
function affinityText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? null : JSON.stringify(content);
  return content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
}

function prepareRelayBody(body, url, defaultEffort = "none") {
  const value = parseJsonObject(body);
  if (!value) return { body, injectedUsage: false };
  let changed = false;
  let injectedUsage = false;
  if (value.model === "claude-flabe-5") {
    value.model = "claude-fable-5";
    changed = true;
  }
  if (protocolForPath(url.pathname) === "anthropic") {
    const system = maskForeignIdentity(withAgentIdentity(value.system));
    if (system !== value.system) {
      value.system = system;
      changed = true;
    }
    if (dropRejectedSamplingParams(value)) changed = true;
    if (applyDefaultThinking(value, defaultEffort)) changed = true;
    if (applySearchFirstGuidance(value)) changed = true;
    // After the identity blocks are settled, so the stable-prefix breakpoint lands on the
    // system array the relay actually receives.
    if (applyCacheBreakpoints(value)) changed = true;
  }
  // The relay reports token usage on a streamed chat completion only when it is asked to,
  // which is what leaves the console with no numbers for OpenAI-protocol traffic.
  if (url.pathname === "/v1/chat/completions" && value.stream === true && value.stream_options === undefined) {
    value.stream_options = { include_usage: true };
    changed = true;
    injectedUsage = true;
  }
  return {
    body: changed ? Buffer.from(JSON.stringify(value)) : body,
    injectedUsage,
    surfaceServerTools: protocolForPath(url.pathname) === "anthropic" && hasServerTool(value)
  };
}

// The relay rejects a /v1/messages system block that opens with the Codex agent identity
// ("You are Codex ..." — leading whitespace does not help), which is exactly how the Codex
// CLI's own instructions begin. A neutral lead-in line keeps the content verbatim while
// the block no longer opens with the foreign identity. The prefix is constant, so the
// masked block stays byte-stable across turns and keeps its prompt-cache hits.
const FOREIGN_IDENTITY_OPENER = /^\s*you are codex\b/i;
const FOREIGN_IDENTITY_LEAD_IN = "Follow the client instructions below.\n";

function maskForeignIdentity(system) {
  if (!Array.isArray(system)) return system;
  let changed = false;
  const masked = system.map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string" || !FOREIGN_IDENTITY_OPENER.test(block.text)) return block;
    changed = true;
    return { ...block, text: FOREIGN_IDENTITY_LEAD_IN + block.text };
  });
  return changed ? masked : system;
}

// A converting gateway (sub2api, new-api) builds its /v1/messages request out of an OpenAI
// one, and the OpenAI protocol has no field for extended thinking — so the request arrives
// with no `thinking` at all and the relay answers with thinking off. That costs more than
// reasoning quality: with thinking off, Claude intermittently writes a tool call into its
// visible text instead of emitting a tool_use block, so the turn succeeds, the tool never
// runs, and nothing reports an error. "No thinking" and "does not call tools" are the same
// bug, and turning thinking on is the fix for both.
//
// Only a request that says nothing gets a default. A caller that asked for
// `{ type: "disabled" }` — or for any thinking of its own — is left exactly as it sent it.
const ADAPTIVE_THINKING_MODEL = /^claude-(?:fable-5|mythos-5|opus-(?:5|4-[678])|sonnet-(?:5|4-6))/i;
// Enough room for thinking and an answer both. A turn under this that asks for no tools is
// the utility call (titles, classification) that genuinely wants thinking off.
const MIN_THINKING_MAX_TOKENS = 2048;

function applyDefaultThinking(value, defaultEffort) {
  if (value.thinking !== undefined) return false;
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!anthropicOnlyModel(model)) return false;
  const budget = REASONING_BUDGET_TOKENS[defaultEffort];
  if (!budget) return false;
  // Whether the turn declares tools is the signal, not how big its budget is. A turn with
  // tools is an agent turn, and it is precisely the turn that breaks with thinking off —
  // Claude writes the call into its visible text and it never runs. Those get thinking
  // whatever max_tokens says, with room made for it when the caller budgeted none; a client
  // that asked Codex to look something up should not lose its search tool to a small budget.
  const agentTurn = Array.isArray(value.tools) && value.tools.length > 0;
  const maxTokens = Number.isFinite(value.max_tokens) ? value.max_tokens : 0;
  // Current models take adaptive thinking and reject a fixed budget outright; the older ones
  // are the other way round, so the shape has to follow the model.
  if (ADAPTIVE_THINKING_MODEL.test(model)) {
    if (maxTokens < MIN_THINKING_MAX_TOKENS && !agentTurn) return false;
    value.thinking = { type: "adaptive" };
    value.max_tokens = Math.max(maxTokens, MIN_THINKING_MAX_TOKENS);
    return true;
  }
  const floor = budget + THINKING_ANSWER_HEADROOM_TOKENS;
  if (maxTokens <= floor && !agentTurn) return false;
  value.thinking = { type: "enabled", budget_tokens: budget };
  value.max_tokens = Math.max(maxTokens, floor + THINKING_ANSWER_HEADROOM_TOKENS);
  // Extended thinking rejects sampling overrides and forced tool choices.
  delete value.temperature;
  delete value.top_p;
  if (value.tool_choice && value.tool_choice.type !== "auto" && value.tool_choice.type !== "none") {
    value.tool_choice = { type: "auto" };
  }
  return true;
}

// Claude reaches for web search far less readily once a system prompt is present: it answers
// from what it already knows unless it is confident a search is needed. A client whose prompt
// was written for another model — Codex's is written for GPT-5 — says nothing about when to
// search, so the tool is offered and then almost never used on its own. Naming the cases that
// need current information is the documented way to restore that.
//
// Only a request that offers a server-side search tool gets this, which is exactly the
// converted-gateway case; Claude Code carries its own client-side WebSearch and its own
// prompt, and is left alone. The text is fixed, so it stays byte-stable across turns and
// keeps the cache it sits in.
const SERVER_SEARCH_TOOL = /^web_(?:search|fetch)(?:_|$)/i;
const SEARCH_FIRST_GUIDANCE = "<search_first>\n"
  + "You have a web search tool. Use it before answering whenever current information would "
  + "change the answer — recent events or releases, current prices, versions, or anything the "
  + "user marks as recent or time-sensitive — rather than answering from memory. For an "
  + "open-ended research request, start searching immediately instead of asking a scoping "
  + "question first, unless the request is genuinely ambiguous about what to research.\n"
  + "</search_first>";

function applySearchFirstGuidance(value) {
  const tools = Array.isArray(value.tools) ? value.tools : [];
  if (!tools.some((tool) => typeof tool?.type === "string" && SERVER_SEARCH_TOOL.test(tool.type))) return false;
  const system = contentBlocks(value.system) || [];
  if (system.some((block) => typeof block?.text === "string" && block.text.includes("<search_first>"))) return false;
  value.system = [...system, { type: "text", text: SEARCH_FIRST_GUIDANCE }];
  return true;
}

function hasServerTool(value) {
  return Array.isArray(value.tools)
    && value.tools.some((tool) => typeof tool?.type === "string" && SERVER_SEARCH_TOOL.test(tool.type));
}

// Anthropic runs a server tool itself and reports it as server_tool_use, but the OpenAI
// protocols have no way to describe a tool the client never ran — so a gateway converting the
// response back drops the block, and the search becomes invisible to the client even though it
// happened. Rewriting the block as ordinary text carries it through anything that speaks the
// protocol at all. The block keeps its index, so the stream's shape is unchanged; only its
// type is. The bulky web_search_tool_result that follows is deliberately left as-is for the
// converter to drop, since the client wants to see that a search ran, not its raw results.
const SERVER_TOOL_TEXT_PREFIX = "🔍 ";

function surfaceServerToolActivity(upstream) {
  const contentType = upstream.headers?.get?.("content-type") || "";
  if (!upstream.ok || !upstream.body) return upstream;
  if (!contentType.includes("text/event-stream")) return jsonServerToolActivity(upstream);
  // The note rides inside the model's own first text block rather than a block of its own.
  // A converter that renders the answer at all therefore renders the note too — a separate
  // block, however well formed, is a structure it may simply not carry.
  const state = { pending: new Map(), queries: [], injected: false };
  let buffer = "";
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const encoder = new TextEncoder();
  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop();
      for (const frame of frames) controller.enqueue(encoder.encode(`${noteServerToolFrame(frame, state)}\n\n`));
    },
    flush(controller) {
      if (buffer) controller.enqueue(encoder.encode(noteServerToolFrame(buffer, state)));
    }
  });
  const body = upstream.body.pipeThrough(transform);
  return { ok: upstream.ok, status: upstream.status, headers: upstream.headers, body,
    text: () => new Response(body).text(), json: () => new Response(body).json() };
}

// Collects what each server tool was asked, then prepends it to the first text the model
// streams. The server_tool_use blocks are left exactly as they are for the converter to drop.
function noteServerToolFrame(frame, state) {
  return frame.split(/\r?\n/).map((line) => {
    if (!line.startsWith("data:")) return line;
    const event = parseJsonObject(Buffer.from(line.slice(5).trimStart()));
    if (!event) return line;
    if (event.type === "content_block_start" && event.content_block?.type === "server_tool_use") {
      state.pending.set(event.index, { name: event.content_block.name || "server tool", json: "" });
      return line;
    }
    if (event.type === "content_block_delta" && state.pending.has(event.index) && event.delta?.type === "input_json_delta") {
      state.pending.get(event.index).json += event.delta.partial_json || "";
      return line;
    }
    if (event.type === "content_block_stop" && state.pending.has(event.index)) {
      const { name, json } = state.pending.get(event.index);
      state.pending.delete(event.index);
      state.queries.push(`${SERVER_TOOL_TEXT_PREFIX}${name} ${serverToolQuery(json)}`);
      return line;
    }
    if (!state.injected && state.queries.length && event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      state.injected = true;
      const note = `${state.queries.join("\n")}\n\n`;
      return `data: ${JSON.stringify({ ...event, delta: { ...event.delta, text: note + (event.delta.text || "") } })}`;
    }
    return line;
  }).join("\n");
}

// The readable query if the tool streamed one, and the raw input otherwise.
function serverToolQuery(json) {
  const parsed = parseJsonObject(Buffer.from(json || "{}"));
  return typeof parsed?.query === "string" ? parsed.query : (json || "").trim();
}

async function jsonServerToolActivity(upstream) {
  const raw = await upstream.text().catch(() => "");
  const payload = parseJsonObject(Buffer.from(raw));
  if (!Array.isArray(payload?.content)) {
    return new Response(raw || null, { status: upstream.status, headers: upstream.headers });
  }
  payload.content = payload.content.map((block) => block?.type === "server_tool_use"
    ? { type: "text", text: `${SERVER_TOOL_TEXT_PREFIX}${block.name || "server tool"} ${JSON.stringify(block.input ?? {})}` }
    : block);
  return new Response(JSON.stringify(payload), { status: upstream.status, headers: upstream.headers });
}

// See RELAY_ACCEPTED_TEMPERATURE: the relay only tolerates the official client's exact
// sampling values, so anything else is removed rather than bounced back as a 400.
function dropRejectedSamplingParams(value) {
  let changed = false;
  if (value.temperature !== undefined && value.temperature !== RELAY_ACCEPTED_TEMPERATURE) {
    delete value.temperature;
    changed = true;
  }
  if (value.top_p !== undefined && value.top_p !== RELAY_ACCEPTED_TOP_P) {
    delete value.top_p;
    changed = true;
  }
  if (value.top_k !== undefined) {
    delete value.top_k;
    changed = true;
  }
  return changed;
}

// Keeps an already-accepted system prompt byte-identical so Claude Code's prompt cache
// still hits; every other caller gets the identity prepended to whatever it sent.
function withAgentIdentity(system) {
  const identity = { type: "text", text: RELAY_AGENT_IDENTITY };
  if (typeof system === "string") {
    if (hasAgentIdentity(system)) return system;
    return system.trim() ? [identity, { type: "text", text: system }] : [identity];
  }
  if (Array.isArray(system)) {
    const first = system.find((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim());
    return hasAgentIdentity(first?.text) ? system : [identity, ...system];
  }
  return [identity];
}

function hasAgentIdentity(text) {
  return typeof text === "string" && ACCEPTED_AGENT_IDENTITIES.some((identity) => text.trimStart().startsWith(identity));
}

async function fetchRelay(request, config, profile, fetchImpl, url, body, relaySessions = null) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, firstByteTimeout(config));
  const abortOnClientDisconnect = () => controller.abort();
  request.once("aborted", abortOnClientDisconnect);
  const headers = await relayRequestHeaders(relaySessions, profile, {
    method: "POST",
    path: url.pathname,
    body,
    accept: request.headers.accept || "application/json",
    contentType: request.headers["content-type"] || "application/json"
  });
  const anthropicUpstream = url.pathname === "/v1/messages";
  const beta = request.headers["anthropic-beta"] || (anthropicUpstream ? DEFAULT_ANTHROPIC_BETA : "");
  const version = request.headers["anthropic-version"] || (anthropicUpstream ? DEFAULT_ANTHROPIC_VERSION : "");
  if (beta) headers["anthropic-beta"] = beta;
  if (version) headers["anthropic-version"] = version;

  try {
    return await fetchImpl(new URL(url.pathname + url.search, `${config.relayUrl}/`), {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      redirect: "error"
    });
  } catch {
    return { networkError: true, timedOut, status: 0, body: null };
  } finally {
    clearTimeout(timeout);
    request.off("aborted", abortOnClientDisconnect);
  }
}

async function modelList(config, pool, fetchImpl, sessions = null, relaySessions = null) {
  await sessions?.refreshAll(config.homes);
  const profile = pool.pick();
  if (!profile) return configuredModels(config);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), modelListTimeout(config));
  try {
    const upstream = await fetchImpl(new URL("/v1/models", `${config.relayUrl}/`), {
      headers: await relayRequestHeaders(relaySessions, profile, { method: "GET", path: "/v1/models", accept: "application/json" }),
      signal: controller.signal,
      redirect: "error"
    });
    if (!upstream.ok) return configuredModels(config);
    const body = await upstream.json();
    const data = normalizeModelList(body?.data);
    if (!data) return configuredModels(config);
    pool.success(profile);
    return { object: "list", data };
  } catch {
    return configuredModels(config);
  } finally {
    clearTimeout(timeout);
  }
}

function configuredModels(config) {
  return {
    object: "list",
    data: config.models.map((id) => ({ id, object: "model", created: 0, owned_by: "mirasim-relay" }))
  };
}

function anthropicModelList(models) {
  const data = models.data.map((model) => ({
    type: "model",
    id: model.id,
    display_name: model.id,
    created_at: new Date(Math.max(0, model.created) * 1_000).toISOString()
  }));
  return {
    data,
    has_more: false,
    first_id: data[0]?.id || null,
    last_id: data.at(-1)?.id || null
  };
}

function normalizeModelList(models) {
  if (!Array.isArray(models)) return null;
  const seen = new Set();
  const data = [];
  for (const model of models) {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!id || id === "*" || seen.has(id)) continue;
    seen.add(id);
    const entry = {
      id,
      object: "model",
      created: Number.isFinite(model?.created) ? model.created : 0,
      owned_by: typeof model?.owned_by === "string" && model.owned_by.trim() ? model.owned_by.trim() : "mirasim-relay"
    };
    if (Number.isFinite(model?.max_input_tokens)) entry.max_input_tokens = model.max_input_tokens;
    if (Number.isFinite(model?.max_output_tokens)) entry.max_output_tokens = model.max_output_tokens;
    data.push(entry);
  }
  return data;
}

function responseToChatRequest(body) {
  let request;
  try {
    request = JSON.parse(body.toString("utf8"));
  } catch {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  const model = typeof request.model === "string" ? request.model.trim() : "";
  if (!model) return { ok: false, message: "A response model is required." };

  const messages = [];
  const instructions = responseContent(request.instructions);
  if (instructions) messages.push({ role: "system", content: instructions });
  const inputMessages = responseInputMessages(request.input);
  if (!inputMessages.length) return { ok: false, message: "A response input is required." };
  messages.push(...inputMessages);

  const chat = { model, messages, stream: request.stream === true };
  for (const field of ["temperature", "top_p", "seed", "parallel_tool_calls", "reasoning", "reasoning_effort", "thinking"]) {
    if (request[field] !== undefined) chat[field] = request[field];
  }
  if (Number.isFinite(request.max_output_tokens)) chat.max_tokens = request.max_output_tokens;
  const tools = responseToolsToChat(request.tools);
  if (tools.length) chat.tools = tools;
  const toolChoice = responseToolChoiceToChat(request.tool_choice);
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  return { ok: true, request, chat, stream: chat.stream };
}

function responseInputMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "input_text" || item.type === "text") {
      const content = responseContent(item.text);
      if (content) messages.push({ role: "user", content });
      continue;
    }
    if (item.type === "function_call") {
      appendResponseFunctionCall(messages, item);
      continue;
    }
    if (item.type === "function_call_output") {
      const content = responseContent(item.output);
      messages.push({ role: "tool", tool_call_id: responseCallId(item), content: content || "" });
      continue;
    }
    const role = responseRole(item.role);
    const content = responseContent(item.content);
    if (role && content) messages.push({ role, content });
  }
  return messages;
}

// A Responses assistant turn arrives as a message item followed by function_call items;
// chat completions expect them folded into one assistant message with tool_calls.
function appendResponseFunctionCall(messages, item) {
  if (typeof item.name !== "string" || !item.name) return;
  const call = {
    id: responseCallId(item),
    type: "function",
    function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : "{}" }
  };
  const last = messages.at(-1);
  if (last?.role === "assistant") {
    (last.tool_calls ??= []).push(call);
  } else {
    messages.push({ role: "assistant", content: null, tool_calls: [call] });
  }
}

function responseCallId(item) {
  return typeof item.call_id === "string" && item.call_id ? item.call_id
    : typeof item.id === "string" && item.id ? item.id
    : `call_${randomUUID().replace(/-/g, "")}`;
}

function responseRole(value) {
  if (value === "developer") return "system";
  return value === "system" || value === "user" || value === "assistant" ? value : null;
}

function responseContent(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value
    .filter((part) => part && typeof part === "object" && (part.type === "input_text" || part.type === "output_text" || part.type === "text"))
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

function responseToolsToChat(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (!tool || tool.type !== "function" || typeof tool.name !== "string" || !tool.name.trim()) return [];
    return [{
      type: "function",
      function: {
        name: tool.name.trim(),
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(tool.parameters && typeof tool.parameters === "object" ? { parameters: tool.parameters } : {})
      }
    }];
  });
}

function responseToolChoiceToChat(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) return toolChoice;
  if (toolChoice.type === "function" && typeof toolChoice.name === "string" && toolChoice.name) {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return toolChoice;
}

function anthropicOnlyModel(model) {
  return typeof model === "string" && ANTHROPIC_ONLY_MODEL.test(model.trim());
}

function parseJsonObject(body) {
  try {
    const value = JSON.parse(body.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function chatToAnthropicRequest(chat, thinking = {}) {
  const requestedModel = typeof chat.model === "string" ? chat.model.trim() : "";
  const model = requestedModel.replace(THINKING_MODEL_SUFFIX, "");
  if (!model) return { ok: false, message: "A chat model is required." };
  const system = [];
  const messages = [];
  for (const message of Array.isArray(chat.messages) ? chat.messages : []) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system" || message.role === "developer") {
      const text = chatMessageText(message.content);
      if (text) system.push({ type: "text", text });
    } else if (message.role === "tool") {
      appendAnthropicToolResult(messages, message);
    } else if (message.role === "assistant") {
      const blocks = anthropicAssistantBlocks(message, thinking.replay);
      if (blocks.length) messages.push({ role: "assistant", content: blocks });
    } else if (message.role === "user") {
      const blocks = anthropicUserBlocks(message.content);
      if (blocks.length) messages.push({ role: "user", content: blocks });
    }
  }
  if (!messages.length) return { ok: false, message: "At least one user or assistant message is required." };
  const request = {
    model,
    max_tokens: Number.isFinite(chat.max_tokens) ? chat.max_tokens
      : Number.isFinite(chat.max_completion_tokens) ? chat.max_completion_tokens
      : DEFAULT_ANTHROPIC_MAX_TOKENS,
    messages
  };
  if (system.length) request.system = system;
  if (chat.stream === true) request.stream = true;
  // Any other value would 400 at the relay, so a mismatched client preference is
  // dropped and the relay default applies instead.
  if (chat.temperature === RELAY_ACCEPTED_TEMPERATURE) request.temperature = chat.temperature;
  if (chat.top_p === RELAY_ACCEPTED_TOP_P) request.top_p = chat.top_p;
  const stop = typeof chat.stop === "string" && chat.stop ? [chat.stop]
    : Array.isArray(chat.stop) ? chat.stop.filter((value) => typeof value === "string" && value) : [];
  if (stop.length) request.stop_sequences = stop;
  const tools = chatToolsToAnthropic(chat.tools);
  if (tools.length) request.tools = tools;
  const toolChoice = chatToolChoiceToAnthropic(chat.tool_choice, chat.parallel_tool_calls);
  if (toolChoice && tools.length) request.tool_choice = toolChoice;
  // Anthropic insists the signed thinking block of a tool_use turn is replayed with its
  // tool_result, and the OpenAI protocols have no field to carry it. anthropicAssistantBlocks
  // restores it from what this gateway streamed out earlier; a turn whose blocks are gone
  // still answers without thinking, because that beats the guaranteed upstream 400.
  //
  // The transcript decides, not just its newest turn. Turning `thinking` on or off is one of
  // the changes that invalidates the whole message cache upstream, and deciding per turn
  // flips it constantly: an agent loop alternates between tool rounds (a tool_use turn is
  // newest, so thinking goes off) and plain answers (nothing to replay, so it comes back on),
  // which costs the message cache on every flip. Reading the whole transcript makes the
  // decision monotonic instead — an unrecoverable turn stays in the history, so a
  // conversation that once answered without thinking keeps doing so and its cache holds.
  // The cost is that such a conversation does not pick thinking back up, which is why
  // ThinkingReplayStore keeps a turn alive for as long as the conversation keeps replaying it.
  const budget = hasUnrestorableToolUse(messages)
    ? null
    : thinkingBudgetTokens(chat, requestedModel, thinking.defaultEffort);
  if (budget) {
    request.thinking = { type: "enabled", budget_tokens: budget };
    request.max_tokens = Math.max(request.max_tokens, budget + THINKING_ANSWER_HEADROOM_TOKENS);
    // Extended thinking rejects sampling overrides and forced tool choices.
    delete request.temperature;
    delete request.top_p;
    if (request.tool_choice && request.tool_choice.type !== "auto" && request.tool_choice.type !== "none") {
      request.tool_choice = { type: "auto" };
    }
  }
  applyCacheBreakpoints(request);
  return { ok: true, request };
}

// The OpenAI protocol has no way to mark Anthropic cache breakpoints, so a conversation
// that reached this gateway through it would be re-billed in full on every turn. That is
// true of the chat-completions translation below and just as true of a /v1/messages
// request that a converting gateway (sub2api, new-api) built from an OpenAI one: it is
// already Anthropic-shaped, so nothing here translates it, but it still carries no
// breakpoint of its own. Both get the same ones.
//
// Anthropic allows four. One pins the stable prefix at the last system block — tools and
// system render ahead of the messages, so that single block covers both — and the rest
// roll along the newest user turns, which is what turns this turn's write into the next
// turn's read. Re-marking the older turns costs nothing (their tokens are already
// cached) and keeps a read anchor when a turn is dropped or the newest breakpoint falls
// outside the relay's lookback window.
const MAX_CACHE_BREAKPOINTS = 4;

function applyCacheBreakpoints(request) {
  if (hasCacheBreakpoint(request)) return false;
  // Anthropic accepts a bare string for `system` and for message content, but a breakpoint
  // has to hang off a block. The rewrite runs over every message rather than only the ones
  // being marked, so a turn does not flip shape as the breakpoints roll past it — that
  // would change the prefix and cost the cache it was meant to keep.
  let changed = false;
  const system = contentBlocks(request.system);
  if (system) {
    changed = system !== request.system;
    request.system = system;
  }
  const userTurns = [];
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    if (!message || typeof message !== "object") continue;
    const content = contentBlocks(message.content);
    if (!content) continue;
    if (content !== message.content) {
      message.content = content;
      changed = true;
    }
    if (message.role === "user") userTurns.push(message);
  }
  const marked = system ? markCacheBreakpoint(system) : false;
  const rolling = MAX_CACHE_BREAKPOINTS - (marked ? 1 : 0);
  for (const message of userTurns.slice(-rolling)) markCacheBreakpoint(message.content);
  return changed || marked || userTurns.length > 0;
}

// A non-empty block array, or the equivalent array for the string shorthand. Anything
// else (empty, absent, malformed) cannot carry a breakpoint and is left alone.
function contentBlocks(value) {
  if (typeof value === "string") return value ? [{ type: "text", text: value }] : null;
  return Array.isArray(value) && value.length ? value : null;
}

// A breakpoint caches everything up to and including the block it sits on, so it goes on
// the last one. A malformed body can end on something that is not a block; marking it
// would throw rather than relay, and the relay rejects the request either way.
function markCacheBreakpoint(blocks) {
  const last = blocks.at(-1);
  if (!last || typeof last !== "object") return false;
  last.cache_control = { type: "ephemeral" };
  return true;
}

function hasCacheBreakpoint(request) {
  const blocks = [
    ...(Array.isArray(request.system) ? request.system : []),
    ...(Array.isArray(request.messages) ? request.messages : [])
      .flatMap((message) => Array.isArray(message?.content) ? message.content : [])
  ];
  return blocks.some((block) => block?.cache_control);
}

// Whether any assistant turn in the transcript calls a tool without the signed thinking that
// Anthropic requires alongside it. True is a one-way door for a conversation: the offending
// turn stays in the history every client sends from here on.
function hasUnrestorableToolUse(messages) {
  return messages.some((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
    return message.content.some((block) => block.type === "tool_use")
      && !message.content.some(isReplayableThinking);
  });
}

function thinkingBudgetTokens(chat, requestedModel, defaultEffort = "none") {
  if (chat.thinking && typeof chat.thinking === "object") {
    if (chat.thinking.type === "disabled") return null;
    if (chat.thinking.type === "enabled" && Number.isFinite(chat.thinking.budget_tokens)) {
      return Math.max(1024, Math.floor(chat.thinking.budget_tokens));
    }
  }
  const effort = typeof chat.reasoning_effort === "string" ? chat.reasoning_effort.trim().toLowerCase()
    : typeof chat.reasoning?.effort === "string" ? chat.reasoning.effort.trim().toLowerCase() : "";
  if (effort === "none") return null;
  if (REASONING_BUDGET_TOKENS[effort]) return REASONING_BUDGET_TOKENS[effort];
  if (THINKING_MODEL_SUFFIX.test(requestedModel)) return REASONING_BUDGET_TOKENS.medium;
  // Nothing in the request asked either way, and most OpenAI-protocol clients never will.
  return REASONING_BUDGET_TOKENS[defaultEffort] ?? null;
}

function chatMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part.type === "text" || part.type === "input_text") && typeof part.text === "string")
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n");
}

function anthropicUserBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const cacheControl = part.cache_control && typeof part.cache_control === "object" ? { cache_control: part.cache_control } : null;
    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string" && part.text) {
      blocks.push({ type: "text", text: part.text, ...cacheControl });
    } else if (part.type === "image_url") {
      const image = anthropicImageBlock(typeof part.image_url === "string" ? part.image_url : part.image_url?.url);
      if (image) blocks.push({ ...image, ...cacheControl });
    }
  }
  return blocks;
}

function anthropicImageBlock(url) {
  if (typeof url !== "string" || !url) return null;
  const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (dataUrl) return { type: "image", source: { type: "base64", media_type: dataUrl[1], data: dataUrl[2] } };
  return /^https?:\/\//.test(url) ? { type: "image", source: { type: "url", url } } : null;
}

function anthropicAssistantBlocks(message, replay = null) {
  const blocks = [];
  // Signed thinking has to lead the turn it belongs to, ahead of any text or tool_use.
  const restored = replay?.recall(toolCallIds(message)) || [];
  blocks.push(...restored);
  const text = chatMessageText(message.content);
  if (text) blocks.push({ type: "text", text });
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (typeof call?.function?.name !== "string" || !call.function.name) continue;
    let input = {};
    try {
      const parsed = JSON.parse(call.function.arguments);
      if (parsed && typeof parsed === "object") input = parsed;
    } catch {}
    blocks.push({
      type: "tool_use",
      id: typeof call.id === "string" && call.id ? call.id : `toolu_${randomUUID().replace(/-/g, "")}`,
      name: call.function.name,
      input
    });
  }
  return blocks;
}

function toolCallIds(message) {
  if (!Array.isArray(message?.tool_calls)) return [];
  return message.tool_calls.map((call) => call?.id).filter((id) => typeof id === "string" && id);
}

function appendAnthropicToolResult(messages, message) {
  const block = {
    type: "tool_result",
    tool_use_id: typeof message.tool_call_id === "string" ? message.tool_call_id : "",
    content: chatMessageText(message.content)
  };
  const last = messages.at(-1);
  if (last?.role === "user" && Array.isArray(last.content) && last.content.every((entry) => entry.type === "tool_result")) {
    last.content.push(block);
  } else {
    messages.push({ role: "user", content: [block] });
  }
}

function chatToolsToAnthropic(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    const fn = tool?.type === "function" ? tool.function : null;
    if (!fn || typeof fn.name !== "string" || !fn.name.trim()) return [];
    return [{
      name: fn.name.trim(),
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      input_schema: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} }
    }];
  });
}

function chatToolChoiceToAnthropic(toolChoice, parallelToolCalls) {
  const parallel = parallelToolCalls === false ? { disable_parallel_tool_use: true } : {};
  if (toolChoice === "none") return { type: "none" };
  if (toolChoice === "required") return { type: "any", ...parallel };
  if (toolChoice && typeof toolChoice === "object" && toolChoice.type === "function" && typeof toolChoice.function?.name === "string") {
    return { type: "tool", name: toolChoice.function.name, ...parallel };
  }
  if (toolChoice === "auto" || parallelToolCalls === false) return { type: "auto", ...parallel };
  return null;
}

async function anthropicUpstreamAsChat(upstream, chat, replay = null) {
  const contentType = upstream.headers?.get?.("content-type") || "";
  if (upstream.ok && contentType.includes("text/event-stream")) {
    const source = Readable.fromWeb(upstream.body);
    const transformed = source.pipe(createAnthropicChatStreamTransform(chat, replay));
    return new Response(Readable.toWeb(transformed), {
      status: upstream.status,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" }
    });
  }
  const raw = upstream.body ? await upstream.text().catch(() => "") : "";
  let payload = null;
  try { payload = JSON.parse(raw); } catch {}
  const converted = upstream.ok ? anthropicMessageToChatCompletion(payload, chat, replay) : anthropicErrorToOpenAi(payload, upstream.status);
  if (!converted) {
    return new Response(raw || null, { status: upstream.status, headers: { "content-type": contentType || "application/json" } });
  }
  return new Response(JSON.stringify(converted), { status: upstream.status, headers: { "content-type": "application/json" } });
}

function anthropicMessageToChatCompletion(message, chat, replay = null) {
  if (!message || message.type !== "message") return null;
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  const toolCalls = content
    .filter((block) => block?.type === "tool_use" && typeof block.name === "string")
    .map((block) => ({
      id: typeof block.id === "string" && block.id ? block.id : `call_${randomUUID().replace(/-/g, "")}`,
      type: "function",
      function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
    }));
  const usage = message.usage || {};
  const outputTokens = Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0;
  const completionMessage = { role: "assistant", content: text || (toolCalls.length ? null : "") };
  const reasoning = content
    .filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking)
    .join("");
  if (reasoning) completionMessage.reasoning_content = reasoning;
  if (toolCalls.length) {
    completionMessage.tool_calls = toolCalls;
    replay?.remember(toolUseIdsOf(content), content);
  }
  return {
    id: chatCompletionId(message.id),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof message.model === "string" && message.model ? message.model : chat.model,
    choices: [{ index: 0, message: completionMessage, finish_reason: chatFinishReason(message.stop_reason, toolCalls.length > 0) }],
    usage: chatUsageFromAnthropic(usage, outputTokens)
  };
}

// Anthropic reports cached tokens outside input_tokens while OpenAI counts them inside
// prompt_tokens, so both counters have to be folded back in for the totals to add up.
function chatUsageFromAnthropic(usage, outputTokens) {
  const cacheRead = Number.isFinite(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0;
  const cacheWrite = Number.isFinite(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : 0;
  const promptTokens = (Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0) + cacheRead + cacheWrite;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: outputTokens,
    total_tokens: promptTokens + outputTokens,
    ...(cacheRead || cacheWrite ? { prompt_tokens_details: { cached_tokens: cacheRead } } : {})
  };
}

function anthropicErrorToOpenAi(payload, status) {
  const message = typeof payload?.error?.message === "string" && payload.error.message
    ? payload.error.message
    : `The upstream Anthropic request failed with HTTP ${status}.`;
  const type = status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" :
    status >= 500 ? "server_error" : "invalid_request_error";
  return { error: { message, type, param: null, code: null } };
}

function chatFinishReason(stopReason, hasToolCalls) {
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "tool_use" || hasToolCalls) return "tool_calls";
  if (stopReason === "refusal") return "content_filter";
  return "stop";
}

function chatCompletionId(value) {
  const suffix = typeof value === "string" && value ? value.replace(/[^A-Za-z0-9_-]/g, "") : randomUUID().replace(/-/g, "");
  return `chatcmpl_${suffix}`;
}

function createAnthropicChatStreamTransform(chat, replay = null) {
  const state = {
    replay,
    toolUseIds: [],
    thinkingBlocks: [],
    thinkingByBlock: new Map(),
    id: `chatcmpl_${randomUUID().replace(/-/g, "")}`,
    model: chat.model,
    created: Math.floor(Date.now() / 1000),
    started: false,
    done: false,
    stopReason: null,
    hasToolCalls: false,
    promptUsage: {},
    outputTokens: 0,
    nextToolIndex: 0,
    toolIndexByBlock: new Map()
  };
  let buffer = "";
  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString("utf8");
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop();
      callback(null, frames.map((frame) => chatChunksForAnthropicFrame(frame, state)).join(""));
    },
    flush(callback) {
      let events = buffer ? chatChunksForAnthropicFrame(buffer, state) : "";
      events += finishChatStream(state);
      callback(null, events);
    }
  });
}

function chatChunksForAnthropicFrame(frame, state) {
  const data = frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return "";
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return "";
  }
  switch (event.type) {
    case "message_start": {
      if (typeof event.message?.id === "string" && event.message.id) state.id = chatCompletionId(event.message.id);
      if (typeof event.message?.model === "string" && event.message.model) state.model = event.message.model;
      if (event.message?.usage && typeof event.message.usage === "object") mergeAnthropicUsage(state, event.message.usage);
      return startChatStream(state);
    }
    case "content_block_start": {
      // The signed thinking of this turn is kept so the next request can replay it; the
      // OpenAI protocols drop the signature, and Anthropic rejects the turn without it.
      if (event.content_block?.type === "thinking") {
        const block = { type: "thinking", thinking: typeof event.content_block.thinking === "string" ? event.content_block.thinking : "", signature: "" };
        state.thinkingBlocks.push(block);
        state.thinkingByBlock.set(event.index, block);
        return startChatStream(state);
      }
      if (event.content_block?.type === "redacted_thinking" && typeof event.content_block.data === "string") {
        state.thinkingBlocks.push({ type: "redacted_thinking", data: event.content_block.data });
        return startChatStream(state);
      }
      if (event.content_block?.type !== "tool_use") return startChatStream(state);
      state.hasToolCalls = true;
      if (typeof event.content_block.id === "string" && event.content_block.id) state.toolUseIds.push(event.content_block.id);
      const index = state.nextToolIndex++;
      state.toolIndexByBlock.set(event.index, index);
      return startChatStream(state) + chatChunk(state, {
        tool_calls: [{ index, id: event.content_block.id, type: "function", function: { name: event.content_block.name, arguments: "" } }]
      });
    }
    case "content_block_delta": {
      if (event.delta?.type === "text_delta" && typeof event.delta.text === "string" && event.delta.text) {
        return startChatStream(state) + chatChunk(state, { content: event.delta.text });
      }
      if (event.delta?.type === "thinking_delta" && typeof event.delta.thinking === "string" && event.delta.thinking) {
        const block = state.thinkingByBlock.get(event.index);
        if (block) block.thinking += event.delta.thinking;
        return startChatStream(state) + chatChunk(state, { reasoning_content: event.delta.thinking });
      }
      if (event.delta?.type === "signature_delta" && typeof event.delta.signature === "string") {
        const block = state.thinkingByBlock.get(event.index);
        if (block) block.signature += event.delta.signature;
        return "";
      }
      if (event.delta?.type === "input_json_delta" && typeof event.delta.partial_json === "string" && event.delta.partial_json) {
        const index = state.toolIndexByBlock.get(event.index);
        if (index === undefined) return "";
        return chatChunk(state, { tool_calls: [{ index, function: { arguments: event.delta.partial_json } }] });
      }
      return "";
    }
    case "message_delta": {
      if (typeof event.delta?.stop_reason === "string") state.stopReason = event.delta.stop_reason;
      if (event.usage && typeof event.usage === "object") mergeAnthropicUsage(state, event.usage);
      return "";
    }
    case "message_stop":
      return finishChatStream(state);
    case "error": {
      state.done = true;
      return `data: ${JSON.stringify(anthropicErrorToOpenAi(event, 502))}\n\ndata: [DONE]\n\n`;
    }
    default:
      return "";
  }
}

// message_start and message_delta both carry cumulative usage, and either one may be
// the only place a counter (especially the cache ones) shows up.
function mergeAnthropicUsage(state, usage) {
  for (const [key, value] of Object.entries(usage)) {
    if (Number.isFinite(value)) state.promptUsage[key] = value;
  }
  if (Number.isFinite(usage.output_tokens)) state.outputTokens = usage.output_tokens;
}

function startChatStream(state) {
  if (state.started) return "";
  state.started = true;
  return chatChunk(state, { role: "assistant", content: "" });
}

function finishChatStream(state) {
  if (state.done) return "";
  state.done = true;
  if (state.hasToolCalls) state.replay?.remember(state.toolUseIds, state.thinkingBlocks);
  const usage = chatUsageFromAnthropic(state.promptUsage, state.outputTokens);
  return startChatStream(state)
    + chatChunk(state, {}, chatFinishReason(state.stopReason, state.hasToolCalls), usage)
    + "data: [DONE]\n\n";
}

function chatChunk(state, delta, finishReason = null, usage = null) {
  const chunk = {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function forwardResponsesResponse(response, upstream, request) {
  if (!upstream.ok || !upstream.body) return forwardResponse(response, upstream);
  return upstream.json()
    .then((body) => sendJson(response, upstream.status, chatCompletionToResponse(body, request)))
    .catch(() => sendError(response, 502, "The upstream chat completion could not be converted to a response."));
}

function chatCompletionToResponse(completion, request) {
  const choice = completion?.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    output.push({
      type: "reasoning",
      id: `rs_${randomUUID().replace(/-/g, "")}`,
      summary: [{ type: "summary_text", text: message.reasoning_content }]
    });
  }
  if (typeof message.content === "string" && message.content) {
    output.push({
      type: "message",
      id: messageId(completion?.id),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: message.content, annotations: [] }]
    });
  }
  for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (toolCall?.function?.name) {
      output.push({
        type: "function_call",
        id: toolCall.id || `fc_${randomUUID().replace(/-/g, "")}`,
        call_id: toolCall.id || `call_${randomUUID().replace(/-/g, "")}`,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments || "{}",
        status: "completed"
      });
    }
  }
  const incomplete = choice.finish_reason === "length";
  const usage = completion?.usage || {};
  return {
    id: responseId(completion?.id),
    object: "response",
    created_at: Number.isFinite(completion?.created) ? completion.created : Math.floor(Date.now() / 1000),
    status: incomplete ? "incomplete" : "completed",
    error: null,
    incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
    instructions: typeof request.instructions === "string" ? request.instructions : null,
    max_output_tokens: Number.isFinite(request.max_output_tokens) ? request.max_output_tokens : null,
    model: completion?.model || request.model,
    output,
    parallel_tool_calls: request.parallel_tool_calls !== false,
    previous_response_id: null,
    reasoning: { effort: typeof request.reasoning?.effort === "string" ? request.reasoning.effort : null, summary: null },
    store: false,
    temperature: Number.isFinite(request.temperature) ? request.temperature : 1,
    text: { format: { type: "text" } },
    tool_choice: request.tool_choice || "auto",
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: Number.isFinite(request.top_p) ? request.top_p : 1,
    usage: responsesUsage(usage)
  };
}

function forwardResponsesStream(response, upstream, request) {
  if (!upstream.ok || !upstream.body) return forwardResponse(response, upstream);
  const state = {
    created: false,
    completed: false,
    createdAt: Math.floor(Date.now() / 1000),
    id: `resp_${randomUUID().replace(/-/g, "")}`,
    messageId: `msg_${randomUUID().replace(/-/g, "")}`,
    model: request.model,
    sequence: 0,
    finishReason: null,
    usage: null,
    nextOutputIndex: 0,
    reasoning: null,
    message: null,
    toolCalls: new Map()
  };
  response.writeHead(upstream.status, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no"
  });
  const source = Readable.fromWeb(upstream.body);
  const transformed = source.pipe(createResponsesStreamTransform(state));
  const abortOnClose = () => {
    if (!response.writableEnded) source.destroy();
  };
  response.once("close", abortOnClose);
  transformed.on("error", () => response.destroy());
  transformed.on("end", () => response.off("close", abortOnClose));
  transformed.pipe(response);
}

function createResponsesStreamTransform(state) {
  let buffer = "";
  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString("utf8");
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop();
      callback(null, frames.map((frame) => responsesEventsForChatFrame(frame, state)).join(""));
    },
    flush(callback) {
      let events = buffer ? responsesEventsForChatFrame(buffer, state) : "";
      events += completeResponsesStream(state);
      callback(null, events);
    }
  });
}

function responsesEventsForChatFrame(frame, state) {
  const data = frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return "";
  if (data === "[DONE]") return completeResponsesStream(state);
  let chunk;
  try {
    chunk = JSON.parse(data);
  } catch {
    return "";
  }
  let events = startResponsesStream(state, chunk.model);
  const choice = chunk.choices?.[0];
  const reasoning = choice?.delta?.reasoning_content;
  if (typeof reasoning === "string" && reasoning) {
    if (!state.reasoning) {
      state.reasoning = { outputIndex: state.nextOutputIndex++, id: `rs_${randomUUID().replace(/-/g, "")}`, text: "" };
      events += responsesSse(state, "response.output_item.added", {
        output_index: state.reasoning.outputIndex,
        item: { type: "reasoning", id: state.reasoning.id, summary: [] }
      });
      events += responsesSse(state, "response.reasoning_summary_part.added", {
        item_id: state.reasoning.id,
        output_index: state.reasoning.outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" }
      });
    }
    state.reasoning.text += reasoning;
    events += responsesSse(state, "response.reasoning_summary_text.delta", {
      item_id: state.reasoning.id,
      output_index: state.reasoning.outputIndex,
      summary_index: 0,
      delta: reasoning
    });
  }
  const text = choice?.delta?.content;
  if (typeof text === "string" && text) {
    if (!state.message) {
      state.message = { outputIndex: state.nextOutputIndex++, text: "" };
      events += responsesSse(state, "response.output_item.added", {
        output_index: state.message.outputIndex,
        item: { type: "message", id: state.messageId, status: "in_progress", role: "assistant", content: [] }
      });
      events += responsesSse(state, "response.content_part.added", {
        item_id: state.messageId,
        output_index: state.message.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      });
    }
    state.message.text += text;
    events += responsesSse(state, "response.output_text.delta", {
      item_id: state.messageId,
      output_index: state.message.outputIndex,
      content_index: 0,
      delta: text
    });
  }
  for (const call of Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : []) {
    events += responsesToolCallEvents(state, call);
  }
  if (chunk.usage && typeof chunk.usage === "object") state.usage = chunk.usage;
  if (choice?.finish_reason) state.finishReason = choice.finish_reason;
  return events;
}

// The first chunk of a chat tool call carries the id and name, later chunks only the
// argument fragments, keyed by the tool call index.
function responsesToolCallEvents(state, call) {
  if (!call || typeof call !== "object") return "";
  const index = Number.isFinite(call.index) ? call.index : 0;
  let item = state.toolCalls.get(index);
  let events = "";
  if (!item) {
    if (typeof call.function?.name !== "string" || !call.function.name) return "";
    item = {
      outputIndex: state.nextOutputIndex++,
      id: `fc_${randomUUID().replace(/-/g, "")}`,
      callId: typeof call.id === "string" && call.id ? call.id : `call_${randomUUID().replace(/-/g, "")}`,
      name: call.function.name,
      arguments: ""
    };
    state.toolCalls.set(index, item);
    events += responsesSse(state, "response.output_item.added", {
      output_index: item.outputIndex,
      item: { type: "function_call", id: item.id, call_id: item.callId, name: item.name, arguments: "", status: "in_progress" }
    });
  }
  const args = call.function?.arguments;
  if (typeof args === "string" && args) {
    item.arguments += args;
    events += responsesSse(state, "response.function_call_arguments.delta", {
      item_id: item.id,
      output_index: item.outputIndex,
      delta: args
    });
  }
  return events;
}

function startResponsesStream(state, model) {
  if (state.created) return "";
  state.created = true;
  if (typeof model === "string" && model) state.model = model;
  return responsesSse(state, "response.created", { response: responseStreamObject(state, "in_progress") });
}

function completeResponsesStream(state, finishReason = state.finishReason || "stop") {
  if (state.completed) return "";
  state.completed = true;
  let events = startResponsesStream(state);
  const output = [];
  for (const { kind, outputIndex, item } of responsesStreamItems(state)) {
    output.push(item);
    if (kind === "reasoning") {
      const summary = { item_id: item.id, output_index: outputIndex, summary_index: 0 };
      events += responsesSse(state, "response.reasoning_summary_text.done", { ...summary, text: state.reasoning.text });
      events += responsesSse(state, "response.reasoning_summary_part.done", { ...summary, part: item.summary[0] });
    } else if (kind === "message") {
      const part = { item_id: item.id, output_index: outputIndex, content_index: 0 };
      events += responsesSse(state, "response.output_text.done", { ...part, text: state.message.text });
      events += responsesSse(state, "response.content_part.done", { ...part, part: item.content[0] });
    } else {
      events += responsesSse(state, "response.function_call_arguments.done", {
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments
      });
    }
    events += responsesSse(state, "response.output_item.done", { output_index: outputIndex, item });
  }
  const incomplete = finishReason === "length";
  events += responsesSse(state, incomplete ? "response.incomplete" : "response.completed", {
    response: { ...responseStreamObject(state, incomplete ? "incomplete" : "completed", output), incomplete_details: incomplete ? { reason: "max_output_tokens" } : null }
  });
  return events;
}

// The finished output items in stream order, each shaped the way the final response
// object and the output_item.done events report them.
function responsesStreamItems(state) {
  const items = [];
  if (state.reasoning) {
    items.push({
      kind: "reasoning",
      outputIndex: state.reasoning.outputIndex,
      item: { type: "reasoning", id: state.reasoning.id, summary: [{ type: "summary_text", text: state.reasoning.text }] }
    });
  }
  if (state.message) {
    items.push({
      kind: "message",
      outputIndex: state.message.outputIndex,
      item: {
        type: "message",
        id: state.messageId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: state.message.text, annotations: [] }]
      }
    });
  }
  for (const tool of state.toolCalls.values()) {
    items.push({
      kind: "function_call",
      outputIndex: tool.outputIndex,
      item: { type: "function_call", id: tool.id, call_id: tool.callId, name: tool.name, arguments: tool.arguments, status: "completed" }
    });
  }
  return items.sort((a, b) => a.outputIndex - b.outputIndex);
}

function responseStreamObject(state, status, output = []) {
  return {
    id: state.id,
    object: "response",
    created_at: state.createdAt,
    status,
    model: state.model,
    output,
    error: null,
    incomplete_details: null,
    ...(state.usage ? { usage: responsesUsage(state.usage) } : {})
  };
}

// Codex reads its token counters off the response object, so the chat completion's
// usage is carried across instead of being dropped in translation.
function responsesUsage(usage) {
  const input = Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : 0;
  const output = Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number.isFinite(usage?.total_tokens) ? usage.total_tokens : input + output,
    ...(Number.isFinite(cached) ? { input_tokens_details: { cached_tokens: cached } } : {})
  };
}

function responsesSse(state, type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: state.sequence++, ...data })}\n\n`;
}

function responseId(value) {
  const suffix = typeof value === "string" && value ? value.replace(/[^A-Za-z0-9_-]/g, "") : randomUUID().replace(/-/g, "");
  return `resp_${suffix}`;
}

function messageId(value) {
  const suffix = typeof value === "string" && value ? value.replace(/[^A-Za-z0-9_-]/g, "") : randomUUID().replace(/-/g, "");
  return `msg_${suffix}`;
}

function firstByteTimeout(config) {
  return config.firstByteTimeoutMs || config.timeoutMs;
}

function modelListTimeout(config) {
  return config.modelListTimeoutMs || Math.min(firstByteTimeout(config), 10_000);
}

export function relayHeaders(incoming, token) {
  const headers = {
    Accept: incoming.accept || "application/json",
    "Content-Type": incoming["content-type"] || "application/json",
    "x-mirasim-client": "0.0.239",
    "x-mirasim-call": randomUUID()
  };
  if (incoming["anthropic-beta"]) headers["anthropic-beta"] = incoming["anthropic-beta"];
  if (incoming["anthropic-version"]) headers["anthropic-version"] = incoming["anthropic-version"];
  // This token comes from the official Mirasim login profile, never from caller input.
  headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function relayRequestHeaders(relaySessions, profile, options) {
  if (relaySessions) return relaySessions.headersFor(profile, options);
  return relayHeaders({
    accept: options.accept,
    "content-type": options.contentType
  }, profile.token);
}

function serveStatic(response, asset) {
  try {
    const body = readFileSync(resolve(publicDir, asset.file));
    response.writeHead(200, {
      "Content-Type": asset.type,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(body);
  } catch {
    sendError(response, 500, "Dashboard assets are missing.");
  }
}

function requiresWebAuth(pathname) {
  return pathname === "/" || pathname === "/assets/dashboard.js" ||
    (pathname.startsWith("/api/") && pathname !== "/api/auth/login" && pathname !== "/api/auth/logout");
}

function redirectToLogin(response) {
  response.writeHead(302, { Location: "/login", "Cache-Control": "no-store" });
  response.end();
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const body = await readBody(request);
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed;
  } catch {
    const error = new Error("Request body must be a JSON object.");
    error.statusCode = 400;
    throw error;
  }
}

function forwardResponse(response, upstream) {
  for (const [name, value] of upstream.headers.entries()) {
    if (RESPONSE_HEADERS.has(name.toLowerCase())) response.setHeader(name, value);
  }
  response.statusCode = upstream.status;
  if (!upstream.body) return response.end();
  const body = Readable.fromWeb(upstream.body);
  const abortOnClose = () => {
    if (!response.writableEnded) body.destroy();
  };
  response.once("close", abortOnClose);
  body.on("error", () => response.destroy());
  body.on("end", () => response.off("close", abortOnClose));
  body.pipe(response);
}

function retryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryAfterMs(value) {
  if (typeof value !== "string" || !value.trim()) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

function sendError(response, statusCode, message) {
  const type = statusCode === 401 ? "authentication_error" : statusCode >= 500 ? "server_error" : "invalid_request_error";
  sendJson(response, statusCode, { error: { message, type } });
}

function protocolForPath(value) {
  const pathname = typeof value === "string" ? value.split("?", 1)[0] : "";
  return pathname === "/v1/messages" ? "anthropic" : "openai";
}

function protocolForRequest(request, value) {
  if (protocolForPath(value) === "anthropic") return "anthropic";
  const pathname = typeof value === "string" ? value.split("?", 1)[0] : "";
  return pathname === "/v1/models" && (hasHeader(request.headers["x-api-key"]) || hasHeader(request.headers["anthropic-version"]))
    ? "anthropic"
    : "openai";
}

function clientApiKey(request, protocol) {
  if (protocol === "anthropic") {
    const value = request.headers["x-api-key"];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return bearerToken(request.headers.authorization);
}

function sendProtocolError(response, protocol, statusCode, message) {
  if (protocol === "anthropic") return sendAnthropicError(response, statusCode, message);
  if (statusCode === 401) return sendOpenAiAuthError(response);
  return sendError(response, statusCode, message);
}

function sendAnthropicError(response, statusCode, message) {
  const type = statusCode === 401 ? "authentication_error" : statusCode === 404 ? "not_found_error" :
    statusCode === 429 ? "rate_limit_error" : statusCode >= 500 ? "api_error" : "invalid_request_error";
  sendJson(response, statusCode, { type: "error", error: { type, message } });
}

function bearerToken(value) {
  const match = /^Bearer\s+(.+)$/i.exec(value || "");
  return match?.[1]?.trim() || null;
}

function hasHeader(value) {
  return typeof value === "string" && value.trim() !== "";
}

function sendOpenAiAuthError(response) {
  sendJson(response, 401, {
    error: {
      message: "Missing or invalid API key.",
      type: "authentication_error",
      param: null,
      code: "invalid_api_key"
    }
  }, { "WWW-Authenticate": "Bearer" });
}
