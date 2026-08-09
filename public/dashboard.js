const DEFAULT_REDEEM_STATUS = "兑换成功后将刷新此账号的官方登录态。";
const state = {
  data: null,
  apiKeys: [],
  modelHealth: null,
  issuedApiKey: null,
  selectedKey: null,
  loginKey: null,
  loginAttempt: null,
  moemailConfig: null,
  redeemStatus: { text: DEFAULT_REDEEM_STATUS, type: "idle" },
  loading: false,
  activeView: "overview"
};

const elements = {
  refresh: document.querySelector("#refresh"),
  logout: document.querySelector("#logout"),
  relayHost: document.querySelector("#relay-host"),
  updatedAt: document.querySelector("#updated-at"),
  notice: document.querySelector("#notice"),
  console: document.querySelector("#console"),
  navOverview: document.querySelector("#nav-overview"),
  navActivity: document.querySelector("#nav-activity"),
  navApiKeys: document.querySelector("#nav-api-keys"),
  navAccountPool: document.querySelector("#nav-account-pool"),
  navModelHealth: document.querySelector("#nav-model-health"),
  overviewView: document.querySelector("#overview-view"),
  activityView: document.querySelector("#activity-view"),
  apiKeysView: document.querySelector("#api-keys-view"),
  accountPoolView: document.querySelector("#account-pool-view"),
  modelHealthView: document.querySelector("#model-health-view"),
  overviewAccountCount: document.querySelector("#overview-account-count"),
  overviewSignedInCount: document.querySelector("#overview-signed-in-count"),
  overviewAvailableCount: document.querySelector("#overview-available-count"),
  overviewRequestCount: document.querySelector("#overview-request-count"),
  overviewInputTokens: document.querySelector("#overview-input-tokens"),
  overviewOutputTokens: document.querySelector("#overview-output-tokens"),
  overviewCacheReadTokens: document.querySelector("#overview-cache-read-tokens"),
  overviewCacheWriteTokens: document.querySelector("#overview-cache-write-tokens"),
  mirasimLoginOpen: document.querySelector("#mirasim-login-open"),
  mirasimLoginOpenHeader: document.querySelector("#mirasim-login-open-header"),
  mirasimLoginModal: document.querySelector("#mirasim-login-modal"),
  mirasimLoginClose: document.querySelector("#mirasim-login-close"),
  mirasimLoginStatus: document.querySelector("#mirasim-login-status"),
  mirasimAccount: document.querySelector("#mirasim-account-select"),
  mirasimEmail: document.querySelector("#mirasim-email"),
  mirasimCodeForm: document.querySelector("#mirasim-code-form"),
  mirasimVerifyForm: document.querySelector("#mirasim-verify-form"),
  mirasimVerifyCode: document.querySelector("#mirasim-verify-code"),
  moemailRegisterForm: document.querySelector("#moemail-register-form"),
  moemailInviteCode: document.querySelector("#moemail-invite-code"),
  moemailCount: document.querySelector("#moemail-count"),
  moemailConfigForm: document.querySelector("#moemail-config-form"),
  moemailUrl: document.querySelector("#moemail-url"),
  moemailDomain: document.querySelector("#moemail-domain"),
  moemailApiKey: document.querySelector("#moemail-api-key"),
  moemailConfigStatus: document.querySelector("#moemail-config-status"),
  apiKeyForm: document.querySelector("#api-key-form"),
  apiKeyName: document.querySelector("#api-key-name"),
  apiKeyReveal: document.querySelector("#api-key-reveal"),
  apiKeyValue: document.querySelector("#api-key-value"),
  copyApiKey: document.querySelector("#copy-api-key"),
  apiKeyList: document.querySelector("#api-key-list"),
  select: document.querySelector("#account-select"),
  accountStatus: document.querySelector("#account-status"),
  activityState: document.querySelector("#activity-state"),
  membership: document.querySelector("#membership-summary"),
  redeemed: document.querySelector("#redeemed-count"),
  remaining: document.querySelector("#remaining-count"),
  progress: document.querySelector("#progress-value"),
  progressCopy: document.querySelector("#progress-copy"),
  inviteCode: document.querySelector("#invite-code"),
  inviteCopy: document.querySelector("#invite-copy"),
  createCode: document.querySelector("#create-code"),
  copyCode: document.querySelector("#copy-code"),
  redeemForm: document.querySelector("#redeem-form"),
  redeemCode: document.querySelector("#redeem-code"),
  redeemStatus: document.querySelector("#redeem-status"),
  poolBody: document.querySelector("#pool-body"),
  restoreAccounts: document.querySelector("#restore-accounts"),
  modelHealthUpdated: document.querySelector("#model-health-updated"),
  modelHealthDiscover: document.querySelector("#model-health-discover"),
  modelHealthRun: document.querySelector("#model-health-run"),
  modelHealthSummary: document.querySelector("#model-health-summary"),
  modelHealthBody: document.querySelector("#model-health-body")
};

elements.refresh.addEventListener("click", () => loadDashboard());
elements.logout.addEventListener("click", logout);
elements.navOverview.addEventListener("click", () => setView("overview"));
elements.navActivity.addEventListener("click", () => setView("activity"));
elements.navApiKeys.addEventListener("click", () => setView("apiKeys"));
elements.navAccountPool.addEventListener("click", () => setView("accountPool"));
elements.navModelHealth.addEventListener("click", () => setView("modelHealth"));
elements.modelHealthDiscover.addEventListener("click", discoverModels);
elements.modelHealthRun.addEventListener("click", runModelHealthCheck);
elements.mirasimLoginOpen.addEventListener("click", openMirasimLogin);
elements.mirasimLoginOpenHeader.addEventListener("click", openMirasimLogin);
elements.mirasimLoginClose.addEventListener("click", closeMirasimLogin);
elements.mirasimLoginModal.addEventListener("click", (event) => {
  if (event.target?.dataset?.closeMirasimLogin !== undefined) closeMirasimLogin();
});
elements.select.addEventListener("change", () => {
  state.selectedKey = elements.select.value;
  render();
});
elements.createCode.addEventListener("click", createReferral);
elements.copyCode.addEventListener("click", copyInviteCode);
elements.redeemForm.addEventListener("submit", redeemInvite);
elements.mirasimAccount.addEventListener("change", () => { state.loginKey = elements.mirasimAccount.value; });
elements.mirasimCodeForm.addEventListener("submit", requestMirasimCode);
elements.mirasimVerifyForm.addEventListener("submit", verifyMirasimLogin);
elements.moemailRegisterForm.addEventListener("submit", registerWithMoeMail);
elements.moemailConfigForm.addEventListener("submit", saveMoeMailConfig);
elements.apiKeyForm.addEventListener("submit", createApiKey);
elements.copyApiKey.addEventListener("click", copyApiKey);
elements.apiKeyList.addEventListener("click", revokeApiKey);
elements.poolBody.addEventListener("click", deleteAccount);
elements.poolBody.addEventListener("click", renewAccount);
elements.restoreAccounts.addEventListener("click", restoreAccounts);

loadDashboard();
setInterval(loadDashboard, 60_000);
setInterval(() => {
  if (state.modelHealth?.running || state.modelHealth?.discovering) void loadModelHealth();
}, 5_000);

async function loadDashboard() {
  if (state.loading) return;
  state.loading = true;
  elements.refresh.disabled = true;
  try {
    const [dashboard, apiKeys, moemailConfig, modelHealth] = await Promise.all([request("/api/dashboard"), request("/api/keys"), request("/api/moemail/config"), request("/api/model-health")]);
    state.data = dashboard;
    state.apiKeys = apiKeys.keys;
    state.moemailConfig = moemailConfig;
    state.modelHealth = modelHealth;
    const signedIn = state.data.accounts.filter((account) => account.loggedIn);
    if (!signedIn.some((account) => account.key === state.selectedKey)) {
      state.selectedKey = signedIn[0]?.key || null;
    }
    if (!state.data.accounts.some((account) => account.key === state.loginKey)) {
      state.loginKey = state.data.accounts[0]?.key || "new";
    }
    render();
  } catch (error) {
    showNotice(error.message || "无法读取控制台数据。");
  } finally {
    state.loading = false;
    elements.refresh.disabled = false;
  }
}

async function loadModelHealth() {
  try {
    state.modelHealth = await request("/api/model-health");
    renderModelHealth();
  } catch {
    // Keep the last rendered result while a background poll is unavailable.
  }
}

function render() {
  const data = state.data;
  if (!data) return;
  const signedIn = data.accounts.filter((account) => account.loggedIn);
  elements.relayHost.textContent = data.relay;
  elements.updatedAt.textContent = `更新于 ${formatTime(data.generatedAt)}`;
  elements.console.hidden = signedIn.length === 0;
  elements.mirasimAccount.innerHTML = `${data.accounts.map((account) => `<option value="${escapeHtml(account.key)}">${escapeHtml(loginAccountLabel(account))}</option>`).join("")}<option value="new">新增账户</option>`;
  elements.mirasimAccount.value = state.loginKey;
  renderMoeMailConfig();
  renderApiKeys();
  renderRedeemStatus();
  renderOverview(data);
  renderPool(data.accounts);
  renderModelHealth();
  if (signedIn.length === 0) return;

  elements.select.innerHTML = signedIn.map((account) => `<option value="${escapeHtml(account.key)}">${escapeHtml(accountLabel(account))}</option>`).join("");
  elements.select.value = state.selectedKey;
  const account = signedIn.find((item) => item.key === state.selectedKey) || signedIn[0];
  renderAccount(account);
}

function renderMoeMailConfig() {
  const config = state.moemailConfig;
  if (!config) return;
  elements.moemailUrl.value = config.url || "";
  elements.moemailDomain.value = config.domain || "";
  elements.moemailConfigStatus.textContent = config.configured ? "已配置" : "未配置";
  elements.moemailConfigStatus.dataset.state = config.configured ? "ready" : "empty";
}

function setView(view) {
  const views = {
    overview: { nav: elements.navOverview, panel: elements.overviewView },
    activity: { nav: elements.navActivity, panel: elements.activityView },
    apiKeys: { nav: elements.navApiKeys, panel: elements.apiKeysView },
    accountPool: { nav: elements.navAccountPool, panel: elements.accountPoolView },
    modelHealth: { nav: elements.navModelHealth, panel: elements.modelHealthView }
  };
  if (!views[view]) return;
  state.activeView = view;
  for (const [name, item] of Object.entries(views)) {
    const active = name === view;
    item.nav.className = `nav-item${active ? " active" : ""}`;
    item.nav.setAttribute?.("aria-current", active ? "page" : "false");
    item.panel.hidden = !active;
  }
}

function renderModelHealth() {
  const health = state.modelHealth;
  if (!health) return;
  const models = Array.isArray(health.models) ? health.models : [];
  const totals = models.reduce((result, model) => {
    result[model.status] = (result[model.status] || 0) + 1;
    return result;
  }, {});
  const nextRun = health.intervalMs ? `每 ${formatDuration(health.intervalMs)} 自动检测` : "自动检测未启用";
  elements.modelHealthUpdated.textContent = health.discovering
    ? "正在读取模型目录..."
    : health.running ? `正在检测 ${health.activeModelId || "模型"}...` : health.lastFinishedAt ? `上次检测 ${formatTime(health.lastFinishedAt)}，${nextRun}` : health.lastDiscoveredAt ? `目录更新于 ${formatTime(health.lastDiscoveredAt)}` : nextRun;
  elements.modelHealthDiscover.disabled = Boolean(health.discovering || health.running);
  elements.modelHealthDiscover.textContent = health.discovering ? "读取中" : "刷新模型";
  elements.modelHealthRun.disabled = Boolean(health.running);
  elements.modelHealthRun.textContent = health.running ? "检测中" : "开始检测";
  elements.modelHealthSummary.innerHTML = `<span class="health-count good">可用 ${numeric(totals.healthy)}</span><span class="health-count warning">限流 ${numeric(totals.limited)}</span><span class="health-count bad">不可用 ${numeric(totals.unavailable) + numeric(totals.unauthorized)}</span><span class="health-count neutral">待检测 ${numeric(totals.pending) + numeric(totals.checking)}</span><span class="health-count neutral">已发现 ${models.length}</span>${health.lastError ? `<span class="health-error">${escapeHtml(health.lastError)}</span>` : ""}`;
  if (models.length === 0) {
    elements.modelHealthBody.innerHTML = `<tr><td colspan="6" class="empty-table">${health.discovering || health.running ? "正在获取上游模型列表..." : "尚未发现可检测的模型。"}</td></tr>`;
    return;
  }
  elements.modelHealthBody.innerHTML = models.map((model) => {
    const meta = modelHealthMeta(model.status);
    return `<tr><td><code>${escapeHtml(model.id)}</code></td><td><span class="table-status ${meta.className}">${meta.label}</span></td><td>${model.latencyMs ? `${formatNumber(model.latencyMs)} ms` : "-"}</td><td>${model.httpStatus || "-"}</td><td>${escapeHtml(formatTime(model.checkedAt))}</td><td class="model-health-message">${escapeHtml(model.message || "-")}</td></tr>`;
  }).join("");
}

function renderOverview(data) {
  const totals = data.accounts.reduce((result, account) => {
    const quota = account.quota || {};
    result.requests += numeric(quota.requests);
    result.inputTokens += numeric(quota.inputTokens);
    result.outputTokens += numeric(quota.outputTokens);
    result.cacheReadTokens += numeric(quota.cacheReadTokens);
    result.cacheWriteTokens += numeric(quota.cacheWriteTokens);
    if (account.loggedIn) result.signedIn += 1;
    if (quota.availability === "available") result.available += 1;
    return result;
  }, { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, signedIn: 0, available: 0 });

  elements.overviewAccountCount.textContent = formatNumber(data.accounts.length);
  elements.overviewSignedInCount.textContent = formatNumber(totals.signedIn);
  elements.overviewAvailableCount.textContent = formatNumber(totals.available);
  elements.overviewRequestCount.textContent = formatNumber(totals.requests);
  elements.overviewInputTokens.textContent = formatNumber(totals.inputTokens);
  elements.overviewOutputTokens.textContent = formatNumber(totals.outputTokens);
  elements.overviewCacheReadTokens.textContent = formatNumber(totals.cacheReadTokens);
  elements.overviewCacheWriteTokens.textContent = formatNumber(totals.cacheWriteTokens);
}

function renderApiKeys() {
  elements.apiKeyReveal.hidden = !state.issuedApiKey;
  elements.apiKeyValue.textContent = state.issuedApiKey || "";
  elements.copyApiKey.disabled = !state.issuedApiKey;
  if (state.apiKeys.length === 0) {
    elements.apiKeyList.innerHTML = '<tr><td colspan="5" class="empty-table">尚未生成 API Key</td></tr>';
    return;
  }
  elements.apiKeyList.innerHTML = state.apiKeys.map((key) => `<tr>
    <td>${escapeHtml(key.name)}</td>
    <td><code>${escapeHtml(key.prefix)}</code></td>
    <td>${escapeHtml(formatTime(key.createdAt))}</td>
    <td>${escapeHtml(key.lastUsedAt ? formatTime(key.lastUsedAt) : "未使用")}</td>
    <td><button class="button button-secondary key-revoke" type="button" data-key-id="${escapeHtml(key.id)}">吊销</button></td>
  </tr>`).join("");
}

function renderRedeemStatus() {
  elements.redeemStatus.textContent = state.redeemStatus.text;
  elements.redeemStatus.dataset.state = state.redeemStatus.type;
}

function renderAccount(account) {
  const referral = account.referral;
  elements.accountStatus.textContent = account.healthy ? "中转可用" : "中转冷却中";
  elements.accountStatus.className = `status-dot ${account.healthy ? "good" : "warning"}`;

  const plan = accountTypeLabel(referral?.currentPlan || account.identity?.accountType) || "普通用户";
  const nextPlan = accountTypeLabel(referral?.nextPlan) || referral?.nextPlan || (referral ? "暂无下一等级" : "暂无活动信息");
  elements.membership.innerHTML = `
    <div><span class="plan-label">账户类型</span><strong class="plan-name">${escapeHtml(plan)}</strong></div>
    <div class="plan-divider" aria-hidden="true">→</div>
    <div class="plan-next"><span class="plan-label">活动目标</span><strong class="plan-name">${escapeHtml(nextPlan)}</strong></div>`;

  const target = referral?.threshold || referral?.maxRedemptions || 0;
  const redeemed = referral?.redeemed || 0;
  const percentage = target > 0 ? Math.min(100, Math.round((redeemed / target) * 100)) : 0;
  elements.redeemed.textContent = target > 0 ? `${redeemed} / ${target}` : String(redeemed);
  elements.remaining.textContent = referral ? `剩余名额 ${referral.remaining}` : "暂无活动名额";
  elements.progress.style.width = `${percentage}%`;
  elements.progressCopy.textContent = referral
    ? (referral.reached ? "当前账号已达到本轮活动目标。" : "活动规则和名额由 Mirasim 官方接口实时返回。")
    : "官方活动接口当前未返回数据。";
  setBadge(elements.activityState, referral?.reached ? "已达成" : referral ? "进行中" : "暂无数据", referral?.reached ? "good" : referral ? "warning" : "bad");

  const code = referral?.code || "";
  elements.inviteCode.textContent = code || "尚未生成";
  elements.inviteCopy.textContent = referral?.maxRedemptions
    ? `本邀请码最多可兑换 ${referral.maxRedemptions} 次。`
    : referral ? "生成后可复制并分享邀请码。" : "等待官方邀请活动接口恢复。";
  elements.copyCode.disabled = !code;
  elements.createCode.disabled = !referral;
  elements.redeemForm.querySelector("button").disabled = !referral;
}

function renderPool(accounts) {
  elements.poolBody.innerHTML = accounts.map((account) => {
    const status = availabilityMeta(account.quota.availability);
    const identity = account.identity?.name || account.identity?.email || account.id;
    const plan = accountTypeLabel(account.referral?.currentPlan || account.identity?.accountType) || "普通用户";
    const activity = account.referral ? formatActivityQuota(account.referral) : "暂无官方数据";
    return `<tr>
      <td><span class="account-name">${escapeHtml(identity)}</span><span class="account-sub">${escapeHtml(account.id)}</span></td>
      <td>${escapeHtml(plan)}</td>
      <td>${escapeHtml(activity)}</td>
      <td><span class="table-status ${status.className}">${status.label}</span></td>
      <td>${escapeHtml(formatStatus(account.quota.lastStatus))}</td>
      <td><div class="account-actions"><button class="button button-secondary account-renew" type="button" data-renew-account="${escapeHtml(account.key)}">续期</button><button class="button button-secondary account-delete" type="button" data-account-key="${escapeHtml(account.key)}">删除</button></div></td>
    </tr>`;
  }).join("");
}

async function requestMirasimCode(event) {
  event.preventDefault();
  const account = state.loginKey;
  const email = elements.mirasimEmail.value.trim();
  if (!account || !email) return;
  const button = elements.mirasimCodeForm.querySelector("button");
  setBusy(button, true, "发送中");
  try {
    const result = await request("/api/mirasim/login/code", { method: "POST", body: { account, email } });
    state.loginAttempt = { account: result.account || account, email };
    elements.mirasimLoginStatus.textContent = result.devCode ? `开发验证码：${result.devCode}` : "验证码已发送";
    elements.mirasimVerifyCode.focus();
    hideNotice();
  } catch (error) {
    showNotice(error.message || "无法发送 Mirasim 验证码。");
  } finally {
    setBusy(button, false, "发送验证码");
  }
}

async function verifyMirasimLogin(event) {
  event.preventDefault();
  const account = state.loginAttempt?.account || state.loginKey;
  const email = state.loginAttempt?.email || elements.mirasimEmail.value.trim();
  const code = elements.mirasimVerifyCode.value.trim();
  if (!account || !email || !code) return;
  const button = elements.mirasimVerifyForm.querySelector("button");
  setBusy(button, true, "登录中");
  try {
    await request("/api/mirasim/login/verify", { method: "POST", body: { account, email, code } });
    elements.mirasimVerifyCode.value = "";
    state.loginAttempt = null;
    await loadDashboard();
    closeMirasimLogin();
  } catch (error) {
    showNotice(error.message || "Mirasim 登录失败。");
  } finally {
    setBusy(button, false, "登录 Mirasim");
  }
}

async function registerWithMoeMail(event) {
  event.preventDefault();
  const button = elements.moemailRegisterForm.querySelector("button");
  setBusy(button, true, "注册中");
  elements.mirasimLoginStatus.textContent = "正在创建邮箱并等待验证码...";
  try {
    const result = await request("/api/moemail/register", {
      method: "POST",
      body: { inviteCode: elements.moemailInviteCode.value.trim(), count: Number(elements.moemailCount.value) }
    });
    const summary = result.stopped
      ? `已完成 ${result.completed}/${result.requested} 个账号，队列已停止：${result.error}`
      : `已完成 ${result.completed}/${result.requested} 个账号并加入账号池。`;
    if (!result.stopped) elements.moemailInviteCode.value = "";
    state.loginAttempt = null;
    if (result.completed > 0) await loadDashboard();
    elements.mirasimLoginStatus.textContent = summary;
    if (!result.stopped) closeMirasimLogin();
    showNotice(summary, result.stopped ? "error" : "success");
  } catch (error) {
    elements.mirasimLoginStatus.textContent = error.message || "MoeMail 注册失败。";
    showNotice(error.message || "MoeMail 注册失败。", "error");
  } finally {
    setBusy(button, false, "MoeMail 注册");
  }
}

async function saveMoeMailConfig(event) {
  event.preventDefault();
  const button = elements.moemailConfigForm.querySelector("button");
  setBusy(button, true, "保存中");
  try {
    state.moemailConfig = await request("/api/moemail/config", {
      method: "PUT",
      body: {
        url: elements.moemailUrl.value.trim(),
        domain: elements.moemailDomain.value.trim(),
        apiKey: elements.moemailApiKey.value.trim()
      }
    });
    elements.moemailApiKey.value = "";
    renderMoeMailConfig();
    showNotice("MoeMail 配置已保存。", "success");
  } catch (error) {
    showNotice(error.message || "无法保存 MoeMail 配置。", "error");
  } finally {
    setBusy(button, false, "保存 MoeMail 配置");
  }
}

async function createReferral() {
  const account = selectedAccount();
  if (!account) return;
  setBusy(elements.createCode, true, "生成中");
  try {
    await request("/api/referral", { method: "POST", body: { account: account.key } });
    await loadDashboard();
  } catch (error) {
    showNotice(error.message || "无法生成邀请码。");
  } finally {
    setBusy(elements.createCode, false, "生成");
  }
}

async function copyInviteCode() {
  const code = elements.inviteCode.textContent;
  if (!code || code === "尚未生成") return;
  try {
    await navigator.clipboard.writeText(code);
    showNotice("邀请码已复制。", "success");
  } catch {
    showNotice("浏览器未授予剪贴板权限。", "error");
  }
}

async function redeemInvite(event) {
  event.preventDefault();
  const account = selectedAccount();
  const code = elements.redeemCode.value.trim();
  if (!account || !code) return;
  const button = elements.redeemForm.querySelector("button");
  state.redeemStatus = { text: "正在兑换邀请码...", type: "pending" };
  renderRedeemStatus();
  setBusy(button, true, "兑换中");
  try {
    await request("/api/invites/redeem", { method: "POST", body: { account: account.key, code } });
    elements.redeemCode.value = "";
    state.redeemStatus = { text: "邀请码已兑换，账号状态已刷新。", type: "success" };
    renderRedeemStatus();
    showNotice(state.redeemStatus.text, "success");
    await loadDashboard();
  } catch (error) {
    state.redeemStatus = { text: error.message || "邀请码兑换失败。", type: "error" };
    renderRedeemStatus();
    showNotice(state.redeemStatus.text, "error");
  } finally {
    setBusy(button, false, "兑换");
  }
}

async function createApiKey(event) {
  event.preventDefault();
  const button = elements.apiKeyForm.querySelector("button");
  setBusy(button, true, "生成中");
  try {
    const result = await request("/api/keys", { method: "POST", body: { name: elements.apiKeyName.value } });
    state.issuedApiKey = result.key;
    elements.apiKeyName.value = "";
    state.apiKeys = [result.record, ...state.apiKeys];
    renderApiKeys();
    showNotice("OpenAI API Key 已生成，请立即复制保存。", "success");
  } catch (error) {
    showNotice(error.message || "无法生成 OpenAI API Key。", "error");
  } finally {
    setBusy(button, false, "生成密钥");
  }
}

async function copyApiKey() {
  if (!state.issuedApiKey) return;
  try {
    await navigator.clipboard.writeText(state.issuedApiKey);
    showNotice("OpenAI API Key 已复制。", "success");
  } catch {
    showNotice("浏览器未授予剪贴板权限。", "error");
  }
}

async function revokeApiKey(event) {
  const button = event.target.closest("[data-key-id]");
  if (!button || !window.confirm("吊销后该 API Key 将立即失效。")) return;
  setBusy(button, true, "吊销中");
  try {
    await request(`/api/keys/${encodeURIComponent(button.dataset.keyId)}`, { method: "DELETE" });
    state.apiKeys = state.apiKeys.filter((key) => key.id !== button.dataset.keyId);
    renderApiKeys();
    showNotice("OpenAI API Key 已吊销。", "success");
  } catch (error) {
    showNotice(error.message || "无法吊销 OpenAI API Key。", "error");
  }
}

async function deleteAccount(event) {
  const button = event.target.closest("[data-account-key]");
  if (!button || !window.confirm("从账号池删除该账户？本地登录文件会保留。")) return;
  setBusy(button, true, "删除中");
  try {
    await request(`/api/accounts/${encodeURIComponent(button.dataset.accountKey)}`, { method: "DELETE" });
    state.selectedKey = null;
    state.loginKey = null;
    await loadDashboard();
    showNotice("账户已从轮询池删除。", "success");
  } catch (error) {
    showNotice(error.message || "无法删除账户。", "error");
    setBusy(button, false, "删除");
  }
}

async function renewAccount(event) {
  const button = event.target.closest("[data-renew-account]");
  if (!button) return;
  setBusy(button, true, "续期中");
  try {
    await request(`/api/accounts/${encodeURIComponent(button.dataset.renewAccount)}/refresh`, { method: "POST" });
    await loadDashboard();
    showNotice("账号登录态已续期。", "success");
  } catch (error) {
    showNotice(error.message || "账号续期失败，请重新登录。", "error");
  } finally {
    setBusy(button, false, "续期");
  }
}

async function restoreAccounts() {
  setBusy(elements.restoreAccounts, true, "恢复中");
  try {
    const result = await request("/api/accounts/restore", { method: "POST" });
    await loadDashboard();
    showNotice(result.restored ? `已恢复 ${result.restored} 个本地账户到轮询池。` : "没有可恢复的本地账户。", "success");
  } catch (error) {
    showNotice(error.message || "无法恢复本地账户。", "error");
  } finally {
    setBusy(elements.restoreAccounts, false, "恢复本地账户");
  }
}

async function discoverModels() {
  setBusy(elements.modelHealthDiscover, true, "读取中");
  try {
    const result = await request("/api/model-health/discover", { method: "POST" });
    state.modelHealth = result.health;
    renderModelHealth();
  } catch (error) {
    showNotice(error.message || "无法读取上游模型目录。", "error");
    setBusy(elements.modelHealthDiscover, false, "刷新模型");
  }
}

async function runModelHealthCheck() {
  setBusy(elements.modelHealthRun, true, "启动中");
  try {
    const result = await request("/api/model-health/run", { method: "POST" });
    state.modelHealth = result.health;
    renderModelHealth();
    showNotice("模型健康检测已在后台启动。", "success");
  } catch (error) {
    showNotice(error.message || "无法启动模型健康检测。", "error");
    setBusy(elements.modelHealthRun, false, "开始检测");
  }
}

async function logout() {
  elements.logout.disabled = true;
  try {
    await request("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  } catch (error) {
    showNotice(error.message || "退出失败。", "error");
    elements.logout.disabled = false;
  }
}

function openMirasimLogin() {
  elements.mirasimLoginModal.hidden = false;
  elements.mirasimEmail.focus();
}

function closeMirasimLogin() {
  elements.mirasimLoginModal.hidden = true;
  state.loginAttempt = null;
  elements.mirasimVerifyCode.value = "";
  elements.mirasimLoginStatus.textContent = "输入邮箱后发送验证码。";
}

function selectedAccount() {
  return state.data?.accounts.find((account) => account.key === state.selectedKey) || null;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The server always returns JSON for API routes.
  }
  if (!response.ok) throw new Error(payload?.error?.message || "请求失败。");
  return payload;
}

function setBadge(element, text, className) {
  element.textContent = text;
  element.className = `badge ${className}`;
}

function setBusy(button, busy, text) {
  button.disabled = busy;
  button.textContent = text;
}

function showNotice(text, type = "error") {
  elements.notice.hidden = false;
  elements.notice.textContent = text;
  elements.notice.style.color = type === "success" ? "var(--green)" : "var(--red)";
  elements.notice.style.borderColor = type === "success" ? "#9bd6b8" : "#efb4ad";
  elements.notice.style.background = type === "success" ? "var(--green-soft)" : "var(--red-soft)";
}

function hideNotice() {
  elements.notice.hidden = true;
}

function availabilityMeta(value) {
  if (value === "available") return { label: "可用", className: "good" };
  if (value === "cooling") return { label: "冷却中", className: "warning" };
  return { label: "未登录", className: "bad" };
}

function modelHealthMeta(status) {
  if (status === "healthy") return { label: "可用", className: "good" };
  if (status === "limited") return { label: "限流", className: "warning" };
  if (status === "checking") return { label: "检测中", className: "warning" };
  if (status === "pending") return { label: "待检测", className: "neutral" };
  if (status === "unauthorized") return { label: "授权异常", className: "bad" };
  return { label: "不可用", className: "bad" };
}

function accountLabel(account) {
  return account.identity?.name || account.identity?.email || account.id;
}

function loginAccountLabel(account) {
  return account.id;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(milliseconds) {
  const minutes = Math.round(milliseconds / 60_000);
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} 小时` : `${Math.max(1, minutes)} 分钟`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function numeric(value) {
  return Number.isFinite(value) ? value : 0;
}

function formatStatus(status) {
  return status ? `HTTP ${status}` : "暂无";
}

function formatActivityQuota(referral) {
  const limit = referral.threshold || referral.maxRedemptions;
  return limit > 0 ? `${referral.redeemed} / ${limit}` : "暂无活动名额";
}

function accountTypeLabel(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "-");
  if (!normalized) return "";
  if (normalized === "plus" || normalized.endsWith("-plus")) return "Plus";
  if (normalized === "max" || normalized.endsWith("-max")) return "Max";
  const labels = { basic: "基础版", external: "标准版", enterprise: "企业版" };
  return labels[normalized] || value.trim();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}
