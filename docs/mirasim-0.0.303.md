# Mirasim 0.0.303 adaptation

Analysis date: September 9, 2026. Target: the exact ARM64 DMG supplied for version 0.0.303, not an assertion that it is the latest available release.

## Artifacts and reproducibility

The DMG was downloaded from the supplied Mirasim CDN address and extracted with 7-Zip without executing the desktop application. Extraction reported an APFS trailing-data warning, but completed without extraction errors. The hashes identify the downloaded bytes; they are not an independent publisher signature or a macOS notarization check.

| Artifact | SHA-256 |
| --- | --- |
| DMG, 115708329 bytes | `4876da508efb8f6f162344153b25cd8e62436cebb4d5fe63c16cc3df2621d445` |
| Extracted `server.cjs` | `fcf3485bf236170be1b02a7035ae3f9ee35cca6f98676588a6c54dc07bb72b40` |
| Vendored `server.cjs`, with one added trailing newline | `08dd7dde30e88a96760d5f573aec6e620a1fd80589e09bc6f991a2c5b303334f` |
| Embedded signing/sealing WebAssembly | `fd6b7870012af2d7dc299a7ae81d1684315ba15592979bf854cf317bc8657d95` |

Local files, excluded from Git:

```text
.runtime/releases/0.0.303/Mirasim-0.0.303-arm64.dmg
.runtime/releases/0.0.303/unpacked/Mirasim.app/Contents/Resources/server.cjs
.runtime/releases/0.0.303/mirasim-server.before-upgrade.cjs
.runtime/releases/0.0.303/extract.log
.runtime/releases/0.0.303/targeted-tests.log
.runtime/releases/0.0.303/full-tests.log
```

The pre-upgrade bundle is preserved, including the pre-existing working-tree version. Other pre-existing source changes are retained. `vendor/mirasim-server.cjs` contains the new official executable code with only a final newline added by the patch tool.

## Protocol findings

These findings come from static inspection of the downloaded official bundle and offline execution of its isolated cryptographic wrappers, not from production endpoint probes.

### Device session

- `POST /v1/device/session` authenticates with the existing login token and JSON `{ publicKey, deviceId }`.
- The device uses an Ed25519 private key persisted in `setting.json`. The public key is base64 DER/SPKI. The ID is the first 22 base64url characters of SHA-256 of that public-key string.
- Mint requests carry `x-mirasim-device`, `x-mirasim-ts`, `x-mirasim-nonce`, `x-mirasim-sig`, and `x-mirasim-client`. They do **not** seal these headers or invent relay-session metadata on the mint request.
- A successful mint returns a `ticket` with `expiresIn` or `expiresAt`; if neither is supplied, the inspected client uses a ten-minute fallback. The ticket becomes the bearer credential for relay requests and stays in memory only. The gateway schedules renewal no earlier than halfway through a short ticket's lifetime, preventing repeated minting on every request.
- The 0.0.303 bundle contains explicit refusal handling when a signed device session cannot be established. The gateway now stops in this situation instead of sending unsigned login-token traffic.
- Cache entries are bound to both login token and device key. Login renewal or an externally changed key cannot reuse a mismatched ticket or its backoff. The gateway does not rotate device keys to avoid restrictions.
- Mint attempts have a 10-second timeout. Failures back off per profile; positive numeric or HTTP-date `Retry-After` values are respected without shortening long waits. A missing/invalid value defaults to 15 minutes. Transient renewal failures may keep using an already-issued, unexpired ticket; 401/403 renewal refusals invalidate it.

### Signing and metadata encryption

The embedded WebAssembly bytes are identical to the locally installed 0.0.264 bundle. Merely changing the version header would still miss protocol steps the old gateway did not implement.

1. Canonical signing fields are `method`, `path`, `ts`, `nonce`, `deviceId`, `clientVersion`, and `credential`, joined with NUL delimiters. NUL inside a field is rejected.
2. Nonempty metadata names and values are passed to the official core, followed by the exact request-body bytes. Signature transport fields, the client-version header, and the encrypted envelope are excluded from the metadata passed to the signer.
3. Relay metadata, including the resulting signing headers, is JSON-encoded and sealed by the official `cc_seal` implementation using the bundled public key, 32 random bytes, and a 12-byte random nonce.
4. Associated data is `mrs-seal-v1`, uppercase method, and the request pathname separated by newlines. As in the inspected official route builders, the query string is not part of this pathname.
5. The result is base64url in `x-mirasim-enc`. Plain `x-mirasim-*` metadata is removed; `x-mirasim-client` remains visible. Authorization and the content body still rely on HTTPS for transport confidentiality.

The September 9 sub2api follow-up also restores the official per-call `x-mirasim-call` correlation ID before signing and sealing, and removes only the `oauth-2025-04-20` beta token on the official Anthropic relay path. Ticket mint requests do not carry a call ID. Other beta tokens and query parameters remain intact. See `docs/sub2api-400-2026-09-09.md` for the incident's findings and the limits of live verification.

A subsequent same-account comparison identified `temperature: 1` as the parameter triggering the reported sub2api-shaped 400. The official Messages relay path now removes `temperature` before signing even when thinking is off. Custom upstreams and non-Anthropic OpenAI routes keep their existing behavior. Correcting the parameter does not restore an exhausted model-scoped quota.

`test/relay-crypto.test.js` contains deterministic signature and seal vectors produced by the isolated official 0.0.303 wrappers. Randomness is fixed only in tests; production uses fresh cryptographic randomness.

### Existing routes

The inspected bundle still contains `/v1/messages`, `/v1/chat/completions`, `/v1/responses`, `/backend-api/codex/responses`, `/v1/models`, `/v1/limits`, `/usage/calls`, and `/auth/refresh`. The refresh body remains `{ refresh_token }`. No endpoint migration was inferred from a version number alone. Existing downstream protocol conversion remains in place.

Local signing and sealing use the request pathname, including when a usage-read request has a query string. The existing agent-routing implementation is retained. Model availability, subscription entitlements, limits, and supported production routes have **not** been verified against an authenticated live account.

## Privacy and enforcement boundaries

- The gateway requests the official optional-collection opt-out with signed/sealed `x-mirasim-collect: off`, and does not add repository paths, repository URLs, or Git revisions to relay metadata.
- `npm run login` and `npm run relay` default the official optional analytics, diagnostic, and recording switches to off. Explicit environment overrides remain possible. These defaults do not claim to remove every network request or every service-side log from the bundled application.
- Device settings and refreshed token files are written with mode `0600`; existing device settings are tightened to that mode when used. Tickets are not written to disk.
- Generated console passwords are shown only on an interactive terminal. Unattended deployments must set `WEB_AUTH_PASSWORD`; redirected startup logs do not contain the generated password.
- Caller authorization and caller-supplied Mirasim signing/envelope headers are not forwarded as upstream identity. Local session errors omit credentials and raw upstream refusal text.
- A failed device-session establishment stops the current generation request; it does not automatically retry that request across the account pool. Separate client requests still use the existing configured pool selection. Backoff is per profile, not a global service pause.
- Custom relay hosts keep their existing unsigned compatibility behavior. Automatic signing/sealing and the HTTPS requirement apply to the official relay hostname, not arbitrary custom hosts.

**Encryption is not invisibility to Mirasim.** The service can decrypt its envelope, identify the account/device/IP, and process request content. The collection opt-out is a request to the service, not proof about its retention behavior. Local request metrics, account IDs, SQLite state, existing logs, and profile files still require normal host access controls and retention management.

There is no no-ban guarantee, fingerprint camouflage, IP rotation, automated replacement-account creation, restriction bypass, or automated re-login in this update. Use only accounts and workloads authorized by the service, obey refusals and quotas, and do not treat multi-account configuration as a way around enforcement.

## Validation and rollout

The tests cover the bundle hash, version defaults, official crypto vectors, encrypted wire headers, ticket reuse and expiry, concurrency, token/device changes, malformed/error responses, backoff, file permissions, custom-host compatibility, and local gateway fail-closed behavior. Integration tests use local HTTP listeners and mocked Mirasim responses, never real account credentials.

Results on September 9, 2026: **33/33 targeted tests pass; 198/199 full-suite tests pass.** The one full-suite failure is the existing quota-window fixture in `test/dashboard.test.js:143`, which expects 80% usage after its hard-coded reset time of September 3, 2026 at 06:57:54 UTC has already passed. The unchanged pool correctly treats that window as expired. The isolated test fails with the current clock and passes when only the test process's clock is fixed to August 28, 2026; this unrelated fixture was left unchanged. `git diff --check` and syntax checks also pass.

```bash
npm test
node --test --experimental-test-isolation=none test/relay-device.test.js test/relay-crypto.test.js test/mirasim-release.test.js test/relay-session-gateway.test.js test/relay-headers.test.js test/session-refresh.test.js
```

During the initial offline adaptation, no production service was restarted and no real-account inference, sign-in, or device mint was performed. The service was subsequently restarted at the operator's request. The first sub2api diagnostic request returned 429 and testing stopped. After a new reported 400, explicitly approved same-account parameter comparisons reproduced the rejection and identified the temperature field; testing again stopped as soon as a comparison returned 429. No diagnostic account switching occurred. Before future rollout, remove an old `MIRASIM_CLIENT_VERSION` override or set it to `0.0.303`, configure a console password for noninteractive startup, and restart the gateway through its existing service manager. Successful live generation still requires an authorized account with available model-scoped quota; offline tests cannot establish account eligibility or absence of enforcement risk.
