import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { validateChatRequest } from "./protocol-validation.js";
import { MAX_RESPONSE_BYTES, MAX_SSE_FRAME_BYTES, ResponseState } from "./response-state.js";
import { isRelayErrorEvent, relayErrorDetails, relayStreamError } from "./relay-errors.js";

const MAX_RESPONSE_PREFIX_BYTES = 1024;
const SSE_PREFIXES = ["event:", "data:", "id:", "retry:", ":"];

export function chatToResponsesRequest(chat) {
  const error = validateChatRequest(chat);
  if (error) return { ok: false, message: error };
  const request = { model: chat.model, input: [], stream: chat.stream === true };
  const instructions = [];
  for (const message of chat.messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system" || message.role === "developer") {
      const text = typeof message.content === "string" ? message.content : (Array.isArray(message.content) ? message.content : []).map((part) => part?.text || "").join("\n");
      if (request.input.length) request.input.push({ type: "message", role: message.role, content: [{ type: "input_text", text }] });
      else instructions.push(text);
      continue;
    }
    if (message.role === "tool") {
      request.input.push({ type: "function_call_output", call_id: message.tool_call_id, output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "") });
      continue;
    }
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    const parts = (Array.isArray(content) ? content : []).flatMap((part) => {
      if (part.type === "text") return [{ type: message.role === "assistant" ? "output_text" : "input_text", text: part.text }];
      if (part.type === "image_url" && message.role !== "assistant") return [{ type: "input_image", image_url: part.image_url.url, ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) }];
      return [];
    });
    if (parts.length) request.input.push({ type: "message", role: message.role, content: parts });
    for (const call of message.tool_calls || []) {
      if (call.type === "function") request.input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments || "{}" });
    }
  }
  if (!request.input.length) return { ok: false, message: "At least one input message is required." };
  request.instructions = instructions.join("\n\n");
  if (Array.isArray(chat.tools)) {
    request.tools = chat.tools.filter((tool) => tool?.type === "function" && tool.function).map((tool) => ({ type: "function", ...tool.function, parameters: tool.function.parameters ?? { type: "object", properties: {} }, strict: tool.function.strict ?? false }));
  }
  if (chat.tool_choice !== undefined) {
    request.tool_choice = chat.tool_choice?.type === "function" ? { type: "function", name: chat.tool_choice.function.name } : chat.tool_choice;
  }
  for (const field of ["parallel_tool_calls", "reasoning", "reasoning_effort", "thinking", "output_config", "prompt_cache_key"]) {
    if (chat[field] !== undefined) request[field] = chat[field];
  }
  const disabled = chat.thinking?.type === "disabled" || chat.thinking?.enabled === false
    || ["none", "off"].includes(String(chat.reasoning_effort ?? chat.reasoning?.effort ?? chat.output_config?.effort ?? "").trim().toLowerCase());
  if (!disabled && request.reasoning?.summary === undefined) request.reasoning = { ...request.reasoning, summary: "auto" };
  if (chat.response_format) {
    request.text = { format: chat.response_format.type === "json_schema" ? { type: "json_schema", ...chat.response_format.json_schema } : chat.response_format };
  }
  return { ok: true, request };
}

export function frameEvent(frame) {
  const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    const event = JSON.parse(data);
    const name = frame.split(/\r?\n/).findLast((line) => line.startsWith("event:"))?.slice(6).trim();
    if (event && typeof event === "object" && !Array.isArray(event) && !event.type && name) return { ...event, type: name };
    return event;
  }
  catch (error) {
    const lines = frame.split(/\r?\n/);
    const start = lines.findIndex((line) => line.startsWith("data:"));
    const continuation = lines.slice(start + 1);
    if (data.trim() !== "{" || continuation.some((line) => /^(data|event|id|retry):|^:/.test(line))) throw error;
    const event = JSON.parse([lines[start].slice(5).trimStart(), ...continuation].join("\n"));
    if (event?.type !== "error" && event?.type !== "response.failed") throw error;
    return event;
  }
}

async function* responseFrames(body, { maxFrameBytes = MAX_SSE_FRAME_BYTES } = {}) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let separator;
    while ((separator = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, separator.index);
      if (Buffer.byteLength(frame) > maxFrameBytes) throw new Error("The upstream SSE frame exceeds the size limit.");
      buffer = buffer.slice(separator.index + separator[0].length);
      yield { frame, separator: separator[0] };
    }
    if (Buffer.byteLength(buffer) > maxFrameBytes) throw new Error("The upstream SSE frame exceeds the size limit.");
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    yield { frame: buffer, separator: "" };
  }
}

export async function* responseEvents(body, options) {
  for await (const { frame } of responseFrames(body, options)) {
    const event = frameEvent(frame);
    if (event) yield event;
    else if (options?.includeHeartbeats && frame.split(/\r?\n/).some((line) => line.startsWith(":"))) yield { type: "ping" };
  }
}

export function normalizeResponsesStream(upstream, { restoreEvent = (event) => event, finalize = null, ...limits } = {}) {
  if (!upstream.ok || !upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream")) return upstream;
  const stream = Readable.from(normalizedResponseChunks(upstream.body, restoreEvent, finalize, limits), { objectMode: false });
  return new Response(Readable.toWeb(stream), { status: upstream.status, headers: upstream.headers });
}

export async function primeResponsesStream(upstream, { maxWaitMs = 250, waitForCompletion = false, maxBytes = MAX_RESPONSE_BYTES, maxFrameBytes = MAX_SSE_FRAME_BYTES } = {}) {
  if (!upstream.body) throw Object.assign(new Error("The upstream Responses stream has no body."), { code: "upstream_empty_stream" });
  if (!upstream.headers.get("content-type")?.includes("text/event-stream")) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of upstream.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw Object.assign(new Error("The upstream response exceeds the size limit."), { code: "upstream_invalid_stream" });
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (!body.toString("utf8").trim()) throw Object.assign(new Error("The upstream Responses stream has no body."), { code: "upstream_empty_stream" });
    return new Response(body, { status: upstream.status, headers: upstream.headers });
  }
  const reader = upstream.body.getReader();
  const frames = responseFrames({
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) return;
          yield result.value;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }, { maxFrameBytes });
  const buffered = [];
  let bytes = 0;
  let pendingFrame;
  let hasOutput = false;
  let completed = false;
  let timer;
  const elapsed = Symbol("preflight elapsed");
  const deadline = new Promise((resolve) => {
    if (!waitForCompletion && Number.isFinite(maxWaitMs)) timer = setTimeout(() => resolve(elapsed), Math.max(0, maxWaitMs));
  });
  try {
    while (true) {
      pendingFrame = frames.next();
      const result = await Promise.race([pendingFrame, deadline]);
      if (result === elapsed) break;
      pendingFrame = null;
      if (result.done) throw Object.assign(new Error(hasOutput ? "The upstream Responses stream ended without a final response." : "The upstream Responses stream ended without output."), { code: hasOutput ? "upstream_stream_incomplete" : "upstream_empty_stream" });
      const { frame, separator } = result.value;
      bytes += Buffer.byteLength(frame + separator);
      if (bytes > maxBytes || (!waitForCompletion && bytes > maxFrameBytes)) throw Object.assign(new Error("The upstream Responses stream buffer exceeds the size limit."), { code: "upstream_invalid_stream" });
      buffered.push(frame + separator);
      if (frame.split(/\r?\n/).some((line) => /^data:\s*\[DONE\]\s*$/.test(line))) {
        throw Object.assign(new Error(hasOutput ? "The upstream Responses stream ended without a final response." : "The upstream Responses stream ended without output."), { code: hasOutput ? "upstream_stream_incomplete" : "upstream_empty_stream" });
      }
      const event = frameEvent(frame);
      if (!event) continue;
      if (isRelayErrorEvent(event)) throw relayStreamError(event);
      if (responsesEventHasOutput(event)) {
        hasOutput = true;
        if (!waitForCompletion) break;
      }
      if (event.type === "response.completed" && !hasOutput) throw Object.assign(new Error("The upstream Responses stream completed without output."), { code: "upstream_empty_stream" });
      if (["response.completed", "response.incomplete"].includes(event.type)) {
        if (waitForCompletion && (!event.response || typeof event.response !== "object" || Array.isArray(event.response))) {
          throw Object.assign(new Error("The upstream Responses terminal event has no valid response."), { code: "upstream_invalid_stream" });
        }
        hasOutput = true;
        completed = waitForCompletion;
        break;
      }
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    void frames.return().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (completed) {
    void reader.cancel().catch(() => {});
    void frames.return().catch(() => {});
  }
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      for (const frame of buffered) controller.enqueue(Buffer.from(frame));
      if (completed) controller.close();
    },
    async pull(controller) {
      try {
        const result = await (pendingFrame || frames.next());
        pendingFrame = null;
        if (cancelled) return;
        if (result.done) {
          if (!hasOutput) throw Object.assign(new Error("The upstream Responses stream ended without output."), { code: "upstream_empty_stream" });
          controller.close();
        } else {
          const { frame, separator } = result.value;
          const event = frameEvent(frame);
          if (event && (responsesEventHasOutput(event) || event.type === "response.incomplete")) hasOutput = true;
          if (!hasOutput && (event?.type === "response.completed" || frame.split(/\r?\n/).some((line) => /^data:\s*\[DONE\]\s*$/.test(line)))) {
            throw Object.assign(new Error("The upstream Responses stream ended without output."), { code: "upstream_empty_stream" });
          }
          controller.enqueue(Buffer.from(frame + separator));
        }
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        await frames.return();
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason).catch(() => {});
      await frames.return();
    }
  });
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, { status: upstream.status, headers });
}

function responsesEventHasOutput(event) {
  const hasText = (value) => typeof value === "string" && value.trim().length > 0;
  const hasOutput = (item) => {
    if (!item || typeof item !== "object") return false;
    if (Array.isArray(item)) return item.some(hasOutput);
    if ([item.text, item.refusal, item.encrypted_content].some(hasText)) return true;
    if (item.type?.endsWith("_call") && (item.id || item.call_id || item.name)) return true;
    return hasOutput(item.content) || hasOutput(item.summary);
  };
  return (event.type?.endsWith(".delta") && hasText(event.delta))
    || (["response.output_text.done", "response.refusal.done"].includes(event.type) && (hasText(event.text) || hasText(event.refusal)))
    || hasOutput(event.item) || hasOutput(event.part)
    || (["response.completed", "response.incomplete"].includes(event.type) && hasOutput(event.response?.output));
}

async function* normalizedResponseChunks(body, restoreEvent, finalize, limits = {}) {
  const state = new ResponseState(limits);
  try {
    for await (const { frame, separator } of responseFrames(body, limits)) {
      const event = frameEvent(frame);
      let repaired = event ? restoreEvent(state.accept(event)) : null;
      // Commit restored history before delivering the terminal frame: the next request may
      // arrive as soon as the caller reads it. Never commit a created or partial envelope.
      if (state.terminal && repaired?.response && finalize) repaired = { ...repaired, response: finalize(repaired.response, repaired.type) };
      yield (JSON.stringify(repaired) !== JSON.stringify(event)
        ? frame.split(/\r?\n/).filter((line) => !line.startsWith("data:")).concat(`data: ${JSON.stringify(repaired)}`).join("\n")
        : frame) + separator;
      if (state.terminal) return;
    }
    throw Object.assign(new Error("The upstream Responses stream ended without a final response."), { code: "upstream_stream_incomplete" });
  } catch (error) {
    const code = ["upstream_stream_timeout", "upstream_stream_incomplete", "response_history_limit"].includes(error.code) ? error.code : "upstream_stream_error";
    const message = code === "upstream_stream_timeout" ? "The upstream stream was idle too long; no new data arrived before the timeout."
      : code === "upstream_stream_incomplete" ? "The upstream stream ended without a final response."
      : code === "response_history_limit" ? "The response history exceeds the local cache limit; resend complete history with store:false." : "The upstream response stream failed.";
    yield `event: error\ndata: ${JSON.stringify({ type: "error", code, message, param: null })}\n\n`;
  }
}

export function responsesUpstreamAsChat(upstream, model, { commentaryAsReasoning = false, ...limits } = {}) {
  if (!upstream.ok || !upstream.body) return upstream;
  const stream = Readable.from(chatChunks(upstream, model, { commentaryAsReasoning, ...limits }), { objectMode: false });
  return new Response(Readable.toWeb(stream), { status: upstream.status, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

export async function normalizeResponsesContentType(upstream) {
  if (!upstream.ok || !upstream.body || upstream.headers.get("content-type")?.includes("text/event-stream")) return upstream;
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let prefix = "";
  let bytes = 0;
  let eventStream = false;
  try {
    while (bytes < MAX_RESPONSE_PREFIX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value.byteLength) continue;
      chunks.push(value);
      prefix += decoder.decode(value.subarray(0, MAX_RESPONSE_PREFIX_BYTES - bytes), { stream: true });
      bytes += value.byteLength;
      const text = prefix.trimStart();
      eventStream = SSE_PREFIXES.some((field) => text.startsWith(field));
      if (eventStream || (text && !SSE_PREFIXES.some((field) => field.startsWith(text)))) break;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    reader.releaseLock();
    throw error;
  }
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { reader.releaseLock(); }
    }
  });
  const headers = new Headers(upstream.headers);
  if (eventStream) headers.set("content-type", "text/event-stream; charset=utf-8");
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

async function* chatChunks(upstream, model, { commentaryAsReasoning, maxBytes = MAX_RESPONSE_BYTES, maxFrameBytes = MAX_SSE_FRAME_BYTES }) {
  let id = `chatcmpl_${randomUUID().replace(/-/g, "")}`;
  const tools = new Map();
  const texts = new Map();
  const citedUrls = new Set();
  const citedRanges = new Set();
  const contentSpans = new Map();
  let contentLength = 0;
  const emittedImages = new Set();
  let completed = false;
  const state = new ResponseState({ maxBytes });
  let aggregateBytes = 0;
  function account(value) {
    aggregateBytes += Buffer.byteLength(value);
    if (aggregateBytes > maxBytes) throw new Error("The upstream response exceeds the aggregate size limit.");
  }
  function chunk(delta, finishReason = null, usage) {
    return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`;
  }
  function textDelta(key, field, value, final = false) {
    const previous = texts.get(key) || "";
    const delta = final ? value.startsWith(previous) ? value.slice(previous.length) : "" : value;
    account(delta);
    texts.set(key, previous + delta);
    if (field === "content" && delta) {
      const spans = contentSpans.get(key) || [];
      spans.push({ local: previous.length, global: contentLength, length: delta.length });
      contentSpans.set(key, spans);
      contentLength += delta.length;
    }
    return delta ? chunk({ [field]: delta }) : "";
  }
  function messageTextField(key, item = state.byId.get(key)?.item ?? state.byIndex.get(key)?.item) {
    return commentaryAsReasoning && item?.phase === "commentary" ? "reasoning_content" : "content";
  }
  function toolDelta(key, item, argumentsDelta, final = false) {
    let tool = tools.get(key);
    let result = "";
    if (!tool) {
      if (!item?.name || !item?.call_id) return "";
      tool = { index: tools.size, arguments: "" };
      tools.set(key, tool);
      result = chunk({ tool_calls: [{ index: tool.index, id: item.call_id, type: "function", function: { name: item.name, arguments: "" } }] });
    }
    const value = typeof argumentsDelta === "string" ? argumentsDelta : "";
    const delta = final ? value.startsWith(tool.arguments) ? value.slice(tool.arguments.length) : "" : value;
    if (delta) {
      account(delta);
      tool.arguments += delta;
      result += chunk({ tool_calls: [{ index: tool.index, function: { arguments: delta } }] });
    }
    return result;
  }
  function finalItem(item, index) {
    const key = item.id ?? index;
    if (item.type === "image_generation_call") {
      if (emittedImages.has(key)) return "";
      if (item.status !== "completed" || typeof item.result !== "string" || !item.result) throw new Error("The upstream image tool returned no completed image.");
      emittedImages.add(key);
      const format = item.output_format || "png";
      if (!["png", "jpeg", "webp"].includes(format)) throw new Error("Unsupported generated image format.");
      const value = `\n\n![Generated image](data:image/${format};base64,${item.result})`;
      account(value);
      contentLength += value.length;
      let result = "";
      for (let offset = 0; offset < value.length; offset += 16384) result += chunk({ content: value.slice(offset, offset + 16384) });
      return result;
    }
    if (item.type === "function_call") return toolDelta(key, item, item.arguments, true);
    if (item.type === "message") {
      let result = (item.content || []).map((part, partIndex) => part.type === "output_text" ? textDelta(`${key}:text:${partIndex}`, messageTextField(key, item), part.text || "", true) : part.type === "refusal" ? textDelta(`${key}:refusal:${partIndex}`, "refusal", part.refusal || "", true) : "").join("");
      const sources = [];
      const annotations = [];
      for (const [partIndex, part] of (item.content || []).entries()) {
        for (const annotation of part.annotations || []) {
          if (annotation?.type !== "url_citation" || typeof annotation.url !== "string") continue;
          let url;
          try { url = new URL(annotation.url); } catch { continue; }
          if (!["https:", "http:"].includes(url.protocol)) continue;
          const start = annotation.start_index;
          const end = annotation.end_index;
          const spans = contentSpans.get(`${key}:text:${partIndex}`) || [];
          const covered = spans.filter((span) => span.local < end && span.local + span.length > start);
          if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= (texts.get(`${key}:text:${partIndex}`) || "").length && covered.length && covered.every((span) => span.global - span.local === covered[0].global - covered[0].local)) {
            const offset = covered[0].global - covered[0].local;
            const citation = { type: "url_citation", url_citation: { url: annotation.url, title: typeof annotation.title === "string" ? annotation.title : url.hostname, start_index: start + offset, end_index: end + offset } };
            const identity = JSON.stringify(citation);
            if (!citedRanges.has(identity)) {
              citedRanges.add(identity);
              annotations.push(citation);
            }
          }
          if (citedUrls.has(annotation.url)) continue;
          citedUrls.add(annotation.url);
          const title = String(annotation.title || url.hostname).replace(/[\[\]\\<>\r\n]/g, " ");
          sources.push(`- [${title}](<${url.href.replace(/</g, "%3C").replace(/>/g, "%3E")}>)`);
        }
      }
      if (annotations.length) result += chunk({ annotations });
      if (sources.length) result += textDelta(`${key}:sources`, "content", `\n\nSources:\n${sources.join("\n")}`);
      return result;
    }
    if (item.type === "reasoning") {
      const summary = item.summary?.length > 0;
      return (summary ? item.summary : item.content || []).map((part, partIndex) => textDelta(`${key}:${summary ? "reasoning" : "reasoning_text"}:${partIndex}`, "reasoning_content", part.text || "", true)).join("");
    }
    return "";
  }
  try {
    upstream = await normalizeResponsesContentType(upstream);
    const events = upstream.headers.get("content-type")?.includes("text/event-stream") ? responseEvents(upstream.body, { includeHeartbeats: true, maxBytes, maxFrameBytes }) : [{ type: "response.completed", response: await upstream.json() }];
    let started = false;
    for await (const incoming of events) {
      if (isRelayErrorEvent(incoming)) throw relayStreamError(incoming);
      const event = state.accept(incoming);
      if (!event) continue;
      if (!started) {
        if (event.response?.id) id = event.response.id;
        yield chunk({ role: "assistant", content: "" });
        started = true;
      }
      const key = event.item_id ?? event.item?.id ?? event.output_index;
      if (event.type === "response.output_item.added" && event.item?.type === "function_call") yield toolDelta(key, event.item, event.item.arguments);
      else if (event.type === "response.function_call_arguments.delta") yield toolDelta(key, null, event.delta);
      else if (event.type === "response.function_call_arguments.done") yield toolDelta(key, null, event.arguments, true);
      else if (event.type === "response.output_text.delta") yield textDelta(`${key}:text:${event.content_index ?? 0}`, messageTextField(key), event.delta);
      else if (event.type === "response.output_text.done") yield textDelta(`${key}:text:${event.content_index ?? 0}`, messageTextField(key), event.text || "", true);
      else if (event.type === "response.refusal.delta") yield textDelta(`${key}:refusal:${event.content_index ?? 0}`, "refusal", event.delta);
      else if (event.type === "response.refusal.done") yield textDelta(`${key}:refusal:${event.content_index ?? 0}`, "refusal", event.refusal || "", true);
      else if (["response.content_part.added", "response.content_part.done"].includes(event.type) && event.part?.type === "output_text") yield textDelta(`${key}:text:${event.content_index ?? 0}`, messageTextField(key), event.part.text || "", true);
      else if (["response.content_part.added", "response.content_part.done"].includes(event.type) && event.part?.type === "refusal") yield textDelta(`${key}:refusal:${event.content_index ?? 0}`, "refusal", event.part.refusal || "", true);
      else if (event.type === "response.reasoning_summary_text.delta") yield textDelta(`${key}:reasoning:${event.summary_index ?? 0}`, "reasoning_content", event.delta);
      else if (event.type === "response.reasoning_summary_text.done") yield textDelta(`${key}:reasoning:${event.summary_index ?? 0}`, "reasoning_content", event.text, true);
      else if (event.type === "response.reasoning_text.delta") yield textDelta(`${key}:reasoning_text:${event.content_index ?? 0}`, "reasoning_content", event.delta);
      else if (event.type === "response.reasoning_text.done") yield textDelta(`${key}:reasoning_text:${event.content_index ?? 0}`, "reasoning_content", event.text, true);
      else if (event.type === "response.output_item.done") yield finalItem(event.item, event.output_index);
      else if (event.type === "response.completed" || event.type === "response.incomplete") {
        const envelope = event.response || {};
        for (const [index, item] of (envelope.output || []).entries()) yield finalItem(item, index);
        const usage = envelope.usage;
        yield chunk({}, event.type === "response.incomplete" ? "length" : tools.size ? "tool_calls" : "stop", usage ? {
          prompt_tokens: usage.input_tokens || 0,
          completion_tokens: usage.output_tokens || 0,
          total_tokens: usage.total_tokens ?? (usage.input_tokens || 0) + (usage.output_tokens || 0),
          ...(usage.input_tokens_details ? { prompt_tokens_details: usage.input_tokens_details } : {}),
          ...(usage.output_tokens_details ? { completion_tokens_details: usage.output_tokens_details } : {})
        } : undefined);
        completed = true;
        break;
      }
      else yield ": ping\n\n";
    }
    if (!completed) throw new Error("The upstream Responses stream ended without a final response.");
  } catch (error) {
    yield `data: ${JSON.stringify({ error: relayErrorDetails(relayStreamError(error)) })}\n\n`;
  }
  yield "data: [DONE]\n\n";
}
