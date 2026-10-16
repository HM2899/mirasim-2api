import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { ThinkTagFilter, splitThinkTags } from "./think-tags.js";
import { MAX_SSE_FRAME_BYTES } from "./response-state.js";
import { pipeWithCancellation } from "./stream-lifecycle.js";
import { normalizeChatUsage } from "./chat-usage.js";

const MAX_COMPLETION_BYTES = 16 * 1024 * 1024;

function normalizeReasoning(message, pieces, reasoningPieces = null) {
  const result = { ...message };
  const hasReasoningContent = typeof result.reasoning_content === "string";
  const hasReasoning = typeof result.reasoning === "string";
  const rawReasoning = hasReasoningContent ? result.reasoning_content : hasReasoning ? result.reasoning : "";
  // Some DeepSeek variants wrap their native `reasoning_content` in <think> tags too. It is
  // already the reasoning channel, so markers have no semantic value there and must never leak
  // into a client that renders that field. A supplied empty array is meaningful: it may be a
  // partial tag held until the next SSE frame, so do not fall back to its raw fragment.
  const reasoning = reasoningPieces === null
    ? stripThinkMarkers(rawReasoning)
    : stripThinkMarkers(reasoningPieces.map((piece) => piece.text).join(""));
  if (hasReasoningContent) delete result.reasoning_content;
  if (hasReasoning) delete result.reasoning;
  const thinking = pieces.filter((piece) => piece.type === "thinking").map((piece) => piece.text).join("");
  if (reasoning || thinking) result.reasoning_content = reasoning + thinking;
  if (typeof result.content === "string" || pieces.some((piece) => piece.type === "text")) {
    result.content = pieces.filter((piece) => piece.type === "text").map((piece) => piece.text).join("");
  }
  return result;
}

function stripThinkMarkers(value) {
  return typeof value === "string" ? value.replace(/<\/?think>/gi, "") : "";
}

export async function normalizeChatUpstream(upstream) {
  if (!upstream.ok || !upstream.body) return upstream;
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  if (!headers.get("content-type")?.includes("text/event-stream")) {
    const raw = await upstream.text();
    let completion;
    try { completion = JSON.parse(raw); } catch { return new Response(raw, { status: upstream.status, headers }); }
    if (completion.usage) completion.usage = normalizeChatUsage(completion.usage);
    for (const choice of completion.choices || []) {
      if (!choice.message) continue;
      const originalContent = choice.message.content;
      const split = splitThinkTags(originalContent);
      const pieces = typeof choice.message.content === "string" ? [{ type: "thinking", text: split.thinking }, { type: "text", text: split.text }] : [];
      choice.message = normalizeReasoning(choice.message, pieces);
      if (choice.message.content !== originalContent) delete choice.message.annotations;
    }
    return new Response(JSON.stringify(completion), { status: upstream.status, headers });
  }
  const filters = new Map();
  const reasoningFilters = new Map();
  const citationStates = new Map();
  function citationDelta(index, pieces, message = {}, final = false) {
    let state = citationStates.get(index);
    if (!state) citationStates.set(index, state = { input: 0, output: 0, annotations: new Map(), bytes: 0 });
    state.input += typeof message.content === "string" ? message.content.length : 0;
    state.output += pieces.filter((piece) => piece.type === "text").reduce((total, piece) => total + piece.text.length, 0);
    for (const annotation of Array.isArray(message.annotations) ? message.annotations : []) {
      const key = JSON.stringify(annotation);
      if (!state.annotations.has(key)) {
        state.bytes += Buffer.byteLength(key);
        if (state.bytes > MAX_SSE_FRAME_BYTES) throw new Error("The upstream annotations exceed the size limit.");
        state.annotations.set(key, annotation);
      }
    }
    if (!final) return {};
    const annotations = state.input === state.output ? [...state.annotations.values()] : [];
    state.annotations.clear();
    state.bytes = 0;
    return annotations.length ? { annotations } : {};
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let envelope = {};
  let done = false;
  function flushThinking() {
    const choices = [];
    for (const [index, filter] of filters) {
      const pieces = filter.end();
      const reasoningPieces = reasoningFilters.get(index)?.end() || [];
      const annotations = citationDelta(index, pieces, {}, true);
      if (pieces.length || reasoningPieces.length || annotations.annotations) choices.push({ index, delta: { ...normalizeReasoning({}, pieces, reasoningPieces), ...annotations }, finish_reason: null });
    }
    return choices.length ? `data: ${JSON.stringify({ ...envelope, choices })}\n\n` : "";
  }
  function frame(value) {
    if (done) return "";
    if (Buffer.byteLength(value) > MAX_SSE_FRAME_BYTES) throw new Error("The upstream SSE frame exceeds the size limit.");
    const data = eventData(value);
    if (!data) return value + "\n\n";
    if (data === "[DONE]") {
      done = true;
      return flushThinking() + "data: [DONE]\n\n";
    }
    const chunk = JSON.parse(data);
    if (chunk.usage) chunk.usage = normalizeChatUsage(chunk.usage);
    if (chunk.object === "chat.completion") chunk.object = "chat.completion.chunk";
    const { choices, usage, ...metadata } = chunk;
    envelope = { ...envelope, ...metadata };
    for (const choice of choices || []) {
      const index = choice.index ?? 0;
      let filter = filters.get(index);
      if (!filter) filters.set(index, filter = new ThinkTagFilter());
      let reasoningFilter = reasoningFilters.get(index);
      if (!reasoningFilter) reasoningFilters.set(index, reasoningFilter = new ThinkTagFilter());
      const field = choice.delta ? "delta" : "message";
      const message = choice[field] || {};
      const pieces = filter.push(message.content);
      const nativeReasoning = typeof message.reasoning_content === "string" ? message.reasoning_content
        : typeof message.reasoning === "string" ? message.reasoning : null;
      const reasoningPieces = nativeReasoning === null ? null : reasoningFilter.push(nativeReasoning);
      if (choice.finish_reason) {
        pieces.push(...filter.end());
        if (reasoningPieces) reasoningPieces.push(...reasoningFilter.end());
      }
      const normalized = normalizeReasoning(message, pieces, reasoningPieces);
      delete normalized.annotations;
      Object.assign(normalized, citationDelta(index, pieces, message, Boolean(choice.finish_reason)));
      if (field === "message") {
        if (Array.isArray(normalized.tool_calls)) normalized.tool_calls = normalized.tool_calls.map((call, toolIndex) => ({ ...call, index: call.index ?? toolIndex }));
        delete choice.message;
      }
      choice.delta = normalized;
    }
    return value.split(/\r?\n/).filter((line) => !line.startsWith("data:")).concat(`data: ${JSON.stringify(chunk)}`).join("\n") + "\n\n";
  }
  const transform = new Transform({
    transform(chunk, encoding, callback) {
      try {
        buffer += decoder.decode(chunk, { stream: true });
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          this.push(frame(buffer.slice(0, separator.index)));
          buffer = buffer.slice(separator.index + separator[0].length);
        }
        if (Buffer.byteLength(buffer) > MAX_SSE_FRAME_BYTES) throw new Error("The upstream SSE frame exceeds the size limit.");
        if (done) {
          buffer = "";
          this.push(null);
        }
        callback();
      } catch (error) { callback(error); }
    },
    flush(callback) {
      try {
        buffer += decoder.decode();
        if (buffer.trim()) this.push(frame(buffer));
        if (!done) this.push(flushThinking());
        callback();
      } catch (error) { callback(error); }
    }
  });
  return new Response(Readable.toWeb(pipeWithCancellation(Readable.fromWeb(upstream.body), transform)), { status: upstream.status, headers });
}

// Some chat-backed relays accept `stream: true` but still answer a completed JSON object. Keep
// the client's requested wire contract by spelling that object as ordinary Chat Completions SSE
// frames instead of handing a streaming SDK one late JSON payload. This cannot invent token
// timing the upstream did not send, but it prevents the gateway from adding its own buffering.
export async function ensureChatCompletionStream(upstream) {
  if (!upstream.ok || !upstream.body || upstream.headers.get("content-type")?.includes("text/event-stream")) return upstream;
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  let raw;
  let completion;
  try {
    raw = await upstream.text();
    completion = JSON.parse(raw);
  } catch {
    return new Response(raw || null, { status: upstream.status, statusText: upstream.statusText, headers });
  }
  if (!completion || !Array.isArray(completion.choices)) return new Response(raw, { status: upstream.status, statusText: upstream.statusText, headers });
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache, no-transform");
  return new Response(chatCompletionEvents(completion), { status: upstream.status, headers });
}

function chatCompletionEvents(completion) {
  const envelope = {};
  for (const field of ["id", "object", "created", "model", "system_fingerprint", "service_tier"]) {
    if (completion[field] !== undefined) envelope[field] = completion[field];
  }
  if (!envelope.id) envelope.id = `chatcmpl_${randomUUID().replace(/-/g, "")}`;
  envelope.object = "chat.completion.chunk";
  if (!Number.isFinite(envelope.created)) envelope.created = Math.floor(Date.now() / 1000);
  const frame = (choices, usage) => `data: ${JSON.stringify({ ...envelope, choices, ...(usage ? { usage } : {}) })}\n\n`;
  const events = [];
  const final = [];
  for (const [offset, choice] of completion.choices.entries()) {
    const index = Number.isInteger(choice?.index) ? choice.index : offset;
    const message = choice?.message && typeof choice.message === "object" ? choice.message : choice?.delta || {};
    events.push(frame([{ index, delta: { role: message.role || "assistant", content: "" }, finish_reason: null }]));
    if (Array.isArray(message.annotations) && message.annotations.length) events.push(frame([{ index, delta: { annotations: message.annotations }, finish_reason: null }]));
    for (const field of ["reasoning_content", "content", "refusal"]) {
      if (typeof message[field] === "string" && message[field]) events.push(frame([{ index, delta: { [field]: message[field] }, finish_reason: null }]));
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      events.push(frame([{
        index,
        delta: {
          tool_calls: message.tool_calls.map((call, toolIndex) => ({
            index: Number.isInteger(call?.index) ? call.index : toolIndex,
            ...(call?.id ? { id: call.id } : {}),
            ...(call?.type ? { type: call.type } : {}),
            ...(call?.function ? { function: call.function } : {})
          }))
        },
        finish_reason: null
      }]));
    }
    final.push({ index, delta: {}, finish_reason: typeof choice?.finish_reason === "string" ? choice.finish_reason : "stop" });
  }
  if (final.length) events.push(frame(final));
  if (completion.usage && typeof completion.usage === "object") events.push(frame([], completion.usage));
  events.push("data: [DONE]\n\n");
  return events.join("");
}

export async function readChatCompletion(upstream, limits = {}) {
  if (!upstream.headers?.get?.("content-type")?.includes("text/event-stream")) {
    return upstream.json();
  }
  const completion = { object: "chat.completion", choices: [] };
  const choices = new Map();
  let done = false;
  for await (const data of streamData(upstream.body, limits)) {
    if (data === "[DONE]") {
      done = true;
      break;
    }
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error(chunk.error.message || "The upstream chat stream reported an error.");
    for (const field of ["id", "created", "model", "system_fingerprint", "service_tier"]) {
      if (chunk[field] !== undefined) completion[field] = chunk[field];
    }
    if (chunk.usage) completion.usage = mergeUsage(completion.usage, chunk.usage);
    for (const part of Array.isArray(chunk.choices) ? chunk.choices : []) {
      const index = Number.isInteger(part.index) ? part.index : 0;
      let choice = choices.get(index);
      if (!choice) {
        choice = { index, message: { role: "assistant", content: null }, finish_reason: null, tools: new Map() };
        choices.set(index, choice);
      }
      const delta = part.delta || part.message || {};
      if (Array.isArray(delta.annotations)) {
        const annotations = choice.message.annotations ||= [];
        const seen = new Set(annotations.map((annotation) => JSON.stringify(annotation)));
        for (const annotation of delta.annotations) {
          const identity = JSON.stringify(annotation);
          if (!seen.has(identity)) { annotations.push(annotation); seen.add(identity); }
        }
      }
      for (const field of ["content", "reasoning_content", "refusal"]) {
        if (typeof delta[field] === "string") choice.message[field] = (choice.message[field] || "") + delta[field];
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const slot = Number.isInteger(call.index) ? call.index : call.id || 0;
        let tool = choice.tools.get(slot);
        if (!tool) {
          tool = { type: "function", function: { name: "", arguments: "" } };
          choice.tools.set(slot, tool);
        }
        if (call.id) tool.id = call.id;
        if (call.type) tool.type = call.type;
        if (typeof call.function?.name === "string") {
          const name = call.function.name;
          tool.function.name = !tool.function.name || name.startsWith(tool.function.name) ? name : tool.function.name + name;
        }
        if (typeof call.function?.arguments === "string") tool.function.arguments += call.function.arguments;
      }
      if (part.finish_reason) choice.finish_reason = part.finish_reason;
    }
  }
  if (choices.size === 0) throw new Error("The upstream chat stream contained no completion choices.");
  if (!done && [...choices.values()].some((choice) => !choice.finish_reason)) {
    throw new Error("The upstream chat stream ended before it completed.");
  }
  completion.choices = [...choices.values()].sort((left, right) => left.index - right.index).map(({ tools, ...choice }) => {
    if (tools.size) {
      choice.message.tool_calls = [...tools.values()];
      // A stream opens with an empty content delta; a non-streaming tool-call turn with no
      // text says so with `null`, which is what a caller that asked for one object expects.
      if (choice.message.content === "") choice.message.content = null;
    }
    return choice;
  });
  if (!completion.choices.some(({ message }) => message.content || message.reasoning_content || message.refusal || message.tool_calls?.length)) {
    throw new Error("The upstream chat stream completed without text, reasoning or tool calls.");
  }
  return completion;
}

function mergeUsage(previous = {}, incoming) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (Number.isFinite(value)) merged[key] = Math.max(Number.isFinite(previous[key]) ? previous[key] : 0, value);
    else if (value && typeof value === "object" && !Array.isArray(value)) merged[key] = mergeUsage(previous[key], value);
  }
  return merged;
}

async function* streamData(body, { maxBytes = MAX_COMPLETION_BYTES } = {}) {
  if (!body) throw new Error("The upstream chat stream has no body.");
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error("The upstream chat stream exceeds the non-streaming response limit.");
    buffer += decoder.decode(chunk, { stream: true });
    let separator;
    while ((separator = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const data = eventData(frame);
      if (data) yield data;
    }
  }
  buffer += decoder.decode();
  const trailing = eventData(buffer);
  if (trailing) yield trailing;
}

function eventData(frame) {
  return frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
}
