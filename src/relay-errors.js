const REQUEST_ERROR_CODES = new Set([
  "unsupported_parameter", "unsupported_value", "unknown_parameter",
  "invalid_parameter", "invalid_request", "invalid_request_error",
  "context_length_exceeded", "string_above_max_length", "unsupported_response_format"
]);

export function isPermanentRequestError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.code === "model_capacity_exhausted" || error.type === "overloaded_error") return false;
  return error.type === "invalid_request_error" || REQUEST_ERROR_CODES.has(error.code);
}

export function relayErrorDetails(error) {
  if (!error || typeof error !== "object") return null;
  const details = {};
  for (const field of ["type", "code", "message", "param"]) {
    if (typeof error[field] !== "string") continue;
    details[field] = error[field].replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
      .replace(/\b(?:sk-|sess-)[a-zA-Z0-9_-]+/g, "[redacted]")
      .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, field === "message" ? 1000 : field === "param" ? 256 : 96);
  }
  if (error.param === null) details.param = null;
  const status = error.statusCode ?? error.status;
  if (Number.isInteger(status) && status >= 400 && status <= 599) details.status = status;
  return Object.keys(details).length ? details : null;
}

export function isRelayErrorEvent(event) {
  return Boolean(event && typeof event === "object" && (event.error || event.type === "error"
    || event.type === "response.failed" || (typeof event.type === "string" && event.type.endsWith("_error"))));
}

// SSE event names are not error types. Unwrap once, then carry only bounded, validated
// diagnostics through each adapter; never attach the raw event (which can contain secrets).
export function relayStreamError(value) {
  const object = (input) => input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const event = object(value);
  const response = object(event.response);
  const detail = object(event.error || response.error || event);
  const sources = [detail, response, event];
  const fields = {};
  for (const field of ["type", "code"]) {
    const candidate = sources.map((source) => source[field]).find((item) => typeof item === "string"
      && /^[a-zA-Z0-9_.-]{1,96}$/.test(item) && !["error", "response.failed"].includes(item));
    if (candidate) fields[field] = candidate;
  }
  fields.message = sources.map((source) => source.message).find((item) => typeof item === "string" && item.trim())
    || "The upstream stream reported an error.";
  fields.param = sources.map((source) => source.param).find((item) => item === null || typeof item === "string") ?? null;
  const statuses = sources.flatMap((source) => [source.statusCode, source.status]).filter((item) => Number.isInteger(item) && item >= 400 && item <= 599);
  const status = statuses.includes(403) ? 403 : statuses[0];
  const permanent = isPermanentRequestError(fields);
  fields.status = status === 403 ? 403 : permanent ? 400 : status || 502;
  if (fields.status === 403) fields.type = "permission_error";
  else if (permanent) fields.type = "invalid_request_error";
  else fields.type ||= fields.status === 401 ? "authentication_error" : fields.status === 429 ? "rate_limit_error"
    : fields.status < 500 ? "invalid_request_error" : "server_error";
  fields.code ||= "upstream_stream_error";
  const details = relayErrorDetails(fields);
  return Object.assign(new Error(details.message), {
    type: details.type, code: details.code, param: details.param, statusCode: details.status,
    upstreamError: details
  });
}
