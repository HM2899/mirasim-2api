const MAX_JSON_CAPTURE_BYTES = 5_000_000;

export class RelayRequestLog {
  #entries = [];
  #maxEntries;
  #nextId = 1;

  constructor({ maxEntries = 500, now = () => Date.now() } = {}) {
    this.#maxEntries = maxEntries;
    this.now = now;
  }

  open(path, body) {
    const value = parseJsonObject(body);
    const entry = {
      id: this.#nextId++,
      at: new Date().toISOString(),
      path,
      protocol: path === "/v1/messages" ? "Anthropic" : path === "/v1/responses" || path === "/backend-api/codex/responses" ? "OpenAI Responses" : "OpenAI Chat",
      model: typeof value?.model === "string" ? value.model : null,
      reasoningEffort: reasoningEffort(value),
      // Whether a turn asked for tools, and how much room it left for an answer, are what
      // decide whether it gets thinking — so they belong in the log that diagnoses it.
      maxTokens: Number.isFinite(value?.max_tokens) ? value.max_tokens
        : Number.isFinite(value?.max_output_tokens) ? value.max_output_tokens : null,
      toolCount: Array.isArray(value?.tools) ? value.tools.length : 0,
      stream: value?.stream === true,
      account: null,
      status: null,
      pending: true,
      ttfbMs: null,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      startedAt: this.now()
    };
    return entry;
  }

  fail(entry, status = 0) {
    entry.status = status;
    this.#finalize(entry);
  }

  // Wraps the upstream body so token usage and first-byte/completion timings are
  // observed while the original bytes flow through to the protocol handlers untouched.
  // dropUsageOnlyFrames removes the usage-only chunk this gateway asked the upstream for,
  // so a client that never set stream_options.include_usage still sees the stream it expected.
  observe(entry, upstream, profile = null, { dropUsageOnlyFrames = false } = {}) {
    entry.account = profile?.id || entry.account;
    entry.status = upstream.status;
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
      if (entry.ttfbMs === null) entry.ttfbMs = Math.max(0, log.now() - entry.startedAt);
      const text = decoder.decode(chunk, { stream: true });
      if (!eventStream) {
        if (jsonBytes < MAX_JSON_CAPTURE_BYTES) {
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
        const usageOnly = scanSseFrame(frame, entry);
        if (!usageOnly || !dropUsageOnlyFrames) forwarded.push(frame);
      }
      return forwarded;
    };
    const finish = () => {
      if (!entry.pending) return;
      if (eventStream) {
        if (buffer) scanSseFrame(buffer, entry);
      } else {
        const payload = parseJsonObject(buffer);
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
      },
      cancel() { finish(); }
    }));

    return {
      ok: upstream.ok,
      status: upstream.status,
      headers: upstream.headers,
      body: monitored,
      text: () => new Response(monitored).text(),
      json: () => new Response(monitored).json()
    };
  }

  snapshot() {
    return [...this.#entries].reverse().map(({ startedAt, ...entry }) => entry);
  }

  #finalize(entry) {
    if (!entry.pending) return;
    entry.pending = false;
    entry.completedAt = new Date().toISOString();
    entry.durationMs = Math.max(0, this.now() - entry.startedAt);
    this.#entries.push(entry);
    if (this.#entries.length > this.#maxEntries) this.#entries.splice(0, this.#entries.length - this.#maxEntries);
  }
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
  // Anthropic streams report usage on message_start/message_delta; OpenAI chunks
  // and Responses events carry a usage object on the frame itself.
  const merged = mergeUsage(entry, event.usage);
  mergeUsage(entry, event.message?.usage);
  mergeUsage(entry, event.response?.usage);
  mergeUsage(entry, event);
  return merged && Array.isArray(event.choices) && event.choices.length === 0;
}

function mergeUsage(entry, usage) {
  if (!usage || typeof usage !== "object") return false;
  const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens;
  const output = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens;
  const cacheRead = usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cacheReadTokens;
  const cacheWrite = usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens ?? usage.cacheWriteTokens;
  const found = [input, output, cacheRead, cacheWrite].some((value) => Number.isFinite(value));
  assignTokens(entry, "inputTokens", input);
  assignTokens(entry, "outputTokens", output);
  assignTokens(entry, "cacheReadTokens", cacheRead);
  assignTokens(entry, "cacheWriteTokens", cacheWrite);
  return found;
}

// A streamed usage object is cumulative and often omits counts it already reported by
// sending a zero, so a later frame must never talk a count back down.
function assignTokens(entry, key, value) {
  if (!Number.isFinite(value) || value < 0) return;
  if (entry[key] === null || value > entry[key]) entry[key] = value;
}

// Normalised so the console never has to render a vendor's raw English keyword.
function reasoningEffort(value) {
  if (!value || typeof value !== "object") return null;
  const effort = firstString(value.reasoning_effort, value.reasoning?.effort, value.thinking?.effort);
  if (effort) return effort.toLowerCase();
  const thinking = value.thinking;
  if (thinking && typeof thinking === "object") {
    if (thinking.type === "disabled" || thinking.enabled === false) return "none";
    if (Number.isFinite(thinking.budget_tokens)) return `budget:${Math.floor(thinking.budget_tokens)}`;
    if (typeof thinking.type === "string" && thinking.type.trim()) return thinking.type.trim().toLowerCase();
    if (thinking.enabled === true) return "on";
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
