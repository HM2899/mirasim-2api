import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sealMirasimRelayHeaders, signMirasimRelayRequest } from "./relay-crypto.js";
import { MIRASIM_CLIENT_VERSION } from "./mirasim-release.js";
import { relayAgentForPath } from "./relay-agents.js";

const DEVICE_SESSION_PATH = "/v1/device/session";
const RENEW_BEFORE_MS = 5 * 60_000;
const DEFAULT_TICKET_TTL_MS = 10 * 60_000;
const DEFAULT_MINT_BACKOFF_MS = 15 * 60_000;
const MINT_TIMEOUT_MS = 10_000;
const SIGNED_RELAY_HOSTS = new Set(["relay.mirasim.ai"]);

// The relay admits Anthropic Messages traffic only from a client it recognizes; every other
// User-Agent is answered `403 this client is not supported; use the mirasim client or Claude
// Code`, before any model is reached. Node's fetch default (`node`) is one of those, so a
// request this gateway makes for a Claude model must say which client it is. It is the Mirasim
// client — the same client whose version the relay is already told in x-mirasim-client — so it
// names itself as that rather than borrowing another product's identity.
export function mirasimClientUserAgent(clientVersion = MIRASIM_CLIENT_VERSION) {
  return `Mirasim/${clientVersion || MIRASIM_CLIENT_VERSION}`;
}

// Only an Anthropic Messages upstream (Claude, and the ZCode route that shares its wire) gates
// on the client. Codex, DeepSeek and Kimi are reached without it, so their requests keep the
// User-Agent they already sent and nothing about those working routes changes.
export function relayNeedsClientIdentity(agent) {
  return (agent || "claude") === "claude";
}

export class MirasimRelaySessionError extends Error {
  constructor(message, { retryAfterMs = 0, upstreamStatus = 0 } = {}) {
    super(message);
    this.name = "MirasimRelaySessionError";
    this.retryAfterMs = retryAfterMs;
    this.upstreamStatus = upstreamStatus;
  }
}

// The official relay now issues short-lived tickets bound to an Ed25519 device key.
// Keep private keys in each local profile; tickets are intentionally memory-only.
export class MirasimRelaySessions {
  #states = new Map();

  constructor(config, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.enabled = SIGNED_RELAY_HOSTS.has(new URL(config.relayUrl).hostname);
    if (this.enabled && new URL(config.relayUrl).protocol !== "https:") {
      throw new Error("The official Mirasim relay requires HTTPS.");
    }
  }

  // `agent` names the relay upstream this request is for. The profile carries no agent of its
  // own, so it is scoped onto a copy per request: the same account serves Claude, DeepSeek and
  // Kimi traffic, and only the header tells the relay which of them this one is.
  async headersFor(profile, { method, path, body = "", accept = "application/json", contentType = "application/json", agent = null, sessionId = null, meta = {}, signal = null } = {}) {
    signal?.throwIfAborted();
    const requestSession = typeof sessionId === "string" ? sessionId.trim() : "";
    const scoped = {
      ...profile,
      agent: agent || relayAgentForPath(path),
      ...(requestSession ? { sessionId: requestSession } : {})
    };
    if (!this.enabled) return baseHeaders(scoped, accept, contentType, this.config.clientVersion, meta);
    const device = this.#device(profile.home);
    if (!device) throw new MirasimRelaySessionError("Mirasim device key is unavailable. Check the profile and its file permissions; no relay request was sent.");
    const state = await waitForTicket(this.#ticket(profile, device), signal);
    signal?.throwIfAborted();
    if (!state?.ticket || state.expiresAt <= this.now()) {
      throw new MirasimRelaySessionError("Mirasim device session is unavailable. Wait before retrying or renew the login; no unsigned relay request was sent.", {
        retryAfterMs: Math.max(0, (state?.retryAt || 0) - this.now()),
        upstreamStatus: state?.upstreamStatus || 0
      });
    }
    const headers = baseHeaders({ ...scoped, token: state.ticket }, accept, contentType, this.config.clientVersion, meta);
    const pathname = new URL(path, this.config.relayUrl).pathname;
    try {
      return sealMirasimRelayHeaders({
        ...headers,
        ...signedHeaders(device, method, pathname, body, state.ticket, this.config.clientVersion || MIRASIM_CLIENT_VERSION, signedMetadata(headers))
      }, { method, path: pathname });
    } catch {
      throw new MirasimRelaySessionError("Mirasim relay signing or metadata encryption failed; no relay request was sent.");
    }
  }

  async #ticket(profile, device) {
    const cached = this.#states.get(profile.home);
    const existing = cached?.token === profile.token && cached?.deviceId === device.id ? cached : null;
    const usable = Boolean(existing?.ticket && existing.expiresAt > this.now());
    if (usable && existing.renewAt > this.now()) return existing;
    if (existing?.inFlight) return usable ? existing : existing.inFlight;
    if (existing?.retryAt > this.now()) return existing;

    const state = existing || { token: profile.token, deviceId: device.id, ticket: null, expiresAt: 0, inFlight: null };
    const task = this.#mint(profile.token, device).then((minted) => {
      if (minted?.ticket) {
        state.ticket = minted.ticket;
        state.expiresAt = minted.expiresAt;
        state.renewAt = minted.expiresAt - Math.min(RENEW_BEFORE_MS, (minted.expiresAt - this.now()) / 2);
        state.retryAt = 0;
        state.upstreamStatus = 0;
      } else if (minted?.retryAt) {
        state.retryAt = minted.retryAt;
        state.upstreamStatus = minted.upstreamStatus;
        if (minted.upstreamStatus === 401 || minted.upstreamStatus === 403) {
          state.ticket = null;
          state.expiresAt = 0;
        }
      }
      return state;
    }).catch(() => {
      state.retryAt = this.now() + DEFAULT_MINT_BACKOFF_MS;
      state.upstreamStatus = 0;
      return state;
    }).finally(() => { state.inFlight = null; });
    state.inFlight = task;
    this.#states.set(profile.home, state);
    return usable ? state : task;
  }

  async #mint(token, device) {
    const body = JSON.stringify({ publicKey: device.publicKey, deviceId: device.id });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(new URL(DEVICE_SESSION_PATH, `${this.config.relayUrl}/`), {
        method: "POST",
        // The device-session request has no relay metadata; including a synthetic session or agent
        // changes the official signature and makes the issuer reject the mint.
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...signedHeaders(device, "POST", DEVICE_SESSION_PATH, body, token, this.config.clientVersion || MIRASIM_CLIENT_VERSION)
        },
        body,
        signal: controller.signal,
        redirect: "error"
      });
      if (!response.ok) {
        const delay = mintRetryDelay(response.headers?.get?.("retry-after"), this.now());
        await response.body?.cancel?.();
        return { retryAt: this.now() + delay, upstreamStatus: response.status };
      }
      const data = await response.json().catch(() => null);
      if (typeof data?.ticket !== "string" || !data.ticket.trim()) return { retryAt: this.now() + DEFAULT_MINT_BACKOFF_MS };
      const expiresAt = typeof data.expiresIn === "number"
        ? this.now() + data.expiresIn * 1000
        : typeof data.expiresAt === "number" ? data.expiresAt * 1000 : this.now() + DEFAULT_TICKET_TTL_MS;
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) return { retryAt: this.now() + DEFAULT_MINT_BACKOFF_MS };
      return { ticket: data.ticket, expiresAt };
    } finally {
      clearTimeout(timer);
    }
  }

  #device(home) {
    try {
      const settingPath = join(home, "setting.json");
      const setting = JSON.parse(readFileSync(settingPath, "utf8"));
      chmodSync(settingPath, 0o600);
      let privateKey = typeof setting?.device?.privateKey === "string" ? setting.device.privateKey : "";
      if (!privateKey) {
        privateKey = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
        setting.device = { ...(setting.device && typeof setting.device === "object" ? setting.device : {}), privateKey };
        const temporaryPath = `${settingPath}.${randomUUID()}.tmp`;
        writeFileSync(temporaryPath, `${JSON.stringify(setting, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        renameSync(temporaryPath, settingPath);
      }
      const key = createPrivateKey(privateKey);
      const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");
      const seed = Buffer.from(key.export({ format: "jwk" }).d || "", "base64url");
      if (seed.length !== 32) return null;
      return { id: createHash("sha256").update(publicKey).digest("base64url").slice(0, 22), publicKey, seed };
    } catch {
      return null;
    }
  }
}

async function waitForTicket(task, signal) {
  if (!signal) return task;
  signal.throwIfAborted();
  let onAbort;
  const cancelled = new Promise((resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([task, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function mintRetryDelay(value, now) {
  if (!value?.trim()) return DEFAULT_MINT_BACKOFF_MS;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? delay : DEFAULT_MINT_BACKOFF_MS;
}

function baseHeaders(profile, accept = "application/json", contentType = "application/json", clientVersion = MIRASIM_CLIENT_VERSION, meta = {}) {
  const token = profile?.token || "";
  const account = profile?.id || profile?.userId;
  return {
    Accept: accept,
    ...(contentType ? { "Content-Type": contentType } : {}),
    Authorization: `Bearer ${token}`,
    // The client identity the relay admits this traffic under. Sent only for the Anthropic
    // Messages upstream, which is the one that gates on it; a caller's own non-empty
    // User-Agent on a native Messages request still wins, so a real Claude Code session keeps
    // its own (see forwardClientIdentity).
    ...(relayNeedsClientIdentity(profile?.agent) ? { "user-agent": mirasimClientUserAgent(clientVersion) } : {}),
    "x-mirasim-session": profile?.sessionId || profile?.userId || randomUUID(),
    "x-mirasim-agent": profile?.agent || "claude",
    ...(account ? { "x-mirasim-account": account } : {}),
    "x-mirasim-client": clientVersion || MIRASIM_CLIENT_VERSION,
    "x-mirasim-locale": profile?.locale || "en-US",
    "x-mirasim-collect": "off",
    "x-mirasim-call": randomUUID(),
    ...meta
  };
}

function signedMetadata(headers) {
  const metadata = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!normalized.startsWith("x-mirasim-") || ["x-mirasim-client", "x-mirasim-device", "x-mirasim-ts", "x-mirasim-nonce", "x-mirasim-sig", "x-mirasim-enc"].includes(normalized)) continue;
    metadata[normalized] = value;
  }
  return metadata;
}

function signedHeaders(device, method, path, body, credential, clientVersion, metadata = {}) {
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("base64url");
  const signature = signMirasimRelayRequest(device.seed, {
    method,
    path,
    ts,
    nonce,
    deviceId: device.id,
    clientVersion,
    credential,
    metadata,
    body
  });
  return {
    "x-mirasim-device": device.id,
    "x-mirasim-ts": ts,
    "x-mirasim-nonce": nonce,
    "x-mirasim-sig": signature.toString("base64url"),
    "x-mirasim-client": clientVersion
  };
}
