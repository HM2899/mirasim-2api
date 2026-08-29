# mirasim-2api

Linux-native OpenAI protocol proxy for Mirasim `v0.0.239`. It uses the Mirasim login flow and relay credential saved by the bundled Mirasim CLI. No OpenAI, Anthropic, or other upstream API key is configured in this project.

The project includes the `server.cjs` core extracted unchanged from the supplied Mirasim DMG:

```text
SHA-256 b1baba6db720746be6fe0ff8fe90a555f5d06df33be2af53e7a9c3b31a231135
```

## Login

Node.js 20+ is required. Log in through the original Mirasim flow. It opens the browser flow or runs the email verification flow and writes only to the selected Mirasim profile directory.

```bash
cd /home/lzh2002/mirasim-2api

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

Open the Web console and create an OpenAI API Key before calling `/v1/*`. Keys use the `msk_` prefix, are shown only once on creation, and are stored locally only as SHA-256 hashes in SQLite. Use `MIRASIM_DATABASE_FILE` to choose the database path (`MIRASIM_API_KEYS_FILE` remains a compatible alias).

## Round Robin

`MIRASIM_HOMES` accepts a comma-separated set of separately logged-in profile directories. Each request goes to the least recently used available profile, so a retry that skips an account does not cost the accounts behind it their turn. A `429`, `500`, `502`, `503`, `504`, timeout, or network error moves that profile into a 30-second cooldown and retries the next profile. When every candidate is cooling, the one whose cooldown ends first is used. Change the cooldown with `MIRASIM_COOLDOWN_MS`.

Free accounts (plan `none`, read from the `plan` claim of the stored token) are held back as the last resort of the rotation. Mirasim's free tier draws on a shared relay allowance that is exhausted in practice: `GET /v1/limits` still reports a 7-day budget, but a real completion comes back as HTTP 429 `中转的共享额度已用尽`. A paid account is therefore preferred even while it is cooling down, and a free account is only used when no account with quota is left — which keeps model-health probes and ordinary traffic off the accounts that cannot serve them. An account whose token carries no `plan` claim counts as usable. The console marks such an account 无额度（最后备用） and reports 免费号无中转额度 instead of the budget Mirasim advertises for it.

Every account carries a rotation priority: the highest priority available account is served first, and accounts that share a priority take turns. Without a manual value the plan decides — `max`/`enterprise` 80, `plus` 60, `basic` and a token without a `plan` claim 40, free 0 — so a MAX 40X account is spent before a MAX 10X one. `PUT /api/accounts/<key>/priority` with `{"priority": 0-100}` pins an account, and `{"priority": null}` returns it to the plan order; the value is stored in SQLite and reloaded at startup. The account pool table exposes the same control. Priority orders accounts that can actually be served: a free account never rises above a funded one, and when every candidate is cooling the account whose cooldown ends first is used regardless of rank.

`/healthz` reports profile identifiers, login availability, rotation priority, and cooldown state without exposing credential values.

## Web Console

Open `http://127.0.0.1:8787/` after starting the service. The console is protected by a username/password login. The default username is `admin`; set a stable password before startup:

```bash
WEB_AUTH_USERNAME=admin WEB_AUTH_PASSWORD='choose-a-long-password' npm start
```

When `WEB_AUTH_PASSWORD` is omitted, startup prints a random one-time password. Accounts and hashed API keys are stored in SQLite at `MIRASIM_DATABASE_FILE` (default: `~/.mirasim/mirasim.sqlite`). Existing `MIRASIM_HOMES` are imported into the database on first start. The account pool rotates across every available logged-in account and temporarily skips failed accounts.

The console reads the current membership referral activity directly from the Mirasim relay for each logged-in profile. `GET /auth/referral` returns the invitation code, how many invitations have been redeemed, the invitation threshold, whether it has been reached, how many redemptions the code itself still has, and the current and next plan. The console shows the official plan names (`none` = FREE, `basic` = MAX 2X, `plus` = MAX 10X, `max` = MAX 40X, `enterprise` = 企业版), and derives the reward tier the way the desktop client does: the next plan while the threshold is unmet, the current plan once it has been reached. Progress is measured against the invitation threshold; the code's remaining redemptions are reported separately, because they are a different quantity. Accounts can be added from the login dialog and removed from the pool; removing one keeps its local profile files intact.

The same page also supports the official Mirasim email login flow. Choose the configured profile directory, request the email code, then submit the code. The browser sends the email and verification code only to this local gateway; the gateway calls the current Mirasim authentication service (`https://auth.mirasim.ai/auth/code` and `/auth/verify`) and stores the returned session only in that profile's `setting.json`. Set `MIRASIM_LOGIN_URL` only when using a different official release environment.

The console can create a referral code and redeem one against the selected profile. A successful redemption refreshes that profile's local Mirasim login session; no token is sent to the browser.

Creating a code repeats the desktop client's request exactly: `POST /auth/referral` carrying the bearer token and nothing else — no content type and no body. Mirasim can pause code creation for the whole service (it answers `503 {"detail":"invite code creation is paused"}`), so the console reports that state in Chinese instead of the raw upstream text, a refused creation falls back to the code the account was already issued, and the MoeMail invitation picker stops asking further accounts once creation is paused. Note that `max_redemptions` is reported even before a code exists, so the panel describes redemption capacity only once a code has actually been issued.

Mirasim routes redemptions by code prefix, and so does this gateway. A code that starts with `MLIC` (ignoring case, spaces, dashes, and underscores) is a licence and goes to `/auth/license/redeem`; anything else is an invitation code and goes to `/auth/invite/redeem`. A licence is checked with `/auth/license/preview` first, so one below the current plan is refused locally and stays unconsumed, and the console can report the tier and duration a licence grants before it is redeemed. `POST /api/invites/preview` exposes that check (`{ account, code }`); it answers `{ supported: false }` for a plain invitation code, which needs no pre-check. Upstream throttling is surfaced as HTTP 429 with the official `retry_after` cooldown in the message. The self-invitation guard applies to invitation codes only.

The relay does not expose an official total remaining credit field in v0.0.239. The quota panel therefore shows the Mirasim relay availability state plus the request and token usage that this proxy can verify from relay call records.

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

`/v1/messages` forwards the native Anthropic request and streaming response. The relay only serves Anthropic Messages traffic that identifies itself as an official Anthropic agent client, so every request reaching the upstream `/v1/messages` — native, or translated from `/v1/chat/completions` and `/v1/responses` — gets `You are a Claude agent, built on Anthropic's Claude Agent SDK.` prepended as its first `system` block. Any system prompt the client sent is kept directly after it. Requests that already start with an accepted identity (Claude Code's own `You are Claude Code, Anthropic's official CLI for Claude.`) are forwarded untouched, so Claude Code's prompt cache still hits. This is what lets non-Claude-Code clients — the Anthropic SDK, Cherry Studio, Chatbox, or plain `curl` — use the Anthropic protocol. `/v1/responses` supports text input, instructions, function tools, non-streaming responses, and Responses SSE text streams through an OpenAI-compatible chat upstream.

The upstream relay only serves `claude-*` models on the Anthropic Messages API. When `/v1/chat/completions` or `/v1/responses` receives a `claude-*` model, the gateway translates the request to `/v1/messages` (system prompts, text and image content, function tools, tool results, stop sequences) and converts the Anthropic response — including SSE streams, tool calls, and errors — back into the OpenAI format the client expects.

Prompt caching survives the OpenAI protocol. Anthropic bills a cached prefix at about a tenth of the input price, but only where the request marks a `cache_control` breakpoint — and the OpenAI protocol has no field that can carry one. So any request that reaches this gateway with no breakpoint of its own gets four: one pinning the stable prefix at the last `system` block (tools and system render ahead of the messages, so that one block covers both), and the rest rolling along the newest user turns, which is what turns each turn's cache write into the next turn's read. This covers the `/v1/chat/completions` and `/v1/responses` translations, and equally a `/v1/messages` request that a converting gateway such as **sub2api** or **new-api** built out of an OpenAI one — that request is already Anthropic-shaped, so nothing translates it, but it still arrives with no breakpoint and without these would be re-billed as a full cold prefix on every single turn. A client that sends its own breakpoints (Claude Code) keeps complete control and is forwarded untouched. Watch `cache_read_input_tokens` on the console's usage figures to confirm it is working.

Thinking levels map to Anthropic extended thinking on translated `claude-*` requests. `reasoning_effort` (chat completions) or `reasoning.effort` (responses) of `minimal`/`low`/`medium`/`high` becomes a `thinking` budget of 1024/2048/8192/16384 tokens, a `-thinking` model-name suffix (e.g. `claude-sonnet-5-thinking`) enables the `medium` budget and is stripped before reaching upstream, and an Anthropic-style `thinking: { type: "enabled", budget_tokens }` object is honored directly. `max_tokens` is raised above the budget when needed, and `temperature`/`top_p`/forced tool choices — which Anthropic rejects during extended thinking — are dropped. Thinking output returns as `reasoning_content` on the chat message (or `delta.reasoning_content` chunks when streaming).

A request that says nothing about reasoning gets the `MIRASIM_DEFAULT_REASONING_EFFORT` budget, `medium` unless it is set to `none`/`minimal`/`low`/`high`. Most OpenAI-protocol clients never send `reasoning_effort` at all, so without this they would silently run with thinking off; anything the client does say still wins, and `reasoning_effort: "none"` turns thinking off per request.

The same default reaches `/v1/messages`, for the same reason. A converting gateway such as **sub2api** or **new-api** builds its Anthropic request out of an OpenAI one, and the OpenAI protocol has no field for extended thinking — so the request arrives with no `thinking` and the relay answers without it. That costs more than reasoning quality: **with thinking off, Claude intermittently writes a tool call into its visible text instead of emitting a `tool_use` block, so the turn succeeds, the tool never runs, and nothing reports an error.** "No thinking" and "does not call tools" are one bug, and turning thinking on fixes both. The shape follows the model — `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5` and `claude-fable-5` take `thinking: { type: "adaptive" }` and reject a fixed budget outright, while `claude-haiku-4-5` takes `{ type: "enabled", budget_tokens }`. A caller that stated its own choice, `{ type: "disabled" }` included, is never overridden, and turns whose `max_tokens` leaves no room for thinking and an answer both (titles, classification) are left alone.

Tool rounds keep their thinking. Anthropic requires the signed thinking block of a `tool_use` turn to come back with the matching `tool_result`, and neither OpenAI protocol has a field that can carry a signature — so the gateway remembers the blocks it streamed out, keyed by their `tool_use` ids, and restores them when the client replays that turn. Signatures are never exposed to the client. Blocks are held in memory for 30 minutes across the 500 most recent tool turns, and replaying a turn keeps it alive, so an active conversation does not lose its own thinking to the cap.

A turn whose blocks are gone (restart, expiry, a client that invents tool-call ids) answers without thinking rather than failing upstream — and the whole conversation then keeps answering without it. Switching `thinking` on or off invalidates the entire message cache upstream, so the decision reads the whole transcript instead of only its newest turn: an unrecoverable turn stays in the history, which makes the choice stick. Deciding per turn would flip `thinking` on every request as an agent loop alternates between tool rounds and plain answers, and pay for the full message history each time. The cost of the stable choice is that such a conversation does not pick thinking back up; starting a new one clears it.

## Timeouts

The gateway waits 45 seconds by default for upstream response headers, then returns `504` and cools down that profile. Once headers arrive, streaming responses continue normally. The model-directory request uses a 10-second timeout and falls back to `MIRASIM_MODELS` when necessary.

```bash
MIRASIM_FIRST_BYTE_TIMEOUT_MS=45000 \
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
