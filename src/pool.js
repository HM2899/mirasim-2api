import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export class MirasimProfilePool {
  #homes;
  #cooldownMs;
  #cursor = 0;
  #state = new Map();

  constructor(homes, { cooldownMs = 30_000, now = () => Date.now() } = {}) {
    this.#homes = [...homes];
    this.#cooldownMs = cooldownMs;
    this.now = now;
  }

  homes() { return [...this.#homes]; }

  add(home) {
    if (!this.#homes.includes(home)) this.#homes.push(home);
  }

  remove(home) {
    const index = this.#homes.indexOf(home);
    if (index < 0) return false;
    this.#homes.splice(index, 1);
    this.#state.delete(home);
    this.#cursor = this.#homes.length ? this.#cursor % this.#homes.length : 0;
    return true;
  }

  pick(excluded = new Set()) {
    const profiles = this.#profiles().filter((profile) => !excluded.has(profile.home));
    const ready = profiles.filter((profile) => this.#entry(profile.home).cooldownUntil <= this.now());
    const candidates = ready.length > 0 ? ready : profiles;
    if (candidates.length === 0) return null;

    const selected = candidates[this.#cursor % candidates.length];
    this.#cursor = (this.#cursor + 1) % candidates.length;
    return selected;
  }

  hasCandidate(excluded = new Set()) {
    return this.#profiles().some((profile) => !excluded.has(profile.home));
  }

  success(profile) {
    this.#state.set(profile.home, { cooldownUntil: 0, failures: 0 });
  }

  failure(profile, retryAfterMs = 0) {
    const previous = this.#entry(profile.home);
    const failures = previous.failures + 1;
    // Repeated upstream failures should not make every incoming request exhaust the pool.
    const backoffMs = Math.min(this.#cooldownMs * (2 ** (failures - 1)), 5 * 60_000);
    const cooldownMs = Math.max(backoffMs, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
    this.#state.set(profile.home, { cooldownUntil: this.now() + cooldownMs, failures });
  }

  status() {
    const profiles = this.#profiles();
    const loaded = new Map(profiles.map((profile) => [profile.home, profile]));
    return this.#homes.map((home) => {
      const profile = loaded.get(home);
      const entry = this.#entry(home);
      return {
        home,
        id: profile?.id || basename(home),
        loggedIn: Boolean(profile),
        healthy: Boolean(profile) && entry.cooldownUntil <= this.now(),
        cooldownUntil: entry.cooldownUntil || null
      };
    });
  }

  #profiles() {
    return this.#homes.map(readProfile).filter(Boolean);
  }

  #entry(home) {
    let entry = this.#state.get(home);
    if (!entry) {
      entry = { cooldownUntil: 0, failures: 0 };
      this.#state.set(home, entry);
    }
    return entry;
  }
}

export function readProfile(home) {
  try {
    const setting = JSON.parse(readFileSync(join(home, "setting.json"), "utf8"));
    const auth = setting?.auth;
    if (!auth || typeof auth.token !== "string" || !auth.token.trim()) return null;
    if (typeof auth.exp === "number" && auth.exp <= Math.floor(Date.now() / 1000)) return null;
    return { home, id: auth.userId || basename(home), token: auth.token.trim() };
  } catch {
    return null;
  }
}
