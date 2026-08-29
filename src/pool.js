import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

// Mirasim's free tier draws on a shared relay allowance that is exhausted in practice: a free
// account still reports a budget on /v1/limits, but a real completion comes back as HTTP 429
// with "中转的共享额度已用尽". Such an account stays in the pool as a last resort only.
const FREE_PLANS = new Set(["none", "free"]);

// Priority orders the rotation: the highest priority available account is served first, and
// accounts sharing a priority take turns. Without a manual value the plan decides, so a MAX
// account is spent before a MAX 2X one. Free accounts stay behind every funded account no
// matter which priority they are given.
const PLAN_PRIORITIES = { max: 80, enterprise: 80, internal: 80, plus: 60, basic: 40, none: 0, free: 0 };
const DEFAULT_PRIORITY = 40;
export const PRIORITY_RANGE = { min: 0, max: 100 };

export function planPriority(profile) {
  return PLAN_PRIORITIES[profile?.plan || ""] ?? DEFAULT_PRIORITY;
}

export function normalizePriority(value) {
  if (value === null || value === undefined || value === "" || value === "auto") return null;
  const priority = Math.round(Number(value));
  if (!Number.isFinite(priority)) return null;
  return Math.min(PRIORITY_RANGE.max, Math.max(PRIORITY_RANGE.min, priority));
}

export class MirasimProfilePool {
  #homes;
  #cooldownMs;
  #tick = 0;
  #state = new Map();
  #disabled = new Set();
  #priorities = new Map();
  #plans = new Map();

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
    this.#disabled.delete(home);
    this.#priorities.delete(home);
    return true;
  }

  // A sealed token tells us nothing, so the plan the console read from /auth/me is handed back
  // here: without it every account looks funded and free ones lose their last-resort ranking.
  observePlan(home, plan) {
    if (!this.#homes.includes(home)) return false;
    const value = typeof plan === "string" ? plan.trim().toLowerCase() : "";
    if (value) this.#plans.set(home, value);
    else this.#plans.delete(home);
    return true;
  }

  // The profile as the rotation sees it, with the plan observed from /auth/me filled in.
  profile(home) {
    return this.#homes.includes(home) ? this.#withPlan(readProfile(home)) : null;
  }

  // A manual priority overrides the plan order; null restores it.
  setPriority(home, value) {
    if (!this.#homes.includes(home)) return false;
    const priority = normalizePriority(value);
    if (priority === null) this.#priorities.delete(home);
    else this.#priorities.set(home, priority);
    return true;
  }

  pick(excluded = new Set(), preferredHome = null) {
    const profiles = this.#profiles().filter((profile) => !excluded.has(profile.home) && !this.#disabled.has(profile.home));
    if (profiles.length === 0) return null;

    // An account with real quota is always preferred; free ones are tried only when it is the
    // difference between a doomed attempt and no attempt at all.
    const funded = profiles.filter(hasRelayQuota);
    const tier = funded.length > 0 ? funded : profiles;
    const ready = tier.filter((profile) => this.#entry(profile.home).cooldownUntil <= this.now());

    // The upstream prompt cache lives per account, so a conversation sticks to the account
    // that wrote its cache for as long as that account remains a healthy candidate. A cache
    // hit outranks the priority order; cooling, exclusion, disabling and quota still do not.
    if (preferredHome) {
      const sticky = ready.find((profile) => profile.home === preferredHome);
      if (sticky) return this.#use(sticky);
    }

    if (ready.length > 0) {
      // Highest priority first, and inside one priority rotate by least-recent use rather than by
      // an index into the candidate list: that list keeps changing shape as accounts are excluded
      // or cool down, and an index into it starves the accounts behind the gap.
      const top = Math.max(...ready.map((profile) => this.#priority(profile)));
      const preferred = ready.filter((profile) => this.#priority(profile) === top);
      return this.#use(this.#best(preferred, (home) => this.#entry(home).usedAt));
    }
    // Everything is cooling, so the request is doomed either way: serve whichever account becomes
    // usable first instead of the one that merely ranks highest.
    return this.#use(this.#best(tier, (home) => this.#entry(home).cooldownUntil));
  }

  hasCandidate(excluded = new Set()) {
    return this.#profiles().some((profile) => !excluded.has(profile.home) && !this.#disabled.has(profile.home));
  }

  success(profile) {
    this.#state.set(profile.home, { ...this.#entry(profile.home), cooldownUntil: 0, failures: 0 });
  }

  disable(home) {
    if (!this.#homes.includes(home)) return false;
    this.#disabled.add(home);
    return true;
  }

  enable(home) {
    if (!this.#homes.includes(home)) return false;
    this.#disabled.delete(home);
    this.#state.set(home, { ...this.#entry(home), cooldownUntil: 0, failures: 0 });
    return true;
  }

  isDisabled(home) {
    return this.#disabled.has(home);
  }

  failure(profile, retryAfterMs = 0) {
    const previous = this.#entry(profile.home);
    const failures = previous.failures + 1;
    // Repeated upstream failures should not make every incoming request exhaust the pool.
    const backoffMs = Math.min(this.#cooldownMs * (2 ** (failures - 1)), 5 * 60_000);
    const cooldownMs = Math.max(backoffMs, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
    this.#state.set(profile.home, { ...previous, cooldownUntil: this.now() + cooldownMs, failures });
  }

  status() {
    const profiles = this.#profiles();
    const loaded = new Map(profiles.map((profile) => [profile.home, profile]));
    return this.#homes.map((home) => {
      const profile = this.#withPlan(loaded.get(home));
      const entry = this.#entry(home);
      return {
        home,
        id: profile?.id || basename(home),
        loggedIn: Boolean(profile),
        disabled: this.#disabled.has(home),
        plan: profile?.plan || null,
        funded: profile ? hasRelayQuota(profile) : false,
        priority: profile ? this.#priority(profile) : this.#priorities.get(home) ?? null,
        priorityOverride: this.#priorities.get(home) ?? null,
        healthy: Boolean(profile) && !this.#disabled.has(home) && hasRelayQuota(profile) && entry.cooldownUntil <= this.now(),
        cooldownUntil: entry.cooldownUntil || null
      };
    });
  }

  #profiles() {
    return this.#homes.map((home) => this.#withPlan(readProfile(home))).filter(Boolean);
  }

  #withPlan(profile) {
    if (!profile) return profile;
    const observed = this.#plans.get(profile.home);
    return profile.plan || !observed ? profile : { ...profile, plan: observed };
  }

  #entry(home) {
    let entry = this.#state.get(home);
    if (!entry) {
      entry = { cooldownUntil: 0, failures: 0, usedAt: 0 };
      this.#state.set(home, entry);
    }
    return entry;
  }

  #priority(profile) {
    // status() and pick() both hand in a profile that already carries the observed plan.
    const manual = this.#priorities.get(profile.home);
    return manual === undefined ? planPriority(profile) : manual;
  }

  // Lowest score wins, and ties keep the configured account order.
  #best(profiles, score) {
    return profiles.reduce((best, profile) => (score(profile.home) < score(best.home) ? profile : best));
  }

  #use(profile) {
    // A counter, not the clock: two picks inside the same millisecond must still rotate.
    this.#state.set(profile.home, { ...this.#entry(profile.home), usedAt: ++this.#tick });
    return profile;
  }
}

// Remembers which account served a conversation so its next turn reads the prompt cache
// that the previous turn wrote. Entries refresh on every use and expire so an abandoned
// conversation releases its account back to plain rotation.
export class ConversationAffinity {
  #entries = new Map();
  #ttlMs;
  #maxEntries;

  constructor({ ttlMs = 30 * 60_000, maxEntries = 5_000, now = () => Date.now() } = {}) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
    this.now = now;
  }

  preferred(key) {
    if (!key) return null;
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.#entries.delete(key);
      return null;
    }
    return entry.home;
  }

  remember(key, home) {
    if (!key || !home) return;
    // Re-insert to keep the map in least-recently-used order for the size cap.
    this.#entries.delete(key);
    this.#entries.set(key, { home, expiresAt: this.now() + this.#ttlMs });
    if (this.#entries.size > this.#maxEntries) {
      for (const oldest of this.#entries.keys()) {
        if (this.#entries.size <= this.#maxEntries) break;
        this.#entries.delete(oldest);
      }
    }
  }
}

export function hasRelayQuota(profile) {
  return !FREE_PLANS.has(profile?.plan || "");
}

// Older Mirasim tokens are JWTs whose payload carries the plan and its expiry (plan_exp).
// A current "mrs1:" token is an AES-256-GCM blob sealed with an OS keychain key, so it carries
// no readable claims at all: plan and subscription end have to come from /auth/me instead.
export function tokenClaims(token) {
  if (typeof token === "string" && token.startsWith("mrs1:")) return {};
  try {
    const payload = String(token).split(".")[1];
    if (!payload) return {};
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : {};
  } catch {
    return {};
  }
}

export function readProfile(home) {
  try {
    const setting = JSON.parse(readFileSync(join(home, "setting.json"), "utf8"));
    const auth = setting?.auth;
    if (!auth || typeof auth.token !== "string" || !auth.token.trim()) return null;
    if (typeof auth.exp === "number" && auth.exp <= Math.floor(Date.now() / 1000)) return null;
    const token = auth.token.trim();
    const plan = tokenClaims(token).plan;
    return { home, id: auth.userId || basename(home), token, plan: typeof plan === "string" ? plan.trim().toLowerCase() : "" };
  } catch {
    return null;
  }
}
