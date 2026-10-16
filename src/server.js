import { createHash, randomUUID } from "node:crypto";
import { adaptResponsesNamespaces } from "./responses-namespaces.js";
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
import { MirasimRelaySessions, MirasimRelaySessionError, mirasimClientUserAgent, relayNeedsClientIdentity } from "./relay-device.js";
import { MIRASIM_CLIENT_VERSION } from "./mirasim-release.js";
import { RELAY_AGENT_MODELS, relayAgentFor, relayAgentForPath, relayModelFor, relayWireFor } from "./relay-agents.js";
import { RelayRequestLog } from "./request-log.js";
import { ThinkingReplayStore, isReplayableThinking, toolUseIdsOf } from "./thinking-replay.js";
import { ensureChatCompletionStream, normalizeChatUpstream, readChatCompletion } from "./chat-completion.js";
import { readAnthropicCompletion } from "./anthropic-completion.js";
import { createProgressSignal, primeChatCompletionStream } from "./chat-stream.js";
import { chatToResponsesRequest, normalizeResponsesContentType, normalizeResponsesStream, primeResponsesStream, responseEvents, responsesUpstreamAsChat } from "./responses-bridge.js";
import { validateAnthropicRequest, validateChatRequest, validateResponsesRequest } from "./protocol-validation.js";
import { MAX_RESPONSE_BYTES, MAX_SSE_FRAME_BYTES, ResponseState } from "./response-state.js";
import { ResponsesHistoryStore } from "./responses-history.js";
import { endMessageStream, frameHasThinkingEstimate, guardUpstreamResponse, pipeWithCancellation, sseHeartbeat } from "./stream-lifecycle.js";
import { ThinkTagFilter, splitThinkTags } from "./think-tags.js";
import { normalizeClaudeSystem, CLAUDE_AGENT_IDENTITY } from "./claude-system.js";
import { localCodexTitleCompletion } from "./codex-title.js";
import { isImageModel, imageConversationRequest, forwardImageConversation, hasImageTool, imageStreamLimits, IMAGE_RESPONSE_BYTES, IMAGE_FRAME_BYTES } from "./image-protocol.js";
import { prepareSearchRequest, applySearchTools } from "./search-protocol.js";
import { prepareImageTools, applyImageTools, multipartImageEdit, imagesToResponses } from "./image-requests.js";
import { responsesAsImageStream } from "./image-stream.js";
import { isPermanentRequestError, relayErrorDetails, relayStreamError } from "./relay-errors.js";
import { holdStreamOpen } from "./queue-keepalive.js";
import { isPlatformQueueRefusal, platformQueueRetryMs, waitForPlatformQueue } from "./relay-queue.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LOGGED_RESPONSES = new WeakSet();
// The heartbeat a streaming relay answer is kept alive with on its way to the caller, keyed by
// the caller's response. Only relay answers are registered; local and error replies are not.
const STREAM_HEARTBEATS = new WeakMap();
// Claude-specific normalization applies only to claude-* models. Other relay agents can use
// the same Anthropic Messages wire contract without accepting a Claude identity or thinking
// controls (for example, Mirasim's ZCode/GLM route).
const ANTHROPIC_ONLY_MODEL = /^claude/i;
const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;
const RELAY_ACCEPTED_TEMPERATURE = 1;
const RELAY_ACCEPTED_TOP_P = 0.99;
// A translated OpenAI or Responses request carries no Anthropic protocol headers of its own,
// so the cache_control blocks this gateway writes reach the relay on a request the official
// client would never send. Default to what that client sends; a caller's own values still win.
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_BETA = "prompt-caching-2024-07-31";
const THINKING_MODEL_SUFFIX = /[-:](?:thinking|think)$/i;
// OpenAI reasoning_effort levels mapped to Anthropic thinking budgets (tokens).
const REASONING_BUDGET_TOKENS = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 32768 };
// An adaptive model is not steered by a token budget but by a named rung, which travels outside
// `thinking` in `output_config`. Measured on the relay with one prompt at each rung, the rungs
// are real and ordered: low 198, medium 221, high 256, xhigh 329, max 747 output tokens. A name
// outside this set is refused with 400, so `minimal` is folded into `low` the way the official
// client folds it, and anything unknown is dropped rather than sent.
const REASONING_RUNGS = ["low", "medium", "high", "xhigh", "max"];
// Adaptive thinking returns no thinking block at all unless a display is asked for — the answer
// is a plain 200 and the reasoning simply is not there. `raw` is refused; `summarized` is what
// the official client sends and the only value that works.
const THINKING_DISPLAY = "summarized";
// Anthropic requires max_tokens to exceed the thinking budget; keep this much room for the reply.
const THINKING_ANSWER_HEADROOM_TOKENS = 1024;
// The relay only serves Anthropic Messages traffic that identifies itself as an official
// Anthropic agent client, so requests from every other caller need the agent identity as
// their first system block. Claude Code already sends its own accepted identity.
const RELAY_AGENT_IDENTITY = CLAUDE_AGENT_IDENTITY;
const ACCEPTED_AGENT_IDENTITIES = [RELAY_AGENT_IDENTITY, "You are Claude Code, Anthropic's official CLI for Claude."];
const RESPONSE_HEADERS = new Set(["content-type", "cache-control", "retry-after", "x-should-retry", "x-request-id", "openai-processing-ms"]);
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
  // The stored choice wins over the configured default: the console is where an operator changes
  // it, and a restart must not quietly put the pool back on whatever the environment says.
  const pool = new MirasimProfilePool(config.homes, {
    cooldownMs: config.cooldownMs,
    mode: database.getRotationMode() || config.rotationMode
  });
  for (const home of database.disabledHomes()) pool.disable(home);
  for (const { home, priority } of database.homePriorities()) pool.setPriority(home, priority);
  const usage = new RelayUsageLedger(database);
  const sessions = new MirasimSessionRefresher(config, { fetchImpl });
  const relaySessions = new MirasimRelaySessions(config, { fetchImpl });
  const modelHealth = new MirasimModelHealth(config, pool, { fetchImpl, sessionRefresher: sessions, relaySessions, database });
  const dashboard = new MirasimDashboard(config, pool, usage, { fetchImpl, database, sessionRefresher: sessions, relaySessions });
  const webAuth = new WebAuth(config.webAuth, { database });
  const apiKeys = new OpenAIKeyStore(database, { secret: config.webAuth.password });
  const requestLog = new RelayRequestLog();
  const affinity = new ConversationAffinity();
  const thinkingReplay = new ThinkingReplayStore();
  const responsesHistory = new ResponsesHistoryStore();
  const server = createServer(async (request, response) => {
    response.setHeader("x-mirasim-request-id", randomUUID());
    try {
      await handleRequest(request, response, config, pool, usage, dashboard, sessions, relaySessions, modelHealth, webAuth, apiKeys, fetchImpl, requestLog, affinity, thinkingReplay, responsesHistory);
    } catch (error) {
      logger.error?.("mirasim relay proxy failed", error);
      if (!response.headersSent) sendProtocolError(response, protocolForRequest(request, request.url), error.statusCode || 502, error.message || "The relay request failed.");
      else response.destroy(error);
    }
  });
  server.startModelHealth = () => modelHealth.start();
  server.on("listening", () => sessions.start());
  server.on("close", () => sessions.stop());
  server.on("close", () => modelHealth.stop());
  return server;
}

async function handleRequest(request, response, config, pool, usage, dashboard, sessions, relaySessions, modelHealth, webAuth, apiKeys, fetchImpl, requestLog, affinity = null, thinkingReplay = null, responsesHistory = null) {
  const passthrough = config.reasoningMode !== "managed";
  const thinking = { defaultEffort: config.defaultReasoningEffort, replay: thinkingReplay, passthrough };
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
  if (requiresWebAuth(url.pathname) && !webAuth.isAuthenticated(request, response)) {
    if (url.pathname.startsWith("/api/")) return sendJson(response, 401, { error: { message: "请先登录 Web 控制台。", type: "authentication_error", param: null, code: "web_session_required" } });
    return redirectToLogin(response);
  }
  if (request.method === "GET" && STATIC_FILES.has(url.pathname)) {
    return serveStatic(response, STATIC_FILES.get(url.pathname));
  }
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    return sendJson(response, 200, await dashboard.snapshot());
  }
  if (request.method === "GET" && url.pathname === "/api/rotation-mode") {
    return sendJson(response, 200, dashboard.rotationMode());
  }
  if (request.method === "PUT" && url.pathname === "/api/rotation-mode") {
    const body = await readJson(request);
    return sendJson(response, 200, dashboard.setRotationMode(body?.mode));
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
    return sendError(response, 410, "旧版邀请码生成已停用，请使用新版邀请链接。");
  }
  if (request.method === "GET" && url.pathname === "/api/campaign-link") {
    return sendJson(response, 200, { campaign: await dashboard.campaignLink(url.searchParams.get("account")) });
  }
  if (request.method === "GET" && url.pathname === "/api/reset-cards") {
    return sendJson(response, 200, { cards: await dashboard.resetCards(url.searchParams.get("account")) });
  }
  if (request.method === "POST" && url.pathname === "/api/reset-cards/redeem") {
    const body = await readJson(request);
    return sendJson(response, 200, await dashboard.redeemResetCard(body.account, body.cardId, body.selectionId ?? null));
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
  if (request.method === "POST" && url.pathname === "/api/accounts/bulk") {
    const body = await readJson(request);
    return sendJson(response, 200, dashboard.bulkAccounts(body?.action, body?.accounts));
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
  const accountStatusCheck = /^\/api\/accounts\/([^/]+)\/status-check$/.exec(url.pathname);
  if (request.method === "POST" && accountStatusCheck) {
    return sendError(response, 410, "Haiku 账号状态检测已移除，不会发送模型请求或消耗额度。");
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/accounts/")) {
    const key = decodeURIComponent(url.pathname.slice("/api/accounts/".length));
    await dashboard.deleteAccount(key);
    return sendJson(response, 200, { deleted: true });
  }
  if (request.method === "POST" && url.pathname === "/api/accounts/recover") {
    return sendJson(response, 200, dashboard.recoverAllAccounts());
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
    await sessions.refreshUntilReady(config.homes, () => pool.hasCandidate());
    return sendJson(response, 200, { status: "ok", profiles: pool.status() });
  }
  const protocol = protocolForRequest(request, url.pathname);
  let clientBody = null;
  let principal = null;
  if (request.method === "POST" && ["/v1/messages", "/v1/chat/completions", "/v1/responses", "/backend-api/codex/responses"].includes(url.pathname)) {
    const startedAt = requestLog.now();
    response.once("finish", () => {
      if (response.statusCode < 400 || LOGGED_RESPONSES.has(response)) return;
      const entry = requestLog.open(url.pathname, clientBody, null, { upstreamPath: null, requestId: response.getHeader("x-mirasim-request-id"), apiKey: principal });
      entry.startedAt = startedAt;
      entry.at = new Date(startedAt).toISOString();
      entry.stage = "failed";
      requestLog.fail(entry, response.statusCode);
    });
  }
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/backend-api/codex/")) {
    principal = apiKeys.authenticate(clientApiKey(request, protocol));
    if (!principal) return sendProtocolError(response, protocol, 401, "Missing or invalid API key.");
    REQUEST_API_KEYS.set(request, principal);
  }
  if (request.method === "GET" && url.pathname === "/v1/models") {
    const models = await modelList(config, pool, fetchImpl, sessions, relaySessions);
    return sendJson(response, 200, protocol === "anthropic" ? anthropicModelList(models) : models);
  }
  const compactPath = url.pathname.replace(/^\/backend-api\/codex\//, "/v1/");
  if (request.method === "POST" && compactPath === "/v1/alpha/search") {
    const body = await readBody(request, config.maxRequestBytes ?? 16 * 1024 * 1024);
    if (!parseJsonObject(body)) return sendError(response, 400, "Search requires a JSON object.");
    return relayRequest(request, response, config, pool, usage, fetchImpl, new URL(compactPath + url.search, url), body, "openai", forwardResponse, sessions, relaySessions, requestLog);
  }
  if (request.method === "POST" && compactPath === "/v1/responses/compact") {
    return sendError(response, 410, "Standalone remote compaction has been disabled. No upstream request or compatibility fallback is performed.");
  }
  const imagePath = url.pathname.replace(/^\/backend-api\/codex\/images\//, "/v1/images/");
  if (request.method === "POST" && ["/v1/images/generations", "/v1/images/edits"].includes(imagePath)) {
    let body = await readBody(request, config.maxRequestBytes ?? 16 * 1024 * 1024);
    const originalBody = body;
    const contentType = request.headers["content-type"] || "application/json";
    if (contentType.toLowerCase().includes("application/json")) {
      if (!parseJsonObject(body)) return sendError(response, 400, "Expected a JSON object.");
    } else if (imagePath !== "/v1/images/edits" || !/^multipart\/form-data\s*;.*\bboundary=/i.test(contentType)) {
      return sendError(response, 415, "Image requests require JSON, or multipart/form-data for edits.");
    }
    try {
      if (/^multipart\/form-data/i.test(contentType)) {
        body = Buffer.from(JSON.stringify(await multipartImageEdit(body, contentType)));
        if (body.length > (config.maxRequestBytes ?? 16 * 1024 * 1024)) return sendError(response, 413, "Converted image request exceeds the request size limit.");
        request.headers["content-type"] = "application/json";
      }
      const imageRequest = parseJsonObject(body);
      if (imageRequest?.stream !== undefined && typeof imageRequest.stream !== "boolean") return sendError(response, 400, "stream must be a boolean.");
      if (imageRequest?.stream === true && relayWireFor(imageRequest.model) === "responses" && !isImageModel(imageRequest.model)) {
        const action = imagePath.endsWith("/edits") ? "edit" : "generate";
        const converted = imagesToResponses(imageRequest, action);
        return relayRequest(request, response, config, pool, usage, fetchImpl, new URL("/v1/responses", url), Buffer.from(JSON.stringify(converted)), "openai", (downstream, upstream) => forwardResponse(downstream, responsesAsImageStream(upstream, action)), sessions, relaySessions, requestLog, { path: url.pathname, body: originalBody });
      }
    } catch (error) { return sendError(response, error.statusCode || 400, error.message); }
    const target = new URL(imagePath + url.search, config.relayUrl);
    return relayRequest(request, response, config, pool, usage, fetchImpl, target, body, "openai", forwardResponse, sessions, relaySessions, requestLog);
  }
  if (request.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/backend-api/codex/responses")) {
    const body = await readBody(request, config.maxRequestBytes ?? 16 * 1024 * 1024);
    clientBody = body;
    // The relay serves GPT models on /v1/responses — /v1/chat/completions answers 404 naming that
    // endpoint, and /backend-api/codex/responses, which this took before, is gone. A Responses
    // request is already in that endpoint's wire format, so it is forwarded rather than
    // translated: that keeps prompt_cache_key and the Codex identity intact, which is what the
    // upstream prompt cache keys on. Only the fields the relay refuses are settled first.
    let codex = parseJsonObject(body);
    const search = prepareSearchRequest(codex, "responses");
    if (search.error) return sendError(response, 400, search.error);
    codex = search.request;
    if (isImageModel(codex?.model)) return relayImageConversation(request, response, codex, "responses", body, url, config, pool, usage, fetchImpl, sessions, relaySessions, requestLog);
    const nativeHistory = relayWireFor(codex?.model) === "responses";
    const nativeModel = relayModelFor(codex?.model) || codex?.model;
    const previousResponseId = codex?.previous_response_id ?? null;
    let nativeRelaySessionId = null;
    // Validate the new turn first; only this authenticated native route can consume a reference.
    const validationInput = nativeHistory ? { ...codex, previous_response_id: null } : codex;
    const validationError = validateResponsesRequest(validationInput, { bridge: !nativeHistory && (anthropicRelayModel(codex?.model) || relayWireFor(codex?.model) === "chat-completions") });
    if (validationError) return sendError(response, 400, validationError);
    if (nativeHistory) {
      if (codex.store !== undefined && typeof codex.store !== "boolean") return sendError(response, 400, "store: expected a boolean.");
      if (codex.include !== undefined && (!Array.isArray(codex.include) || codex.include.some((item) => typeof item !== "string"))) return sendError(response, 400, "include: expected an array of strings.");
      if (!search.tools.length && config.localCodexTitles !== false && await sendLocalCodexTitle(response, codex, url.pathname)) return;
      nativeRelaySessionId = responsesHistory.sessionFor((principal.scopeId || principal.id), nativeModel, previousResponseId);
      try { codex = responsesHistory.expand((principal.scopeId || principal.id), relayModelFor(codex.model) || codex.model, codex); }
      catch (error) { return sendJson(response, error.statusCode || 400, { error: { type: "invalid_request_error", message: error.message, code: error.code, param: error.param } }); }
      const expandedError = validateResponsesRequest(codex);
      if (expandedError) return sendError(response, 400, expandedError);
      const promptCacheKey = codex.prompt_cache_key || responsesHistory.promptCacheKeyFor((principal.scopeId || principal.id), nativeModel, previousResponseId)
        || gptPromptCacheKey((principal.scopeId || principal.id), nativeModel, codex);
      if (promptCacheKey) codex.prompt_cache_key = promptCacheKey;
      nativeRelaySessionId ||= gptPromptCacheSessionId((principal.scopeId || principal.id), nativeModel, codex.prompt_cache_key) || randomUUID();
    }
    // Except when the model's upstream does not serve Responses at all. DeepSeek and Kimi are
    // served on chat completions alone, so a Responses request under their agent is refused
    // with a bare 400 however well-formed it is — Codex speaks nothing else, so the request is
    // translated instead of being sent where it cannot be answered.
    if (codex && relayWireFor(codex.model) === "chat-completions") {
      const translated = responseToChatRequest(body);
      if (!translated.ok) return sendError(response, 400, translated.message);
      return relayRequest(
        request,
        response,
        config,
        pool,
        usage,
        fetchImpl,
        new URL("/v1/chat/completions", url),
        Buffer.from(JSON.stringify(chatUpstreamRequest(translated.chat, passthrough))),
        "openai",
        (downstream, upstream) => translated.stream
          ? forwardResponsesStream(downstream, upstream, translated.request)
          : forwardResponsesResponse(downstream, upstream, translated.request),
        sessions,
        relaySessions,
        requestLog,
        { path: url.pathname, body },
        affinity
      );
    }
    if (codex && !anthropicRelayModel(codex.model)) {
      const historyInput = nativeHistory ? structuredClone(codex.input) : null;
      const shouldStore = nativeHistory && codex.store !== false;
      const finalize = nativeHistory ? (envelope, terminalType) => {
        const stored = terminalType === "response.completed" && !response.destroyed && shouldStore && responsesHistory.remember((principal.scopeId || principal.id), relayModelFor(codex.model) || codex.model, historyInput, envelope, { sessionId: nativeRelaySessionId, promptCacheKey: codex.prompt_cache_key });
        return { ...envelope, store: Boolean(stored), previous_response_id: previousResponseId };
      } : (envelope) => envelope;
      if (shouldStore) codex.include = [...new Set([...(codex.include || []), "reasoning.encrypted_content"])];
      let adapted;
      try { adapted = adaptResponsesNamespaces(codex); }
      catch (error) { return sendError(response, 400, error.message); }
      const clientWantsStream = prepareCodexBody(adapted.request, config.defaultReasoningEffort, config.minReasoningEffort, passthrough);
      return relayRequest(
        request,
        response,
        config,
        pool,
        usage,
        fetchImpl,
        new URL("/v1/responses", url),
        Buffer.from(JSON.stringify(adapted.request)),
        "openai",
        // The relay refuses a non-streaming Responses request, so the stream is always asked for
        // and a caller that wanted one object gets the stream folded back into one.
        clientWantsStream ? (downstream, upstream) => forwardResponse(downstream, normalizeResponsesStream(upstream, { ...adapted, finalize, ...imageStreamLimits(codex) })) : (downstream, upstream) => forwardCodexResponse(downstream, upstream, (envelope, terminalType) => finalize(adapted.restoreResponse(envelope), terminalType), imageStreamLimits(codex)),
        sessions,
        relaySessions,
        requestLog,
        { path: url.pathname, body, affinityBody: nativeHistory ? codex : undefined },
        affinity,
        nativeRelaySessionId
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
    const body = await readBody(request, config.maxRequestBytes ?? 16 * 1024 * 1024);
    clientBody = body;
    const search = prepareSearchRequest(parseJsonObject(body), "chat");
    if (search.error) return sendError(response, 400, search.error);
    let imageTools;
    try { imageTools = prepareImageTools(search.request, "chat"); }
    catch (error) { return sendError(response, error.statusCode || 400, error.message); }
    const chat = imageTools.request;
    if (isImageModel(chat?.model)) return relayImageConversation(request, response, chat, "chat", body, url, config, pool, usage, fetchImpl, sessions, relaySessions, requestLog);
    const validationError = validateChatRequest(chat, { bridge: anthropicRelayModel(chat?.model) || relayWireFor(chat?.model) === "responses" });
    if (validationError) return sendError(response, 400, validationError);
    if (!imageTools.tools.length && !search.tools.length && config.localCodexTitles !== false && await sendLocalCodexTitle(response, chat, url.pathname)) return;
    if (chat && relayWireFor(chat.model) === "responses") {
      const translated = chatToResponsesRequest(chat);
      if (!translated.ok) return sendError(response, 400, translated.message);
      applySearchTools(translated.request, search);
      applyImageTools(translated.request, imageTools);
      const imageLimits = imageStreamLimits(translated.request);
      const promptCacheKey = gptPromptCacheKey((principal.scopeId || principal.id), relayModelFor(chat.model) || chat.model, chat);
      if (promptCacheKey) translated.request.prompt_cache_key = promptCacheKey;
      prepareCodexBody(translated.request, config.defaultReasoningEffort, config.minReasoningEffort, passthrough);
      const relaySessionId = gptPromptCacheSessionId((principal.scopeId || principal.id), relayModelFor(translated.request.model) || translated.request.model, translated.request.prompt_cache_key);
      return relayRequest(request, response, config, pool, usage, fetchImpl,
        new URL("/v1/responses", url), Buffer.from(JSON.stringify(translated.request)), "openai",
        (downstream, upstream) => forwardChatResponse(downstream, responsesUpstreamAsChat(upstream, chat.model, imageLimits), chat.stream === true, imageLimits),
        sessions, relaySessions, requestLog, { path: url.pathname, body }, affinity, relaySessionId,
        (upstream) => responsesUpstreamAsChat(upstream, chat.model, imageLimits));
    }
    if (chat && anthropicRelayModel(chat.model)) {
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
        async (downstream, upstream) => forwardChatResponse(downstream, await anthropicUpstreamAsChat(upstream, chat, thinkingReplay), chat?.stream === true),
        sessions,
        relaySessions,
        requestLog,
        { path: url.pathname, body },
        affinity,
        null,
        (upstream) => anthropicUpstreamAsChat(upstream, chat, thinkingReplay)
      );
    }
    return relayRequest(request, response, config, pool, usage, fetchImpl, url, body, "openai", (downstream, upstream) => forwardChatResponse(downstream, upstream, chat?.stream === true), sessions, relaySessions, requestLog, null, affinity, null, (upstream) => upstream);
  }
  if (request.method === "POST" && url.pathname === "/v1/messages") {
    const body = await readBody(request, config.maxRequestBytes ?? 16 * 1024 * 1024);
    clientBody = body;
    const search = prepareSearchRequest(parseJsonObject(body), "anthropic");
    if (search.error) return sendAnthropicError(response, 400, search.error);
    let imageTools;
    try { imageTools = prepareImageTools(search.request, "anthropic"); }
    catch (error) { return sendAnthropicError(response, error.statusCode || 400, error.message); }
    const message = imageTools.request;
    if (isImageModel(message?.model)) return relayImageConversation(request, response, message, "anthropic", body, url, config, pool, usage, fetchImpl, sessions, relaySessions, requestLog);
    const validationError = validateAnthropicRequest(message, { bridge: ["responses", "chat-completions"].includes(relayWireFor(message?.model)) });
    if (validationError) return sendAnthropicError(response, 400, validationError);
    if (!imageTools.tools.length && !search.tools.length && config.localCodexTitles !== false && await sendLocalCodexTitle(response, message, url.pathname)) return;
    if (message && relayWireFor(message.model) === "responses") {
      const chat = anthropicToChatRequest(message);
      if (!chat.ok) return sendAnthropicError(response, 400, chat.message);
      const translated = chatToResponsesRequest(chat.request);
      if (!translated.ok) return sendAnthropicError(response, 400, translated.message);
      applySearchTools(translated.request, search);
      applyImageTools(translated.request, imageTools);
      const imageLimits = imageStreamLimits(translated.request);
      const model = relayModelFor(translated.request.model) || translated.request.model;
      const promptCacheKey = gptPromptCacheKey((principal.scopeId || principal.id), model, message);
      if (promptCacheKey) translated.request.prompt_cache_key = promptCacheKey;
      prepareCodexBody(translated.request, config.defaultReasoningEffort, config.minReasoningEffort, passthrough);
      const relaySessionId = gptPromptCacheSessionId((principal.scopeId || principal.id), model, promptCacheKey);
      return relayRequest(request, response, config, pool, usage, fetchImpl,
        new URL("/v1/responses", url), Buffer.from(JSON.stringify(translated.request)), "anthropic",
        async (downstream, upstream) => forwardResponse(downstream, await chatUpstreamAsAnthropic(responsesUpstreamAsChat(upstream, message.model, { commentaryAsReasoning: true, ...imageLimits }), message.model, message.stream === true, imageLimits)),
        sessions, relaySessions, requestLog, { path: url.pathname, body, affinityBody: promptCacheKey ? { ...message, prompt_cache_key: promptCacheKey } : message }, affinity, relaySessionId);
    }
    // The other half of the same problem: Claude Code speaks Anthropic Messages and nothing
    // else, and the relay does not serve DeepSeek or Kimi on that endpoint. Forwarding the
    // request as it arrived is the 400 the operator sees, so it is bridged to the endpoint
    // their agent is actually served on and the answer is translated back.
    if (message && relayWireFor(message.model) === "chat-completions") {
      const chat = anthropicToChatRequest(message, passthrough);
      if (!chat.ok) return sendAnthropicError(response, 400, chat.message);
      // The client's own model id, not the one that went upstream: an alias is this gateway's
      // business, and a client that asked for `kimi-code/k3` should not be told it got
      // something else back.
      const requested = typeof message.model === "string" ? message.model.trim() : chat.request.model;
      return relayRequest(
        request,
        response,
        config,
        pool,
        usage,
        fetchImpl,
        new URL("/v1/chat/completions", url),
        Buffer.from(JSON.stringify(chat.request)),
        "anthropic",
        async (downstream, upstream) => forwardResponse(downstream, await chatUpstreamAsAnthropic(upstream, requested, message.stream === true)),
        sessions,
        relaySessions,
        requestLog,
        { path: url.pathname, body },
        affinity
      );
    }
    return relayRequest(request, response, config, pool, usage, fetchImpl, url, body, "anthropic",
      async (downstream, upstream) => {
        if (message.stream === true || !upstream.ok || !upstream.headers.get("content-type")?.includes("text/event-stream")) return forwardResponse(downstream, upstream);
        try {
          return sendJson(downstream, upstream.status, await readAnthropicCompletion(upstream));
        } catch (error) {
          return sendAnthropicError(downstream, 502, error.message);
        }
      }, sessions, relaySessions, requestLog, null, affinity);
  }
  // Every proxied path answers above, including the ones that only forward: which endpoint a
  // request goes to upstream now depends on its model, so no route can be left to a shared
  // pass-through that cannot see one.
  return sendProtocolError(response, protocol, 404, "Use /, /api/dashboard, /healthz, /v1/models, /v1/chat/completions, /v1/responses, /v1/alpha/search, /v1/images/generations, /v1/images/edits, /backend-api/codex/responses, or /v1/messages.");
}

async function relayImageConversation(request, response, value, protocol, body, url, config, pool, usage, fetchImpl, sessions, relaySessions, requestLog) {
  let converted;
  try { converted = imageConversationRequest(value, protocol); }
  catch (error) { return sendProtocolError(response, protocol === "anthropic" ? "anthropic" : "openai", error.statusCode || 400, error.message); }
  return relayRequest(request, response, config, pool, usage, fetchImpl, new URL(converted.path, url), Buffer.from(JSON.stringify(converted.body)), protocol === "anthropic" ? "anthropic" : "openai",
    async (downstream, upstream) => {
      try { await forwardImageConversation(downstream, upstream, value, protocol); }
      catch (error) {
        if (downstream.headersSent) downstream.destroy(error);
        else sendProtocolError(downstream, protocol === "anthropic" ? "anthropic" : "openai", 502, error.message || "Invalid image relay response.");
      }
    }, sessions, relaySessions, requestLog, { path: url.pathname, body });
}

async function relayRequest(request, response, config, pool, usage, fetchImpl, url, body, protocol = "openai", responseHandler = forwardResponse, sessions = null, relaySessions = null, requestLog = null, clientRequest = null, affinity = null, requestedRelaySessionId = null, chatAdapter = null) {
  const clientPath = new URL(request.url || "/", "http://gateway.local").pathname;
  protocol = protocolForRequest(request, clientPath);
  // Captured before the body is prepared: on the Anthropic path there is no separate client
  // request to fall back on, so reading it afterwards would report this gateway's own rewrite
  // back to the operator as the caller's request.
  const clientBody = clientRequest?.body || body;
  const validateChatStream = chatAdapter && parseJsonObject(clientBody)?.stream === true;
  const validateResponsesStream = url.pathname === "/v1/responses";
  const gateAnthropicStream = !validateChatStream && url.pathname === "/v1/messages";
  const prepared = prepareRelayBody(body, url, config.defaultReasoningEffort, config.minReasoningEffort, relaySessions?.enabled === true, config.reasoningMode !== "managed", protocol === "openai");
  body = prepared.body;
  // The console reports the request the client sent, not the shape this gateway translated it
  // into — and alongside it the thinking level this gateway settled on, which only the body
  // going upstream carries.
  const logEntry = requestLog?.open(clientPath, clientBody, body, {
    upstreamPath: url.pathname, requestId: response.getHeader("x-mirasim-request-id"), apiKey: REQUEST_API_KEYS.get(request)
  });
  if (logEntry) {
    LOGGED_RESPONSES.add(response);
    response.once("finish", () => {
      logEntry.status = logEntry.streamError && response.statusCode < 400 ? 502 : response.statusCode;
      if (logEntry.pending) requestLog.fail(logEntry, response.statusCode);
    });
    response.once("close", () => {
      if (logEntry.pending) requestLog.fail(logEntry, response.writableEnded ? response.statusCode : 499);
    });
  }
  const relayBody = parseJsonObject(body);
  const affinityKeys = affinity ? affinityKeysFor(clientRequest?.affinityBody || parseJsonObject(clientBody), REQUEST_API_KEYS.get(request)?.id) : [];
  // The relay tells its upstreams apart by the agent header alone, so the model decides which
  // upstream this is for — read from the body actually being sent, which for a translated
  // request is the one carrying the upstream's own model id. Decided once: every attempt of the
  // failover loop is the same request going to the same upstream.
  const relayAgent = url.pathname.startsWith("/v1/images/") || url.pathname === "/v1/alpha/search" ? "codex" : relayAgentFor(relayBody?.model) || relayAgentForPath(url.pathname);
  // A pool profile is an upstream account, not a downstream conversation. Reusing its saved
  // user/session id for every generation lets unrelated callers share relay-side state whenever
  // they land on the same account. A caller that explicitly binds a cache gets its own stable
  // relay session: GPT uses prompt_cache_key or verified Responses history, while other agents
  // accept a local prompt_cache_key binding or an explicit Anthropic cache_control boundary.
  // Unbound requests remain one session per generation. Keep the value across failover attempts:
  // retries are one logical request and must not fork their own relay session.
  const cacheRelaySessionId = relayAgent === "codex"
    ? null
    : relayPromptCacheSessionId(clientApiKey(request, protocol), relayBody?.model, parseJsonObject(clientBody));
  if (cacheRelaySessionId) affinityKeys.unshift(hashKey(["relay-cache-session", cacheRelaySessionId]));
  const relaySessionId = typeof requestedRelaySessionId === "string" && requestedRelaySessionId.trim()
    ? requestedRelaySessionId.trim()
    : cacheRelaySessionId || randomUUID();
  if (relayAgent === "codex" && requestedRelaySessionId) affinityKeys.unshift(hashKey(["relay-cache-session", relaySessionId]));
  // The relay queues a request before it sends any header; a streaming caller is kept connected
  // through that wait instead of watching a silent socket. See queue-keepalive.js. Measured on
  // the Claude relay, but nothing about the wait is Claude's: Codex callers hang up on the same
  // silence. Image generation is left out — its handler cannot report a failure in-stream.
  const queueHold = parseJsonObject(clientBody)?.stream === true && QUEUE_HOLD_PATHS.has(clientPath)
    && !url.pathname.startsWith("/v1/images/") && !hasImageTool(relayBody) && !isImageModel(relayBody?.model)
    ? holdStreamOpen(response, { protocol, path: clientPath, delayMs: config.queueHoldDelayMs, intervalMs: config.queueHoldIntervalMs })
    : null;
  const rotationMode = pool.mode();
  await sessions?.refreshUntilReady(config.homes, () => pool.hasCandidate());
  if (request.aborted || response.destroyed) {
    queueHold?.stop();
    if (logEntry) requestLog.fail(logEntry, 499);
    return;
  }
  if (parseJsonObject(clientBody)?.stream === true && config.streamHeartbeatIntervalMs !== 0) {
    STREAM_HEARTBEATS.set(response, {
      heartbeat: protocol === "anthropic" ? 'event: ping\ndata: {"type":"ping"}\n\n' : ": keepalive\n\n",
      intervalMs: config.streamHeartbeatIntervalMs || 15_000
    });
  }
  const excluded = new Set();
  const headerTimeoutMs = url.pathname.startsWith("/v1/images/") || hasImageTool(relayBody) ? Math.min(config.timeoutMs || 300_000, config.imageTimeoutMs || 180_000) : firstByteTimeout(config, relayAgent, thinkingRungOf(relayBody));
  const failoverDeadline = Date.now() + Math.max(failoverBudget(config), headerTimeoutMs);
  let serverFaults = 0;
  let congestionRefusals = 0;
  let platformQueueRefusals = 0;
  const platformQueueDeadline = Math.min(failoverDeadline, Date.now() + 240_000);
  let queuedProfile = null;
  let profile;
  let usedProfile = null;
  let upstream;
  let preparedChatStream = null;
  let chatStreamFailure = null;

  while ((profile = pool.pick(excluded, queuedProfile?.home || preferredHome(affinity, affinityKeys), rotationMode))) {
    queuedProfile = null;
    if (request.aborted || response.destroyed) {
      if (upstream?.body) await upstream.body.cancel().catch(() => {});
      if (logEntry) requestLog.fail(logEntry, 499);
      return;
    }
    const remainingMs = failoverDeadline - Date.now();
    if (upstream && remainingMs <= 0) break;
    await upstream?.body?.cancel?.();
    const attemptTimeoutMs = upstream ? Math.min(headerTimeoutMs, remainingMs) : headerTimeoutMs;
    const attemptDeadline = Date.now() + attemptTimeoutMs;
    // Only a stream held back from the caller until it shows content can still go to another
    // account, so only that one owes its first content by the attempt's deadline. Any other
    // answer is forwarded as soon as its headers arrive: cutting it off at the header wait —
    // while a long prompt is still being read, or a model thinks before its first summary —
    // only breaks an answer the caller already has, to be retried from the top. That one is
    // allowed what an idle stream is allowed, which heartbeats cannot stretch.
    const contentTimeoutMs = validateChatStream ? attemptTimeoutMs : Math.max(attemptTimeoutMs, config.streamIdleTimeoutMs || 300_000);
    usedProfile = profile;
    chatStreamFailure = null;
    // A Claude answer held back for Chat may think for longer than that deadline with nothing to
    // show: hidden thinking converts to no chunk at all. Its raw relay frames still carry a token
    // estimate, and only that is passed to the hold, out of band and never onto the wire.
    const hiddenProgress = validateChatStream && relayAgent === "claude" && url.pathname === "/v1/messages" ? createProgressSignal() : null;
    upstream = await fetchRelay(request, config, profile, fetchImpl, url, body, relaySessions, relayAgent, attemptTimeoutMs, response, relaySessionId, contentTimeoutMs, {
      ...(logEntry ? { onChunk: () => requestLog.recordFirstByte(logEntry) } : {}),
      ...(logEntry || hiddenProgress ? {
        onFrame: (frame) => {
          if (logEntry) requestLog.recordFirstOutput(logEntry, frame);
          if (hiddenProgress && frameHasThinkingEstimate(frame)) hiddenProgress.report(Date.now());
        }
      } : {})
    });
    if (request.aborted || response.destroyed) {
      if (upstream?.body) await upstream.body.cancel().catch(() => {});
      if (logEntry) requestLog.fail(logEntry, 499);
      return;
    }
    // Every answer carries the account's rate-limit meter, refusals included, so the rotation
    // learns what this account has left from the request it just made rather than from a poll.
    pool.observeQuota(profile.home, upstream.headers);
    if (upstream.status === 429) pool.markLimited(profile, retryAfterMs(upstream.headers?.get?.("retry-after")));
    if (upstream.ok && (validateChatStream || validateResponsesStream || gateAnthropicStream)) {
      try {
        if (validateChatStream) {
          const chatUpstream = await normalizeChatUpstream(await chatAdapter(upstream));
          preparedChatStream = await primeChatCompletionStream(await ensureChatCompletionStream(chatUpstream), {
            ...imageStreamLimits(relayBody),
            firstContentTimeoutMs: Math.max(0, attemptDeadline - Date.now()),
            progress: hiddenProgress,
            progressTimeoutMs: config.streamIdleTimeoutMs || 300_000
          });
        } else if (gateAnthropicStream) {
          upstream = await gateAnthropicRefusal(upstream, protocol === "anthropic" ? Math.min(attemptDeadline, Date.now() + 250) : attemptDeadline, protocol === "anthropic");
        } else {
          upstream = await primeResponsesStream(await normalizeResponsesContentType(upstream), {
            ...imageStreamLimits(relayBody),
            waitForCompletion: parseJsonObject(clientBody)?.stream !== true,
            maxWaitMs: parseJsonObject(clientBody)?.stream === true ? 250 : Infinity
          });
        }
      } catch (error) {
        const streamError = relayStreamError(error);
        chatStreamFailure = {
          code: streamError.code,
          status: upstream.status,
          details: relayErrorDetails(error.upstreamError || streamError),
          stream: upstream.headers.get("content-type")?.includes("text/event-stream") || false
        };
        await upstream.body?.cancel().catch(() => {});
        const headers = new Headers(upstream.headers);
        headers.set("content-type", "application/json");
        headers.delete("content-length");
        headers.delete("content-encoding");
        const status = streamError.statusCode;
        upstream = new Response(JSON.stringify({ ...(protocol === "anthropic" ? { type: "error" } : {}), error: relayErrorDetails(streamError) }), {
          status, headers
        });
      }
      if (request.aborted || response.destroyed) {
        await preparedChatStream?.body?.cancel().catch(() => {});
        if (logEntry) requestLog.fail(logEntry, 499);
        return;
      }
    }
    requestLog?.attempt(logEntry, profile, pool.priority(profile), upstream.status, upstream.headers);
    if (upstream.relaySessionBlocked) break;
    // An upstream permission denial is final for this request. Do not consume its
    // body to guess policy, switch credentials, or penalize a healthy account.
    if (upstream.status === 403) {
      usage.record(profile, upstream);
      break;
    }
    if (upstream.headers?.get?.("x-should-retry")?.trim().toLowerCase() === "false") {
      usage.record(profile, upstream);
      break;
    }
    const retryWithAnotherProfile = upstream.networkError || retryableStatus(upstream.status);
    if (retryWithAnotherProfile) {
      // 0.0.454 distinguishes platform admission from account/model failover. Wait on the
      // same account instead of sending one queue-full refusal through the entire pool.
      if (upstream.status === 503) {
        upstream = await bufferRefusal(upstream, failoverDeadline);
        if (isPlatformQueueRefusal({ status: upstream.status, headers: upstream.headers, refusalBody: upstream.refusalBody })) {
          usage.record(profile, upstream, { congested: true });
          if (upstream.refusalComplete === false) break;
          platformQueueRefusals += 1;
          const delayMs = platformQueueRetryMs(upstream.headers);
          if (platformQueueRefusals >= MAX_CONGESTION_ATTEMPTS || Date.now() + delayMs >= platformQueueDeadline) break;
          if (logEntry) logEntry.stage = "waiting_queue";
          const ready = await waitForPlatformQueue(request, response, delayMs);
          if (!ready || request.aborted || response.destroyed) {
            queueHold?.stop();
            if (logEntry) requestLog.fail(logEntry, 499);
            return;
          }
          if (logEntry) logEntry.stage = "waiting_headers";
          queuedProfile = profile;
          continue;
        }
      }
      excluded.add(profile.home);
      // Only a fault the account is answerable for costs it its place in the rotation.
      if (accountFault(upstream)) pool.failure(profile, retryAfterMs(upstream.headers?.get?.("retry-after")));
      // The refusal has to be read to be told apart, and the body is about to be discarded
      // anyway. Buffered rather than cancelled, so the attempt that turns out to be the last
      // one still answers the caller with the relay's own words and request_id.
      let congested = false;
      let permanentRequestError = false;
      if (serverFault(upstream)) {
        upstream = await bufferRefusal(upstream, failoverDeadline);
        permanentRequestError = isPermanentRequestError(parseJsonObject(upstream.refusalBody || "")?.error);
        congested = congestionRefusal(upstream);
        if (congested) congestionRefusals += 1;
        else serverFaults += 1;
      }
      // Recorded after the refusal is classified, so the console can report a congestion 503
      // as the relay's own and not as this account's last word.
      if (upstream.networkError) usage.failure(profile);
      else usage.record(profile, upstream, { congested });
      // The budget is spent on retries, never on the first attempt: a request always reaches
      // the upstream at least once, however long the pool took to answer before it.
      const mayRetry = !permanentRequestError && Date.now() < failoverDeadline
        && serverFaults < MAX_SERVER_FAULT_ATTEMPTS
        && congestionRefusals < MAX_CONGESTION_ATTEMPTS;
      if (pool.hasCandidate(excluded) && mayRetry) {
        await congestionBackoff(congestionRefusals, failoverDeadline);
        continue;
      }
      break;
    }
    pool.success(profile);
    for (const key of affinityKeys) affinity?.remember(key, profile.home);
    usage.record(profile, upstream);
    break;
  }

  // Nothing was sent upstream because every eligible account is parked until its quota window
  // resets. Say so with the time to wait, instead of a login error or one more refused request.
  const limitedMs = upstream ? 0 : pool.limitedRetryMs(excluded);
  if (limitedMs > 0) {
    const minutes = Math.max(1, Math.ceil(limitedMs / 60_000));
    const message = `All Mirasim accounts have reached their rate limit; the earliest resets in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
    if (logEntry) requestLog.fail(logEntry, 429);
    if (queueHold?.committed) return queueHold.fail(429, { message });
    queueHold?.stop();
    return sendProtocolError(response, protocol, 429, message, { "Retry-After": String(Math.min(3600, Math.ceil(limitedMs / 1000))) });
  }
  if (!upstream || upstream.networkError) {
    const statusCode = upstream?.timedOut ? 504 : 503;
    const message = upstream?.timedOut
      ? "The Mirasim upstream did not return response headers before the configured timeout."
      // Only an empty pool is a login problem. A network error reached an account and failed
      // on the way to the relay, and telling its operator to log in again sends them to fix
      // the one thing that is not broken.
      : upstream
        ? "The Mirasim relay could not be reached from this gateway. Check the network and MIRASIM_RELAY_URL."
        : "No logged-in Mirasim relay profile is available. Run `npm run login -- email` or `npm run login -- github`.";
    if (logEntry) {
      logEntry.account = usedProfile?.id || null;
      requestLog.fail(logEntry, statusCode);
    }
    if (queueHold?.committed) return queueHold.fail(statusCode, { message });
    queueHold?.stop();
    return sendProtocolError(response, protocol, statusCode, message);
  }
  if (preparedChatStream) upstream = preparedChatStream;
  else if (url.pathname === "/v1/chat/completions") upstream = await normalizeChatUpstream(upstream);
  else if (url.pathname === "/v1/responses") upstream = await normalizeResponsesContentType(upstream);
  if (logEntry) {
    upstream = requestLog.observe(logEntry, upstream, usedProfile, {
      // Only a pass-through has to hide the usage chunk again; a translating handler
      // needs it to report token counts of its own.
      dropUsageOnlyFrames: prepared.injectedUsage && responseHandler === forwardResponse
    });
    if (chatStreamFailure) {
      logEntry.upstreamStatus = chatStreamFailure.status;
      logEntry.upstreamStream = chatStreamFailure.stream;
      logEntry.streamError = chatStreamFailure.code;
      logEntry.upstreamError = chatStreamFailure.details;
      logEntry.stage = "failed";
    }
  }
  if (queueHold?.committed && !upstream.ok) {
    const error = parseJsonObject(await upstream.text().catch(() => ""))?.error;
    return queueHold.fail(upstream.status, error && typeof error === "object" ? error : {});
  }
  queueHold?.stop();
  if (!upstream.ok && protocol === "openai") return forwardOpenAiError(response, upstream);
  if (!upstream.ok && protocol === "anthropic" && url.pathname.startsWith("/v1/images/")) {
    const payload = await upstream.json().catch(() => null);
    return sendAnthropicError(response, upstream.status, payload?.error?.message || "The image relay rejected the request.");
  }
  return preparedChatStream ? forwardChatResponse(response, upstream, true, imageStreamLimits(relayBody)) : responseHandler(response, upstream);
}

// A conversation is identified by what stays byte-stable across its turns: the model, the
// system prompt (or Responses instructions) and the first user message. Later turns append
// to the transcript without touching any of these, so every turn maps to the same key —
// and therefore to the same account, whose prompt cache holds the conversation's prefix.
// The system prompt alone is the second, weaker key: a NEW conversation from the same
// client shares no transcript but does share the (often long) system prefix, so routing it
// to the account its siblings warmed still turns that prefix into a cache read.
function affinityKeysFor(value, owner) {
  if (!owner || !value || typeof value !== "object") return [];
  const keys = [];
  // The upstream cache slot belongs to the relay's current model id. Keep an old desktop alias
  // and the current spelling on one account, otherwise the next turn lands on a cold profile.
  const model = relayModelFor(value.model) || value.model || null;
  const promptCacheKey = typeof value.prompt_cache_key === "string" ? value.prompt_cache_key.trim() : "";
  // This is only a local routing key. Chat-backed agents do not all accept the Responses-only
  // field upstream, but callers that supply it still expect their cached conversation to stick.
  if (promptCacheKey) keys.push(hashKey({ owner, model, promptCacheKey }));
  const system = affinitySystemText(value);
  const first = firstUserMessage(value);
  if (first !== null) keys.push(hashKey({ owner, model, system, first }));
  if (system) keys.push(hashKey({ owner, model, system }));
  return keys;
}

function gptPromptCacheKey(owner, model, value) {
  const explicit = typeof value.prompt_cache_key === "string" ? value.prompt_cache_key.trim() : "";
  if (explicit) return explicit;
  const sessionId = metadataSessionId(value);
  if (sessionId) return hashKey(["mirasim-anthropic-gpt-cache-v1", owner, model, sessionId]);
  const marked = relayPromptCacheSessionId(owner, model, value);
  if (marked) return marked;
  const first = firstUserMessage(value);
  if (!first) return null;
  return hashKey(["mirasim-gpt-auto-cache-v1", owner, model, affinitySystemText(value), first]);
}

function metadataSessionId(value) {
  const userId = typeof value.metadata?.user_id === "string" ? value.metadata.user_id.trim() : "";
  const metadata = parseJsonObject(userId);
  const legacySession = userId.startsWith("user_") && userId.includes("_account_")
    ? /_session_([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i.exec(userId)?.[1] : null;
  return typeof metadata?.session_id === "string" ? metadata.session_id.trim()
    : legacySession;
}

// GPT prompt caching is session-sensitive at the relay. Derive a stable UUID only when the
// request carries a cache key, and scope it to this gateway API key and model so a
// shared cache-key string can never bridge two tenants or GPT variants. The digest is not sent
// as prompt content; only its UUID representation is sealed as relay metadata.
function gptPromptCacheSessionId(owner, model, promptCacheKey) {
  const cacheKey = typeof promptCacheKey === "string" ? promptCacheKey.trim() : "";
  if (!cacheKey || typeof owner !== "string" || !owner || typeof model !== "string" || !model) return null;
  const bytes = createHash("sha256").update(JSON.stringify(["mirasim-gpt-cache-session-v1", owner, model, cacheKey])).digest().subarray(0, 16);
  return sessionIdFromBytes(bytes);
}

// The other relay agents use the same session-sensitive cache, but their client protocols do
// not all have OpenAI's Responses-only prompt_cache_key. Treat that field as local metadata on
// every wire, and also honor a caller's explicit Anthropic cache_control boundary. The immutable
// conversation origin (system prompt plus first user message) keeps later transcript growth on
// the same cache session without making an unmarked request share relay-side state.
function relayPromptCacheSessionId(owner, model, value) {
  if (typeof owner !== "string" || !owner || typeof model !== "string" || !model || !value || typeof value !== "object") return null;
  const cacheKey = typeof value.prompt_cache_key === "string" ? value.prompt_cache_key.trim() : "";
  let binding = cacheKey ? ["prompt_cache_key", cacheKey] : null;
  const sessionId = metadataSessionId(value);
  if (!binding && sessionId) binding = ["metadata_session", sessionId];
  if (!binding && hasExplicitCacheControl(value)) {
    const system = affinitySystemText(value);
    const first = firstUserMessage(value);
    if (system || first !== null) binding = ["cache_control", system, first];
  }
  if (!binding) return null;
  const bytes = createHash("sha256")
    .update(JSON.stringify(["mirasim-relay-cache-session-v1", owner, model, binding]))
    .digest()
    .subarray(0, 16);
  return sessionIdFromBytes(bytes);
}

function sessionIdFromBytes(bytes) {
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hasExplicitCacheControl(value) {
  const candidates = [
    value,
    value.system,
    value.instructions,
    value.tools,
    ...(Array.isArray(value.tools) ? value.tools.map((tool) => tool?.function) : []),
    ...(Array.isArray(value.messages) ? value.messages.flatMap((message) => [message, message?.content]) : []),
    ...(Array.isArray(value.input) ? value.input.flatMap((item) => [item, item?.content, item?.output]) : [])
  ];
  return candidates.some((candidate) => cacheControlIn(candidate));
}

function cacheControlIn(value) {
  if (Array.isArray(value)) return value.some(cacheControlIn);
  return Boolean(value && typeof value === "object" && value.cache_control && typeof value.cache_control === "object");
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

function prepareRelayBody(body, url, defaultEffort = "none", minEffort = "none", officialRelay = false, passthrough = true, bridged = false) {
  if (url.pathname.startsWith("/v1/images/") || url.pathname === "/v1/alpha/search") return { body, injectedUsage: false };
  const value = parseJsonObject(body);
  if (!value) return { body, injectedUsage: false };
  let changed = false;
  let injectedUsage = false;
  if (value.model === "claude-flabe-5") {
    value.model = "claude-fable-5";
    changed = true;
  }
  // A vendor id the relay does not answer to, swapped for the one it does. The desktop client
  // does the same rewrite before it sends anything, and the id it starts from is the one this
  // gateway used to advertise.
  const relayModel = relayModelFor(value.model);
  if (relayModel) {
    value.model = relayModel;
    changed = true;
  }
  // prompt_cache_key is useful local cache-session metadata for every model, but only Codex's
  // Responses upstream accepts it on the wire. Keep it for GPT and remove it everywhere else
  // after the session has been derived, so another agent never rejects an otherwise valid call.
  if (value.prompt_cache_key !== undefined && relayWireFor(value.model) !== "responses") {
    delete value.prompt_cache_key;
    changed = true;
  }
  if (url.pathname === "/v1/chat/completions" && relayAgentFor(value.model) === "dsh") {
    const foreignReasoning = value.reasoning !== undefined || value.output_config !== undefined || value.thinking?.type === "adaptive" || value.thinking?.budget_tokens !== undefined;
    if (foreignReasoning) {
      copyChatReasoning(value, value);
      delete value.reasoning;
      delete value.output_config;
      changed = true;
    }
    if (!passthrough) {
      const effort = explicitReasoningEffort(value);
      if (!isDisabledEffort(effort)) {
        const managed = { reasoning: { effort } };
        applyCodexEffort(managed, defaultEffort, minEffort);
        if (managed.reasoning?.effort) {
          value.reasoning_effort = managed.reasoning.effort;
          value.thinking = { type: "enabled" };
          changed = true;
        }
      }
    }
  }
  // Unknown names retain the established Claude-default treatment. Known non-Claude Messages
  // agents (currently ZCode) must reach their own upstream untouched: adding Claude's identity,
  // cache markers, or thinking controls changes their protocol contract.
  const agent = relayAgentFor(value.model);
  if (protocolForPath(url.pathname) === "anthropic" && (agent === null || agent === "claude")) {
    if (typeof value.output_config?.effort === "string" && value.output_config.effort.trim().toLowerCase() === "ultracode") {
      value.output_config = { ...value.output_config, effort: "xhigh" };
      changed = true;
    }
    if (normalizeClaudeSystem(value, { bridged })) changed = true;
    const system = withAgentIdentity(value.system);
    if (system !== value.system) {
      value.system = system;
      changed = true;
    }
    if (dropRejectedSamplingParams(value, officialRelay)) changed = true;
    // First what the caller asked for, restated in a shape the relay accepts; then what it left
    // unsaid; then the floor over whatever the two of them settled on.
    if (!passthrough && normalizeThinkingShape(value, defaultEffort)) changed = true;
    if (!passthrough && applyDefaultThinking(value, defaultEffort)) changed = true;
    // After the level is settled, whoever settled it: the floor lifts a client's own rung too,
    // which is the only way past a client that names its level and stops below where the
    // operator wants to run.
    if (!passthrough && applyEffortFloor(value, minEffort)) changed = true;
    if (dropUnrunnableSearchTool(value)) changed = true;
    if (applySearchFirstGuidance(value)) changed = true;
    // After the identity blocks are settled, so the stable-prefix breakpoint lands on the
    // system array the relay actually receives.
    if (applyCacheBreakpoints(value)) changed = true;
  }
  // A chat-completions upstream (DeepSeek, Kimi) holds the response headers of a
  // non-streaming request until the whole completion is done, so a slow generation outlasts
  // the header wait and fails over for nothing. The stream is always asked for instead; a
  // caller that wanted one object still gets one, folded back out of the stream by the
  // response handlers.
  if ((url.pathname === "/v1/messages" || (url.pathname === "/v1/chat/completions" && relayWireFor(value.model) === "chat-completions")) && value.stream !== true) {
    value.stream = true;
    changed = true;
  }
  // The relay reports token usage on a streamed chat completion only when it is asked to,
  // which is what leaves the console with no numbers for OpenAI-protocol traffic.
  if (url.pathname === "/v1/chat/completions" && value.stream === true && value.stream_options === undefined) {
    value.stream_options = { include_usage: true };
    changed = true;
    injectedUsage = true;
  }
  return { body: changed ? Buffer.from(JSON.stringify(value)) : body, injectedUsage };
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

// The whole shape an adaptive model needs, in one place: the display that makes the reasoning
// come back at all, and the rung that decides how much of it there is. A caller that named its
// own `output_config` is left alone — it has already said what it wants.
function applyAdaptiveThinking(value, effort) {
  // A caller that named a display of its own keeps it; everything else gets the one that works.
  const display = typeof value.thinking?.display === "string" && value.thinking.display.trim()
    ? value.thinking.display
    : THINKING_DISPLAY;
  value.thinking = { type: "adaptive", display };
  if (effort && !value.output_config) value.output_config = { effort };
  return true;
}

// Lifts a level that came in below the configured floor, and never lowers one that came in
// above it. A request that asked for no thinking still gets none: the floor sets
// how hard a turn thinks, not whether it thinks at all.
function applyEffortFloor(value, minEffort) {
  const floor = minEffort === "minimal" ? "low" : minEffort;
  if (!REASONING_RUNGS.includes(floor)) return false;
  const thinking = value.thinking;
  if (!thinking || typeof thinking !== "object" || thinking.type === "disabled" || thinking.enabled === false) return false;

  if (thinking.type === "adaptive") {
    const current = typeof value.output_config?.effort === "string" ? value.output_config.effort.trim().toLowerCase() : "";
    if (REASONING_RUNGS.indexOf(current) >= REASONING_RUNGS.indexOf(floor)) return false;
    value.output_config = { ...value.output_config, effort: floor };
    return true;
  }
  // An older model has no rung to lift, so the floor is applied as the budget that rung means.
  const budget = REASONING_BUDGET_TOKENS[floor];
  if (!Number.isFinite(thinking.budget_tokens) || !budget || thinking.budget_tokens >= budget) return false;
  value.thinking = { ...thinking, budget_tokens: budget };
  const maxTokens = Number.isFinite(value.max_tokens) ? value.max_tokens : 0;
  value.max_tokens = Math.max(maxTokens, budget + THINKING_ANSWER_HEADROOM_TOKENS);
  return true;
}

// The rung a token budget was reaching for. The budget table is one entry per rung, so a budget
// this gateway itself chose maps back to exactly the rung it came from; a number a caller picked
// lands on the nearest rung at or below it.
function rungForBudget(budget) {
  const tokens = Number.isFinite(budget) ? budget : 0;
  let rung = REASONING_RUNGS[0];
  for (const name of REASONING_RUNGS) {
    if (tokens >= REASONING_BUDGET_TOKENS[name]) rung = name;
  }
  return rung;
}

// What the caller asked for by name, if it named a rung at all. `minimal` is folded into `low`
// the way the official client folds it; a name the relay would refuse is treated as unsaid.
function requestedRung(chat) {
  return normalizeRung(chat?.reasoning_effort) || normalizeRung(chat?.reasoning?.effort);
}

const RUNG_ALIASES = {
  minimal: "low", light: "low", lite: "low", none: null, off: null,
  "extra high": "xhigh", "extra-high": "xhigh", extra_high: "xhigh", extrahigh: "xhigh",
  ultra: "max", ultracode: "xhigh", highest: "max", xtreme: "max"
};

// One rung name, or null for anything the relay would refuse. Null means "unsaid": a name this
// gateway cannot place is not forwarded into a guaranteed 400, it simply stops counting as a
// request for a level, and whatever would have applied without it applies instead.
function normalizeRung(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (!name) return null;
  if (REASONING_RUNGS.includes(name)) return name;
  return Object.hasOwn(RUNG_ALIASES, name) ? RUNG_ALIASES[name] : null;
}

// The relay serves GPT models on its own Responses endpoint and validates that request against the
// exact field set the official Codex client sends. Measured: `store: false` and `stream: true` are
// required and `input` must be an array; `max_output_tokens`, `temperature`, `top_p`, `metadata`,
// `previous_response_id`, `store: true` and `stream: false` are each refused with a bare 400.
// `instructions`, `tools`, `tool_choice`, `parallel_tool_calls`, `text`, `include`,
// `prompt_cache_key` and `reasoning` are all accepted.
const CODEX_REJECTED_FIELDS = ["max_output_tokens", "max_tokens", "temperature", "top_p", "metadata", "n", "logprobs", "top_logprobs", "seed", "service_tier", "truncation", "user"];

// A Codex request as the relay will accept it. Returns the sanitised body and whether the caller
// wanted the stream itself — the relay refuses a non-streaming request, so one is always made and
// a caller that asked for a single object has the stream folded back into one.
function prepareCodexBody(value, defaultEffort, minEffort, passthrough = true) {
  const clientWantsStream = value.stream === true;
  value.stream = true;
  value.store = false;
  delete value.previous_response_id;
  delete value.conversation;
  // The Responses API takes a bare string; this relay does not.
  if (typeof value.input === "string") {
    value.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: value.input }] }];
  }
  if (Array.isArray(value.input)) {
    value.input = value.input.map((item) => item?.role === "system" && (!item.type || item.type === "message") ? { ...item, role: "developer" } : item);
  }
  for (const field of CODEX_REJECTED_FIELDS) delete value[field];
  const effort = explicitReasoningEffort(value);
  const foreignReasoning = value.reasoning_effort !== undefined || value.thinking !== undefined || value.output_config !== undefined;
  if (effort !== undefined && (value.reasoning === undefined || foreignReasoning)) {
    value.reasoning = { ...value.reasoning, effort: foreignReasoning ? normalizeRung(effort) || effort : effort };
  }
  delete value.reasoning_effort;
  delete value.thinking;
  delete value.output_config;
  if (typeof value.reasoning?.effort === "string" && value.reasoning.effort.trim().toLowerCase() === "ultra") {
    value.reasoning = { ...value.reasoning, effort: "max" };
  }
  if (!passthrough) applyCodexEffort(value, defaultEffort, minEffort);
  if (value.model === "gpt-6-astra" && isDisabledEffort(value.reasoning?.effort)) {
    value.reasoning = { ...value.reasoning, effort: "low" };
  }
  if (!isDisabledEffort(value.reasoning?.effort) && value.reasoning?.summary === undefined) {
    value.reasoning = { ...value.reasoning, summary: "auto" };
  }
  return clientWantsStream;
}

// The same ladder the Anthropic side uses — low, medium, high, xhigh, max — because the relay
// accepts exactly those five for a gpt-5.6 model and refuses everything else: `minimal` with
// `unsupported_value`, anything unplaceable with `invalid_value`. An effort it cannot place is
// dropped rather than sent, which leaves the model on its own default of medium.
function applyCodexEffort(value, defaultEffort, minEffort) {
  if (isDisabledEffort(value.reasoning?.effort)) {
    value.reasoning.effort = "none";
    return;
  }
  const asked = value.reasoning && typeof value.reasoning === "object" ? normalizeRung(value.reasoning.effort) : null;
  const fallback = REASONING_BUDGET_TOKENS[defaultEffort] ? rungForBudget(REASONING_BUDGET_TOKENS[defaultEffort]) : null;
  const floor = normalizeRung(minEffort);
  let effort = asked || fallback;
  if (effort && floor && REASONING_RUNGS.indexOf(effort) < REASONING_RUNGS.indexOf(floor)) effort = floor;
  if (!effort) {
    if (value.reasoning && typeof value.reasoning === "object" && value.reasoning.effort !== undefined) {
      const { effort: dropped, ...rest } = value.reasoning;
      value.reasoning = rest;
      if (Object.keys(rest).length === 0) delete value.reasoning;
    }
    return;
  }
  value.reasoning = { ...(value.reasoning && typeof value.reasoning === "object" ? value.reasoning : {}), effort };
}

// What the caller said about thinking, restated in the shapes the relay accepts, before anything
// else reads it. Each rewrite here replaces a request the relay would refuse outright — or answer
// 200 with the reasoning silently missing — with the nearest one it honours. A caller that sent
// something valid is not touched.
function normalizeThinkingShape(value, defaultEffort) {
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!anthropicOnlyModel(model)) return false;
  const adaptive = ADAPTIVE_THINKING_MODEL.test(model);
  let changed = false;

  // A rung only means something to an adaptive model, and only by a name the relay knows. An
  // older model is refused outright for carrying one; an unplaceable name counts as unsaid, so
  // the level this gateway would have chosen anyway applies instead of a certain 400.
  if (value.output_config !== undefined) {
    if (!adaptive || value.output_config === null || typeof value.output_config !== "object") {
      delete value.output_config;
      changed = true;
    } else if (value.output_config.effort !== undefined) {
      const rung = normalizeRung(value.output_config.effort);
      if (rung === null) {
        const { effort, ...rest } = value.output_config;
        value.output_config = rest;
        if (Object.keys(rest).length === 0) delete value.output_config;
        changed = true;
      } else if (rung !== value.output_config.effort) {
        value.output_config = { ...value.output_config, effort: rung };
        changed = true;
      }
    }
  }

  const thinking = value.thinking;
  if (!thinking || typeof thinking !== "object") return changed;

  if (adaptive && thinking.type === "adaptive") {
    // Only `summarized` is served: every other display is refused, and no display at all means a
    // 200 with the reasoning missing. Either way the caller asked to think and gets nothing to
    // show for it, so the display is settled here — including for a request that named its own
    // rung, which is the shape Claude Code sends and the one nothing else fills in.
    if (thinking.display !== THINKING_DISPLAY) {
      value.thinking = { ...thinking, display: THINKING_DISPLAY };
      changed = true;
    }
    return changed;
  }

  // An older model refuses the adaptive type. The caller asked for thinking and named no budget,
  // so it gets the configured one — the same level it would have been given had it said nothing.
  if (!adaptive && thinking.type === "adaptive") {
    const budget = REASONING_BUDGET_TOKENS[defaultEffort] || REASONING_BUDGET_TOKENS.medium;
    value.thinking = { type: "enabled", budget_tokens: budget };
    const maxTokens = Number.isFinite(value.max_tokens) ? value.max_tokens : 0;
    value.max_tokens = Math.max(maxTokens, budget + THINKING_ANSWER_HEADROOM_TOKENS);
    return true;
  }
  return changed;
}

function applyDefaultThinking(value, defaultEffort) {
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!anthropicOnlyModel(model)) return false;
  const adaptive = ADAPTIVE_THINKING_MODEL.test(model);

  // A caller that asked for thinking of its own is honoured — with one exception, because
  // honouring it there means the caller silently gets none. An adaptive model accepts
  // `{ type: "enabled", budget_tokens }` with a 200 and then ignores it: no thinking block
  // comes back and nothing reports a problem. That request is restating, in the older shape,
  // the same thing the rung says, so it is carried over to the rung nearest its budget.
  if (value.thinking !== undefined) {
    if (!adaptive) return false;
    if (value.thinking?.type === "enabled") return applyAdaptiveThinking(value, rungForBudget(value.thinking.budget_tokens));
    // `{ type: "adaptive" }` on its own turns thinking on and says nothing about how hard, which
    // is the same silence a request with no thinking at all leaves — most clients have no field
    // for the rung and never send one. So it gets the configured level, and the display without
    // which its reasoning never comes back. A rung the caller did name is left alone.
    if (value.thinking?.type === "adaptive" && !value.output_config) {
      const configured = REASONING_BUDGET_TOKENS[defaultEffort];
      return applyAdaptiveThinking(value, configured ? rungForBudget(configured) : null);
    }
    return false;
  }

  const budget = REASONING_BUDGET_TOKENS[defaultEffort];
  if (!budget) return false;
  // A transcript that replays a tool_use turn without its signed thinking is rejected upstream
  // the moment thinking is on, so a history this gateway cannot restore keeps it off. The
  // OpenAI translation already decides that for the requests it builds; this is the same
  // decision made here, where it also covers a converting gateway that arrives on this path
  // with exactly that history and no thinking field of its own.
  if (Array.isArray(value.messages) && hasUnrestorableToolUse(value.messages)) return false;
  // Whether the turn declares tools is the signal, not how big its budget is. A turn with
  // tools is an agent turn, and it is precisely the turn that breaks with thinking off —
  // Claude writes the call into its visible text and it never runs. Those get thinking
  // whatever max_tokens says, with room made for it when the caller budgeted none; a client
  // that asked Codex to look something up should not lose its search tool to a small budget.
  const agentTurn = Array.isArray(value.tools) && value.tools.length > 0;
  const maxTokens = Number.isFinite(value.max_tokens) ? value.max_tokens : 0;
  // Current models are steered by a rung and quietly ignore a token budget; the older ones only
  // understand the budget and refuse the rung outright, so the shape has to follow the model.
  if (adaptive) {
    if (maxTokens < MIN_THINKING_MAX_TOKENS && !agentTurn) return false;
    applyAdaptiveThinking(value, rungForBudget(budget));
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
  + "Look information up before answering whenever current information would "
  + "change the answer — recent events or releases, current prices, versions, or anything the "
  + "user marks as recent or time-sensitive — rather than answering from memory. For an "
  + "open-ended research request, start searching immediately instead of asking a scoping "
  + "question first, unless the request is genuinely ambiguous about what to research.\n"
  + "Search by running a shell command — that is the route available here, so do not answer "
  + "from memory instead. Prefer an endpoint that returns text rather than a page that needs "
  + "a browser: lite.duckduckgo.com/lite/?q=... works with a plain curl, as does fetching a "
  + "page through r.jina.ai. URL-encode the query, strip the markup from what comes back, and "
  + "read the result. One search is rarely enough: follow the promising links and fetch those "
  + "pages too before answering, and prefer sources that show a date.\n"
  + "</search_first>";

function applySearchFirstGuidance(value) {
  const tools = Array.isArray(value.tools) ? value.tools : [];
  if (!tools.some((tool) => typeof tool?.type === "string" && SERVER_SEARCH_TOOL.test(tool.type))) return false;
  const system = contentBlocks(value.system) || [];
  if (system.some((block) => typeof block?.text === "string" && block.text.includes("<search_first>"))) return false;
  value.system = [...system, { type: "text", text: SEARCH_FIRST_GUIDANCE }];
  return true;
}

// A server tool is run by Anthropic, so the client never invokes it and — where the client
// restricts it, as Codex does — never gets to. Offering it only invites a call that dies.
// Withdrawing it leaves the model the client's own shell, which the client really does run,
// so the search executes through the same tool-call path as everything else the client does.
const CLIENT_SHELL_TOOL = /^(?:exec_command|bash|shell|run_command|execute)/i;

function dropUnrunnableSearchTool(value) {
  const tools = Array.isArray(value.tools) ? value.tools : [];
  if (!tools.some((tool) => typeof tool?.name === "string" && CLIENT_SHELL_TOOL.test(tool.name))) return false;
  const kept = tools.filter((tool) => typeof tool?.type !== "string" || !SERVER_SEARCH_TOOL.test(tool.type));
  if (kept.length === tools.length) return false;
  value.tools = kept;
  return true;
}

function dropRejectedSamplingParams(value, officialRelay = false) {
  let changed = false;
  if (value.temperature !== undefined && (officialRelay || value.temperature !== RELAY_ACCEPTED_TEMPERATURE)) {
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

async function fetchRelay(request, config, profile, fetchImpl, url, body, relaySessions = null, agent = null, timeoutMs = firstByteTimeout(config, agent), downstream = null, sessionId = null, contentTimeoutMs = timeoutMs, timing = {}) {
  const controller = new AbortController();
  const signal = controller.signal;
  const contentDeadline = Date.now() + contentTimeoutMs;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortOnClientDisconnect = () => controller.abort();
  const abortOnResponseClose = () => {
    if (!downstream.writableEnded) controller.abort();
  };
  let streaming = false;
  const cleanup = () => {
    request.off("aborted", abortOnClientDisconnect);
    downstream?.off("close", abortOnResponseClose);
  };
  request.once("aborted", abortOnClientDisconnect);
  downstream?.once("close", abortOnResponseClose);
  try {
    // Chat-backed agents are internally changed to `stream: true` when the caller wants one
    // JSON object: their relay does not send non-streaming response headers soon enough. That
    // transport decision must include the matching Accept header too. Leaving the caller's
    // `application/json` here makes DeepSeek negotiate a JSON response while the handlers are
    // collecting SSE, so the non-streaming JSON conversion receives the wrong wire format.
    const upstreamStream = parseJsonObject(body)?.stream === true;
    const headerOptions = {
      method: "POST",
      path: url.pathname,
      body,
      accept: upstreamStream ? "text/event-stream" : request.headers.accept || "application/json",
      contentType: request.headers["content-type"] || "application/json",
      clientVersion: config.clientVersion,
      agent,
      sessionId,
      signal
    };
    const headers = await relayRequestHeaders(relaySessions, profile, headerOptions);
    signal.throwIfAborted();
    const anthropicUpstream = url.pathname === "/v1/messages";
    const requestedBeta = anthropicUpstream ? request.headers["anthropic-beta"] || DEFAULT_ANTHROPIC_BETA : "";
    const beta = anthropicUpstream && relaySessions?.enabled
      ? requestedBeta.split(",").map((value) => value.trim()).filter((value) => value && value !== "oauth-2025-04-20").join(",")
      : requestedBeta;
    const version = anthropicUpstream ? request.headers["anthropic-version"] || DEFAULT_ANTHROPIC_VERSION : "";
    if (beta) headers["anthropic-beta"] = beta;
    if (version) headers["anthropic-version"] = version;
    // Native Messages callers retain their own metadata, so a real client's request reaches the
    // relay with the same shape it sent. This metadata is never attached to an OpenAI request
    // translated into Messages — that request is this gateway's own, not the caller's.
    const clientPath = new URL(request.url || "/", "http://gateway.local").pathname;
    if (anthropicUpstream && clientPath === "/v1/messages") {
      for (const name of [
        "x-stainless-lang", "x-stainless-package-version", "x-stainless-os", "x-stainless-arch",
        "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-retry-count", "x-stainless-timeout"
      ]) {
        const value = request.headers[name];
        if (typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\r\n\u0000]/.test(value)) headers[name] = value;
      }
    }

    const upstream = await fetchImpl(new URL(url.pathname + url.search, `${config.relayUrl}/`), {
      method: "POST",
      headers,
      body,
      signal,
      redirect: "error"
    });
    streaming = true;
    const guarded = guardUpstreamResponse(upstream, {
      ...timing,
      signal,
      // Before its first content the stream is still held to firstContentTimeoutMs, which is what
      // failover decides on. After it, the caller already has part of the answer: a quiet upstream
      // is bridged with heartbeats downstream and is only given up on as a stall.
      idleTimeoutMs: streamStallTimeout(config),
      firstContentTimeoutMs: upstream.ok ? Math.max(0, contentDeadline - Date.now()) : null,
      maxBytes: url.pathname.startsWith("/v1/images/") || hasImageTool(parseJsonObject(body)) ? IMAGE_RESPONSE_BYTES : config.maxStreamBytes || MAX_RESPONSE_BYTES,
      maxFrameBytes: url.pathname.startsWith("/v1/images/") || hasImageTool(parseJsonObject(body)) ? IMAGE_FRAME_BYTES : config.maxSseFrameBytes || MAX_SSE_FRAME_BYTES,
      onCancel: () => controller.abort(),
      onDone: cleanup
    });
    return anthropicUpstream ? endMessageStream(guarded) : guarded;
  } catch (error) {
    if (error instanceof MirasimRelaySessionError) {
      const blocked = new Response(JSON.stringify({ error: { type: "relay_session_unavailable", message: error.message } }), {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          ...(error.retryAfterMs > 0 ? { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) } : {})
        }
      });
      blocked.relaySessionBlocked = true;
      return blocked;
    }
    return { networkError: true, timedOut, status: 0, body: null };
  } finally {
    clearTimeout(timeout);
    if (!streaming) cleanup();
  }
}

async function modelList(config, pool, fetchImpl, sessions = null, relaySessions = null) {
  await sessions?.refreshUntilReady(config.homes, () => pool.hasCandidate());
  const profile = pool.pick();
  if (!profile) return configuredModels(config);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), modelListTimeout(config));
  try {
    const upstream = await fetchImpl(new URL("/v1/models", `${config.relayUrl}/`), {
      headers: await relayRequestHeaders(relaySessions, profile, { method: "GET", path: "/v1/models", accept: "application/json", clientVersion: config.clientVersion, signal: controller.signal }),
      signal: controller.signal,
      redirect: "error"
    });
    if (!upstream.ok) return configuredModels(config);
    const body = await upstream.json();
    const data = normalizeModelList(body?.data);
    if (!data) return configuredModels(config);
    pool.success(profile);
    return { object: "list", data: withAgentModels(data, config) };
  } catch {
    return configuredModels(config);
  } finally {
    clearTimeout(timeout);
  }
}

function configuredModels(config) {
  return {
    object: "list",
    data: withAgentModels(config.models.map((id) => ({ id, object: "model", created: 0, owned_by: "mirasim-relay" })), config)
  };
}

// The relay answers /v1/models for the agent that asked, so the list an account gets back never
// mentions DeepSeek or Kimi — they are reachable, but only once a request arrives under their
// agent. What the relay will serve is therefore added to what it advertises; `owned_by` names
// the agent so a client can see which upstream an id belongs to. Nothing is added for an agent
// the operator turned off, and a config that predates the setting is left exactly as it is.
function withAgentModels(data, config) {
  const imageIds = (config.imageModels || []).filter((id) => !data.some((model) => model.id === id));
  if (imageIds.length) data = [...data, ...imageIds.map((id) => ({ id, object: "model", created: 0, owned_by: "mirasim-relay:codex" }))];
  const agents = Array.isArray(config?.relayAgents) ? config.relayAgents : [];
  if (agents.length === 0) return data;
  const known = new Set(data.map((model) => model.id));
  const added = [];
  for (const agent of agents) {
    for (const id of RELAY_AGENT_MODELS[agent] || []) {
      if (known.has(id)) continue;
      known.add(id);
      added.push({ id, object: "model", created: 0, owned_by: `mirasim-relay:${agent}` });
    }
  }
  return added.length > 0 ? [...data, ...added] : data;
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
  const validationError = validateResponsesRequest(request, { bridge: true });
  if (validationError) return { ok: false, message: validationError };
  const model = typeof request.model === "string" ? request.model.trim() : "";
  if (!model) return { ok: false, message: "A response model is required." };

  const messages = [];
  const preserveCache = anthropicOnlyModel(model);
  const instructions = preserveCache ? responseChatContent(request.instructions, true) : responseContent(request.instructions);
  if (instructions) messages.push({ role: "system", content: instructions });
  const inputMessages = responseInputMessages(request.input, preserveCache);
  if (!inputMessages.length) return { ok: false, message: "A response input is required." };
  messages.push(...inputMessages);

  const chat = { model, messages, stream: request.stream === true };
  if (preserveCache && request.system !== undefined) chat.system = request.system;
  for (const field of ["temperature", "top_p", "seed", "parallel_tool_calls", "reasoning", "reasoning_effort", "thinking", "output_config"]) {
    if (request[field] !== undefined) chat[field] = request[field];
  }
  if (Number.isFinite(request.max_output_tokens)) chat.max_tokens = request.max_output_tokens;
  if (request.text?.format) {
    const { type, ...format } = request.text.format;
    chat.response_format = type === "json_schema" ? { type, json_schema: format } : { type };
  }
  const tools = responseToolsToChat(request.tools, preserveCache);
  if (tools.length) chat.tools = tools;
  const toolChoice = responseToolChoiceToChat(request.tool_choice);
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  return { ok: true, request, chat, stream: chat.stream };
}

function responseInputMessages(input, preserveCache = false) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "reasoning") {
      const reasoning = Array.isArray(item.summary) ? item.summary.filter((part) => part?.type === "summary_text" && typeof part.text === "string").map((part) => part.text).join("") : "";
      if (reasoning) messages.push({ role: "assistant", content: null, reasoning_content: reasoning });
      continue;
    }
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
      const parts = responseChatContent(item.output, preserveCache);
      const content = typeof parts === "string" ? parts : parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      messages.push({ role: "tool", tool_call_id: responseCallId(item), content: content || "" });
      if (Array.isArray(parts) && parts.some((part) => part.type === "image_url")) messages.push({ role: "user", content: [{ type: "text", text: `Images from tool result ${item.call_id}:` }, ...parts.filter((part) => part.type === "image_url")] });
      continue;
    }
    const role = responseRole(item.role);
    const content = responseChatContent(item.content, preserveCache);
    const previous = messages.at(-1);
    if (role === "assistant" && content && previous?.role === "assistant" && previous.reasoning_content && previous.content === null && !previous.tool_calls) {
      previous.content = content;
    } else if (role && content) messages.push({ role, content });
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

function responseChatContent(value, preserveCache = false) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts = value.filter((part) => part && typeof part === "object").map((part) => ({
    ...(part.type === "input_image"
      ? { type: "image_url", image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } }
      : { type: "text", text: part.text }),
    ...(preserveCache && part.cache_control ? { cache_control: part.cache_control } : {})
  }));
  return parts.some((part) => part.type === "image_url" || part.cache_control) ? parts : parts.map((part) => part.text).join("\n");
}

function responseToolsToChat(tools, preserveCache = false) {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (!tool || tool.type !== "function" || typeof tool.name !== "string" || !tool.name.trim()) return [];
    return [{
      type: "function",
      ...(preserveCache && tool.cache_control ? { cache_control: tool.cache_control } : {}),
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

function anthropicRelayModel(model) {
  return relayWireFor(model) === "anthropic-messages";
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
  if (chat.response_format && chat.response_format.type !== "text") {
    return { ok: false, message: "response_format: structured output is not supported by this Messages bridge; use a native Responses or Chat model." };
  }
  const requestedModel = typeof chat.model === "string" ? chat.model.trim() : "";
  const model = requestedModel.replace(THINKING_MODEL_SUFFIX, "");
  if (!model) return { ok: false, message: "A chat model is required." };
  if (chat.system !== undefined && typeof chat.system !== "string" && (!Array.isArray(chat.system)
    || chat.system.some((block) => !block || block.type !== "text" || typeof block.text !== "string"))) {
    return { ok: false, message: "system: expected a string or an array of text blocks for a Claude model." };
  }
  const system = anthropicUserBlocks(chat.system);
  const messages = [];
  for (const message of Array.isArray(chat.messages) ? chat.messages : []) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system" || message.role === "developer") {
      const blocks = anthropicUserBlocks(message.content);
      if (blocks.length && messages.length) messages.push({ role: "system", content: blocks });
      else system.push(...blocks);
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
  // Always a stream upstream, whatever the caller asked for. A non-streaming Messages request
  // gets its response headers only once the whole answer — thinking included — is generated,
  // so an ordinary answer outlasts the header wait, is abandoned, and fails over to an account
  // whose prompt cache is cold, to be abandoned again. The caller's shape is unchanged: the
  // response handlers fold the stream back into one object for a caller that wanted one.
  request.stream = true;
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
  if (thinking.passthrough) {
    const effort = explicitReasoningEffort(chat);
    if (chat.thinking !== undefined) request.thinking = chat.thinking;
    if (chat.output_config !== undefined) request.output_config = chat.output_config;
    if (request.thinking === undefined && effort !== undefined) {
      if (isDisabledEffort(effort)) {
        request.thinking = { type: "disabled" };
      } else if (ADAPTIVE_THINKING_MODEL.test(model)) {
        request.thinking = { type: "adaptive", display: THINKING_DISPLAY };
      } else {
        const budget = REASONING_BUDGET_TOKENS[effort];
        if (!Number.isFinite(budget)) return { ok: false, message: `Cannot translate reasoning effort ${String(effort)} to a thinking budget for ${model}. Use thinking.budget_tokens explicitly.` };
        request.thinking = { type: "enabled", budget_tokens: budget };
        request.max_tokens = Math.max(request.max_tokens, budget + THINKING_ANSWER_HEADROOM_TOKENS);
      }
    }
    if (request.thinking?.type !== "disabled" && ADAPTIVE_THINKING_MODEL.test(model) && effort !== undefined && request.output_config === undefined) {
      request.output_config = { effort };
    }
    return { ok: true, request };
  }
  const budget = hasUnrestorableToolUse(messages)
    ? null
    : thinkingBudgetTokens(chat, requestedModel, thinking.defaultEffort);
  if (budget && ADAPTIVE_THINKING_MODEL.test(model)) {
    // The OpenAI protocol carries an effort name, which is exactly what an adaptive model wants,
    // and this path used to translate it into a token budget the model then ignored — so every
    // reasoning_effort from low to high produced the same answer with no reasoning in it. The
    // rung the caller named is passed through; a caller that only implied one (a default, a
    // budget of its own) gets the rung that budget was reaching for.
    applyAdaptiveThinking(request, requestedRung(chat) || rungForBudget(budget));
    request.max_tokens = Math.max(request.max_tokens, MIN_THINKING_MAX_TOKENS);
  } else if (budget) {
    request.thinking = { type: "enabled", budget_tokens: budget };
    request.max_tokens = Math.max(request.max_tokens, budget + THINKING_ANSWER_HEADROOM_TOKENS);
    // Extended thinking rejects sampling overrides and forced tool choices.
    delete request.temperature;
    delete request.top_p;
    if (request.tool_choice && request.tool_choice.type !== "auto" && request.tool_choice.type !== "none") {
      request.tool_choice = { type: "auto" };
    }
  }
  return { ok: true, request };
}

const MAX_CACHE_BREAKPOINTS = 4;

function applyCacheBreakpoints(request) {
  const existing = cacheBreakpointBlocks(request);
  const system = contentBlocks(request.system);
  const identity = system?.find((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim());
  let changed = false;
  const identityCovered = system?.some((block) => block !== identity && block?.cache_control);
  if (hasAgentIdentity(identity?.text) && !identity.cache_control && !identityCovered && existing.length < MAX_CACHE_BREAKPOINTS) {
    identity.cache_control = { type: "ephemeral", ...(existing.some((block) => block.cache_control.ttl === "1h") ? { ttl: "1h" } : {}) };
    request.system = system;
    changed = true;
  }
  // Anthropic accepts a bare string for `system` and for message content, but a breakpoint
  // has to hang off a block. The rewrite runs over every message rather than only the ones
  // being marked, so a turn does not flip shape as the breakpoints roll past it — that
  // would change the prefix and cost the cache it was meant to keep. It runs whether or not
  // the caller sent breakpoints of its own: the upstream only ever sees this rewritten form,
  // so one consistent shape is what every turn of the conversation is cached against.
  if (system) {
    changed ||= system !== request.system;
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
  // The caller's own breakpoints stay exactly where it put them; the slots it left spare go
  // on the static prefix and the most recent unmarked user turns. A caller that marks only
  // its newest turn leaves the whole history unread on an upstream that does no lookback of
  // its own — the previous turn's breakpoint is the one this request can still read.
  let room = MAX_CACHE_BREAKPOINTS - cacheBreakpointBlocks(request).length;
  if (room > 0 && system && markCacheBreakpoint(system)) {
    room -= 1;
    changed = true;
  }
  for (let index = userTurns.length - 1; index >= 0 && room > 0; index -= 1) {
    if (markCacheBreakpoint(userTurns[index].content)) {
      room -= 1;
      changed = true;
    }
  }
  return changed;
}

// A non-empty block array, or the equivalent array for the string shorthand. Anything
// else (empty, absent, malformed) cannot carry a breakpoint and is left alone.
function contentBlocks(value) {
  if (typeof value === "string") return value ? [{ type: "text", text: value }] : null;
  return Array.isArray(value) && value.length ? value : null;
}

// A breakpoint caches everything up to and including the block it sits on, so it goes on
// the last one. A malformed body can end on something that is not a block; marking it
// would throw rather than relay, and the relay rejects the request either way. A block the
// caller already marked keeps its marker — its TTL may be deliberate.
function markCacheBreakpoint(blocks) {
  const last = blocks.at(-1);
  if (!last || typeof last !== "object" || last.cache_control) return false;
  last.cache_control = { type: "ephemeral" };
  return true;
}

function cacheBreakpointBlocks(request) {
  const blocks = [
    request,
    ...(Array.isArray(request.tools) ? request.tools : []),
    ...(Array.isArray(request.system) ? request.system : []),
    ...(Array.isArray(request.messages) ? request.messages : [])
      .flatMap((message) => Array.isArray(message?.content) ? message.content : [])
  ];
  return blocks.filter((block) => block?.cache_control);
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
      ...(tool.cache_control || fn.cache_control ? { cache_control: tool.cache_control || fn.cache_control } : {}),
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

// The relay can refuse a Claude request with a 200 whose first event is an `error`. Forwarded
// as it stands, a translated stream has already opened by the time it reads that, and the caller
// is left with an empty answer instead of the refusal. So the stream is held until its first
// event: a refusal becomes a failed attempt, anything else is replayed byte for byte. A healthy
// stream opens with message_start as soon as it is accepted, so this waits on no generated
// content — that may come later than the header deadline and is held to the idle timeout.
// An invalid_request_error is the request's own answer and is not retried, the way the GPT path
// treats one: "Third-party apps now draw from extra usage, not plan limits." came back the same
// from every account it was sent to. Anything else may be one account's trouble and fails over.
async function gateAnthropicRefusal(upstream, deadline, skipMetadata = false) {
  if (!upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream")) return upstream;
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const held = [];
  let text = "";
  let pending = null;
  let ended = false;
  let timer;
  const elapsed = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), null); });
  try {
    while (true) {
      pending ||= reader.read();
      const result = await Promise.race([pending, elapsed]);
      if (!result) break;
      pending = null;
      if (result.done) {
        ended = true;
        break;
      }
      held.push(result.value);
      text += decoder.decode(result.value, { stream: true });
      const event = firstAnthropicEvent(text, skipMetadata);
      if (event?.type === "error") {
        if (skipMetadata && isPermanentRequestError(event.error)) break;
        throw Object.assign(new Error(typeof event.error?.message === "string" && event.error.message
          ? event.error.message : "The upstream Anthropic stream reported an error."), {
          code: "upstream_stream_error",
          upstreamError: event.error,
          statusCode: isPermanentRequestError(event.error) ? 400 : undefined
        });
      }
      if (event || Buffer.byteLength(text) > MAX_SSE_FRAME_BYTES) break;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of held) controller.enqueue(chunk);
      if (ended) controller.close();
    },
    async pull(controller) {
      try {
        const result = await (pending || reader.read());
        pending = null;
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    }
  });
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, { status: upstream.status, headers });
}

// The first complete event that is not a heartbeat; anything unreadable counts as one, and is
// left to the handler to judge.
function firstAnthropicEvent(text, skipMetadata = false) {
  const frames = text.split(/\r?\n\r?\n/);
  frames.pop();
  for (const frame of frames) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    let event;
    try { event = JSON.parse(data); } catch { return { type: "unreadable" }; }
    if (event?.type === "ping") continue;
    if (skipMetadata && (event?.type === "message_start" || (event?.type === "content_block_start" && event.content_block?.type === "text" && !event.content_block.text))) continue;
    return event;
  }
  return null;
}

async function anthropicUpstreamAsChat(upstream, chat, replay = null) {
  const contentType = upstream.headers?.get?.("content-type") || "";
  if (upstream.ok && contentType.includes("text/event-stream")) {
    const source = Readable.fromWeb(upstream.body);
    const transformed = pipeWithCancellation(source, createAnthropicChatStreamTransform(chat, replay));
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
  return { error: { message, type, param: null, code: payload?.error?.code ?? null } };
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
  const decoder = new TextDecoder();
  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop();
        for (const frame of frames) {
          const events = chatChunksForAnthropicFrame(frame, state);
          if (events) this.push(events);
        }
        callback();
      } catch (error) { callback(error); }
    },
    flush(callback) {
      try {
        buffer += decoder.decode();
        const events = buffer ? chatChunksForAnthropicFrame(buffer, state) : "";
        if (events) this.push(events);
        if (!state.done && !state.stopReason) throw Object.assign(new Error("The upstream Anthropic stream ended before it completed."), { code: "upstream_stream_incomplete" });
        callback(null, finishChatStream(state));
      } catch (error) { callback(error); }
    }
  });
}

function chatChunksForAnthropicFrame(frame, state) {
  if (state.done) return "";
  const data = frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return "";
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    throw Object.assign(new Error("The upstream Anthropic stream contains invalid JSON."), { code: "upstream_invalid_stream" });
  }
  switch (event.type) {
    case "message_start": {
      if (typeof event.message?.id === "string" && event.message.id) state.id = chatCompletionId(event.message.id);
      if (typeof event.message?.model === "string" && event.message.model) state.model = event.message.model;
      if (event.message?.usage && typeof event.message.usage === "object") mergeAnthropicUsage(state, event.message.usage);
      return startChatStream(state);
    }
    case "content_block_start": {
      if (event.content_block?.type === "text" && typeof event.content_block.text === "string") {
        return startChatStream(state) + (event.content_block.text ? chatChunk(state, { content: event.content_block.text }) : "");
      }
      // The signed thinking of this turn is kept so the next request can replay it; the
      // OpenAI protocols drop the signature, and Anthropic rejects the turn without it.
      if (event.content_block?.type === "thinking") {
        const block = { type: "thinking", thinking: typeof event.content_block.thinking === "string" ? event.content_block.thinking : "", signature: event.content_block.signature || "" };
        state.thinkingBlocks.push(block);
        state.thinkingByBlock.set(event.index, block);
        return startChatStream(state) + (block.thinking ? chatChunk(state, { reasoning_content: block.thinking }) : "");
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
      return `data: ${JSON.stringify(anthropicErrorToOpenAi(event, event.error?.type === "invalid_request_error" ? 400 : 502))}\n\ndata: [DONE]\n\n`;
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

// DeepSeek and Kimi are served on chat completions and nothing else — the official client's
// wire table lists no second format for either — so an Anthropic-shaped request for one of
// their models cannot be forwarded as it arrived. It is rewritten here instead, the way the
// official client's own bridge rewrites it: the same message folding, the same tool shapes,
// and the same fields left behind. `thinking`, `metadata` and the cache breakpoints have no
// chat-completions form to be carried in, and a field the relay does not expect is answered
// with the same bare 400 as the wrong endpoint.
function anthropicToChatRequest(value, passthrough = true) {
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!model) return { ok: false, message: "A message model is required." };
  const messages = [];
  const system = anthropicBlockText(value.system);
  if (system) messages.push({ role: "system", content: system });
  const history = Array.isArray(value.messages) ? value.messages : [];
  const lastUserIndex = history.findLastIndex((message) => message?.role === "user");
  const availableTools = new Set((value.tools || []).filter((tool) => !tool.defer_loading).map((tool) => tool.name));
  let outputConfig = value.output_config;
  for (const [index, message] of history.entries()) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system") {
      if (message.clear_at === "next_user_message" && index < lastUserIndex) continue;
      const content = anthropicBlockText(message.content);
      if (content) messages.push({ role: "system", content });
      if (message.output_config) outputConfig = { ...outputConfig, ...message.output_config };
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === "tool_addition") availableTools.add(block.tool.name);
        if (block.type === "tool_removal") availableTools.delete(block.tool.name);
      }
      continue;
    }
    if (typeof message.content === "string") {
      if (message.content) messages.push({ role: message.role === "assistant" ? "assistant" : "user", content: message.content });
    } else if (Array.isArray(message.content)) {
      if (message.role === "assistant") appendChatAssistantMessage(messages, message.content);
      else appendChatUserMessages(messages, message.content);
    }
  }
  if (!messages.some((message) => message.role !== "system")) {
    return { ok: false, message: "At least one user or assistant message is required." };
  }
  const request = { model, messages };
  if (passthrough || relayAgentFor(model) === "dsh") copyChatReasoning({ ...value, output_config: outputConfig }, request);
  if (Number.isFinite(value.max_tokens)) request.max_tokens = value.max_tokens;
  if (Number.isFinite(value.temperature)) request.temperature = value.temperature;
  if (Number.isFinite(value.top_p)) request.top_p = value.top_p;
  const stop = Array.isArray(value.stop_sequences) ? value.stop_sequences.filter((entry) => typeof entry === "string" && entry) : [];
  if (stop.length) request.stop = stop;
  const tools = chatToolsFromAnthropic(value.tools).filter((tool) => availableTools.has(tool.function.name));
  if (tools.length) request.tools = tools;
  const toolChoice = chatToolChoiceFromAnthropic(value.tool_choice);
  if (toolChoice?.type === "function" && !tools.some((tool) => tool.function.name === toolChoice.function.name)) return { ok: false, message: "tool_choice: the selected tool is not available in this turn." };
  if (toolChoice === "required" && !tools.length) return { ok: false, message: "tool_choice: no tools are available in this turn." };
  if (toolChoice && tools.length) request.tool_choice = toolChoice;
  if (typeof value.tool_choice?.disable_parallel_tool_use === "boolean") request.parallel_tool_calls = !value.tool_choice.disable_parallel_tool_use;
  if (value.stream === true) {
    request.stream = true;
    // Asked for on the way out rather than left to prepareRelayBody, because this stream is
    // read by a transform of this gateway's own and the counts are what it reports back.
    request.stream_options = { include_usage: true };
  }
  return { ok: true, request };
}

// Text out of whatever shape it arrived in: a bare string, a block array, or one of the
// blocks. Only text blocks have anything to contribute.
function anthropicBlockText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => typeof block === "string" ? block : block?.type === "text" && typeof block.text === "string" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

function appendChatAssistantMessage(messages, blocks) {
  const text = [];
  const reasoning = [];
  const toolCalls = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "thinking" && typeof block.thinking === "string") reasoning.push(block.thinking);
    else if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: typeof block.id === "string" && block.id ? block.id : `call_${randomUUID().replace(/-/g, "")}`,
        type: "function",
        function: { name: typeof block.name === "string" ? block.name : "", arguments: JSON.stringify(block.input ?? {}) }
      });
    }
  }
  const content = text.filter(Boolean).join("\n");
  if (!content && toolCalls.length === 0 && reasoning.length === 0) return;
  const message = { role: "assistant", content: content || null };
  if (reasoning.length) message.reasoning_content = reasoning.join("");
  if (toolCalls.length) message.tool_calls = toolCalls;
  messages.push(message);
}

// One Anthropic user turn is two things at once: the results of the tools the last turn
// called, which chat completions spells as its own `tool` messages ahead of the turn, and
// whatever the user themself sent.
function appendChatUserMessages(messages, blocks) {
  const toolResults = [];
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      parts.push(chatImagePart(block.source) || omittedAttachment(block));
    } else if (block.type === "document") {
      parts.push(omittedAttachment(block));
    } else if (block.type === "tool_result") {
      const images = toolResultImages(block);
      const text = anthropicBlockText(block.content) || (images.length ? TOOL_RESULT_IMAGE_NOTE : "");
      toolResults.push({
        role: "tool",
        ...(typeof block.tool_use_id === "string" && block.tool_use_id ? { tool_call_id: block.tool_use_id } : {}),
        content: text
      });
      // An image cannot travel inside a tool message, so it follows as part of the user turn.
      parts.push(...images);
    }
  }
  messages.push(...toolResults);
  if (!parts.length) return;
  if (parts.every((part) => part.type === "text")) {
    // Nothing but empty text is nothing at all, and an empty turn is one more thing for the
    // upstream to refuse.
    const text = parts.map((part) => part.text).filter(Boolean).join("\n");
    if (text) messages.push({ role: "user", content: text });
    return;
  }
  messages.push({ role: "user", content: parts });
}

const TOOL_RESULT_IMAGE_NOTE = "(see attached image)";

function toolResultImages(block) {
  if (!Array.isArray(block.content)) return [];
  const images = block.content
    .filter((entry) => entry?.type === "image")
    .map((entry) => chatImagePart(entry.source))
    .filter(Boolean);
  if (!images.length) return [];
  const label = typeof block.tool_use_id === "string" && block.tool_use_id ? ` ${block.tool_use_id}` : "";
  return [{ type: "text", text: `Attached image(s) from tool result${label}:` }, ...images];
}

function chatImagePart(source) {
  if (!source || typeof source !== "object") return null;
  if (source.type === "base64" && typeof source.data === "string" && source.data) {
    const mediaType = typeof source.media_type === "string" && source.media_type ? source.media_type : "image/png";
    return { type: "image_url", image_url: { url: `data:${mediaType};base64,${source.data}` } };
  }
  if (source.type === "url" && typeof source.url === "string" && source.url) {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

// Named rather than dropped: the model can see that something was attached and say so, which
// beats answering as though the turn never carried it.
function omittedAttachment(block) {
  const source = block.source && typeof block.source === "object" ? block.source : {};
  const label = [block.title, source.file_id, source.media_type, block.type]
    .find((value) => typeof value === "string" && value) || "attachment";
  return { type: "text", text: `[attachment ${label} omitted: no chat-completions equivalent]` };
}

// A server tool is Anthropic's own to run: it arrives as a type with no schema, and neither
// this upstream nor the client can execute it. Offering it would only invite a call that dies.
const ANTHROPIC_SERVER_TOOL = /^(?:web_search|web_fetch|code_execution|mcp_toolset|tool_search_tool_|advisor)/;

function chatToolsFromAnthropic(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    if (typeof tool.type === "string" && ANTHROPIC_SERVER_TOOL.test(tool.type) && !tool.input_schema) return [];
    if (typeof tool.name !== "string" || !tool.name.trim()) return [];
    return [{
      type: "function",
      function: {
        name: tool.name.trim(),
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: tool.input_schema && typeof tool.input_schema === "object" ? tool.input_schema : { type: "object", properties: {} }
      }
    }];
  });
}

function chatToolChoiceFromAnthropic(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return null;
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "none") return "none";
  if (toolChoice.type === "tool" && typeof toolChoice.name === "string" && toolChoice.name) {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return "auto";
}

// The answer on the way back, mirroring anthropicUpstreamAsChat: a streamed body is rewritten
// frame by frame, anything else is read once and converted whole.
async function chatUpstreamAsAnthropic(upstream, model, stream, limits = {}) {
  if (stream) upstream = await ensureChatCompletionStream(upstream);
  const contentType = upstream.headers?.get?.("content-type") || "";
  if (upstream.ok && contentType.includes("text/event-stream")) {
    if (!stream) {
      try {
        const converted = chatCompletionToAnthropicMessage(await readChatCompletion(upstream, limits), model);
        return new Response(JSON.stringify(converted), { status: upstream.status, headers: { "content-type": "application/json" } });
      } catch (error) {
        return new Response(JSON.stringify(openAiErrorToAnthropic({ error: { message: error.message } }, 502)), { status: 502, headers: { "content-type": "application/json" } });
      }
    }
    const source = Readable.fromWeb(upstream.body);
    const transformed = pipeWithCancellation(source, createChatAnthropicStreamTransform(model, limits));
    return endMessageStream(new Response(Readable.toWeb(transformed), {
      status: upstream.status,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" }
    }));
  }
  const raw = upstream.body ? await upstream.text().catch(() => "") : "";
  let payload = null;
  try { payload = JSON.parse(raw); } catch {}
  const converted = upstream.ok ? chatCompletionToAnthropicMessage(payload, model) : openAiErrorToAnthropic(payload, upstream.status);
  if (!converted) {
    return new Response(raw || null, { status: upstream.status, headers: { "content-type": contentType || "application/json" } });
  }
  return new Response(JSON.stringify(converted), { status: upstream.status, headers: { "content-type": "application/json" } });
}

function chatCompletionToAnthropicMessage(completion, model) {
  if (!completion || !Array.isArray(completion.choices)) return null;
  const choice = completion.choices[0] || {};
  const message = choice.message && typeof choice.message === "object" ? choice.message : {};
  const content = [];
  const inline = splitThinkTags(message.content);
  const reasoning = [message.reasoning_content, inline.thinking].filter((part) => typeof part === "string" && part).join("");
  if (reasoning) content.push({ type: "thinking", thinking: reasoning });
  if (inline.text) content.push({ type: "text", text: inline.text });
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of toolCalls) {
    if (!call || typeof call !== "object") continue;
    content.push({
      type: "tool_use",
      id: typeof call.id === "string" && call.id ? call.id : `toolu_${randomUUID().replace(/-/g, "")}`,
      name: typeof call.function?.name === "string" ? call.function.name : "",
      input: toolCallInput(call.function?.arguments)
    });
  }
  // A message has to come back with at least one block, so a turn that produced nothing at
  // all comes back as one that produced an empty answer rather than as a malformed message.
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    id: messageId(completion.id),
    type: "message",
    role: "assistant",
    // The id the client asked for, not the one that went upstream: an alias is this gateway's
    // business, and the client is entitled to see back the name it sent.
    model,
    content,
    ...(Array.isArray(message.annotations) && message.annotations.length && inline.text === message.content ? { mirasim_annotations: message.annotations } : {}),
    stop_reason: toolCalls.length ? "tool_use" : anthropicStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: anthropicUsageFromChat(completion.usage)
  };
}

function toolCallInput(value) {
  if (typeof value !== "string" || !value.trim()) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The upstream tool arguments must be a JSON object.");
  return parsed;
}

// OpenAI counts cached tokens inside prompt_tokens while Anthropic reports them beside
// input_tokens, so the cached ones come back out for the totals to add up.
function anthropicUsageFromChat(usage) {
  const promptTokens = Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : 0;
  const cachedTokens = Number.isFinite(usage?.prompt_tokens_details?.cached_tokens) ? usage.prompt_tokens_details.cached_tokens : 0;
  const cacheRead = Math.min(Math.max(0, cachedTokens), promptTokens);
  return {
    input_tokens: promptTokens - cacheRead,
    output_tokens: Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : 0,
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {})
  };
}

function anthropicStopReason(finishReason) {
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "tool_calls") return "tool_use";
  return "end_turn";
}

function openAiErrorToAnthropic(payload, status) {
  const message = typeof payload?.error?.message === "string" && payload.error.message ? payload.error.message
    : typeof payload?.message === "string" && payload.message ? payload.message
    : `The upstream chat request failed with HTTP ${status}.`;
  const type = status === 401 ? "authentication_error" : status === 403 ? "permission_error" :
    status === 404 ? "not_found_error" : status === 429 ? "rate_limit_error" :
    status >= 500 ? "api_error" : "invalid_request_error";
  return { type: "error", error: { type, message } };
}

function createChatAnthropicStreamTransform(model, { maxBytes = MAX_RESPONSE_BYTES, maxFrameBytes = MAX_SSE_FRAME_BYTES } = {}) {
  const state = {
    model,
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    started: false,
    done: false,
    nextIndex: 0,
    openBlock: null,
    wroteBlock: false,
    toolSlots: [],
    toolSlotByIndex: new Map(),
    activeTool: null,
    pendingText: [],
    annotations: new Map(),
    citationInputLength: 0,
    citationOutputLength: 0,
    finishReason: null,
    usage: null,
    thinkFilter: new ThinkTagFilter()
  };
  let buffer = "";
  const decoder = new TextDecoder();
  let bytes = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      if (state.done) return callback();
      try {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) throw new Error("The upstream tool stream exceeds the aggregate size limit.");
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop();
        if ([buffer, ...frames].some((frame) => Buffer.byteLength(frame) > maxFrameBytes)) throw new Error("The upstream SSE frame exceeds the size limit.");
        for (const frame of frames) {
          const events = anthropicEventsForChatFrame(frame, state);
          if (events) this.push(events);
        }
        if (state.done) this.push(null);
        callback();
      } catch (error) {
        state.done = true;
        this.push(anthropicSse("error", { error: { type: "api_error", message: error.message } }));
        this.push(null);
        callback();
      }
    },
    flush(callback) {
      buffer += decoder.decode();
      try {
        let events = buffer ? anthropicEventsForChatFrame(buffer, state) : "";
        events += finishAnthropicStream(state);
        callback(null, events);
      } catch (error) {
        state.done = true;
        callback(null, anthropicSse("error", { error: { type: "api_error", message: error.message } }));
      }
    }
  });
}

function anthropicEventsForChatFrame(frame, state) {
  // Nothing follows message_stop. An upstream that keeps talking past its own end of stream
  // must not reopen a block on a message the client has already been told is finished.
  if (state.done) return "";
  const data = frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return frame.split(/\r?\n/).some((line) => line.startsWith(":")) ? startAnthropicStream(state) + anthropicSse("ping") : "";
  if (data === "[DONE]") return finishAnthropicStream(state);
  let chunk;
  chunk = JSON.parse(data);
  if (chunk.error) {
    state.done = true;
    return anthropicSse("error", { error: openAiErrorToAnthropic(chunk, 502).error });
  }
  let events = startAnthropicStream(state);
  if (chunk.usage && typeof chunk.usage === "object") state.usage = chunk.usage;
  // The frame the gateway asked for with stream_options carries usage and no choice at all.
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (!choice) return events;
  if (typeof choice.finish_reason === "string" && choice.finish_reason) state.finishReason = choice.finish_reason;
  const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};
  if (typeof delta.content === "string") state.citationInputLength += delta.content.length;
  for (const annotation of Array.isArray(delta.annotations) ? delta.annotations : []) state.annotations.set(JSON.stringify(annotation), annotation);
  if (state.activeTool && (delta.reasoning_content || delta.content)) {
    state.pendingText.push({ reasoning: delta.reasoning_content, text: delta.content });
  }
  if (!state.activeTool && typeof delta.reasoning_content === "string" && delta.reasoning_content) {
    events += openAnthropicTextBlock(state, "thinking");
    events += anthropicSse("content_block_delta", { index: state.openBlock.index, delta: { type: "thinking_delta", thinking: delta.reasoning_content } });
  }
  // A DeepSeek upstream that inlines its reasoning in <think>…</think> instead of a
  // reasoning_content field gets the same split, or the whole thought lands in the answer.
  if (!state.activeTool && typeof delta.content === "string" && delta.content) {
    for (const piece of state.thinkFilter.push(delta.content)) events += anthropicTextPiece(state, piece);
  }
  for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    if (!call || typeof call !== "object") continue;
    const slot = anthropicToolSlot(state, call);
    if (typeof call.function?.arguments === "string") slot.arguments += call.function.arguments;
    if (!state.activeTool && slot === state.toolSlots[0] && slot.idFromUpstream && slot.name && slot.arguments) {
      if (state.openBlock) {
        events += anthropicSse("content_block_stop", { index: state.openBlock.index });
        state.openBlock = null;
      }
      state.activeTool = slot;
      slot.blockIndex = state.nextIndex++;
      slot.sentName = slot.name;
      slot.sentArguments = 0;
      events += anthropicSse("content_block_start", { index: slot.blockIndex, content_block: { type: "tool_use", id: slot.id, name: slot.name, input: {} } });
    }
    if (state.activeTool === slot) {
      if (slot.name !== slot.sentName) throw new Error("The upstream changed a tool name after its argument stream started.");
      const partial = slot.arguments.slice(slot.sentArguments);
      if (partial) events += anthropicSse("content_block_delta", { index: slot.blockIndex, delta: { type: "input_json_delta", partial_json: partial } });
      slot.sentArguments = slot.arguments.length;
    }
  }
  return events;
}

function anthropicSse(type, data = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function startAnthropicStream(state) {
  if (state.started) return "";
  state.started = true;
  return anthropicSse("message_start", {
    message: {
      id: state.id,
      type: "message",
      role: "assistant",
      model: state.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });
}

function openAnthropicTextBlock(state, type = "text") {
  if (state.openBlock?.type === type) return "";
  let events = state.openBlock ? anthropicSse("content_block_stop", { index: state.openBlock.index }) : "";
  state.openBlock = { index: state.nextIndex++, type };
  state.wroteBlock = true;
  const contentBlock = type === "thinking" ? { type, thinking: "" } : { type, text: "" };
  return events + anthropicSse("content_block_start", { index: state.openBlock.index, content_block: contentBlock });
}

// One piece of split content — reasoning or visible text — as its block and delta.
function anthropicTextPiece(state, piece) {
  if (piece.type !== "thinking") state.citationOutputLength += piece.text.length;
  return openAnthropicTextBlock(state, piece.type)
    + anthropicSse("content_block_delta", {
      index: state.openBlock.index,
      delta: piece.type === "thinking" ? { type: "thinking_delta", thinking: piece.text } : { type: "text_delta", text: piece.text }
    });
}

// A streamed tool call is identified by its index where the upstream sends one, by its id
// where it does not, and by whichever call is still open where it sends neither. An index that
// comes back carrying a different id is a second call reusing the slot, not more of the first.
function anthropicToolSlot(state, call) {
  const id = typeof call.id === "string" && call.id ? call.id : null;
  const index = Number.isFinite(call.index) ? call.index : null;
  let slot = null;
  if (index !== null) {
    slot = state.toolSlotByIndex.get(index) || null;
    if (slot && id && slot.idFromUpstream && slot.id !== id) slot = null;
    if (!slot) {
      slot = openAnthropicToolSlot(state, id);
      state.toolSlotByIndex.set(index, slot);
    }
  } else if (id) {
    slot = state.toolSlots.find((entry) => entry.id === id) || openAnthropicToolSlot(state, id);
  } else {
    slot = state.toolSlots.at(-1) || openAnthropicToolSlot(state, null);
  }
  if (id && !slot.idFromUpstream) {
    slot.id = id;
    slot.idFromUpstream = true;
  }
  // The name arrives in pieces from some upstreams and whole from others, so a name that
  // repeats what is already there replaces it rather than being appended to it.
  const name = call.function?.name;
  if (typeof name === "string" && name) {
    slot.name = !slot.name || name.startsWith(slot.name) ? name : slot.name + name;
  }
  return slot;
}

function openAnthropicToolSlot(state, id) {
  const slot = { id: id || `toolu_${randomUUID().replace(/-/g, "")}`, idFromUpstream: id !== null, name: "", arguments: "" };
  state.toolSlots.push(slot);
  return slot;
}

function finishAnthropicStream(state) {
  if (state.done) return "";
  if (!state.finishReason) throw new Error("The upstream chat stream ended without a finish reason.");
  for (const slot of state.toolSlots) {
    if (!slot.name || !slot.idFromUpstream) throw new Error("The upstream tool call is missing its name or call ID.");
    const input = JSON.parse(slot.arguments.trim() || "{}");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("The upstream tool arguments must be a JSON object.");
  }
  state.done = true;
  let events = startAnthropicStream(state);
  if (state.openBlock) {
    events += anthropicSse("content_block_stop", { index: state.openBlock.index });
    state.openBlock = null;
  }
  for (const slot of state.toolSlots) {
    const index = slot.blockIndex ?? state.nextIndex++;
    if (slot.blockIndex === undefined) {
      events += anthropicSse("content_block_start", { index, content_block: { type: "tool_use", id: slot.id, name: slot.name, input: {} } });
      events += anthropicSse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: slot.arguments.trim() ? slot.arguments : "{}" } });
    }
    events += anthropicSse("content_block_stop", { index });
  }
  // Text held back while a tool call streamed rejoins here, through the same tag split as the
  // live flow, and whatever the filter still cannot decide settles at the end of the stream.
  for (const part of state.pendingText) {
    if (part.reasoning) events += anthropicTextPiece(state, { type: "thinking", text: part.reasoning });
    if (part.text) for (const piece of state.thinkFilter.push(part.text)) events += anthropicTextPiece(state, piece);
  }
  for (const piece of state.thinkFilter.end()) events += anthropicTextPiece(state, piece);
  // Every message carries at least one block, so a turn that produced neither text nor a tool
  // call still comes back as one that produced an empty answer.
  if (!state.wroteBlock && state.toolSlots.length === 0) {
    const index = state.nextIndex++;
    events += anthropicSse("content_block_start", { index, content_block: { type: "text", text: "" } });
    events += anthropicSse("content_block_stop", { index });
  }
  if (state.openBlock) {
    events += anthropicSse("content_block_stop", { index: state.openBlock.index });
    state.openBlock = null;
  }
  const stopReason = state.toolSlots.length ? "tool_use" : anthropicStopReason(state.finishReason);
  const citations = state.annotations.size && state.citationInputLength === state.citationOutputLength ? { mirasim_annotations: [...state.annotations.values()] } : {};
  events += anthropicSse("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null, ...citations }, usage: anthropicUsageFromChat(state.usage) });
  return events + anthropicSse("message_stop");
}

// The Responses translation carries fields that only ever meant something to this gateway's
// own Anthropic conversion — `reasoning`, `thinking`, a `seed` the relay refuses — and an
// unexpected field is answered with the same bare 400 as the wrong endpoint. Only the
// chat-completions fields survive the trip.
const CHAT_UPSTREAM_FIELDS = ["temperature", "top_p", "max_tokens", "stop", "tools", "tool_choice", "parallel_tool_calls", "response_format"];

function chatUpstreamRequest(chat, passthrough = true) {
  const request = { model: typeof chat.model === "string" ? chat.model.trim() : "", messages: chat.messages };
  if (passthrough || relayAgentFor(chat.model) === "dsh") copyChatReasoning(chat, request);
  for (const field of CHAT_UPSTREAM_FIELDS) {
    if (chat[field] !== undefined) request[field] = chat[field];
  }
  if (chat.stream === true) {
    request.stream = true;
    request.stream_options = { include_usage: true };
  }
  return request;
}

function isDisabledEffort(effort) {
  return typeof effort === "string" && ["none", "off"].includes(effort.trim().toLowerCase());
}

function explicitReasoningEffort(value) {
  if (value.thinking?.type === "disabled" || value.thinking?.enabled === false) return "none";
  const effort = value.reasoning_effort ?? value.reasoning?.effort ?? value.output_config?.effort ?? value.thinking?.effort;
  if (effort !== undefined) return effort;
  if (value.thinking?.type === "enabled" && Number.isFinite(value.thinking.budget_tokens)) return rungForBudget(value.thinking.budget_tokens);
  return undefined;
}

function copyChatReasoning(source, target) {
  const effort = explicitReasoningEffort(source);
  if (effort !== undefined) target.reasoning_effort = normalizeRung(effort) || effort;
  if (source.thinking !== undefined) {
    target.thinking = source.thinking;
    if (relayAgentFor(target.model) === "dsh") {
      target.thinking = { type: isDisabledEffort(effort) ? "disabled" : "enabled" };
    } else if (source.thinking?.type === "adaptive") {
      const { display, ...thinking } = source.thinking;
      target.thinking = { ...thinking, type: isDisabledEffort(effort) ? "disabled" : "enabled" };
    }
  }
}

async function forwardChatResponse(response, upstream, stream, limits = {}) {
  if (stream) upstream = await ensureChatCompletionStream(upstream);
  if (stream || !upstream.ok || !upstream.headers?.get?.("content-type")?.includes("text/event-stream")) return forwardResponse(response, upstream);
  return readChatCompletion(upstream, limits)
    .then((body) => sendJson(response, upstream.status, body))
    .catch((error) => sendError(response, 502, error.message));
}

async function sendLocalCodexTitle(response, request, path) {
  const completion = localCodexTitleCompletion(request);
  if (!completion) return false;
  response.setHeader("x-mirasim-local-response", "codex-title");
  const upstream = Response.json(completion);
  if (path === "/v1/messages") {
    await forwardResponse(response, await chatUpstreamAsAnthropic(upstream, request.model, request.stream === true));
  } else if (path === "/v1/chat/completions") {
    await forwardChatResponse(response, upstream, request.stream === true);
  } else if (request.stream === true) {
    await forwardResponsesStream(response, upstream, request);
  } else {
    await forwardResponsesResponse(response, upstream, request);
  }
  return true;
}

function forwardResponsesResponse(response, upstream, request) {
  if (!upstream.ok || !upstream.body) return forwardResponse(response, upstream);
  return readChatCompletion(upstream)
    .then((body) => sendJson(response, upstream.status, chatCompletionToResponse(body, request)))
    .catch(() => sendError(response, 502, "The upstream chat completion could not be converted to a response."));
}

function chatAnnotationsToResponses(annotations, text) {
  const result = new Map();
  for (const annotation of Array.isArray(annotations) ? annotations : []) {
    const citation = annotation?.url_citation;
    if (annotation?.type !== "url_citation" || typeof citation?.url !== "string" || !Number.isInteger(citation.start_index) || !Number.isInteger(citation.end_index) || citation.start_index < 0 || citation.end_index <= citation.start_index || citation.end_index > text.length) continue;
    let url;
    try { url = new URL(citation.url); } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol)) continue;
    const value = { type: "url_citation", url: citation.url, title: typeof citation.title === "string" ? citation.title : url.hostname, start_index: citation.start_index, end_index: citation.end_index };
    result.set(JSON.stringify(value), value);
  }
  return [...result.values()];
}

function chatCompletionToResponse(completion, request) {
  const choice = completion?.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  const inline = splitThinkTags(message.content);
  const reasoning = [message.reasoning_content, inline.thinking].filter((part) => typeof part === "string" && part).join("");
  if (reasoning) {
    output.push({
      type: "reasoning",
      id: `rs_${randomUUID().replace(/-/g, "")}`,
      summary: [{ type: "summary_text", text: reasoning }]
    });
  }
  if (inline.text) {
    output.push({
      type: "message",
      id: messageId(completion?.id),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: inline.text, annotations: inline.text === message.content ? chatAnnotationsToResponses(message.annotations, inline.text) : [] }]
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
    text: request.text || { format: { type: "text" } },
    tool_choice: request.tool_choice || "auto",
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: Number.isFinite(request.top_p) ? request.top_p : 1,
    usage: responsesUsage(usage)
  };
}

async function forwardResponsesStream(response, upstream, request) {
  if (!upstream.ok || !upstream.body) return forwardResponse(response, upstream);
  upstream = await ensureChatCompletionStream(upstream);
  const state = {
    request,
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
    toolCalls: new Map(),
    thinkFilter: new ThinkTagFilter()
  };
  response.writeHead(upstream.status, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no"
  });
  response.socket?.setNoDelay?.(true);
  response.flushHeaders?.();
  const source = Readable.fromWeb(upstream.body);
  const transformed = pipeWithCancellation(source, createResponsesStreamTransform(state));
  const abortOnClose = () => {
    if (!response.writableEnded) source.destroy();
  };
  response.once("close", abortOnClose);
  transformed.on("error", () => response.destroy());
  transformed.on("end", () => response.off("close", abortOnClose));
  withHeartbeat(response, transformed, true).pipe(response);
}

function createResponsesStreamTransform(state) {
  let buffer = "";
  const decoder = new TextDecoder();
  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop();
      for (const frame of frames) {
        const events = responsesEventsForChatFrame(frame, state);
        if (events) this.push(events);
      }
      callback();
    },
    flush(callback) {
      buffer += decoder.decode();
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
  if (!data || state.completed) return "";
  if (data === "[DONE]") return completeResponsesStream(state);
  let chunk;
  try {
    chunk = JSON.parse(data);
  } catch {
    return "";
  }
  if (chunk?.error) return failResponsesStream(state, chunk.error);
  let events = startResponsesStream(state, chunk.model);
  const choice = chunk.choices?.[0];
  state.citationAnnotations ||= new Map();
  for (const annotation of Array.isArray(choice?.delta?.annotations) ? choice.delta.annotations : []) state.citationAnnotations.set(JSON.stringify(annotation), annotation);
  const reasoning = choice?.delta?.reasoning_content;
  if (typeof reasoning === "string" && reasoning) events += responsesReasoningDelta(state, reasoning);
  const text = choice?.delta?.content;
  state.citationTextLength = (state.citationTextLength || 0) + (typeof text === "string" ? text.length : 0);
  // Reasoning inlined as <think>…</think> — the shape some DeepSeek upstreams answer with —
  // joins the same reasoning item rather than the visible message.
  if (typeof text === "string" && text) {
    for (const piece of state.thinkFilter.push(text)) {
      events += piece.type === "thinking" ? responsesReasoningDelta(state, piece.text) : responsesTextDelta(state, piece.text);
    }
  }
  for (const call of Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : []) {
    events += responsesToolCallEvents(state, call);
  }
  if (chunk.usage && typeof chunk.usage === "object") state.usage = chunk.usage;
  if (choice?.finish_reason) state.finishReason = choice.finish_reason;
  return events;
}

function responsesReasoningDelta(state, reasoning) {
  let events = "";
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
  return events + responsesSse(state, "response.reasoning_summary_text.delta", {
    item_id: state.reasoning.id,
    output_index: state.reasoning.outputIndex,
    summary_index: 0,
    delta: reasoning
  });
}

function responsesTextDelta(state, text) {
  let events = "";
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
  return events + responsesSse(state, "response.output_text.delta", {
    item_id: state.messageId,
    output_index: state.message.outputIndex,
    content_index: 0,
    delta: text
  });
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
  // Whatever the tag filter still held at the end of the stream joins its channel now.
  for (const piece of state.thinkFilter.end()) {
    events += piece.type === "thinking" ? responsesReasoningDelta(state, piece.text) : responsesTextDelta(state, piece.text);
  }
  const output = [];
  for (const { kind, outputIndex, item } of responsesStreamItems(state)) {
    output.push(item);
    if (kind === "reasoning") {
      const summary = { item_id: item.id, output_index: outputIndex, summary_index: 0 };
      events += responsesSse(state, "response.reasoning_summary_text.done", { ...summary, text: state.reasoning.text });
      events += responsesSse(state, "response.reasoning_summary_part.done", { ...summary, part: item.summary[0] });
    } else if (kind === "message") {
      const part = { item_id: item.id, output_index: outputIndex, content_index: 0 };
      for (const [annotation_index, annotation] of item.content[0].annotations.entries()) events += responsesSse(state, "response.output_text.annotation.added", { ...part, annotation_index, annotation });
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

// A chat stream reports a failure as an `error` chunk followed by [DONE]. Folded into the
// [DONE] it would close as response.completed, and an empty completed response is what the
// client then retries or shows as an empty answer instead of the upstream's reason.
function failResponsesStream(state, error) {
  if (state.completed) return "";
  state.completed = true;
  const message = typeof error?.message === "string" && error.message ? error.message : "The upstream stream failed.";
  const code = typeof error?.code === "string" && error.code ? error.code : "server_error";
  return startResponsesStream(state) + responsesSse(state, "response.failed", {
    response: { ...responseStreamObject(state, "failed"), error: { code, message } }
  });
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
        content: [{ type: "output_text", text: state.message.text, annotations: state.citationTextLength === state.message.text.length ? chatAnnotationsToResponses([...(state.citationAnnotations?.values() || [])], state.message.text) : [] }]
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
    text: state.request?.text || { format: { type: "text" } },
    store: false,
    previous_response_id: null,
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

// The rung a prepared request will actually run at, read off the body going upstream: the
// effort an adaptive model carries — under whichever field its wire spells it, `reasoning` on a
// GPT Responses request and `reasoning_effort` on a chat one — or the budget an older model was
// given mapped back to the rung it reaches. A request with no thinking settled has no rung and
// keeps the generic budget.
function thinkingRungOf(body) {
  const effort = normalizeRung([body?.output_config?.effort, body?.reasoning?.effort, body?.reasoning_effort].find((value) => typeof value === "string"));
  if (effort) return effort;
  if (body?.thinking?.type === "enabled" && Number.isFinite(body.thinking.budget_tokens)) {
    return rungForBudget(body.thinking.budget_tokens);
  }
  return null;
}

function firstByteTimeout(config, agent = null, rung = null) {
  if (agent === "kimi" && config.kimiFirstByteTimeoutMs) {
    return Math.min(config.timeoutMs, config.kimiFirstByteTimeoutMs);
  }
  const base = ["medium", "high", "xhigh", "max"].includes(rung) && config.thinkingFirstByteTimeoutMs
    ? Math.min(config.timeoutMs, config.thinkingFirstByteTimeoutMs)
    : config.firstByteTimeoutMs || config.timeoutMs;
  // Claude's wait includes the relay's queue, which comes before any header: never shorter than
  // the wait any other rule would allow this request.
  if (agent === "claude" && config.claudeFirstByteTimeoutMs) return Math.max(base, Math.min(config.timeoutMs, config.claudeFirstByteTimeoutMs));
  return base;
}

function modelListTimeout(config) {
  return config.modelListTimeoutMs || Math.min(firstByteTimeout(config), 10_000);
}

// Failover is sequential, so a pool deep enough to be worth having is also deep enough to keep
// a client waiting for an answer that is never coming: 67 accounts that each fail fast cost
// thirteen seconds, and 67 that each burn the 45-second first-byte timeout cost fifty minutes.
// The budget bounds what the caller waits for, not how many accounts may be tried — accounts
// that reject in milliseconds are still all worth trying.
const DEFAULT_FAILOVER_BUDGET_MS = 60_000;

// The key a request authenticated with, for the request log. Kept beside the request rather than
// threaded through every relay signature, and gone with the request.
const REQUEST_API_KEYS = new WeakMap();

const QUEUE_HOLD_PATHS = new Set(["/v1/messages", "/v1/chat/completions", "/v1/responses"]);

function streamStallTimeout(config) {
  const idle = config.streamIdleTimeoutMs || 300_000;
  return Math.max(idle, config.streamStallTimeoutMs || idle);
}

function failoverBudget(config) {
  return config.failoverBudgetMs || DEFAULT_FAILOVER_BUDGET_MS;
}

// The client version the relay is told about when no device session is in play. Kept as a
// constant rather than read from config so the export stays callable with two arguments.
const FALLBACK_CLIENT_VERSION = MIRASIM_CLIENT_VERSION;

export function relayHeaders(incoming, token, { clientVersion = FALLBACK_CLIENT_VERSION, agent = null } = {}) {
  const headers = {
    Accept: incoming.accept || "application/json",
    "Content-Type": incoming["content-type"] || "application/json",
    "x-mirasim-client": clientVersion || FALLBACK_CLIENT_VERSION
  };
  // Only a request that needs a specific upstream names one: the default agent is the relay's
  // own business, and the paths Claude and Codex use identify their upstream by themselves.
  if (agent) headers["x-mirasim-agent"] = agent;
  // The relay admits Anthropic Messages traffic only under a recognized client, and Node's
  // default User-Agent is not one of them, so this gateway identifies itself as the Mirasim
  // client for a Claude (or ZCode) upstream. The other agents are not gated on it.
  if (relayNeedsClientIdentity(agent)) headers["user-agent"] = mirasimClientUserAgent(clientVersion);
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
  }, profile.token, { clientVersion: options.clientVersion, agent: options.agent });
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

async function readBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > maxBytes) {
      request.resume();
      const error = new Error(`Request body is too large (limit: ${maxBytes} bytes).`);
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
  if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
    if (!response.hasHeader("cache-control")) response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("X-Accel-Buffering", "no");
    response.socket?.setNoDelay?.(true);
    response.flushHeaders?.();
  }
  const body = Readable.fromWeb(upstream.body);
  const abortOnClose = () => {
    if (!response.writableEnded) body.destroy();
  };
  response.once("close", abortOnClose);
  body.on("error", () => response.destroy());
  body.on("end", () => response.off("close", abortOnClose));
  withHeartbeat(response, body, upstream.ok && upstream.headers.get("content-type")?.includes("text/event-stream")).pipe(response);
}

function withHeartbeat(response, body, eventStream) {
  const options = STREAM_HEARTBEATS.get(response);
  if (!options || !eventStream) return body;
  const kept = sseHeartbeat(body, options);
  kept.on("error", () => response.destroy());
  response.once("close", () => kept.destroy());
  return kept;
}

// A caller that asked for one object, served from a stream the relay insisted on. The final
// `response.completed` event carries the whole envelope — status, model, usage, reasoning — with
// one thing missing: its `output` array arrives empty. The items are only ever announced as
// `response.output_item.done`, so they are collected on the way past and put back. Trusting the
// envelope alone would answer 200 with no content at all.
async function forwardCodexResponse(response, upstream, restoreResponse = (value) => value, limits = {}) {
  if (!upstream.ok || !upstream.body) return forwardResponse(response, upstream);
  const state = new ResponseState(limits);
  try {
    const events = upstream.headers.get("content-type")?.includes("text/event-stream") ? responseEvents(upstream.body, limits) : [{ type: "response.completed", response: await upstream.json() }];
    for await (const incoming of events) {
      const event = state.accept(incoming);
      if (event.type === "error" || event.type === "response.failed") return sendError(response, 502, event.message || event.error?.message || event.response?.error?.message || "The upstream Codex stream reported an error.");
      if (state.terminal) break;
    }
  } catch (error) {
    return sendError(response, 502, error.message || "The upstream Codex stream ended before it completed.");
  }
  const envelope = state.terminal?.response;
  if (!envelope) return sendError(response, 502, "The upstream Codex stream ended without a final response.");
  return sendJson(response, upstream.status, restoreResponse(envelope, state.terminal.type));
}

function retryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

// A 429 is the account's own quota talking, so it earns that account a cooldown. A 5xx is the
// relay failing, and cooling an account for it is how one bad model empties a healthy pool: a
// single request for a model the relay could not serve used to walk all 67 accounts and leave
// every one of them cooling on a backoff that reaches five minutes, so the models that were
// working had nothing left to run on either.
function accountFault(upstream) {
  return upstream.networkError || upstream.status === 429;
}

// Another account is still worth asking after a 5xx — the relay's capacity for a model differs
// between accounts, and a 503 that one account is refused is often served by the next. But when
// several in a row refuse, the model is out everywhere, and walking the rest of the pool turns
// one failed request into sixty-seven without changing the answer.
const MAX_SERVER_FAULT_ATTEMPTS = 3;

// A congestion refusal is the exception to that reasoning, and it has to be counted separately
// or the pool gives up on a request that was one more attempt from being served.
//
// The relay answers `503 {"code":"model_capacity_exhausted","type":"overloaded_error"}` when the
// shared upstream capacity behind a model is momentarily full. It is not a verdict on the model
// and not a verdict on the account — the relay says so itself ("不计费、也不影响你的账号额度") —
// it is a per-request draw against whatever capacity exists at that instant, and the draws come
// out differently for two accounts asked in the same second. Measured against claude-opus-5
// during one such spell, 12 of 14 accounts were refused while the other 2 were served; retrying
// found an account that answered within 5 attempts every time, median 2.
//
// So three attempts is the wrong budget for it. At a 64% refusal rate three attempts drop a
// quarter of all requests, and at 86% they drop nearly two thirds — which is exactly what the
// console was reporting: 156 of 384 requests dead on a 503 the next account would have served.
// The cap here is a guard against a pathological spell rather than the real limit; the failover
// deadline is, and it is what stops a slow request from walking the whole pool.
const MAX_CONGESTION_ATTEMPTS = 20;

// The refusal the relay hands back for its own congestion. `code` is the precise signal and
// `type` is the wire-level one every Anthropic-shaped upstream sets, so either is enough.
const CONGESTION_CODES = new Set(["model_capacity_exhausted"]);
const CONGESTION_TYPES = new Set(["overloaded_error"]);

// Distinct from `no upstream available for model "x"` (type `api_error`), which is deterministic:
// the model is not routable at all, every account gets the same answer, and retrying is only a
// way to spend the pool on a settled question. That one keeps the three-attempt budget.
function congestionRefusal(upstream) {
  const error = parseJsonObject(upstream.refusalBody || "")?.error;
  if (!error || typeof error !== "object") return false;
  return CONGESTION_CODES.has(error.code) || CONGESTION_TYPES.has(error.type);
}

// A refusal body is a few hundred bytes of JSON, but it arrives on a stream that would otherwise
// be cancelled, so it is read once and carried on the response object. The cap is there because
// nothing guarantees a failing upstream is terse.
const MAX_REFUSAL_BODY_BYTES = 64 * 1024;
const MAX_REFUSAL_READ_MS = 1000;

async function bufferRefusal(upstream, deadline) {
  if (upstream.refusalBody !== undefined || !upstream.body || upstream.bodyUsed) return upstream;
  const reader = upstream.body.getReader();
  const chunks = [];
  let bytes = 0;
  let completed = false;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, Math.min(MAX_REFUSAL_READ_MS, deadline - Date.now())));
  });
  try {
    while (bytes < MAX_REFUSAL_BODY_BYTES) {
      const result = await Promise.race([reader.read(), timeout]);
      if (!result) break;
      if (result.done) {
        completed = true;
        break;
      }
      const chunk = Buffer.from(result.value.subarray(0, MAX_REFUSAL_BODY_BYTES - bytes));
      chunks.push(chunk);
      bytes += chunk.byteLength;
    }
  } catch {} finally {
    clearTimeout(timer);
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  // Rebuilt rather than mutated: the caller may go on to forward this response, and its body has
  // now been consumed. The status, headers and text are all a forward needs.
  let text = Buffer.concat(chunks, bytes).toString("utf8");
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  if (!completed && !parseJsonObject(text)) {
    text = JSON.stringify({ error: { type: "upstream_error", message: `The upstream returned HTTP ${upstream.status}, but its error body exceeded the read limit or deadline.` } });
    headers.set("content-type", "application/json");
  }
  const replayed = new Response(text, { status: upstream.status, statusText: upstream.statusText, headers });
  replayed.refusalBody = text;
  replayed.refusalComplete = completed;
  return replayed;
}

// Congestion is a property of the moment, not of the account, so the first retries go out at
// full speed — that is where nearly every request is rescued, and a pause there is latency the
// caller pays for nothing, since the next account is an independent draw either way. Only once a
// run of accounts has been refused does the spell look wide enough to be worth easing off for.
//
// The pause stays flat and small on purpose. A doubling backoff reads as the careful choice and
// is the wrong one here: the caller's deadline is the budget that decides how many draws this
// request gets, and every millisecond spent waiting is one not spent on an attempt that might
// have been served. Flat 200ms costs at most ~3s across the whole cap.
const CONGESTION_FREE_RETRIES = 3;
const CONGESTION_BACKOFF_MS = 200;

async function congestionBackoff(refusals, deadline) {
  if (refusals <= CONGESTION_FREE_RETRIES) return;
  const delay = Math.min(CONGESTION_BACKOFF_MS, deadline - Date.now());
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

function serverFault(upstream) {
  return !upstream.networkError && upstream.status !== 429 && retryableStatus(upstream.status);
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

function sendError(response, statusCode, message, headers = {}) {
  const type = statusCode === 401 ? "authentication_error" : statusCode === 429 ? "rate_limit_error" : statusCode >= 500 ? "server_error" : "invalid_request_error";
  sendJson(response, statusCode, { error: { message, type, param: null, code: null } }, headers);
}

async function forwardOpenAiError(response, upstream) {
  const chunks = [];
  let bytes = 0;
  if (upstream.body) {
    for await (const chunk of upstream.body) {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024) break;
      chunks.push(chunk);
    }
  }
  const body = bytes <= 64 * 1024 ? Buffer.concat(chunks).toString("utf8") : "";
  const payload = parseJsonObject(body);
  const error = payload?.error;
  const fallbackType = upstream.status === 401 ? "authentication_error" : upstream.status === 403 ? "permission_error" : upstream.status === 429 ? "rate_limit_error" : upstream.status >= 500 ? "server_error" : "invalid_request_error";
  // Preserve recognized upstream classifications, not the SSE event name or arbitrary
  // vendor labels. A permission denial remains final regardless of its payload's type.
  const type = upstream.status !== 403 && ["invalid_request_error", "overloaded_error", "api_error", "authentication_error", "permission_error", "rate_limit_error", "server_error"].includes(error?.type)
    ? error.type : fallbackType;
  let message = typeof error?.message === "string" ? error.message : null;
  if (upstream.status === 403) {
    const contentType = upstream.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (message === null && !payload && contentType === "text/plain") message = body;
    message = relayErrorDetails({ message })?.message.trim() || null;
  }
  const headers = {};
  for (const name of ["retry-after", "x-request-id", "request-id"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  sendJson(response, upstream.status, { error: {
    message: message ?? `The upstream request failed with HTTP ${upstream.status}.`,
    type,
    param: typeof error?.param === "string" ? error.param : null,
    code: typeof error?.code === "string" ? error.code : null
  } }, headers);
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

function sendProtocolError(response, protocol, statusCode, message, headers = {}) {
  if (protocol === "anthropic") return sendAnthropicError(response, statusCode, message, headers);
  if (statusCode === 401) return sendOpenAiAuthError(response);
  return sendError(response, statusCode, message, headers);
}

function sendAnthropicError(response, statusCode, message, headers = {}) {
  const type = statusCode === 401 ? "authentication_error" : statusCode === 404 ? "not_found_error" :
    statusCode === 429 ? "rate_limit_error" : statusCode >= 500 ? "api_error" : "invalid_request_error";
  sendJson(response, statusCode, { type: "error", error: { type, message } }, headers);
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
