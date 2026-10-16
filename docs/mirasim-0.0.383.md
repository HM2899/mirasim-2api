# Mirasim 0.0.383 adaptation

Target: the exact ARM64 DMG supplied by the user, not a claim about the latest published release.
The desktop application was extracted without executing it. 7-Zip reports one APFS trailing-data warning and no file-extraction errors. Artifact hashes identify the inspected bytes, not a verified publisher signature or macOS notarization result.

## Evidence

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| DMG | 116423029 | `f3a1847eae5469e853c12a99e3599dec1557d63516ed972327052d514169a359` |
| `Contents/Resources/server.cjs` | 22149756 | `8d45de4db65be0ea4316eb3bef45da112e8fadedb5d4aeffa73d4bc7f274452d` |
| Embedded signing/sealing WebAssembly | — | `fd6b7870012af2d7dc299a7ae81d1684315ba15592979bf854cf317bc8657d95` |

Both version fields in `Contents/Info.plist` report `0.0.383`. Extracted files remain outside the repository:

```text
/tmp/mirasim-0.0.383/Mirasim-0.0.383-arm64.dmg
/tmp/mirasim-0.0.383/extract.log
/tmp/mirasim-0.0.383/unpacked/Mirasim.app/Contents/Resources/server.cjs
/tmp/mirasim-0.0.383/asar/dist/renderer/assets/settings-modal-_rWhgxbv.js
```

The ASAR was read as an archive without evaluating application JavaScript. The server bundle establishes endpoint and schema behavior; the settings renderer establishes user-facing invitation and reset-card semantics.

## Invitation replacement

The renderer requests `getCampaignLink`; the server calls `GET /v1/pay/campaign/my-link` on the configured login origin with the account bearer token. The response accepts a lowercase slug matching `^go-[a-z0-9-]{1,29}$`, nonnegative integer `sold`, positive integer `cap` (default 3), and explicit boolean `rewarded`. The purchase link uses `https://mirasim.ai/r/{slug}`. Buying Go through the link counts as an invitation; registering or redeeming an old code is not the new campaign event.

The gateway replaces the old invitation progress and code-generation UI with that link and those counters. Reaching `cap` alone does not imply a reward was issued. Snapshots no longer fetch the old referral activity; the deprecated `referral` property remains null for compatibility. The old local generation route returns 410 and blank-code registration no longer searches for legacy invitations. Explicit legacy invite redemption and MLIC preview/redemption remain available because the official artifact retains their endpoints.

## Reset cards

The artifact uses the relay origin, with an account bearer token rather than an inference device ticket:

- `GET /v1/reset-cards`: 8-second deadline; arrays `cards` and `history` are required.
- `POST /v1/reset-cards/{encoded-card-id}/redeem`: empty body, 20-second deadline.
- One authentication refresh and retry is allowed after a 401 only if the token changes. Network failures and ambiguous POST outcomes are not retried.
- Card statuses: `active`, `used`, `revoked`, `expired`; history kinds: `granted`, `used`, `revoked`, `expired`.
- Dates are parsed from the official ISO-string fields. Invalid entries are discarded rather than fabricated.
- Outcomes: `reset`, `nothingToReset`, `alreadyRedeemed`, `expired`, `revoked`, `noCard`; `windows` is an array of names.

The console lists cards and history on explicit refresh, requires confirmation showing the account and current usage, blocks repeat clicks, and drops late responses after account changes. An uncertain result invalidates use buttons until refreshed. Only `reset` clears the automatic pool cooldown and updates the returned window names to zero usage; it never re-enables manually disabled accounts or clears local usage history. No card is consumed by deployment or testing against mocks.

## Protocol changes

The embedded core and `mrs-seal-v1` public key match 0.0.338 and the existing vendored core. Device-ticket minting remains `/v1/device/session`. The client version default now identifies 0.0.383; explicit configuration overrides remain honored. Replacing the whole vendored desktop bundle is unnecessary and would introduce unrelated executable code.

The official route switch now maps Codex image generation/edit aliases to `/v1/images/generations` and `/v1/images/edits`. The gateway adds those authenticated routes, selects Codex explicitly, signs the original body, preserves JSON and multipart edit bytes, and forwards the response without chat/Responses rewriting. Existing Claude, GPT, DeepSeek, Kimi and ZCode namespace routing and aliases remain intact. Live model listing stays authoritative; no unsupported model entitlement is fabricated.

Other newly observed endpoint strings include machine enrollment and Git connections. The added `x-mirasim-git-session` header belongs to desktop/cloud-machine Git operations, not inference. Those management features and desktop integrations are deliberately outside this API gateway adaptation.

## Validation scope

Local tests cover schema validation, fixed-origin link construction, bearer-only reset endpoints, all six outcomes, token refresh, stale account selection, no retries on ambiguous outcomes, manually disabled accounts, UI confirmation/cancellation, duplicate-click blocking, late account-switch responses, expired cards, HTML escaping, image aliases, byte-preserving JSON/multipart forwarding, and API/console authentication.

```sh
node --test test/account-features.test.js test/dashboard.test.js test/dashboard-ui.test.js test/mirasim-release.test.js test/relay-agent-routing.test.js test/relay-crypto.test.js test/relay-device.test.js test/relay-headers.test.js
npm test
```

Mocks do not prove production entitlement or successful image inference. Any live validation must be read-only unless a user explicitly authorizes consuming a reset card or paid model quota. Previously removed monetary statistics remain removed.

## Deployment verification

The service was restarted after checking that no logged request was in progress. Read-only checks on the running service retained all 67 accounts, retrieved a valid new campaign link, and received HTTP 200 with zero available reset cards for the sampled account. No reset-card redemption or paid image inference was performed. The usage and dashboard APIs still omit monetary summaries.

A headless Chromium rendering check used mocked account/card data over the real served UI: the invitation link and active-card controls rendered without JavaScript errors at desktop and 390-pixel mobile widths, with no mobile horizontal overflow. Local screenshots: `/tmp/mirasim-383-desktop.png` and `/tmp/mirasim-383-mobile.png`.
