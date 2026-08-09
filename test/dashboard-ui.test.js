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
    identity: { name: "Relay User", email: "user@example.test", accountType: "Team" },
    referral: { code: "INVITE-123", redeemed: 1, threshold: 5, remaining: 4, reached: false, maxRedemptions: 10, currentPlan: "Starter", nextPlan: "Pro" },
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

test("official Plus and Max plans take priority over a generic user role", async () => {
  const plusDashboard = JSON.parse(JSON.stringify(dashboard));
  plusDashboard.accounts[0].identity.accountType = "普通用户";
  plusDashboard.accounts[0].referral.currentPlan = "PLUS";
  plusDashboard.accounts[0].referral.nextPlan = "MAX";
  const { api, nodes } = loadDashboardUi(plusDashboard);
  await api.loadDashboard();
  assert.match(nodes.get("#membership-summary").innerHTML, /Plus/);
  assert.match(nodes.get("#membership-summary").innerHTML, /Max/);
  assert.match(nodes.get("#pool-body").innerHTML, /Plus/);
});

function loadDashboardUi(dashboardData = dashboard) {
  const nodes = new Map();
  const context = {
    document: { querySelector(selector) { return node(nodes, selector); } },
    fetch: async (url, options = {}) => {
      if (url === "/api/dashboard") return json(dashboardData);
      if (url === "/api/keys") return json({ keys: [] });
      if (url === "/api/moemail/config") {
        return json(options.method === "PUT"
          ? { configured: true, url: "https://mail.example.test", domain: "mail.example.test" }
          : { configured: false, url: "", domain: "" });
      }
      if (url === "/api/model-health") return json(modelHealth);
      if (url === "/api/model-health/run") return json({ started: true, health: { ...modelHealth, running: true } });
      if (url === "/api/model-health/discover") return json({ started: true, health: { ...modelHealth, discovering: true } });
      if (url === "/api/accounts/restore") return json({ restored: 1, accounts: ["account-2"] });
      if (url === "/api/invites/redeem") return json({ updated: true });
      if (url === "/api/mirasim/login/verify") return json({ updated: true });
      if (url === "/api/moemail/register") return json({
        requested: 1, completed: 1, accounts: [{ account: "account-2", email: "new@example.test", redeemed: true }], stopped: false, error: null
      });
      throw new Error(`Unexpected request: ${url}`);
    },
    navigator: { clipboard: { writeText: async () => {} } },
    window: { confirm: () => true, location: { assign() {} } },
    setInterval: () => 0
  };
  const source = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
  const withoutAutoLoad = source.replace("loadDashboard();\nsetInterval(loadDashboard, 60_000);", "");
  assert.notEqual(withoutAutoLoad, source, "dashboard startup hook should be present");
  vm.runInNewContext(`${withoutAutoLoad}\nglobalThis.dashboardTestApi = { loadDashboard, redeemInvite, openMirasimLogin, closeMirasimLogin, verifyMirasimLogin, registerWithMoeMail, saveMoeMailConfig, runModelHealthCheck, setView };`, context, { filename: "dashboard.js" });
  return { api: context.dashboardTestApi, nodes };
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
    value: "",
    addEventListener() {},
    closest() { return null; },
    focus() {},
    querySelector(childSelector) { return childSelector === "button" ? button : null; }
  };
  nodes.set(selector, value);
  return value;
}

function json(body) {
  return { ok: true, json: async () => body };
}
