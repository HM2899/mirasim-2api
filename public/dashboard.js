const DEFAULT_REDEEM_STATUS = "兑换成功后将刷新此账号的官方登录态。";
const POOL_PAGE_SIZE = 10;
const USAGE_LOG_PAGE_SIZE = 20;
// 时间/账号/模型/协议/思考等级/输入/输出/缓存读/缓存写/首字/总耗时/状态
const USAGE_LOG_COLUMNS = 12;
// Mirasim's own plan names, as shown by the desktop client.
const PLAN_LABELS = { none: "FREE", free: "FREE", basic: "MAX 2X", plus: "MAX 10X", max: "MAX 40X", enterprise: "企业版", internal: "内部账号" };
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
  poolQuery: "",
  poolCategory: "all",
  poolPage: 1,
  usageLog: [],
  usageLogPage: 1,
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
  usageLogView: document.querySelector("#usage-log-view"),
  navUsageLog: document.querySelector("#nav-usage-log"),
  usageLogUpdated: document.querySelector("#usage-log-updated"),
  usageLogBody: document.querySelector("#usage-log-body"),
  usageLogPageSummary: document.querySelector("#usage-log-page-summary"),
  usageLogPagePrev: document.querySelector("#usage-log-page-prev"),
  usageLogPageNext: document.querySelector("#usage-log-page-next"),
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
  moemailDomains: document.querySelector("#moemail-domains"),
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
  previewCode: document.querySelector("#preview-code"),
  redeemStatus: document.querySelector("#redeem-status"),
  poolBody: document.querySelector("#pool-body"),
  poolSearch: document.querySelector("#pool-search"),
  poolCategory: document.querySelector("#pool-category"),
  poolPageSummary: document.querySelector("#pool-page-summary"),
  poolPagePrev: document.querySelector("#pool-page-prev"),
  poolPageNext: document.querySelector("#pool-page-next"),
  restoreAccounts: document.querySelector("#restore-accounts"),
  importAccounts: document.querySelector("#import-accounts"),
  importAccountsFile: document.querySelector("#import-accounts-file"),
  exportAccounts: document.querySelector("#export-accounts"),
  modelHealthUpdated: document.querySelector("#model-health-updated"),
  modelHealthDiscover: document.querySelector("#model-health-discover"),
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
elements.navUsageLog.addEventListener("click", () => setView("usageLog"));
elements.modelHealthDiscover.addEventListener("click", discoverModels);
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
elements.notice.addEventListener("click", hideNotice);
elements.copyCode.addEventListener("click", copyInviteCode);
elements.redeemForm.addEventListener("submit", redeemInvite);
elements.previewCode.addEventListener("click", previewRedeemCode);
elements.mirasimCodeForm.addEventListener("submit", requestMirasimCode);
elements.mirasimVerifyForm.addEventListener("submit", verifyMirasimLogin);
elements.moemailRegisterForm.addEventListener("submit", registerWithMoeMail);
elements.moemailConfigForm.addEventListener("submit", saveMoeMailConfig);
elements.moemailDomains.addEventListener("click", discoverMoeMailDomains);
elements.apiKeyForm.addEventListener("submit", createApiKey);
elements.copyApiKey.addEventListener("click", copyApiKey);
elements.apiKeyList.addEventListener("click", revokeApiKey);
elements.apiKeyList.addEventListener("click", copyHistoricalApiKey);
elements.poolBody.addEventListener("click", deleteAccount);
elements.poolBody.addEventListener("click", renewAccount);
elements.poolBody.addEventListener("click", cooldownAccount);
elements.poolBody.addEventListener("click", recoverAccount);
elements.poolBody.addEventListener("change", changeAccountPriority);
elements.poolSearch.addEventListener("input", () => {
  state.poolQuery = elements.poolSearch.value.trim();
  state.poolPage = 1;
  renderPool(state.data?.accounts || []);
});
elements.poolCategory.addEventListener("change", () => {
  state.poolCategory = elements.poolCategory.value;
  state.poolPage = 1;
  renderPool(state.data?.accounts || []);
});
elements.poolPagePrev.addEventListener("click", () => changePoolPage(-1));
elements.poolPageNext.addEventListener("click", () => changePoolPage(1));
elements.usageLogPagePrev.addEventListener("click", () => changeUsageLogPage(-1));
elements.usageLogPageNext.addEventListener("click", () => changeUsageLogPage(1));
elements.restoreAccounts.addEventListener("click", restoreAccounts);
elements.importAccounts.addEventListener("click", () => elements.importAccountsFile.click());
elements.importAccountsFile.addEventListener("change", importAccounts);
elements.exportAccounts.addEventListener("click", exportAccounts);
elements.modelHealthBody.addEventListener("click", checkModel);

loadDashboard();
setInterval(loadDashboard, 60_000);
setInterval(() => {
  if (state.activeView === "modelHealth") void loadModelHealth();
  if (state.activeView === "usageLog") void loadUsageLog();
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
  // Login always defaults to a fresh pool slot; existing accounts remain selectable explicitly.
  state.loginKey = "new";
    }
    render();
  } catch (error) {
    showNotice(error.message || "无法读取控制台数据。");
  } finally {
    state.loading = false;
    elements.refresh.disabled = false;
  }
}

async function loadUsageLog() {
  try {
    const result = await request("/api/usage-log");
    state.usageLog = result.entries || [];
    renderUsageLog();
  } catch {
    // Keep the last rendered result while a background poll is unavailable.
  }
}

function renderUsageLog() {
  const entries = state.usageLog || [];
  elements.usageLogUpdated.textContent = `更新于 ${formatTime(new Date().toISOString())} · 共 ${entries.length} 条`;
  const pageCount = Math.max(1, Math.ceil(entries.length / USAGE_LOG_PAGE_SIZE));
  state.usageLogPage = Math.min(Math.max(state.usageLogPage, 1), pageCount);
  const offset = (state.usageLogPage - 1) * USAGE_LOG_PAGE_SIZE;
  const pageEntries = entries.slice(offset, offset + USAGE_LOG_PAGE_SIZE);
  elements.usageLogPageSummary.textContent = entries.length === 0
    ? "暂无记录"
    : `${offset + 1}-${offset + pageEntries.length} / ${entries.length} 条`;
  elements.usageLogPagePrev.disabled = state.usageLogPage <= 1;
  elements.usageLogPageNext.disabled = state.usageLogPage >= pageCount;
  if (pageEntries.length === 0) {
    elements.usageLogBody.innerHTML = `<tr><td colspan="${USAGE_LOG_COLUMNS}" class="empty-table">还没有中转请求记录。</td></tr>`;
    return;
  }
  elements.usageLogBody.innerHTML = pageEntries.map((entry) => {
    const status = `<span class="table-status ${entry.status >= 200 && entry.status < 300 ? "good" : "bad"}">${entry.status ? `HTTP ${entry.status}` : "失败"}</span>`;
    return `<tr>
      <td>${escapeHtml(formatTime(entry.completedAt || entry.at))}</td>
      <td>${escapeHtml(usageAccountLabel(entry.account))}</td>
      <td><code>${escapeHtml(entry.model || "-")}</code>${entry.stream ? `<span class="account-sub">流式</span>` : ""}</td>
      <td>${escapeHtml(entry.protocol || "-")}</td>
      <td>${escapeHtml(reasoningLabel(entry.reasoningEffort))}</td>
      <td class="token-cell">${tokenCell(entry.inputTokens)}</td>
      <td class="token-cell">${tokenCell(entry.outputTokens)}</td>
      <td class="token-cell">${tokenCell(entry.cacheReadTokens)}</td>
      <td class="token-cell">${tokenCell(entry.cacheWriteTokens)}</td>
      <td>${latencyCell(entry.ttfbMs)}</td>
      <td>${latencyCell(entry.durationMs)}</td>
      <td>${status}</td>
    </tr>`;
  }).join("");
}

function changeUsageLogPage(direction) {
  const pageCount = Math.max(1, Math.ceil((state.usageLog || []).length / USAGE_LOG_PAGE_SIZE));
  state.usageLogPage = Math.min(pageCount, Math.max(1, state.usageLogPage + direction));
  renderUsageLog();
}

// The log only keeps the account id the relay authenticated with; the mailbox is what the
// operator actually recognises, so it is resolved from the pool that is already loaded.
function usageAccountLabel(account) {
  if (!account) return "-";
  const match = (state.data?.accounts || []).find((item) => item.id === account || item.key === account || item.home === account);
  return match?.identity?.email || match?.identity?.name || match?.key || account;
}

function tokenCell(value) {
  return value === null || value === undefined ? "-" : escapeHtml(formatNumber(value));
}

function latencyCell(value) {
  if (value === null || value === undefined) return "-";
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} 秒` : `${value} 毫秒`;
}

function reasoningLabel(value) {
  if (!value) return "默认";
  if (value === "none") return "关闭";
  if (value === "low") return "低";
  if (value === "medium") return "中";
  if (value === "high") return "高";
  if (value.startsWith("budget:")) return `${value.slice(7)} tokens`;
  return value;
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
  state.loginKey = "new";
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
    modelHealth: { nav: elements.navModelHealth, panel: elements.modelHealthView },
    usageLog: { nav: elements.navUsageLog, panel: elements.usageLogView }
  };
  if (!views[view]) return;
  state.activeView = view;
  if (view === "usageLog") void loadUsageLog();
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
  const scanCopy = health.scanIntervalMs ? `每 ${formatDuration(health.scanIntervalMs)} 轮转检测一个模型` : "定时检测未启用";
  elements.modelHealthUpdated.textContent = health.discovering
    ? "正在读取模型目录..."
    : health.running ? `正在检测 ${health.activeModelId || "模型"}...` : health.lastFinishedAt ? `上次检测 ${formatTime(health.lastFinishedAt)}，${scanCopy}` : health.lastDiscoveredAt ? `目录更新于 ${formatTime(health.lastDiscoveredAt)}，${scanCopy}` : scanCopy;
  elements.modelHealthDiscover.disabled = Boolean(health.discovering || health.running);
  elements.modelHealthDiscover.textContent = health.discovering ? "读取中" : "刷新模型";
  elements.modelHealthSummary.innerHTML = `<span class="health-count good">可用 ${numeric(totals.healthy)}</span><span class="health-count warning">限流 ${numeric(totals.limited)}</span><span class="health-count bad">不可用 ${numeric(totals.unavailable) + numeric(totals.unauthorized)}</span><span class="health-count neutral">待检测 ${numeric(totals.pending) + numeric(totals.checking)}</span><span class="health-count neutral">已发现 ${models.length}</span>${health.lastError ? `<span class="health-error">${escapeHtml(health.lastError)}</span>` : ""}`;
  if (models.length === 0) {
    elements.modelHealthBody.innerHTML = `<tr><td colspan="8" class="empty-table">${health.discovering || health.running ? "正在获取上游模型列表..." : "尚未发现可检测的模型。"}</td></tr>`;
    return;
  }
  elements.modelHealthBody.innerHTML = models.map((model) => {
    const meta = modelHealthMeta(model.status);
    const testing = health.running && health.activeModelId === model.id;
    return `<tr><td><code>${escapeHtml(model.id)}</code></td><td><span class="table-status ${meta.className}">${meta.label}</span></td><td>${model.latencyMs ? `${formatNumber(model.latencyMs)} ms` : "-"}</td><td>${model.httpStatus || "-"}</td><td>${escapeHtml(formatTime(model.checkedAt))}</td><td class="model-health-message">${escapeHtml(model.message || "-")}</td><td><button class="button button-secondary model-check" type="button" data-model-id="${escapeHtml(model.id)}" ${health.running ? "disabled" : ""}>${testing ? "检测中" : "检测"}</button></td></tr>`;
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
  renderOverviewCounter(elements.overviewRequestCount, totals.requests);
  renderOverviewCounter(elements.overviewInputTokens, totals.inputTokens);
  renderOverviewCounter(elements.overviewOutputTokens, totals.outputTokens);
  renderOverviewCounter(elements.overviewCacheReadTokens, totals.cacheReadTokens);
  renderOverviewCounter(elements.overviewCacheWriteTokens, totals.cacheWriteTokens);
}

// A running total is what the card is for; the exact digits are what the tooltip is for.
function renderOverviewCounter(element, value) {
  element.textContent = formatCompactNumber(value);
  element.title = formatNumber(numeric(value));
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
    <td><div class="account-actions">${key.copyable ? `<button class="button button-secondary key-copy" type="button" data-copy-key-id="${escapeHtml(key.id)}">复制</button>` : `<span class="account-sub">不可恢复</span>`}<button class="button button-secondary key-revoke" type="button" data-key-id="${escapeHtml(key.id)}">吊销</button></div></td>
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
  // The reward tier is what the invites unlock: the next tier, or the current one once reached.
  const reward = accountTypeLabel(referral?.rewardPlan) || (referral ? "官方暂未开放奖励档位" : "暂无活动信息");
  elements.membership.innerHTML = `
    <div><span class="plan-label">账户类型</span><strong class="plan-name">${escapeHtml(plan)}</strong></div>
    <div class="plan-divider" aria-hidden="true">→</div>
    <div class="plan-next"><span class="plan-label">活动目标</span><strong class="plan-name">${escapeHtml(reward)}</strong></div>`;

  const threshold = referral?.threshold || 0;
  const redeemed = referral?.redeemed || 0;
  const percentage = threshold > 0 ? Math.min(100, Math.round((redeemed / threshold) * 100)) : 0;
  elements.redeemed.textContent = threshold > 0 ? `${redeemed} / ${threshold}` : String(redeemed);
  elements.remaining.textContent = !referral
    ? "暂无活动名额"
    : referral.maxRedemptions > 0 ? `邀请码剩余可兑换 ${referral.remaining} 次` : "官方未限制兑换次数";
  elements.progress.style.width = `${percentage}%`;
  elements.progressCopy.textContent = activityCopy(referral, reward);
  setBadge(elements.activityState, referral?.reached ? "已达成" : referral ? "进行中" : "暂无数据", referral?.reached ? "good" : referral ? "warning" : "bad");

  const code = referral?.code || "";
  elements.inviteCode.textContent = code || "尚未生成";
  elements.inviteCopy.textContent = inviteCopy(referral, code);
  elements.copyCode.disabled = !code;
  elements.createCode.disabled = !account.loggedIn;
  elements.previewCode.disabled = !account.loggedIn;
  elements.redeemForm.querySelector("button[type=submit]").disabled = !account.loggedIn;
}

function inviteCopy(referral, code) {
  if (!referral) return "官方活动接口暂无数据，仍可尝试生成邀请码。";
  if (!code) return "尚未生成邀请码，点击生成后即可复制并分享。";
  if (referral.maxRedemptions > 0) return `本邀请码最多可兑换 ${referral.maxRedemptions} 次，剩余 ${referral.remaining} 次。`;
  return "官方未限制该邀请码的兑换次数。";
}

function activityCopy(referral, reward) {
  if (!referral) return "官方活动接口当前未返回数据。";
  if (referral.threshold <= 0) return "官方当前未开放邀请奖励档位。";
  if (referral.reached) return `已达成本轮目标，可兑换${reward}一个月。`;
  return `再邀请 ${referral.needed ?? Math.max(0, referral.threshold - referral.redeemed)} 位，可兑换${reward}一个月。`;
}

function renderPool(accounts) {
  const filtered = accounts.filter(matchesPoolFilter);
  const pageCount = Math.max(1, Math.ceil(filtered.length / POOL_PAGE_SIZE));
  state.poolPage = Math.min(Math.max(state.poolPage, 1), pageCount);
  const offset = (state.poolPage - 1) * POOL_PAGE_SIZE;
  const pageAccounts = filtered.slice(offset, offset + POOL_PAGE_SIZE);
  const start = filtered.length ? offset + 1 : 0;
  const end = Math.min(offset + POOL_PAGE_SIZE, filtered.length);
  elements.poolSearch.value = state.poolQuery;
  elements.poolCategory.value = state.poolCategory;
  elements.poolPageSummary.textContent = `${start}-${end} / ${filtered.length} 个账户`;
  elements.poolPagePrev.disabled = state.poolPage <= 1;
  elements.poolPageNext.disabled = state.poolPage >= pageCount;
  if (pageAccounts.length === 0) {
    elements.poolBody.innerHTML = `<tr><td colspan="8" class="empty-table">没有符合当前筛选条件的账户。</td></tr>`;
    return;
  }
  elements.poolBody.innerHTML = pageAccounts.map((account) => {
    const status = availabilityMeta(account.quota.availability);
    const identity = account.identity?.name || account.identity?.email || account.id;
    const plan = accountTypeLabel(account.referral?.currentPlan || account.identity?.accountType) || "普通用户";
    const activity = account.referral ? formatActivityQuota(account.referral) : "暂无官方数据";
    const windows = (account.quota?.windows || []).map((window) => `<li><strong>${escapeHtml(window.name)}</strong><span>${window.resetAt ? `重置 ${escapeHtml(formatCompactTime(typeof window.resetAt === "number" ? window.resetAt * 1000 : window.resetAt))}` : "暂无重置时间"}</span></li>`).join("");
    return `<tr>
      <td><span class="account-name">${escapeHtml(identity)}</span><span class="account-sub">${escapeHtml(account.identity?.email || account.id)}</span>${account.identity?.subscriptionExpiresAt ? `<span class="account-sub" title="${escapeHtml(formatTime(account.identity.subscriptionExpiresAt))}">订阅至 ${escapeHtml(formatExpiryDate(account.identity.subscriptionExpiresAt))}</span>` : ""}</td>
      <td>${escapeHtml(plan)}</td>
      <td>${escapeHtml(activity)}</td>
      <td>${quotaCell(account, windows)}</td>
      <td>${priorityCell(account)}</td>
      <td><span class="table-status ${status.className}">${status.label}</span>${account.quota.availability === "cooling" && account.cooldownUntil ? `<span class="account-sub">冷却至 ${escapeHtml(formatCompactTime(account.cooldownUntil))}</span>` : ""}</td>
      <td>${escapeHtml(formatStatus(account.quota.lastStatus))}</td>
      <td><div class="account-actions">${cooldownActionButton(account)}<button class="button button-secondary account-renew" type="button" data-renew-account="${escapeHtml(account.key)}">续期</button><button class="button button-secondary account-delete" type="button" data-account-key="${escapeHtml(account.key)}">删除</button></div></td>
    </tr>`;
  }).join("");
}

// The rotation serves the highest priority available account first and rotates inside one
// priority. "自动" leaves the account ordered by its plan, which is what most accounts want.
const PRIORITY_CHOICES = [["auto", "自动（按档位）"], ["100", "最高 100"], ["75", "较高 75"], ["50", "普通 50"], ["25", "较低 25"], ["0", "最低 0"]];

function priorityCell(account) {
  const override = account.priorityOverride === null || account.priorityOverride === undefined ? "auto" : String(account.priorityOverride);
  const known = PRIORITY_CHOICES.some(([value]) => value === override);
  const choices = known ? PRIORITY_CHOICES : [...PRIORITY_CHOICES, [override, `自定义 ${override}`]];
  const options = choices.map(([value, label]) => `<option value="${escapeHtml(value)}"${value === override ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
  const effective = typeof account.priority === "number" ? account.priority : "-";
  return `<div class="priority-cell"><select class="account-priority" data-priority-account="${escapeHtml(account.key)}" aria-label="轮询优先级" title="轮询优先级">${options}</select><span class="account-sub">当前 ${escapeHtml(String(effective))}</span></div>`;
}

function cooldownActionButton(account) {
  if (!account.loggedIn && !account.disabled) return "";
  if (account.disabled || account.quota.availability === "cooling") {
    return `<button class="button button-secondary account-recover" type="button" data-recover-account="${escapeHtml(account.key)}">恢复</button>`;
  }
  return `<button class="button button-secondary account-cooldown" type="button" data-cooldown-account="${escapeHtml(account.key)}">冷却</button>`;
}

function changePoolPage(direction) {
  const accounts = state.data?.accounts || [];
  const filtered = accounts.filter(matchesPoolFilter);
  const pageCount = Math.max(1, Math.ceil(filtered.length / POOL_PAGE_SIZE));
  state.poolPage = Math.min(pageCount, Math.max(1, state.poolPage + direction));
  renderPool(accounts);
}

function matchesPoolFilter(account) {
  const category = poolCategory(account);
  if (state.poolCategory !== "all" && category !== state.poolCategory) return false;
  const query = state.poolQuery.trim().toLocaleLowerCase();
  if (!query) return true;
  const values = [account.key, account.id, account.identity?.name, account.identity?.email];
  return values.some((value) => String(value || "").toLocaleLowerCase().includes(query));
}

function poolCategory(account) {
  if (!account.loggedIn) return "logged-out";
  const raw = account.referral?.currentPlan || account.identity?.accountType || "";
  const plan = raw.trim().toLowerCase();
  if (plan === "max" || plan === "enterprise" || plan === "internal") return "max";
  if (plan === "plus") return "plus";
  if (plan === "basic") return "member";
  if (!plan || plan === "none" || plan === "free" || raw.trim() === "普通用户") return "standard";
  return "member";
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

async function discoverMoeMailDomains() {
  setBusy(elements.moemailDomains, true, "获取中");
  try {
    const result = await request("/api/moemail/domains", {
      method: "POST",
      body: { url: elements.moemailUrl.value.trim(), apiKey: elements.moemailApiKey.value.trim() }
    });
    elements.moemailDomain.value = result.domains.join(", ");
    elements.moemailConfigStatus.textContent = `已获取 ${result.domains.length} 个域名`;
    elements.moemailConfigStatus.dataset.state = "ready";
  } catch (error) {
    showNotice(error.message || "无法获取 MoeMail 域名。", "error");
  } finally {
    setBusy(elements.moemailDomains, false, "自动获取域名");
  }
}

async function createReferral() {
  const account = selectedAccount();
  if (!account) return;
  setBusy(elements.createCode, true, "生成中");
  try {
    const result = await request("/api/referral", { method: "POST", body: { account: account.key } });
    await loadDashboard();
    const code = result.referral?.code || "";
    showNotice(code ? `邀请码已生成：${code}` : "官方未返回邀请码，请稍后重试。", code ? "success" : "error");
  } catch (error) {
    showNotice(error.message || "无法生成邀请码。", "error");
  } finally {
    setBusy(elements.createCode, false, "生成");
  }
}

async function copyInviteCode() {
  const code = elements.inviteCode.textContent;
  if (!code || code === "尚未生成") return;
  try {
    await copyText(code);
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
  const button = elements.redeemForm.querySelector("button[type=submit]");
  const license = isLicenseCode(code);
  state.redeemStatus = { text: license ? "正在兑换授权码..." : "正在兑换邀请码...", type: "pending" };
  renderRedeemStatus();
  setBusy(button, true, "兑换中");
  try {
    const result = await request("/api/invites/redeem", { method: "POST", body: { account: account.key, code } });
    elements.redeemCode.value = "";
    state.redeemStatus = { text: redeemedCopy(result), type: "success" };
    renderRedeemStatus();
    showNotice(state.redeemStatus.text, "success");
    await loadDashboard();
  } catch (error) {
    state.redeemStatus = { text: error.message || (license ? "授权码兑换失败。" : "邀请码兑换失败。"), type: "error" };
    renderRedeemStatus();
    showNotice(state.redeemStatus.text, "error");
  } finally {
    setBusy(button, false, "兑换");
  }
}

// MLIC licences report which tier they granted and whether that was an upgrade or a renewal.
function redeemedCopy(result) {
  if (result?.kind !== "license") return "邀请码已兑换，账号状态已刷新。";
  const plan = accountTypeLabel(result.plan) || "该档位";
  const duration = result.durationDays ? `${result.durationDays} 天` : "";
  if (result.action === "extend") return `授权码已兑换：${plan}已续期${duration}。`;
  if (result.action === "upgrade") return `授权码已兑换：已升级为${plan}${duration ? `（${duration}）` : ""}。`;
  return `授权码已兑换：${plan}${duration ? `（${duration}）` : ""}。`;
}

async function previewRedeemCode() {
  const account = selectedAccount();
  const code = elements.redeemCode.value.trim();
  if (!account) return;
  if (!code) {
    state.redeemStatus = { text: "请输入邀请码或 MLIC 授权码。", type: "error" };
    renderRedeemStatus();
    return;
  }
  setBusy(elements.previewCode, true, "查询中");
  try {
    const result = await request("/api/invites/preview", { method: "POST", body: { account: account.key, code } });
    state.redeemStatus = { text: previewCopy(result), type: result.verdict === "redeemable" ? "success" : "pending" };
  } catch (error) {
    state.redeemStatus = { text: error.message || "无法校验该兑换码。", type: "error" };
  } finally {
    renderRedeemStatus();
    setBusy(elements.previewCode, false, "查看档位");
  }
}

function previewCopy(result) {
  if (!result?.supported) return "邀请码无需预检，直接兑换即可；MLIC 开头的授权码可先查看档位。";
  const plan = accountTypeLabel(result.plan) || "未知档位";
  const duration = result.durationDays ? `，有效期 ${result.durationDays} 天` : "";
  if (result.verdict === "already_redeemed") return `该授权码（${plan}）已被兑换。`;
  if (result.verdict === "blocked_lower_tier") return `该授权码为${plan}，低于当前账号档位，兑换会被官方拦截，且不会消耗该授权码。`;
  if (result.action === "extend") return `可兑换：${plan}同档续期${duration}。`;
  return `可兑换：${plan}${duration}，兑换后立即升档。`;
}

function isLicenseCode(code) {
  return code.toUpperCase().replace(/[\s\-_]/g, "").startsWith("MLIC");
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
    await copyText(state.issuedApiKey);
    showNotice("OpenAI API Key 已复制。", "success");
  } catch {
    showNotice("浏览器未授予剪贴板权限。", "error");
  }
}

async function copyHistoricalApiKey(event) {
  const button = event.target.closest("[data-copy-key-id]");
  if (!button) return;
  setBusy(button, true, "复制中");
  try {
    const result = await request(`/api/keys/${encodeURIComponent(button.dataset.copyKeyId)}/reveal`, { method: "POST" });
    await copyText(result.key);
    showNotice("历史 API Key 已复制。", "success");
  } catch (error) {
    showNotice(error.message || "无法复制历史 API Key。", "error");
  } finally {
    setBusy(button, false, "复制");
  }
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("Clipboard unavailable");
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

async function cooldownAccount(event) {
  const button = event.target.closest("[data-cooldown-account]");
  if (!button || !window.confirm("将该账号移出中转轮询？在你点击恢复之前它不会再被使用。")) return;
  setBusy(button, true, "冷却中");
  try {
    await request(`/api/accounts/${encodeURIComponent(button.dataset.cooldownAccount)}/cooldown`, { method: "POST" });
    await loadDashboard();
    showNotice("该账号已冷却，已停止参与中转轮询。", "success");
  } catch (error) {
    showNotice(error.message || "无法冷却该账号。", "error");
    setBusy(button, false, "冷却");
  }
}

async function changeAccountPriority(event) {
  const select = event.target?.closest?.("select[data-priority-account]");
  if (!select) return;
  const priority = select.value === "auto" ? null : Number(select.value);
  select.disabled = true;
  try {
    const result = await request(`/api/accounts/${encodeURIComponent(select.dataset.priorityAccount)}/priority`, { method: "PUT", body: { priority } });
    await loadDashboard();
    showNotice(priority === null ? `该账号恢复按档位排序（当前 ${result.priority}）。` : `该账号的轮询优先级已设为 ${result.priority}。`, "success");
  } catch (error) {
    showNotice(error.message || "无法调整轮询优先级。", "error");
  } finally {
    select.disabled = false;
  }
}

async function recoverAccount(event) {
  const button = event.target.closest("[data-recover-account]");
  if (!button) return;
  setBusy(button, true, "恢复中");
  try {
    await request(`/api/accounts/${encodeURIComponent(button.dataset.recoverAccount)}/recover`, { method: "POST" });
    await loadDashboard();
    showNotice("该账号已恢复中转可用。", "success");
  } catch (error) {
    showNotice(error.message || "无法恢复该账号。", "error");
    setBusy(button, false, "恢复");
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

async function importAccounts() {
  const file = elements.importAccountsFile.files?.[0];
  elements.importAccountsFile.value = "";
  if (!file) return;
  setBusy(elements.importAccounts, true, "导入中");
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error("账号文件不能超过 4MB。");
    const payload = JSON.parse(await file.text());
    const result = await request("/api/accounts/import", { method: "POST", body: payload });
    await loadDashboard();
    showNotice(`已导入 ${result.imported} 个账号${result.skipped ? `，跳过 ${result.skipped} 个重复或无效账号` : ""}。`, "success");
  } catch (error) {
    showNotice(error instanceof SyntaxError ? "账号文件不是有效的 JSON。" : error.message || "无法导入账号。", "error");
  } finally {
    setBusy(elements.importAccounts, false, "导入账号");
  }
}

async function exportAccounts() {
  if (!window.confirm("导出文件包含账号登录令牌，请将其作为敏感文件保管。继续导出？")) return;
  setBusy(elements.exportAccounts, true, "导出中");
  try {
    const response = await fetch("/api/accounts/export");
    if (!response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch {}
      throw new Error(apiErrorMessage(payload, response.status, "/api/accounts/export"));
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "mirasim-accounts.json";
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
    showNotice("账号已导出。", "success");
  } catch (error) {
    showNotice(error.message || "无法导出账号。", "error");
  } finally {
    setBusy(elements.exportAccounts, false, "导出账号");
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

async function checkModel(event) {
  const button = event.target.closest("[data-model-id]");
  if (!button) return;
  setBusy(button, true, "检测中");
  try {
    const result = await request(`/api/model-health/${encodeURIComponent(button.dataset.modelId)}/check`, { method: "POST" });
    state.modelHealth = result.health;
    renderModelHealth();
  } catch (error) {
    showNotice(error.message || "模型检测失败。", "error");
    setBusy(button, false, "检测");
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
  let response;
  try {
    response = await fetch(url, {
      method: options.method || "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch (error) {
    throw new Error(error?.message === "Failed to fetch" ? "无法连接本地网关，请确认服务仍在运行。" : "网络请求失败。");
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The server always returns JSON for API routes.
  }
  if (!response.ok) throw new Error(apiErrorMessage(payload, response.status, url));
  return payload;
}

// A 404 answered by the relay's route list means this page is newer than the gateway process serving
// it, which is what happens when the console is reloaded but the local service was never restarted.
function apiErrorMessage(payload, status, url) {
  const message = payload?.error?.message;
  if (status === 404 && url.startsWith("/api/") && (!message || message.startsWith("Use /"))) {
    return "本地网关不认识该接口（HTTP 404），请重启本机网关后重试。";
  }
  return message || `请求失败（HTTP ${status}）。`;
}

function setBadge(element, text, className) {
  element.textContent = text;
  element.className = `badge ${className}`;
}

function setBusy(button, busy, text) {
  button.disabled = busy;
  button.textContent = text;
}

// Notices are a toast in the top-right corner: they announce themselves and then get out of the
// way. Failures linger longer than confirmations, and a click dismisses either immediately.
const NOTICE_TIMEOUT_MS = { success: 4_000, error: 8_000 };
let noticeTimer = 0;

function showNotice(text, type = "error") {
  clearTimeout(noticeTimer);
  elements.notice.hidden = false;
  elements.notice.textContent = text;
  elements.notice.dataset.state = type === "success" ? "success" : "error";
  noticeTimer = setTimeout(hideNotice, NOTICE_TIMEOUT_MS[type] || NOTICE_TIMEOUT_MS.error);
}

function hideNotice() {
  clearTimeout(noticeTimer);
  noticeTimer = 0;
  elements.notice.hidden = true;
}

// A free account keeps a nominal window on /v1/limits, but the relay answers its completions with
// "中转的共享额度已用尽", so the pool only falls back to it when no paid account is left.
function quotaCell(account, windows) {
  if (account.quota?.availability === "no_quota") return "免费号无中转额度";
  return windows ? `<ul class="quota-windows">${windows}</ul>` : "官方暂无额度数据";
}

function availabilityMeta(value) {
  if (value === "available") return { label: "可用", className: "good" };
  if (value === "cooling") return { label: "冷却中", className: "warning" };
  if (value === "disabled") return { label: "已冷却（停止轮询）", className: "warning" };
  if (value === "no_quota") return { label: "无额度（最后备用）", className: "warning" };
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

// Table cells only have room for the part of a timestamp that differs between rows.
function formatCompactTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

// A subscription runs months or years out, so the year the compact table format drops is the
// part that actually identifies the date; the exact hour stays in the cell's tooltip.
function formatExpiryDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function formatDuration(milliseconds) {
  const minutes = Math.round(milliseconds / 60_000);
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} 小时` : `${Math.max(1, minutes)} 分钟`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

// Token totals reach seven and eight digits, and at that width the card stops reading as a
// quantity at a glance. K/M/B keeps three significant digits, which is all the summary needs.
function formatCompactNumber(value) {
  const amount = numeric(value);
  for (const [scale, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
    if (Math.abs(amount) < scale) continue;
    const scaled = amount / scale;
    const text = scaled.toFixed(Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2);
    return `${text.includes(".") ? text.replace(/\.?0+$/, "") : text}${suffix}`;
  }
  return formatNumber(amount);
}

function numeric(value) {
  return Number.isFinite(value) ? value : 0;
}

function formatStatus(status) {
  return status ? `HTTP ${status}` : "暂无";
}

function formatActivityQuota(referral) {
  if (referral.threshold > 0) return `${referral.redeemed} / ${referral.threshold}`;
  return referral.redeemed > 0 ? `已邀请 ${referral.redeemed} 位` : "暂无活动名额";
}

function accountTypeLabel(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "";
  return PLAN_LABELS[normalized] || value.trim();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}
