import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MirasimProfilePool } from "../src/pool.js";

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
