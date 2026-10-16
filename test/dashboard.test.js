import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { MirasimDashboard, RelayUsageLedger } from "../src/dashboard.js";
import { MirasimProfilePool } from "../src/pool.js";
import { StateDatabase } from "../src/database.js";
import { MirasimRelaySessionError } from "../src/relay-device.js";

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

for (const failure of [401, 503, "malformed"]) {
  test(`personal quota ${failure} automatically refreshes once then uses the renewed credentials`, async () => {
    const fixture = setup();
    let renewals = 0;
    const tokens = [];
    try {
      const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
        sessionRefresher: {
          refreshInBackground() {},
          async refreshNow() {
            renewals++;
            writeFileSync(join(fixture.home, "setting.json"), JSON.stringify({ auth: { userId: "user-a", token: "renewed-token", refreshToken: "refresh-a", exp: 4102444800 } }));
            return true;
          }
        },
        fetchImpl: async (url, options) => {
          if (url.pathname === "/auth/me") return Response.json({ plan: "max" });
          if (url.pathname === "/v1/limits") {
            tokens.push(options.headers.Authorization);
            return tokens.length === 1 ? Response.json({}, { status: failure === "malformed" ? 200 : failure }) : Response.json({ windows: [{ name: "5h", used: 25, budget: 100 }] });
          }
          return Response.json({});
        }
      });
      const account = (await dashboard.snapshot()).accounts[0];
      assert.equal(account.quota.remainingPercent, 75);
      assert.equal(renewals, 1);
      assert.equal(tokens.length, 2);
      assert.equal(tokens[1], "Bearer renewed-token");
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });
}

test("persistent quota failures are rate-limited without turning unknown quota into zero", async () => {
  const fixture = setup();
  let renewals = 0;
  let reads = 0;
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      sessionRefresher: { refreshInBackground() {}, async refreshNow() { renewals++; return true; } },
      fetchImpl: async (url) => {
        if (url.pathname === "/auth/me") return Response.json({ plan: "max" });
        if (url.pathname === "/v1/limits") { reads++; return Response.json({}, { status: 503 }); }
        return Response.json({});
      }
    });
    await dashboard.snapshot();
    const account = (await dashboard.snapshot()).accounts[0];
    assert.equal(renewals, 1);
    assert.equal(reads, 3);
    assert.equal(account.quota.remainingPercent, null);
    assert.ok(account.syncWarnings.some((warning) => warning.field === "limits"));
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

for (const status of [403, 404, 405, 429]) {
  test(`quota HTTP ${status} does not force credential refresh`, async () => {
    const fixture = setup();
    try {
      const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
        sessionRefresher: { refreshInBackground() {}, async refreshNow() { assert.fail("unexpected refresh"); } },
        fetchImpl: async (url) => Response.json(url.pathname === "/auth/me" ? { plan: "max" } : {}, { status: url.pathname === "/v1/limits" ? status : 200 })
      });
      await dashboard.snapshot();
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });
}

test("bulk account operations validate identities before mutation and delete captured homes", async () => {
  const fixture = setup();
  const homes = [fixture.home, join(fixture.root, "b"), join(fixture.root, "c")];
  const database = new StateDatabase(join(fixture.root, "bulk.sqlite"), { seedHomes: homes });
  const pool = new MirasimProfilePool(homes);
  const dashboard = new MirasimDashboard({ ...fixture.config, homes }, pool, fixture.usage, { database, fetchImpl: async () => Response.json({}) });
  const targets = homes.map((home, index) => ({ key: `account-${index + 1}`, selectionId: createHash("sha256").update(home).digest("hex") }));
  try {
    assert.equal((await dashboard.snapshot()).accounts[0].selectionId, targets[0].selectionId);
    assert.throws(() => dashboard.bulkAccounts("disable", [targets[0], { ...targets[1], selectionId: "stale" }]), /列表已变化/);
    assert.deepEqual(database.disabledHomes(), []);
    assert.throws(() => dashboard.bulkAccounts("delete", [targets[0], targets[0]]), /重复/);
    assert.throws(() => dashboard.bulkAccounts("unknown", targets), /有效/);
    assert.throws(() => dashboard.bulkAccounts("disable", []), /1–1000/);
    assert.throws(() => dashboard.bulkAccounts("disable", [null]), /参数无效/);
    assert.equal(dashboard.bulkAccounts("disable", targets).succeeded, 3);
    assert.equal(database.disabledHomes().length, 3);
    assert.equal(dashboard.bulkAccounts("recover", targets).succeeded, 3);
    assert.equal(database.disabledHomes().length, 0);
    const deleted = dashboard.bulkAccounts("delete", [targets[0], targets[2]]);
    assert.equal(deleted.succeeded, 2);
    assert.deepEqual(pool.homes(), [homes[1]]);
    assert.deepEqual(database.homes(), [homes[1]]);
    assert.ok(readFileSync(join(fixture.home, "setting.json"), "utf8"));
    assert.throws(() => dashboard.bulkAccounts("disable", [targets[0]]), /列表已变化/);
    assert.deepEqual(database.disabledHomes(), []);
  } finally {
    database.db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("bulk operations report per-account failures without claiming full success", () => {
  const fixture = setup();
  try {
    const selectionId = createHash("sha256").update(fixture.home).digest("hex");
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage);
    fixture.pool.disable = () => { throw new Error("temporary failure"); };
    const result = dashboard.bulkAccounts("disable", [{ key: "account-1", selectionId }]);
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.results[0].error, "temporary failure");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dashboard snapshots schedule renewal without awaiting it", async () => {
  const fixture = setup();
  let scheduled;
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async () => Response.json({}),
      sessionRefresher: {
        refreshInBackground(homes) { scheduled = homes; },
        refreshAll() { assert.fail("snapshot must not await all renewals"); }
      }
    });
    await dashboard.snapshot();
    assert.deepEqual(scheduled, [fixture.home]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dashboard reads the new campaign and relay usage without returning a token", async () => {
  const fixture = setup();
  try {
    fixture.usage.record({ home: fixture.home }, { status: 200, headers: new Headers({ "x-litellm-call-id": "call-1" }) });
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url, options = {}) => {
        if (url.pathname === "/auth/me") {
          assert.equal(url.origin, "https://login.example.test");
          return json({ name: "Relay User", email: "user@example.test", plan: "Team", tenant: "workspace-a" });
        }
        if (url.pathname === "/v1/pay/campaign/my-link") return json({ slug: "go-example", sold: 2, cap: 3, rewarded: false });
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
    assert.deepEqual(account.campaign, { slug: "go-example", url: "https://mirasim.ai/r/go-example", sold: 2, cap: 3, rewarded: false });
    assert.equal(account.referral, null);
    assert.equal(account.quota.inputTokens, 120);
    assert.equal(account.quota.outputTokens, 45);
    assert.equal(JSON.stringify(snapshot).includes("signature"), false);
    assert.equal(JSON.stringify(snapshot).includes("refresh-a"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("device session failure preserves accounts, local usage and successful account data", async () => {
  const fixture = setup();
  try {
    const secondHome = join(fixture.root, "account-b");
    mkdirSync(secondHome);
    writeFileSync(join(secondHome, "setting.json"), JSON.stringify({ auth: { userId: "user-b", token: jwt(4_102_444_800, { sub: "user-b" }), exp: 4_102_444_800 } }));
    fixture.config.homes.push(secondHome);
    fixture.pool = new MirasimProfilePool(fixture.config.homes);
    fixture.pool.observeLimits(fixture.home, [{ name: "5h", usedPercent: 85, resetAt: Date.now() + 3_600_000 }]);
    fixture.usage.record({ home: fixture.home }, { status: 200, headers: new Headers({ "x-litellm-call-id": "call-1" }) });
    fixture.usage.recordCallUsage(fixture.home, [{ id: "call-1", input: 120, output: 45 }]);
    let relayRequests = 0;
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      relaySessions: { headersFor: async (profile) => {
        if (profile.home === fixture.home) throw new MirasimRelaySessionError("private-upstream-details", { upstreamStatus: 503, retryAfterMs: 900_000 });
        return { Authorization: "Bearer signed-ticket" };
      } },
      fetchImpl: async (url, options) => {
        if (url.pathname === "/auth/me") return json({ email: "saved@example.test", plan: "max" });
        if (url.pathname === "/v1/pay/campaign/my-link") return json({ slug: "go-example", sold: 1, cap: 3, rewarded: false });
        if (url.pathname === "/v1/limits") {
          relayRequests += 1;
          assert.equal(options.headers.Authorization, "Bearer signed-ticket");
          return json({ windows: [{ name: "5h", used: 25, budget: 100 }] });
        }
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });
    const snapshot = await dashboard.snapshot();
    assert.equal(snapshot.accounts.length, 2);
    const account = snapshot.accounts[0];
    assert.equal(account.loggedIn, true);
    assert.equal(account.identity.email, "saved@example.test");
    assert.equal(account.campaign.slug, "go-example");
    assert.equal(account.quota.requests, 1);
    assert.equal(account.quota.inputTokens, 120);
    assert.equal(account.quota.source, "local");
    assert.equal(account.quota.remainingPercent, null);
    assert.deepEqual(account.quota.windows, []);
    assert.deepEqual(account.syncWarnings.map((warning) => warning.field), ["usage", "limits"]);
    assert.equal(account.syncWarnings[0].upstreamStatus, 503);
    assert.equal(account.syncWarnings[0].retryAfterMs, 900_000);
    assert.match(account.syncWarnings[0].message, /15 分钟/);
    assert.doesNotMatch(JSON.stringify(snapshot), /private-upstream-details|signed-ticket|signature|refresh-a/);
    assert.equal(fixture.pool.usedPercent(fixture.home), 85);
    assert.equal(snapshot.accounts[1].quota.remainingPercent, 75);
    assert.deepEqual(snapshot.accounts[1].syncWarnings, []);
    assert.equal(relayRequests, 1);
    assert.ok(readFileSync(join(fixture.home, "setting.json"), "utf8").includes("refresh-a"));
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

test("quota windows are converted from the relay's used/budget pair into percentages", async () => {
  const fixture = setup();
  try {
    let limitsHeaders = null;
    const futureResetAt = Math.floor((Date.now() + 7 * 24 * 60 * 60_000) / 1000);
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url, options = {}) => {
        if (url.pathname === "/auth/me") return json({ email: "user@example.test", plan: "max" });
        if (url.pathname === "/auth/referral") return json({ code: null, threshold: 0 });
        if (url.pathname === "/usage/calls") return json({ calls: [] });
        if (url.pathname === "/v1/limits") {
          limitsHeaders = options.headers;
          return json({
            subject: "user-a",
            windows: [
              { name: "5h", used: 5.85365, budget: 156_800, reset_at: futureResetAt },
              { name: "7d", used: 448_000, budget: 560_000, reset_at: futureResetAt },
              // Model-scoped and completely spent: it must not decide the account's headline.
              { name: "7d_fable", used: 296_800, budget: 296_800, reset_at: futureResetAt, model_scoped: true },
              // No usable figure — a zero budget would otherwise render as "100% left".
              { name: "broken", used: 10, budget: 0, reset_at: 0 },
              { name: "missing", used: null, budget: 100 },
              { name: "empty", used: "", budget: 100 },
              { name: "negative", used: -1, budget: 100 }
            ]
          });
        }
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    const account = (await dashboard.snapshot()).accounts[0];
    // The read identifies itself as a metering query rather than traffic.
    assert.equal(limitsHeaders["x-mirasim-probe"], "usage");
    // ...and the headers the caller passes no longer replace the authenticated ones.
    assert.equal(limitsHeaders["x-mirasim-token"], fixture.pool.profile(fixture.home).token);

    assert.deepEqual(account.quota.windows.map((window) => window.name), ["5h", "7d", "7d_fable"]);
    const [fiveHour, sevenDay, fable] = account.quota.windows;
    // 5.85365 / 156800 rounds to 0% used, so effectively the whole window is still open.
    assert.deepEqual(
      { usedPercent: fiveHour.usedPercent, remainingPercent: fiveHour.remainingPercent, status: fiveHour.status },
      { usedPercent: 0, remainingPercent: 100, status: "allowed" }
    );
    assert.deepEqual(
      { usedPercent: sevenDay.usedPercent, remainingPercent: sevenDay.remainingPercent, status: sevenDay.status, remaining: sevenDay.remaining },
      { usedPercent: 80, remainingPercent: 20, status: "warning", remaining: 112_000 }
    );
    assert.deepEqual(
      { usedPercent: fable.usedPercent, status: fable.status, modelScoped: fable.modelScoped },
      { usedPercent: 100, status: "limit_reached", modelScoped: true }
    );
    assert.equal(sevenDay.resetAt, new Date(futureResetAt * 1000).toISOString());
    // reset_at 0 and a zero budget both mean "no number", not zero.
    assert.equal(account.quota.windows.some((window) => window.name === "broken"), false);

    // The account is at warning, not limit_reached: the exhausted window is fable's alone, and
    // the binding figure is the worst of the windows that actually govern the account.
    assert.equal(account.quota.limitStatus, "warning");
    assert.equal(account.quota.remainingPercent, 20);

    // The same reading reaches the rotation, which otherwise learns an account's quota only from
    // traffic it has already sent that account. fable's exhausted window is left out of it for
    // the same reason it is left out of the headline: it stops fable, not the account.
    assert.equal(fixture.pool.usedPercent(fixture.home), 80);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a quota reading that is 99% spent is reported as exhausted, and a scoped-only account still gets a figure", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => {
        if (url.pathname === "/auth/me") return json({ email: "user@example.test", plan: "max" });
        if (url.pathname === "/auth/referral") return json({ code: null, threshold: 0 });
        if (url.pathname === "/usage/calls") return json({ calls: [] });
        // The upstream's counters lag its refusals, so 99% up is treated as spent.
        if (url.pathname === "/v1/limits") return json({
          windows: [{ name: "7d_fable", used: 99_100, budget: 100_000, reset_at: 0, model_scoped: true }]
        });
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    const account = (await dashboard.snapshot()).accounts[0];
    assert.equal(account.quota.windows[0].usedPercent, 100);
    assert.equal(account.quota.windows[0].remainingPercent, 0);
    assert.equal(account.quota.windows[0].resetAt, null);
    // Nothing but scoped windows, so they are all there is to go on rather than being ignored.
    assert.equal(account.quota.limitStatus, "limit_reached");
    assert.equal(account.quota.remainingPercent, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a relay without a limits endpoint reports no quota figures rather than an error", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => {
        if (url.pathname === "/auth/me") return json({ email: "user@example.test", plan: "max" });
        if (url.pathname === "/auth/referral") return json({ code: null, threshold: 0 });
        if (url.pathname === "/usage/calls") return json({ calls: [] });
        if (url.pathname === "/v1/limits") return new Response("not found", { status: 404 });
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    const account = (await dashboard.snapshot()).accounts[0];
    assert.deepEqual(account.quota.windows, []);
    assert.equal(account.quota.limitStatus, null);
    assert.equal(account.quota.remainingPercent, null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("bulk recovery reports how many accounts it lifted out of cooldown", () => {
  const fixture = setup();
  try {
    const database = new StateDatabase(join(fixture.root, "state.sqlite"), { seedHomes: [fixture.home] });
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, { fetchImpl: async () => json({}), database });
    assert.deepEqual(dashboard.recoverAllAccounts(), { recovered: 0 });
    fixture.pool.failure({ home: fixture.home });
    assert.equal(fixture.pool.status()[0].healthy, false);
    assert.deepEqual(dashboard.recoverAllAccounts(), { recovered: 1 });
    assert.equal(fixture.pool.status()[0].healthy, true);
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

test("an unavailable campaign does not fall back to legacy referral rewards", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => {
        if (url.pathname === "/auth/me") return json({ name: "Relay User", email: "user@example.test" });
        if (url.pathname === "/auth/referral") return json({ code: null, current_plan: "none", next_plan: null });
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    const account = (await dashboard.snapshot()).accounts[0];
    assert.equal(account.campaign, null);
    assert.equal(account.referral, null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("campaign rewards follow the explicit official rewarded flag", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url) => {
        if (url.pathname === "/auth/me") return json({ email: "user@example.test" });
        if (url.pathname === "/v1/pay/campaign/my-link") return json({ slug: "go-reward", sold: 3, cap: 3, rewarded: true });
        throw new Error(`Unexpected path ${url.pathname}`);
      }
    });

    const campaign = (await dashboard.snapshot()).accounts[0].campaign;
    assert.equal(campaign.rewarded, true);
    assert.equal(campaign.sold, 3);
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
    assert.equal(account.referral, null);
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

test("account snapshots never run the removed paid Haiku probe", async () => {
  const fixture = setup();
  try {
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, {
      fetchImpl: async (url, options) => {
        assert.notEqual(url.pathname, "/v1/messages");
        assert.notEqual(options.method, "POST");
        return json({});
      }
    });

    assert.equal(dashboard.checkAccountStatus, undefined);
    await dashboard.snapshot();
    assert.equal(fixture.usage.snapshot(fixture.home).requests, 0);
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

test("blank MoeMail invite code does not create or redeem legacy invitations", async () => {
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
    assert.equal((await dashboard.registerMoeMailBatch("", 1)).accounts[0].redeemed, false);
    assert.equal(referralRequests, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});



test("registration does not attempt the retired invite creation endpoint", async () => {
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
    assert.equal(creates, 0);
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

test("the rotation mode is stored, replayed onto the pool, and refuses a name it does not know", async () => {
  const fixture = setup();
  try {
    const database = new StateDatabase(join(fixture.root, "state.sqlite"), { seedHomes: [fixture.home] });
    const dashboard = new MirasimDashboard(fixture.config, fixture.pool, fixture.usage, { fetchImpl: async () => json({}), database });

    assert.deepEqual(dashboard.rotationMode(), { mode: "spread", modes: ["spread", "waterfall", "roundRobin"] });
    assert.deepEqual(dashboard.setRotationMode("waterfall"), { mode: "waterfall", modes: ["spread", "waterfall", "roundRobin"] });
    assert.equal(fixture.pool.mode(), "waterfall");
    // Stored, so a restart keeps the operator's choice rather than reverting to the default.
    assert.equal(database.getRotationMode(), "waterfall");

    // A name the pool cannot place is refused, and leaves the running mode untouched.
    assert.throws(() => dashboard.setRotationMode("greedy"), /轮询模式必须是/);
    assert.throws(() => dashboard.setRotationMode(""), /轮询模式必须是/);
    assert.equal(fixture.pool.mode(), "waterfall");
    assert.equal(database.getRotationMode(), "waterfall");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
