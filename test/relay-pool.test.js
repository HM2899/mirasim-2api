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
