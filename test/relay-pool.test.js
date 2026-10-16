import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MirasimProfilePool, readProfile } from "../src/pool.js";

function fixture(root, id, token) {
  const home = join(root, id);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: id, token, exp: 4_102_444_800 } }));
  return home;
}

test("selects logged-in profiles in round-robin order", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const first = fixture(root, "first", "token-a");
    const second = fixture(root, "second", "token-b");
    const pool = new MirasimProfilePool([first, second]);
    assert.equal(pool.pick().id, "first");
    assert.equal(pool.pick().id, "second");
    assert.equal(pool.pick().id, "first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cools down a failed profile and keeps the next profile available", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const first = fixture(root, "first", "token-a");
    const second = fixture(root, "second", "token-b");
    let now = 10_000;
    const pool = new MirasimProfilePool([first, second], { cooldownMs: 500, now: () => now });
    const picked = pool.pick();
    pool.failure(picked);
    assert.equal(pool.pick().id, "second");
    now += 501;
    assert.equal(pool.pick().id, "first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a forced pick from a fully cooling pool does not deepen the backoff", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const only = fixture(root, "only", "token-a");
    let now = 10_000;
    const pool = new MirasimProfilePool([only], { cooldownMs: 1_000, now: () => now });
    pool.failure(pool.pick());
    assert.equal(pool.status()[0].cooldownUntil, 11_000);

    // Everything is cooling, so the rotation serves the account anyway — and that doomed attempt
    // must not count against it. Left uncounted, three more failures would reach 8x the cooldown.
    for (let attempt = 0; attempt < 3; attempt++) {
      now += 1;
      pool.failure(pool.pick());
      assert.equal(pool.status()[0].cooldownUntil, 11_000 + attempt + 1);
    }

    // Once the cooldown has actually elapsed, a fresh failure is the account's own again.
    now = 11_010;
    pool.failure(pool.pick());
    assert.equal(pool.status()[0].cooldownUntil, 13_010);

    // A retry-after longer than the backoff still wins, and never shortens a running cooldown.
    pool.failure(pool.pick(), 10_000);
    assert.equal(pool.status()[0].cooldownUntil, 21_010);
    pool.failure(pool.pick(), 1);
    assert.equal(pool.status()[0].cooldownUntil, 21_010);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rewritten setting.json is picked up without re-reading every file on every pick", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const home = fixture(root, "only", "token-a");
    const file = join(home, "setting.json");
    const settle = () => utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const pool = new MirasimProfilePool([home]);
    assert.equal(pool.pick().token, "token-a");

    // Once the file is old enough that a further write could not share its timestamp, the parse
    // is reused: that identity is what lets the plan overlay and the rotation stop rebuilding
    // every account in the pool on every pick.
    settle();
    assert.equal(pool.profile(home), pool.profile(home));

    // A token refresh rewrites the file, and the very next pick must carry the new token — even
    // though it is the same length as the one it replaced, so only the timestamp changed.
    writeFileSync(file, JSON.stringify({ auth: { userId: "only", token: "token-b", exp: 4_102_444_800 } }));
    assert.equal(pool.pick().token, "token-b");

    // A file rewritten inside the timestamp granularity of the read that cached it is re-read
    // rather than trusted, which is the case a stamp alone cannot tell apart.
    for (const token of ["token-c", "token-d", "token-e"]) {
      writeFileSync(file, JSON.stringify({ auth: { userId: "only", token, exp: 4_102_444_800 } }));
      assert.equal(pool.pick().token, token);
    }

    // A logged-out account disappears from the rotation rather than being served from cache.
    settle();
    assert.equal(pool.profile(home).token, "token-e");
    rmSync(file);
    assert.equal(pool.pick(), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an expired token leaves the rotation on the clock alone, without the file changing", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const home = join(root, "expiring");
    mkdirSync(home, { recursive: true });
    const exp = Math.floor(Date.now() / 1000) + 1;
    writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: "expiring", token: "token-a", exp } }));
    const pool = new MirasimProfilePool([home]);
    assert.equal(pool.pick().token, "token-a");
    // Expiry is re-checked against the clock on every read, so a cached parse cannot outlive it.
    assert.equal(readProfile(home).token, "token-a");
    assert.equal(readProfile(home, () => (exp + 1) * 1000), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function meter({ fiveHour = null, sevenDay = null, reset = null } = {}) {
  const headers = new Headers();
  if (fiveHour !== null) headers.set("anthropic-ratelimit-unified-5h-utilization", String(fiveHour));
  if (sevenDay !== null) headers.set("anthropic-ratelimit-unified-7d-utilization", String(sevenDay));
  if (reset !== null) {
    headers.set("anthropic-ratelimit-unified-5h-reset", String(reset));
    headers.set("anthropic-ratelimit-unified-7d-reset", String(reset));
  }
  return headers;
}

test("an account the relay has metered to its limit is passed over until its window resets", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const [first, second] = ["first", "second"].map((id, index) => fixture(root, id, `token-${index}`));
    let now = 10_000;
    const pool = new MirasimProfilePool([first, second], { now: () => now });
    const resetAt = 610; // seconds since epoch, i.e. now + 600_000 ms

    // 0.994 rounds to 99.4%, which the official arithmetic closes off to spent.
    assert.equal(pool.observeQuota(first, meter({ fiveHour: 0.994, sevenDay: 0.1, reset: resetAt })), true);
    pool.observeQuota(second, meter({ fiveHour: 0.2, sevenDay: 0.1, reset: resetAt }));
    assert.equal(pool.usedPercent(first), 100);
    assert.equal(pool.usedPercent(second), 20);

    // The spent account is skipped rather than discovered by burning a request on it.
    assert.equal(pool.pick().id, "second");
    assert.equal(pool.pick().id, "second");
    // It is skipped, not cooled: nothing about the account itself has gone wrong.
    assert.equal(pool.status()[0].healthy, true);
    assert.equal(pool.status()[0].usedPercent, 100);

    // Past the reset the window has started over, so its last reading no longer says anything.
    now = 610_001;
    assert.equal(pool.usedPercent(first), 0);
    assert.equal(pool.pick().id, "first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every account reading as spent still gets the request rather than nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const homes = ["first", "second"].map((id, index) => fixture(root, id, `token-${index}`));
    const pool = new MirasimProfilePool(homes, { now: () => 10_000 });
    for (const home of homes) pool.observeQuota(home, meter({ fiveHour: 1, sevenDay: 1 }));
    assert.equal(pool.pick()?.id, "first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quota orders accounts inside a priority tier, and never across one", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const [low, high, alsoHigh] = ["low", "high", "also-high"].map((id, index) => fixture(root, id, `token-${index}`));
    const pool = new MirasimProfilePool([low, high, alsoHigh], { now: () => 10_000 });
    pool.setPriority(low, 10);
    pool.setPriority(high, 90);
    pool.setPriority(alsoHigh, 90);

    // The bottom-priority account is nearly untouched and the top ones are half spent; priority
    // is still a hard constraint, so quota reorders within the tier and never promotes across it.
    pool.observeQuota(low, meter({ fiveHour: 0.01 }));
    pool.observeQuota(high, meter({ fiveHour: 0.5 }));
    pool.observeQuota(alsoHigh, meter({ fiveHour: 0.3 }));
    // The barely-touched account is in the bottom tier and stays there: quota never promotes an
    // account past a priority, however much it has left.
    assert.equal(pool.pick().id, "also-high");
    // The fuller of the two keeps serving until its own meter says it has caught up — that is
    // what ordering by remaining quota means, and it is the traffic that moves the meter.
    assert.equal(pool.pick().id, "also-high");
    pool.observeQuota(alsoHigh, meter({ fiveHour: 0.55 }));
    assert.equal(pool.pick().id, "high");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accounts whose meters are effectively level keep rotating instead of piling onto one", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const homes = ["a", "b", "c"].map((id, index) => fixture(root, id, `token-${index}`));
    const pool = new MirasimProfilePool(homes, { now: () => 10_000 });
    // Fractions of a percent apart. Ordering on the raw number would send a burst of concurrent
    // requests to whichever account read lowest, because no meter moves until a response returns.
    pool.observeQuota(homes[0], meter({ fiveHour: 0.011 }));
    pool.observeQuota(homes[1], meter({ fiveHour: 0.014 }));
    pool.observeQuota(homes[2], meter({ fiveHour: 0.012 }));
    assert.deepEqual([pool.pick().id, pool.pick().id, pool.pick().id], ["a", "b", "c"]);

    // An account a whole band emptier drops out of the rotation entirely while the level ones
    // still have room, and those keep taking turns between themselves.
    pool.observeQuota(homes[1], meter({ fiveHour: 0.4 }));
    assert.deepEqual([pool.pick().id, pool.pick().id, pool.pick().id], ["a", "c", "a"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a response without rate-limit headers leaves the last reading alone", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const home = fixture(root, "only", "token-a");
    const pool = new MirasimProfilePool([home], { now: () => 10_000 });
    assert.equal(pool.status()[0].usedPercent, null);
    assert.equal(pool.observeQuota(home, new Headers()), false);
    assert.equal(pool.observeQuota(home, undefined), false);
    assert.equal(pool.status()[0].usedPercent, null);

    pool.observeQuota(home, meter({ fiveHour: 0.25 }));
    assert.equal(pool.usedPercent(home), 25);
    // A later answer that carries no meter must not erase what the last one reported.
    assert.equal(pool.observeQuota(home, new Headers()), false);
    assert.equal(pool.usedPercent(home), 25);
    assert.equal(pool.observeQuota(join(root, "missing"), meter({ fiveHour: 0.5 })), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the console's limit reading tells the rotation about accounts no request has touched", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const [spent, fresh] = ["spent", "fresh"].map((id, index) => fixture(root, id, `token-${index}`));
    let now = 10_000;
    const pool = new MirasimProfilePool([spent, fresh], { now: () => now });

    // Neither account has served anything since startup, so both read as untouched and the
    // first in configured order would go first — including the one that is already spent.
    assert.equal(pool.pick().id, "spent");

    // /v1/limits says otherwise, and it says so without a request having to be spent on it.
    assert.equal(pool.observeLimits(spent, [
      { name: "5h", usedPercent: 99.4, resetAt: new Date(610_000).toISOString(), modelScoped: false },
      { name: "7d", usedPercent: 30, resetAt: null, modelScoped: false }
    ]), true);
    assert.equal(pool.observeLimits(fresh, [{ name: "5h", usedPercent: 12, resetAt: null, modelScoped: false }]), true);
    assert.equal(pool.usedPercent(spent), 100);
    assert.equal(pool.pick().id, "fresh");

    // Past the reset that window has started over, and the 7d window it still has is what binds.
    now = 610_001;
    assert.equal(pool.usedPercent(spent), 30);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a model-scoped window never reports the account itself as spent", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const home = fixture(root, "only", "token-a");
    const pool = new MirasimProfilePool([home], { now: () => 10_000 });
    // Filling up `7d_fable` stops fable, not the account: everything else keeps running, so the
    // rotation must not park the account on the strength of it.
    assert.equal(pool.observeLimits(home, [
      { name: "7d_fable", usedPercent: 100, resetAt: null, modelScoped: true },
      { name: "7d", usedPercent: 20, resetAt: null, modelScoped: false }
    ]), true);
    assert.equal(pool.usedPercent(home), 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the two quota sources share one store, window by window", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const home = fixture(root, "only", "token-a");
    const pool = new MirasimProfilePool([home], { now: () => 10_000 });
    pool.observeLimits(home, [
      { name: "5h", usedPercent: 20, resetAt: null, modelScoped: false },
      { name: "7d", usedPercent: 45, resetAt: null, modelScoped: false }
    ]);
    assert.equal(pool.usedPercent(home), 45);

    // Traffic reports the same windows by the same names, so a fresher header reading replaces
    // the console's for the windows it covers and leaves the rest of the account's picture alone.
    pool.observeQuota(home, meter({ fiveHour: 0.6 }));
    assert.equal(pool.usedPercent(home), 60);
    pool.observeQuota(home, meter({ fiveHour: 0.1 }));
    assert.equal(pool.usedPercent(home), 45);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a limit reading with nothing usable in it leaves the last reading alone", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const home = fixture(root, "only", "token-a");
    const pool = new MirasimProfilePool([home], { now: () => 10_000 });
    assert.equal(pool.observeLimits(home, null), false);
    assert.equal(pool.observeLimits(home, []), false);
    assert.equal(pool.status()[0].usedPercent, null);

    pool.observeLimits(home, [{ name: "5h", usedPercent: 25, resetAt: null, modelScoped: false }]);
    assert.equal(pool.usedPercent(home), 25);
    // A relay with no limits endpoint, a window with no name, a window with no figure: an absence
    // rather than a reading of zero, which would read as an account with plenty left.
    assert.equal(pool.observeLimits(home, [{ name: "", usedPercent: 0 }, { name: "5h" }, null]), false);
    assert.equal(pool.usedPercent(home), 25);
    assert.equal(pool.observeLimits(join(root, "missing"), [{ name: "5h", usedPercent: 90 }]), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("waterfall drains the fullest account first, spread the emptiest, and neither crosses a priority", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const [a, b, c] = ["a", "b", "c"].map((id, index) => fixture(root, id, `token-${index}`));
    const readings = (pool) => {
      pool.observeQuota(a, meter({ fiveHour: 0.6 }));   // most spent
      pool.observeQuota(b, meter({ fiveHour: 0.3 }));
      pool.observeQuota(c, meter({ fiveHour: 0.05 }));  // barely touched
    };

    const spread = new MirasimProfilePool([a, b, c], { now: () => 10_000 });
    readings(spread);
    assert.equal(spread.mode(), "spread");
    // Most left first, so the pool drains evenly.
    assert.equal(spread.pick().id, "c");

    const waterfall = new MirasimProfilePool([a, b, c], { mode: "waterfall", now: () => 10_000 });
    readings(waterfall);
    // Least left first: the account already in use is finished before a fresh one is opened.
    assert.equal(waterfall.pick().id, "a");
    assert.equal(waterfall.pick().id, "a");

    // The meters say nothing under round-robin; it is least-recent use and nothing else.
    const roundRobin = new MirasimProfilePool([a, b, c], { mode: "roundRobin", now: () => 10_000 });
    readings(roundRobin);
    assert.deepEqual([roundRobin.pick().id, roundRobin.pick().id, roundRobin.pick().id], ["a", "b", "c"]);

    // Priority stays a hard constraint under every mode: the emptiest account in the bottom tier
    // never rises above a full one in the top tier.
    for (const mode of ["spread", "waterfall", "roundRobin"]) {
      const tiered = new MirasimProfilePool([a, b, c], { mode, now: () => 10_000 });
      readings(tiered);
      tiered.setPriority(a, 10);
      tiered.setPriority(b, 90);
      tiered.setPriority(c, 90);
      assert.notEqual(tiered.pick().id, "a", `${mode} must select the highest-priority tier first`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("priority remains first for conversation affinity and a fully cooling pool", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const [low, high] = ["low", "high"].map((id, index) => fixture(root, id, `token-${index}`));
    let now = 10_000;
    const pool = new MirasimProfilePool([low, high], { cooldownMs: 1_000, now: () => now });
    pool.setPriority(low, 10);
    pool.setPriority(high, 90);

    // Reusing a prompt cache is useful, but must not let a lower-priority account leapfrog one
    // that is currently available in the higher tier.
    assert.equal(pool.pick(new Set(), low).id, "high");

    // If every account is cooling, the next recovery time breaks ties only after priority.
    pool.failure({ home: low });
    now += 1;
    pool.failure({ home: high });
    assert.equal(pool.pick().id, "high");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every rotation mode keeps priority ahead of quota", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const [low, high] = ["low", "high"].map((id, index) => fixture(root, id, `token-${index}`));
    for (const mode of ["spread", "waterfall", "roundRobin"]) {
      const pool = new MirasimProfilePool([low, high], { mode, now: () => 10_000 });
      pool.setPriority(low, 10);
      pool.setPriority(high, 90);
      pool.observeQuota(low, meter({ fiveHour: 0 }));
      pool.observeQuota(high, meter({ fiveHour: 1 }));

      // Quota can choose only within the selected priority tier. A full high-priority account
      // must not be replaced by a lower-priority account just because the latter has more quota.
      assert.equal(pool.pick().id, "high", `${mode} must keep priority ahead of quota`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the rotation mode can be changed while the pool is running, and a name it does not know is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const [a, b] = ["a", "b"].map((id, index) => fixture(root, id, `token-${index}`));
    const pool = new MirasimProfilePool([a, b], { now: () => 10_000 });
    pool.observeQuota(a, meter({ fiveHour: 0.6 }));
    pool.observeQuota(b, meter({ fiveHour: 0.05 }));
    assert.equal(pool.pick().id, "b");

    assert.equal(pool.setMode("waterfall"), true);
    assert.equal(pool.pick().id, "a");

    // A mode the pool cannot place leaves it exactly where it was, rather than silently
    // reverting the rotation to the default.
    assert.equal(pool.setMode("greedy"), false);
    assert.equal(pool.setMode(""), false);
    assert.equal(pool.setMode(null), false);
    assert.equal(pool.mode(), "waterfall");
    // An unknown mode passed at construction falls back to the default rather than throwing.
    assert.equal(new MirasimProfilePool([a], { mode: "nonsense" }).mode(), "spread");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a request can retain its rotation mode while new picks use the operator's new mode", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const [a, b, c] = ["a", "b", "c"].map((id) => fixture(root, id, `token-${id}`));
    const pool = new MirasimProfilePool([a, b, c]);
    pool.observeQuota(a, meter({ fiveHour: 0.05 }));
    pool.observeQuota(b, meter({ fiveHour: 0.3 }));
    pool.observeQuota(c, meter({ fiveHour: 0.8 }));
    const mode = pool.mode();
    assert.equal(pool.pick(new Set(), null, mode).id, "a");
    pool.setMode("waterfall");
    assert.equal(pool.pick(new Set([a]), null, mode).id, "b");
    assert.equal(pool.pick().id, "c");
    assert.equal(pool.mode(), "waterfall");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a manually disabled profile leaves the rotation until it is re-enabled", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const first = fixture(root, "first", "token-a");
    const second = fixture(root, "second", "token-b");
    let now = 10_000;
    const pool = new MirasimProfilePool([first, second], { cooldownMs: 500, now: () => now });
    assert.equal(pool.disable(first), true);
    assert.equal(pool.status()[0].disabled, true);
    assert.equal(pool.status()[0].healthy, false);
    assert.equal(pool.pick().id, "second");
    assert.equal(pool.pick().id, "second");
    // Even when every other profile is cooling down, a disabled profile is never used as a fallback.
    pool.failure(pool.pick());
    assert.equal(pool.pick().id, "second");
    assert.equal(pool.enable(first), true);
    assert.equal(pool.status()[0].disabled, false);
    assert.equal(pool.status()[0].healthy, true);
    assert.equal(pool.disable(join(root, "missing")), false);
    assert.equal(pool.enable(join(root, "missing")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bulk recovery lifts every cooldown at once and leaves manually disabled accounts parked", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const homes = ["first", "second", "third"].map((id, index) => fixture(root, id, `token-${index}`));
    let now = 10_000;
    const pool = new MirasimProfilePool(homes, { cooldownMs: 30_000, now: () => now });
    // An upstream outage is what puts the whole pool under at once: three failures each, so every
    // account is deep enough into the backoff to be unusable for minutes.
    for (const home of homes) for (let i = 0; i < 3; i++) pool.failure({ home });
    assert.equal(pool.status().filter((entry) => entry.healthy).length, 0);
    pool.disable(homes[2]);

    assert.equal(pool.recoverAll(), 3);
    // Recovery clears the backoff itself, not just the wait: the next failure starts over at one
    // cooldown rather than resuming at eight.
    assert.equal(pool.status().filter((entry) => entry.healthy).length, 2);
    pool.failure({ home: homes[0] });
    assert.equal(pool.status()[0].cooldownUntil, now + 30_000);
    // The account an operator parked stays parked — bulk recovery undoes the pool's own penalty.
    assert.equal(pool.status()[2].disabled, true);
    assert.equal(pool.status()[2].healthy, false);

    // Nothing left to lift reports nothing, so the console can say so instead of claiming a fix.
    now += 30_001;
    assert.equal(pool.recoverAll(), 1);
    assert.equal(pool.recoverAll(), 0);
    assert.equal(pool.recover(join(root, "missing")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("increases cooldown after repeated failures and resets it on success", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const first = fixture(root, "first", "token-a");
    let now = 10_000;
    const pool = new MirasimProfilePool([first], { cooldownMs: 500, now: () => now });
    const profile = pool.pick();
    pool.failure(profile);
    now += 501;
    pool.failure(profile);
    now += 999;
    assert.equal(pool.status()[0].healthy, false);
    now += 1;
    assert.equal(pool.status()[0].healthy, true);
    pool.success(profile);
    pool.failure(profile);
    now += 501;
    assert.equal(pool.status()[0].healthy, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A legacy Mirasim token is a JWT whose payload carries the plan claim. A current "mrs1:" token
// is sealed instead, and gets its plan from observePlan; see the sealed-token test below.
function planToken(plan) {
  const payload = Buffer.from(JSON.stringify({ sub: "usr_test", exp: 4_102_444_800, plan })).toString("base64url");
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${payload}.signature`;
}

function sealedToken() {
  return `mrs1:${Buffer.from("sealed-bytes").toString("base64")}`;
}

test("a sealed token ranks by the plan the console read from Mirasim", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const free = fixture(root, "free", sealedToken());
    const paid = fixture(root, "paid", sealedToken());
    const pool = new MirasimProfilePool([free, paid]);

    // A sealed token carries no claims, so both accounts start out looking equally funded.
    assert.equal(pool.status()[0].plan, null);
    assert.equal(pool.status()[0].funded, true);

    pool.observePlan(free, "none");
    pool.observePlan(paid, "plus");
    const [freeStatus, paidStatus] = pool.status();
    assert.equal(freeStatus.plan, "none");
    assert.equal(freeStatus.funded, false);
    assert.equal(paidStatus.priority, 60);
    assert.equal(pool.pick().id, "paid");
    assert.equal(pool.pick().id, "paid");
    assert.equal(pool.pick(new Set([paid])).id, "free");

    // A plan Mirasim stops reporting must not linger as a stale ranking.
    pool.observePlan(free, "");
    assert.equal(pool.status()[0].funded, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rotation stays even after a request skips an account", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const first = fixture(root, "first", planToken("plus"));
    const second = fixture(root, "second", planToken("plus"));
    const third = fixture(root, "third", planToken("plus"));
    const pool = new MirasimProfilePool([first, second, third]);

    assert.equal(pool.pick().id, "first");
    // A retry that excludes the account it just used must not cost the skipped one its turn.
    assert.equal(pool.pick(new Set([first])).id, "second");
    assert.equal(pool.pick().id, "third");
    assert.equal(pool.pick().id, "first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a free account is the last resort of the rotation", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const free = fixture(root, "free", planToken("none"));
    const paid = fixture(root, "paid", planToken("plus"));
    const legacy = fixture(root, "legacy", "opaque-token-without-claims");
    let now = 10_000;
    const pool = new MirasimProfilePool([free, paid, legacy], { cooldownMs: 500, now: () => now });

    assert.equal(pool.pick().id, "paid");
    assert.equal(pool.pick().id, "paid");

    // The account without a plan claim ranks below MAX 10X, but still above any free account.
    pool.failure({ home: paid });
    assert.equal(pool.pick().id, "legacy");

    // A paid account that is merely cooling down still beats a free one that cannot be served.
    pool.failure({ home: legacy });
    assert.equal(pool.pick().id, "paid");

    // Only when no account with quota is left does the free one get the request.
    assert.equal(pool.pick(new Set([paid, legacy])).id, "free");

    const [freeStatus, , legacyStatus] = pool.status();
    assert.equal(freeStatus.plan, "none");
    assert.equal(freeStatus.funded, false);
    assert.equal(freeStatus.healthy, false);
    assert.equal(legacyStatus.funded, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a manual priority is served before the plan order", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const top = fixture(root, "top", planToken("max"));
    const first = fixture(root, "first", planToken("plus"));
    const second = fixture(root, "second", planToken("plus"));
    const pool = new MirasimProfilePool([top, first, second]);

    // Without an override the plan decides, so MAX 40X carries every request.
    assert.equal(pool.pick().id, "top");
    assert.equal(pool.pick().id, "top");

    // Promoted accounts take over and then take turns among themselves.
    assert.equal(pool.setPriority(first, 100), true);
    assert.equal(pool.setPriority(second, "100"), true);
    assert.equal(pool.pick().id, "first");
    assert.equal(pool.pick().id, "second");
    assert.equal(pool.pick().id, "first");

    const [topStatus, firstStatus] = pool.status();
    assert.equal(topStatus.priority, 80);
    assert.equal(topStatus.priorityOverride, null);
    assert.equal(firstStatus.priority, 100);
    assert.equal(firstStatus.priorityOverride, 100);

    // Clearing the override restores the plan order.
    pool.setPriority(first, null);
    pool.setPriority(second, "auto");
    assert.equal(pool.pick().id, "top");
    assert.equal(pool.status()[1].priority, 60);
    assert.equal(pool.setPriority(join(root, "missing"), 10), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a free account stays last even at the highest priority", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const free = fixture(root, "free", planToken("none"));
    const paid = fixture(root, "paid", planToken("plus"));
    const pool = new MirasimProfilePool([free, paid]);
    pool.setPriority(free, 100);
    pool.setPriority(paid, 0);

    assert.equal(pool.pick().id, "paid");
    assert.equal(pool.pick(new Set([paid])).id, "free");

    // Values outside the range are clamped instead of refused.
    pool.setPriority(paid, 1_000);
    assert.equal(pool.status()[1].priority, 100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fullMeter(fraction, resetSeconds) {
  return new Headers({
    "anthropic-ratelimit-unified-5h-utilization": String(fraction),
    "anthropic-ratelimit-unified-5h-reset": String(resetSeconds)
  });
}

test("a 429 with a full meter parks the account until its window resets, even when every account is parked", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const first = fixture(root, "first", "token-a");
    const second = fixture(root, "second", "token-b");
    let now = 1_000_000;
    const pool = new MirasimProfilePool([first, second], { cooldownMs: 500, now: () => now });
    const resetAt = Math.floor(now / 1000) + 3600;
    for (const id of ["first", "second"]) {
      const profile = pool.profile(id === "first" ? first : second);
      pool.observeQuota(profile.home, fullMeter(1, resetAt));
      assert.ok(pool.markLimited(profile) > 3_000_000);
      pool.failure(profile);
    }
    // Both accounts are cooling *and* parked: the forced last-resort attempt is gone too.
    assert.equal(pool.pick(), null);
    assert.equal(pool.hasCandidate(), false);
    assert.ok(pool.limitedRetryMs() > 3_000_000);
    assert.equal(pool.status().every((entry) => entry.healthy === false), true);
    // The window rolls over: both are served again without any manual recovery.
    now = (resetAt + 1) * 1000;
    assert.ok(pool.pick());
    assert.equal(pool.limitedRetryMs(), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a 429 whose meter has room is only the ordinary cooldown, and fresh headroom releases a parked account", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-2api-"));
  try {
    const only = fixture(root, "only", "token-a");
    let now = 2_000_000;
    const pool = new MirasimProfilePool([only], { cooldownMs: 500, now: () => now });
    const resetAt = Math.floor(now / 1000) + 3600;
    const profile = pool.profile(only);
    pool.observeQuota(only, fullMeter(0.4, resetAt));
    assert.equal(pool.markLimited(profile), 0, "a model-scoped refusal must not park the account");
    assert.ok(pool.pick());

    pool.observeQuota(only, fullMeter(1, resetAt));
    assert.ok(pool.markLimited(profile) > 0);
    assert.equal(pool.pick(), null);
    // The console's /v1/limits poll sees the account recovered (e.g. a reset card was used).
    pool.observeLimits(only, [{ name: "5h", usedPercent: 3, resetAt: new Date(now + 5 * 3600_000).toISOString() }]);
    assert.ok(pool.pick());

    pool.observeQuota(only, fullMeter(1, resetAt));
    pool.markLimited(profile);
    assert.equal(pool.pick(), null);
    assert.equal(pool.recover(only), true);
    assert.ok(pool.pick());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
