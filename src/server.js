import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { OpenAIKeyStore, normalizeApiKeyName } from "./api-keys.js";
import { MirasimDashboard, RelayUsageLedger } from "./dashboard.js";
import { MirasimProfilePool } from "./pool.js";
import { WebAuth } from "./web-auth.js";
import { StateDatabase } from "./database.js";
import { MirasimSessionRefresher } from "./session-refresh.js";
import { MirasimModelHealth } from "./model-health.js";
import { MirasimRelaySessions } from "./relay-device.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const RESPONSE_HEADERS = new Set(["content-type", "cache-control", "retry-after", "x-request-id", "openai-processing-ms"]);
const PROXY_PATHS = new Set(["/v1/chat/completions", "/v1/messages"]);
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
  const usage = new RelayUsageLedger();
  const sessions = new MirasimSessionRefresher(config, { fetchImpl });
  const relaySessions = new MirasimRelaySessions(config, { fetchImpl });
  const modelHealth = new MirasimModelHealth(config, pool, { fetchImpl, sessionRefresher: sessions, relaySessions, database });
  const dashboard = new MirasimDashboard(config, pool, usage, { fetchImpl, database, sessionRefresher: sessions });
  const webAuth = new WebAuth(config.webAuth, { database });
  const apiKeys = new OpenAIKeyStore(database);
  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, config, pool, usage, dashboard, sessions, relaySessions, modelHealth, webAuth, apiKeys, fetchImpl);
    } catch (error) {
      logger.error?.("mirasim relay proxy failed", error);
      if (!response.headersSent) sendProtocolError(response, protocolForPath(request.url), error.statusCode || 502, error.message || "The relay request failed.");
      else response.destroy(error);
    }
  });
  server.startModelHealth = () => modelHealth.start();
  server.on("close", () => modelHealth.stop());
  return server;
}

async function handleRequest(request, response, config, pool, usage, dashboard, sessions, relaySessions, modelHealth, webAuth, apiKeys, fetchImpl) {
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
  if (request.method === "PUT" && url.pathname === "/api/moemail/config") {
    const body = await readJson(request);
    return sendJson(response, 200, dashboard.configureMoeMail(body));
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
  const protocol = protocolForPath(url.pathname);
  if (url.pathname.startsWith("/v1/")) {
    if (!apiKeys.authenticate(clientApiKey(request, protocol))) return sendProtocolError(response, protocol, 401, "Missing or invalid API key.");
  }
  if (request.method === "GET" && url.pathname === "/v1/models") {
    return sendJson(response, 200, await modelList(config, pool, fetchImpl, sessions, relaySessions));
  }
  if (request.method === "POST" && url.pathname === "/v1/responses") {
    const body = await readBody(request);
    const translated = responseToChatRequest(body);
    if (!translated.ok) return sendError(response, 400, translated.message);
    const upstreamUrl = new URL("/v1/chat/completions", url);
    return relayRequest(
      request,
      response,
      config,
      pool,
      usage,
      fetchImpl,
      upstreamUrl,
      Buffer.from(JSON.stringify(translated.chat)),
      "openai",
      (downstream, upstream) => translated.stream
        ? forwardResponsesStream(downstream, upstream, translated.request)
        : forwardResponsesResponse(downstream, upstream, translated.request),
      sessions,
      relaySessions
    );
  }
  if (request.method !== "POST" || !PROXY_PATHS.has(url.pathname)) {
    return sendProtocolError(response, protocol, 404, "Use /, /api/dashboard, /healthz, /v1/models, /v1/chat/completions, /v1/responses, or /v1/messages.");
  }

  const body = await readBody(request);
  return relayRequest(request, response, config, pool, usage, fetchImpl, url, body, protocol, forwardResponse, sessions, relaySessions);
}

async function relayRequest(request, response, config, pool, usage, fetchImpl, url, body, protocol = "openai", responseHandler = forwardResponse, sessions = null, relaySessions = null) {
  await sessions?.refreshAll(config.homes);
  const excluded = new Set();
  let profile;
  let upstream;

  while ((profile = pool.pick(excluded))) {
    upstream = await fetchRelay(request, config, profile, fetchImpl, url, body, relaySessions);
    if (upstream.networkError || retryableStatus(upstream.status)) {
      excluded.add(profile.home);
      pool.failure(profile, retryAfterMs(upstream.headers?.get?.("retry-after")));
      if (upstream.networkError) usage.failure(profile);
      else usage.record(profile, upstream);
      if (pool.hasCandidate(excluded)) {
        await upstream.body?.cancel?.();
        continue;
      }
      break;
    }
    pool.success(profile);
    usage.record(profile, upstream);
    break;
  }

  if (!upstream || upstream.networkError) {
    const statusCode = upstream?.timedOut ? 504 : 503;
    const message = upstream?.timedOut
      ? "The Mirasim upstream did not return response headers before the configured timeout."
      : "No logged-in Mirasim relay profile is available. Run `npm run login -- email` or `npm run login -- github`.";
    return sendProtocolError(response, protocol, statusCode, message);
  }
  return responseHandler(response, upstream);
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
  if (request.headers["anthropic-beta"]) headers["anthropic-beta"] = request.headers["anthropic-beta"];
  if (request.headers["anthropic-version"]) headers["anthropic-version"] = request.headers["anthropic-version"];

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
  for (const field of ["temperature", "top_p", "seed", "parallel_tool_calls"]) {
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
    const role = responseRole(item.role);
    const content = responseContent(item.content);
    if (role && content) messages.push({ role, content });
  }
  return messages;
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
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: Number.isFinite(request.temperature) ? request.temperature : 1,
    text: { format: { type: "text" } },
    tool_choice: request.tool_choice || "auto",
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: Number.isFinite(request.top_p) ? request.top_p : 1,
    usage: {
      input_tokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0,
      output_tokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0,
      total_tokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : 0
    }
  };
}

function forwardResponsesStream(response, upstream, request) {
  if (!upstream.ok || !upstream.body) return forwardResponse(response, upstream);
  const state = {
    created: false,
    completed: false,
    contentStarted: false,
    createdAt: Math.floor(Date.now() / 1000),
    id: `resp_${randomUUID().replace(/-/g, "")}`,
    messageId: `msg_${randomUUID().replace(/-/g, "")}`,
    model: request.model,
    sequence: 0
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
  const text = choice?.delta?.content;
  if (typeof text === "string" && text) {
    if (!state.contentStarted) {
      state.contentStarted = true;
      events += responsesSse(state, "response.output_item.added", {
        output_index: 0,
        item: { type: "message", id: state.messageId, status: "in_progress", role: "assistant", content: [] }
      });
      events += responsesSse(state, "response.content_part.added", {
        item_id: state.messageId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      });
    }
    events += responsesSse(state, "response.output_text.delta", {
      item_id: state.messageId,
      output_index: 0,
      content_index: 0,
      delta: text
    });
  }
  if (choice?.finish_reason) events += completeResponsesStream(state, choice.finish_reason);
  return events;
}

function startResponsesStream(state, model) {
  if (state.created) return "";
  state.created = true;
  if (typeof model === "string" && model) state.model = model;
  return responsesSse(state, "response.created", { response: responseStreamObject(state, "in_progress") });
}

function completeResponsesStream(state, finishReason = "stop") {
  if (state.completed) return "";
  state.completed = true;
  let events = startResponsesStream(state);
  if (state.contentStarted) {
    events += responsesSse(state, "response.output_text.done", { item_id: state.messageId, output_index: 0, content_index: 0, text: "" });
    events += responsesSse(state, "response.content_part.done", {
      item_id: state.messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] }
    });
    events += responsesSse(state, "response.output_item.done", {
      output_index: 0,
      item: { type: "message", id: state.messageId, status: "completed", role: "assistant", content: [] }
    });
  }
  const incomplete = finishReason === "length";
  events += responsesSse(state, incomplete ? "response.incomplete" : "response.completed", {
    response: { ...responseStreamObject(state, incomplete ? "incomplete" : "completed"), incomplete_details: incomplete ? { reason: "max_output_tokens" } : null }
  });
  return events;
}

function responseStreamObject(state, status) {
  return {
    id: state.id,
    object: "response",
    created_at: state.createdAt,
    status,
    model: state.model,
    output: [],
    error: null,
    incomplete_details: null
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
    "x-mirasim-client": "0.0.147",
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
