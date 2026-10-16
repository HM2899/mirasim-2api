# Mirasim 0.0.338 adaptation

Analysis date: September 21, 2026. Target: the exact ARM64 DMG supplied for version 0.0.338.

## Artifacts and reproducibility

The DMG was downloaded from the supplied Mirasim CDN address and extracted with 7-Zip without
executing the desktop application. Extraction reports an APFS trailing-data warning but completes
without file-extraction errors. Hashes identify the downloaded bytes; they are not an independent
publisher signature or a macOS notarization check.

| Artifact | SHA-256 |
| --- | --- |
| DMG, 116284725 bytes | `b055969f240a424220c6de3362c251b380ff11edf11f4136a8550efc076f421d` |
| Extracted `server.cjs`, 22020316 bytes | `69136e27cfab61101b88773bb424022b159b2b97fd9bfc6542437ecafe084976` |
| Embedded signing/sealing WebAssembly | `fd6b7870012af2d7dc299a7ae81d1684315ba15592979bf854cf317bc8657d95` |

The application `Info.plist` identifies both `CFBundleShortVersionString` and `CFBundleVersion`
as `0.0.338`. Local inspection files are excluded from Git:

```text
/tmp/mirasim-0.0.338/Mirasim-0.0.338-arm64.dmg
/tmp/mirasim-0.0.338/unpacked/Mirasim.app/Contents/Resources/server.cjs
/tmp/mirasim-0.0.338/extract.log
```

The embedded WebAssembly signing/sealing bytes are byte-identical to the core embedded in the
previously vendored 0.0.303 bundle. `vendor/mirasim-server.cjs` is therefore retained only as the
local source of that exact core; this gateway does not execute any other vendored client logic.

## Protocol findings

The signed device-session, relay-header, signature, and encrypted-metadata protocols are
unchanged from the documented 0.0.303 behavior:

- Device tickets are minted at `POST /v1/device/session`.
- Mint headers use `x-mirasim-device`, `x-mirasim-ts`, `x-mirasim-nonce`,
  `x-mirasim-sig`, and `x-mirasim-client`.
- Relay metadata is signed with the device key and sealed into `x-mirasim-enc` using
  `mrs-seal-v1`.
- The seal public key and the embedded core hash are unchanged.
- Existing production routes remain `/v1/messages`, `/v1/chat/completions`, `/v1/responses`,
  `/backend-api/codex/responses`, `/v1/models`, `/v1/limits`, `/usage/calls`, and
  `/auth/refresh`.

No production endpoint probe or account login was used for this update.

## New 0.0.338 routing and model behavior

Static inspection found the following API-relevant changes:

| Official client behavior | Gateway behavior |
| --- | --- |
| `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` map to `deepseek-flash` (v4.1 Flash) | Both legacy IDs remain accepted and are rewritten before signing. |
| `deepseek-v4-pro` remains in the DeepSeek roster | Routes as relay agent `dsh` over Chat Completions. |
| `glm-5.3-flash` and `glm-5.3` are the ZCode roster | Routes as relay agent `zcode` over Anthropic Messages; OpenAI Chat and Responses callers are bridged. |
| `claude-fable-5-1` and `gpt-6-astra` appear in the official model list | Existing namespace routing automatically assigns them to Claude Messages and Codex Responses. |
| Pi is present as a desktop integration | It has no fixed relay model roster or single wire protocol in the bundle, so it is not exposed as a fabricated API model. |

The `zcode` path uses the Anthropic Messages contract, but it is not Claude: the gateway does not
inject Claude Agent SDK identity text, Claude cache controls, sampling rewrites, or Claude thinking
normalization into GLM requests.

`MIRASIM_RELAY_AGENTS` accepts `dsh`, `kimi`, and `zcode`. As before, these static model IDs are
advertised only when that setting enables the relevant agent; models returned by the authenticated
live directory remain authoritative.

## Validation

The targeted local verification run on September 21, 2026 passed 36/36 tests:

```bash
node --test \
  test/mirasim-release.test.js \
  test/relay-agents.test.js \
  test/relay-agent-routing.test.js \
  test/relay-crypto.test.js \
  test/relay-device.test.js
```

It verifies the 0.0.338 default client header, extracted-core compatibility, ticket minting and
sealing, legacy DeepSeek aliases, agent selection, ZCode routing, the absence of a Claude identity
on ZCode traffic, and static model advertisement. The route test uses a local mock listener; it
does not make a relay request or consume account quota.

Before rollout, remove an old `MIRASIM_CLIENT_VERSION` override or set it to `0.0.338`, set
`MIRASIM_RELAY_AGENTS=dsh,kimi,zcode` only if static listing of those agent models is desired,
and restart the gateway through its existing service manager. Authorized accounts, live model
entitlement, and service-side enforcement remain outside what offline inspection can prove.
