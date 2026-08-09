import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MirasimDashboard, RelayUsageLedger } from "../src/dashboard.js";
import { MirasimProfilePool } from "../src/pool.js";
import { StateDatabase } from "../src/database.js";

function jwt(exp, claims = {}) {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp, sub: "user-a", ...claims })).toString("base64url")}.signature`;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "mirasim-dashboard-"));
  const home = join(root, "account-a");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "setting.json"), JSON.stringify({
    auth: { userId: "user-a", token: jwt(4_102_444_800), refreshToken: "refresh-a", exp: 4_102_444_800 }
  }));
  const config = { homes: [home], relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test", cooldownMs: 30_000 };
  return { root, home, config, pool: new MirasimProfilePool([home]), usage: new RelayUsageLedger() };
}

test("dashboard reads current referral activity and relay usage without returning a token", async () => {
  const fixture = setup();
  try {
    fixture.usage.record({ home: fixture.home }, { status: 200, headers: new Headers({ "x-litellm-call-id": "call-1" }) });
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url, options = {}) => {
        if (url.pathname === "/auth/me") {
          assert.equal(url.origin, "https://login.example.test");
          return json({ name: "Relay User", email: "user@example.test", plan: "Team", tenant: "workspace-a" });
        }
        if (url.pathname === "/auth/referral") return json({
          code: "INVITE-123", redeemed: 2, threshold: 5, remaining: 3, reached: false,
          max_redemptions: 10, current_plan: "Starter", next_plan: "Pro"
        });
        if (url.pathname === "/usage/calls") {
          assert.equal(url.origin, "https://relay.example.test");
          assert.equal(options.headers.Authorization.startsWith("Bearer "), true);
          return json({ calls: [{ id: "call-1", input: 120, output: 45, cacheRead: 10, cacheWrite: 5 }] });
        }
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    const snapshot = await dashboard.snapshot();
    const account = snapshot.accounts[0];
    assert.equal(account.identity.name, "Relay User");
    assert.equal(account.identity.accountType, "Team");
    assert.equal(account.identity.tenant, "workspace-a");
    assert.deepEqual(account.referral, {
      code: "INVITE-123", redeemed: 2, threshold: 5, remaining: 3, reached: false,
      maxRedemptions: 10, currentPlan: "Starter", nextPlan: "Pro"
    });
    assert.equal(account.quota.inputTokens, 120);
    assert.equal(account.quota.outputTokens, 45);
    assert.equal(JSON.stringify(snapshot).includes("signature"), false);
    assert.equal(JSON.stringify(snapshot).includes("refresh-a"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dashboard normalizes nested and camel-case referral activity fields", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => {
        if (url.pathname === "/auth/me") return json({ name: "Relay User", email: "user@example.test" });
        if (url.pathname === "/auth/referral") return json({
          data: {
            referralCode: "REF-42",
            redemption_count: 2,
            invite_threshold: 4,
            maxRedemptions: 7,
            membership: { plan: "Pro", nextPlan: "Enterprise" }
          }
        });
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    const referral = (await dashboard.snapshot()).accounts[0].referral;
    assert.deepEqual(referral, {
      code: "REF-42", redeemed: 2, threshold: 4, remaining: 5, reached: false,
      maxRedemptions: 7, currentPlan: "Pro", nextPlan: "Enterprise"
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dashboard normalizes membership and campaign activity envelopes", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => {
        if (url.pathname === "/auth/me") return json({ email: "user@example.test" });
        if (url.pathname === "/auth/referral") return json({ result: {
          invite: {
            referral_code: "CAMPAIGN-7",
            membership: { plan_name: "Plus", next_plan_name: "Pro" },
            campaign: { used: 3, total: 8, remaining: 5, target: 6 }
          }
        } });
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    assert.deepEqual((await dashboard.snapshot()).accounts[0].referral, {
      code: "CAMPAIGN-7", redeemed: 3, threshold: 6, remaining: 5, reached: false,
      maxRedemptions: 8, currentPlan: "Plus", nextPlan: "Pro"
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dashboard maps current auth roles to an account type", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => url.pathname === "/auth/me"
        ? json({ email: "user@example.test", roles: ["user"] })
        : json({ detail: "Not Found" }, 404)
    });
    assert.equal((await dashboard.snapshot()).accounts[0].identity.accountType, "普通用户");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dashboard reads Plus and Max account types from official subscription fields", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => {
        if (url.pathname === "/auth/me") return json({ email: "user@example.test", subscription: { tier: "max" } });
        return json({ data: { membership: { plan: "Plus" } } });
      }
    });
    const account = (await dashboard.snapshot()).accounts[0];
    assert.equal(account.identity.accountType, "max");
    assert.equal(account.referral.currentPlan, "Plus");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dashboard uses the signed-in token plan when auth/me only returns a user role", async () => {
  const fixture = setup();
  try {
    const setting = JSON.parse(readFileSync(join(fixture.home, "setting.json"), "utf8"));
    setting.auth.token = jwt(4_102_444_800, { plan: "max" });
    writeFileSync(join(fixture.home, "setting.json"), JSON.stringify(setting));
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => url.pathname === "/auth/me"
        ? json({ email: "user@example.test", roles: ["user"] })
        : json({ detail: "Not Found" }, 404)
    });
    assert.equal((await dashboard.snapshot()).accounts[0].identity.accountType, "max");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a locally retained account is restored to the round-robin pool only on manual request", async () => {
  const fixture = setup();
  try {
    const restoredHome = join(fixture.root, "account-restored");
    mkdirSync(restoredHome, { recursive: true });
    writeFileSync(join(restoredHome, "setting.json"), JSON.stringify({
      auth: { userId: "user-restored", token: jwt(4_102_444_800, { sub: "user-restored" }), refreshToken: "refresh-restored", exp: 4_102_444_800 }
    }));
    fixture.config.accountRoot = fixture.root;
    const database = new StateDatabase(join(fixture.root, "state.sqlite"), { seedHomes: [fixture.home] });
    const refreshed = [];
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      database,
      sessionRefresher: { async refreshAll(homes) { refreshed.push(...homes); } }
    });

    assert.deepEqual(await dashboard.restoreAccounts(), { restored: 1, accounts: ["account-2"] });
    assert.deepEqual(database.homes(), [fixture.home, restoredHome]);
    assert.deepEqual(fixture.pool.homes(), [fixture.home, restoredHome]);
    assert.deepEqual(refreshed, [restoredHome]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("manual account renewal delegates to the session refresher for the selected pool account", async () => {
  const fixture = setup();
  try {
    const renewedHomes = [];
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      sessionRefresher: { async refreshNow(home) { renewedHomes.push(home); return true; } }
    });
    assert.deepEqual(await dashboard.renewAccount("account-1"), { renewed: true });
    assert.deepEqual(renewedHomes, [fixture.home]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("redeeming an invite refreshes the local Mirasim auth profile", async () => {
  const fixture = setup();
  try {
    const refreshed = jwt(4_102_444_900);
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url, options = {}) => {
        if (url.pathname === "/auth/referral") return json({ code: "OTHER-INVITE" });
        assert.equal(url.pathname, "/auth/invite/redeem");
        assert.equal(url.origin, "https://login.example.test");
        assert.equal(options.method, "POST");
        assert.deepEqual(JSON.parse(options.body), { code: "INVITE-123" });
        return json({ access_token: refreshed, refresh_token: "refresh-b" });
      }
    });

    assert.deepEqual(await dashboard.redeemInvite("account-1", "  INVITE-123  "), { updated: true });
    const setting = JSON.parse(readFileSync(join(fixture.home, "setting.json"), "utf8"));
    assert.equal(setting.auth.token, refreshed);
    assert.equal(setting.auth.refreshToken, "refresh-b");
    assert.equal(setting.auth.exp, 4_102_444_900);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("redeeming the current account's invite is rejected before calling Mirasim", async () => {
  const fixture = setup();
  try {
    let redeemCalled = false;
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => {
        if (url.pathname === "/auth/referral") return json({ code: "OWN-INVITE" });
        if (url.pathname === "/auth/invite/redeem") redeemCalled = true;
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    await assert.rejects(
      dashboard.redeemInvite("account-1", "OWN-INVITE"),
      (error) => error.statusCode === 400 && error.message === "不能兑换当前账号的邀请码。"
    );
    assert.equal(redeemCalled, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("redeeming an invite returns the official rejection detail", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => {
        if (url.pathname === "/auth/referral") return json({ code: "OWN-INVITE" });
        if (url.pathname === "/auth/invite/redeem") return json({ error: { message: "邀请码已被兑换。" } }, 400);
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    await assert.rejects(
      dashboard.redeemInvite("account-1", "USED-INVITE"),
      (error) => error.statusCode === 400 && error.message === "邀请码已被兑换。"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("email login uses Mirasim auth endpoints and creates a new local profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-dashboard-login-"));
  const home = join(root, "account-a");
  const config = { homes: [home], relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test", cooldownMs: 30_000 };
  const pool = new MirasimProfilePool([home]);
  const usage = new RelayUsageLedger();
  try {
    const dashboard = new MirasimDashboard(config, pool, usage, {
      fetchImpl: async (url, options = {}) => {
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(url.origin, "https://login.example.test");
        if (url.pathname === "/auth/code") {
          assert.deepEqual(JSON.parse(options.body), { email: "user@example.test" });
          return json({ dev_code: "123456" });
        }
        if (url.pathname === "/auth/verify") {
          assert.deepEqual(JSON.parse(options.body), { email: "user@example.test", code: "123456" });
          return json({ access_token: jwt(4_102_444_900), refresh_token: "refresh-new" });
        }
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    assert.deepEqual(await dashboard.requestLoginCode("account-1", " User@Example.Test "), { sent: true, devCode: "123456" });
    assert.deepEqual(await dashboard.verifyLoginCode("account-1", "user@example.test", "123456"), { updated: true });
    const setting = JSON.parse(readFileSync(join(home, "setting.json"), "utf8"));
    assert.equal(setting.auth.userId, "user-a");
    assert.equal(setting.auth.refreshToken, "refresh-new");
    assert.equal(setting.auth.token, jwt(4_102_444_900));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new login creates a persistent pool account and rolls it back when code delivery fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-dashboard-new-account-"));
  const database = new StateDatabase(join(root, "state.sqlite"));
  const config = { homes: [], accountRoot: join(root, "profiles"), relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test" };
  const pool = new MirasimProfilePool([]);
  try {
    const failing = new MirasimDashboard(config, pool, new RelayUsageLedger(), {
      database,
      fetchImpl: async () => json({ message: "发送失败" }, 503)
    });
    await assert.rejects(failing.requestLoginCode("new", "user@example.test"));
    assert.deepEqual(database.homes(), []);
    assert.deepEqual(pool.homes(), []);

    const working = new MirasimDashboard(config, pool, new RelayUsageLedger(), {
      database,
      fetchImpl: async () => json({})
    });
    const result = await working.requestLoginCode("new", "user@example.test");
    assert.equal(result.account, "account-1");
    assert.equal(database.homes().length, 1);
    assert.deepEqual(pool.homes(), database.homes());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MoeMail signup redeems before making the account available in the pool", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-dashboard-moemail-"));
  const database = new StateDatabase(join(root, "state.sqlite"));
  const config = { homes: [], accountRoot: join(root, "profiles"), relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test" };
  const pool = new MirasimProfilePool([]);
  let deletedMailbox = null;
  try {
    const dashboard = new MirasimDashboard(config, pool, new RelayUsageLedger(), {
      database,
      moemail: {
        isConfigured: () => true,
        createMailbox: async () => ({ id: "mail-1", email: "new@example.test" }),
        waitForVerificationCode: async () => "123456",
        deleteMailbox: async (mailbox) => { deletedMailbox = mailbox.id; }
      },
      fetchImpl: async (url, options = {}) => {
        if (url.pathname === "/auth/code") {
          assert.deepEqual(JSON.parse(options.body), { email: "new@example.test" });
          return json({});
        }
        if (url.pathname === "/auth/verify") {
          assert.equal(database.homes().length, 0);
          assert.deepEqual(JSON.parse(options.body), { email: "new@example.test", code: "123456" });
          return json({ access_token: jwt(4_102_444_900), refresh_token: "refresh-new" });
        }
        if (url.pathname === "/auth/referral") return json({ code: "OTHER-INVITE" });
        if (url.pathname === "/auth/invite/redeem") {
          assert.equal(database.homes().length, 0);
          assert.deepEqual(JSON.parse(options.body), { code: "INVITE-123" });
          return json({ access_token: jwt(4_102_445_000), refresh_token: "refresh-redeemed" });
        }
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    assert.deepEqual(await dashboard.registerWithMoeMail("INVITE-123"), {
      account: "account-1", email: "new@example.test", redeemed: true
    });
    assert.equal(database.homes().length, 1);
    assert.deepEqual(pool.homes(), database.homes());
    assert.equal(deletedMailbox, "mail-1");
    const setting = JSON.parse(readFileSync(join(database.homes()[0], "setting.json"), "utf8"));
    assert.equal(setting.auth.token, jwt(4_102_445_000));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MoeMail configuration can be saved from the console without exposing its API key", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-dashboard-moemail-config-"));
  try {
    const database = new StateDatabase(join(root, "state.sqlite"));
    const config = {
      homes: [], accountRoot: join(root, "profiles"), relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test",
      moemail: { url: "", apiKey: "", domain: "", expiryTimeMs: 3_600_000, codeTimeoutMs: 120_000, pollMs: 2_500 },
      webAuth: { password: "console-password" }
    };
    const dashboard = new MirasimDashboard(config, new MirasimProfilePool([]), new RelayUsageLedger(), { database });
    assert.deepEqual(dashboard.configureMoeMail({
      url: "https://mail.example.test/", domain: "MAIL.EXAMPLE.TEST", apiKey: "private-mail-key"
    }), { configured: true, url: "https://mail.example.test", domain: "mail.example.test" });
    const reloaded = new MirasimDashboard({ ...config, moemail: { ...config.moemail, url: "", apiKey: "", domain: "" } }, new MirasimProfilePool([]), new RelayUsageLedger(), { database });
    assert.deepEqual(reloaded.moeMailSettings(), { configured: true, url: "https://mail.example.test", domain: "mail.example.test" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MoeMail batch registration runs sequentially and stops at the first failure", async () => {
  const config = { homes: [], relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test" };
  const dashboard = new MirasimDashboard(config, new MirasimProfilePool([]), new RelayUsageLedger());
  let calls = 0;
  dashboard.registerWithMoeMail = async () => {
    calls += 1;
    if (calls === 2) throw new Error("上游请求过于频繁。");
    return { account: `account-${calls}`, email: `user-${calls}@example.test`, redeemed: true };
  };

  assert.deepEqual(await dashboard.registerMoeMailBatch("INVITE-123", 4), {
    requested: 4,
    completed: 1,
    accounts: [{ account: "account-1", email: "user-1@example.test", redeemed: true }],
    stopped: true,
    error: "上游请求过于频繁。"
  });
  assert.equal(calls, 2);
  await assert.rejects(dashboard.registerMoeMailBatch("INVITE-123", 0), (error) => error.statusCode === 400);
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
