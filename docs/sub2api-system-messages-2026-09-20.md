# sub2api Messages compatibility regression

## Confirmed 400

The affected route is client → sub2api → this gateway's `/v1/messages` → the model-specific upstream. The gateway's validator allowed only `user` and `assistant`, rejecting a mid-conversation `system` message before contacting the model. A synthetic request through the affected sub2api group reproduced the exact reported error: `messages[1]: expected a user or assistant message.`

The Anthropic official mid-conversation-system-messages documentation describes `system` entries, turn-scoped `clear_at`, and client tool additions/removals. The old conversion also treated every non-assistant message as user text, so merely relaxing validation would lose instruction priority.

## Changes

- Accept `system` messages and validate their turn scope.
- Keep native Claude system history; preserve system-role ordering in GPT Responses and Chat conversions.
- On the GPT relay leg, map inline system messages to `developer`. Live synthetic comparisons returned 400 with `system`, but 200 with `developer` and with a user-only baseline. Simply admitting system messages at the incoming validator did not fix this second rejection.
- Remove expired turn-scoped instructions only on cross-provider conversion, including expiry caused by a user tool-result turn.
- Apply client tool additions/removals to current tool availability without removing historical calls/results. Reject unresolved references and unavailable forced tools.
- Preserve upstream heartbeat comments through Responses → Chat → Anthropic as `ping`, rather than silently swallowing them.
- Retain the separate upstream idle timeout and cancellation path; a heartbeat is not a successful completion.
- Do not record normal upstream cancellation after a completed response as a false 502 in the request log.

## Verification boundary

A later direct-to-gateway comparison reproduced a separate namespace failure without sub2api: both namespaced function and custom tools failed during streaming, while a top-level custom tool successfully returned a `custom_tool_call`. Native GPT requests now flatten namespace declarations and restore namespace identities in the full response lifecycle. This fix belongs in this gateway even when sub2api is absent. Separately, the deployed sub2api version was observed dropping custom children from namespaces; changing this gateway cannot recover tools already removed before arrival.

The direct fix passed 70 focused tests. The full suite passed 353 of 354 tests; the remaining failure is the pre-existing expired quota reset-date fixture. A loopback preview using the real GPT upstream completed seven turns with six namespaced native custom calls (`exec_command` and `apply_patch`), including a simulated failing test followed by another repair and passing tests, at `max` effort. No generated commands were executed. After restarting the main gateway, namespace function, namespace custom and ordinary custom probes all returned valid tool calls and `response.completed`, in approximately 3.9, 2.7 and 3.7 seconds respectively. These are protocol and synthetic workflow checks, not a guarantee that every client workload finishes within those times. The live sub2api image was not replaced.

Regression tests cover role/scope validation, native and bridged histories, tool availability, heartbeat delivery before completion, and upstream cancellation. Live checks must go through sub2api rather than treating a direct gateway greeting as proof that Codex long tasks work. Historical requests with zero usage and HTTP 200 do not establish successful completion. Long-task failures require terminal-event and active-request diagnostics; these changes do not establish that every prior timeout had the same cause.
