# mirasim-2api 详细参考（Reference）

> 本文件由原 README 迁移而来，按功能记录协议行为、轮询策略、超时与各项边界。快速上手请看根目录 [README.md](../README.md)。


## Console login sessions

Console login cookies last seven days. Authenticated console requests renew both the cookie and the stored session after one day, so regular use no longer hits a fixed 12-hour logout. Renewal is throttled to avoid writing SQLite on every dashboard poll. Sessions survive gateway restarts; expired sessions cannot be renewed, and explicit logout immediately revokes the session. Existing unexpired 12-hour sessions upgrade on their next authenticated console request. This does not extend upstream Mirasim account tokens, which use their separate refresh flow.

## OpenAI protocol diagnostics and boundaries

Inference request bodies allow 16 MiB by default, configurable with `MIRASIM_MAX_REQUEST_BYTES` up to 64 MiB. This accommodates Codex tool-result and conversation uploads larger than the previous 4 MiB limit. Over-limit requests return a structured HTTP 413 instead of a connection reset. Management endpoints retain their 4 MiB limit; response-stream and local history-cache limits remain independent.

`POST /v1/chat/completions`, `POST /v1/responses`, and the Codex alias `POST /backend-api/codex/responses` retain their incoming OpenAI protocol independently of the selected upstream model. Request logs derive `clientPath` and `protocol` from the actual HTTP request URL; `upstreamPath` and `upstreamProtocol` describe the separate relay hop. The console shows both in request details and filters by the client protocol. Every HTTP response carries a gateway-generated `x-mirasim-request-id`, also available as `requestId` in the usage log and searchable in the console. This is separate from the upstream provider's request ID.

Authentication, malformed JSON, and validation failures on these generation endpoints are recorded even when no upstream request was made. Such entries have no upstream path/status. Successful local title shortcuts remain excluded from the usage log. Logs do not retain request bodies or credentials.

OpenAI routes normalize upstream HTTP failures to JSON `{ "error": { "message": "...", "type": "...", "param": null, "code": null } }`, preserving string error codes/parameters, HTTP status, provider request IDs and `Retry-After` when supplied. Non-JSON provider error pages are replaced with a generic status message. Streaming errors after response delivery continue to use the existing SSE failure handling rather than switching wire protocols.

Invalid stream flags, token limits, tool selectors and structured-output shapes are rejected before forwarding. Cross-protocol Chat bridges support `n=1` only, and asynchronous Responses `background=true` is explicitly unsupported. Responses `text.format` is translated to Chat `response_format` for Chat-backed models and retained in the returned response, including streaming terminal events. Native GPT structured output retains its existing Responses mapping. The Messages bridge does not implement structured-output guarantees: non-text formats now return a clear HTTP 400 rather than silently discarding the constraint. These compatibility routes do not implement every OpenAI API resource or override upstream model capabilities and relay-specific limits documented below.

## GPT streaming latency measurements

`ttfbMs` is captured at the raw upstream reader, before content-type detection, stream preflight or protocol conversion. Opening events and heartbeat bytes can establish this timestamp; they do not count as generated text. `firstOutputMs` measures the first observed output event (including reasoning or tool activity), while `firstTextMs` measures the first visible text/refusal event. These times are relative to request-log creation, and the earliest observed timing is retained across retry attempts. The console displays upstream first-byte, first-text and total duration separately; absent measurements remain unknown, not zero. They describe arrival at this gateway, not when the user's screen renders text. Non-streaming upstream JSON has no incremental text timestamp.

GPT Responses-to-Chat/Messages conversion forwards text already present in `response.output_text.done`, `response.refusal.done` and content-part events immediately, rather than waiting for `response.output_item.done` or `response.completed`. Later snapshots do not duplicate previously delivered text. Native Responses preflight also recognizes text-done events as output. Gate-controlled tests hold the final upstream response until the client has received text, covering Responses, its Codex alias, Chat and Messages, including mislabeled SSE. These changes do not shorten model reasoning or manufacture earlier tokens when the upstream itself emits only a final answer; a very short answer can legitimately have nearly identical first-text and completion times.

## Local Codex task titles

When a protocol converter merges Codex startup context into one user message, the matcher also accepts separate `AGENTS.md` and complete `<environment_context>` text blocks before the final exact title instruction. Arbitrary prefixes, additional conversation history, non-text blocks, and trailing user tasks do not qualify for this context exception.

Unmatched GPT requests include bounded `codexTitleDiagnostics` metadata in the authenticated request log: message roles, block counts, text lengths, and known title-template marker positions. It does not retain prompt text. Use this to diagnose differences introduced by clients or protocol-conversion gateways before broadening any local-title matching rules.

Codex TUI can send a separate automatic task-title request alongside a conversation turn. By default, this gateway handles the exact built-in title instruction for GPT models locally on Messages, Chat Completions, and Responses endpoints. It returns a short, deterministic excerpt of the task text rather than a model-written title. These responses support streaming, report zero model-token usage, carry `x-mirasim-local-response: codex-title`, and do not enter the upstream request log or consume an upstream account. Ordinary conversation, tool results, and requests referencing stored history are not handled by this shortcut. The client still makes two HTTP requests; only the conversation reaches the model. Set `MIRASIM_LOCAL_CODEX_TITLES=false` to restore model-generated titles.

Linux-native OpenAI protocol proxy using the checksum-verified Mirasim `v0.0.516` bundle, with evidence-backed platform queue compatibility. It uses the Mirasim login flow and relay credential saved by the bundled CLI. No separate provider API key is configured in this project.

The inspected target artifact is the supplied 0.0.516 ARM64 DMG:

```text
DMG        https://cdn-assets.mirasim.ai/mirasim/releases/v0.0.516/Mirasim-0.0.516-arm64.dmg
           SHA-256 9076604bd173dd9bef3f07fc55969fbd8e4aaa72fc264c47e759f01f875b171e
vendored server.cjs (installed 0.0.516 bundle)
           SHA-256 671caeca8bae790743a1ee2fde417da8db406c79967f7ef92c89bffd172e77dc
embedded signing/sealing WebAssembly (byte-identical to 0.0.454)
           SHA-256 fd6b7870012af2d7dc299a7ae81d1684315ba15592979bf854cf317bc8657d95
```

The DMG matches the official checksum manifest; this does not verify publisher signature or notarization. The complete vendor bundle and default client version target 0.0.516; explicit version overrides remain supported. The gateway reads its embedded compatibility core; `npm run login` and `npm run relay` execute the bundled CLI. CLI version, crypto vectors and 81 focused tests pass. The full suite passes 1435/1445 tests; the same ten failures reproduce with the previous bundle in an isolated copy. No service restart or production model call was performed for this upgrade. Findings and validation limits are recorded in `docs/mirasim-0.0.516-inspection.md`; historical queue analysis remains in `docs/mirasim-0.0.454-inspection.md`.

### Automatic credential recovery on missing quota

Personal quota reads can automatically refresh the account's **login credentials**, then retry the read once, on HTTP 401, network/5xx failures, or structurally missing quota data. Concurrent forced renewals share one promise and are limited to one attempt per account per five minutes. Reads of a valid zero balance do not renew; neither do permission denials, unsupported endpoints (404/405), or rate limits (429). Refresh failure or missing refresh credentials leaves quota unknown and requires manual login where appropriate. This neither replenishes credit nor extends a paid subscription. Existing scheduled credential maintenance remains separate. Failed quota reads retain the pool's previous observations rather than falsely marking unknown quota as zero.

### Platform admission and caller isolation

- Explicit HTTP 503 platform admission refusals (`platform_queue_full` or a valid `x-router-queue-class`) wait, then prefer the same upstream account while rechecking normal pool eligibility. Numeric `Retry-After` is clamped to 1–60 seconds, defaulting to 5 seconds. Retry scheduling is bounded by the existing request deadline, a 240-second ceiling from attempt-budget creation, and 20 admission refusals; these are gateway bounds, not the official client's exact four-minute hold accounting or a guaranteed total inference duration.
- Ordinary quota 429, legacy model capacity failures, and platform admission are distinct. Admission does not cool the account; `x-should-retry: false` stops retries. Client disconnect cancels admission backoff. No active `/v1/queue` polling or local fair queue is added.
- Request-log attempts include bounded `queue` observations only when actual queue headers exist: class, refused cause, position, ETA and reported throttle wait. Missing position is unknown, not zero or a reserved place in line. Local SSE keepalives never establish upstream TTFB.
- Keys still share the global upstream account pool. Generic cache/account affinity is now scoped to the authenticated key ID, and a request's failover retains its starting rotation mode. This removes routing interference; it is not a claim that prior code leaked conversation content.
- `npm test` explicitly selects `test/*.test.js`, avoiding recursive discovery into downloaded releases and archived copies.

### 0.0.383 account and protocol features

Image-model Chat/Responses/Anthropic compatibility, native image-tool streaming limits and optional image model listing are documented in `docs/image-protocol-and-features.md`. Standalone `/responses/compact` and its Codex alias are retired (HTTP 410, no upstream request or fallback); explicitly requested native Responses automatic compaction remains unchanged. The document also lists useful remaining desktop features and their security/availability boundaries.

Native alpha search forwarding and conversational search across all three protocols are documented in `docs/search-protocol.md`, including tool declarations, citations, and upstream availability boundaries.

- The console uses the new Go purchase invitation link, with official `sold`, `cap`, and `rewarded` fields. Legacy invite generation is retired (`POST /api/referral` returns 410), and registration with a blank code no longer automatically creates or redeems legacy invitations. Explicit legacy-code and MLIC redemption remain compatible with the official client.
- The account pool shows each account's available reset-card count with separate compact refresh and reset-quota buttons. Refresh only queries the count and history; reset asks for confirmation before using the earliest-expiring known active card, without a preliminary count query. Zero or unknown cards disables reset, but refresh remains available. The account row is the only card-control area; the separate reset-card panel has been removed. It never automatically spends cards or retries an ambiguous redemption. Resetting upstream windows does not erase local request or Token history.
- Console-session APIs: `GET /api/campaign-link?account=…`, `GET /api/reset-cards?account=…`, and `POST /api/reset-cards/redeem` with `{account, cardId, selectionId?}`. The selection fingerprint prevents a stale console selection from targeting a different account.
- API-key authenticated image routes: `POST /v1/images/generations` and `POST /v1/images/edits`, including their `/backend-api/codex/images/…` aliases. JSON bodies and multipart edit bytes are preserved and forwarded through the signed Codex agent. Availability and model entitlement are decided by the relay; offline route tests do not prove access to any image model.
- The signing/sealing core is unchanged. Team spaces, cloud-machine enrollment, Git connection management and desktop UI integrations are not exposed as API proxy features.

## Login

Node.js 22.5+ is required. Log in through the original Mirasim flow. It opens the browser flow or runs the email verification flow and writes only to the selected Mirasim profile directory.

```bash
cd /path/to/mirasim-2api

MIRASIM_HOME=$PWD/profiles/account-a npm run login -- email
MIRASIM_HOME=$PWD/profiles/account-b npm run login -- email
```

GitHub login is also available:

```bash
MIRASIM_HOME=$PWD/profiles/account-a npm run login -- github
```

The gateway reads `setting.json` from each profile at request time. Login tokens are not printed, returned from an endpoint, or written to any new configuration file.

## Start

```bash
MIRASIM_HOMES=$PWD/profiles/account-a,$PWD/profiles/account-b npm start
```

The listener is `http://127.0.0.1:8787` by default and exposes:

- `GET /` Mirasim account, invitation, membership activity, and usage console
- `GET /api/dashboard`
- `GET /healthz`
- `GET /v1/models` (OpenAI API Key required; lists the active Mirasim account's current model directory)
- `POST /v1/chat/completions` (OpenAI API Key required)
- `POST /v1/responses` (OpenAI API Key required; translated to the upstream chat interface)
- `POST /v1/messages` (Anthropic Messages API; use the same generated key in `x-api-key`)

Open the Web console and create an OpenAI API Key before calling `/v1/*`. Keys use the `msk_` prefix and are authenticated against SHA-256 hashes stored locally in SQLite. When a console password is configured, new keys also have an encrypted copy for later copying through the authenticated console; hash-only keys cannot be recovered. Use `MIRASIM_DATABASE_FILE` to choose the database path (`MIRASIM_API_KEYS_FILE` remains a compatible alias).

### Console views

- **Overview:** account availability, cumulative usage, Token composition, and shortcuts to keys, model health, and request details. Composition reflects the displayed counters, not billing proportions or cache hit rate.
- **API keys:** search by name or prefix, filter by usage, sort, and paginate. Newly generated secrets can be hidden and are cleared from the reveal panel when leaving the page. Only records marked as copyable support retrieving a saved key; revocation is immediate and requires confirmation.
- **Model health:** search, status filters, attention-first ordering, latency sorting, and pagination. Every model — Claude included — is checked by one `GET /v1/limits` quota/availability reading, with no generation request. It is not a first-token-latency benchmark. Failed background synchronization preserves the last results with a visible warning. Tables adapt to labeled cards on narrow screens.

Console modules load independently: a failed account refresh does not hide saved API keys. When a device-session failure prevents reading an account's relay usage or quota, the dashboard still returns its local record, available identity/referral data, and local usage counters with `syncWarnings`. Missing quota figures remain unknown rather than being shown as exhausted or as a deleted account. This fallback does not bypass signed relay authentication.

## Round Robin

`MIRASIM_HOMES` accepts a comma-separated set of separately logged-in profile directories. Each request goes to the least recently used available profile, so a retry that skips an account does not cost the accounts behind it their turn. A `429`, `500`, `502`, `503`, `504`, timeout, or network error moves that profile into a 30-second cooldown and retries the next profile. When every candidate is cooling, the one whose cooldown ends first is used within the highest-priority tier. Change the cooldown with `MIRASIM_COOLDOWN_MS`.

Every relay response carries the account's own rate-limit meter — `anthropic-ratelimit-unified-5h-utilization` and `-7d-utilization`, as a fraction of one, alongside `-reset` epochs — so the rotation is told what each account has left by the traffic it is already sending. No polling, and never more than one request out of date. A `429` is the most valuable reading of all: the account saying it is spent, in the same breath as the refusal. The headers cover only the unified windows, which is what the rotation wants: a model-scoped budget filling up stops that model, not the account.

Two things follow from a reading. An account already metered to its limit is **passed over** while another account at the same priority can serve, so a request is no longer spent discovering what the last response already said; it is skipped rather than cooled, because nothing about the account has gone wrong, and once its window is past `reset` the reading is void and it returns. Priority is selected first under every mode, then quota can reorder accounts only within that priority tier. This balances on tokens rather than on request count: a 200k-token request and a 10-token one move a least-recently-used pointer equally while consuming four orders of magnitude apart.

Ordering is by 5% bands, not by the raw figure. Readings differ by fractions of a percent, and no account's meter moves until its response comes back, so ordering on the raw number would hand every request in a burst to whichever account happened to read lowest. Within a band accounts fall back to least-recent use, which is what keeps the rotation turning.

The headers only ever describe accounts the gateway has already sent traffic to, so a second source fills in the rest: the account pool page reads `GET /v1/limits` for every account each time it refreshes, and that reading — the same counters, arriving without a request having to be spent — is handed to the rotation as well. Both sources write into one store keyed by window name, so traffic and the console correct each other window by window rather than one wholesale-replacing the other. Model-scoped windows are dropped on the way in for the same reason the console sets them aside: `7d_fable` filling up stops fable, not the account. This is what the console is already fetching, on its own 60-second refresh, so it only covers a gateway whose console someone has open — with the console closed an account that has served nothing since startup still reports nothing consumed and sorts to the front, and the first response it serves corrects that.

Reading the meter this way is what the relay itself asks for. A completion that requests at most one token and carries no session is refused with `400 … read as an availability probe rather than work. Use GET /v1/limits to check availability; it costs no upstream call and is not rate limited per model`. So a caller who pings this gateway with `max_tokens: 1` gets that refusal passed through — it is the relay's answer, not a gateway fault — and the console's per-account `/v1/limits` polling is the sanctioned, free way to ask the same question.

The order inside a tier is the operator's to choose, in **账号池 → 轮询模式**, and it is stored in SQLite so a restart keeps it (`MIRASIM_ROTATION_MODE` only seeds a pool that has never been told). `spread` (均摊, the default) serves the account with the most left first: the pool drains evenly, and empties evenly too — every account reaches its limit at about the same time and their windows reset together, so the pool goes quiet all at once. `waterfall` (榨干) serves the account with the least left first, draining one account at a time: reset windows stagger, so there is usually a fresh account somewhere, and a conversation's turns land on one account often enough to keep its prompt cache warm — at the cost of more `429`s on the account being drained and more failover hops. `roundRobin` (纯轮流) ignores the meters entirely, for a pool whose accounts report nothing usable. Priority stays a hard constraint under all three: the cooldown fallback and conversation affinity only decide between accounts at the same priority, while the free-account last resort remains below every funded account. The change takes effect on the next pick; a request already inside its failover loop keeps the order it started with.

Failover is sequential. `MIRASIM_FAILOVER_BUDGET_MS` (default 60000) limits the response-header waiting and retry phase rather than just counting accounts. The effective budget is at least one full model-specific response-header wait: 60000 ms for other models and 120000 ms for Kimi with the defaults. The first attempt gets its full wait; every retry is limited to the smaller of the per-attempt timeout and the remaining budget. Fast failures can still retry, but repeated slow attempts cannot each spend a fresh timeout beyond the budget. A response-header timeout returns `504`; when retries stop after an upstream refusal, the last refusal is forwarded. Streaming after accepted response headers is not capped by this budget.

An account that was still cooling when the rotation picked it is not charged for the failure that follows. When every candidate is cooling, the rotation serves the one that recovers soonest in the highest-priority tier rather than nothing at all; that attempt reports the outage again, not a new fault of that account, so it extends the cooldown without deepening the backoff. Counting it would double the cooldown of every account the pool falls back on, and a burst of doomed requests would walk the whole pool to the five-minute ceiling, where it would sit long after the upstream had recovered.

A `429` whose rate-limit meter shows a unified window (`5h` or `7d`) at its limit does more than cool the account: it **parks** it until that window's reset time (or the `Retry-After`, whichever is later). A parked account is not a candidate at all — not even as the forced last resort for a cooling pool — so one request against an exhausted pool costs one upstream `429` per account once, instead of walking the whole pool on every request. When every eligible account is parked, the gateway answers locally with `429` and a `Retry-After` header (capped at one hour) without contacting the upstream. A `429` whose meter still has room, such as a model-scoped limit, keeps only the ordinary cooldown. A parked account is released as soon as a fresh reading shows room (the console's `/v1/limits` poll after a reset card, or a rolled-over window), when it is recovered or re-enabled from the console, or when the window resets.

A `5xx` never cools an account down. Only a fault the account is answerable for does that — a `429`, which is its own quota talking, or a network error. When the relay answers `503 no upstream available for model "claude-fable-5"` it is reporting its own capacity, and cooling the account for it is how one unavailable model empties a healthy pool: the request walks all 67 accounts and leaves every one of them cooling on a backoff that reaches five minutes, so the models that were working have nothing left to run on either.

Such a `503` is still retried on another account, because the relay's capacity for a model varies between them — a `503` one account is refused is often served by the next, and that failover is what keeps the model usable. But only `MAX_SERVER_FAULT_ATTEMPTS` (3) accounts are asked: when three in a row refuse, the model is out everywhere and re-asking the rest of the pool cannot change the answer. The client then gets the relay's own response, `request_id` and all, so the message names the model that is out rather than blaming the login. The outage is usually short-lived and the model stays in the catalog; retry it.

`POST /api/accounts/recover`, or **解除全部冷却** in the console, lifts the cooldown from every account carrying one and reports how many it lifted. It clears the backoff itself, not just the wait, so the next failure starts over at one cooldown instead of resuming at eight. An account an operator disabled by hand stays disabled: this undoes what an upstream outage did to the pool, not what a person did.

Free accounts (plan `none`, read from the `plan` claim of the stored token) are held back as the last resort of the rotation. Mirasim's free tier draws on a shared relay allowance that is exhausted in practice: `GET /v1/limits` still reports a 7-day budget, but a real completion comes back as HTTP 429 `中转的共享额度已用尽`. A paid account is therefore preferred even while it is cooling down, and a free account is only used when no account with quota is left — which keeps model-health probes and ordinary traffic off the accounts that cannot serve them. An account whose token carries no `plan` claim counts as usable. The console marks such an account 无额度（最后备用） and reports 免费号无中转额度 instead of the budget Mirasim advertises for it.

Every account carries a rotation priority: the highest priority available account is served first, and accounts that share a priority take turns. Without a manual value the plan decides — `max`/`enterprise` 80, `plus` 60, `basic` and a token without a `plan` claim 40, free 0 — so a MAX 40X account is spent before a MAX 10X one. `PUT /api/accounts/<key>/priority` with `{"priority": 0-100}` pins an account, and `{"priority": null}` returns it to the plan order; the value is stored in SQLite and reloaded at startup. The account pool table exposes the same control. Priority orders accounts that can actually be served: a free account never rises above a funded one, and when every candidate is cooling, the one whose cooldown ends first is selected within the highest-priority tier.

The account-pool view separates available accounts, automatic cooldowns, manual pauses, exhausted account-wide quotas, free-account fallback, signed-out accounts and unknown state. Status chips combine with account/category searches; quota, future reset, request count, priority and subscription-expiry sorts apply before pagination. Unknown quota sorts last in either direction. Capacity cards summarize the whole pool, not only the filtered page: the displayed balance is an equal-weight average of known, non-expired account-wide percentages, not total remaining tokens. Model-scoped limits do not mark the whole account exhausted. Past reset windows are marked as awaiting an update and excluded from future reset summaries; reset timing does not imply that every account will become exhausted together.

“暂停轮询” is a manual pause requiring explicit recovery, unlike an automatic cooldown. Recovering all accounts requires confirmation because it also re-enables manually paused accounts; recovery does not replenish quota or repair expired credentials. Account actions remain locked while in flight, including across dashboard refreshes, to prevent duplicate submissions. The paid manual Haiku “状态检测” action has been removed; its legacy POST endpoint returns HTTP 410 without issuing a model request. “续期” refreshes login credentials rather than extending a paid subscription, and never runs automatically from filters or sorting. Scheduled model-health probing is a separate existing feature and is unchanged. Mobile screens display account cards instead of a wide table. This view does not change the existing rotation algorithm or persist account selection preferences.

`/healthz` reports profile identifiers, login availability, rotation priority, and cooldown state without exposing credential values.

Generation requests, `/v1/models`, and `/healthz` start due login refreshes in the background and proceed as soon as the pool has an eligible, unexpired profile. A slow refresh on an unrelated account no longer delays a usable one. If every profile is expired, requests wait at most 250 ms for recovery before continuing with the endpoint's existing unavailable behavior (generation requests return 503); renewal continues in the background and expired credentials are never forwarded. The server also checks for due renewals every minute while listening, including during idle periods, and stops the timer on close. Dashboard snapshots trigger renewal without waiting for it. Concurrent automatic and manual renewals share the same in-flight operation per account. Explicit account refreshes and background health scans still wait for their refresh results.

Signed relay tickets renew in the background while their current ticket is valid. Concurrent requests share one renewal; expired tickets wait for its result, and authorization refusals invalidate the cached ticket. A request's header deadline or client disconnect also cancels its wait for a ticket without cancelling a shared mint needed by other requests. These changes remove gateway-side waiting without reducing model reasoning levels or generation timeouts.

## Cache Sessions and Usage

DeepSeek, Kimi, GLM/ZCode and Claude preserve explicit cache bindings across Messages, Chat
Completions and Responses entry points. The binding priority is `prompt_cache_key`, then a
recognizable session in `metadata.user_id` (a JSON-encoded object with `session_id`, or the
`user_..._account_..._session_<UUID>` form), then caller-provided `cache_control` boundaries.
The first two survive transcript compaction; boundary-only bindings use the original system
text and first user message, so appended turns, moved boundaries and changed TTLs remain stable.
Cache controls nested in Chat Completions function definitions are recognized as well.

The binding keeps both the relay session and the preferred eligible account stable, including
when a caller switches between a supported model alias and its canonical name. Sessions are
scoped to the gateway API key and canonical model; generic user IDs and unmarked requests do
not bind a conversation. Account priority, availability and failover still apply. Non-GPT
`prompt_cache_key` values are local routing metadata and are removed before forwarding to
upstreams that do not accept them. Cache intent is read before protocol conversion or automatic
Claude cache preparation, not reconstructed from gateway-added cache markers.

Claude cache preparation preserves caller-owned breakpoints. When a later system block
already has a cache boundary, the gateway does not add a redundant identity-only boundary;
the spare slot can retain the previous user turn alongside the newest turn, within the
four-breakpoint limit. This improves boundary continuity but does not guarantee upstream hits.

DeepSeek `prompt_cache_hit_tokens` is also exposed as `prompt_tokens_details.cached_tokens`
on Chat Completions and carried into the corresponding Messages/Responses usage fields and
request-log cache counts, for both JSON and streaming replies. A valid standard cached-token
counter takes precedence, including zero. Native counters are retained on Chat Completions;
`prompt_cache_miss_tokens` is not treated as cache-write usage. Missing counters are not
fabricated, and stable routing does not guarantee an upstream cache hit or retention period.

## Relay Agents

This gateway sends signed relay-agent metadata for every model it can identify: `claude`,
`codex`, `dsh`, `kimi`, or `zcode`. DeepSeek models route to `dsh`, Kimi models to `kimi`, and
GLM/ZCode models to `zcode`; the metadata is encrypted on requests to the official relay. The
desktop `gui` and `pi` integrations are not exposed as synthetic API models because 0.0.338 does
not assign them one stable relay model ID and wire contract. Agent names do not establish account
entitlement or model availability.

The 0.0.338 desktop bundle references `claude-fable-5-1`, `gpt-6-astra`, `deepseek-flash`
(labelled v4.1 Flash), `deepseek-v4-pro`, `kimi-k3`, `glm-5.3-flash`, and `glm-5.3`, in addition
to the established Claude and GPT models. The relay continues to return its live model directory
from `GET /v1/models`; this gateway treats that directory as authoritative for every individual
account.

`MIRASIM_RELAY_AGENTS` remains opt-in for `dsh,kimi,zcode`: the gateway can route their model
namespaces, but it does not advertise static IDs until the live model directory confirms those
models for the account. `kimi-k3` no longer needs the setting — the relay's own directory returns
it and `GET /v1/limits` reports it available — so it is listed and routed without one.

**Each agent is served on one endpoint, and the model decides which.** Claude and ZCode answer
Anthropic Messages, Codex answers the Responses API, and DeepSeek and Kimi are served on OpenAI
chat completions only. A model sent on another protocol is translated to the endpoint that serves
it and translated back, streamed or non-streamed and with function tools preserved. Claude-only
identity, prompt-cache and thinking preparation is deliberately not added to a ZCode request.
A chat-completions upstream is always asked for a stream, even when the caller wanted one
object: a non-streaming request gets its response headers only when the whole completion is
done, and a slow generation outlasts the header wait and fails over for nothing. The caller's
shape is unchanged — a non-streaming caller gets the stream folded back into a single object.
The same applies to a Claude model reached through `/v1/chat/completions` or `/v1/responses`:
the translated Messages request always streams, because a non-streaming Messages answer — thinking
included — arrives only once it is fully generated and otherwise ran into the header timeout,
failed over to a cold account and ended as a slow `504`. A native `/v1/messages` request is
forwarded with the `stream` value its caller chose.
`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are retained as aliases of
`deepseek-flash`; `kimi-code/k3` and the other desktop labels remain aliases of `kimi-k3`.

**The relay admits Anthropic Messages traffic only from a client it recognizes.** Every other
`User-Agent` is answered `403 this client is not supported; use the mirasim client or Claude
Code` before any model is reached — and Node's fetch default (`node`) is one of the refused
values, so a Claude request this gateway used to send was refused outright whether it arrived on
`/v1/messages` or was translated from `/v1/chat/completions`. A request for the Claude (or ZCode)
upstream therefore states this gateway's own Mirasim client identity, `Mirasim/<version>` with the
same version the relay is already told in `x-mirasim-client`. This is the gateway naming itself,
not a borrowed Claude Code identity: the caller's own `User-Agent` is not forwarded on this path,
and no other product's identity is claimed. The other agents — Codex, DeepSeek, Kimi — are not
gated on the client, so their requests are unchanged. A refusal that still reaches the caller is
the relay's own decision about the account, not a missing client identity, and is not retried on
another account.

The official relay uses device authentication at `https://relay.mirasim.ai`. Ticket minting and
subsequent requests use the official embedded WebAssembly signature core, binding the device key,
credential, metadata, and raw body. The 0.0.383 core is byte-identical to the local core loaded
by this proxy. Relay requests then seal their metadata into `x-mirasim-enc` using the official
`mrs-seal-v1` format; ticket minting itself retains the official unsealed signing headers. Missing
keys, unavailable/expired tickets, or encryption failures stop the request instead of falling back
to unsigned traffic. Ticket mint failures honor `Retry-After` and use a per-profile backoff; a
blocked device session does not automatically retry the same request on another account.

Optional relay collection is requested off with signed, sealed `x-mirasim-collect: off`. The bundled CLI defaults `MIRASIM_ANALYTICS`, `MIRASIM_DIAG`, and `MIRASIM_RECORD` to `0`; explicit environment overrides are respected. Device settings and refreshed credentials use owner-only file permissions. These are privacy controls, **not anonymity or a no-ban guarantee**: Mirasim still receives the credential, device identity, decrypted metadata, and request content, and decides access and account enforcement. Use only authorized accounts and permitted workloads.

## Web Console

Open `http://127.0.0.1:8787/` after starting the service. The console is protected by a username/password login. The default username is `admin`; set a stable password before startup:

```bash
WEB_AUTH_USERNAME=admin WEB_AUTH_PASSWORD='choose-a-long-password' npm start
```

When `WEB_AUTH_PASSWORD` is omitted, startup shows a random one-time password only on an interactive terminal, never in redirected service logs. Set `WEB_AUTH_PASSWORD` for unattended deployments. Accounts and hashed API keys are stored in SQLite at `MIRASIM_DATABASE_FILE` (default: `~/.mirasim/mirasim.sqlite`). Existing `MIRASIM_HOMES` are imported into the database on first start. The account pool rotates across available logged-in accounts; this is not a mechanism for bypassing an upstream refusal or account restriction.

The console reads the current membership referral activity directly from the Mirasim relay for each logged-in profile. `GET /auth/referral` returns the invitation code, how many invitations have been redeemed, the invitation threshold, whether it has been reached, how many redemptions the code itself still has, and the current and next plan. The console shows the official plan names (`none` = FREE, `basic` = MAX 2X, `plus` = MAX 10X, `max` = MAX 40X, `enterprise` = 企业版), and derives the reward tier the way the desktop client does: the next plan while the threshold is unmet, the current plan once it has been reached. Progress is measured against the invitation threshold; the code's remaining redemptions are reported separately, because they are a different quantity. Accounts can be added from the login dialog and removed from the pool; removing one keeps its local profile files intact.

The same page also supports the official Mirasim email login flow. Choose the configured profile directory, request the email code, then submit the code. The browser sends the email and verification code only to this local gateway; the gateway calls the current Mirasim authentication service (`https://auth.mirasim.ai/auth/code` and `/auth/verify`) and stores the returned session only in that profile's `setting.json`. Set `MIRASIM_LOGIN_URL` only when using a different official release environment.

The console can create a referral code and redeem one against the selected profile. A successful redemption refreshes that profile's local Mirasim login session; no token is sent to the browser.

Creating a code repeats the desktop client's request exactly: `POST /auth/referral` carrying the bearer token and nothing else — no content type and no body. Mirasim can pause code creation for the whole service (it answers `503 {"detail":"invite code creation is paused"}`), so the console reports that state in Chinese instead of the raw upstream text, a refused creation falls back to the code the account was already issued, and the MoeMail invitation picker stops asking further accounts once creation is paused. Note that `max_redemptions` is reported even before a code exists, so the panel describes redemption capacity only once a code has actually been issued.

Mirasim routes redemptions by code prefix, and so does this gateway. A code that starts with `MLIC` (ignoring case, spaces, dashes, and underscores) is a licence and goes to `/auth/license/redeem`; anything else is an invitation code and goes to `/auth/invite/redeem`. A licence is checked with `/auth/license/preview` first, so one below the current plan is refused locally and stays unconsumed, and the console can report the tier and duration a licence grants before it is redeemed. `POST /api/invites/preview` exposes that check (`{ account, code }`); it answers `{ supported: false }` for a plain invitation code, which needs no pre-check. Upstream throttling is surfaced as HTTP 429 with the official `retry_after` cooldown in the message. The self-invitation guard applies to invitation codes only.

The quota panel reports available window-level measurements, relay availability, and request/token usage that this proxy can verify from relay call records. It does not infer an account's total remaining credit from those measurements.

## Model availability

**模型健康** keeps one result per model. Refreshing the directory queries `GET /v1/models` through the currently selected usable account. Every discovered or configured model — Claude included, matched case-insensitively by the exact ID — is checked with the same `GET /v1/limits` request: one quota/availability reading through the currently selected usable account. No generation request is sent for any model, so a check never consumes model allowance and never depends on the relay admitting a Messages client. A healthy result means the model is reported available, **not** that inference ran; it is a directory/quota check, not an inference or first-token-latency benchmark.

A `403`, `429`, `401` or other non-OK limits response is recorded with its own status classification (`unavailable`, `limited`, `unauthorized`) and the upstream message where one is available; the check does not fall back to OpenAI Chat or try another account after a refusal. Session acquisition, headers and response-body reads share the configured health timeout (`MIRASIM_MODEL_HEALTH_TIMEOUT_MS`, default 12 s).

The periodic scanner advances one model at a time (`MIRASIM_MODEL_HEALTH_INTERVAL_MS`, default 30 minutes). Results are stored in SQLite and retained when the directory is refreshed.

Both manual checks and scheduled scans refresh expiring or expired account sessions before selecting a profile, just as directory discovery does. This keeps an idle gateway from reporting “没有可用的已登录账号” merely because its access tokens expired between scans. Refresh failures and manually disabled accounts still respect the pool's normal availability rules.

### MoeMail single-account signup

The login dialog includes a MoeMail signup queue. It creates temporary inboxes one at a time, requests the Mirasim email code, waits up to two minutes for each code, optionally redeems the entered invitation or `MLIC` licence code, and only then persists each successful account in the SQLite pool. When that field is left blank, the queue borrows an invitation code from the highest-ranked paid account in the pool whose code still has redemptions left. A queue contains at most five accounts and stops at the first error or upstream rate limit. The same dialog can save the MoeMail service address, API key, and domain. The API key is encrypted in SQLite with the current `WEB_AUTH_PASSWORD` and is never sent back to the browser. Environment variables below remain useful for unattended deployments:

```bash
MOEMAIL_URL=https://your-moemail.example \
MOEMAIL_API_KEY=your_moemail_api_key \
MOEMAIL_DOMAIN=your-mail-domain.example \
npm start
```

Optional settings: `MOEMAIL_EXPIRY_MS` (default `3600000`), `MOEMAIL_CODE_TIMEOUT_MS` (default `120000`), and `MOEMAIL_POLL_MS` (default `2500`). MoeMail's API key must be allowed to create and read mailboxes for the configured domain.

Web authentication applies only to the console and its `/api/*` management routes. All OpenAI-compatible `/v1/*` relay endpoints require a console-generated API Key.

`/v1/messages` forwards the native Anthropic request and streaming response. Every Claude-family
request reaching upstream `/v1/messages` — native, or translated from `/v1/chat/completions`,
`/v1/responses` or `/backend-api/codex/responses` — passes through the same identity and cache
preparation before relay signing. The gateway prepends the following block when an accepted agent
identity is absent. This is a JSON **request-body system block**, not an HTTP header:

```json
{
  "system": [
    {
      "type": "text",
      "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
      "cache_control": { "type": "ephemeral" }
    }
  ]
}
```

Client system instructions remain after the identity. An existing accepted identity, including Claude Code's `You are Claude Code, Anthropic's official CLI for Claude.`, is not duplicated or replaced for an ordinary native prompt. Claude-targeted OpenAI requests also accept the top-level `system` string/block-array extension shown above; Chat `system`/`developer` messages and Responses `instructions` remain supported. Their text-block cache controls and function-tool cache controls survive translation. System/developer instructions occurring after conversation messages stay in place as relay Messages `system` turns instead of being moved to the initial prompt. The `system` extension is a gateway compatibility feature, not a standard OpenAI request field.

On OpenAI-to-Claude bridges, a leading Claude Code identity declaration in system instructions becomes the generic Claude Agent SDK identity regardless of whether another product's declaration is recognized. This also covers Claude Code requests that arrive through an external OpenAI converter: the incoming wire protocol, not the client's displayed name, determines this normalization. Task instructions, inline system-turn positions and cache preferences are retained; ordinary native Messages prompts and GPT/DeepSeek routes are unaffected. A quoted or fenced Claude Code identity example is not treated as a declaration.

The bridge also separates an identity declaration from instructions appended to the same text block. Changing the identity wording alone is insufficient: the relay has rejected a combined identity/product-context block with `system prompt must not present another product's instructions behind Claude Code's identity line`, while accepting the same context in a separate block. The identity therefore occupies its own block; the remaining instructions stay in their original system scope, with any existing cache marker on the remainder so its cache boundary still covers the full original prefix. Added identity cache markers still respect the four-breakpoint limit. Product references in those instructions are not blanket-deleted or moved into user messages.

For Claude upstreams, recognized incompatible system identity declarations such as `You are Codex, based on GPT-5.6.` or `You are a coding agent running in the Codex CLI, a terminal-based coding assistant.` are adapted to a neutral coding-assistant declaration before signing. A Claude Code identity attached to such a mixed-product prompt becomes the generic Claude agent identity; ordinary native Claude Code prompts are unchanged. The old `Follow the client instructions below.` masking prefix is no longer added and is removed from a legacy block when its conflicting declaration is corrected. Task constraints and tool rules remain in system messages, not hidden in user messages, and identity-adjacent constraints are preserved. Quoted examples, fenced code, user messages, tool payloads and signed thinking are not rewritten. GPT/DeepSeek routes retain their original prompts. This is a bounded compatibility conversion, not blanket removal of product names, a retry-on-400 policy, or proof that every upstream prompt restriction is resolved. Unrecognized upstream errors are returned unchanged.

Actual HTTP `anthropic-version` and `anthropic-beta` headers are added only for an Anthropic upstream, with caller overrides retained and the existing official-relay beta filtering applied. A Messages client targeting GPT or DeepSeek does not leak those headers to its OpenAI upstream. The gateway does not inject the Claude identity into GPT, DeepSeek or Kimi requests. Response conversion continues to keep thinking, visible text and tool calls in separate protocol fields in both streaming and non-streaming mode.

The Claude relay agent serves `claude-*` models on the Anthropic Messages API; the 0.0.338 ZCode
agent serves `glm-5.3` and `glm-5.3-flash` on that wire contract as well. When
`/v1/chat/completions` or `/v1/responses` receives one of these models, the gateway translates
the request to `/v1/messages` (system prompts, text and image content, function tools, tool
results, stop sequences) and converts the Anthropic response — including SSE streams, tool calls,
and errors — back into the OpenAI format the client expects.

With no caller-managed cache controls, the gateway marks the identity block, the last system block when distinct, and up to the remaining four-breakpoint budget on recent user turns. Identity insertion and cache allocation happen once, after protocol conversion, so they cannot independently add a fifth breakpoint. Caller-owned cache controls on tools, system and messages are counted and preserved — never moved or rewritten, TTL included — and the slots they leave spare are filled the same way: the last system block when distinct, then the most recent unmarked user turns. That top-up keeps the history readable for a caller that marks only its newest turn (Claude Code does): an upstream that does no lookback of its own would otherwise read the static prefix on every turn and nothing else, which shows up as a `cache_read_input_tokens` that never grows. The string shorthand for system and message content is rewritten to block form on every request, marked or not, so a turn keeps one consistent shape as the breakpoints roll past it. An unmarked identity gets a cache marker only when there is room. If all four slots are already occupied, the identity text is still added but its extra marker is omitted rather than breaking the request. A supplied one-hour TTL is retained, and an added identity marker uses that TTL when needed to avoid placing a shorter-lived prefix before it. Existing accepted identities with cache controls are left unchanged. Watch `cache_read_input_tokens` in usage figures to check actual cache hits; a cache marker alone does not guarantee a hit.

## Reasoning Passthrough

Native GPT Responses requests also support Codex `namespace` tools. The gateway flattens both `function` and `custom` children for the relay and restores their original `namespace`/`name` in streaming items, final responses and subsequent tool-call history. Custom inputs and grammar definitions remain native; they are not converted to JSON function arguments. Collisions or unsupported namespace children return explicit validation errors instead of dropping execution tools.

Messages requests may contain mid-conversation `role: "system"` entries. Native Claude requests retain those entries; Chat bridges retain the system role, while the GPT relay requires mapping inline system messages to `developer`. Their order is preserved instead of treating instructions as user text or moving them ahead of earlier turns. On bridged requests, `clear_at: "next_user_message"` expires a reminder after any later user message, including a tool-result turn. Client `tool_addition`/`tool_removal` references update the currently offered tools, including deferred declarations. Unsupported server-tool references still return an explicit validation error. GPT Responses-to-Messages conversion forwards upstream SSE heartbeats as Anthropic `ping` events without inventing text, tool results, or completion events.

`MIRASIM_REASONING_MODE=passthrough` is the default. Native Claude `thinking`/`output_config`, GPT Responses reasoning effort, and Kimi/DeepSeek Chat reasoning settings retain the client's values. No default reasoning level or minimum effort is injected, including when an existing service environment still sets `MIRASIM_MIN_REASONING_EFFORT=max`. Explicitly absent effort settings remain absent; explicit disabling is not replaced by the configured default. GPT requests add `reasoning.summary=auto` only when reasoning is not explicitly disabled and no summary preference was supplied, so available reasoning can be displayed without changing its effort. This is reasoning-field passthrough, not a bypass of the relay's other protocol, authentication or sampling compatibility handling.

Cross-protocol requests still require translation. Messages `output_config.effort` and Responses `reasoning.effort` become Chat `reasoning_effort` for Kimi/DeepSeek. Known aliases are normalized during translation (`minimal` → `low`, `extra-high` → `xhigh`, `ultra` → `max`); native effort values are not normalized in passthrough mode. An Anthropic adaptive thinking switch becomes Chat `thinking.type=enabled`, without the Anthropic-only display field. For DeepSeek and GPT, an enabled Anthropic token budget maps to the existing effort ladder when no named effort was supplied; DeepSeek receives only its thinking switch, not Anthropic budget/display fields. Explicit disabling takes priority over competing effort hints and survives managed defaults/floors. DeepSeek managed mode also applies configured defaults/floors rather than dropping the client's reasoning request. Chat/Responses efforts become Claude adaptive `output_config.effort`; budget-based Claude models use the existing effort-to-budget table, and an unknown effort that cannot be converted returns a descriptive 400 instead of silently disabling thinking. Explicit native Anthropic thinking objects retain their shape and budget. Unsupported native values are left for the upstream to accept or reject rather than silently normalized. In passthrough mode, an unrestorable tool history no longer silently turns thinking off; the caller must retain valid native signed history if that upstream requires it.

DeepSeek and GPT reasoning stays separate from the answer across Chat Completions, Messages, Responses, and `/backend-api/codex/responses`, in streaming and non-streaming conversions. Chat upstreams normalize a leading `<think>…</think>` span and string `reasoning` aliases into `reasoning_content`, including the formerly unfiltered native Chat route. Stream parsing handles split tags, split UTF-8, independent choices and final buffered fragments; tags occurring after visible answer text remain literal. Messages exposes thinking blocks, Responses exposes reasoning items, and GPT bridges also preserve `response.reasoning_text` events without putting them into answer text. Tool calls, finish reasons and usage remain on their own fields. No reasoning text or signatures are invented when the upstream does not supply them.

Kimi/DeepSeek reasoning output is preserved as Chat `reasoning_content`, Responses reasoning summaries, or bridged Messages thinking blocks and `thinking_delta` events. Chat-backed Messages blocks do not invent an Anthropic signature: they are converted back to `reasoning_content` for that same Chat-backed model on replay, not treated as signed Claude history. Native Claude signatures and GPT reasoning response data remain on their native paths. SSE conversion keeps partial UTF-8 characters intact.

The console's **上游思考参数** column describes fields actually sent, not a claim that the provider honored them. Missing fields display **未指定（上游默认）**, not **关闭**. `thinkingLevel` records the sent setting and `reasoningEffort` the client's request; only explicit disabling is shown as off. Offline tests establish forwarding behavior, not which effort names the live Kimi service supports or whether it returns reasoning on a particular request.

### Legacy Managed Mode

Compatibility verified on September 29, 2026: `gpt-6-astra` rejects disabled reasoning (`none`). The gateway maps explicit disabling for this model to its minimum supported effort, `low`, in both reasoning modes, preserving other reasoning fields and recording requested versus outgoing effort separately. Other models are unchanged. Pretty-printed upstream parameter-error frames are recognized and returned as HTTP 400 rather than a JSON-parser 502; invalid requests are not retried across accounts.

Set `MIRASIM_REASONING_MODE=managed` only to restore the previous default injection, normalization, history fallback and effort floor. The following historical reasoning policies apply to that mode, not to the default passthrough mode; the transport requirements for Codex still apply in both modes.

Thinking levels map to Anthropic extended thinking on translated `claude-*` requests, and the shape follows the model. A **current model** — `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5` — is steered by a named rung that travels *outside* `thinking`, in `output_config: { effort }`, alongside `thinking: { type: "adaptive", display: "summarized" }`. An **older model** — `claude-haiku-4-5` — is steered by `thinking: { type: "enabled", budget_tokens }` and refuses both the rung and the adaptive type with a 400. `reasoning_effort` (chat completions), `reasoning.effort` (responses) and a `-thinking` model-name suffix (medium, stripped before it reaches upstream) all feed the same decision; an Anthropic-style `thinking` object is honored directly. Thinking output returns as `reasoning_content` on the chat message, or `delta.reasoning_content` chunks when streaming.

The rungs are `low`, `medium`, `high`, `xhigh` and `max`, with `minimal` folded into `low` the way the official client folds it; a name outside that set is refused upstream with a 400. Measured on one prompt through this gateway, they are real and graded — `low` 207, `medium` 236, `high` 243, `xhigh` 244, `max` 951 completion tokens, with the returned reasoning growing from 121 to 310 characters. For an older model the same names become budgets of 1024/2048/8192/16384/24576/32768 tokens, and `max_tokens` is raised above the budget when needed.

Two details are easy to get wrong, and both fail silently rather than loudly. `display` is what makes the reasoning come back at all: without it an adaptive model answers `200` with no thinking block, so the reasoning simply is not there (`raw` is refused; `summarized` is the only value that works). And a current model **accepts** `{ type: "enabled", budget_tokens }` with a `200` and then ignores it — no rung, no reasoning — so a caller that sends one is carried over to the rung nearest its budget rather than passed through into silence. `temperature`/`top_p` are dropped while a budget is in force, which is when Anthropic rejects them; a forced tool choice survives on the adaptive path, which accepts one.

On the **official Mirasim Messages relay**, `temperature` is also omitted when thinking is off, including the formerly retained value `1`. A September 9, 2026 same-account comparison reproduced sub2api's 400 with `temperature: 1`; removing only that field changed the response to the account's independently confirmed quota-limit 429. The removal happens before signing and applies to native Messages and Chat/Responses requests translated into Messages. The existing temperature behavior for custom upstreams and non-Anthropic OpenAI routes is unchanged. No sub2api-side configuration change is required for this normalization. See `docs/sub2api-400-2026-09-09.md` for the evidence and remaining quota limitation.

Before any of that, what the caller said is restated in a shape the relay accepts. Each rewrite replaces a request the relay would refuse outright, or answer `200` with the reasoning silently missing, with the nearest one it honours — a caller that sent something valid is untouched. A rung name is trimmed and lowercased; `minimal` folds to `low`, and `ultracode` folds to `xhigh` (the Claude Code session mode combines xhigh with client-side workflow orchestration, not max). A name nothing can place counts as **unsaid**, so the level this gateway would have chosen anyway applies instead of a certain `400`. `output_config` is dropped from a request to an older model, which is refused for carrying one, and `thinking: { type: "adaptive" }` sent to one becomes the budget that level means. `display` is settled to `summarized` whenever thinking is adaptive — including on a request that named its own rung, which is the shape Claude Code sends and the one nothing else fills in.

Claude Code compatibility checked locally on September 27, 2026: installed CLI `2.1.282 --help` lists `low`, `medium`, `high`, `xhigh`, and `max`; its embedded `/effort` help describes `ultracode` as `xhigh + dynamic workflow orchestration`. Native Messages requests preserve the five effort values and other `output_config` fields in passthrough mode. If a client sends the session-mode name itself, `output_config.effort: "ultracode"` is normalized to `xhigh` in both modes; protocol bridges use the same alias. Managed defaults/floors also accept this alias, and a configured `max` floor can still raise it. Logs retain the requested `ultracode` separately from the outgoing level. This does not start workflows or subagents. Official documentation retrieval was unavailable for this check, and model-specific live upstream acceptance was not re-probed.

### Codex (GPT) turns

The relay serves GPT models on its own Responses endpoint, and only there: `POST /v1/chat/completions` with `gpt-5.6-sol` answers `404 model "gpt-5.6-sol" is not served on /v1/chat/completions; use /v1/responses`, and `/backend-api/codex/responses` — where this gateway used to send them — no longer exists. A Responses request is already in that endpoint's wire format, so it is forwarded rather than translated, which keeps `prompt_cache_key` and the Codex identity intact for the upstream prompt cache.

That endpoint validates the field set as strictly as the Messages one. Measured: `store: false` and `stream: true` are **required**, and `input` is taken only as an array; `max_output_tokens`, `temperature`, `top_p`, `metadata`, `previous_response_id`, `store: true` and `stream: false` are each refused with a bare `400`. `instructions`, `tools`, `tool_choice`, `parallel_tool_calls`, `text`, `include`, `prompt_cache_key` and `reasoning` are accepted. The gateway normalizes transport and sampling fields before forwarding. For native GPT Responses requests, it can now resolve `previous_response_id` from a **local, API-key-isolated memory cache**, expand the complete input/output history, and send a self-contained request upstream. History references are never silently removed without restoring their context. `conversation` and stored `item_reference` inputs remain unsupported; cross-provider Responses conversions still require complete input history.

Both `/v1/responses` and the compatibility alias `/backend-api/codex/responses` require a valid Bearer API key. Use the same key and model for continuation; an unknown, expired, evicted, different-key or incompatible-model response ID fails before contacting the upstream. Start a new conversation or resend complete input history, including tool calls/results, to recover. Responses created before this feature was started cannot be recovered retrospectively.

Omitting `store`, or sending `store:true`, permits short-term local retention of a successfully completed response. **Explicit `store:false` disables retention of that response**, but it may still reference an already cached parent. Upstream requests always use `store:false`; the final client-facing `store` value describes the local cache instead. Failed, incomplete, cancelled or truncated responses are not retained as continuation points. A response without a usable ID/output is also not retained. Oversized histories fail explicitly rather than being silently truncated or advertised as stored.

The cache is process-local and never written to the database or request log. Limits are a fixed 30-minute lifetime from completion, 500 records / 64 MiB globally, 100 records / 32 MiB per API key, and 16 MiB / 16,384 items per history, with least-recently-used capacity eviction. These are serialized-data budgets, not a precise bound on JavaScript heap usage. Restarting the gateway loses this state; multiple instances require requests to reach the same instance. This is not persistent OpenAI response storage, and no response retrieval/deletion or conversation API is implemented. Clients that always send `store:false` must continue sending full history rather than relying on ID continuation.

Only input/output items are inherited: top-level `instructions`, tools and reasoning settings come from the current request. Native namespace/custom-tool items, message phase and reasoning fields are retained without a Chat conversion. Stored GPT turns request `reasoning.encrypted_content` alongside existing `include` entries. Whether a particular upstream returns replayable encrypted reasoning, especially across account failover, requires live validation; the gateway never removes that field to disguise a replay failure.

GPT requests from Claude Code (`/v1/messages`) and Chat Completions clients (`/v1/chat/completions`) are translated to `/v1/responses` with the Codex relay agent. Function definitions, tool choices, parallel calls, call IDs, arguments and tool results are converted in both directions; the caller receives its original protocol, including streamed tool blocks and the appropriate tool-use stop reason. Native Codex Responses requests retain their function/custom tools and tool history without a Chat Completions round trip.

For GPT requests arriving through `/v1/messages`, cache intent is preserved before translating away Anthropic-only fields. An explicit `prompt_cache_key` wins. Otherwise, a recognizable session in `metadata.user_id` (a JSON-encoded object with `session_id`, or the `user_..._account_..._session_<UUID>` form) produces an opaque key scoped to the gateway API key and model. This session binding survives transcript compaction. A generic user identifier alone is not treated as a conversation ID.

Without an explicit key or session, GPT requests on Responses, Chat Completions and Messages derive an opaque, stable cache key from the API-key owner, model, system prompt and first user message. No `cache_control` marker is required. Appended turns do not change that binding; clients that compact or replace the conversation origin should supply a stable `prompt_cache_key`. Identical conversation origins under the same API key/model share a cache binding, not response history. Existing Anthropic cache-marker bindings remain supported. Requests without a usable conversation origin or explicit binding still receive a fresh session. The relay session also controls local account affinity, and `previous_response_id` continuations inherit the stored prompt cache key when none is supplied. Different API keys and models remain isolated. Anthropic cache markers and metadata are not forwarded as unsupported Responses fields, and Anthropic `ttl` is not an upstream retention guarantee. Reported cache reads continue to come from upstream token usage, not an estimated or synthetic hit count.

The GPT Messages and Chat Completions bridges also recognize Responses SSE bodies when the upstream omits `Content-Type` or incorrectly labels them as JSON/plain text. Detection inspects only a bounded prefix, including fragmented SSE field names, without buffering the full answer. Non-streaming callers still receive one JSON object; streaming callers keep receiving incremental events.

Because the relay refuses a non-streaming request, the stream is always asked for, and a caller that wanted a single object gets it folded back into one. JSON and streaming conversions share an output accumulator: empty or partially populated completion envelopes are merged with completed items, deduplicated by item ID/index and ordered by output index. Native custom-tool events remain intact. A terminal event ends the response and cancels any remaining upstream body; truncated streams are not treated as successful completions. SSE decoding preserves UTF-8 characters split across network chunks.

### Protocol validation and tool streaming

- Invalid message blocks, function definitions, tool-call IDs and argument JSON return `400` with a field path instead of failing inside a converter.
- Cross-provider Responses conversions accept function tools and URL/data-URL images, including images returned by tools. They reject custom/built-in tools, encrypted reasoning, unresolved file IDs and unsupported attachment types rather than silently dropping them. Native GPT Responses retains its custom tools and native history; unsupported cross-provider requests must be adapted by the caller.
- Messages conversions to GPT/Kimi/DeepSeek require client-executed tools with `input_schema`. Provider-hosted tools and unsupported documents return descriptive `400` errors. Native Claude requests are not subject to these cross-provider capability restrictions.
- Messages tool arguments are sent incrementally once the first tool's identity is known. Additional parallel calls are buffered to keep content-block ordering valid. Tool arguments must be complete JSON objects before a successful message stop is emitted; interrupted or malformed calls fail instead of being replaced with empty arguments.
- Cancelling a client request cancels the upstream body/fetch through conversion layers and prevents further account failover for that request.

The rungs are the same five, measured on `gpt-5.6-sol`: `low`, `medium`, `high`, `xhigh`, `max`, echoed back on the response and rising in reasoning tokens (47/48/53/54/88 on one prompt). `minimal` is refused there with `unsupported_value` and anything unplaceable with `invalid_value`, so `light`/`minimal` fold to `low`, `extra high` to `xhigh`, and `ultra` to `max` — which is what the desktop client does with `ultra` itself before anything leaves the machine. A rung nothing can place is dropped rather than sent, leaving the model on its own default of `medium`.

`MIRASIM_MIN_REASONING_EFFORT` is a floor rather than a default: it lifts a level that arrived below it and never lowers one that arrived above, and a request that asked for no thinking still gets none — it sets how hard a turn thinks, not whether it thinks. It applies after the level is settled, whoever settled it, which is what separates it from the default: a client that names its own rung is lifted too. Current locally installed Claude Code can request `xhigh` or `max` directly through `output_config.effort`; a floor is only needed when the operator intentionally wants to lift a lower client setting in managed mode. On an older model, which has no rung, the floor arrives as the token budget that rung stands for.

**使用明细** reports the outgoing setting and, when different, the caller's setting underneath as `请求 …`. Missing settings are unknown/provider-default, never evidence that a turn did not think. `GET /api/usage-log` carries the same pair as `thinkingLevel` (what was sent) and `reasoningEffort` (what was asked).

Codex `ultra` compatibility: when a GPT request explicitly carries `reasoning.effort: "ultra"`, the gateway maps it to the relay's `max` even in passthrough mode, preserving other reasoning fields such as `summary`. Chat Completions and Messages bridges use the same mapping. The usage log retains the original `ultra` request alongside the outgoing `max`; this is not a sixth upstream reasoning rung. Both managed-mode effort environment settings also accept `ultra` as an alias for `max`. Automatic task delegation belongs to the Codex client: this gateway does not enable delegation by mapping an effort value. Other native effort values remain unchanged in passthrough mode.

The usage view includes filter-scoped request counts, completed-request success rate, reported input/output tokens and average completed duration. Search matches model, account, local/upstream request ID and error code; status/protocol filters and duration/output-token sorting apply before pagination. Active requests never count as successful simply because upstream headers report HTTP 200, and incomplete/cancelled/error streams remain distinct. Unknown token usage is displayed as missing rather than inferred from character counts. “首字节” measures the first upstream body chunk, not the first visible answer token. The detail panel shows timings, reasoning settings, tool names, upstream diagnostics and account attempt order, without exposing message text, reasoning text or tool arguments. Automatic refresh runs every five seconds while this view is active and can be paused; refresh failures retain the last successful snapshot and show a warning. Mobile layouts show two-column request cards instead of a wide table. These are recent in-memory records (up to 500), not persistent billing reports; restarting the gateway clears them.

A request that says nothing about reasoning gets `MIRASIM_DEFAULT_REASONING_EFFORT`, `medium` unless it is set to `none`/`minimal`/`low`/`high`/`xhigh`/`max`. Most OpenAI-protocol clients never send `reasoning_effort` at all, so without this they would silently run with thinking off; anything the client does say still wins, and `reasoning_effort: "none"` turns thinking off per request.

The same default reaches `/v1/messages`, for the same reason. A converting gateway such as **sub2api** or **new-api** builds its Anthropic request out of an OpenAI one, and the OpenAI protocol has no field for extended thinking — so the request arrives with no `thinking` and the relay answers without it. That costs more than reasoning quality: **with thinking off, Claude intermittently writes a tool call into its visible text instead of emitting a `tool_use` block, so the turn succeeds, the tool never runs, and nothing reports an error.** "No thinking" and "does not call tools" are one bug, and turning thinking on fixes both. The shape follows the model, as above. A caller that stated its own choice, `{ type: "disabled" }` included, is never overridden, and turns whose `max_tokens` leaves no room for thinking and an answer both (titles, classification) are left alone. A transcript that replays a tool_use turn without its signed thinking keeps thinking off on this path too, because turning it on is what makes the upstream reject that history.

Tool rounds keep their thinking. Anthropic requires the signed thinking block of a `tool_use` turn to come back with the matching `tool_result`, and neither OpenAI protocol has a field that can carry a signature — so the gateway remembers the blocks it streamed out, keyed by their `tool_use` ids, and restores them when the client replays that turn. Signatures are never exposed to the client. Blocks are held in memory for 30 minutes across the 500 most recent tool turns, and replaying a turn keeps it alive, so an active conversation does not lose its own thinking to the cap.

A turn whose blocks are gone (restart, expiry, a client that invents tool-call ids) answers without thinking rather than failing upstream — and the whole conversation then keeps answering without it. Switching `thinking` on or off invalidates the entire message cache upstream, so the decision reads the whole transcript instead of only its newest turn: an unrecoverable turn stays in the history, which makes the choice stick. Deciding per turn would flip `thinking` on every request as an agent loop alternates between tool rounds and plain answers, and pay for the full message history each time. The cost of the stable choice is that such a conversation does not pick thinking back up; starting a new one clears it.

## Timeouts

Sonnet 5.5 can report ongoing hidden thinking as `thinking_delta` events with empty `thinking` and a positive integer `estimated_tokens`. These events renew the generation progress deadline even before visible text or a signature arrives. The estimate is used only for liveness, not billed usage. Pings, empty deltas without a positive estimate, and invalid estimates do not renew the deadline; a stalled generation still times out.

Native `/v1/messages` requests use streaming upstream even when the caller omits `stream` or sets it to `false`, avoiding a response-header wait for the entire generation. Non-streaming callers still receive one JSON message, retaining content blocks, thinking signatures, tool inputs, stop information and usage. Aggregation finishes at `message_stop` without waiting for transport EOF; truncated streams, invalid tool JSON and upstream errors return an Anthropic-shaped HTTP `502` error instead of a partial successful message. An upstream JSON fallback remains supported.

Native Anthropic streams emit a protocol `error` event when the upstream connection fails, times out, or ends without `message_stop`, rather than resetting the downstream HTTP connection or treating truncated output as success. Partial trailing frames are discarded before the error frame so clients can parse it. During upstream silence, the gateway emits Anthropic `ping` events every 15 seconds, only between complete SSE frames and without building an unbounded backlog for slow readers. These local keepalives do not renew upstream idle/progress deadlines. Already delivered text and tool calls are never automatically replayed; an actual upstream failure still requires the caller to retry.

The gateway gives each upstream attempt 45 seconds by default to receive response headers, or 120 seconds for Kimi (`kimi-k3` and its aliases) across Chat Completions, Messages and Responses. Device-ticket acquisition shares this deadline. Streaming Chat preflight also uses the remaining attempt time for normalization and first content; receiving headers does not restart it. Requests settled at `medium`, `high`, `xhigh` or `max` thinking — Claude `output_config.effort`, GPT Responses `reasoning.effort` or Chat `reasoning_effort` — get the same 120-second allowance (`MIRASIM_THINKING_FIRST_BYTE_TIMEOUT_MS`). Medium/high requests can also start slowly or encounter relay congestion; previously they were cut off by the generic 45-second wait and 60-second failover budget. Low-effort and requests without a settled thinking level retain the generic wait. Both waits are capped by `MIRASIM_TIMEOUT_MS` (default 300000 ms); changing that cap alone does not change either wait. The failover window is at least one applicable header wait, and retries use only its remaining time rather than starting a fresh budget. A final response-header timeout still returns `504`. Streaming can continue beyond the header deadline under its separate idle/progress limits. The model-directory request keeps its separate 10-second timeout and falls back to `MIRASIM_MODELS` when necessary. Longer waits cannot guarantee success during an upstream outage.

Claude requests get a 180-second header wait (`MIRASIM_CLAUDE_FIRST_BYTE_TIMEOUT_MS`, also capped by `MIRASIM_TIMEOUT_MS`). The Claude relay now queues a request before it sends any header — the wait is reported afterwards as `x-router-throttle-wait-ms`, measured at 24–37 seconds — so abandoning that wait only rejoins the same queue from the back on another account. While a streaming request waits — Claude or GPT/Codex alike; image generation excepted — the gateway commits the stream after `MIRASIM_QUEUE_HOLD_DELAY_MS` (default 5000 ms): it answers `200` with SSE headers and sends a heartbeat every `MIRASIM_QUEUE_HOLD_INTERVAL_MS` (default 10000 ms) — `event: ping` on Messages, an SSE comment on Chat Completions and Responses — so callers with an idle limit stay connected. A refusal that arrives before the commit keeps its real HTTP status. One that arrives after it is delivered as that protocol's in-stream error event (`event: error` on Messages and Responses, a `data: {"error": ...}` frame followed by `[DONE]` on Chat Completions), and the request log still records the real status.

Heartbeats, role-only chunks and usage-only frames do not release the initial content deadline. This applies to Messages and Responses as well as Chat Completions, including Responses SSE mislabeled as JSON or plain text. JSON replies must finish within the deadline rather than trickling bytes indefinitely before normalization. The attempt deadline above only binds the first content of a stream that is still held back from the caller — a streaming Chat Completions request — because only that one can still go to another account. Every other answer is forwarded as soon as its headers arrive, so it gets `MIRASIM_STREAM_IDLE_TIMEOUT_MS` (default 300000 ms) from the start of the attempt for its first content instead: ending it at the header wait while a long prompt is still being read, or a model is still thinking before its first summary, would only break an answer the caller already has and make it retry from the top on a cache that was never written. Heartbeats cannot stretch that allowance either. Streams that have already sent downstream headers are cancelled on expiry rather than retried mid-answer; native Responses emit their explicit SSE error. Retryable server-error bodies have a separate bounded read: at most 64 KiB and the lesser of one second or the remaining failover budget. Oversized, stalled or unreadable bodies are cancelled without waiting for connection closure. Complete error payloads retain their original details; unusable partial payloads become a JSON error retaining the original HTTP status and safe response headers.

After response headers arrive, `MIRASIM_STREAM_IDLE_TIMEOUT_MS` (default `300000`) bounds the wait for a stream's first content. Once content has reached the caller the answer can no longer move to another account, so a quiet upstream is no longer cut at that allowance: the stream ends only after `MIRASIM_STREAM_STALL_TIMEOUT_MS` (default `1800000`) without the next body chunk, or without further content — reasoning, text and tool activity renew this progress deadline, but heartbeat-only traffic cannot keep a stalled generation alive forever. Meanwhile the caller gets a heartbeat whenever nothing was written for `MIRASIM_STREAM_HEARTBEAT_MS` (default `15000`) — `event: ping` on Messages, an SSE comment on Chat Completions and Responses, only ever between two frames — so a client's own idle limit (reported by Claude Code and Codex as a connection lost mid-response) does not fire while the model is still working. Both idle and progress timers pause during downstream backpressure; neither is a total generation-time limit. `MIRASIM_MAX_STREAM_BYTES` bounds upstream response bytes (default/hard maximum 16 MiB), and `MIRASIM_MAX_SSE_FRAME_BYTES` bounds each SSE frame (default/hard maximum 2 MiB). Both byte limits may be lowered. Responses aggregation is additionally limited to 16 MiB and 4096 output items. A body timeout or limit violation cancels the upstream; non-streaming conversions report an error. Native Responses streams send an explicit SSE error (`upstream_stream_timeout`, `upstream_stream_incomplete` or `upstream_stream_error`) instead of silently closing or emitting a success terminator.

Streaming `/v1/chat/completions` requests wait for actual text, reasoning, refusal text or a tool call before sending successful response headers. Role-only, usage-only and empty completed streams are retried on another available profile within the existing failover budget (at most three server-fault attempts), without cooling an otherwise healthy account. If no attempt produces content, the gateway returns HTTP `502` with `upstream_empty_stream` instead of an empty HTTP `200` stream. The initial content wait uses only the remaining attempt deadline; heartbeats do not extend it. Once content starts, frames flow immediately without buffering the full answer. Subsequent stream errors or premature EOF produce an explicit SSE error and are not retried, avoiding duplicate text or tool calls. The usage log retains the upstream HTTP status separately from the failed generation status. Chat-backed upstreams release their connection at `[DONE]`, preserving preceding usage and cache counters; non-streaming Chat, Messages and Responses conversions no longer wait for transport EOF after the answer is complete.

Native streaming GPT Responses preflight waits at most 250 ms after SSE normalization. Immediate empty or failed streams can still fail over before delivery; otherwise headers and buffered opening events are released without waiting for the first reasoning summary or answer token. After delivery, failures remain stream errors rather than account retries. This removes gateway-held startup events, not the model's own thinking time, and does not reduce reasoning effort. Non-streaming Responses keep their output validation and aggregation behavior.

Non-streaming GPT requests through Responses, Chat Completions and Messages validate the full upstream stream before selecting a successful attempt. A connection cut or error after partial output can still fail over within the existing retry/time budget, because nothing has been delivered to the caller. Failed-attempt text is discarded rather than combined with the next answer. Buffering remains subject to the response-size and per-frame limits; a terminal event releases the upstream without waiting for transport EOF. Explicit `response.incomplete` results remain incomplete, genuinely empty responses still fail, and streaming clients are never silently retried after delivery.

GPT requests on all supported client protocols request `reasoning.summary=auto` when no summary preference or explicit reasoning disable was supplied, so available summaries can be returned in their dedicated reasoning fields without lowering the requested effort. Explicit summary preferences, including `null`, are retained. Summaries depend on the upstream and do not guarantee immediate visible output. The usage log now includes active requests, elapsed time, the latest upstream event, generation stage and safe stream error codes, without retaining message content or tool arguments. HTTP 200 headers alone are not treated as proof of a successful generation.

GPT Responses bodies are checked for SSE framing before request logging and protocol conversion, even when the relay labels the stream as JSON, plain text, or omits its content type. This also applies to GPT requests received through Anthropic `/v1/messages` (including New API channels). Terminal events and token/cache usage are recorded before the bridge releases its source, so normal stream cleanup does not appear as “已取消 · HTTP 200”. Genuine upstream error events remain failures, and absent usage counters are not fabricated.

Anthropic upstream streams likewise close at `message_stop` (or a terminal `error` event), without waiting for the upstream socket to close. This applies both to native Messages and to Chat Completions/Responses conversions; preceding text, tool calls and usage/cache counters are retained, and frames after the terminal event are ignored. A downstream close after an observed successful or incomplete terminal event preserves that outcome rather than rewriting it to HTTP `499`. A genuine disconnect before completion still records `499 / client_disconnected`, cancels upstream work and does not retry the abandoned request. Upstream transport errors remain `502` failures, not client cancellations. Late buffered events cannot turn a finalized real disconnect back into success.

```bash
MIRASIM_FIRST_BYTE_TIMEOUT_MS=45000 \
MIRASIM_KIMI_FIRST_BYTE_TIMEOUT_MS=120000 \
MIRASIM_THINKING_FIRST_BYTE_TIMEOUT_MS=120000 \
MIRASIM_MODEL_LIST_TIMEOUT_MS=10000 \
npm start
```

## Client Example

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer msk_your_console_generated_key' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"Hello"}]}'
```

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H 'x-api-key: msk_your_console_generated_key' \
  -H 'anthropic-version: 2023-06-01' \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-4-5","max_tokens":64,"messages":[{"role":"user","content":"Hello"}]}'
```

`/v1/models` reads the active logged-in Mirasim account's model directory in real time. When no profile is logged in or the upstream directory is unavailable, set `MIRASIM_MODELS` as a fallback list:

```bash
MIRASIM_MODELS=gpt-5,claude-sonnet-4-5 \
MIRASIM_HOMES=$PWD/profiles/account-a npm start
```

## Verify

```bash
npm test

MIRASIM_HOMES=$PWD/profiles/account-a npm run relay
```
## 额度与用量展示

账号池已移除独立的「额度汇总」卡片；各账号明细保留全部额度窗口、剩余百分比、进度条及重置时间。

账号列表支持单选、选择本页、选择全部筛选结果、清空选择，选择可跨分页和筛选保留。可批量停用、恢复或删除，提交前显示确认；删除仅移出账号池，不删除本地登录文件。失败账号保留选择并显示结果。批量接口 `POST /api/accounts/bulk` 接收 `action`（`disable`、`recover`、`delete`）及 `accounts`（每项包含快照中的 `key` 和 `selectionId`）。服务端先校验全部账号身份再处理，防止列表序号变动导致误操作；单次最多 1000 个账号。

更新此功能时需要重启网关进程，再刷新浏览器；只刷新静态页面不会更新后端接口。若账号勾选框全部禁用且出现「后端版本尚未更新」，说明快照缺少 `selectionId`。确认没有进行中的推理请求后，再重启服务，避免中断流式响应。账号名称和勾选框都可点击选择。

金额统计已从前后端彻底移除：不再计算或返回近 5 小时、近 7 天预估消耗及额度金额汇总，不再读取金额换算或模型价格配置。数据库启动时自动删除历史计价表和计价起始标记；保留账号、密钥、请求数、Token 用量和各账号额度窗口百分比。
