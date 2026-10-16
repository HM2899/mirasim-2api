# Mirasim 0.0.403 runtime upgrade

## Verified official artifact

The user-supplied endpoint `https://mirasim.ai/d/mac` resolved to the official ARM64 DMG:

`https://cdn-assets.mirasim.ai/mirasim/releases/v0.0.403/Mirasim-0.0.403-arm64.dmg`

- DMG size: 116615811 bytes
- DMG SHA-256 verified against official SHA256SUMS: `0f634ca0e289ae1101a401ac08a01d8f443a1dfd614a5f74abc35e4a890c4fc5`
- Both Info.plist version fields: `0.0.403`
- Official `server.cjs` size: 22324070 bytes
- Official `server.cjs` SHA-256: `2cc4c182f3ffc8cda74b7f07f716a0691f8f812701e1fb24aaac6f36c29d2d99`
- 7-Zip completed extraction successfully with one archive/APFS warning. Checksum equality does not verify publisher signature or macOS notarization.

## Actual runtime change

The upgrade replaces `vendor/mirasim-server.cjs` with the complete, byte-identical official `server.cjs`, rather than changing only a version string. Running this new vendored CLI with `--version` returns `0.0.403`. The integrated `MIRASIM_CLIENT_VERSION` default is updated only together with that real runtime replacement; explicit environment overrides remain supported.

The gateway's existing signing/sealing wrapper, device-session authentication, public-key configuration, account state, and persistent data are not rewritten. Existing fixed-vector, sealed-metadata, device-session and protocol regressions execute against the new underlying bundle. This is ordinary runtime replacement and regression verification, not reverse engineering a new private attestation protocol or bypassing client authorization.

## Preserved compatibility fixes

- Forward only the caller's actual `user-agent` and `x-app` on native `/v1/messages` traffic; never synthesize a supported client or borrow identity metadata for translated OpenAI traffic.
- Forward only non-empty string values up to 512 characters without CR, LF or NUL.
- Stop upstream HTTP 403 without account switching, body-based policy guessing, or account cooldown. Keep the existing downstream error forwarding contract.
- Retain caller system/developer content, runtime profiles, database, API keys, production configuration and routing.

## Candidate verification

The updated candidate CLI reports `0.0.403` and matches the official bundle hash. Its complete suite returns 1237 passes and four failures out of 1241 tests. The four native-search assertion failures are exactly the same as the pre-upgrade baseline; no new failing test was introduced. The broader targeted run returns 119 passes and those same four existing failures out of 123 tests.

Production cutover must separately verify the live runtime version/hash, changed service PID, health, SQLite integrity, 67 accounts, three API keys, public HTTPS and authentication boundaries. The CLI version alone is not a production-health test.

## Availability boundary

Pre-upgrade native-header experiments with genuine Claude Code 2.1.284 and all six advertised Claude IDs produced `503 overloaded_error/platform_queue_full`, not successful model output. Later public acceptance also encountered origin timeouts; these are not proof of restored inference.

A successful runtime upgrade does not grant an unsupported client access, change upstream entitlement, or guarantee capacity. Keep explicit upstream authorization refusals intact. Successful inference, streaming completion, and translated third-party-client availability must be reported only when independently verified after cutover.

## Production result

The live official runtime was replaced and the owning `mirasim-2api.service` restarted. Post-cutover CLI reports `0.0.403`, and the complete live bundle exactly matches the official hash recorded above. Health reports 67 profiles; the database retains 67 accounts, three API keys and 72 usage-ledger rows, with SQLite quick-check `ok` and no foreign-key errors. Local and public HTTPS login/model-directory and unauthenticated rejection boundaries passed. A focused run against the deployed source returned 91/91 passing tests.

All six advertised Claude IDs were subsequently exercised with the actual installed Claude Code client on the native Messages path. Each reached its bounded 30-second client timeout and was stopped before retrying; none produced a successful model reply. This is inconclusive for eventual provider availability, not proof of success. An ordinary OpenAI Chat control for `claude-haiku-4-5` still returned HTTP 403 with `this client is not supported; use the mirasim client or Claude Code`, preserved unchanged in one attempt. Thus the bottom-runtime upgrade is verified, while removing the third-party-client restriction and restoring Claude inference are not achieved.
