# Protocol error retry classification

## Change

The relay now stops account failover when a buffered server-error response explicitly identifies an invalid request or a known parameter/schema/context-length failure. Some upstreams report these failures using HTTP 5xx; retrying the same request against another account cannot repair its shape.

Classification uses structured `error.type` and `error.code`, not words found in the message. Explicit capacity exhaustion and overload take precedence and retain the congestion retry policy. Unknown server failures, quota/entitlement differences, model availability and session-specific unavailability retain the existing behavior. The upstream status and error message are not replaced with a fabricated success.

This does not change system prompts, model routing, retired compaction endpoints, or image generation behavior. It does not disable all HTTP 503 retries.

## Validation and deployment status

- The six offline test files for error classification, image requests/protocols, Responses conversion, Chat stream validation and request validation passed in the current environment.
- Syntax checks and `git diff --check` passed.
- Multi-account regression cases were added for all three client protocols, plus a case ensuring unknown server errors still fail over.
- HTTP integration execution is blocked by the current sandbox: binding `127.0.0.1` fails with `listen EPERM`. Service-manager access is also denied. The modified backend has **not** been restarted or deployed by this change.

When running in an environment with loopback and service access, run `node --test test/relay-errors.test.js test/request-timeouts.test.js`, then `npm test`. Check active requests before restarting `mirasim-2api.service`.
