import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { RelayRequestLog } from "../src/request-log.js";

const dashboard = {
  relay: "relay.example.test",
  generatedAt: "2026-08-09T00:00:00.000Z",
  accounts: [{
    key: "account-1",
    id: "user-a",
    loggedIn: true,
    healthy: true,
    identity: { name: "Relay User", email: "user@example.test", accountType: "Team", subscriptionExpiresAt: "2027-03-05T12:00:00.000Z" },
    referral: { code: "INVITE-123", redeemed: 1, threshold: 5, remaining: 4, reached: false, maxRedemptions: 10, currentPlan: "basic", nextPlan: "plus", rewardPlan: "plus", needed: 4 },
    campaign: { slug: "go-example", url: "https://mirasim.ai/r/go-example", sold: 1, cap: 3, rewarded: false },
    quota: { availability: "available", requests: 12, inputTokens: 120, outputTokens: 45, cacheReadTokens: 10, cacheWriteTokens: 5, source: "relay", lastStatus: 200 }
  }]
};

const modelHealth = {
  running: false,
  scanIntervalMs: 1_800_000,
  lastStartedAt: "2026-08-09T00:00:00.000Z",
  lastFinishedAt: "2026-08-09T00:01:00.000Z",
  lastError: null,
  models: [{ id: "gpt-5.6", status: "healthy", latencyMs: 234, httpStatus: 200, checkedAt: "2026-08-09T00:01:00.000Z", message: "可正常响应。" }]
};

const usageLog = {
  entries: Array.from({ length: 25 }, (_, index) => ({
    id: index + 1,
    at: "2026-08-09T00:00:00.000Z",
    path: "/v1/chat/completions",
    account: "user-a",
    model: `model-${index + 1}`,
    stream: true,
    reasoningEffort: ["high", "budget:8192", "adaptive", null, null][index % 5],
    // What the model was told, which is what the column reports; the ask above is only shown
    // when the two differ.
    thinkingLevel: ["high", "budget:8192", "max", "off", null][index % 5],
    inputTokens: 120,
    outputTokens: 45,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    inputTokenSemantics: "inclusive_cache",
    uncachedInputTokens: 110,
    ttfbMs: 800,
    durationMs: 1_500,
    status: 200,
    pending: false
  }))
};

test("redeem result remains visible after the dashboard refreshes", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();
  nodes.get("#redeem-code").value = "OTHER-INVITE";

  await api.redeemInvite({ preventDefault() {} });
  assert.equal(nodes.get("#redeem-status").textContent, "邀请码已兑换，账号状态已刷新。");
  assert.equal(nodes.get("#redeem-status").dataset.state, "success");

  await api.loadDashboard();
  assert.equal(nodes.get("#redeem-status").textContent, "邀请码已兑换，账号状态已刷新。");
  assert.equal(nodes.get("#redeem-status").dataset.state, "success");
});

test("Mirasim account login is presented in a modal and closes after verification", async () => {
  const { api, nodes } = loadDashboardUi();
  const modal = nodes.get("#mirasim-login-modal");
  modal.hidden = true;

  api.openMirasimLogin();
  assert.equal(modal.hidden, false);

  api.closeMirasimLogin();
  assert.equal(modal.hidden, true);

  await api.loadDashboard();
  nodes.get("#mirasim-login-modal").hidden = false;
  nodes.get("#notice").hidden = true;
  nodes.get("#mirasim-email").value = "user@example.test";
  nodes.get("#mirasim-verify-code").value = "123456";
  await api.verifyMirasimLogin({ preventDefault() {} });

  assert.equal(nodes.get("#mirasim-login-modal").hidden, true);
  assert.equal(nodes.get("#mirasim-login-status").textContent, "输入邮箱后发送验证码。");
  assert.equal(nodes.get("#notice").hidden, true);
});

test("MoeMail signup submits the optional invite code and refreshes the account pool", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();
  nodes.get("#mirasim-login-modal").hidden = false;
  nodes.get("#moemail-invite-code").value = "INVITE-123";
  await api.registerWithMoeMail({ preventDefault() {} });
  assert.equal(nodes.get("#mirasim-login-modal").hidden, true);
  assert.equal(nodes.get("#notice").hidden, false);
  assert.match(nodes.get("#notice").textContent, /1\/1/);
});

test("MoeMail configuration is saved without retaining the API key in the page", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();
  nodes.get("#moemail-url").value = "https://mail.example.test";
  nodes.get("#moemail-domain").value = "mail.example.test";
  nodes.get("#moemail-api-key").value = "private-mail-key";
  await api.saveMoeMailConfig({ preventDefault() {} });
  assert.equal(nodes.get("#moemail-api-key").value, "");
  assert.equal(nodes.get("#moemail-config-status").textContent, "已配置");
});

test("MoeMail domain discovery fills all available domains", async () => {
  const { api, nodes } = loadDashboardUi();
  nodes.get("#moemail-url").value = "https://mail.example.test";
  nodes.get("#moemail-api-key").value = "mail-key";
  await api.discoverMoeMailDomains();
  assert.equal(nodes.get("#moemail-domain").value, "one.example.test, two.example.test");
  assert.equal(nodes.get("#moemail-config-status").textContent, "已获取 2 个域名");
});

test("new API keys provide a complete-key copy action", async () => {
  const { api, nodes, clipboardWrites } = loadDashboardUi();
  await api.loadDashboard();
  nodes.get("#api-key-name").value = "Local client";
  await api.createApiKey({ preventDefault() {} });
  assert.equal(nodes.get("#api-key-value").textContent, "msk_test_complete_key");
  assert.equal(nodes.get("#api-key-reveal").hidden, false);
  await api.copyApiKey();
  assert.deepEqual(clipboardWrites, ["msk_test_complete_key"]);
});

test("saved API keys can be retrieved only through the historical copy action", async () => {
  const { api, clipboardWrites } = loadDashboardUi();
  const button = { dataset: { copyKeyId: "key-test" }, closest() { return this; } };
  await api.copyHistoricalApiKey({ target: button });
  assert.deepEqual(clipboardWrites, ["msk_saved_complete_key"]);
});

test("the overview scales large totals to K/M/B and keeps the exact count in the tooltip", async () => {
  const account = dashboard.accounts[0];
  const large = {
    ...dashboard,
    accounts: [{
      ...account,
      quota: { ...account.quota, requests: 1_500, inputTokens: 12_345_678, outputTokens: 2_000_000_000, cacheReadTokens: 999, cacheWriteTokens: 1_000_000 }
    }]
  };
  const { api, nodes } = loadDashboardUi(large);
  await api.loadDashboard();

  assert.equal(nodes.get("#overview-request-count").textContent, "1.5K");
  assert.equal(nodes.get("#overview-input-tokens").textContent, "12.3M");
  assert.equal(nodes.get("#overview-output-tokens").textContent, "2B");
  // Under a thousand there is no unit worth adding, so the plain count stays.
  assert.equal(nodes.get("#overview-cache-read-tokens").textContent, "999");
  assert.equal(nodes.get("#overview-cache-write-tokens").textContent, "1M");
  assert.equal(nodes.get("#overview-input-tokens").title, "12,345,678");
});

test("sidebar switches between exclusive views and overview aggregates usage", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();

  assert.equal(nodes.get("#overview-account-count").textContent, "1");
  assert.equal(nodes.get("#overview-request-count").textContent, "12");
  assert.equal(nodes.get("#overview-input-tokens").textContent, "120");
  assert.equal(nodes.get("#overview-output-tokens").textContent, "45");
  assert.equal(nodes.get("#overview-cache-read-tokens").textContent, "10");
  assert.equal(nodes.get("#overview-cache-write-tokens").textContent, "5");

  api.setView("activity");
  assert.equal(nodes.get("#overview-view").hidden, true);
  assert.equal(nodes.get("#activity-view").hidden, false);
  assert.equal(nodes.get("#nav-activity").className, "nav-item active");
  assert.equal(nodes.get("#nav-activity")["aria-current"], "page");
  assert.equal(nodes.get("#nav-overview")["aria-current"], "false");
  assert.equal(nodes.get("#workspace-location").textContent, "邀请活动");

  api.setView("apiKeys");
  assert.equal(nodes.get("#activity-view").hidden, true);
  assert.equal(nodes.get("#api-keys-view").hidden, false);
  assert.equal(nodes.get("#workspace-location").textContent, "API 密钥");

  api.setView("modelHealth");
  assert.equal(nodes.get("#api-keys-view").hidden, true);
  assert.equal(nodes.get("#model-health-view").hidden, false);
  assert.equal(nodes.get("#workspace-location").textContent, "模型健康");
  assert.match(nodes.get("#model-health-body").innerHTML, /gpt-5\.6/);
});

test("activity views show an explicit unavailable state instead of blank membership data", async () => {
  const noActivityDashboard = JSON.parse(JSON.stringify(dashboard));
  noActivityDashboard.accounts[0].referral = null;
  noActivityDashboard.accounts[0].campaign = null;
  noActivityDashboard.accounts[0].identity.accountType = null;
  const { api, nodes } = loadDashboardUi(noActivityDashboard);
  await api.loadDashboard();

  assert.match(nodes.get("#membership-summary").innerHTML, /普通用户/);
  assert.match(nodes.get("#pool-body").innerHTML, /普通用户/);
  assert.match(nodes.get("#pool-body").innerHTML, /暂无官方数据/);
});

test("official account plan is displayed without the retired referral reward tier", async () => {
  const plusDashboard = JSON.parse(JSON.stringify(dashboard));
  plusDashboard.accounts[0].identity.accountType = "plus";
  plusDashboard.accounts[0].referral.currentPlan = "plus";
  plusDashboard.accounts[0].referral.nextPlan = "max";
  plusDashboard.accounts[0].referral.rewardPlan = "max";
  const { api, nodes } = loadDashboardUi(plusDashboard);
  await api.loadDashboard();
  assert.match(nodes.get("#membership-summary").innerHTML, /MAX 10X/);
  assert.match(nodes.get("#membership-summary").innerHTML, /Go 套餐邀请/);
  assert.doesNotMatch(nodes.get("#membership-summary").innerHTML, /MAX 40X/);
  assert.match(nodes.get("#pool-body").innerHTML, /MAX 10X/);
});

test("activity progress counts Go purchases instead of legacy code redemptions", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();

  assert.equal(nodes.get("#redeemed-count").textContent, "1 / 3");
  assert.equal(nodes.get("#remaining-count").textContent, "距活动目标还差 2 位");
  assert.match(nodes.get("#progress-copy").textContent, /购买 Go 套餐才计入邀请/);
  assert.match(nodes.get("#invite-copy").textContent, /购买 Go 套餐/);
  assert.match(nodes.get("#membership-summary").innerHTML, /Go 套餐邀请/);
  assert.match(nodes.get("#pool-body").innerHTML, /1 \/ 3 位已购买/);
});

test("redeeming an MLIC licence reports the tier it granted", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();
  nodes.get("#redeem-code").value = "MLIC-0001";

  await api.redeemInvite({ preventDefault() {} });
  assert.equal(nodes.get("#redeem-status").textContent, "授权码已兑换：已升级为MAX 40X（30 天）。");
  assert.equal(nodes.get("#redeem-status").dataset.state, "success");
});

test("previewing a licence surfaces the official verdict without redeeming it", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();
  nodes.get("#redeem-code").value = "MLIC-LOW";

  await api.previewRedeemCode();
  assert.equal(nodes.get("#redeem-status").textContent, "该授权码为MAX 2X，低于当前账号档位，兑换会被官方拦截，且不会消耗该授权码。");
  assert.equal(nodes.get("#redeem-code").value, "MLIC-LOW");
});

test("refreshing a campaign link no longer generates legacy invite codes", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();

  await api.createReferral();
  assert.equal(nodes.get("#notice").textContent, "新版邀请链接已刷新。");
  assert.equal(nodes.get("#create-code").textContent, "刷新链接");
});

test("an account without an invite code is not told its code can still be redeemed", async () => {
  const pending = JSON.parse(JSON.stringify(dashboard));
  pending.accounts[0].campaign = null;
  const { api, nodes } = loadDashboardUi(pending);
  await api.loadDashboard();

  assert.equal(nodes.get("#invite-code").textContent, "暂无邀请链接");
  assert.equal(nodes.get("#invite-copy").textContent, "官方暂未提供邀请链接，可稍后刷新。");
  assert.equal(nodes.get("#copy-code").disabled, true);
  assert.equal(nodes.get("#create-code").disabled, false);
});

test("notices appear as a dismissable toast that clears itself", async () => {
  const { api, nodes, timers } = loadDashboardUi();
  await api.loadDashboard();

  await api.createReferral();
  const notice = nodes.get("#notice");
  assert.equal(notice.hidden, false);
  assert.equal(notice.dataset.state, "success");

  const scheduled = timers.filter(Boolean).pop();
  assert.equal(scheduled.delay, 4_000);
  scheduled.callback();
  assert.equal(notice.hidden, true);
});

test("a free account is listed as having no relay quota", async () => {
  const freeDashboard = JSON.parse(JSON.stringify(dashboard));
  freeDashboard.accounts[0].quota.availability = "no_quota";
  freeDashboard.accounts[0].quota.windows = [];
  const { api, nodes } = loadDashboardUi(freeDashboard);
  await api.loadDashboard();

  assert.match(nodes.get("#pool-body").innerHTML, /免费号无中转额度/);
  assert.match(nodes.get("#pool-body").innerHTML, /无额度备用/);
  assert.equal(nodes.get("#overview-available-count").textContent, "0");
});

test("the account pool exposes the rotation priority and reports a change", async () => {
  const priorityDashboard = JSON.parse(JSON.stringify(dashboard));
  priorityDashboard.accounts[0].priority = 60;
  priorityDashboard.accounts[0].priorityOverride = null;
  const { api, nodes } = loadDashboardUi(priorityDashboard);
  await api.loadDashboard();

  assert.match(nodes.get("#pool-body").innerHTML, /自动（按档位）<\/option>/);
  assert.match(nodes.get("#pool-body").innerHTML, /当前 60/);

  const select = { value: "25", disabled: false, dataset: { priorityAccount: "account-1" }, closest() { return this; } };
  await api.changeAccountPriority({ target: select });
  assert.equal(nodes.get("#notice").textContent, "该账号的轮询优先级已设为 25。");
  assert.equal(select.disabled, false);
});

test("account-pool rows no longer expose a paid Haiku status probe", async () => {
  assert.doesNotMatch(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"), /状态检测消耗额度|data-check-account/);
  const { api, nodes, requests } = loadDashboardUi();
  await api.loadDashboard();
  assert.doesNotMatch(nodes.get("#pool-body").innerHTML, /data-check-account|状态检测|Haiku/);
  assert.equal(requests.some((entry) => entry.url?.includes("status-check")), false);
});

test("an empty account pool spans every column of the pool table", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();
  nodes.get("#pool-search").value = "no-such-account";
  api.setPoolFilters();

  assert.match(nodes.get("#pool-body").innerHTML, new RegExp(`<td colspan="${poolColumnCount()}"`));
});

test("an outdated gateway is reported as needing a restart instead of its route list", async () => {
  const { api, nodes } = loadDashboardUi(dashboard, {
    "/api/accounts/account-1/priority": () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: "Use /, /api/dashboard, /healthz, /v1/models, /v1/chat/completions." } })
    })
  });
  await api.loadDashboard();

  const select = { value: "25", disabled: false, dataset: { priorityAccount: "account-1" }, closest() { return this; } };
  await api.changeAccountPriority({ target: select });
  assert.equal(nodes.get("#notice").textContent, "本地网关不认识该接口（HTTP 404），请重启本机网关后重试。");
  assert.equal(nodes.get("#notice").dataset.state, "error");
  assert.equal(select.disabled, false);
});

test("account pool filters by category and search term, then paginates results", async () => {
  const accounts = Array.from({ length: 12 }, (_, index) => ({
    ...JSON.parse(JSON.stringify(dashboard.accounts[0])),
    key: `account-${index + 1}`,
    id: `user-${index + 1}`,
    identity: { name: `Member ${index + 1}`, email: `member-${index + 1}@example.test`, accountType: index === 10 ? "MAX" : "普通用户" },
    referral: index === 10 ? { ...dashboard.accounts[0].referral, currentPlan: "MAX" } : { ...dashboard.accounts[0].referral, currentPlan: "普通用户" }
  }));
  const { api, nodes } = loadDashboardUi({ ...dashboard, accounts });
  await api.loadDashboard();
  assert.match(nodes.get("#pool-page-summary").textContent, /1-10 \/ 12/);
  api.changePoolPage(1);
  assert.match(nodes.get("#pool-body").innerHTML, /Member 11/);
  assert.match(nodes.get("#pool-page-summary").textContent, /11-12 \/ 12/);

  nodes.get("#pool-category").value = "max";
  api.setPoolFilters();
  assert.match(nodes.get("#pool-body").innerHTML, /Member 11/);
  assert.doesNotMatch(nodes.get("#pool-body").innerHTML, /Member 12/);

  nodes.get("#pool-category").value = "all";
  nodes.get("#pool-search").value = "member-12@example.test";
  api.setPoolFilters();
  assert.match(nodes.get("#pool-body").innerHTML, /Member 12/);
  assert.match(nodes.get("#pool-page-summary").textContent, /1-1 \/ 1/);
});

test("the account pool states the subscription end date down to the year", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();

  const html = nodes.get("#pool-body").innerHTML;
  // A subscription runs months out, so a month/day pair alone cannot identify the date.
  assert.match(html, /订阅至 2027\/03\/05/);
  assert.match(html, /title="[^"]*2027[^"]*"/);
});

test("pool status filters separate manual pauses, cooling, exhaustion and signed-out accounts", async () => {
  const future = new Date(Date.now() + 3600000).toISOString();
  const accounts = [
    {}, { disabled: true }, { quota: { availability: "cooling" } },
    { quota: { availability: "available", windows: [{ name: "5h", remainingPercent: 0, resetAt: future }] } },
    { quota: { availability: "no_quota" } }, { loggedIn: false }, { quota: {} }
  ].map((fields, index) => ({ ...dashboard.accounts[0], ...fields, key: `account-${index}`, id: `status-user-${index}`, identity: { name: `Status ${index}` } }));
  const { api, nodes } = loadDashboardUi({ ...dashboard, accounts });
  await api.loadDashboard();
  for (const [index, status] of ["available", "disabled", "cooling", "exhausted", "no_quota", "signed_out", "unknown"].entries()) {
    api.setPoolStatus(status);
    assert.equal(nodes.get("#pool-page-summary").textContent, "1-1 / 1 个账户");
    assert.match(nodes.get("#pool-body").innerHTML, new RegExp(`Status ${index}<`));
  }
  api.resetPoolFilters();
  assert.match(nodes.get("#pool-page-summary").textContent, /1-7 \/ 7/);
  assert.match(nodes.get("#pool-filter-summary").textContent, /全池统计/);
});

test("pool capacity excludes missing and expired quota data instead of assuming full balances", async () => {
  const future = new Date(Date.now() + 3600000).toISOString();
  const past = new Date(Date.now() - 3600000).toISOString();
  const accounts = [
    { remainingPercent: 50, windows: [{ name: "5h", remainingPercent: 50, resetAt: future }] },
    {},
    { remainingPercent: 0, windows: [{ name: "5h", remainingPercent: 0, resetAt: past }] },
    { remainingPercent: 0, windows: [{ name: "7d_fable", remainingPercent: 0, resetAt: future, modelScoped: true }] }
  ].map((quota, index) => ({ ...dashboard.accounts[0], key: `account-${index}`, quota: { availability: "available", ...quota } }));
  const { api, nodes } = loadDashboardUi({ ...dashboard, accounts });
  await api.loadDashboard();
  assert.match(nodes.get("#pool-capacity").innerHTML, /50\.0%/);
  assert.match(nodes.get("#pool-capacity").innerHTML, /1 个已知 · 3 个未知/);
  assert.match(nodes.get("#pool-body").innerHTML, /重置时间已过 · 待更新/);
  assert.doesNotMatch(nodes.get("#pool-capacity").innerHTML, /同时归零|没有账号接近上限/);
  assert.equal(api.poolStatus(accounts[2]), "available");
  assert.equal(api.poolStatus(accounts[3]), "available");
});

test("pool sorting keeps unknown quotas last in both directions without changing the source order", async () => {
  const accounts = [null, 15, 90].map((remainingPercent, index) => ({ ...dashboard.accounts[0], key: `account-${index}`, identity: { name: `Balance ${index}` }, quota: { availability: "available", remainingPercent } }));
  const { api, nodes } = loadDashboardUi({ ...dashboard, accounts });
  await api.loadDashboard();
  for (const [sort, expected] of [["remaining-asc", [1, 2, 0]], ["remaining-desc", [2, 1, 0]]]) {
    nodes.get("#pool-sort").value = sort;
    api.setPoolFilters();
    const html = nodes.get("#pool-body").innerHTML;
    assert.ok(html.indexOf(`Balance ${expected[0]}<`) < html.indexOf(`Balance ${expected[1]}<`));
    assert.ok(html.indexOf(`Balance ${expected[1]}<`) < html.indexOf(`Balance ${expected[2]}<`));
  }
  api.resetPoolFilters();
  assert.match(nodes.get("#pool-body").innerHTML.split("</tr>")[0], /Balance 0</);
});

test("past quota resets are not advertised as the next reset and timestamps support seconds and milliseconds", async () => {
  const now = Date.now();
  const { api, nodes } = loadDashboardUi({ ...dashboard, accounts: [{ ...dashboard.accounts[0], quota: { availability: "available", windows: [{ name: "5h", remainingPercent: 0, resetAt: now - 1000 }] } }] });
  await api.loadDashboard();
  assert.match(nodes.get("#pool-capacity").innerHTML, /暂无未来的账号级重置时间/);
  assert.equal(api.resetMs(now), now);
  assert.equal(api.resetMs(Math.floor(now / 1000)), Math.floor(now / 1000) * 1000);
  assert.ok(Number.isNaN(api.resetMs(0)));
});

test("zero pool balance draws an empty bar and stopped accounts do not count in capacity", async () => {
  const accounts = [
    { ...dashboard.accounts[0], quota: { availability: "available", remainingPercent: 0 } },
    { ...dashboard.accounts[0], key: "stopped", disabled: true, quota: { availability: "disabled", remainingPercent: 100 } }
  ];
  const { api, nodes } = loadDashboardUi({ ...dashboard, accounts });
  await api.loadDashboard();
  assert.match(nodes.get("#pool-capacity").innerHTML, /width: 0\.0%/);
  assert.match(nodes.get("#pool-capacity").innerHTML, /1 个已用尽/);
  assert.match(nodes.get("#pool-status-summary").innerHTML, /手动停用<strong>1/);
});

test("a pending account action remains locked across refreshes and cannot be submitted twice", async () => {
  let resolveRefresh;
  let calls = 0;
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/accounts/account-1/refresh": () => {
    calls += 1;
    return new Promise((resolve) => { resolveRefresh = resolve; });
  } });
  await api.loadDashboard();
  const button = { disabled: false, dataset: { renewAccount: "account-1" }, closest() { return this; } };
  const first = api.renewAccount({ target: button });
  await api.loadDashboard();
  assert.match(nodes.get("#pool-body").innerHTML, /fieldset[^>]*disabled/);
  assert.match(nodes.get("#pool-body").innerHTML, /刷新登录态中/);
  await api.renewAccount({ target: { ...button, disabled: false } });
  assert.equal(calls, 1);
  resolveRefresh(json({ renewed: true }));
  await first;
  assert.doesNotMatch(nodes.get("#pool-body").innerHTML, /fieldset[^>]*disabled/);
  assert.equal(button.disabled, false);
});

test("failed account actions unlock the row and display an error", async () => {
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/accounts/account-1/refresh": () => { throw new Error("offline"); } });
  await api.loadDashboard();
  const button = { disabled: false, dataset: { renewAccount: "account-1" }, closest() { return this; } };
  await api.renewAccount({ target: button });
  assert.equal(nodes.get("#notice").dataset.state, "error");
  assert.doesNotMatch(nodes.get("#pool-body").innerHTML, /fieldset[^>]*disabled/);
  assert.equal(button.disabled, false);
});

test("account pool flags upcoming subscription expiry without calling it login renewal", async () => {
  const account = { ...dashboard.accounts[0], identity: { ...dashboard.accounts[0].identity, subscriptionExpiresAt: new Date(Date.now() + 86400000).toISOString() } };
  const { api, nodes } = loadDashboardUi({ ...dashboard, accounts: [account] });
  await api.loadDashboard();
  assert.match(nodes.get("#pool-body").innerHTML, /7 天内到期/);
  assert.match(nodes.get("#pool-body").innerHTML, /刷新登录态，不延长订阅/);
  assert.doesNotMatch(nodes.get("#pool-body").innerHTML, /会使用上游调用额度/);
});

test("the usage log names the account by mailbox and reports the thinking level", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();
  api.setView("usageLog");
  await api.loadUsageLog();

  const html = nodes.get("#usage-log-body").innerHTML;
  assert.match(html, /user@example\.test/);
  // The account column must not fall back to the raw Mirasim user id.
  assert.doesNotMatch(html, /user-a/);
  assert.match(html, /class="badge good">high<\/span>/);
  assert.match(html, /class="badge bad">max<\/span>/);
  assert.doesNotMatch(html, /(?:low|medium|high|xhigh|max) \d+\/\d+/);
  assert.match(html, /8192 tokens/);
  assert.match(html, /关闭/);
  assert.match(html, /未指定（上游默认）/);
  // A caller whose ask was not what the model was told gets both, and one whose ask was
  // honoured is not told twice.
  assert.match(html, /请求 自适应/);
  assert.doesNotMatch(html, /请求 high/);
  // The speed column was dropped, so no row may still report a rate.
  assert.doesNotMatch(html, /tok\/s/);
  assert.equal(rowColumnCount(html), usageLogColumnCount());
});

test("the usage log shows and filters by the API key that made each request", async () => {
  const production = { ...usageLog.entries[0], id: 1, apiKey: { id: "key-prod", name: "Production", prefix: "msk_prod..." } };
  const revoked = { ...usageLog.entries[0], id: 2, apiKey: { id: "key-old", name: "Old laptop", prefix: "msk_old..." } };
  const anonymous = { ...usageLog.entries[0], id: 3, status: 401, apiKey: null };
  const { api, nodes } = loadDashboardUi(dashboard, {
    "/api/keys": () => json({ keys: [{ id: "key-prod", name: "Production (renamed)", prefix: "msk_prod...", createdAt: "2026-08-09T00:00:00.000Z" }] }),
    "/api/usage-log": () => json({ entries: [production, revoked, anonymous] })
  });
  await api.loadDashboard();
  await api.loadUsageLog();
  const html = nodes.get("#usage-log-body").innerHTML;
  assert.match(html, /Production \(renamed\)/, "the current name of a key wins over the one logged");
  assert.match(html, /Old laptop<\/strong><span class="account-sub"><code>msk_old\.\.\.<\/code> · 已吊销/);
  assert.match(html, /密钥无效或缺失/);
  assert.equal(rowColumnCount(html), usageLogColumnCount());
  assert.match(nodes.get("#usage-log-api-key").innerHTML, /Old laptop · msk_old\.\.\.（已吊销）/);

  nodes.get("#usage-log-api-key").value = "key-old";
  api.updateUsageLogFilters();
  assert.match(nodes.get("#usage-log-body").innerHTML, /Old laptop/);
  assert.doesNotMatch(nodes.get("#usage-log-body").innerHTML, /Production/);

  nodes.get("#usage-log-api-key").value = "none";
  api.updateUsageLogFilters();
  assert.match(nodes.get("#usage-log-body").innerHTML, /密钥无效或缺失/);
  assert.doesNotMatch(nodes.get("#usage-log-body").innerHTML, /Old laptop|Production/);

  nodes.get("#usage-log-api-key").value = "all";
  nodes.get("#usage-log-search").value = "msk_prod";
  api.updateUsageLogFilters();
  assert.match(nodes.get("#usage-log-body").innerHTML, /Production/);
  assert.doesNotMatch(nodes.get("#usage-log-body").innerHTML, /Old laptop/);
});

test("the usage log distinguishes Codex ultra from the upstream max rung", async () => {
  const entry = { ...usageLog.entries[0], reasoningEffort: "ultra", thinkingLevel: "max" };
  const { api, nodes } = loadDashboardUi(dashboard, {
    "/api/usage-log": () => json({ ...usageLog, entries: [entry] })
  });
  await api.loadUsageLog();
  const html = nodes.get("#usage-log-body").innerHTML;
  assert.match(html, /class="badge bad">max<\/span>/);
  assert.match(html, /请求 ultra<\/span>/);
});

test("the usage log distinguishes Claude Code ultracode from xhigh", async () => {
  const entry = { ...usageLog.entries[0], model: "claude-opus-4-6", reasoningEffort: "ultracode", thinkingLevel: "xhigh" };
  const { api, nodes } = loadDashboardUi(dashboard, {
    "/api/usage-log": () => json({ ...usageLog, entries: [entry] })
  });
  await api.loadUsageLog();
  const html = nodes.get("#usage-log-body").innerHTML;
  assert.match(html, /class="badge warning">xhigh<\/span>/);
  assert.match(html, /请求 ultracode<\/span>/);
});

test("the rotation mode selector shows what the pool is doing", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadRotationMode();
  api.setView("accountPool");

  // The stored mode is what the control shows. What the choice costs is left to the capacity
  // cards it now sits beside, so nothing here restates it in prose.
  assert.equal(nodes.get("#rotation-mode").value, "spread");

  nodes.get("#rotation-mode").value = "waterfall";
  await api.saveRotationMode();
  assert.equal(nodes.get("#rotation-mode").value, "waterfall");
  assert.match(nodes.get("#notice").textContent, /轮询模式已切换/);
  // The control is released again, so a second change is possible without a reload.
  assert.equal(nodes.get("#rotation-mode").disabled, false);
});

test("zero usage with actual content is not presented as an empty reply", async () => {
  const entry = { ...usageLog.entries[0], stream: false, upstreamStream: true, outputTokens: 0, textCharacters: 2, reasoningCharacters: 7 };
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => json({ entries: [entry] }) });
  await api.loadDashboard();
  api.setView("usageLog");
  await api.loadUsageLog();
  const html = nodes.get("#usage-log-body").innerHTML;
  assert.match(html, /上游 SSE · 客户端 JSON/);
  assert.match(html, /有内容 · 文本 2 字 · 思考 7 字/);
});

test("pending requests display their current stage and elapsed time rather than HTTP success", async () => {
  const entry = { ...usageLog.entries[0], pending: true, status: 200, stage: "reasoning", elapsedMs: 61000, lastEvent: "response.reasoning_summary_text.delta" };
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => json({ entries: [entry] }) });
  await api.loadDashboard();
  api.setView("usageLog");
  await api.loadUsageLog();
  const html = nodes.get("#usage-log-body").innerHTML;
  assert.match(html, /进行中/);
  assert.match(html, /上游推理中/);
  assert.match(html, /response.reasoning_summary_text.delta/);
  assert.doesNotMatch(html, /HTTP 200/);
});

test("the usage log paginates the retained entries", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();
  api.setView("usageLog");
  await api.loadUsageLog();

  assert.match(nodes.get("#usage-log-page-summary").textContent, /1-20 \/ 25 条/);
  assert.equal(nodes.get("#usage-log-page-prev").disabled, true);
  assert.equal(nodes.get("#usage-log-page-next").disabled, false);
  assert.match(nodes.get("#usage-log-body").innerHTML, /model-1</);
  assert.doesNotMatch(nodes.get("#usage-log-body").innerHTML, /model-21</);

  api.changeUsageLogPage(1);
  assert.match(nodes.get("#usage-log-page-summary").textContent, /21-25 \/ 25 条/);
  assert.match(nodes.get("#usage-log-body").innerHTML, /model-21</);
  assert.doesNotMatch(nodes.get("#usage-log-body").innerHTML, /model-1</);
  assert.equal(nodes.get("#usage-log-page-next").disabled, true);
});

test("an empty usage log spans every column of the table", async () => {
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => json({ entries: [] }) });
  await api.loadDashboard();
  api.setView("usageLog");
  await api.loadUsageLog();

  assert.match(nodes.get("#usage-log-body").innerHTML, new RegExp(`<td colspan="${usageLogColumnCount()}"`));
  assert.equal(nodes.get("#usage-log-page-summary").textContent, "暂无记录");
  assert.equal(nodes.get("#usage-log-page-next").disabled, true);
});

test("usage filters search resolved accounts, combine protocol and status, and reset pagination", async () => {
  const entries = usageLog.entries.map((entry, index) => ({ ...entry, protocol: index < 2 ? "Anthropic" : "OpenAI Chat", pending: index === 0 }));
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => json({ entries }) });
  await api.loadDashboard();
  await api.loadUsageLog();
  api.changeUsageLogPage(1);
  nodes.get("#usage-log-search").value = "USER@EXAMPLE.TEST";
  nodes.get("#usage-log-protocol").value = "Anthropic";
  nodes.get("#usage-log-status").value = "pending";
  api.updateUsageLogFilters();
  assert.equal(nodes.get("#usage-log-page-summary").textContent, "1-1 / 1 条");
  assert.match(nodes.get("#usage-log-body").innerHTML, /model-1</);
  assert.doesNotMatch(nodes.get("#usage-log-body").innerHTML, /model-2</);
  assert.match(nodes.get("#usage-log-summary").innerHTML, /1 条进行中/);
  assert.match(nodes.get("#usage-log-summary").innerHTML, /0 \/ 0 条已结束请求成功/);
  api.resetUsageLogFilters();
  assert.equal(nodes.get("#usage-log-page-summary").textContent, "1-20 / 25 条");
});

test("HTTP 200 does not turn incomplete or failed streams into successful requests", async () => {
  const entries = [
    { ...usageLog.entries[0], id: 1, stage: "completed", durationMs: 1000 },
    { ...usageLog.entries[0], id: 2, stage: "incomplete", durationMs: 2000 },
    { ...usageLog.entries[0], id: 3, stage: "completed", streamError: "upstream_stream_incomplete", durationMs: 3000 },
    { ...usageLog.entries[0], id: 4, stage: "client_disconnected", status: 499, durationMs: 4000 },
    { ...usageLog.entries[0], id: 5, pending: true, durationMs: null, elapsedMs: 100000 }
  ];
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => json({ entries }) });
  await api.loadUsageLog();
  const summary = nodes.get("#usage-log-summary").innerHTML;
  assert.match(summary, /25\.0%/);
  assert.match(summary, /1 \/ 4 条已结束请求成功/);
  assert.match(summary, /2\.5 秒/);
  const html = nodes.get("#usage-log-body").innerHTML;
  assert.match(html, /未完整结束 · HTTP 200/);
  assert.match(html, /失败 · HTTP 200/);
  for (const [status, id] of [["incomplete", 2], ["failed", 3], ["cancelled", 4]]) {
    nodes.get("#usage-log-status").value = status;
    api.updateUsageLogFilters();
    assert.equal(nodes.get("#usage-log-page-summary").textContent, "1-1 / 1 条");
    assert.match(nodes.get("#usage-log-body").innerHTML, new RegExp(`data-usage-detail="${id}"`));
  }
});

test("usage sorting compares pending elapsed time and output token counts", async () => {
  const entries = [
    { ...usageLog.entries[0], id: 1, pending: true, elapsedMs: 9000, outputTokens: null },
    { ...usageLog.entries[1], id: 2, durationMs: 1000, outputTokens: 500 },
    { ...usageLog.entries[2], id: 3, durationMs: 5000, outputTokens: 200 }
  ];
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => json({ entries }) });
  await api.loadUsageLog();
  nodes.get("#usage-log-sort").value = "duration";
  api.updateUsageLogFilters();
  assert.match(nodes.get("#usage-log-body").innerHTML.split("</tr>")[0], /data-usage-detail="1"/);
  nodes.get("#usage-log-sort").value = "tokens";
  api.updateUsageLogFilters();
  assert.match(nodes.get("#usage-log-body").innerHTML.split("</tr>")[0], /data-usage-detail="2"/);
});

test("filtered empty states differ from a request history with no records", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadUsageLog();
  nodes.get("#usage-log-search").value = "no-such-model";
  api.updateUsageLogFilters();
  assert.match(nodes.get("#usage-log-body").innerHTML, /没有符合当前筛选条件/);
  assert.equal(nodes.get("#usage-log-page-next").disabled, true);
  assert.match(nodes.get("#usage-log-filter-summary").textContent, /当前筛选 0 \/ 已保留 25/);
});

test("usage refresh failures preserve entries and do not report a new successful update", async () => {
  let fail = false;
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => {
    if (fail) throw new Error("offline");
    return json(usageLog);
  } });
  await api.loadUsageLog();
  fail = true;
  await api.loadUsageLog();
  assert.match(nodes.get("#usage-log-updated").textContent, /保留上次结果/);
  assert.match(nodes.get("#usage-log-body").innerHTML, /model-1</);
  assert.equal(nodes.get("#usage-log-refresh").disabled, false);
  fail = false;
  await api.loadUsageLog();
  assert.doesNotMatch(nodes.get("#usage-log-updated").textContent, /保留上次结果/);
});

test("usage initial failures show an error rather than a successful empty history", async () => {
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => { throw new Error("offline"); } });
  await api.loadUsageLog();
  assert.match(nodes.get("#usage-log-body").innerHTML, /暂时无法加载/);
  assert.match(nodes.get("#usage-log-updated").textContent, /重试/);
});

test("concurrent usage refreshes share one request and pause state is visible", async () => {
  let resolveRequest;
  let calls = 0;
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => {
    calls += 1;
    return new Promise((resolve) => { resolveRequest = resolve; });
  } });
  const first = api.loadUsageLog();
  const second = api.loadUsageLog();
  assert.equal(calls, 1);
  assert.equal(nodes.get("#usage-log-refresh").disabled, true);
  resolveRequest(json(usageLog));
  await Promise.all([first, second]);
  api.toggleUsageLogPause();
  assert.equal(nodes.get("#usage-log-pause").textContent, "继续刷新");
  assert.equal(nodes.get("#usage-log-pause")["aria-pressed"], "true");
  assert.match(nodes.get("#usage-log-updated").textContent, /已暂停/);
});

test("usage protocol comes from the client path and exposes a separate upstream protocol", async () => {
  const entries = [{ ...usageLog.entries[0], clientPath: "/v1/responses", protocol: "Anthropic", upstreamPath: "/v1/messages", upstreamProtocol: "Anthropic", requestId: "req_correlation" }];
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => json({ entries }) });
  await api.loadDashboard();
  await api.loadUsageLog();
  assert.match(nodes.get("#usage-log-body").innerHTML, /OpenAI Responses/);
  nodes.get("#usage-log-search").value = "req_correlation";
  nodes.get("#usage-log-protocol").value = "OpenAI Responses";
  api.updateUsageLogFilters();
  assert.equal(nodes.get("#usage-log-page-summary").textContent, "1-1 / 1 条");
  api.selectUsageLogEntry("1");
  const detail = nodes.get("#usage-log-detail-body").innerHTML;
  assert.match(detail, /本机请求 ID/);
  assert.match(detail, /req_correlation/);
  assert.match(detail, /上游协议/);
  assert.match(detail, /Anthropic/);
  assert.match(detail, /\/v1\/responses/);
});

test("all backend-recognized protocol paths render and filter without becoming unknown", async () => {
  const paths = ["/v1/messages", "/v1/chat/completions", "/v1/responses", "/backend-api/codex/responses", "/v1/images/generations", "/v1/images/edits", "/backend-api/codex/images/generations", "/backend-api/codex/images/edits", "/v1/alpha/search", "/backend-api/codex/alpha/search", "/v1/responses/compact", "/backend-api/codex/responses/compact"];
  const log = new RelayRequestLog();
  for (const path of paths) {
    const entry = log.open(path + "?test=1", '{"model":"gpt-6-astra"}', null, { upstreamPath: "/v1/responses" });
    const entries = [{ ...usageLog.entries[0], ...entry, status: 200, pending: false }];
    const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => json({ entries }) });
    await api.loadDashboard();
    await api.loadUsageLog();
    assert.match(nodes.get("#usage-log-body").innerHTML, new RegExp(entry.protocol));
    assert.doesNotMatch(nodes.get("#usage-log-body").innerHTML, /未知协议/);
    nodes.get("#usage-log-protocol").value = entry.protocol;
    api.updateUsageLogFilters();
    assert.equal(nodes.get("#usage-log-page-summary").textContent, "1-1 / 1 条", path);
    api.selectUsageLogEntry(String(entry.id));
    assert.match(nodes.get("#usage-log-detail-body").innerHTML, /OpenAI Responses/);
  }
});

test("historical unknown labels recover by exact path without misclassifying arbitrary responses paths", async () => {
  const entries = [
    { ...usageLog.entries[0], id: 1, path: "/v1/images/edits", protocol: "未知协议" },
    { ...usageLog.entries[0], id: 2, path: "/not-supported/responses", protocol: null },
    { ...usageLog.entries[0], id: 3, clientPath: "/future/endpoint", protocol: "Future Protocol" }
  ];
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => json({ entries }) });
  await api.loadDashboard();
  await api.loadUsageLog();
  for (const protocol of ["OpenAI Images", "未知协议", "Future Protocol"]) {
    nodes.get("#usage-log-protocol").value = protocol;
    api.updateUsageLogFilters();
    assert.equal(nodes.get("#usage-log-page-summary").textContent, "1-1 / 1 条");
  }
});

test("protocol filter includes image/search and historical compact entries", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  for (const label of ["OpenAI Images", "OpenAI Search", "OpenAI Compact", "未知协议"]) assert.ok(html.includes(`value="${label}"`));
});

test("GPT timing rows distinguish first byte, visible text and completion", async () => {
  const entries = [{ ...usageLog.entries[0], ttfbMs: 100, firstOutputMs: 500, firstTextMs: 1500, durationMs: 5000 }];
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => json({ entries }) });
  await api.loadDashboard();
  await api.loadUsageLog();
  assert.match(nodes.get("#usage-log-body").innerHTML, /首字节/);
  assert.match(nodes.get("#usage-log-body").innerHTML, /首正文/);
  api.selectUsageLogEntry("1");
  const detail = nodes.get("#usage-log-detail-body").innerHTML;
  assert.match(detail, /上游首字节/);
  assert.match(detail, /上游首输出（含思考\/工具）/);
  assert.match(detail, /上游首正文/);
});

test("parameter diagnostics show changes and escape untrusted field names", async () => {
  const entries = [{ ...usageLog.entries[0], parameterDiagnostics: [{ parameter: "temperature", status: "omitted" }, { parameter: '<img src=x onerror="alert(1)">', status: "related_fields", targets: ["<script>"] }] }];
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => json({ entries }) });
  await api.loadDashboard();
  await api.loadUsageLog();
  api.selectUsageLogEntry("1");
  const detail = nodes.get("#usage-log-detail-body").innerHTML;
  assert.match(detail, /参数转发诊断/);
  assert.match(detail, /temperature：未直传上游/);
  assert.match(detail, /&lt;img/);
  assert.doesNotMatch(detail, /<img|<script>/);
});

test("usage details escape diagnostic values, preserve selection on refresh and handle expired records", async () => {
  let entries = [{ ...usageLog.entries[0], upstreamRequestId: '<img src=x onerror="alert(1)">', toolNames: ["Read"], calledTools: ["Read"], attempts: [{ account: "user-a", priority: 25, status: 503, at: usageLog.entries[0].at }], finishReason: "tool_calls" }];
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => json({ entries }) });
  await api.loadDashboard();
  await api.loadUsageLog();
  api.selectUsageLogEntry("1");
  assert.equal(nodes.get("#usage-log-detail").hidden, false);
  const detail = nodes.get("#usage-log-detail-body").innerHTML;
  assert.match(detail, /&lt;img/);
  assert.doesNotMatch(detail, /<img/);
  assert.match(detail, /user@example\.test/);
  assert.match(detail, /HTTP 503/);
  assert.match(detail, /tool_calls/);
  assert.match(detail, /Token 口径/);
  assert.match(detail, /上游输入（含缓存）/);
  assert.match(detail, /非缓存输入/);
  await api.loadUsageLog();
  assert.equal(nodes.get("#usage-log-detail").hidden, false);
  entries = [];
  await api.loadUsageLog();
  assert.match(nodes.get("#usage-log-detail-body").innerHTML, /已不在最近保留的明细/);
  api.selectUsageLogEntry(null);
  assert.equal(nodes.get("#usage-log-detail").hidden, true);
});

test("missing token counts remain unknown rather than becoming zero in summary cards", async () => {
  const entries = [{ ...usageLog.entries[0], inputTokens: null, outputTokens: 0 }];
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => json({ entries }) });
  await api.loadUsageLog();
  assert.match(nodes.get("#usage-log-summary").innerHTML, /— \/ 0/);
});

test("reused request IDs after restart do not replace the selected request details", async () => {
  let entries = [usageLog.entries[0]];
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => json({ entries }) });
  await api.loadUsageLog();
  api.selectUsageLogEntry("1");
  entries = [{ ...entries[0], at: "2026-09-21T04:00:00.000Z", upstreamRequestId: "different-request" }];
  await api.loadUsageLog();
  assert.match(nodes.get("#usage-log-detail-body").innerHTML, /已不在最近保留的明细/);
  assert.doesNotMatch(nodes.get("#usage-log-detail-body").innerHTML, /different-request/);
});

// The priority column made the pool table eight columns wide; the empty state has to follow the header.
function poolColumnCount() {
  return columnCount("pool-table");
}

test("usage statistics omit dollar estimates supplied by the backend", async () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /usage-cost-summary|usage-cost-note|美元额度预估/);
  const costSummary = { windows: [
    { key: "fiveHours", amountUsd: 1.2345, requests: 3, estimatedRequests: 2, unestimatedRequests: 1 },
    { key: "sevenDays", amountUsd: 15, requests: 10, estimatedRequests: 9, unestimatedRequests: 1 }
  ] };
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/usage-log": () => json({ ...usageLog, costSummary }) });
  await api.loadUsageLog();
  assert.equal(nodes.has("#usage-cost-summary"), false);
  assert.equal(nodes.has("#usage-cost-note"), false);
  assert.match(nodes.get("#usage-log-summary").innerHTML, /当前筛选请求/);
  assert.match(nodes.get("#usage-log-summary").innerHTML, /Token/);
  nodes.get("#usage-log-search").value = "no-matching-request";
  api.updateUsageLogFilters();
  await api.loadUsageLog();
  assert.equal(nodes.has("#usage-cost-summary"), false);
  assert.equal(nodes.has("#usage-cost-note"), false);
});

test("quota summary is removed while individual account quota windows remain", async () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /pool-quota-totals|额度汇总/);
  const data = structuredClone(dashboard);
  data.accounts[0].quota.windows = [{ name: "7d_fable", modelScoped: true, remainingPercent: 75 }];
  const { api, nodes } = loadDashboardUi(data);
  await api.loadDashboard();
  assert.match(nodes.get("#pool-body").innerHTML, /7d_fable/);
  assert.match(nodes.get("#pool-body").innerHTML, /剩余 75%/);
});

test("older backends show a clear upgrade message instead of silently disabling selection", async () => {
  const data = structuredClone(dashboard);
  const { api, nodes } = loadDashboardUi(data);
  await api.loadDashboard();
  assert.equal(nodes.get("#pool-selection-warning").hidden, false);
  assert.match(nodes.get("#pool-selection-warning").textContent, /后端版本尚未更新/);
  assert.equal(nodes.get("#pool-select-page").disabled, true);
  data.accounts[0].selectionId = "stable-one";
  await api.loadDashboard();
  assert.equal(nodes.get("#pool-selection-warning").hidden, true);
  assert.equal(nodes.get("#pool-select-page").disabled, false);
  assert.match(nodes.get("#pool-body").innerHTML, /<label class="pool-account-choice">/);
  api.selectPoolAccount({ target: { closest: () => ({ dataset: { selectAccount: "stable-one" }, checked: true }) } });
  assert.equal(nodes.get("#pool-selection-count").textContent, "已选 1 个账号");
});

test("pool selection persists across pages and filters and tracks current identities", async () => {
  const data = structuredClone(dashboard);
  data.accounts = Array.from({ length: 12 }, (_, index) => ({ ...dashboard.accounts[0], key: `account-${index + 1}`, selectionId: `stable-${index}`, identity: { name: `Member ${index}` } }));
  const { api, nodes } = loadDashboardUi(data);
  await api.loadDashboard();
  api.selectPoolAccounts("page", true);
  assert.equal(nodes.get("#pool-selection-count").textContent, "已选 10 个账号");
  assert.equal(nodes.get("#pool-select-page").checked, true);
  api.changePoolPage(1);
  assert.equal(nodes.get("#pool-select-page").checked, false);
  api.selectPoolAccount({ target: { closest: () => ({ dataset: { selectAccount: "stable-10" }, checked: true }) } });
  assert.equal(nodes.get("#pool-select-page").indeterminate, true);
  nodes.get("#pool-search").value = "Member 11";
  api.setPoolFilters();
  assert.match(nodes.get("#pool-selection-count").textContent, /11 个不在当前筛选/);
  api.selectPoolAccounts("filtered", true);
  assert.match(nodes.get("#pool-selection-count").textContent, /已选 12/);
  data.accounts.shift();
  data.accounts.forEach((account, index) => { account.key = `account-${index + 1}`; });
  await api.loadDashboard();
  assert.match(nodes.get("#pool-selection-count").textContent, /已选 11/);
  api.selectPoolAccounts("clear", false);
  assert.equal(nodes.get("#pool-selection-count").textContent, "已选 0 个账号");
  assert.equal(nodes.get("#pool-bulk-delete").disabled, true);
});

test("bulk actions submit selected identities once and retain failed selections", async () => {
  const data = structuredClone(dashboard);
  data.accounts = [1, 2].map((index) => ({ ...dashboard.accounts[0], key: `account-${index}`, selectionId: `stable-${index}` }));
  let submitted;
  let finish;
  let calls = 0;
  const { api, nodes } = loadDashboardUi(data, { "/api/accounts/bulk": (options) => {
    calls += 1;
    submitted = JSON.parse(options.body);
    return new Promise((resolve) => { finish = resolve; });
  } });
  await api.loadDashboard();
  api.selectPoolAccounts("filtered", true);
  const pending = api.bulkPoolAccounts("disable");
  assert.equal(nodes.get("#pool-bulk-delete").disabled, true);
  await api.bulkPoolAccounts("delete");
  assert.equal(calls, 1);
  assert.deepEqual(submitted, { action: "disable", accounts: [{ key: "account-1", selectionId: "stable-1" }, { key: "account-2", selectionId: "stable-2" }] });
  finish(json({ results: [{ selectionId: "stable-1", ok: true }, { selectionId: "stable-2", ok: false, error: "retry" }] }));
  await pending;
  assert.equal(nodes.get("#pool-selection-count").textContent, "已选 1 个账号");
  assert.match(nodes.get("#notice").textContent, /成功 1 个，失败 1 个/);
  assert.equal(nodes.get("#pool-bulk-disable").disabled, false);
});

test("cancelling a bulk delete makes no request and preserves selection", async () => {
  const data = structuredClone(dashboard);
  data.accounts[0].selectionId = "stable-one";
  let calls = 0;
  const { api, nodes } = loadDashboardUi(data, { "/api/accounts/bulk": () => { calls += 1; return json({ results: [] }); } }, () => false);
  await api.loadDashboard();
  api.selectPoolAccounts("page", true);
  await api.bulkPoolAccounts("delete");
  assert.equal(calls, 0);
  assert.equal(nodes.get("#pool-selection-count").textContent, "已选 1 个账号");
  assert.equal(nodes.get("#pool-bulk-delete").disabled, false);
});

test("failed bulk requests unlock controls without dropping selected accounts", async () => {
  const data = structuredClone(dashboard);
  data.accounts[0].selectionId = "stable-one";
  const { api, nodes } = loadDashboardUi(data, { "/api/accounts/bulk": () => { throw new Error("offline"); } });
  await api.loadDashboard();
  api.selectPoolAccounts("page", true);
  await api.bulkPoolAccounts("recover");
  assert.equal(nodes.get("#pool-selection-count").textContent, "已选 1 个账号");
  assert.equal(nodes.get("#pool-bulk-recover").disabled, false);
  assert.match(nodes.get("#notice").textContent, /网络请求失败/);
});

function usageLogColumnCount() {
  return columnCount("usage-log-table");
}

function columnCount(className) {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const header = new RegExp(`<table class="${className}"><thead><tr>([\\s\\S]*?)</tr>`).exec(html);
  assert.ok(header, `${className} header should be present`);
  return header[1].split("<th").length - 1;
}

function rowColumnCount(html) {
  const row = /<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/.exec(html);
  assert.ok(row, "at least one row should be rendered");
  return row[1].split("<td").length - 1;
}

test("overview shows workspace counts and handles empty token totals", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();
  assert.equal(nodes.get("#overview-pulse-title").textContent, "1 个账号当前可用");
  assert.match(nodes.get("#overview-workspace").innerHTML, /1 \/ 1 个可用/);
  assert.match(nodes.get("#overview-token-mix").innerHTML, /66\.7%/);
  assert.doesNotMatch(nodes.get("#overview-token-mix").innerHTML, /NaN|Infinity/);
  const empty = loadDashboardUi({ ...dashboard, accounts: [] });
  await empty.api.loadDashboard();
  assert.equal(empty.nodes.get("#overview-pulse-title").textContent, "暂无可用账号");
  assert.match(empty.nodes.get("#overview-token-mix").innerHTML, /还没有 Token 用量/);
});

test("key list filters, sorts and paginates", async () => {
  const keys = Array.from({ length: 12 }, (_, index) => ({ id: `key-${index}`, name: `Client ${String(index).padStart(2, "0")}`, prefix: `msk_${index}`, createdAt: new Date(2026, 0, index + 1).toISOString(), lastUsedAt: index % 2 ? null : "2026-08-09T00:00:00.000Z", copyable: index % 2 === 0 }));
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/keys": () => json({ keys }) });
  await api.loadDashboard();
  assert.match(nodes.get("#api-key-page-summary").textContent, /12 \/ 12 项 · 第 1 \/ 2 页/);
  assert.equal((nodes.get("#api-key-list").innerHTML.match(/<tr>/g) || []).length, 10);
  api.changeConsolePage("apiKey", 1);
  assert.equal((nodes.get("#api-key-list").innerHTML.match(/<tr>/g) || []).length, 2);
  assert.equal(nodes.get("#api-key-page-next").disabled, true);
  nodes.get("#api-key-status").value = "used";
  nodes.get("#api-key-sort").value = "name";
  api.updateConsoleFilters("apiKey");
  assert.match(nodes.get("#api-key-page-summary").textContent, /6 \/ 12 项 · 第 1 \/ 1 页/);
  assert.ok(nodes.get("#api-key-list").innerHTML.indexOf("Client 00") < nodes.get("#api-key-list").innerHTML.indexOf("Client 02"));
  nodes.get("#api-key-search").value = "MSK_10";
  api.updateConsoleFilters("apiKey");
  assert.match(nodes.get("#api-key-list").innerHTML, /Client 10/);
  assert.doesNotMatch(nodes.get("#api-key-list").innerHTML, /Client 00/);
  nodes.get("#api-key-search").value = "nothing";
  api.updateConsoleFilters("apiKey");
  assert.match(nodes.get("#api-key-list").innerHTML, /没有匹配的密钥/);
  api.resetConsoleFilters("apiKey");
  assert.equal(nodes.get("#api-key-search").value, "");
  assert.match(nodes.get("#api-key-page-summary").textContent, /12 \/ 12/);
});

test("key secrets clear on hide and navigation, and creation resets filters", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();
  api.setView("apiKeys");
  nodes.get("#api-key-search").value = "not-matching";
  api.updateConsoleFilters("apiKey");
  await api.createApiKey({ preventDefault() {} });
  assert.equal(nodes.get("#api-key-search").value, "");
  assert.match(nodes.get("#api-key-list").innerHTML, /Local client/);
  assert.doesNotMatch(nodes.get("#api-key-list").innerHTML, /msk_test_complete_key/);
  api.dismissApiKey();
  assert.equal(nodes.get("#api-key-reveal").hidden, true);
  assert.equal(nodes.get("#api-key-value").textContent, "");
  await api.createApiKey({ preventDefault() {} });
  api.setView("overview");
  assert.equal(nodes.get("#api-key-value").textContent, "");
});

test("failed revocation restores its button and success clears the secret", async () => {
  let fail = true;
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/keys/key-test": () => {
    if (fail) throw new Error("offline");
    return json({ deleted: true });
  } });
  await api.loadDashboard();
  await api.createApiKey({ preventDefault() {} });
  const button = { dataset: { keyId: "key-test" }, disabled: false, textContent: "吊销" };
  const event = { target: { closest: () => button } };
  await api.revokeApiKey(event);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "吊销");
  fail = false;
  await api.revokeApiKey(event);
  assert.equal(nodes.get("#api-key-value").textContent, "");
  assert.match(nodes.get("#api-key-list").innerHTML, /尚未生成 API Key/);
});

test("model filters prioritize issues and put missing latency last", async () => {
  const models = [
    { id: "z-fast", status: "healthy", latencyMs: 5 },
    { id: "a-unknown", status: "pending", latencyMs: null },
    { id: "b-auth", status: "unauthorized", latencyMs: 200, message: '<img src=x onerror="alert(1)">' },
    { id: "c-limited", status: "limited", latencyMs: 20 },
    { id: "d-failed", status: "unavailable", latencyMs: 300 }
  ];
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/model-health": () => json({ ...modelHealth, models }) });
  await api.loadDashboard();
  const body = nodes.get("#model-health-body");
  assert.ok(body.innerHTML.indexOf("b-auth") < body.innerHTML.indexOf("z-fast"));
  assert.match(body.innerHTML, /&lt;img/);
  assert.doesNotMatch(body.innerHTML, /<img/);
  nodes.get("#model-health-sort").value = "latency";
  api.updateConsoleFilters("modelHealth");
  assert.ok(body.innerHTML.indexOf("z-fast") < body.innerHTML.indexOf("a-unknown"));
  assert.ok(body.innerHTML.indexOf("d-failed") < body.innerHTML.indexOf("a-unknown"));
  nodes.get("#model-health-status").value = "issues";
  api.updateConsoleFilters("modelHealth");
  assert.match(nodes.get("#model-health-page-summary").textContent, /2 \/ 5 项/);
  assert.doesNotMatch(body.innerHTML, /z-fast|c-limited/);
  nodes.get("#model-health-search").value = "B-AUTH";
  api.updateConsoleFilters("modelHealth");
  assert.match(nodes.get("#model-health-page-summary").textContent, /1 \/ 5 项/);
  nodes.get("#model-health-search").value = "no-results";
  api.updateConsoleFilters("modelHealth");
  assert.match(body.innerHTML, /没有匹配的模型/);
  api.resetConsoleFilters("modelHealth");
  assert.match(nodes.get("#model-health-page-summary").textContent, /5 \/ 5 项/);
});

test("model pagination clamps after directory shrink and poll errors stay visible", async () => {
  let models = Array.from({ length: 21 }, (_, index) => ({ id: `model-${index}`, status: "pending" }));
  let fail = false;
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/model-health": () => {
    if (fail) throw new Error("offline");
    return json({ ...modelHealth, models });
  } });
  await api.loadDashboard();
  api.changeConsolePage("modelHealth", 2);
  assert.match(nodes.get("#model-health-page-summary").textContent, /第 3 \/ 3 页/);
  models = models.slice(0, 1);
  await api.loadModelHealth();
  assert.match(nodes.get("#model-health-page-summary").textContent, /第 1 \/ 1 页/);
  fail = true;
  await api.loadModelHealth();
  assert.equal(nodes.get("#model-health-error").hidden, false);
  assert.match(nodes.get("#model-health-error").textContent, /保留上次结果/);
  assert.match(nodes.get("#model-health-body").innerHTML, /model-0/);
  fail = false;
  await api.loadModelHealth();
  assert.equal(nodes.get("#model-health-error").hidden, true);
});

test("model check locks all actions immediately and rejects duplicate clicks", async () => {
  let finish;
  let calls = 0;
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/model-health/gpt-5.6/check": () => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  } });
  await api.loadDashboard();
  const event = { target: { closest: () => ({ dataset: { modelId: "gpt-5.6" }, disabled: false }) } };
  const checking = api.checkModel(event);
  assert.equal(nodes.get("#model-health-discover").disabled, true);
  assert.match(nodes.get("#model-health-body").innerHTML, /检测中/);
  await api.checkModel(event);
  assert.equal(calls, 1);
  finish(json({ health: modelHealth }));
  await checking;
  assert.equal(nodes.get("#model-health-discover").disabled, false);
  assert.doesNotMatch(nodes.get("#model-health-body").innerHTML, /console-row-pending/);
});

test("sections show loading skeletons until their first response arrives", async () => {
  const { api, nodes } = loadDashboardUi();
  for (const selector of ["#pool-body", "#api-key-list", "#model-health-body"]) assert.match(nodes.get(selector).innerHTML, /skeleton-row/, selector);
  assert.match(nodes.get("#overview-account-count").innerHTML, /skeleton/);
  assert.match(nodes.get("#pool-capacity").innerHTML, /skeleton-card/);

  await api.loadDashboard();
  for (const selector of ["#pool-body", "#api-key-list", "#model-health-body", "#pool-capacity"]) assert.doesNotMatch(nodes.get(selector).innerHTML, /skeleton/, selector);
  assert.equal(nodes.get("#overview-account-count").textContent, "1");

  const loading = api.loadUsageLog();
  assert.match(nodes.get("#usage-log-body").innerHTML, /skeleton-row/);
  assert.match(nodes.get("#usage-log-summary").innerHTML, /skeleton-card/);
  await loading;
  assert.doesNotMatch(nodes.get("#usage-log-body").innerHTML, /skeleton/);
});

test("a failed first load replaces skeletons with an error rather than a spinner forever", async () => {
  const { api, nodes } = loadDashboardUi(dashboard, {
    "/api/dashboard": () => { throw new Error("device session unavailable"); },
    "/api/keys": () => { throw new Error("database unavailable"); },
    "/api/model-health": () => { throw new Error("upstream unavailable"); }
  });
  await api.loadDashboard();
  for (const selector of ["#pool-body", "#api-key-list", "#model-health-body", "#pool-capacity", "#overview-token-mix"]) assert.doesNotMatch(nodes.get(selector).innerHTML, /skeleton/, selector);
});

test("dashboard failure does not hide independently loaded API keys", async () => {
  const key = { id: "persisted", name: "Existing key", prefix: "msk_saved...", createdAt: "2026-08-09T00:00:00Z" };
  const { api, nodes } = loadDashboardUi(dashboard, {
    "/api/dashboard": () => { throw new Error("device session unavailable"); },
    "/api/keys": () => json({ keys: [key] })
  });
  await api.loadDashboard();
  assert.match(nodes.get("#api-key-list").innerHTML, /Existing key/);
  assert.match(nodes.get("#model-health-body").innerHTML, /gpt-5\.6/);
  assert.equal(nodes.get("#overview-account-count").textContent, "—");
  assert.match(nodes.get("#pool-body").innerHTML, /不代表账号已删除/);
  assert.match(nodes.get("#dashboard-sync-status").textContent, /账号数据加载失败/);
  assert.equal(nodes.get("#dashboard-sync-status").hidden, false);
});

test("API key failure preserves accounts and does not claim an empty key list", async () => {
  const { api, nodes } = loadDashboardUi(dashboard, { "/api/keys": () => { throw new Error("offline"); } });
  await api.loadDashboard();
  assert.equal(nodes.get("#overview-account-count").textContent, "1");
  assert.match(nodes.get("#pool-body").innerHTML, /Relay User/);
  assert.match(nodes.get("#api-key-list").innerHTML, /密钥加载失败/);
  assert.doesNotMatch(nodes.get("#api-key-list").innerHTML, /尚未生成 API Key/);
  assert.match(nodes.get("#dashboard-sync-status").textContent, /API 密钥加载失败/);
});

test("partial refresh failure preserves previous records and clears after recovery", async () => {
  let fail = false;
  const { api, nodes } = loadDashboardUi(dashboard, {
    "/api/dashboard": () => { if (fail) throw new Error("offline"); return json(dashboard); },
    "/api/keys": () => { if (fail) throw new Error("offline"); return json({ keys: [{ id: "saved", name: "Keep this key", prefix: "msk_saved..." }] }); }
  });
  await api.loadDashboard();
  fail = true;
  await api.loadDashboard();
  assert.equal(nodes.get("#overview-account-count").textContent, "1");
  assert.match(nodes.get("#api-key-list").innerHTML, /Keep this key/);
  assert.match(nodes.get("#pool-body").innerHTML, /Relay User/);
  assert.equal(nodes.get("#dashboard-sync-status").hidden, false);
  fail = false;
  await api.loadDashboard();
  assert.equal(nodes.get("#dashboard-sync-status").hidden, true);
});

test("keys render without waiting for a slow account endpoint", async () => {
  let finish;
  const { api, nodes } = loadDashboardUi(dashboard, {
    "/api/dashboard": () => new Promise((resolve) => { finish = resolve; }),
    "/api/keys": () => json({ keys: [{ id: "saved", name: "Independent key", prefix: "msk_saved..." }] })
  });
  const loading = api.loadDashboard();
  for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
  assert.match(nodes.get("#api-key-list").innerHTML, /Independent key/);
  finish(json(dashboard));
  await loading;
  assert.equal(nodes.get("#overview-account-count").textContent, "1");
});

test("partial account synchronization is visible without losing the account", async () => {
  const partial = structuredClone(dashboard);
  partial.accounts[0].syncWarnings = [{ field: "limits", upstreamStatus: 503, retryAfterMs: 900_000, message: "上游设备会话暂不可用（HTTP 503），约 15 分钟后可重试。" }];
  const { api, nodes } = loadDashboardUi(partial);
  await api.loadDashboard();
  assert.match(nodes.get("#pool-body").innerHTML, /Relay User/);
  assert.match(nodes.get("#pool-body").innerHTML, /HTTP 503/);
  assert.match(nodes.get("#dashboard-sync-status").textContent, /1 个账号的上游数据未完整同步/);
});

const resetCardFixture = { available: 1, cards: [{ id: "card-one", status: "active", grantedAt: Date.now() - 1000, expiresAt: Date.now() + 86400000 }], history: [] };

test("reset cards are located in the account pool and each row shows the available count", async () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /reset-card-panel|reset-cards-list|reset-cards-history|RESET CARDS|账号重置卡/);
  const data = structuredClone(dashboard);
  data.accounts[0].resetCards = structuredClone(resetCardFixture);
  data.accounts.push({ ...structuredClone(data.accounts[0]), key: "account-2", id: "second", resetCards: { cards: [], history: [] } });
  const { api, nodes } = loadDashboardUi(data);
  await api.loadDashboard();
  const rows = nodes.get("#pool-body").innerHTML;
  assert.match(rows, /data-label="重置卡"><strong>1 张/);
  assert.match(rows, /data-label="重置卡"><strong>0 张/);
  assert.match(rows, /data-reset-account="account-2" disabled/);
  assert.match(rows, /<strong>1 张<\/strong><div class="reset-card-actions"><button class="button button-secondary"/);
  assert.match(rows, /data-refresh-reset-cards="[^"]*"[^>]*>刷新<\/button>/);
  assert.doesNotMatch(rows, /reset-card-refresh|reset-cards-history/);
});

test("account row reset uses known cards without querying their count", async () => {
  const data = structuredClone(dashboard);
  data.accounts.push({ ...structuredClone(data.accounts[0]), key: "account-2", id: "second", selectionId: "second-fingerprint" });
  const cards = structuredClone(resetCardFixture);
  cards.cards.push({ ...cards.cards[0], id: "expires-first", expiresAt: Date.now() + 60000 });
  data.accounts[1].resetCards = cards;
  let posted;
  let confirmation;
  const { api } = loadDashboardUi(data, {
    "/api/reset-cards?account=account-2": () => assert.fail("reset must not query the count"),
    "/api/reset-cards/redeem": (options) => { posted = JSON.parse(options.body); return json({ outcome: "reset", cards: { cards: [], history: [] } }); }
  }, (message) => { confirmation = message; return true; });
  await api.loadDashboard();
  await api.resetAccountQuota({ target: { closest: () => ({ disabled: false, dataset: { resetAccount: "account-2" } }) } });
  assert.deepEqual(posted, { account: "account-2", selectionId: "second-fingerprint", cardId: "expires-first" });
  assert.match(confirmation, /second/);
});

test("the independent row refresh updates counts without redeeming a card", async () => {
  let reads = 0;
  const { api, nodes } = loadDashboardUi(structuredClone(dashboard), {
    "/api/reset-cards?account=account-1": () => { reads++; return json({ cards: resetCardFixture }); },
    "/api/reset-cards/redeem": () => assert.fail("refresh must never redeem")
  });
  await api.loadDashboard();
  await api.refreshAccountResetCards({ target: { closest: () => ({ disabled: false, dataset: { refreshResetCards: "account-1" } }) } });
  assert.equal(reads, 1);
  assert.match(nodes.get("#pool-body").innerHTML, /data-label="重置卡"><strong>1 张/);
  assert.match(nodes.get("#pool-body").innerHTML, /data-refresh-reset-cards="account-1"/);
});

test("campaign clipboard copies the new purchase link, never the legacy invite code", async () => {
  const { api, clipboardWrites } = loadDashboardUi();
  await api.loadDashboard();
  await api.copyInviteCode();
  assert.deepEqual(clipboardWrites, ["https://mirasim.ai/r/go-example"]);
});

test("reset cards require confirmation and do not consume a card when cancelled", async () => {
  let posted = false;
  let confirmation;
  const { api, nodes } = loadDashboardUi(dashboard, {
    "/api/reset-cards?account=account-1": () => json({ cards: resetCardFixture }),
    "/api/reset-cards/redeem": () => { posted = true; return json({ outcome: "reset" }); }
  }, (text) => { confirmation = text; return false; });
  await api.loadDashboard();
  await api.loadResetCards();
  assert.match(nodes.get("#pool-body").innerHTML, /data-label="重置卡"><strong>1 张/);
  await api.redeemResetCard("card-one");
  assert.equal(posted, false);
  assert.match(confirmation, /user-a/);
  assert.match(confirmation, /不可撤销/);
});

test("reset card redemption blocks duplicate clicks and preserves nothingToReset feedback", async () => {
  let finish;
  let posts = 0;
  const { api, nodes } = loadDashboardUi(dashboard, {
    "/api/reset-cards?account=account-1": () => json({ cards: resetCardFixture }),
    "/api/reset-cards/redeem": (options) => {
      posts++;
      assert.deepEqual(JSON.parse(options.body), { account: "account-1", cardId: "card-one" });
      return new Promise((resolve) => { finish = resolve; });
    }
  });
  await api.loadDashboard();
  await api.loadResetCards();
  const pending = api.redeemResetCard("card-one");
  await api.redeemResetCard("card-one");
  assert.equal(posts, 1);
  assert.match(nodes.get("#pool-body").innerHTML, /data-reset-account="account-1" disabled/);
  finish(json({ outcome: "nothingToReset", cards: resetCardFixture }));
  await pending;
  assert.match(nodes.get("#notice").textContent, /未扣除/);
  assert.equal(nodes.has("#reset-cards-list"), false);
});

test("reset card failures invalidate stale buttons and require an explicit refresh", async () => {
  const { api, nodes } = loadDashboardUi(dashboard, {
    "/api/reset-cards?account=account-1": () => json({ cards: resetCardFixture }),
    "/api/reset-cards/redeem": () => { throw new Error("connection lost"); }
  });
  await api.loadDashboard();
  await api.loadResetCards();
  await api.redeemResetCard("card-one");
  assert.match(nodes.get("#notice").textContent, /不要重复提交/);
  assert.match(nodes.get("#pool-body").innerHTML, /data-reset-account="account-1" disabled/);
});

test("switching accounts keeps reset card refresh scoped to its original account", async () => {
  const data = structuredClone(dashboard);
  data.accounts.push({ ...structuredClone(data.accounts[0]), key: "account-2", id: "user-b" });
  let finish;
  const { api, nodes } = loadDashboardUi(data, {
    "/api/reset-cards?account=account-1": () => new Promise((resolve) => { finish = resolve; })
  });
  await api.loadDashboard();
  const pending = api.loadResetCards();
  api.selectAccountForTest("account-2");
  finish(json({ cards: resetCardFixture }));
  await pending;
  assert.equal((nodes.get("#pool-body").innerHTML.match(/data-label="重置卡"><strong>1 张/g) || []).length, 1);
  assert.match(nodes.get("#notice").textContent, /重置卡已刷新，可用 1 张/);
  assert.equal(nodes.has("#reset-cards-list"), false);
});

test("row refresh does not change selection or fetch unrelated dashboard modules", async () => {
  const data = structuredClone(dashboard);
  data.accounts.push({ ...structuredClone(data.accounts[0]), key: "account-2", id: "user-b" });
  let dashboardReads = 0;
  const { api, nodes } = loadDashboardUi(data, {
    "/api/dashboard": () => { dashboardReads++; return json(data); },
    "/api/reset-cards?account=account-2": () => json({ cards: resetCardFixture })
  });
  await api.loadDashboard();
  await api.refreshAccountResetCards({ target: { closest: () => ({ disabled: false, dataset: { refreshResetCards: "account-2" } }) } });
  assert.equal(dashboardReads, 1);
  assert.equal(api.selectedAccountForTest().key, "account-1");
  assert.equal(api.accountsForTest().find((account) => account.key === "account-2").resetCards.cards.length, resetCardFixture.cards.length);
  assert.equal(nodes.get("#notice").dataset.state, "success");
});

test("reset card refresh blocks duplicate reads and invalidates stale cards on failure", async () => {
  let finish;
  let reads = 0;
  const { api, nodes } = loadDashboardUi(structuredClone(dashboard), {
    "/api/reset-cards?account=account-1": () => { reads++; return new Promise((resolve) => { finish = resolve; }); }
  });
  await api.loadDashboard();
  const pending = api.loadResetCards();
  await api.loadResetCards();
  assert.equal(reads, 1);
  assert.match(nodes.get("#pool-body").innerHTML, /data-refresh-reset-cards="account-1"[^>]*disabled/);
  finish(json({ cards: {} }));
  await pending;
  assert.equal(api.selectedAccountForTest().resetCards, null);
  assert.equal(nodes.get("#notice").dataset.state, "error");
  assert.match(nodes.get("#notice").textContent, /数据格式异常/);
  assert.doesNotMatch(nodes.get("#pool-body").innerHTML, /data-refresh-reset-cards="account-1"[^>]*disabled/);
});

test("a stale dashboard snapshot cannot overwrite a completed card-only refresh", async () => {
  let finish;
  let reads = 0;
  const data = structuredClone(dashboard);
  const { api } = loadDashboardUi(data, {
    "/api/dashboard": () => ++reads === 1 ? json(data) : new Promise((resolve) => { finish = resolve; }),
    "/api/reset-cards?account=account-1": () => json({ cards: resetCardFixture })
  });
  await api.loadDashboard();
  const pending = api.loadDashboard();
  await api.loadResetCards();
  finish(json(data));
  await pending;
  assert.equal(api.selectedAccountForTest().resetCards.cards.length, resetCardFixture.cards.length);
});

test("manual dashboard and usage refreshes notify while automatic loads stay quiet", async () => {
  const { api, nodes } = loadDashboardUi();
  nodes.get("#notice").hidden = true;
  await api.loadDashboard();
  await api.loadUsageLog();
  assert.equal(nodes.get("#notice").hidden, true);
  await api.loadDashboard({ notify: true });
  assert.equal(nodes.get("#notice").textContent, "控制台数据已刷新。");
  await api.loadUsageLog({ notify: true });
  assert.equal(nodes.get("#notice").textContent, "使用明细已刷新。");
  assert.equal(nodes.get("#notice").dataset.state, "success");
});

test("manual refresh failures report errors instead of successful completion", async () => {
  const { api, nodes } = loadDashboardUi(dashboard, {
    "/api/keys": () => { throw new Error("keys unavailable"); },
    "/api/usage-log": () => { throw new Error("usage unavailable"); }
  });
  await api.loadDashboard({ notify: true });
  assert.match(nodes.get("#notice").textContent, /部分数据读取失败/);
  assert.equal(nodes.get("#notice").dataset.state, "error");
  await api.loadUsageLog({ notify: true });
  assert.match(nodes.get("#notice").textContent, /网络请求失败/);
  assert.equal(nodes.get("#notice").dataset.state, "error");
});

test("model refresh reports success and upstream errors after completing", async () => {
  let failed = false;
  const { api, nodes } = loadDashboardUi(dashboard, {
    "/api/model-health/discover": () => json({ health: { ...modelHealth, discovering: false, lastError: failed ? "upstream failed" : null } })
  });
  await api.loadDashboard();
  await api.discoverModels();
  assert.equal(nodes.get("#notice").textContent, "模型目录已刷新。");
  failed = true;
  await api.discoverModels();
  assert.equal(nodes.get("#notice").textContent, "upstream failed");
  assert.equal(nodes.get("#notice").dataset.state, "error");
});

test("reset card refresh ignores results when its account key is reused", async () => {
  const data = structuredClone(dashboard);
  let finish;
  let reads = 0;
  const { api, nodes } = loadDashboardUi(data, {
    "/api/dashboard": () => {
      const snapshot = structuredClone(data);
      if (++reads > 1) Object.assign(snapshot.accounts[0], { id: "replacement", selectionId: "replacement-selection", resetCards: null });
      return json(snapshot);
    },
    "/api/reset-cards?account=account-1": () => new Promise((resolve) => { finish = resolve; })
  });
  await api.loadDashboard();
  const pending = api.loadResetCards();
  await api.loadDashboard();
  finish(json({ cards: resetCardFixture }));
  await pending;
  assert.equal(api.selectedAccountForTest().id, "replacement");
  assert.equal(api.selectedAccountForTest().resetCards, null);
  assert.match(nodes.get("#notice").textContent, /账号列表已变化/);
  assert.equal(nodes.get("#notice").dataset.state, "error");
});

test("card refresh updates the live account after a dashboard reload replaces its object", async () => {
  let finish;
  const data = structuredClone(dashboard);
  const { api } = loadDashboardUi(structuredClone(dashboard), {
    "/api/dashboard": () => json(structuredClone(data)),
    "/api/reset-cards?account=account-1": () => new Promise((resolve) => { finish = resolve; })
  });
  await api.loadDashboard();
  const previous = api.selectedAccountForTest();
  const pending = api.loadResetCards();
  await api.loadDashboard();
  assert.notEqual(api.selectedAccountForTest(), previous);
  finish(json({ cards: resetCardFixture }));
  await pending;
  assert.equal(api.selectedAccountForTest().resetCards.cards.length, resetCardFixture.cards.length);
});

test("expired cards cannot be used and card identifiers are HTML escaped", async () => {
  const cards = structuredClone(resetCardFixture);
  cards.cards.push({ ...cards.cards[0], id: "expired", expiresAt: Date.now() - 1 });
  cards.cards[0].id = '\"><img src=x onerror=alert(1)>';
  const { api, nodes } = loadDashboardUi(dashboard, {
    "/api/reset-cards?account=account-1": () => json({ cards })
  });
  await api.loadDashboard();
  await api.loadResetCards();
  assert.doesNotMatch(nodes.get("#pool-body").innerHTML, /<img|data-reset-card="expired"/);
  await api.redeemResetCard("expired");
  assert.match(nodes.get("#pool-body").innerHTML, /data-refresh-reset-cards="account-1"[^>]*>刷新<\/button>/);
});

test("browser refresh restores every dashboard view", async () => {
  const saved = new Map();
  const sessionStorage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value)
  };
  for (const [view, panel] of [
    ["overview", "overview"], ["activity", "activity"], ["apiKeys", "api-keys"],
    ["accountPool", "account-pool"], ["modelHealth", "model-health"], ["usageLog", "usage-log"]
  ]) {
    loadDashboardUi(dashboard, {}, undefined, sessionStorage).api.setView(view);
    let usageRequests = 0;
    const restored = loadDashboardUi(dashboard, {
      "/api/usage-log": () => { usageRequests += 1; return json(usageLog); }
    }, undefined, sessionStorage);
    await restored.api.loadDashboard();
    assert.equal(restored.nodes.get(`#${panel}-view`).hidden, false);
    assert.equal(restored.nodes.get(`#nav-${panel}`)["aria-current"], "page");
    if (view !== "overview") assert.equal(restored.nodes.get("#overview-view").hidden, true);
    assert.equal(usageRequests, view === "usageLog" ? 1 : 0);
  }
});

test("invalid or unavailable view storage falls back safely", () => {
  for (const sessionStorage of [
    undefined,
    { getItem: () => "removed-view", setItem() {} },
    { getItem: () => "__proto__", setItem() {} },
    { getItem() { throw new Error("Storage blocked"); }, setItem() { throw new Error("Storage blocked"); } }
  ]) {
    const { api, nodes } = loadDashboardUi(dashboard, {}, undefined, sessionStorage);
    assert.equal(nodes.get("#overview-view").hidden, false);
    assert.equal(nodes.get("#workspace-location").textContent, "运行概览");
    api.setView("accountPool");
    assert.equal(nodes.get("#account-pool-view").hidden, false);
  }
});

for (const phase of ["fetch", "body"]) {
  test(`dashboard ${phase} deadline releases refresh locks, retains data and ignores a late response`, async () => {
    let hang = false;
    let finish;
    let current = dashboard;
    const ui = loadDashboardUi(dashboard, {
      "/api/dashboard": () => {
        if (!hang) return json(current);
        const pending = new Promise((resolve) => { finish = resolve; });
        return phase === "fetch" ? pending : { ok: true, json: () => pending };
      }
    });
    await ui.api.loadDashboard();
    hang = true;
    const loading = ui.api.loadDashboard();
    await flushUi();
    assert.equal(ui.nodes.get("#refresh").disabled, true);
    assert.equal(ui.api.activeReadsForTest(), 1);
    assert.deepEqual(ui.timers.filter(Boolean).map(({ delay }) => delay), [120_000]);
    ui.fireTimeouts(60_000);
    assert.equal(ui.api.stateForTest().loading, true, "slow dashboard explicitly allows 120 seconds");
    ui.fireTimeouts(120_000);
    await loading;
    assert.equal(ui.api.stateForTest().loading, false);
    assert.equal(ui.nodes.get("#refresh").disabled, false);
    assert.equal(ui.api.activeReadsForTest(), 0);
    assert.equal(ui.api.readLoadsForTest(), 0);
    assert.equal(ui.timers.filter(Boolean).length, 0);
    assert.match(ui.nodes.get("#dashboard-sync-status").textContent, /请求超时/);
    assert.match(ui.nodes.get("#pool-body").innerHTML, /Relay User/);
    assert.equal(ui.requests.filter(({ url }) => url === "/api/dashboard").at(-1).options.signal.aborted, true);

    hang = false;
    current = { ...dashboard, relay: "recovered.example.test" };
    ui.poll(60_000);
    await flushUi();
    assert.equal(ui.nodes.get("#relay-host").textContent, "recovered.example.test");
    assert.equal(ui.nodes.get("#dashboard-sync-status").hidden, true);
    const stale = { ...dashboard, relay: "stale.example.test" };
    finish(phase === "fetch" ? json(stale) : stale);
    await flushUi();
    assert.equal(ui.nodes.get("#relay-host").textContent, "recovered.example.test");
    assert.deepEqual(ui.redirects, []);
  });
}

test("ordinary GET body deadlines preserve usage and model results and unlock the next poll", async () => {
  let hang = false;
  const stalled = { ok: true, json: () => new Promise(() => {}) };
  const ui = loadDashboardUi(dashboard, {
    "/api/usage-log": () => hang ? stalled : json(usageLog),
    "/api/model-health": () => hang ? stalled : json(modelHealth)
  });
  await ui.api.loadUsageLog();
  await ui.api.loadModelHealth();
  const loadedAt = ui.api.stateForTest().usageLogLoadedAt;
  hang = true;
  const loads = [ui.api.loadUsageLog(), ui.api.loadModelHealth()];
  await flushUi();
  assert.deepEqual(ui.timers.filter(Boolean).map(({ delay }) => delay), [60_000, 60_000]);
  ui.fireTimeouts(60_000);
  await Promise.all(loads);
  assert.equal(ui.api.stateForTest().usageLogLoadedAt, loadedAt);
  assert.equal(ui.api.stateForTest().usageLogLoading, null);
  assert.equal(ui.api.stateForTest().modelHealthLoading, false);
  assert.match(ui.nodes.get("#usage-log-updated").textContent, /请求超时.*保留上次结果/);
  assert.match(ui.nodes.get("#usage-log-body").innerHTML, /model-1</);
  assert.match(ui.nodes.get("#model-health-error").textContent, /请求超时.*保留上次结果/);
  assert.match(ui.nodes.get("#model-health-body").innerHTML, /gpt-5\.6/);
  hang = false;
  await Promise.all([ui.api.loadUsageLog(), ui.api.loadModelHealth()]);
  assert.doesNotMatch(ui.nodes.get("#usage-log-updated").textContent, /请求超时/);
  assert.equal(ui.nodes.get("#model-health-error").hidden, true);
  assert.equal(ui.api.activeReadsForTest(), 0);
  assert.equal(ui.timers.filter(Boolean).length, 0);
});

test("request supports deadline overrides and does not swallow body AbortError", async () => {
  const ui = loadDashboardUi(dashboard, {
    "/api/never": () => new Promise(() => {}),
    "/api/body-abort": () => ({ ok: true, json: async () => { throw Object.assign(new Error("body aborted"), { name: "AbortError" }); } })
  });
  const pending = assert.rejects(ui.api.request("/api/never", { timeoutMs: 25 }), /请求超时/);
  ui.fireTimeouts(25);
  await pending;
  assert.equal(ui.controllers[0].signal.aborted, true);
  await assert.rejects(ui.api.request("/api/body-abort"), { name: "AbortError", message: "body aborted" });
  assert.equal(ui.api.activeReadsForTest(), 0);
  assert.equal(ui.timers.filter(Boolean).length, 0);
  assert.deepEqual(ui.redirects, []);
});

test("concurrent Web-session 401s redirect once, retain the view and stop all reads permanently", async () => {
  const saved = new Map();
  const sessionStorage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  let expire = false;
  const unauthorized = () => ({ ok: false, status: 401, json: async () => ({ error: { code: "web_session_required", message: "请先登录管理页面。" } }) });
  const ui = loadDashboardUi(dashboard, {
    "/api/dashboard": () => expire ? unauthorized() : json(dashboard),
    "/api/keys": () => expire ? unauthorized() : json({ keys: [] }),
    "/api/model-health": () => expire ? new Promise(() => {}) : json(modelHealth),
    "/api/usage-log": () => new Promise(() => {})
  }, undefined, sessionStorage);
  await ui.api.loadDashboard();
  ui.api.setView("accountPool");
  expire = true;
  await Promise.all([ui.api.loadDashboard(), ui.api.loadUsageLog()]);
  assert.deepEqual(ui.redirects, ["/login"]);
  assert.equal(saved.get("mirasim.dashboard.activeView"), "accountPool");
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.api.activeReadsForTest(), 0);
  assert.equal(ui.api.readLoadsForTest(), 0);
  assert.equal(ui.api.stateForTest().loading, false);
  assert.equal(ui.api.stateForTest().usageLogLoading, null);
  assert.equal(ui.timers.filter(Boolean).length, 0);
  assert.match(ui.nodes.get("#pool-body").innerHTML, /Relay User/);
  const count = ui.requests.length;
  ui.emit("online");
  ui.emit("pageshow");
  ui.visibility("visible");
  await ui.api.loadDashboard();
  await ui.api.loadUsageLog();
  await ui.api.loadModelHealth();
  await flushUi();
  assert.equal(ui.requests.length, count);
  assert.equal(ui.intervals.size, 0);
  assert.deepEqual(ui.redirects, ["/login"]);
});

test("API-key/upstream 401, other statuses and offline failures do not expire the Web session", async () => {
  for (const [status, code] of [[401, "invalid_api_key"], [401, "upstream_unauthorized"], [401, undefined], [403, "web_session_required"], [502, "web_session_required"]]) {
    const ui = loadDashboardUi(dashboard, {
      "/api/keys": () => ({ ok: false, status, json: async () => ({ error: { code, message: "original upstream message" } }) })
    });
    await ui.api.loadDashboard();
    assert.match(ui.nodes.get("#dashboard-sync-status").textContent, /original upstream message/);
    assert.deepEqual(ui.redirects, []);
    assert.equal(ui.intervals.size, 2);
  }
  const offline = loadDashboardUi(dashboard, { "/api/keys": () => { throw new Error("Failed to fetch"); } });
  await offline.api.loadDashboard();
  assert.match(offline.nodes.get("#dashboard-sync-status").textContent, /无法连接本地网关/);
  assert.deepEqual(offline.redirects, []);
  assert.equal(offline.intervals.size, 2);
});

test("online/pageshow/visible recovery coalesces, waits for old locks and rejects late data", async () => {
  let hang = false;
  let finish;
  let current = dashboard;
  const ui = loadDashboardUi(dashboard, {
    "/api/dashboard": () => hang ? new Promise((resolve) => { finish = resolve; }) : json(current)
  });
  await ui.api.loadDashboard();
  hang = true;
  const oldLoad = ui.api.loadDashboard();
  const oldSignal = ui.requests.filter(({ url }) => url === "/api/dashboard").at(-1).options.signal;
  const oldCount = ui.requests.length;
  hang = false;
  current = { ...dashboard, relay: "resumed.example.test" };
  ui.emit("online");
  const resumed = ui.api.resumeDashboard();
  assert.equal(resumed, ui.api.resumeDashboard(), "concurrent recoveries share one promise");
  ui.emit("pageshow");
  ui.visibility("visible");
  assert.equal(oldSignal.aborted, true);
  assert.equal(ui.requests.length, oldCount, "replacement requests wait for loader finally");
  await oldLoad;
  await resumed;
  assert.equal(ui.requests.filter(({ url }) => url === "/api/dashboard").length, 3);
  assert.equal(ui.requests.filter(({ url }) => url === "/api/rotation-mode").length, 1);
  assert.equal(ui.intervals.size, 2);
  assert.equal(ui.nodes.get("#relay-host").textContent, "resumed.example.test");
  finish(json({ ...dashboard, relay: "stale.example.test" }));
  await flushUi();
  assert.equal(ui.nodes.get("#relay-host").textContent, "resumed.example.test");
  assert.equal(ui.api.activeReadsForTest(), 0);
  assert.equal(ui.api.readLoadsForTest(), 0);
});

test("pagehide clears reads and polling, recovery preserves usage pause and remains single", async () => {
  let hang = false;
  const ui = loadDashboardUi(dashboard, {
    "/api/dashboard": () => hang ? new Promise(() => {}) : json(dashboard),
    "/api/usage-log": () => hang ? new Promise(() => {}) : json(usageLog)
  });
  await ui.api.loadDashboard();
  ui.api.setView("usageLog");
  await ui.api.loadUsageLog();
  ui.api.toggleUsageLogPause();
  hang = true;
  const pending = [ui.api.loadDashboard(), ui.api.loadUsageLog()];
  ui.emit("pagehide");
  assert.equal(ui.intervals.size, 0);
  await Promise.all(pending);
  assert.equal(ui.api.activeReadsForTest(), 0);
  assert.equal(ui.api.readLoadsForTest(), 0);
  assert.equal(ui.api.stateForTest().loading, false);
  assert.equal(ui.api.stateForTest().usageLogLoading, null);
  assert.equal(ui.timers.filter(Boolean).length, 0);
  assert.match(ui.nodes.get("#usage-log-body").innerHTML, /model-1</);
  const count = ui.requests.length;
  ui.emit("online");
  ui.visibility("visible");
  await flushUi();
  assert.equal(ui.requests.length, count, "a hidden-away page is not revived by online");
  hang = false;
  const usageCount = ui.requests.filter(({ url }) => url === "/api/usage-log").length;
  ui.emit("pageshow");
  ui.emit("online");
  await ui.api.resumeDashboard();
  ui.poll(5_000);
  await flushUi();
  assert.equal(ui.intervals.size, 2);
  assert.equal(ui.api.stateForTest().usageLogPaused, true);
  assert.equal(ui.requests.filter(({ url }) => url === "/api/usage-log").length, usageCount);
  assert.match(ui.nodes.get("#usage-log-updated").textContent, /已暂停/);
  ui.api.toggleUsageLogPause();
  await ui.api.loadUsageLog();
  assert.equal(ui.requests.filter(({ url }) => url === "/api/usage-log").length, usageCount + 1);
});

test("pagehide during recovery invalidates that recovery, even if pageshow arrives before it settles", async () => {
  let hang = true;
  const ui = loadDashboardUi(dashboard, { "/api/dashboard": () => hang ? new Promise(() => {}) : json(dashboard) });
  ui.emit("online");
  await flushUi();
  assert.equal(ui.api.stateForTest().loading, true);
  ui.emit("pagehide");
  hang = false;
  ui.emit("pageshow");
  await flushUi();
  assert.equal(ui.api.stateForTest().loading, false);
  assert.equal(ui.requests.filter(({ url }) => url === "/api/dashboard").length, 2);
  assert.equal(ui.intervals.size, 2);
  assert.equal(ui.api.activeReadsForTest(), 0);
  assert.equal(ui.nodes.get("#relay-host").textContent, dashboard.relay);
});

test("visibility recovery runs only when visible and does not duplicate a model-health read", async () => {
  const ui = loadDashboardUi();
  await ui.api.loadDashboard();
  ui.api.setView("modelHealth");
  await flushUi();
  const count = ui.requests.length;
  ui.visibility("hidden");
  ui.emit("online");
  ui.poll(60_000);
  ui.poll(5_000);
  await flushUi();
  assert.equal(ui.requests.length, count);
  const healthCount = ui.requests.filter(({ url }) => url === "/api/model-health").length;
  ui.visibility("visible");
  ui.emit("online");
  await ui.api.resumeDashboard();
  assert.equal(ui.requests.filter(({ url }) => url === "/api/model-health").length, healthCount + 1);
  assert.equal(ui.intervals.size, 2);
});

test("slow POST has no GET deadline and recovery/pagehide neither cancel nor replay writes", async () => {
  let finish;
  const ui = loadDashboardUi(dashboard, {
    "/api/moemail/register": () => new Promise((resolve) => { finish = resolve; })
  });
  await ui.api.loadDashboard();
  let settled = false;
  const write = ui.api.registerWithMoeMail({ preventDefault() {} }).then(() => { settled = true; });
  const post = ui.requests.find(({ url }) => url === "/api/moemail/register");
  assert.equal(post.options.method, "POST");
  assert.equal(ui.api.activeReadsForTest(), 0);
  assert.equal(ui.timers.filter(Boolean).length, 0);
  ui.fireTimeouts(60_000);
  ui.fireTimeouts(120_000);
  ui.emit("online");
  await ui.api.resumeDashboard();
  ui.emit("pagehide");
  ui.emit("pageshow");
  await ui.api.resumeDashboard();
  assert.equal(post.options.signal.aborted, false);
  assert.equal(settled, false);
  assert.equal(ui.requests.filter(({ url }) => url === "/api/moemail/register").length, 1);
  finish(json({ requested: 1, completed: 1, accounts: [], stopped: false, error: null }));
  await write;
  assert.equal(settled, true);
  assert.equal(ui.requests.filter(({ url }) => url === "/api/moemail/register").length, 1);
  assert.match(ui.nodes.get("#notice").textContent, /1\/1/);
});

test("failed writes are not automatically retried by recovery", async () => {
  const ui = loadDashboardUi(dashboard, {
    "/api/moemail/register": () => { throw new Error("offline"); }
  });
  await ui.api.registerWithMoeMail({ preventDefault() {} });
  ui.emit("online");
  ui.emit("pageshow");
  await ui.api.resumeDashboard();
  assert.equal(ui.requests.filter(({ url }) => url === "/api/moemail/register").length, 1);
  assert.deepEqual(ui.redirects, []);
});

test("export uses the shared body deadline and retains its blob and server filename on recovery", async () => {
  let hang = true;
  let finish;
  const blob = { type: "application/json", size: 123 };
  const ui = loadDashboardUi(dashboard, {
    "/api/accounts/export": () => ({
      ok: true,
      headers: { get: (name) => name === "content-disposition" ? 'attachment; filename="account-backup.json"' : null },
      blob: () => hang ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(blob)
    })
  });
  const exporting = ui.api.exportAccounts();
  await flushUi();
  assert.equal(ui.nodes.get("#export-accounts").disabled, true);
  ui.fireTimeouts(60_000);
  await exporting;
  assert.equal(ui.nodes.get("#export-accounts").disabled, false);
  assert.match(ui.nodes.get("#notice").textContent, /请求超时/);
  assert.equal(ui.api.activeReadsForTest(), 0);
  assert.deepEqual(ui.downloads, []);
  finish(blob);
  await flushUi();
  assert.deepEqual(ui.downloads, [], "a timed-out export must not download late");
  hang = false;
  await ui.api.exportAccounts();
  assert.deepEqual(ui.downloads, [{ href: "blob:test-export", filename: "account-backup.json" }]);
  assert.deepEqual(ui.revokedUrls, ["blob:test-export"]);
  assert.equal(ui.requests.filter(({ url }) => url === "/api/accounts/export").length, 2);
});

test("export shares exact Web-session authentication handling, not generic 401 redirects", async () => {
  for (const code of ["web_session_required", "invalid_api_key"]) {
    const ui = loadDashboardUi(dashboard, {
      "/api/accounts/export": () => ({ ok: false, status: 401, json: async () => ({ error: { code, message: "原始中文消息" } }) })
    });
    await ui.api.exportAccounts();
    assert.deepEqual(ui.redirects, code === "web_session_required" ? ["/login"] : []);
    assert.equal(ui.nodes.get("#notice").textContent, "原始中文消息");
    assert.equal(ui.nodes.get("#export-accounts").disabled, false);
    assert.equal(ui.api.activeReadsForTest(), 0);
    assert.deepEqual(ui.downloads, []);
  }
});

function loadDashboardUi(dashboardData = dashboard, overrides = {}, confirm = () => true, sessionStorage) {
  const nodes = new Map();
  const clipboardWrites = [];
  const timers = [];
  const intervals = new Map();
  const requests = [];
  const redirects = [];
  const downloads = [];
  const revokedUrls = [];
  const controllers = [];
  let intervalId = 0;
  const context = {
    crypto: { randomUUID },
    AbortController: class extends AbortController {
      constructor() { super(); controllers.push(this); }
    },
    document: Object.assign(eventTarget(), {
      visibilityState: "visible",
      querySelector(selector) { return node(nodes, selector); },
      createElement(tag) {
        assert.equal(tag, "a");
        return { click() { downloads.push({ href: this.href, filename: this.download }); }, remove() {} };
      },
      body: { append() {} }
    }),
    URL: {
      createObjectURL: () => "blob:test-export",
      revokeObjectURL: (url) => revokedUrls.push(url)
    },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (overrides[url]) return overrides[url](options);
      if (url === "/api/dashboard") return json(dashboardData);
      if (url === "/api/keys/key-test/reveal") return json({ key: "msk_saved_complete_key" });
      if (url === "/api/keys") return options.method === "POST"
        ? json({ key: "msk_test_complete_key", record: { id: "key-test", name: "Local client", prefix: "msk_test...", createdAt: "2026-08-09T00:00:00.000Z", lastUsedAt: null } })
        : json({ keys: [] });
      if (url === "/api/moemail/config") {
        return json(options.method === "PUT"
          ? { configured: true, url: "https://mail.example.test", domain: "mail.example.test" }
          : { configured: false, url: "", domain: "" });
      }
      if (url === "/api/moemail/domains") return json({ domains: ["one.example.test", "two.example.test"] });
      if (url === "/api/usage-log") return json(usageLog);
      if (url === "/api/rotation-mode") {
        return json(options.method === "PUT"
          ? { mode: JSON.parse(options.body || "{}").mode, modes: ["spread", "waterfall", "roundRobin"] }
          : { mode: "spread", modes: ["spread", "waterfall", "roundRobin"] });
      }
      if (url === "/api/model-health") return json(modelHealth);
      if (url === "/api/model-health/discover") return json({ started: true, health: { ...modelHealth, discovering: true } });
      if (url.startsWith("/api/model-health/") && url.endsWith("/check")) return json({ health: { ...modelHealth, running: false } });
      if (url === "/api/accounts/restore") return json({ restored: 1, accounts: ["account-2"] });
      if (url === "/api/invites/redeem") {
        return JSON.parse(options.body || "{}").code?.startsWith("MLIC")
          ? json({ updated: true, kind: "license", verdict: "redeemable", action: "upgrade", plan: "max", durationDays: 30 })
          : json({ updated: true, kind: "invite" });
      }
      if (url.endsWith("/priority")) return json({ updated: true, priority: 25, priorityOverride: 25 });
      if (url.startsWith("/api/campaign-link?")) return json({ campaign: dashboardData.accounts[0].campaign });
      if (url === "/api/invites/preview") return json({ kind: "license", supported: true, verdict: "blocked_lower_tier", plan: "basic" });
      if (url === "/api/mirasim/login/verify") return json({ updated: true });
      if (url === "/api/moemail/register") return json({
        requested: 1, completed: 1, accounts: [{ account: "account-2", email: "new@example.test", redeemed: true }], stopped: false, error: null
      });
      throw new Error(`Unexpected request: ${url}`);
    },
    navigator: { clipboard: { writeText: async (value) => { clipboardWrites.push(value); } } },
    window: Object.assign(eventTarget(), { confirm, sessionStorage, location: { assign(url) { redirects.push(url); } } }),
    setInterval: (callback, delay) => { const id = ++intervalId; intervals.set(id, { callback, delay }); return id; },
    clearInterval: (handle) => intervals.delete(handle),
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    clearTimeout: (handle) => { if (handle) timers[handle - 1] = null; }
  };
  const source = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
  const withoutAutoLoad = source.replace("loadDashboard();\nloadRotationMode();\nstartPolling();", "startPolling();");
  assert.notEqual(withoutAutoLoad, source, "dashboard startup hook should be present");
  vm.runInNewContext(`${withoutAutoLoad}\nglobalThis.dashboardTestApi = { loadDashboard, redeemInvite, previewRedeemCode, createReferral, openMirasimLogin, closeMirasimLogin, verifyMirasimLogin, registerWithMoeMail, saveMoeMailConfig, discoverMoeMailDomains, createApiKey, copyApiKey, copyHistoricalApiKey, changeAccountPriority, renewAccount, checkModel, setView, changePoolPage, setPoolStatus, resetPoolFilters, poolStatus, poolRemaining, resetMs, changeUsageLogPage, loadUsageLog, updateUsageLogFilters, resetUsageLogFilters, toggleUsageLogPause, selectUsageLogEntry, loadRotationMode, saveRotationMode, setPoolFilters: () => { state.poolQuery = elements.poolSearch.value.trim(); state.poolCategory = elements.poolCategory.value || "all"; state.poolSort = elements.poolSort.value || "default"; state.poolPage = 1; renderPool(state.data.accounts); } };`, context, { filename: "dashboard.js" });
  vm.runInNewContext("Object.assign(dashboardTestApi, { selectPoolAccount, selectPoolAccounts, bulkPoolAccounts, updateConsoleFilters, resetConsoleFilters, changeConsolePage, dismissApiKey, revokeApiKey, loadModelHealth, loadResetCards, redeemResetCard, resetAccountQuota, refreshAccountResetCards, copyInviteCode, selectAccountForTest: (key) => { state.selectedKey = key; render(); } });", context);
  vm.runInNewContext("Object.assign(dashboardTestApi, { discoverModels, selectedAccountForTest: selectedAccount, accountsForTest: () => state.data.accounts });", context);
  vm.runInNewContext("Object.assign(dashboardTestApi, { request, exportAccounts, resumeDashboard, stateForTest: () => state, activeReadsForTest: () => activeReads.size, readLoadsForTest: () => readLoads.size });", context);
  return {
    api: context.dashboardTestApi, nodes, clipboardWrites, timers, intervals, requests, redirects, downloads, revokedUrls, controllers,
    emit: (type) => context.window.dispatchEvent({ type }),
    visibility: (value) => { context.document.visibilityState = value; context.document.dispatchEvent({ type: "visibilitychange" }); },
    fireTimeouts: (delay) => timers.forEach((timer, index) => {
      if (timer?.delay === delay) { timers[index] = null; timer.callback(); }
    }),
    poll: (delay) => { for (const timer of intervals.values()) if (timer.delay === delay) timer.callback(); }
  };
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); }
  };
}

async function flushUi() {
  // Flush VM/host Promise continuations without advancing deadline or polling timers.
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
}

function node(nodes, selector) {
  if (nodes.has(selector)) return nodes.get(selector);
  const button = { disabled: false, textContent: "" };
  const value = {
    className: "",
    dataset: {},
    disabled: false,
    hidden: false,
    innerHTML: "",
    style: {},
    textContent: "",
    title: "",
    value: "",
    addEventListener() {},
    setAttribute(name, value) { this[name] = value; },
    closest() { return null; },
    focus() {},
    querySelector(childSelector) { return childSelector.startsWith("button") ? button : null; }
  };
  nodes.set(selector, value);
  return value;
}

function json(body) {
  return { ok: true, json: async () => body };
}
