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
          max_redemptions: 10, current_plan: "basic", next_plan: "plus"
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
      maxRedemptions: 10, currentPlan: "basic", nextPlan: "plus", rewardPlan: "plus", needed: 3
    });
    assert.equal(account.quota.inputTokens, 120);
    assert.equal(account.quota.outputTokens, 45);
    assert.equal(JSON.stringify(snapshot).includes("signature"), false);
    assert.equal(JSON.stringify(snapshot).includes("refresh-a"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a manual rotation priority is persisted and applied to the pool", () => {
  const fixture = setup();
  try {
    const database = new StateDatabase(join(fixture.root, "state.sqlite"), { seedHomes: [fixture.home] });
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, { fetchImpl: async () => json({}), database });

    assert.deepEqual(dashboard.setAccountPriority("account-1", 75), { updated: true, priority: 75, priorityOverride: 75 });
    assert.equal(fixture.pool.status()[0].priority, 75);
    assert.deepEqual(database.homePriorities(), [{ home: fixture.home, priority: 75 }]);

    // A restart reads the stored priority back into a fresh pool.
    const restarted = new MirasimProfilePool([fixture.home]);
    for (const { home, priority } of database.homePriorities()) restarted.setPriority(home, priority);
    assert.equal(restarted.status()[0].priority, 75);

    // Clearing it returns the account to the plan order, which a token without a plan claim
    // reports as the default rank.
    assert.deepEqual(dashboard.setAccountPriority("account-1", null), { updated: true, priority: 40, priorityOverride: null });
    assert.deepEqual(database.homePriorities(), []);
    assert.throws(() => dashboard.setAccountPriority("account-1", "urgent"), /优先级需为 0-100 的整数/);
    assert.throws(() => dashboard.setAccountPriority("account-9", 10), /未找到所选账号/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a free account is reported as having no relay quota", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-dashboard-"));
  try {
    const home = join(root, "account-free");
    mkdirSync(home, { recursive: true });
    // A current token is sealed, so "none" can only reach the pool through /auth/me below.
    const token = `mrs1:${Buffer.from("sealed-bytes").toString("base64")}`;
    writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: "user-free", token, exp: 4_102_444_800 } }));
    const config = { homes: [home], relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test", cooldownMs: 30_000 };
    const paths = [];
    const dashboard = new MirasimDashboard(config, new MirasimProfilePool([home]), new RelayUsageLedger(), {
      fetchImpl: async (url) => {
        paths.push(url.pathname);
        if (url.pathname === "/auth/me") return json({ email: "free@example.test", plan: "none" });
        if (url.pathname === "/auth/referral") return json({ code: null, threshold: 3, next_plan: "basic" });
        if (url.pathname === "/usage/calls") return json({ calls: [] });
        // Mirasim answers a free account with a 7d budget the relay then refuses to honour.
        if (url.pathname === "/v1/limits") return json({ windows: [{ name: "7d", used: 0, budget: 11_667 }] });
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    const account = (await dashboard.snapshot()).accounts[0];
    assert.equal(account.quota.availability, "no_quota");
    assert.deepEqual(account.quota.windows, []);
    assert.equal(paths.includes("/v1/limits"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manually disabling an account persists it out of the rotation until recovery", () => {
  const fixture = setup();
  try {
    const database = new StateDatabase(join(fixture.root, "state.sqlite"), { seedHomes: [fixture.home] });
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, { fetchImpl: async () => json({}), database });
    assert.deepEqual(dashboard.disableAccount("account-1"), { disabled: true });
    assert.equal(fixture.pool.status()[0].disabled, true);
    assert.equal(fixture.pool.status()[0].healthy, false);
    assert.equal(fixture.pool.pick(), null);
    assert.deepEqual(database.disabledHomes(), [fixture.home]);
    assert.throws(() => dashboard.disableAccount("account-9"), /未找到所选账号/);
    assert.deepEqual(dashboard.recoverAccount("account-1"), { recovered: true });
    assert.equal(fixture.pool.status()[0].disabled, false);
    assert.equal(fixture.pool.status()[0].healthy, true);
    assert.deepEqual(database.disabledHomes(), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("usage totals persist across ledger instances and do not double count relay call IDs", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-usage-ledger-"));
  try {
    const home = join(root, "account-a");
    const database = new StateDatabase(join(root, "state.sqlite"));
    const first = new RelayUsageLedger(database);
    first.record({ home }, { status: 200, headers: new Headers({ "x-litellm-call-id": "call-1" }) });
    first.recordCallUsage(home, [{ id: "call-1", input: 120, output: 45, cacheRead: 10, cacheWrite: 5 }]);
    first.recordCallUsage(home, [{ id: "call-1", input: 120, output: 45, cacheRead: 10, cacheWrite: 5 }]);

    const restored = new RelayUsageLedger(new StateDatabase(join(root, "state.sqlite"))).snapshot(home);
    assert.deepEqual({ requests: restored.requests, input: restored.inputTokens, output: restored.outputTokens, cacheRead: restored.cacheReadTokens, cacheWrite: restored.cacheWriteTokens }, {
      requests: 1, input: 120, output: 45, cacheRead: 10, cacheWrite: 5
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("referral counters default to zero and no reward is derived without a threshold", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => {
        if (url.pathname === "/auth/me") return json({ name: "Relay User", email: "user@example.test" });
        if (url.pathname === "/auth/referral") return json({ code: null, current_plan: "none", next_plan: null });
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    assert.deepEqual((await dashboard.snapshot()).accounts[0].referral, {
      code: null, redeemed: 0, threshold: 0, remaining: 0, reached: false,
      maxRedemptions: 0, currentPlan: "none", nextPlan: null, rewardPlan: null, needed: 0
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a reached invite threshold rewards the current tier when Mirasim reports no next tier", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => {
        if (url.pathname === "/auth/me") return json({ email: "user@example.test" });
        if (url.pathname === "/auth/referral") return json({
          code: "REF-42", redeemed: 6, threshold: 5, remaining: 4, reached: true,
          max_redemptions: 10, current_plan: "max", next_plan: null
        });
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    const referral = (await dashboard.snapshot()).accounts[0].referral;
    assert.equal(referral.rewardPlan, "max");
    assert.equal(referral.needed, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the subscription end date is read from plan_exp and kept to the exact year", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      // /auth/me reports the subscription end in whole seconds.
      fetchImpl: async (url) => url.pathname === "/auth/me"
        ? json({ email: "user@example.test", plan: "max", plan_exp: 1_804_161_600 })
        : json({ detail: "Not Found" }, 404)
    });
    assert.equal((await dashboard.snapshot()).accounts[0].identity.subscriptionExpiresAt, "2027-03-04T12:00:00.000Z");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an account Mirasim reports as never expiring carries no subscription end date", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => url.pathname === "/auth/me"
        ? json({ email: "user@example.test", plan: "none", plan_exp: null })
        : json({ detail: "Not Found" }, 404)
    });
    assert.equal((await dashboard.snapshot()).accounts[0].identity.subscriptionExpiresAt, null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a sealed mrs1 token yields no claims, so the subscription end comes from auth/me alone", async () => {
  const fixture = setup();
  try {
    // Current tokens are AES-GCM blobs behind an OS keychain key, not decodable claim payloads.
    writeFileSync(join(fixture.home, "setting.json"), JSON.stringify({
      auth: { userId: "user-a", token: `mrs1:${Buffer.from("sealed-bytes").toString("base64")}`, refreshToken: "refresh-a", exp: 4_102_444_800 }
    }));
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => url.pathname === "/auth/me"
        ? json({ email: "user@example.test", plan: "max", plan_exp: 1_804_161_600 })
        : json({ detail: "Not Found" }, 404)
    });
    assert.equal((await dashboard.snapshot()).accounts[0].identity.subscriptionExpiresAt, "2027-03-04T12:00:00.000Z");
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
        return json({ current_plan: "plus", next_plan: "max" });
      }
    });
    const account = (await dashboard.snapshot()).accounts[0];
    assert.equal(account.identity.accountType, "max");
    assert.equal(account.referral.currentPlan, "plus");
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

test("restoring local accounts skips duplicate identities", async () => {
  const fixture = setup();
  try {
    fixture.config.accountRoot = fixture.root;
    for (const [name, id] of [["account-duplicate", "user-a"], ["account-new", "user-new"], ["account-new-copy", "user-new"]]) {
      const home = join(fixture.root, name);
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: id, token: jwt(4_102_444_800, { sub: id }) } }));
    }
    const database = new StateDatabase(join(fixture.root, "state.sqlite"), { seedHomes: [fixture.home] });
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, { database });
    assert.deepEqual((await dashboard.restoreAccounts()).restored, 1);
    assert.equal(fixture.pool.homes().length, 2);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
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

    assert.deepEqual(await dashboard.redeemInvite("account-1", "  INVITE-123  "), { updated: true, kind: "invite" });
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

test("an MLIC licence is previewed and redeemed through the licence endpoints", async () => {
  const fixture = setup();
  try {
    const refreshed = jwt(4_102_444_900);
    const paths = [];
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url, options = {}) => {
        paths.push(url.pathname);
        assert.deepEqual(JSON.parse(options.body), { code: "MLIC-ABCD-1234" });
        if (url.pathname === "/auth/license/preview") {
          return json({ verdict: "redeemable", action: "upgrade", plan: "max", duration_days: 30 });
        }
        if (url.pathname === "/auth/license/redeem") return json({ access_token: refreshed, refresh_token: "refresh-b" });
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    assert.deepEqual(await dashboard.redeemInvite("account-1", " MLIC-ABCD-1234 "), {
      updated: true, kind: "license", verdict: "redeemable", action: "upgrade",
      plan: "max", durationDays: 30, planExpiresAt: null, retryAfter: null
    });
    // The self-invite guard is a referral rule, so a licence never reads /auth/referral.
    assert.deepEqual(paths, ["/auth/license/preview", "/auth/license/redeem"]);
    assert.equal(JSON.parse(readFileSync(join(fixture.home, "setting.json"), "utf8")).auth.token, refreshed);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a licence below the current tier is refused without being consumed", async () => {
  const fixture = setup();
  try {
    let redeemCalled = false;
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => {
        if (url.pathname === "/auth/license/preview") return json({ verdict: "blocked_lower_tier", plan: "basic" });
        if (url.pathname === "/auth/license/redeem") redeemCalled = true;
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    await assert.rejects(
      dashboard.redeemInvite("account-1", "mlic_lower_tier"),
      (error) => error.statusCode === 409 && error.message.includes("MAX 2X")
    );
    assert.equal(redeemCalled, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("previewing reports the licence verdict and leaves plain invite codes to the redeem call", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => {
        if (url.pathname === "/auth/license/preview") {
          return json({ verdict: "already_redeemed", plan: "plus", plan_expires_at: "2026-09-01T00:00:00.000Z" });
        }
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    assert.deepEqual(await dashboard.previewRedeemCode("account-1", "MLIC0001"), {
      kind: "license", supported: true, verdict: "already_redeemed", action: null,
      plan: "plus", durationDays: null, planExpiresAt: "2026-09-01T00:00:00.000Z", retryAfter: null
    });
    assert.deepEqual(await dashboard.previewRedeemCode("account-1", "INVITE-123"), { kind: "invite", supported: false });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a throttled redemption reports the official cooldown", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => {
        if (url.pathname === "/auth/referral") return json({ code: "OWN-INVITE" });
        if (url.pathname === "/auth/invite/redeem") return json({ retry_after: 12.4 }, 429);
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    await assert.rejects(
      dashboard.redeemInvite("account-1", "OTHER-INVITE"),
      (error) => error.statusCode === 429 && error.message === "邀请码未能兑换：请求过于频繁，请 13 秒后重试。"
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
    assert.deepEqual(await dashboard.verifyLoginCode("account-1", "user@example.test", "123456"), { updated: true, refreshed: false });
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
    }), { configured: true, url: "https://mail.example.test", domain: "mail.example.test", domains: ["mail.example.test"] });
    const reloaded = new MirasimDashboard({ ...config, moemail: { ...config.moemail, url: "", apiKey: "", domain: "" } }, new MirasimProfilePool([]), new RelayUsageLedger(), { database });
    assert.deepEqual(reloaded.moeMailSettings(), { configured: true, url: "https://mail.example.test", domain: "mail.example.test", domains: ["mail.example.test"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blank MoeMail invite code uses an available Max account referral", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-dashboard-moemail-max-"));
  const maxHome = join(root, "max-account");
  mkdirSync(maxHome, { recursive: true });
  writeFileSync(join(maxHome, "setting.json"), JSON.stringify({ auth: { userId: "max-user", token: jwt(4_102_444_800, { plan: "MAX" }), refreshToken: "refresh-max", exp: 4_102_444_800 } }));
  const database = new StateDatabase(join(root, "state.sqlite"), { seedHomes: [maxHome] });
  const config = { homes: [maxHome], accountRoot: join(root, "profiles"), relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test" };
  let referralRequests = 0;
  try {
    const dashboard = new MirasimDashboard(config, new MirasimProfilePool([maxHome]), new RelayUsageLedger(), {
      database,
      moemail: { isConfigured: () => true, createMailbox: async () => ({ id: "mail-1", email: "new@example.test" }), waitForVerificationCode: async () => "123456", deleteMailbox: async () => {} },
      fetchImpl: async (url, options = {}) => {
        if (url.pathname === "/auth/referral") {
          return json(referralRequests++ === 0
            ? { code: "MAX-INVITE", current_plan: "MAX" }
            : { code: "NEW-ACCOUNT-INVITE" });
        }
        if (url.pathname === "/auth/code") return json({});
        if (url.pathname === "/auth/verify") return json({ access_token: jwt(4_102_444_900), refresh_token: "refresh-new" });
        if (url.pathname === "/auth/invite/redeem") {
          assert.deepEqual(JSON.parse(options.body), { code: "MAX-INVITE" });
          return json({ access_token: jwt(4_102_445_000), refresh_token: "refresh-redeemed" });
        }
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });
    assert.equal((await dashboard.registerMoeMailBatch("", 1)).accounts[0].redeemed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registration picks the highest tier account whose invite code still has redemptions left", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-dashboard-invite-pick-"));
  const subjects = ["max-user", "plus-user", "basic-user"];
  const homes = subjects.map((subject) => {
    const home = join(root, subject);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "setting.json"), JSON.stringify({
      auth: { userId: subject, token: jwt(4_102_444_800, { sub: subject }), refreshToken: `refresh-${subject}`, exp: 4_102_444_800 }
    }));
    return home;
  });
  const database = new StateDatabase(join(root, "state.sqlite"), { seedHomes: homes });
  const config = { homes, accountRoot: join(root, "profiles"), relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test" };
  const referrals = {
    // The strongest account has already spent every redemption of its own code.
    "max-user": { code: "MAX-INVITE", current_plan: "max", max_redemptions: 10, remaining: 0 },
    "plus-user": { code: "PLUS-INVITE", current_plan: "plus", max_redemptions: 10, remaining: 4 },
    "basic-user": { code: "BASIC-INVITE", current_plan: "basic", max_redemptions: 10, remaining: 9 }
  };
  try {
    const dashboard = new MirasimDashboard(config, new MirasimProfilePool(homes), new RelayUsageLedger(), {
      database,
      moemail: { isConfigured: () => true, createMailbox: async () => ({ id: "mail-1", email: "new@example.test" }), waitForVerificationCode: async () => "123456", deleteMailbox: async () => {} },
      fetchImpl: async (url, options = {}) => {
        if (url.pathname === "/auth/referral") return json(referrals[subjectOf(options)] || { code: "NEW-ACCOUNT-INVITE" });
        if (url.pathname === "/auth/code") return json({});
        if (url.pathname === "/auth/verify") return json({ access_token: jwt(4_102_444_900), refresh_token: "refresh-new" });
        if (url.pathname === "/auth/invite/redeem") {
          assert.deepEqual(JSON.parse(options.body), { code: "PLUS-INVITE" });
          return json({ access_token: jwt(4_102_445_000), refresh_token: "refresh-redeemed" });
        }
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });
    assert.equal((await dashboard.registerWithMoeMail("")).redeemed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creating an invite code repeats the desktop client's bare authenticated POST", async () => {
  const fixture = setup();
  try {
    const requests = [];
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url, options = {}) => {
        requests.push({ path: url.pathname, method: options.method, body: options.body, headers: options.headers });
        return json({
          code: "FRESH-INVITE", redeemed: 0, threshold: 10, remaining: 50, reached: false,
          max_redemptions: 50, current_plan: "plus", next_plan: "max"
        });
      }
    });

    assert.deepEqual(await dashboard.createReferral("account-1"), {
      code: "FRESH-INVITE", redeemed: 0, threshold: 10, remaining: 50, reached: false,
      maxRedemptions: 50, currentPlan: "plus", nextPlan: "max", rewardPlan: "max", needed: 10
    });
    assert.equal(requests.length, 1);
    const [created] = requests;
    assert.equal(created.path, "/auth/referral");
    assert.equal(created.method, "POST");
    assert.equal(created.body, undefined);
    assert.equal(created.headers["Content-Type"], undefined);
    assert.equal(created.headers.Authorization.startsWith("Bearer "), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a paused invite code creation is reported in Chinese", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url, options = {}) => options.method === "POST"
        ? json({ detail: "invite code creation is paused" }, 503)
        : json({ code: null, threshold: 10, remaining: 50, max_redemptions: 50, current_plan: "plus", next_plan: "max" })
    });

    await assert.rejects(
      dashboard.createReferral("account-1"),
      (error) => error.statusCode === 503 && error.message === "官方已暂停生成新的邀请码，请稍后再试。"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a refused creation still answers with the code Mirasim already issued", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url, options = {}) => options.method === "POST"
        ? json({ detail: "invite code creation is paused" }, 503)
        : json({
          code: "EXISTING-INVITE", redeemed: 1, threshold: 10, remaining: 49, reached: false,
          max_redemptions: 50, current_plan: "plus", next_plan: "max"
        })
    });

    const referral = await dashboard.createReferral("account-1");
    assert.equal(referral.code, "EXISTING-INVITE");
    assert.equal(referral.rewardPlan, "max");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("registration stops asking other accounts once Mirasim pauses invite creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-dashboard-invite-paused-"));
  const subjects = ["plus-a", "plus-b", "plus-c"];
  const homes = subjects.map((subject) => {
    const home = join(root, subject);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "setting.json"), JSON.stringify({
      auth: { userId: subject, token: jwt(4_102_444_800, { sub: subject }), refreshToken: `refresh-${subject}`, exp: 4_102_444_800 }
    }));
    return home;
  });
  const database = new StateDatabase(join(root, "state.sqlite"), { seedHomes: homes });
  const config = { homes, accountRoot: join(root, "profiles"), relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test" };
  try {
    let creates = 0;
    const dashboard = new MirasimDashboard(config, new MirasimProfilePool(homes), new RelayUsageLedger(), {
      database,
      moemail: { isConfigured: () => true, createMailbox: async () => ({ id: "mail-1", email: "new@example.test" }), waitForVerificationCode: async () => "123456", deleteMailbox: async () => {} },
      fetchImpl: async (url, options = {}) => {
        if (url.pathname === "/auth/referral" && options.method === "POST") {
          creates += 1;
          return json({ detail: "invite code creation is paused" }, 503);
        }
        if (url.pathname === "/auth/referral") return json({ code: null, threshold: 10, remaining: 50, max_redemptions: 50, current_plan: "plus", next_plan: "max" });
        if (url.pathname === "/auth/code") return json({});
        if (url.pathname === "/auth/verify") return json({ access_token: jwt(4_102_444_900), refresh_token: "refresh-new" });
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    const result = await dashboard.registerWithMoeMail("");
    assert.equal(result.redeemed, false);
    assert.equal(creates, 1);
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

test("accounts export and import preserve login settings and pool preferences", () => {
  const source = setup();
  const targetRoot = mkdtempSync(join(tmpdir(), "mirasim-dashboard-import-"));
  try {
    const sourceDatabase = new StateDatabase(join(source.root, "state.sqlite"), { seedHomes: [source.home] });
    const sourceDashboard = new MirasimDashboard(source.config, source.pool, source.usage, { database: sourceDatabase });
    sourceDashboard.setAccountPriority("account-1", 75);
    sourceDashboard.disableAccount("account-1");
    const exported = sourceDashboard.exportAccounts();
    assert.equal(exported.format, "mirasim-2api-accounts");
    assert.equal(exported.accounts[0].disabled, true);
    assert.equal(exported.accounts[0].priority, 75);

    const database = new StateDatabase(join(targetRoot, "state.sqlite"));
    const config = { homes: [], accountRoot: join(targetRoot, "profiles"), relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test" };
    const pool = new MirasimProfilePool([]);
    const dashboard = new MirasimDashboard(config, pool, new RelayUsageLedger(), { database });
    assert.deepEqual(dashboard.importAccounts(exported), { imported: 1, skipped: 0 });
    assert.equal(config.homes.length, 1);
    assert.match(readFileSync(join(config.homes[0], "setting.json"), "utf8"), /refreshToken/);
    assert.equal(pool.status()[0].disabled, true);
    assert.equal(pool.status()[0].priorityOverride, 75);
    assert.deepEqual(dashboard.importAccounts(exported), { imported: 0, skipped: 1 });
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

function subjectOf(options) {
  const token = String(options.headers?.Authorization || "").split(" ")[1] || "";
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).sub;
  } catch {
    return null;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
