import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MirasimSessionRefresher } from "../src/session-refresh.js";
import { readProfile } from "../src/pool.js";

function jwt(exp, sub = "user-a") {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp, sub })).toString("base64url")}.signature`;
}

test("refreshes an expired Mirasim profile through the official refresh endpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-refresh-"));
  const home = join(root, "account-a");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "setting.json"), JSON.stringify({
    auth: { userId: "user-a", token: jwt(1), refreshToken: "refresh-old", exp: 1 }
  }));
  chmodSync(join(home, "setting.json"), 0o644);
  const now = 1_725_000_000_000;
  try {
    const refresher = new MirasimSessionRefresher({ loginUrl: "https://login.example.test" }, {
      now: () => now,
      fetchImpl: async (url, options) => {
        assert.equal(url.href, "https://login.example.test/auth/refresh");
        assert.equal(options.method, "POST");
        assert.deepEqual(JSON.parse(options.body), { refresh_token: "refresh-old" });
        return json({ access_token: jwt(1_900_000_000, "user-refreshed"), refresh_token: "refresh-new" });
      }
    });
    assert.equal(await refresher.refreshIfNeeded(home), true);
    const setting = JSON.parse(readFileSync(join(home, "setting.json"), "utf8"));
    assert.equal(setting.auth.userId, "user-refreshed");
    assert.equal(setting.auth.refreshToken, "refresh-new");
    assert.equal(statSync(join(home, "setting.json")).mode & 0o777, 0o600);
    assert.equal(readProfile(home).id, "user-refreshed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps an expired profile unchanged when Mirasim rejects its refresh token", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-refresh-"));
  const home = join(root, "account-a");
  mkdirSync(home, { recursive: true });
  const initial = { auth: { userId: "user-a", token: jwt(1), refreshToken: "refresh-old", exp: 1 } };
  writeFileSync(join(home, "setting.json"), JSON.stringify(initial));
  try {
    const refresher = new MirasimSessionRefresher({ loginUrl: "https://login.example.test" }, {
      now: () => 1_725_000_000_000,
      fetchImpl: async () => json({ detail: "invalid refresh token" }, 401)
    });
    assert.equal(await refresher.refreshIfNeeded(home), false);
    assert.deepEqual(JSON.parse(readFileSync(join(home, "setting.json"), "utf8")), initial);
    assert.match(refresher.failureReason(home), /invalid refresh token/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manually refreshes a profile even when its current token is not near expiry", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-refresh-"));
  const home = join(root, "account-a");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "setting.json"), JSON.stringify({
    auth: { userId: "user-a", token: jwt(1_900_000_000), refreshToken: "refresh-old", exp: 1_900_000_000 }
  }));
  try {
    const refresher = new MirasimSessionRefresher({ loginUrl: "https://login.example.test" }, {
      now: () => 1_725_000_000_000,
      fetchImpl: async () => json({ access_token: jwt(1_950_000_000, "user-renewed"), refresh_token: "refresh-new" })
    });
    assert.equal(await refresher.refreshNow(home), true);
    const setting = JSON.parse(readFileSync(join(home, "setting.json"), "utf8"));
    assert.equal(setting.auth.userId, "user-renewed");
    assert.equal(setting.auth.refreshToken, "refresh-new");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("request readiness avoids rescanning a ready pool for every background refresh", async () => {
  const refresher = new MirasimSessionRefresher({ loginUrl: "https://login.example.test" });
  const pending = Promise.withResolvers();
  let checks = 0;
  let refreshes = 0;
  refresher.refreshIfNeeded = async () => {
    refreshes += 1;
    return pending.promise;
  };
  const homes = Array.from({ length: 80 }, (_, index) => `account-${index}`);
  try {
    await refresher.refreshUntilReady(homes, () => {
      checks += 1;
      return true;
    });
    assert.equal(refreshes, homes.length);
    assert.equal(checks, 1);
  } finally {
    pending.resolve(true);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(checks, 1);
});

test("background renewal follows current homes and stops with its lifecycle", (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const config = { homes: ["account-a"] };
  const refresher = new MirasimSessionRefresher(config);
  const batches = [];
  refresher.refreshInBackground = (homes) => batches.push([...homes]);
  refresher.start();
  refresher.start();
  context.mock.timers.tick(60_000);
  config.homes = ["account-b"];
  context.mock.timers.tick(60_000);
  refresher.stop();
  context.mock.timers.tick(60_000);
  assert.deepEqual(batches, [["account-a"], ["account-b"]]);
});

test("request timeout leaves renewal running for subsequent requests", async () => {
  const refresher = new MirasimSessionRefresher({});
  const pending = Promise.withResolvers();
  let available = false;
  refresher.refreshIfNeeded = async () => {
    await pending.promise;
    available = true;
    return true;
  };
  try {
    await refresher.refreshUntilReady(["account-a"], () => available);
    assert.equal(available, false);
  } finally {
    pending.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(available, true);
});
