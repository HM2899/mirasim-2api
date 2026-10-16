import assert from "node:assert/strict";
import test from "node:test";
import { isPermanentRequestError, relayErrorDetails, relayStreamError } from "../src/relay-errors.js";

test("explicit request-shape failures are permanent even if upstream mislabels the HTTP status", () => {
  for (const code of ["unsupported_parameter", "unsupported_value", "unknown_parameter", "context_length_exceeded", "unsupported_response_format"]) assert.equal(isPermanentRequestError({ code, type: "server_error" }), true);
  assert.equal(isPermanentRequestError({ type: "invalid_request_error", message: "Invalid tool schema" }), true);
});

test("quota, model entitlement, session unavailability and congestion are not treated as permanent request failures", () => {
  for (const error of [null, {}, { code: "model_not_found" }, { code: "insufficient_quota" }, { type: "api_error", message: 'no upstream available for model "example"' }, { type: "server_error", message: "web search is unavailable for this session right now" }, { type: "invalid_request_error", code: "model_capacity_exhausted" }, { type: "overloaded_error", code: "unsupported_value" }]) assert.equal(isPermanentRequestError(error), false);
});

test("relay error details are bounded and redact credentials", async () => {
  const { relayErrorDetails } = await import("../src/relay-errors.js");
  assert.equal(relayErrorDetails(null), null);
  const details = relayErrorDetails({ type: "api_error", message: "Bearer secret sk-private\n" + "x".repeat(2000), private: "hidden" });
  assert.equal(details.message.length, 1000);
  assert.doesNotMatch(details.message, /secret|sk-private|\n/);
  assert.equal(details.private, undefined);
});

test("stream errors unwrap only validated fields and keep bounded redacted diagnostics", () => {
  const error = relayStreamError({ type: "response.failed", response: { status: 503, error: {
    type: "invalid_request_error", code: "unsupported_parameter", param: "text.format",
    message: "Rejected Bearer private-token sk-private sess-private\n" + "x".repeat(2000), private: "hidden"
  } } });
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, "unsupported_parameter");
  assert.equal(error.param, "text.format");
  assert.equal(error.message.length, 1000);
  assert.deepEqual(error.upstreamError, relayErrorDetails(error));
  assert.doesNotMatch(JSON.stringify(error), /private-token|sk-private|sess-private|hidden/);
});

test("stream error normalization rejects malformed fields and statuses", () => {
  for (const status of [200, "403", 399, 600, 503.5, null, {}]) {
    const error = relayStreamError({ error: { type: [], code: { secret: true }, message: {}, param: [], status } });
    assert.equal(error.type, "server_error");
    assert.equal(error.code, "upstream_stream_error");
    assert.equal(error.statusCode, 502);
    assert.equal(error.param, null);
  }
  assert.equal(relayStreamError({ type: "error", code: "not a code" }).code, "upstream_stream_error");
});

test("explicit permission denial wins over permanent errors in any envelope", () => {
  for (const input of [
    { status: 403, error: { type: "invalid_request_error", code: "unsupported_value", status: 400 } },
    { type: "response.failed", response: { error: { code: "unsupported_value", statusCode: 403 } } }
  ]) {
    assert.equal(relayStreamError(input).statusCode, 403);
    assert.equal(relayStreamError(input).type, "permission_error");
  }
  const mislabeled = relayStreamError({ type: "server_error", code: "unsupported_value", status: 503 });
  assert.equal(mislabeled.statusCode, 400);
  assert.equal(mislabeled.type, "invalid_request_error");
  assert.equal(relayStreamError({ type: "overloaded_error", status: 503 }).type, "overloaded_error");
  assert.equal(relayStreamError({ type: "overloaded_error" }).statusCode, 502);
});
