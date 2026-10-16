import { readFileSync, statSync } from "node:fs";
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

// How the rotation orders accounts that are otherwise equal — inside one priority tier, and only
// there. Priority stays a hard constraint under every mode.
//
// `spread` serves the account with the most left first, so the pool drains evenly. The cost is
// that it also empties evenly: every account reaches its limit at about the same time and their
// 5h/7d windows reset together, so the pool goes quiet all at once.
//
// `waterfall` serves the account with the least left first, draining one account at a time. Their
// reset windows stagger, so there is usually a fresh account somewhere, and a conversation's turns
// land on one account often enough to keep its prompt cache warm. The cost is more 429s on the
// account being drained and more failover hops.
//
// `roundRobin` ignores the meters and simply takes turns — what the pool did before it could read
// quota at all, kept for a pool whose accounts do not report usable readings.
export const ROTATION_MODES = new Set(["spread", "waterfall", "roundRobin"]);
export const DEFAULT_ROTATION_MODE = "spread";

export function normalizeRotationMode(value) {
  const mode = typeof value === "string" ? value.trim() : "";
  return ROTATION_MODES.has(mode) ? mode : null;
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
  #planned = new Map();
  #quota = new Map();
  #mode = DEFAULT_ROTATION_MODE;

  constructor(homes, { cooldownMs = 30_000, mode = DEFAULT_ROTATION_MODE, now = () => Date.now() } = {}) {
    this.#homes = [...homes];
    this.#cooldownMs = cooldownMs;
    this.#mode = normalizeRotationMode(mode) || DEFAULT_ROTATION_MODE;
    this.now = now;
  }

  mode() { return this.#mode; }

  // The operator's choice, taken live: a request already in its failover loop keeps the order it
  // started with, and the next one picks under the new mode.
  setMode(value) {
    const mode = normalizeRotationMode(value);
    if (!mode) return false;
    this.#mode = mode;
    return true;
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
    return this.#homes.includes(home) ? this.#withPlan(readProfile(home, this.now)) : null;
  }

  // Every relay response carries the account's own rate-limit meter, so the rotation is told what
  // each account has left by the traffic it is already sending — no polling, and never more than
  // one request out of date. A 429 is the most valuable reading of all: it is the account saying
  // it is spent, in the same breath as the refusal.
  observeQuota(home, headers) {
    if (!this.#homes.includes(home) || typeof headers?.get !== "function") return false;
    const windows = [];
    for (const name of UNIFIED_WINDOWS) {
      const usedPercent = utilizationPercent(headers.get(`anthropic-ratelimit-unified-${name}-utilization`));
      if (usedPercent === null) continue;
      const reset = Number(headers.get(`anthropic-ratelimit-unified-${name}-reset`));
      windows.push({ name, usedPercent, resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null });
    }
    return this.#observeWindows(home, windows);
  }

  // The console reads /v1/limits for every account about once a minute, and those are the same
  // counters the response headers carry — only they arrive without a request having to be spent,
  // and they cover accounts the rotation has not touched since startup, which otherwise report
  // nothing consumed and sort to the front until a doomed request corrects them.
  //
  // A model-scoped window is dropped: filling up `7d_fable` stops fable, not the account, and
  // letting one in would park a perfectly usable account as spent.
  observeLimits(home, windows) {
    if (!this.#homes.includes(home) || !Array.isArray(windows)) return false;
    const readings = [];
    for (const window of windows) {
      if (!window || window.modelScoped === true) continue;
      const name = typeof window.name === "string" ? window.name.trim() : "";
      const usedPercent = Number(window.usedPercent);
      if (!name || !Number.isFinite(usedPercent)) continue;
      readings.push({ name, usedPercent: settlePercent(Math.min(100, Math.max(0, usedPercent))), resetAt: resetAtMs(window.resetAt) });
    }
    return this.#observeWindows(home, readings);
  }

  // What the account has left, as of its last reading. A window that is past its reset has
  // started over, so its reading no longer says anything and is read as empty rather than kept.
  // An account that has not been used since startup reports nothing consumed, which puts it at
  // the front — the optimistic guess, and the first response it serves corrects it.
  usedPercent(home) {
    const readings = this.#quota.get(home);
    if (!readings) return 0;
    const live = [...readings.values()].filter((window) => !window.resetAt || window.resetAt > this.now());
    return live.length > 0 ? Math.max(...live.map((window) => window.usedPercent)) : 0;
  }

  // A manual priority overrides the plan order; null restores it.
  setPriority(home, value) {
    if (!this.#homes.includes(home)) return false;
    const priority = normalizePriority(value);
    if (priority === null) this.#priorities.delete(home);
    else this.#priorities.set(home, priority);
    return true;
  }

  priority(profile) {
    if (!profile) return null;
    return this.#priority(profile);
  }

  pick(excluded = new Set(), preferredHome = null, mode = this.#mode) {
    // An account the relay has said is out of quota, until its window resets, is not a candidate
    // at all — not even as the forced last resort for a pool that is cooling. Asking it again can
    // only be refused again, and a refused request walks on to the next account, so one request
    // against an exhausted pool used to cost one 429 per account.
    const profiles = this.#profiles().filter((profile) => !excluded.has(profile.home) && !this.#disabled.has(profile.home) && !this.#limited(profile.home));
    if (profiles.length === 0) return null;

    // An account with real quota is always preferred; free ones are tried only when it is the
    // difference between a doomed attempt and no attempt at all.
    const funded = profiles.filter(hasRelayQuota);
    const tier = funded.length > 0 ? funded : profiles;
    const ready = tier.filter((profile) => this.#entry(profile.home).cooldownUntil <= this.now());
    const top = ready.length > 0
      ? Math.max(...ready.map((profile) => this.#priority(profile)))
      : null;
    const priorityTier = top === null ? [] : ready.filter((profile) => this.#priority(profile) === top);
    // An account the relay has already metered to its limit will answer 429 and nothing else, so
    // it is passed over while another account in the same priority tier can serve — priority is
    // decided first and quota must not promote a lower-priority account. If every account in the
    // selected tier reads as spent, that tier is still the only tier eligible for this pick.
    const spendable = priorityTier.filter((profile) => this.usedPercent(profile.home) < 100);
    const usable = spendable.length > 0 ? spendable : priorityTier;

    if (usable.length > 0) {
      // The upstream prompt cache lives per account, so a conversation sticks to the account
      // that wrote its cache when that account remains eligible in the current priority tier.
      if (preferredHome) {
        const sticky = usable.find((profile) => profile.home === preferredHome);
        if (sticky) return this.#use(sticky);
      }
      // All modes are already inside the highest-priority tier. The account with the most left
      // goes first where the selected mode uses quota, but only in bands:
      // readings differ by fractions of a percent, and ordering on that alone would hand every
      // request in a burst to the same account, since none of their meters move until the first
      // response comes back. Accounts within a band fall back to least-recent use, which is what
      // actually keeps the rotation turning.
      return this.#use(this.#best(usable, (home) => this.#order(home, mode)));
    }
    // Even when every account is cooling, priority remains the first constraint. The cooldown
    // time only chooses which account to force inside the highest-priority tier.
    const coolingTop = Math.max(...tier.map((profile) => this.#priority(profile)));
    const preferred = tier.filter((profile) => this.#priority(profile) === coolingTop);
    return this.#use(this.#best(preferred, (home) => [this.#entry(home).cooldownUntil]));
  }

  hasCandidate(excluded = new Set()) {
    return this.#profiles().some((profile) => !excluded.has(profile.home) && !this.#disabled.has(profile.home) && !this.#limited(profile.home));
  }

  // Called when an account has just answered 429. If the meter it came back with shows a unified
  // window at its limit, the account is out until that window resets, and is parked until then
  // instead of being retried on a backoff that is shorter than the window. A 429 whose meter is
  // not full is a model-scoped or transient refusal and keeps only the ordinary cooldown. Returns
  // the milliseconds the account is parked for, or 0.
  markLimited(profile, retryAfterMs = 0) {
    if (!profile || !this.#homes.includes(profile.home)) return 0;
    const readings = this.#quota.get(profile.home);
    let until = 0;
    if (readings) {
      for (const window of readings.values()) {
        if (window.usedPercent < 100 || !window.resetAt || window.resetAt <= this.now()) continue;
        until = Math.max(until, window.resetAt);
      }
    }
    if (until === 0) return 0;
    until = Math.max(until, this.now() + (Number.isFinite(retryAfterMs) ? retryAfterMs : 0));
    this.#state.set(profile.home, { ...this.#entry(profile.home), limitedUntil: until });
    return until - this.now();
  }

  // When the pool has nothing to offer only because its accounts are parked, how long until the
  // first of them is back. 0 when no eligible account is parked, so the caller can tell an
  // exhausted pool from an empty one.
  limitedRetryMs(excluded = new Set()) {
    let soonest = 0;
    for (const profile of this.#profiles()) {
      if (excluded.has(profile.home) || this.#disabled.has(profile.home)) continue;
      const remaining = this.#entry(profile.home).limitedUntil - this.now();
      if (remaining > 0 && (soonest === 0 || remaining < soonest)) soonest = remaining;
    }
    return soonest;
  }

  #limited(home) {
    return this.#entry(home).limitedUntil > this.now();
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
    this.#state.set(home, { ...this.#entry(home), cooldownUntil: 0, failures: 0, limitedUntil: 0 });
    return true;
  }

  isDisabled(home) {
    return this.#disabled.has(home);
  }

  // Clears the automatic cooldown and the backoff behind it, and nothing else. An account an
  // operator parked stays parked — only the penalty the pool applied by itself is lifted.
  recover(home) {
    if (!this.#homes.includes(home)) return false;
    const entry = this.#entry(home);
    if (entry.cooldownUntil === 0 && entry.failures === 0 && !(entry.limitedUntil > 0)) return false;
    this.#state.set(home, { ...entry, cooldownUntil: 0, failures: 0, limitedUntil: 0 });
    return true;
  }

  // One upstream outage can cool every account at once, and waiting out a backoff that is
  // already up to five minutes long is the wrong answer once the upstream is back. Reports how
  // many accounts actually carried a penalty, so the console can say what it changed.
  recoverAll() {
    return this.#homes.filter((home) => this.recover(home)).length;
  }

  failure(profile, retryAfterMs = 0) {
    const previous = this.#entry(profile.home);
    // An account that was still cooling when it was picked was a forced attempt: every candidate
    // was cooling and the rotation served the one that recovers soonest rather than nothing at
    // all. Its failure reports the outage again, not a further fault of this account, so it must
    // not deepen the backoff — counting it doubles the cooldown of every account the pool falls
    // back on, and a burst of doomed requests walks the whole pool up to the five-minute ceiling
    // where it then stays long after the upstream has recovered.
    const forced = previous.cooldownUntil > this.now();
    const failures = forced ? previous.failures : previous.failures + 1;
    // Repeated upstream failures should not make every incoming request exhaust the pool.
    const backoffMs = Math.min(this.#cooldownMs * (2 ** Math.max(0, failures - 1)), 5 * 60_000);
    const cooldownMs = Math.max(backoffMs, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
    // A forced attempt still honours a longer cooldown that is already running.
    const cooldownUntil = Math.max(previous.cooldownUntil, this.now() + cooldownMs);
    this.#state.set(profile.home, { ...previous, cooldownUntil, failures });
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
        healthy: Boolean(profile) && !this.#disabled.has(home) && hasRelayQuota(profile) && entry.cooldownUntil <= this.now() && !(entry.limitedUntil > this.now()),
        cooldownUntil: Math.max(entry.cooldownUntil, entry.limitedUntil || 0) || null,
        // What the rotation itself is going on, which is the last reading the traffic brought
        // back — null until this account has served a response since startup.
        usedPercent: this.#quota.has(home) ? this.usedPercent(home) : null
      };
    });
  }

  #profiles() {
    return this.#homes.map((home) => this.#withPlan(readProfile(home, this.now))).filter(Boolean);
  }

  // Most accounts hold a sealed `mrs1:` token whose plan can only come from /auth/me, so this
  // rebuilds nearly every profile in the pool on every pick. readProfile hands back the same
  // object while the file is untouched, which is enough to reuse the last result.
  #withPlan(profile) {
    if (!profile) return profile;
    const observed = this.#plans.get(profile.home);
    if (profile.plan || !observed) return profile;
    const cached = this.#planned.get(profile.home);
    if (cached?.source === profile && cached.observed === observed) return cached.profile;
    const planned = { ...profile, plan: observed };
    this.#planned.set(profile.home, { source: profile, observed, profile: planned });
    return planned;
  }

  // One store for both sources, keyed by window name: the response headers and /v1/limits report
  // the same counters, so a window that appears in both keeps whichever reading arrived last.
  // They disagree only by whatever traffic landed between the two, which is well inside a band.
  #observeWindows(home, windows) {
    if (windows.length === 0) return false;
    const readings = this.#quota.get(home) || new Map();
    for (const window of windows) readings.set(window.name, window);
    this.#quota.set(home, readings);
    // The account is only parked while its meter says it is full: a reading with room — the
    // console's /v1/limits poll after a reset card, or a window that rolled over — releases it.
    const entry = this.#entry(home);
    if (entry.limitedUntil > 0 && this.usedPercent(home) < 100) this.#state.set(home, { ...entry, limitedUntil: 0 });
    return true;
  }

  #entry(home) {
    let entry = this.#state.get(home);
    if (!entry) {
      entry = { cooldownUntil: 0, failures: 0, limitedUntil: 0, usedAt: 0 };
      this.#state.set(home, entry);
    }
    return entry;
  }

  #priority(profile) {
    // status() and pick() both hand in a profile that already carries the observed plan.
    const manual = this.#priorities.get(profile.home);
    return manual === undefined ? planPriority(profile) : manual;
  }

  // Consumption sorted into bands, so that ordering by quota is a real preference between
  // accounts that differ and a no-op between accounts that are effectively level.
  #quotaBand(home) {
    return Math.floor(this.usedPercent(home) / QUOTA_BAND_PERCENT);
  }

  // The score that orders accounts inside one priority tier, lowest first. Least-recent use is the
  // last word under every mode, which is what keeps the rotation turning between accounts the mode
  // itself cannot separate.
  #order(home, mode) {
    if (mode === "roundRobin") return [this.#entry(home).usedAt];
    // Waterfall drains the fullest account first, so it wants the highest consumption band at the
    // front — the band negated, since a lower score wins. An account with no reading yet counts as
    // untouched under either mode, which puts it last here and first under spread; that is the
    // right way round, because the point of waterfall is to finish an account already in use
    // before opening a fresh one.
    if (mode === "waterfall") return [-this.#quotaBand(home), this.#entry(home).usedAt];
    return [this.#quotaBand(home), this.#entry(home).usedAt];
  }

  // Lowest score wins, compared entry by entry so a later entry only breaks a tie in an earlier
  // one; ties all the way down keep the configured account order.
  #best(profiles, score) {
    return profiles.reduce((best, profile) => (compareScores(score(profile.home), score(best.home)) < 0 ? profile : best));
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

// The unified rate limit the relay reports back on every response. There is no per-model window
// here, which is what the rotation wants: filling up a model-scoped budget stops that model, not
// the account.
const UNIFIED_WINDOWS = ["5h", "7d"];
// Wide enough that the fraction-of-a-percent differences between two barely-used accounts do not
// count as a preference, narrow enough that a visibly emptier account sinks.
const QUOTA_BAND_PERCENT = 5;

function compareScores(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

// The percentages the official client computes, kept in one place so the console's colours and
// the rotation's decisions are reading the same numbers. Rounded to a tenth, then closed off:
// the upstream's counters lag its refusals, so anything from 99% up is treated as spent.
export function usedPercentOf(used, budget) {
  return settlePercent(Math.max(0, Math.min(100, Math.round(used / budget * 100 * 10) / 10)));
}

// The rate-limit headers report utilization as a fraction of one, not a percentage.
export function utilizationPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const fraction = Number(value);
  if (!Number.isFinite(fraction)) return null;
  return settlePercent(Math.max(0, Math.min(100, Math.round(fraction * 100 * 10) / 10)));
}

// /v1/limits reports a reset as an ISO timestamp once the console has normalized it; the
// rate-limit headers report the same instant as bare epoch seconds.
function resetAtMs(value) {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function settlePercent(percent) {
  return percent >= 99 ? 100 : percent;
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

export function readProfile(home, now = () => Date.now()) {
  const parsed = parseProfile(home);
  if (!parsed) return null;
  // Expiry is the one thing that turns a good profile bad without the file changing, so it is
  // re-checked against the clock on every read rather than baked into what is cached.
  if (parsed.exp !== null && parsed.exp <= Math.floor(now() / 1000)) return null;
  return parsed.profile;
}

// Rotation reads every account's setting.json on every pick, and a pick happens on every
// attempt of every request: with a pool of 67 accounts that was 1.3 ms of blocking sync I/O
// per pick, which stalls every stream this gateway is relaying at the time. The files change
// only when a token is refreshed or an account is logged in, so the parse is cached and
// revalidated against the cheaper stat.
const parsedProfiles = new Map();
// mtime and size cannot distinguish a write that lands in the same timestamp tick as the read
// that cached it — and a token refresh writes a token of exactly the same length, so size does
// not break the tie either. File timestamps here have millisecond granularity, and other
// filesystems round to a whole second, so a file is only trusted to the cache once the clock
// has moved a full second past its mtime. Serving a token that has already been replaced is
// the one error this cache must not make; re-reading a just-written file for a second is free.
const SETTLE_MS = 1_000;

function parseProfile(home) {
  const file = join(home, "setting.json");
  let stats;
  try {
    stats = statSync(file);
  } catch {
    parsedProfiles.delete(home);
    return null;
  }
  const stamp = `${stats.mtimeMs}:${stats.size}`;
  const cached = parsedProfiles.get(home);
  if (cached?.stamp === stamp && cached.settled) return cached.parsed;

  const parsed = readParsedProfile(home, file);
  parsedProfiles.set(home, { stamp, parsed, settled: Date.now() - stats.mtimeMs > SETTLE_MS });
  return parsed;
}

function readParsedProfile(home, file) {
  try {
    const setting = JSON.parse(readFileSync(file, "utf8"));
    const auth = setting?.auth;
    if (!auth || typeof auth.token !== "string" || !auth.token.trim()) return null;
    const token = auth.token.trim();
    const plan = tokenClaims(token).plan;
    return {
      exp: typeof auth.exp === "number" ? auth.exp : null,
      profile: { home, id: auth.userId || basename(home), token, plan: typeof plan === "string" ? plan.trim().toLowerCase() : "" }
    };
  } catch {
    return null;
  }
}
