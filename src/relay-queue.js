// These are relay-reported observations, not a locally estimated queue position.
export function relayQueueInfo(headers) {
  const text = (name) => {
    const value = headers?.get?.(name)?.trim();
    return value && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
  };
  const number = (name) => {
    const value = text(name);
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER ? Math.floor(parsed) : null;
  };
  const info = {
    queueClass: text("x-router-queue-class"),
    cause: text("x-router-queue-cause") === "refused" ? "refused" : null,
    position: number("x-router-queue-position"),
    etaMs: number("x-router-queue-eta-ms"),
    waitMs: number("x-router-throttle-wait-ms")
  };
  return Object.values(info).some((value) => value !== null) ? info : null;
}

export function isPlatformQueueRefusal(upstream) {
  if (upstream?.status !== 503 || upstream.refusalComplete === false) return false;
  if (relayQueueInfo(upstream.headers)?.queueClass) return true;
  const text = upstream.refusalBody || "";
  const candidates = [text, text.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim()];
  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(candidate);
      if ((payload?.error ?? payload)?.code === "platform_queue_full") return true;
    } catch {}
  }
  return false;
}

export function platformQueueRetryMs(headers) {
  const seconds = Number(headers?.get?.("retry-after")?.split(",", 1)[0]?.trim());
  const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 5_000;
  return Math.max(1_000, Math.min(60_000, delay));
}

// A cancelled caller must not wait out Retry-After or submit another upstream request.
export function waitForPlatformQueue(request, response, delayMs) {
  if (request.aborted || response.destroyed || response.writableEnded) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer;
    const finish = (ready) => {
      clearTimeout(timer);
      request.off("aborted", cancelled);
      response.off("close", cancelled);
      response.off("finish", cancelled);
      resolve(ready);
    };
    const cancelled = () => finish(false);
    request.once("aborted", cancelled);
    response.once("close", cancelled);
    response.once("finish", cancelled);
    timer = setTimeout(() => finish(true), delayMs);
  });
}
