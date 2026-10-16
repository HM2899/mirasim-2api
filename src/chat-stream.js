import { MAX_RESPONSE_BYTES, MAX_SSE_FRAME_BYTES } from "./response-state.js";
import { isRelayErrorEvent, relayErrorDetails, relayStreamError } from "./relay-errors.js";
import { frameEvent } from "./responses-bridge.js";

function streamError(code, message, type = "server_error") {
  return Object.assign(new Error(message), { code, type, statusCode: type === "invalid_request_error" ? 400 : undefined });
}

export function createProgressSignal() {
  const target = new EventTarget();
  let latestAt = 0;
  return {
    get latestAt() { return latestAt; },
    addEventListener(...args) { return target.addEventListener(...args); },
    removeEventListener(...args) { return target.removeEventListener(...args); },
    report(at = Date.now()) {
      if (!Number.isFinite(at)) return;
      latestAt = Math.max(latestAt, at);
      target.dispatchEvent(new Event("progress"));
    }
  };
}

export async function primeChatCompletionStream(upstream, { firstContentTimeoutMs = 300_000, progress = null, progressTimeoutMs = 300_000, maxBytes = MAX_RESPONSE_BYTES, maxFrameBytes = MAX_SSE_FRAME_BYTES } = {}) {
  if (!upstream.body) throw streamError("upstream_empty_stream", "The upstream chat stream has no body.");
  if (!upstream.headers.get("content-type")?.includes("text/event-stream")) {
    throw streamError("upstream_invalid_stream", "The upstream did not return a valid chat completion stream.");
  }
  const reader = upstream.body.getReader();
  const state = { hasContent: false, done: false, choices: new Map(), maxBytes, maxFrameBytes };
  const frames = checkedFrames(reader, state);
  const buffered = [];
  let bufferedBytes = 0;
  let timer;
  let expire;
  let deadline = Date.now() + firstContentTimeoutMs;
  const timeout = new Promise((resolve, reject) => { expire = reject; });
  function arm() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const error = streamError("upstream_stream_timeout", "The upstream chat stream did not produce content before the configured timeout.");
      expire(error);
      void reader.cancel(error).catch(() => {});
    }, Math.max(0, deadline - Date.now()));
  }
  // Progress the converted stream cannot show (hidden thinking) is reported out of band. Like a
  // forwarded stream's progress it buys one idle budget from the moment it arrives, never less
  // than what is left; it is never content, and a stream that stops reporting it still expires.
  function progressed() {
    const latestAt = Number.isFinite(progress?.latestAt) ? progress.latestAt : Date.now();
    const candidate = latestAt + progressTimeoutMs;
    if (deadline >= candidate) return;
    deadline = Math.max(Date.now(), candidate);
    arm();
  }
  arm();
  const renewable = Boolean(progress) && Number.isFinite(progressTimeoutMs) && progressTimeoutMs > 0;
  if (renewable) {
    progress.addEventListener("progress", progressed);
    if (progress.latestAt > 0) progressed();
  }
  try {
    while (!state.hasContent) {
      const result = await Promise.race([frames.next(), timeout]);
      if (result.done) throw streamError("upstream_empty_stream", "The upstream chat stream completed without text, reasoning or tool calls.");
      bufferedBytes += result.value.byteLength;
      if (bufferedBytes > maxFrameBytes) throw streamError("upstream_invalid_stream", "The upstream chat stream prefix exceeds the size limit.");
      buffered.push(result.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    await frames.return();
    throw error;
  } finally {
    clearTimeout(timer);
    if (renewable) progress.removeEventListener("progress", progressed);
  }
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      for (const frame of buffered) controller.enqueue(frame);
    },
    async pull(controller) {
      try {
        const result = await frames.next();
        if (cancelled) return;
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        if (cancelled) return;
        controller.enqueue(Buffer.from(`data: ${JSON.stringify({ error: relayErrorDetails(relayStreamError(error)) })}\n\ndata: [DONE]\n\n`));
        controller.close();
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

async function* checkedFrames(reader, state) {
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  try {
    while (!state.done) {
      const result = await reader.read();
      if (result.done) buffer += decoder.decode();
      else {
        bytes += result.value.byteLength;
        if (bytes > state.maxBytes) throw streamError("upstream_invalid_stream", "The upstream chat stream exceeds the size limit.");
        buffer += decoder.decode(result.value, { stream: true });
      }
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        yield checkFrame(frame, state);
        if (state.done) return;
      }
      if (Buffer.byteLength(buffer) > state.maxFrameBytes) throw streamError("upstream_invalid_stream", "The upstream SSE frame exceeds the size limit.");
      if (!result.done) continue;
      if (buffer.trim()) yield checkFrame(buffer, state);
      if (state.done) return;
      if (!state.hasContent) throw streamError("upstream_empty_stream", "The upstream chat stream completed without text, reasoning or tool calls.");
      if (!state.choices.size || [...state.choices.values()].some((finished) => !finished)) {
        throw streamError("upstream_stream_incomplete", "The upstream chat stream ended before it completed.");
      }
      yield Buffer.from("data: [DONE]\n\n");
      return;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function checkFrame(frame, state) {
  if (Buffer.byteLength(frame) > state.maxFrameBytes) throw streamError("upstream_invalid_stream", "The upstream SSE frame exceeds the size limit.");
  const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (data === "[DONE]") {
    if (!state.hasContent) throw streamError("upstream_empty_stream", "The upstream chat stream completed without text, reasoning or tool calls.");
    state.done = true;
  } else if (data) {
    let chunk;
    try { chunk = frameEvent(frame); }
    catch { throw streamError("upstream_invalid_stream", "The upstream chat stream contains invalid JSON."); }
    if (isRelayErrorEvent(chunk)) throw relayStreamError(chunk);
    if (!Array.isArray(chunk?.choices)) throw streamError("upstream_invalid_stream", "The upstream chat stream contains no completion choices.");
    for (const choice of chunk.choices) {
      const delta = choice.delta || choice.message || {};
      state.hasContent ||= [delta.content, delta.reasoning_content, delta.refusal].some((value) => typeof value === "string" && value.trim().length > 0)
        || delta.tool_calls?.some((call) => call?.id || call?.function?.name || call?.function?.arguments)
        || Boolean(delta.function_call?.name || delta.function_call?.arguments);
      const index = choice.index ?? 0;
      state.choices.set(index, Boolean(choice.finish_reason) || state.choices.get(index) || false);
    }
  }
  return Buffer.from(`${frame}\n\n`);
}
