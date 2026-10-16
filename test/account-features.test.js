import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { normalizeCampaignLink, normalizeResetCards, RESET_OUTCOMES } from "../src/account-features.js";
import { MirasimDashboard, RelayUsageLedger } from "../src/dashboard.js";
import { MirasimProfilePool } from "../src/pool.js";

const card = { id: "card/one", status: "active", granted_at: "2026-09-01T00:00:00Z", expires_at: "2027-09-01T00:00:00Z" };
const snapshot = { cards: [card], history: [{ card_id: card.id, kind: "granted", at: card.granted_at, expires_at: card.expires_at }] };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

test("campaign links validate official slugs and never trust an upstream URL", () => {
  assert.deepEqual(normalizeCampaignLink({ slug: " GO-Example ", sold: 1.9, cap: 4.9, rewarded: true, url: "javascript:alert(1)" }), {
    slug: "go-example", url: "https://mirasim.ai/r/go-example", sold: 1, cap: 4, rewarded: true
  });
  assert.deepEqual(normalizeCampaignLink({ slug: "go-ok", sold: -1, cap: 0, rewarded: "true" }), {
    slug: "go-ok", url: "https://mirasim.ai/r/go-ok", sold: 0, cap: 3, rewarded: false
  });
  for (const slug of [null, "", "go-", "go-<script>", "https://evil.test", "go-" + "a".repeat(30)]) assert.equal(normalizeCampaignLink({ slug }), null);
});

test("reset cards normalize valid dates, statuses and history without inventing cards", () => {
  assert.equal(normalizeResetCards({ cards: [] }), null);
  const normalized = normalizeResetCards({ cards: [card, null, { ...card, status: "unknown" }, { ...card, expires_at: "bad" }, { ...card, id: "used", status: "used" }], history: [null, ...snapshot.history, { ...snapshot.history[0], kind: "used", windows: ["5h", "7d", 42] }] });
  assert.equal(normalized.available, 1);
  assert.equal(normalized.cards.length, 2);
  assert.equal(normalized.cards[0].expiresAt, Date.parse(card.expires_at));
  assert.equal(normalized.cards[0].usedAt, null);
  assert.deepEqual(normalized.history[1].windows, ["5h", "7d"]);
});

function fixture(context, fetchImpl, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirasim-account-features-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "profile");
  mkdirSync(home);
  const saveToken = (token) => writeFileSync(join(home, "setting.json"), JSON.stringify({ auth: { userId: "user-a", token, exp: 4102444800 } }));
  saveToken("initial-token");
  const config = { homes: [home], relayUrl: "https://relay.example.test", loginUrl: "https://login.example.test" };
  const pool = new MirasimProfilePool([home]);
  const dashboard = new MirasimDashboard(config, pool, new RelayUsageLedger(), { fetchImpl, ...options });
  return { dashboard, pool, home, saveToken };
}

test("campaign reads login origin while reset cards use bearer-only relay authentication", async (context) => {
  const seen = [];
  const { dashboard } = fixture(context, async (url, options) => {
    seen.push({ url: url.href, ...options });
    return json(url.pathname.includes("campaign") ? { slug: "go-test", sold: 1, cap: 3 } : snapshot);
  }, { relaySessions: { headersFor: () => assert.fail("reset cards must not mint inference tickets") } });
  assert.equal((await dashboard.campaignLink("account-1")).url, "https://mirasim.ai/r/go-test");
  assert.equal((await dashboard.resetCards("account-1")).available, 1);
  assert.equal(seen[0].url, "https://login.example.test/v1/pay/campaign/my-link");
  assert.equal(seen[1].url, "https://relay.example.test/v1/reset-cards");
  assert.deepEqual(seen[1].headers, { Authorization: "Bearer initial-token" });
  assert.equal(seen[1].body, undefined);
});

for (const outcome of RESET_OUTCOMES) {
  test(`reset card outcome ${outcome} is preserved without retry or accidental account enabling`, async (context) => {
    const seen = [];
    const { dashboard, pool, home } = fixture(context, async (url, options) => {
      seen.push({ path: url.pathname, ...options });
      return json({ ...snapshot, outcome, windows: ["5h", "7d"] });
    });
    pool.observeLimits(home, [{ name: "5h", usedPercent: 95, resetAt: Date.now() + 3600000 }]);
    pool.failure(pool.profile(home), 60000);
    pool.disable(home);
    const result = await dashboard.redeemResetCard("account-1", card.id);
    assert.equal(result.outcome, outcome);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, "/v1/reset-cards/card%2Fone/redeem");
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].body, undefined);
    assert.equal(pool.isDisabled(home), true);
    assert.equal(pool.usedPercent(home), outcome === "reset" ? 0 : 95);
  });
}

test("unknown and failed reset results are not retried or treated as success", async (context) => {
  for (const result of [json({ outcome: "unexpected" }), json({}, 503), json({ outcome: "reset" }, 401)]) {
    let calls = 0;
    const { dashboard } = fixture(context, async () => { calls++; return result; });
    await assert.rejects(dashboard.redeemResetCard("account-1", "card"));
    assert.equal(calls, 1);
  }
});

test("reset card authentication refreshes once after 401 using the new token", async (context) => {
  const tokens = [];
  const refreshed = fixture(context, async (url, options) => {
    tokens.push(options.headers.Authorization);
    return tokens.length === 1 ? json({}, 401) : json(snapshot);
  }, { sessionRefresher: { refreshNow: async () => { refreshed.saveToken("fresh-token"); return true; } } });
  assert.equal((await refreshed.dashboard.resetCards("account-1")).available, 1);
  assert.deepEqual(tokens, ["Bearer initial-token", "Bearer fresh-token"]);
});

test("invalid card ids are rejected without an upstream call", async (context) => {
  const { dashboard } = fixture(context, () => assert.fail("unexpected upstream request"));
  for (const id of [null, "", " ", "x".repeat(257)]) await assert.rejects(dashboard.redeemResetCard("account-1", id), (error) => error.statusCode === 400);
  await assert.rejects(dashboard.redeemResetCard("account-1", "card", "stale-account-selection"), (error) => error.statusCode === 409);
});

test("dashboard snapshots include account-specific cards and distinguish unavailable from zero", async (context) => {
  let unavailable = false;
  const { dashboard } = fixture(context, async (url) => {
    if (url.pathname === "/auth/me") return json({ plan: "go" });
    if (url.pathname === "/v1/reset-cards") return unavailable ? json({}, 503) : json(snapshot);
    return json({});
  });
  assert.equal((await dashboard.snapshot()).accounts[0].resetCards.available, 1);
  unavailable = true;
  const account = (await dashboard.snapshot()).accounts[0];
  assert.equal(account.resetCards, null);
  assert.equal(account.loggedIn, true);
});
