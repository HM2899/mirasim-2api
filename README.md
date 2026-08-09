# mirasim-2api

Linux-native OpenAI protocol proxy for Mirasim `v0.0.147`. It uses the Mirasim login flow and relay credential saved by the bundled Mirasim CLI. No OpenAI, Anthropic, or other upstream API key is configured in this project.

The project includes the `server.cjs` core extracted unchanged from the supplied Mirasim DMG:

```text
SHA-256 09875926c3d1d7f59d404bd8327c2210518223c59718f11aca6792b42f3c6ce6
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

`MIRASIM_HOMES` accepts a comma-separated set of separately logged-in profile directories. Each request uses the next valid profile. A `429`, `500`, `502`, `503`, `504`, timeout, or network error moves that profile into a 30-second cooldown and retries the next profile. Change the cooldown with `MIRASIM_COOLDOWN_MS`.

`/healthz` reports profile identifiers, login availability, and cooldown state without exposing credential values.

## Web Console

Open `http://127.0.0.1:8787/` after starting the service. The console is protected by a username/password login. The default username is `admin`; set a stable password before startup:

```bash
WEB_AUTH_USERNAME=admin WEB_AUTH_PASSWORD='choose-a-long-password' npm start
```

When `WEB_AUTH_PASSWORD` is omitted, startup prints a random one-time password. Accounts and hashed API keys are stored in SQLite at `MIRASIM_DATABASE_FILE` (default: `~/.mirasim/mirasim.sqlite`). Existing `MIRASIM_HOMES` are imported into the database on first start. The account pool rotates across every available logged-in account and temporarily skips failed accounts.

The console reads the current membership referral activity directly from the Mirasim relay for each logged-in profile. It shows the official invitation code, redemption progress, current and next membership plan, and remaining activity redemptions. Accounts can be added from the login dialog and removed from the pool; removing one keeps its local profile files intact.

The same page also supports the official Mirasim email login flow. Choose the configured profile directory, request the email code, then submit the code. The browser sends the email and verification code only to this local gateway; the gateway calls the login service compiled into Mirasim 0.0.147 (`https://admin.test.mirofish.ai/auth/code` and `/auth/verify`) and stores the returned session only in that profile's `setting.json`. Set `MIRASIM_LOGIN_URL` only when using a different official release environment.

The console can create a referral code and redeem one against the selected profile. A successful redemption refreshes that profile's local Mirasim login session; no token is sent to the browser. The relay does not expose an official total remaining credit field in v0.0.147. The quota panel therefore shows the Mirasim relay availability state plus the request and token usage that this proxy can verify from relay call records.

### MoeMail single-account signup

The login dialog includes a MoeMail signup queue. It creates temporary inboxes one at a time, requests the Mirasim email code, waits up to two minutes for each code, optionally redeems the entered invite code, and only then persists each successful account in the SQLite pool. A queue contains at most five accounts and stops at the first error or upstream rate limit. The same dialog can save the MoeMail service address, API key, and domain. The API key is encrypted in SQLite with the current `WEB_AUTH_PASSWORD` and is never sent back to the browser. Environment variables below remain useful for unattended deployments:

```bash
MOEMAIL_URL=https://your-moemail.example \
MOEMAIL_API_KEY=your_moemail_api_key \
MOEMAIL_DOMAIN=your-mail-domain.example \
npm start
```

Optional settings: `MOEMAIL_EXPIRY_MS` (default `3600000`), `MOEMAIL_CODE_TIMEOUT_MS` (default `120000`), and `MOEMAIL_POLL_MS` (default `2500`). MoeMail's API key must be allowed to create and read mailboxes for the configured domain.

Web authentication applies only to the console and its `/api/*` management routes. All OpenAI-compatible `/v1/*` relay endpoints require a console-generated API Key.

`/v1/messages` forwards the native Anthropic request and streaming response. `/v1/responses` supports text input, instructions, function tools, non-streaming responses, and Responses SSE text streams through an OpenAI-compatible chat upstream.

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
