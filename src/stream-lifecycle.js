import { MAX_RESPONSE_BYTES, MAX_SSE_FRAME_BYTES } from "./response-state.js";
import { Readable, Transform } from "node:stream";

export function pipeWithCancellation(source, transform) {
  source.on("error", (error) => {
    if (!transform.readableEnded) transform.destroy(error);
  });
  transform.on("close", () => source.destroy());
  transform.once("end", () => {
    source.unpipe(transform);
    source.destroy();
    if (!transform.writableEnded && !transform.destroyed) transform.end();
  });
  return source.pipe(transform);
}

// A caller reading an answer has an idle limit of its own, and an upstream that is thinking,
// searching or queued between two events can stay quiet past it; the client then reports the
// connection lost mid-response. This keeps bytes flowing toward the caller while the upstream is
// silent. The heartbeat is one the caller's protocol already ignores, and it only goes between
// two frames: a pass-through stream arrives in chunks that may end halfway through one.
export function sseHeartbeat(source, { heartbeat, intervalMs }) {
  let lastWriteAt = Date.now();
  let tail = "\n\n";
  let ended = false;
  let timer;
  const stop = () => {
    ended = true;
    clearInterval(timer);
  };
  const transform = new Transform({
    transform(chunk, encoding, callback) {
      if (chunk.length) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        tail = (tail + bytes.toString("latin1", Math.max(0, bytes.length - 4))).slice(-4);
        lastWriteAt = Date.now();
      }
      callback(null, chunk);
    },
    flush(callback) {
      stop();
      callback();
    }
  });
  transform.on("close", stop);
  timer = setInterval(() => {
    const atBoundary = tail.endsWith("\n\n") || tail === "\r\n\r\n";
    if (ended || transform.destroyed || !atBoundary || transform.readableLength > 0) return;
    if (Date.now() - lastWriteAt < intervalMs) return;
    lastWriteAt = Date.now();
    transform.push(heartbeat);
  }, Math.max(1, Math.floor(intervalMs / 2)));
  timer.unref?.();
  return pipeWithCancellation(source, transform);
}

export function endMessageStream(upstream, { heartbeatIntervalMs = 15_000 } = {}) {
  if (!upstream.ok || !upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream")) return upstream;
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  let heartbeat;
  function fail(stream, error) {
    if (ended || stream.destroyed) return;
    ended = true;
    buffer = "";
    clearInterval(heartbeat);
    const code = ["upstream_stream_timeout", "upstream_stream_incomplete"].includes(error?.code) ? error.code : "upstream_stream_error";
    const message = code === "upstream_stream_timeout" ? "The upstream stream exceeded its idle timeout."
      : code === "upstream_stream_incomplete" ? "The upstream stream ended before message_stop; the response is incomplete."
        : "The upstream connection failed during the response; the response is incomplete.";
    stream.push(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", code, message } })}\n\n`);
    stream.push(null);
  }
  const transform = new Transform({
    transform(chunk, encoding, callback) {
      if (ended) return callback();
      try {
        buffer += decoder.decode(chunk, { stream: true });
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, separator.index);
          if (Buffer.byteLength(frame) > MAX_SSE_FRAME_BYTES) throw new Error("The upstream SSE frame exceeds the size limit.");
          buffer = buffer.slice(separator.index + separator[0].length);
          this.push(frame + separator[0]);
          const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          let event;
          try { event = JSON.parse(data); } catch {}
          if (["message_stop", "error"].includes(event?.type)) {
            ended = true;
            clearInterval(heartbeat);
            buffer = "";
            this.push(null);
            break;
          }
        }
        if (Buffer.byteLength(buffer) > MAX_SSE_FRAME_BYTES) throw new Error("The upstream SSE frame exceeds the size limit.");
        callback();
      } catch (error) { fail(this, error); callback(); }
    },
    flush(callback) {
      if (ended) return callback();
      buffer += decoder.decode();
      const data = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      let event;
      try { event = JSON.parse(data); } catch {}
      if (["message_stop", "error"].includes(event?.type)) {
        ended = true;
        clearInterval(heartbeat);
        this.push(buffer + "\n\n");
      } else fail(this, { code: "upstream_stream_incomplete" });
      callback();
    }
  });
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const source = Readable.fromWeb(upstream.body);
  source.on("error", (error) => fail(transform, error));
  transform.on("close", () => { clearInterval(heartbeat); source.destroy(); });
  transform.once("end", () => {
    clearInterval(heartbeat);
    source.unpipe(transform);
    source.destroy();
    if (!transform.writableEnded && !transform.destroyed) transform.end();
  });
  if (heartbeatIntervalMs > 0) {
    heartbeat = setInterval(() => {
      if (!ended && !transform.destroyed && transform.readableLength === 0) transform.push('event: ping\ndata: {"type":"ping"}\n\n');
    }, heartbeatIntervalMs);
    heartbeat.unref();
  }
  return new Response(Readable.toWeb(source.pipe(transform)), { status: upstream.status, statusText: upstream.statusText, headers });
}

export function guardUpstreamResponse(upstream, {
  signal,
  idleTimeoutMs = 300_000,
  firstContentTimeoutMs = null,
  maxBytes = MAX_RESPONSE_BYTES,
  maxFrameBytes = MAX_SSE_FRAME_BYTES,
  onChunk = () => {},
  onFrame = () => {},
  onCancel = () => {},
  onDone = () => {}
} = {}) {
  if (!upstream.body) {
    onDone();
    return upstream;
  }
  const reader = upstream.body.getReader();
  let isSse = upstream.headers.get("content-type")?.includes("text/event-stream") ? true : null;
  const decoder = new TextDecoder();
  let pendingFrame = "";
  let bytes = 0;
  let timer;
  let contentTimer;
  let progressRemainingMs = null;
  let closed = false;
  let streamController;
  function cleanup() {
    clearTimeout(timer);
    clearTimeout(contentTimer);
    signal?.removeEventListener("abort", aborted);
    onDone();
  }
  function cancel(reason) {
    if (closed) return;
    closed = true;
    cleanup();
    onCancel(reason);
    void reader.cancel(reason).catch(() => {});
  }
  function fail(error) {
    if (closed) return;
    streamController.error(error);
    cancel(error);
  }
  function aborted() {
    fail(signal.reason instanceof Error ? signal.reason : new Error("The upstream request was cancelled."));
  }
  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
      if (Number.isFinite(firstContentTimeoutMs)) {
        contentTimer = setTimeout(() => fail(Object.assign(new Error("The upstream response did not produce content before the configured deadline."), { code: "upstream_stream_timeout" })), Math.max(0, firstContentTimeoutMs));
      }
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    },
    async pull(controller) {
      if (closed) return;
      const readStartedAt = Date.now();
      if (progressRemainingMs !== null) {
        contentTimer = setTimeout(() => fail(Object.assign(new Error("The upstream response stream stopped producing content before the configured deadline."), { code: "upstream_stream_timeout" })), Math.max(0, progressRemainingMs));
      }
      timer = setTimeout(() => fail(Object.assign(new Error("The upstream response stream exceeded its idle timeout."), { code: "upstream_stream_timeout" })), idleTimeoutMs);
      try {
        const result = await reader.read();
        clearTimeout(timer);
        if (closed) return;
        if (progressRemainingMs !== null) {
          progressRemainingMs -= Date.now() - readStartedAt;
          clearTimeout(contentTimer);
        }
        if (result.done) {
          closed = true;
          cleanup();
          controller.close();
          return;
        }
        bytes += result.value.byteLength;
        if (result.value.byteLength) onChunk();
        if (bytes > maxBytes) throw new Error("The upstream response exceeds the stream size limit.");
        if (isSse !== false) {
          pendingFrame += decoder.decode(result.value, { stream: true });
          if (isSse === null) {
            const prefix = pendingFrame.trimStart();
            const fields = ["data:", "event:", ":", "id:", "retry:"];
            if (fields.some((field) => prefix.startsWith(field))) isSse = true;
            else if (prefix && !fields.some((field) => field.startsWith(prefix))) {
              isSse = false;
              pendingFrame = "";
            }
          }
          let separator;
          while (isSse && (separator = /\r?\n\r?\n/.exec(pendingFrame))) {
            const frame = pendingFrame.slice(0, separator.index);
            if (Buffer.byteLength(frame) > maxFrameBytes) throw new Error("The upstream SSE frame exceeds the size limit.");
            onFrame(frame);
            if (Number.isFinite(firstContentTimeoutMs) && frameHasProgress(frame)) {
              clearTimeout(contentTimer);
              progressRemainingMs = idleTimeoutMs;
            }
            pendingFrame = pendingFrame.slice(separator.index + separator[0].length);
          }
          if (Buffer.byteLength(pendingFrame) > maxFrameBytes) throw new Error("The upstream SSE frame exceeds the size limit.");
        }
        controller.enqueue(result.value);
      } catch (error) { fail(error); }
    },
    cancel
  });
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
}

// Hidden thinking is relayed as an empty thinking_delta that carries only a token estimate, and a
// translated stream has nothing to show for it. The raw relay frame is then the one place left
// that says the generation is still moving, so only that frame — never anything a converter
// produced — may be read with this.
export function frameHasThinkingEstimate(frame) {
  return frameDataValues(frame).some((data) => {
    try { return isThinkingEstimate(JSON.parse(data)); }
    catch { return false; }
  });
}

function isThinkingEstimate(event) {
  return event?.type === "content_block_delta" && event.delta?.type === "thinking_delta"
    && Number.isSafeInteger(event.delta.estimated_tokens) && event.delta.estimated_tokens > 0;
}

function frameDataValues(frame) {
  return frame.split(/\r?\n\r?\n/).flatMap((part) => {
    const data = part.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    return data ? [data] : [];
  });
}

function frameData(frame) {
  return frameDataValues(frame).join("\n");
}

function frameHasProgress(frame) {
  const data = frameData(frame);
  if (data === "[DONE]") return true;
  try {
    const event = JSON.parse(data);
    if (/^(?:image_generation|image_edit)\.(?:partial_image|completed)$/.test(event?.type) && hasText(event.b64_json)) return true;
    if (event?.type === "response.image_generation_call.partial_image" && hasText(event.partial_image_b64)) return true;
    if (/^response\.web_search_call\.(?:in_progress|searching|completed)$/.test(event?.type) && hasText(event.item_id)) return true;
    if (event?.error || ["error", "message_stop", "response.completed", "response.incomplete", "response.failed"].includes(event?.type)) return true;
    if (isThinkingEstimate(event)) return true;
    if (event?.choices?.some((choice) => outputHasContent(choice?.delta || choice?.message))) return true;
    if (typeof event?.type === "string" && event.type.endsWith(".delta") && hasText(event.delta)) return true;
    return [event?.delta, event?.content_block, event?.message, event?.item, event?.part].some(outputHasContent)
      || hasText(event?.text) || hasText(event?.arguments);
  } catch {
    return false;
  }
}

function outputHasContent(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(outputHasContent);
  if ([value.content, value.text, value.thinking, value.reasoning, value.reasoning_content, value.refusal, value.partial_json, value.signature, value.encrypted_content].some(hasText)) return true;
  if (["tool_use", "server_tool_use", "function_call", "custom_tool_call"].includes(value.type) && (value.id || value.name || value.arguments)) return true;
  if (typeof value.type === "string" && value.type.endsWith("_call") && value.id) return true;
  if (value.tool_calls?.some((call) => call?.id || call?.function?.name || call?.function?.arguments)) return true;
  if (value.function_call?.name || value.function_call?.arguments) return true;
  return outputHasContent(value.content) || outputHasContent(value.summary);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
