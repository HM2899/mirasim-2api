# Native search compatibility

## Two separate interfaces

- `POST /v1/alpha/search` and `POST /backend-api/codex/alpha/search` forward JSON bytes and query parameters to the canonical alpha route using the signed Codex relay agent and gateway API-key authentication. Generation defaults are not injected. Upstream results/errors are forwarded without inventing a result schema. The inspected Mirasim 0.0.383 bundle establishes the route aliases, not an alpha request schema or account entitlement. Callers must supply an upstream-compatible payload. GET and other methods are not implemented.
- Conversational search on Chat Completions, Responses and Anthropic Messages uses the Responses `web_search` tool and existing answer adapters. It does not assume alpha search is interchangeable with Responses search or parse alpha results into a synthetic assistant answer.

## Three client protocols

Use a Responses-backed **text** model already available to your account. No model substitution or additional model entitlement is performed. A convenient gateway extension available on all three protocols is `web_search_options: {}`. Omit this field entirely to leave search disabled unless an explicit search tool is supplied. `{}` enables automatic tool selection; use the documented tool choice to require search. Availability still depends on the upstream model and account.

Chat Completions example (`POST /v1/chat/completions`):

```json
{
  "model": "gpt-6-astra",
  "messages": [{"role": "user", "content": "Search for the latest project release and cite sources."}],
  "web_search_options": {"search_context_size": "high"},
  "tool_choice": "required",
  "stream": true
}
```

Responses (`POST /v1/responses`): replace `messages` with `input` text. Prefer its native `tools: [{"type":"web_search"}]` instead of `web_search_options` when the client supports it. Native search events, search-call output items and URL annotations remain in their original protocol shape. Existing Responses history rules apply.

Anthropic Messages (`POST /v1/messages`): retain `messages`, supply `max_tokens`, and use `tool_choice: {"type":"any"}` instead of `"required"`. A hosted-tool declaration such as `{"type":"web_search_20250305","name":"web_search","allowed_domains":["example.com"]}` is also translated for Responses-backed models; `tool_choice: {"type":"tool","name":"web_search"}` forces that tool. Domain allowlists and approximate locations are mapped. Unsupported provider-only controls such as `max_uses` or `blocked_domains` are rejected rather than silently discarded.

Chat also accepts native `web_search` / `web_search_preview` tool declarations as a gateway extension. Existing function tools can coexist with search. A function merely **named** `web_search` remains a client function and is not replaced by hosted search. Do not combine `web_search_options` with another hosted search declaration. Chat's nested approximate location format is converted to the Responses location shape.

## Output and limits

Both JSON and SSE replies are supported. Responses retains structured native citations. Chat and Anthropic receive assistant text with a deduplicated Markdown Sources list derived only from upstream URL citations; these adapters do not fabricate Anthropic `server_tool_use` blocks or claim a lossless provider-native search transcript. Only HTTP(S) citation links are included. Search events count as upstream progress; total request deadlines and size limits still apply.

For non-Responses models, the new cross-protocol search extension returns a clear 400 instead of silently ignoring search or choosing a different model. Existing provider-specific Anthropic search behavior is unchanged. Image models cannot use this search bridge.

## Verification

Local mock-upstream tests cover raw aliases/authentication, exact payload forwarding, all three protocols in JSON/SSE, forced selection, native declarations, source deduplication, progress tracking, and unsupported-model errors.

### Production verification

User-authorized live verification with `gpt-6-astra` searched for the official Node.js website using `web_search_options`, low search context and required tool selection:

| Protocol | JSON | SSE | Observed evidence |
| --- | --- | --- | --- |
| Responses | HTTP 200, 11.6 s | HTTP 200, 5.0 s | Completed web search call, URL citations and completed response |
| Chat Completions | HTTP 200, 6.3 s | HTTP 200, 6.0 s | Answer, source links and normal stop / DONE |
| Anthropic Messages | HTTP 200, 6.0 s | HTTP 200, 5.0 s | Answer, source links and end_turn / message_stop |

Both standalone alpha paths returned upstream HTTP 503: `web search is unavailable for this session right now`. They are **not verified usable**. Initial probes with only `query` were rejected for missing `model` and then `id`. After checking the official Codex `codex-rs/codex-api/src/search.rs` definition, the final probes supplied `id`, `model`, and `commands.search_query` with `response_length: "short"`; these reached the 503 result rather than a schema error. This distinguishes successful conversational search from unavailable standalone alpha search; do not treat the two as interchangeable or claim all search endpoints work. The gateway's existing failover attempted multiple accounts, so further blind retries were stopped.

Temporary verification API keys were revoked. These observations establish the tested model/account-pool behavior only, not every model, search option or future upstream availability. Images and other unrelated features were not part of this search verification.
