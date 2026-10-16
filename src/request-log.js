import { relayErrorDetails } from "./relay-errors.js";
import { chatCacheReadTokens } from "./chat-usage.js";
import { codexTitleDiagnostics } from "./codex-title.js";
import { parameterDiagnostics } from "./parameter-diagnostics.js";
import { relayQueueInfo } from "./relay-queue.js";

const MAX_JSON_CAPTURE_BYTES = 5_000_000;
const MAX_ERROR_CAPTURE_BYTES = 64 * 1024;

function protocolLabel(path) {
  const pathname = typeof path === "string" ? path.split("?", 1)[0] : "";
  if (pathname === "/v1/messages") return "Anthropic";
  if (/^\/(?:v1|backend-api\/codex)\/images\/(?:generations|edits)$/.test(pathname)) return "OpenAI Images";
  if (["/v1/responses/compact", "/backend-api/codex/responses/compact"].includes(pathname)) return "OpenAI Compact";
  if (["/v1/alpha/search", "/backend-api/codex/alpha/search"].includes(pathname)) return "OpenAI Search";
  if (["/v1/responses", "/backend-api/codex/responses"].includes(pathname)) return "OpenAI Responses";
  return pathname === "/v1/chat/completions" ? "OpenAI Chat" : "未知协议";
}

export class RelayRequestLog {
  #entries = [];
  #active = new Map();
  #maxEntries;
  #nextId = 1;

  constructor({ maxEntries = 500, now = () => Date.now() } = {}) {
    this.#maxEntries = maxEntries;
    this.now = now;
  }

  // `body` is what the client sent, which is what the console reports back. `upstreamBody` is
  // what this gateway ended up sending — after the model-shaped thinking decision, the default
  // level, and the histories that force thinking off — and it is the only place the level the
  // model was actually told is visible.
  open(path, body, upstreamBody = null, { upstreamPath = path, requestId = null, apiKey = null } = {}) {
    const value = parseJsonObject(body);
    const upstream = (upstreamBody === null ? null : parseJsonObject(upstreamBody)) || value;
    const entry = {
      id: this.#nextId++,
      at: new Date().toISOString(),
      path,
      clientPath: path,
      protocol: protocolLabel(path),
      upstreamPath,
      upstreamProtocol: upstreamPath ? protocolLabel(upstreamPath) : null,
      requestId,
      // Which of this gateway's keys made the request. Copied, not referenced: the console has
      // to name the caller even after its key is renamed or revoked. Never the secret itself.
      apiKey: apiKeyLabel(apiKey),
      model: typeof value?.model === "string" ? value.model : null,
      codexTitleDiagnostics: codexTitleDiagnostics(value),
      parameterDiagnostics: upstreamBody === null ? [] : parameterDiagnostics(value, upstream),
      reasoningEffort: reasoningEffort(value),
      thinkingLevel: thinkingLevel(upstream),
      // Whether a turn asked for tools, and how much room it left for an answer, are what
      // decide whether it gets thinking — so they belong in the log that diagnoses it.
      maxTokens: Number.isFinite(value?.max_tokens) ? value.max_tokens
        : Number.isFinite(value?.max_output_tokens) ? value.max_output_tokens : null,
      toolCount: Array.isArray(value?.tools) ? value.tools.length : 0,
      // Names, because a count cannot answer the question that actually matters: whether the
      // tool the user asked for is among them. A server tool (web search) carries its
      // capability in `type`, and a converting gateway that drops the type leaves a tool the
      // model can name but nothing can run.
      toolNames: toolNames(value),
      // What the model actually called back. Without this there is no way to tell a model
      // that never reached for a tool from one whose call was dropped on the way back to the
      // client — the symptom ("it didn't search") looks identical from outside.
      calledTools: [],
      stream: value?.stream === true,
      account: null,
      attempts: [],
      status: null,
      upstreamStatus: null,
      upstreamStream: null,
      responseBytes: 0,
      stage: "waiting_headers",
      lastEvent: null,
      lastEventAt: null,
      eventCounts: {},
      streamError: null,
      upstreamError: null,
      textCharacters: 0,
      reasoningCharacters: 0,
      finishReason: null,
      upstreamRequestId: null,
      pending: true,
      ttfbMs: null,
      firstOutputMs: null,
      firstTextMs: null,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      // OpenAI/DeepSeek report prompt tokens including cache reads, while Anthropic's
      // input_tokens excludes cache reads. Keep both the upstream counter and the amount
      // that was newly processed so the dashboard never implies the cache was double-billed.
      inputTokenSemantics: null,
      uncachedInputTokens: null,
      startedAt: this.now()
    };
    this.#active.set(entry.id, entry);
    if (this.#active.size > this.#maxEntries) this.#active.delete(this.#active.keys().next().value);
    return entry;
  }

  // A single client request can pass through several accounts during failover. Keep every
  // attempt on the request entry so the console can explain why its final account was used.
  attempt(entry, profile = null, priority = null, status = 0, headers = null) {
    if (!entry || !Array.isArray(entry.attempts)) return;
    const queue = relayQueueInfo(headers);
    entry.attempts.push({
      account: profile?.id || null,
      priority: Number.isFinite(priority) ? priority : null,
      status: Number.isInteger(status) ? status : 0,
      ...(queue ? { queue } : {}),
      at: new Date().toISOString()
    });
  }

  recordFirstByte(entry) {
    if (entry.pending && entry.ttfbMs === null) entry.ttfbMs = Math.max(0, this.now() - entry.startedAt);
  }

  recordFirstOutput(entry, frame) {
    if (!entry.pending || (entry.firstOutputMs !== null && entry.firstTextMs !== null)) return;
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    const event = parseJsonObject(data);
    if (!event || event.error || event.type === "error" || event.type === "response.failed") return;
    const hasText = (value) => typeof value === "string" && value.length > 0;
    const list = (value) => Array.isArray(value) ? value : [];
    const textPart = (part) => (["output_text", "text"].includes(part?.type) && hasText(part.text)) || (part?.type === "refusal" && hasText(part.refusal));
    const items = [event.item, ...list(event.response?.output)].filter(Boolean);
    const deltas = list(event.choices).map((choice) => choice?.delta || choice?.message || {});
    const text = (["response.output_text.delta", "response.refusal.delta"].includes(event.type) && hasText(event.delta))
      || (["response.output_text.done", "response.refusal.done"].includes(event.type) && hasText(event.text || event.refusal))
      || textPart(event.part) || textPart(event.content_block)
      || (event.delta?.type === "text_delta" && hasText(event.delta.text))
      || deltas.some((delta) => hasText(delta.content) || hasText(delta.refusal))
      || items.some((item) => item.type === "message" && list(item.content).some(textPart));
    const output = text || hasText(event.b64_json) || hasText(event.partial_image_b64) || (typeof event.type === "string" && event.type.endsWith(".delta") && hasText(event.delta))
      || (["response.reasoning_summary_text.done", "response.reasoning_text.done"].includes(event.type) && hasText(event.text))
      || (event.part?.type === "summary_text" && hasText(event.part.text))
      || (event.delta?.type === "thinking_delta" && hasText(event.delta.thinking))
      || deltas.some((delta) => hasText(delta.reasoning_content) || delta.tool_calls?.length)
      || items.some((item) => (typeof item.type === "string" && item.type.endsWith("_call")) || list(item.summary).some((part) => hasText(part?.text)));
    const elapsed = Math.max(0, this.now() - entry.startedAt);
    if (output && entry.firstOutputMs === null) entry.firstOutputMs = elapsed;
    if (text && entry.firstTextMs === null) entry.firstTextMs = elapsed;
  }

  fail(entry, status = 0) {
    if (status === 499 && !entry.streamError && ["completed", "incomplete"].includes(entry.stage)) {
      this.#finalize(entry);
      return;
    }
    entry.status = entry.streamError && (status < 400 || status === 499) ? 502 : status;
    if (status === 499 && !entry.streamError) entry.stage = "client_disconnected";
    this.#finalize(entry);
  }

  // Wraps the upstream body so token usage and first-byte/completion timings are
  // observed while the original bytes flow through to the protocol handlers untouched.
  // dropUsageOnlyFrames removes the usage-only chunk this gateway asked the upstream for,
  // so a client that never set stream_options.include_usage still sees the stream it expected.
  observe(entry, upstream, profile = null, { dropUsageOnlyFrames = false } = {}) {
    entry.account = profile?.id || entry.account;
    entry.status = upstream.status;
    entry.upstreamStatus = upstream.status;
    entry.upstreamStream = (upstream.headers?.get?.("content-type") || "").includes("text/event-stream");
    entry.stage = "waiting_content";
    entry.upstreamRequestId = requestId(upstream.headers?.get?.("x-request-id")) || requestId(upstream.headers?.get?.("request-id"));
    if (!upstream.body) {
      this.#finalize(entry);
      return upstream;
    }

    const contentType = upstream.headers?.get?.("content-type") || "";
    const eventStream = contentType.includes("text/event-stream");
    const rewriteFrames = eventStream && dropUsageOnlyFrames;
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const encoder = new TextEncoder();
    const log = this;
    let buffer = "";
    let jsonBytes = 0;

    // Returns the frames that should reach the client, which only matters while rewriting.
    const scanChunk = (chunk) => {
      if (!entry.pending) return [];
      entry.responseBytes += chunk.byteLength;
      if (chunk.byteLength) log.recordFirstByte(entry);
      const text = decoder.decode(chunk, { stream: true });
      if (!eventStream) {
        if (upstream.status >= 400) {
          jsonBytes += chunk.byteLength ?? chunk.length ?? 0;
          buffer = jsonBytes <= MAX_ERROR_CAPTURE_BYTES ? buffer + text : "";
        } else if (jsonBytes < MAX_JSON_CAPTURE_BYTES) {
          jsonBytes += chunk.byteLength ?? chunk.length ?? 0;
          buffer += text;
        }
        return [];
      }
      buffer += text;
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop();
      const forwarded = [];
      for (const frame of frames) {
        log.recordFirstOutput(entry, frame);
        const usageOnly = scanSseFrame(frame, entry);
        if (!usageOnly || !dropUsageOnlyFrames) forwarded.push(frame);
      }
      return forwarded;
    };
    const finish = () => {
      if (!entry.pending) return;
      buffer += decoder.decode();
      if (eventStream) {
        if (buffer) scanSseFrame(buffer, entry);
      } else {
        const payload = parseJsonObject(buffer);
        if (upstream.status >= 400 && jsonBytes <= MAX_ERROR_CAPTURE_BYTES) {
          const error = payload?.error;
          const details = { type: error?.type, code: error?.code };
          // Permission refusals need their explanation; other errors may echo prompt text.
          if (upstream.status === 403) {
            if (typeof error?.message === "string") details.message = error.message;
            else if (!payload && contentType.split(";", 1)[0].trim().toLowerCase() === "text/plain") details.message = buffer;
          }
          entry.upstreamError ||= relayErrorDetails(details);
        }
        recordResponseContent(entry, payload);
        entry.upstreamRequestId ||= requestId(payload?.request_id);
        recordCalledTools(entry, payload?.content);
        recordCalledFunctions(entry, payload?.choices?.[0]?.message?.tool_calls);
        mergeUsage(entry, payload?.usage);
        mergeUsage(entry, payload?.message?.usage);
        // Some relays answer an Anthropic-shaped request with OpenAI-compatible
        // counters at the top level rather than under `usage`.
        mergeUsage(entry, payload);
      }
      log.#finalize(entry);
    };

    const monitored = upstream.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        let forwarded = [];
        try { forwarded = scanChunk(chunk); } catch {}
        if (!rewriteFrames) {
          controller.enqueue(chunk);
          return;
        }
        for (const frame of forwarded) controller.enqueue(encoder.encode(`${frame}\n\n`));
      },
      flush(controller) {
        const trailing = rewriteFrames ? buffer : "";
        finish();
        if (trailing) controller.enqueue(encoder.encode(trailing));
      }
    }));
    const reader = monitored.getReader();
    const tracked = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { finish(); controller.close(); }
          else controller.enqueue(value);
        } catch (error) {
          if (!entry.pending || ["completed", "incomplete"].includes(entry.stage)) {
            finish();
            try { controller.close(); } catch {}
            return;
          }
          entry.streamError = error.code === "upstream_stream_timeout" ? "upstream_stream_timeout" : "upstream_stream_error";
          entry.stage = "failed";
          entry.status = 502;
          finish();
          controller.error(error);
        }
      },
      async cancel(reason) {
        // The stream adapters release their source after a terminal event too. That normal
        // cleanup must not overwrite a successful Chat `finish_reason` or a reported
        // incomplete response with “cancelled · HTTP 200”.
        if (entry.pending && !["completed", "incomplete", "failed"].includes(entry.stage)) entry.stage = "cancelled";
        finish();
        await reader.cancel(reason).catch(() => {});
      }
    });

    return {
      ok: upstream.ok,
      status: upstream.status,
      headers: upstream.headers,
      body: tracked,
      text: () => new Response(tracked).text(),
      json: () => new Response(tracked).json()
    };
  }

  snapshot() {
    return [...this.#entries, ...this.#active.values()].sort((left, right) => right.id - left.id).slice(0, this.#maxEntries).map(({ startedAt, ...entry }) => ({ ...entry, ...(entry.pending ? { elapsedMs: Math.max(0, this.now() - startedAt) } : {}) }));
  }

  #finalize(entry) {
    if (!entry.pending) return;
    entry.pending = false;
    this.#active.delete(entry.id);
    entry.completedAt = new Date().toISOString();
    entry.durationMs = Math.max(0, this.now() - entry.startedAt);
    this.#entries.push(entry);
    if (this.#entries.length > this.#maxEntries) this.#entries.splice(0, this.#entries.length - this.#maxEntries);
  }
}

function apiKeyLabel(value) {
  if (!value || typeof value.id !== "string") return null;
  return { id: value.id, name: typeof value.name === "string" ? value.name : null, prefix: typeof value.prefix === "string" ? value.prefix : null };
}

function requestId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
}

// Reports whether the frame carried nothing but token usage, which is the shape of the
// final OpenAI chunk requested through stream_options.include_usage.
function scanSseFrame(frame, entry) {
  const data = frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return false;
  const event = parseJsonObject(data);
  if (!event) return false;
  const type = typeof event.type === "string" && /^[a-zA-Z0-9_.-]{1,96}$/.test(event.type) ? event.type : "chat.chunk";
  entry.lastEvent = type;
  entry.lastEventAt = new Date().toISOString();
  if (Object.hasOwn(entry.eventCounts, type) || Object.keys(entry.eventCounts).length < 64) entry.eventCounts[type] = (entry.eventCounts[type] || 0) + 1;
  const itemType = event.item?.type;
  if (/^(?:image_generation|image_edit)\.completed$/.test(type)) entry.stage = "completed";
  if (itemType === "reasoning" || type.includes("reasoning") || event.delta?.type === "thinking_delta") entry.stage = "reasoning";
  if (["function_call", "custom_tool_call"].includes(itemType)) {
    entry.stage = "tool_call";
    if (typeof event.item.name === "string" && !entry.calledTools.includes(event.item.name)) entry.calledTools.push(event.item.name);
  }
  if (type.includes("function_call_arguments") || type.includes("custom_tool_call_input") || event.delta?.type === "input_json_delta") entry.stage = "tool_call";
  if (type === "response.output_text.delta" || event.delta?.type === "text_delta" || event.choices?.[0]?.delta?.content) entry.stage = "text";
  if (["response.completed", "response.incomplete", "message_stop"].includes(type)) {
    entry.stage = type === "response.incomplete" ? "incomplete" : "completed";
    entry.finishReason ||= type === "response.incomplete" ? "incomplete" : "completed";
  }
  if (type === "error" || type === "response.failed" || event.error) {
    entry.streamError = "upstream_error_event";
    entry.upstreamError = relayErrorDetails(event.error || event.response?.error);
    entry.stage = "failed";
    entry.status = 502;
  }
  // OpenAI Chat has no named terminal event: its final chunk carries a finish_reason and the
  // next `[DONE]` only closes the transport. Recognize that terminal chunk before an adapter
  // releases the source, or the release is indistinguishable from a client cancellation.
  const chatFinishReason = event.choices?.find((choice) => typeof choice?.finish_reason === "string" && choice.finish_reason)?.finish_reason;
  if (chatFinishReason) {
    entry.finishReason ||= chatFinishReason;
    if (!entry.streamError) entry.stage = chatFinishReason === "length" ? "incomplete" : "completed";
  }
  recordResponseContent(entry, event);
  // Anthropic streams report usage on message_start/message_delta; OpenAI chunks
  // and Responses events carry a usage object on the frame itself.
  if (event.type === "content_block_start") recordCalledTools(entry, [event.content_block]);
  // A chat-completions upstream — which is where DeepSeek and Kimi are served, whichever
  // protocol the client spoke — names its calls under `delta` instead.
  recordCalledFunctions(entry, event.choices?.[0]?.delta?.tool_calls);
  const merged = mergeUsage(entry, event.usage);
  mergeUsage(entry, event.message?.usage);
  mergeUsage(entry, event.response?.usage);
  mergeUsage(entry, event);
  return merged && Array.isArray(event.choices) && event.choices.length === 0;
}

function recordResponseContent(entry, payload) {
  if (!payload || typeof payload !== "object") return;
  const choice = payload.choices?.[0];
  const message = choice?.delta || choice?.message;
  if (typeof message?.content === "string") entry.textCharacters += message.content.length;
  if (typeof message?.reasoning_content === "string") entry.reasoningCharacters += message.reasoning_content.length;
  entry.finishReason = choice?.finish_reason || payload.stop_reason || payload.delta?.stop_reason || entry.finishReason;
  const blocks = payload.type === "content_block_start" ? [payload.content_block] : Array.isArray(payload.content) ? payload.content : [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") entry.textCharacters += block.text.length;
    if (block?.type === "thinking" && typeof block.thinking === "string") entry.reasoningCharacters += block.thinking.length;
  }
  if (payload.delta?.type === "text_delta") entry.textCharacters += payload.delta.text?.length || 0;
  if (payload.delta?.type === "thinking_delta") entry.reasoningCharacters += payload.delta.thinking?.length || 0;
  if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") entry.textCharacters += payload.delta.length;
  if (payload.type === "response.reasoning_summary_text.delta" && typeof payload.delta === "string") entry.reasoningCharacters += payload.delta.length;
}

function mergeUsage(entry, usage) {
  if (!usage || typeof usage !== "object") return false;
  const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens;
  const output = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens;
  const cacheRead = usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? chatCacheReadTokens(usage) ?? usage.input_tokens_details?.cached_tokens ?? usage.cacheReadTokens;
  const cacheWrite = usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens ?? usage.cacheWriteTokens;
  const found = [input, output, cacheRead, cacheWrite].some((value) => Number.isFinite(value));
  if (found) assignInputTokenSemantics(entry, inputTokenSemantics(entry, usage));
  assignTokens(entry, "inputTokens", input);
  assignTokens(entry, "outputTokens", output);
  assignTokens(entry, "cacheReadTokens", cacheRead);
  assignTokens(entry, "cacheWriteTokens", cacheWrite);
  updateUncachedInputTokens(entry);
  return found;
}

// A streamed usage object is cumulative and often omits counts it already reported by
// sending a zero, so a later frame must never talk a count back down.
function assignTokens(entry, key, value) {
  if (!Number.isFinite(value) || value < 0) return;
  if (entry[key] === null || value > entry[key]) entry[key] = value;
}

function inputTokenSemantics(entry, usage) {
  // Anthropic reports cache counters alongside input_tokens, but input_tokens itself is
  // already the non-cache amount. Its counter names are distinct from OpenAI's.
  if (hasOwnCounter(usage, "cache_read_input_tokens") || hasOwnCounter(usage, "cache_creation_input_tokens")) {
    return "exclusive_cache";
  }
  // Chat Completions, Responses, and DeepSeek all use an OpenAI-style input total that
  // includes cached prompt tokens. The cached amount is a detail of that total.
  if (hasOwnCounter(usage, "prompt_tokens") || hasOwnCounter(usage, "promptTokens")
    || hasOwnCounter(usage, "prompt_cache_hit_tokens") || hasOwnCounter(usage, "prompt_cache_miss_tokens")
    || hasOwnCounter(usage, "cached_input_tokens") || hasOwnCounter(usage, "cacheReadTokens")
    || usage.prompt_tokens_details || usage.input_tokens_details) {
    return "inclusive_cache";
  }
  // An Anthropic-shaped usage object without cache activity remains exclusive by definition.
  // Bridged DeepSeek replies expose OpenAI markers above, so this fallback does not reclassify
  // them merely because the client used /v1/messages.
  return entry.protocol === "Anthropic" ? "exclusive_cache" : "inclusive_cache";
}

function hasOwnCounter(usage, key) {
  return Object.hasOwn(usage, key) && Number.isFinite(usage[key]);
}

function assignInputTokenSemantics(entry, value) {
  if (!["inclusive_cache", "exclusive_cache"].includes(value)) return;
  // Explicit Anthropic cache fields are authoritative. Otherwise preserve an already known
  // semantics across partial streaming usage frames.
  if (entry.inputTokenSemantics === null || value === "exclusive_cache") entry.inputTokenSemantics = value;
}

function updateUncachedInputTokens(entry) {
  if (!Number.isFinite(entry.inputTokens)) return;
  if (entry.inputTokenSemantics === "inclusive_cache") {
    entry.uncachedInputTokens = Math.max(0, entry.inputTokens - (Number.isFinite(entry.cacheReadTokens) ? entry.cacheReadTokens : 0));
    return;
  }
  if (entry.inputTokenSemantics === "exclusive_cache") entry.uncachedInputTokens = entry.inputTokens;
}

// Normalised so the console never has to render a vendor's raw English keyword.
// The level the model was actually told to think at, read off the request as it went upstream.
// The two model families say it in different places: a current model carries a named rung in
// `output_config.effort` next to `thinking: { type: "adaptive" }`, an older one carries a token
// budget inside `thinking` itself. Reading the sent request rather than the caller's own is the whole point: a caller
// that says nothing still gets a level, and a caller that names one does not always keep it.
function thinkingLevel(value) {
  const effort = reasoningEffort(value);
  if (effort === "none" || effort === "off") return "off";
  if (effort) return effort;
  return null;
}

function reasoningEffort(value) {
  if (!value || typeof value !== "object") return null;
  const thinking = value?.thinking;
  if (thinking?.type === "disabled" || thinking?.enabled === false) return "none";
  const effort = firstString(value.reasoning_effort, value.reasoning?.effort, value.output_config?.effort, thinking?.effort);
  if (effort) return effort.toLowerCase();
  if (thinking && typeof thinking === "object") {
    if (Number.isFinite(thinking.budget_tokens)) return `budget:${Math.floor(thinking.budget_tokens)}`;
    if (typeof thinking.type === "string" && thinking.type.trim()) return thinking.type.trim().toLowerCase();
    return "on";
  }
  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(typeof value === "string" ? value : value.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Anthropic names a custom tool directly and a server tool by `type`; the OpenAI protocols
// nest it under `function`. Capped, because a tool list can be long and this is a log.
function toolNames(value) {
  if (!Array.isArray(value?.tools)) return [];
  return value.tools.slice(0, 64).map((tool) => {
    if (!tool || typeof tool !== "object") return "?";
    const name = typeof tool.name === "string" && tool.name ? tool.name
      : typeof tool.function?.name === "string" ? tool.function.name : "";
    const type = typeof tool.type === "string" && tool.type && tool.type !== "function" ? tool.type : "";
    return type && type !== name ? `${name || "?"}<${type}>` : (name || "?");
  });
}

// A tool the model invoked, named the way the request named it: a server tool by its type,
// a client tool by its name. Deduped, since a streamed block can be seen more than once.
function recordCalledTools(entry, blocks) {
  if (!Array.isArray(blocks) || !Array.isArray(entry.calledTools)) return;
  for (const block of blocks) {
    const type = block?.type;
    if (type !== "tool_use" && type !== "server_tool_use") continue;
    const label = typeof block.name === "string" && block.name ? block.name : type;
    if (!entry.calledTools.includes(label)) entry.calledTools.push(label);
  }
}

// The same question asked of an OpenAI-shaped answer, where a call names itself under
// `function` rather than on the block. Only the chunk that opens a call carries the name, so
// this sees each one once.
function recordCalledFunctions(entry, toolCalls) {
  if (!Array.isArray(toolCalls) || !Array.isArray(entry.calledTools)) return;
  for (const call of toolCalls) {
    const name = call?.function?.name;
    if (typeof name !== "string" || !name || entry.calledTools.includes(name)) continue;
    entry.calledTools.push(name);
  }
}
