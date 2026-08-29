import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEVICE_SESSION_PATH = "/v1/device/session";
const RENEW_BEFORE_MS = 5 * 60_000;
const DEFAULT_MINT_BACKOFF_MS = 15 * 60_000;

// The official relay now issues short-lived tickets bound to an Ed25519 device key.
// Keep private keys in each local profile; tickets are intentionally memory-only.
export class MirasimRelaySessions {
  #states = new Map();

  constructor(config, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.enabled = new URL(config.relayUrl).hostname === "mirasim-relay.mirofish.ai";
  }

  async headersFor(profile, { method, path, body = "", accept = "application/json", contentType = "application/json" } = {}) {
    const device = this.enabled ? this.#device(profile.home) : null;
    if (!device) return baseHeaders(profile, accept, contentType, this.config.clientVersion);
    const state = await this.#ticket(profile, device);
    if (!state?.ticket) return baseHeaders(profile.token, accept, contentType, this.config.clientVersion);
    return {
      ...baseHeaders({ ...profile, token: state.ticket }, accept, contentType, this.config.clientVersion),
      ...signedHeaders(device, method, path, body)
    };
  }

  async #ticket(profile, device) {
    const existing = this.#states.get(profile.home);
    if (existing?.token === profile.token && existing.ticket && existing.expiresAt > this.now() + RENEW_BEFORE_MS) return existing;
    if (existing?.inFlight) return existing.inFlight;
    if (existing?.retryAt > this.now()) return existing;

    const state = existing || { token: profile.token, ticket: null, expiresAt: 0, inFlight: null };
    state.token = profile.token;
    const task = this.#mint(profile.token, device).then((minted) => {
      if (minted?.ticket) {
        state.ticket = minted.ticket;
        state.expiresAt = minted.expiresAt;
        state.retryAt = 0;
      } else if (minted?.retryAt) {
        state.retryAt = minted.retryAt;
      }
      return state;
    }).catch(() => state).finally(() => { state.inFlight = null; });
    state.inFlight = task;
    this.#states.set(profile.home, state);
    return task;
  }

  async #mint(token, device) {
    const body = JSON.stringify({ publicKey: device.publicKey, deviceId: device.id });
    const response = await this.fetchImpl(new URL(DEVICE_SESSION_PATH, `${this.config.relayUrl}/`), {
      method: "POST",
      headers: { ...baseHeaders({ token }, "application/json", "application/json", this.config.clientVersion), ...signedHeaders(device, "POST", DEVICE_SESSION_PATH, body) },
      body,
      redirect: "error"
    });
    if (!response.ok) {
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 60 * 60_000)
        : DEFAULT_MINT_BACKOFF_MS;
      return response.status === 429 ? { retryAt: this.now() + delay } : null;
    }
    const data = await response.json().catch(() => null);
    if (typeof data?.ticket !== "string" || !data.ticket) return null;
    const expiresAt = typeof data.expiresIn === "number"
      ? this.now() + data.expiresIn * 1000
      : typeof data.expiresAt === "number" ? data.expiresAt * 1000 : this.now() + 60 * 60_000;
    return { ticket: data.ticket, expiresAt };
  }

  #device(home) {
    try {
      const settingPath = join(home, "setting.json");
      const setting = JSON.parse(readFileSync(settingPath, "utf8"));
      let privateKey = typeof setting?.device?.privateKey === "string" ? setting.device.privateKey : "";
      if (!privateKey) {
        privateKey = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
        setting.device = { ...(setting.device && typeof setting.device === "object" ? setting.device : {}), privateKey };
        const mode = existsSync(settingPath) ? statSync(settingPath).mode & 0o777 : 0o600;
        const temporaryPath = `${settingPath}.${process.pid}.tmp`;
        writeFileSync(temporaryPath, `${JSON.stringify(setting, null, 2)}\n`, { mode: mode || 0o600 });
        renameSync(temporaryPath, settingPath);
      }
      const key = createPrivateKey(privateKey);
      const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");
      return { id: createHash("sha256").update(publicKey).digest("base64url").slice(0, 22), publicKey, key };
    } catch {
      return null;
    }
  }
}

function baseHeaders(profile, accept = "application/json", contentType = "application/json", clientVersion = "0.0.239") {
  const token = profile?.token || "";
  const account = profile?.id || profile?.userId;
  return {
    Accept: accept,
    "Content-Type": contentType,
    Authorization: `Bearer ${token}`,
    "x-mirasim-token": token,
    "x-mirasim-session": profile?.sessionId || profile?.userId || randomUUID(),
    "x-mirasim-agent": profile?.agent || "mirasim",
    ...(account ? { "x-mirasim-account": account } : {}),
    "x-mirasim-client": clientVersion,
    "x-mirasim-locale": profile?.locale || "en-US",
    "x-mirasim-call": randomUUID()
  };
}

function signedHeaders(device, method, path, body) {
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("base64url");
  const digest = createHash("sha256").update(body).digest("hex");
  const value = ["mrs-sig-v1", method.toUpperCase(), path, ts, nonce, digest].join("\n");
  return {
    "x-mirasim-device": device.id,
    "x-mirasim-ts": ts,
    "x-mirasim-nonce": nonce,
    "x-mirasim-sig": sign(null, Buffer.from(value), device.key).toString("base64url")
  };
}
