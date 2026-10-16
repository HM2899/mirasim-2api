// The Claude relay queues a request before it answers: its router holds the request (reported
// afterwards as `x-router-throttle-wait-ms`) and sends nothing at all — no headers, no bytes —
// until a slot frees, which measured 24–37s on an idle pool. A streaming caller sees a silent
// socket for that whole time, and clients with an idle limit of their own hang up on it.
//
// So once the wait has lasted long enough to be a queue rather than a slow answer, the gateway
// commits the stream itself: 200 with SSE headers, then a heartbeat the caller's protocol already
// knows to ignore, until the upstream answers. A fast answer — including a fast refusal with its
// real status — never sees any of this. A failure after the commit can no longer change the
// status line, so it is delivered as that protocol's own in-stream error event instead.
const DEFAULT_DELAY_MS = 5_000;
const DEFAULT_INTERVAL_MS = 10_000;

export function holdStreamOpen(response, { protocol, path, delayMs = DEFAULT_DELAY_MS, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const anthropic = protocol === "anthropic";
  // Anthropic's own API sends `ping` events and every SDK skips them; an SSE comment is skipped
  // by every parser by definition, which is what the OpenAI wires get.
  const heartbeat = anthropic ? 'event: ping\ndata: {"type":"ping"}\n\n' : ": keepalive\n\n";
  let committed = false;
  let stopped = false;
  let closed = false;
  let waitingDrain = false;
  let interval = null;
  let timer = null;
  const isClosed = () => closed || response.closed || response.writableEnded || response.destroyed;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearInterval(interval);
    response.off("close", onClose);
    response.off("finish", onClose);
    response.off("error", onClose);
    response.off("drain", onDrain);
  };
  const onClose = () => {
    closed = true;
    stop();
  };
  const onDrain = () => { waitingDrain = false; };
  const beat = () => {
    if (stopped) return;
    if (isClosed()) return onClose();
    if (waitingDrain) return;
    try {
      // A false return still accepted this heartbeat. Skip further beats until it drains;
      // never queue more bytes (or more drain listeners) for a caller that is not reading.
      if (response.write(heartbeat) === false && !stopped) {
        waitingDrain = true;
        response.once("drain", onDrain);
      }
    } catch {
      onClose();
    }
  };
  const commit = () => {
    if (stopped) return;
    if (committed || response.headersSent || isClosed()) return stop();
    try {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no"
      });
      committed = true;
      response.socket?.setNoDelay?.(true);
      // The handler that eventually forwards the answer still sets its status and headers as if it
      // were first. Those are settled now; letting the calls through would only throw.
      response.writeHead = function () { return this; };
      response.setHeader = function () { return this; };
      response.removeHeader = function () {};
      beat();
      if (stopped) return;
      interval = setInterval(beat, intervalMs);
      interval.unref?.();
    } catch {
      onClose();
    }
  };
  timer = setTimeout(commit, delayMs);
  timer.unref?.();
  response.once("close", onClose);
  response.once("finish", onClose);
  response.once("error", onClose);

  return {
    get committed() { return committed; },
    stop,
    // Ends a committed stream with the error the caller would otherwise have received as a status.
    // The status is still recorded on the response, so request logs report what really happened.
    fail(statusCode, error = {}) {
      stop();
      if (isClosed()) return;
      const message = typeof error.message === "string" && error.message ? error.message : `The upstream returned HTTP ${statusCode}.`;
      const type = typeof error.type === "string" && error.type ? error.type : errorType(statusCode, anthropic);
      const code = typeof error.code === "string" && error.code ? error.code : null;
      response.statusCode = statusCode;
      if (anthropic) {
        response.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message } })}\n\n`);
      } else if (path === "/v1/responses") {
        response.end(`event: error\ndata: ${JSON.stringify({ type: "error", code: code || type, message, param: null })}\n\n`);
      } else {
        response.end(`data: ${JSON.stringify({ error: { message, type, param: null, code } })}\n\ndata: [DONE]\n\n`);
      }
    }
  };
}

function errorType(statusCode, anthropic) {
  if (statusCode === 429) return anthropic ? "rate_limit_error" : "rate_limit_exceeded";
  if (statusCode === 529 || statusCode === 503) return anthropic ? "overloaded_error" : "server_error";
  if (statusCode === 504) return anthropic ? "timeout_error" : "server_error";
  if (statusCode >= 500) return anthropic ? "api_error" : "server_error";
  return "invalid_request_error";
}
