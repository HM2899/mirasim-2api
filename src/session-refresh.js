import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REFRESH_WINDOW_SECONDS = 5 * 60;
const CHECK_INTERVAL_MS = 60_000;
const FAILED_CHECK_INTERVAL_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 12_000;

export class MirasimSessionRefresher {
  #nextCheckAt = new Map();
  #inFlight = new Map();

  constructor(config, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async refreshAll(homes) {
    await Promise.all(homes.map((home) => this.refreshIfNeeded(home)));
  }

  async refreshIfNeeded(home) {
    const now = this.now();
    if ((this.#nextCheckAt.get(home) || 0) > now) return false;
    return this.#start(home, now, false);
  }

  async refreshNow(home) {
    return this.#start(home, this.now(), true);
  }

  #start(home, now, force) {
    const active = this.#inFlight.get(home);
    if (active) return active;
    const task = this.#refresh(home, now, force).finally(() => this.#inFlight.delete(home));
    this.#inFlight.set(home, task);
    return task;
  }

  async #refresh(home, now, force) {
    const auth = storedAuth(home);
    if (!auth?.token || !auth.refreshToken) return this.#wait(home, now, FAILED_CHECK_INTERVAL_MS);
    const secondsLeft = typeof auth.exp === "number" ? auth.exp - Math.floor(now / 1000) : 0;
    if (!force && secondsLeft > REFRESH_WINDOW_SECONDS) {
      this.#nextCheckAt.set(home, Math.min(now + CHECK_INTERVAL_MS, (auth.exp - REFRESH_WINDOW_SECONDS) * 1000));
      return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(new URL("/auth/refresh", `${this.config.loginUrl}/`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: auth.refreshToken }),
        signal: controller.signal,
        redirect: "error"
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || typeof data?.access_token !== "string" || !data.access_token) {
        return this.#wait(home, now, FAILED_CHECK_INTERVAL_MS);
      }
      saveRefreshedAuth(home, data.access_token, typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : auth.refreshToken);
      return this.#wait(home, now, CHECK_INTERVAL_MS, true);
    } catch {
      return this.#wait(home, now, FAILED_CHECK_INTERVAL_MS);
    } finally {
      clearTimeout(timer);
    }
  }

  #wait(home, now, interval, result = false) {
    this.#nextCheckAt.set(home, now + interval);
    return result;
  }
}

export function saveRefreshedAuth(home, token, refreshToken) {
  const settingPath = join(home, "setting.json");
  const exists = existsSync(settingPath);
  if (!exists) mkdirSync(home, { recursive: true, mode: 0o700 });
  const setting = exists ? JSON.parse(readFileSync(settingPath, "utf8")) : {};
  const previousAuth = setting?.auth && typeof setting.auth === "object" ? setting.auth : {};
  const updatedAuth = { ...previousAuth, token };
  const expiry = jwtExpiry(token);
  if (expiry !== undefined) updatedAuth.exp = expiry;
  const userId = jwtUserId(token);
  if (userId) updatedAuth.userId = userId;
  if (typeof refreshToken === "string" && refreshToken) updatedAuth.refreshToken = refreshToken;
  setting.auth = updatedAuth;
  const mode = exists ? statSync(settingPath).mode & 0o777 : 0o600;
  const temporaryPath = `${settingPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(setting, null, 2)}\n`, { mode: mode || 0o600 });
  renameSync(temporaryPath, settingPath);
}

function storedAuth(home) {
  try {
    const auth = JSON.parse(readFileSync(join(home, "setting.json"), "utf8"))?.auth;
    return auth && typeof auth === "object" ? auth : null;
  } catch {
    return null;
  }
}

function jwtExpiry(token) {
  try {
    const payload = token.split(".")[1];
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof parsed.exp === "number" ? parsed.exp : undefined;
  } catch {
    return undefined;
  }
}

function jwtUserId(token) {
  try {
    const payload = token.split(".")[1];
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof parsed.sub === "string" && parsed.sub ? parsed.sub : undefined;
  } catch {
    return undefined;
  }
}
