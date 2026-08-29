import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

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
    quota: { availability: "available", requests: 12, inputTokens: 120, outputTokens: 45, cacheReadTokens: 10, cacheWriteTokens: 5, source: "relay", lastStatus: 200 }
  }]
};

const modelHealth = {
  running: false,
  intervalMs: 1_800_000,
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
    reasoningEffort: ["high", "budget:8192", "adaptive", null][index % 4],
    inputTokens: 120,
    outputTokens: 45,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
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

  api.setView("apiKeys");
  assert.equal(nodes.get("#activity-view").hidden, true);
  assert.equal(nodes.get("#api-keys-view").hidden, false);

  api.setView("modelHealth");
  assert.equal(nodes.get("#api-keys-view").hidden, true);
  assert.equal(nodes.get("#model-health-view").hidden, false);
  assert.match(nodes.get("#model-health-body").innerHTML, /gpt-5\.6/);
});

test("activity views show an explicit unavailable state instead of blank membership data", async () => {
  const noActivityDashboard = JSON.parse(JSON.stringify(dashboard));
  noActivityDashboard.accounts[0].referral = null;
  noActivityDashboard.accounts[0].identity.accountType = null;
  const { api, nodes } = loadDashboardUi(noActivityDashboard);
  await api.loadDashboard();

  assert.match(nodes.get("#membership-summary").innerHTML, /普通用户/);
  assert.match(nodes.get("#pool-body").innerHTML, /普通用户/);
  assert.match(nodes.get("#pool-body").innerHTML, /暂无官方数据/);
});

test("official plan identifiers take priority over a generic user role", async () => {
  const plusDashboard = JSON.parse(JSON.stringify(dashboard));
  plusDashboard.accounts[0].identity.accountType = "普通用户";
  plusDashboard.accounts[0].referral.currentPlan = "plus";
  plusDashboard.accounts[0].referral.nextPlan = "max";
  plusDashboard.accounts[0].referral.rewardPlan = "max";
  const { api, nodes } = loadDashboardUi(plusDashboard);
  await api.loadDashboard();
  assert.match(nodes.get("#membership-summary").innerHTML, /MAX 10X/);
  assert.match(nodes.get("#membership-summary").innerHTML, /MAX 40X/);
  assert.match(nodes.get("#pool-body").innerHTML, /MAX 10X/);
});

test("activity progress explains the remaining invites and the tier they unlock", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();

  assert.equal(nodes.get("#redeemed-count").textContent, "1 / 5");
  assert.equal(nodes.get("#remaining-count").textContent, "邀请码剩余可兑换 4 次");
  assert.equal(nodes.get("#progress-copy").textContent, "再邀请 4 位，可兑换MAX 10X一个月。");
  assert.equal(nodes.get("#invite-copy").textContent, "本邀请码最多可兑换 10 次，剩余 4 次。");
  assert.match(nodes.get("#membership-summary").innerHTML, /活动目标<\/span><strong class="plan-name">MAX 10X/);
  assert.match(nodes.get("#pool-body").innerHTML, /1 \/ 5/);
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

test("generating an invite code confirms the code Mirasim returned", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();

  await api.createReferral();
  assert.equal(nodes.get("#notice").textContent, "邀请码已生成：FRESH-INVITE");
  assert.equal(nodes.get("#create-code").textContent, "生成");
});

test("an account without an invite code is not told its code can still be redeemed", async () => {
  const pending = JSON.parse(JSON.stringify(dashboard));
  pending.accounts[0].referral.code = null;
  const { api, nodes } = loadDashboardUi(pending);
  await api.loadDashboard();

  assert.equal(nodes.get("#invite-code").textContent, "尚未生成");
  assert.equal(nodes.get("#invite-copy").textContent, "尚未生成邀请码，点击生成后即可复制并分享。");
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
  assert.match(nodes.get("#pool-body").innerHTML, /无额度（最后备用）/);
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

test("the usage log names the account by mailbox and reports the thinking level", async () => {
  const { api, nodes } = loadDashboardUi();
  await api.loadDashboard();
  api.setView("usageLog");
  await api.loadUsageLog();

  const html = nodes.get("#usage-log-body").innerHTML;
  assert.match(html, /user@example\.test/);
  // The account column must not fall back to the raw Mirasim user id.
  assert.doesNotMatch(html, /user-a/);
  assert.match(html, /高|8192 tokens|adaptive|默认/);
  // The speed column was dropped, so no row may still report a rate.
  assert.doesNotMatch(html, /tok\/s/);
  assert.equal(rowColumnCount(html), usageLogColumnCount());
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

// The priority column made the pool table eight columns wide; the empty state has to follow the header.
function poolColumnCount() {
  return columnCount("pool-table");
}

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
  const row = /<tr>([\s\S]*?)<\/tr>/.exec(html);
  assert.ok(row, "at least one row should be rendered");
  return row[1].split("<td").length - 1;
}

function loadDashboardUi(dashboardData = dashboard, overrides = {}) {
  const nodes = new Map();
  const clipboardWrites = [];
  const timers = [];
  const context = {
    document: { querySelector(selector) { return node(nodes, selector); } },
    fetch: async (url, options = {}) => {
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
      if (url === "/api/referral") return json({ referral: { ...dashboardData.accounts[0].referral, code: "FRESH-INVITE" } });
      if (url === "/api/invites/preview") return json({ kind: "license", supported: true, verdict: "blocked_lower_tier", plan: "basic" });
      if (url === "/api/mirasim/login/verify") return json({ updated: true });
      if (url === "/api/moemail/register") return json({
        requested: 1, completed: 1, accounts: [{ account: "account-2", email: "new@example.test", redeemed: true }], stopped: false, error: null
      });
      throw new Error(`Unexpected request: ${url}`);
    },
    navigator: { clipboard: { writeText: async (value) => { clipboardWrites.push(value); } } },
    window: { confirm: () => true, location: { assign() {} } },
    setInterval: () => 0,
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    clearTimeout: (handle) => { if (handle) timers[handle - 1] = null; }
  };
  const source = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
  const withoutAutoLoad = source.replace("loadDashboard();\nsetInterval(loadDashboard, 60_000);", "");
  assert.notEqual(withoutAutoLoad, source, "dashboard startup hook should be present");
  vm.runInNewContext(`${withoutAutoLoad}\nglobalThis.dashboardTestApi = { loadDashboard, redeemInvite, previewRedeemCode, createReferral, openMirasimLogin, closeMirasimLogin, verifyMirasimLogin, registerWithMoeMail, saveMoeMailConfig, discoverMoeMailDomains, createApiKey, copyApiKey, copyHistoricalApiKey, changeAccountPriority, checkModel, setView, changePoolPage, changeUsageLogPage, loadUsageLog, setPoolFilters: () => { state.poolQuery = elements.poolSearch.value.trim(); state.poolCategory = elements.poolCategory.value; state.poolPage = 1; renderPool(state.data.accounts); } };`, context, { filename: "dashboard.js" });
  return { api: context.dashboardTestApi, nodes, clipboardWrites, timers };
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
