const DEFAULT_REDEEM_STATUS = "兑换成功后将刷新此账号的官方登录态。";
const POOL_PAGE_SIZE = 10;
const USAGE_LOG_PAGE_SIZE = 20;
const USAGE_LOG_COLUMNS = 9;
const CONSOLE_PAGE_SIZE = 10;
const SKELETON_VALUE = '<span class="skeleton skeleton-value" aria-hidden="true"></span>';
const SKELETON_WIDTHS = ["", " skeleton-medium", " skeleton-short"];
const ACTIVE_VIEW_STORAGE_KEY = "mirasim.dashboard.activeView";
// Mirasim's own plan names, as shown by the desktop client.
const PLAN_LABELS = { none: "FREE", free: "FREE", go: "Go", basic: "MAX 2X", plus: "MAX 10X", max: "MAX 40X", enterprise: "企业版", internal: "内部账号" };
const state = {
  data: null,
  apiKeys: [],
  apiKeysLoaded: false,
  moduleErrors: {},
  modelHealth: null,
  issuedApiKey: null,
  issuedApiKeyId: null,
  apiKeyQuery: "",
  apiKeyStatus: "all",
  apiKeySort: "newest",
  apiKeyPage: 1,
  modelHealthQuery: "",
  modelHealthStatus: "all",
  modelHealthSort: "attention",
  modelHealthPage: 1,
  modelHealthLoading: false,
  modelHealthError: "",
  modelHealthAction: null,
  selectedKey: null,
  loginKey: null,
  loginAttempt: null,
  moemailConfig: null,
  redeemStatus: { text: DEFAULT_REDEEM_STATUS, type: "idle" },
  poolQuery: "",
  poolCategory: "all",
  poolSort: "default",
  poolPage: 1,
  poolStatus: "all",
  poolActions: new Map(),
  poolSelection: new Set(),
  poolBulkBusy: false,
  usageLog: [],
  usageLogPage: 1,
  usageLogQuery: "",
  usageLogStatus: "all",
  usageLogProtocol: "all",
  usageLogApiKey: "all",
  usageLogSort: "newest",
  usageLogPaused: false,
  usageLogLoading: null,
  usageLogLoadedAt: null,
  usageLogError: "",
  usageLogSelected: null,
  usageLogSelectedAt: null,
  loading: false,
  activeView: "overview"
};
const resetCardState = { account: null, selectionId: null, snapshot: null, loading: false, busy: false, error: "", notice: "", generation: 0 };
const resetCardRefreshes = new Map();
const resetCardUpdates = new Map();
let resetCardRevision = 0;
const activeReads = new Set();
const readLoads = new Set();
let readGeneration = 0;
let pageActive = true;
let webSessionExpired = false;
let dashboardInterval = null;
let viewInterval = null;
let resumePromise = null;
let resumeGeneration = 0;
let resumeAgain = false;

const elements = {
  refresh: document.querySelector("#refresh"),
  logout: document.querySelector("#logout"),
  relayHost: document.querySelector("#relay-host"),
  updatedAt: document.querySelector("#updated-at"),
  notice: document.querySelector("#notice"),
  dashboardSyncStatus: document.querySelector("#dashboard-sync-status"),
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
  usageLogSummary: document.querySelector("#usage-log-summary"),
  usageLogFilterSummary: document.querySelector("#usage-log-filter-summary"),
  usageLogSearch: document.querySelector("#usage-log-search"),
  usageLogStatus: document.querySelector("#usage-log-status"),
  usageLogProtocol: document.querySelector("#usage-log-protocol"),
  usageLogApiKey: document.querySelector("#usage-log-api-key"),
  usageLogSort: document.querySelector("#usage-log-sort"),
  usageLogReset: document.querySelector("#usage-log-reset"),
  usageLogPause: document.querySelector("#usage-log-pause"),
  usageLogRefresh: document.querySelector("#usage-log-refresh"),
  usageLogDetail: document.querySelector("#usage-log-detail"),
  usageLogDetailTitle: document.querySelector("#usage-log-detail-title"),
  usageLogDetailBody: document.querySelector("#usage-log-detail-body"),
  usageLogDetailClose: document.querySelector("#usage-log-detail-close"),
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
  apiKeySummary: document.querySelector("#api-key-summary"),
  apiKeySearch: document.querySelector("#api-key-search"),
  apiKeyStatus: document.querySelector("#api-key-status"),
  apiKeySort: document.querySelector("#api-key-sort"),
  apiKeyReset: document.querySelector("#api-key-reset"),
  apiKeyPageSummary: document.querySelector("#api-key-page-summary"),
  apiKeyPagePrev: document.querySelector("#api-key-page-prev"),
  apiKeyPageNext: document.querySelector("#api-key-page-next"),
  dismissApiKey: document.querySelector("#dismiss-api-key"),
  overviewPulseTitle: document.querySelector("#overview-pulse-title"),
  overviewPulseCopy: document.querySelector("#overview-pulse-copy"),
  overviewTokenMix: document.querySelector("#overview-token-mix"),
  overviewWorkspace: document.querySelector("#overview-workspace"),
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
  poolSelectPage: document.querySelector("#pool-select-page"),
  poolSelectFiltered: document.querySelector("#pool-select-filtered"),
  poolClearSelection: document.querySelector("#pool-clear-selection"),
  poolSelectionCount: document.querySelector("#pool-selection-count"),
  poolSelectionWarning: document.querySelector("#pool-selection-warning"),
  poolBulkDisable: document.querySelector("#pool-bulk-disable"),
  poolBulkRecover: document.querySelector("#pool-bulk-recover"),
  poolBulkDelete: document.querySelector("#pool-bulk-delete"),
  poolSearch: document.querySelector("#pool-search"),
  poolCategory: document.querySelector("#pool-category"),
  poolSort: document.querySelector("#pool-sort"),
  poolCapacity: document.querySelector("#pool-capacity"),
  poolStatusSummary: document.querySelector("#pool-status-summary"),
  poolFilterSummary: document.querySelector("#pool-filter-summary"),
  poolReset: document.querySelector("#pool-reset"),
  rotationModeHint: document.querySelector("#rotation-mode-hint"),
  poolPageSummary: document.querySelector("#pool-page-summary"),
  poolPagePrev: document.querySelector("#pool-page-prev"),
  poolPageNext: document.querySelector("#pool-page-next"),
  recoverAccounts: document.querySelector("#recover-accounts"),
  rotationMode: document.querySelector("#rotation-mode"),
  restoreAccounts: document.querySelector("#restore-accounts"),
  importAccounts: document.querySelector("#import-accounts"),
  importAccountsFile: document.querySelector("#import-accounts-file"),
  exportAccounts: document.querySelector("#export-accounts"),
  modelHealthUpdated: document.querySelector("#model-health-updated"),
  modelHealthDiscover: document.querySelector("#model-health-discover"),
  modelHealthSummary: document.querySelector("#model-health-summary"),
  modelHealthBody: document.querySelector("#model-health-body"),
  modelHealthError: document.querySelector("#model-health-error"),
  modelHealthSearch: document.querySelector("#model-health-search"),
  modelHealthStatus: document.querySelector("#model-health-status"),
  modelHealthSort: document.querySelector("#model-health-sort"),
  modelHealthReset: document.querySelector("#model-health-reset"),
  modelHealthPageSummary: document.querySelector("#model-health-page-summary"),
  modelHealthPagePrev: document.querySelector("#model-health-page-prev"),
  modelHealthPageNext: document.querySelector("#model-health-page-next")
};

for (const [name, view] of [["pool", "accountPool"], ["usage", "usageLog"], ["keys", "apiKeys"], ["health", "modelHealth"]]) {
  document.querySelector(`#overview-open-${name}`).addEventListener("click", () => setView(view));
}
for (const prefix of ["apiKey", "modelHealth"]) {
  elements[`${prefix}Search`].addEventListener("input", () => updateConsoleFilters(prefix));
  elements[`${prefix}Status`].addEventListener("change", () => updateConsoleFilters(prefix));
  elements[`${prefix}Sort`].addEventListener("change", () => updateConsoleFilters(prefix));
  elements[`${prefix}Reset`].addEventListener("click", () => resetConsoleFilters(prefix));
  elements[`${prefix}PagePrev`].addEventListener("click", () => changeConsolePage(prefix, -1));
  elements[`${prefix}PageNext`].addEventListener("click", () => changeConsolePage(prefix, 1));
}
elements.dismissApiKey.addEventListener("click", dismissApiKey);
elements.refresh.addEventListener("click", () => loadDashboard({ notify: true }));
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
elements.poolBody.addEventListener("click", resetAccountQuota);
elements.poolBody.addEventListener("click", refreshAccountResetCards);
elements.poolBody.addEventListener("click", cooldownAccount);
elements.poolBody.addEventListener("click", recoverAccount);
elements.poolBody.addEventListener("change", changeAccountPriority);
elements.poolBody.addEventListener("change", selectPoolAccount);
elements.poolSelectPage.addEventListener("change", () => selectPoolAccounts("page", elements.poolSelectPage.checked));
elements.poolSelectFiltered.addEventListener("click", () => selectPoolAccounts("filtered", true));
elements.poolClearSelection.addEventListener("click", () => selectPoolAccounts("clear", false));
elements.poolBulkDisable.addEventListener("click", () => bulkPoolAccounts("disable"));
elements.poolBulkRecover.addEventListener("click", () => bulkPoolAccounts("recover"));
elements.poolBulkDelete.addEventListener("click", () => bulkPoolAccounts("delete"));
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
elements.poolSort.addEventListener("change", () => {
  state.poolSort = elements.poolSort.value;
  state.poolPage = 1;
  renderPool(state.data?.accounts || []);
});
elements.poolStatusSummary.addEventListener("click", (event) => {
  const button = event.target.closest("[data-pool-status]");
  if (button) setPoolStatus(button.dataset.poolStatus);
});
elements.poolReset.addEventListener("click", resetPoolFilters);
elements.poolPagePrev.addEventListener("click", () => changePoolPage(-1));
elements.poolPageNext.addEventListener("click", () => changePoolPage(1));
elements.usageLogPagePrev.addEventListener("click", () => changeUsageLogPage(-1));
elements.usageLogPageNext.addEventListener("click", () => changeUsageLogPage(1));
elements.usageLogSearch.addEventListener("input", updateUsageLogFilters);
for (const control of [elements.usageLogStatus, elements.usageLogApiKey, elements.usageLogProtocol, elements.usageLogSort]) control.addEventListener("change", updateUsageLogFilters);
elements.usageLogReset.addEventListener("click", resetUsageLogFilters);
elements.usageLogPause.addEventListener("click", toggleUsageLogPause);
elements.usageLogRefresh.addEventListener("click", () => loadUsageLog({ notify: true }));
elements.usageLogBody.addEventListener("click", (event) => {
  const button = event.target.closest("[data-usage-detail]");
  if (button) selectUsageLogEntry(button.dataset.usageDetail);
});
elements.usageLogDetailClose.addEventListener("click", () => selectUsageLogEntry(null));
elements.recoverAccounts.addEventListener("click", recoverAccounts);
elements.rotationMode.addEventListener("change", saveRotationMode);
elements.restoreAccounts.addEventListener("click", restoreAccounts);
elements.importAccounts.addEventListener("click", () => elements.importAccountsFile.click());
elements.importAccountsFile.addEventListener("change", importAccounts);
elements.exportAccounts.addEventListener("click", exportAccounts);
elements.modelHealthBody.addEventListener("click", checkModel);

restoreActiveView();
render();
loadDashboard();
loadRotationMode();
startPolling();
window.addEventListener("online", resumeDashboard);
window.addEventListener("pageshow", () => {
  pageActive = true;
  void resumeDashboard();
});
window.addEventListener("pagehide", () => {
  pageActive = false;
  resumeAgain = false;
  stopPolling();
  cancelReads();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void resumeDashboard();
});

function startPolling() {
  if (webSessionExpired || !pageActive) return;
  if (dashboardInterval === null) dashboardInterval = setInterval(() => {
    if (document.visibilityState !== "hidden") void loadDashboard();
  }, 60_000);
  if (viewInterval === null) viewInterval = setInterval(() => {
    if (document.visibilityState !== "hidden") void loadActiveView();
  }, 5_000);
}

function stopPolling() {
  clearInterval(dashboardInterval);
  clearInterval(viewInterval);
  dashboardInterval = viewInterval = null;
}

function loadActiveView() {
  if (state.activeView === "modelHealth") return loadModelHealth();
  if (state.activeView === "usageLog" && !state.usageLogPaused) return loadUsageLog();
}

// Track the loaders, not just fetch: recovery must wait for their existing finally blocks
// to release the refresh locks before it starts the replacement reads.
function trackReadLoad() {
  const generation = readGeneration;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  readLoads.add(done);
  return {
    current: () => generation === readGeneration && pageActive && !webSessionExpired,
    finish: () => { readLoads.delete(done); finish(); }
  };
}

function readCancelledError() {
  const error = new Error("页面读取已取消。");
  error.name = "AbortError";
  return error;
}

function cancelReads(reason = readCancelledError()) {
  readGeneration += 1;
  for (const controller of activeReads) controller.abort(reason);
}

function expireWebSession(error) {
  if (webSessionExpired) return;
  webSessionExpired = true;
  stopPolling();
  cancelReads(error);
  // Unlike an explicit logout, expiry must retain the saved view for the next login.
  window.location.assign("/login");
}

function resumeDashboard() {
  if (webSessionExpired || !pageActive || document.visibilityState === "hidden") return;
  if (resumePromise) {
    if (resumeGeneration !== readGeneration) resumeAgain = true;
    return resumePromise;
  }
  stopPolling();
  cancelReads();
  resumeGeneration = readGeneration;
  const generation = resumeGeneration;
  resumePromise = (async () => {
    await Promise.allSettled([...readLoads]);
    if (generation !== readGeneration || webSessionExpired || !pageActive || document.visibilityState === "hidden") return;
    startPolling();
    await Promise.allSettled([
      loadDashboard(),
      loadRotationMode(),
      state.activeView === "usageLog" && !state.usageLogPaused ? loadUsageLog() : undefined
    ]);
  })().finally(() => {
    resumePromise = null;
    if (resumeAgain) {
      resumeAgain = false;
      void resumeDashboard();
    }
  });
  return resumePromise;
}

async function loadDashboard({ notify = false } = {}) {
  if (state.loading || webSessionExpired || !pageActive) return;
  const load = trackReadLoad();
  state.loading = true;
  elements.refresh.disabled = true;
  const cardsRevision = resetCardRevision;
  try {
    const modules = [
      { key: "dashboard", label: "账号数据", url: "/api/dashboard", timeoutMs: 120_000, apply: (data) => {
        for (const account of data.accounts) {
          const update = resetCardUpdates.get(account.key);
          if (update && update.revision > cardsRevision && update.selectionId === account.selectionId && update.id === account.id) account.resetCards = update.cards;
        }
        state.data = data;
        const signedIn = data.accounts.filter((account) => account.loggedIn);
        if (!signedIn.some((account) => account.key === state.selectedKey)) state.selectedKey = signedIn[0]?.key || null;
        if (!data.accounts.some((account) => account.key === state.loginKey)) state.loginKey = "new";
      } },
      { key: "apiKeys", label: "API 密钥", url: "/api/keys", apply: (data) => { state.apiKeys = data.keys; state.apiKeysLoaded = true; } },
      { key: "moemailConfig", label: "邮箱配置", url: "/api/moemail/config", apply: (data) => { state.moemailConfig = data; } },
      { key: "modelHealth", label: "模型健康", url: "/api/model-health", apply: (data) => { state.modelHealth = data; state.modelHealthError = ""; } }
    ];
    await Promise.all(modules.map(async (module) => {
      try {
        const data = await request(module.url, { timeoutMs: module.timeoutMs });
        if (!load.current()) return;
        module.apply(data);
        delete state.moduleErrors[module.key];
      } catch (error) {
        if (!load.current()) return;
        state.moduleErrors[module.key] = `${module.label}加载失败：${error.message || "请稍后重试。"}`;
        if (module.key === "modelHealth") state.modelHealthError = state.moduleErrors[module.key];
      }
      render();
    }));
    if (notify && load.current()) {
      const failures = Object.values(state.moduleErrors);
      const warnings = state.data?.accounts.flatMap((account) => account.syncWarnings || []) || [];
      showNotice(failures.length ? `刷新完成，但部分数据读取失败：${failures.join("；")}` : warnings.length ? "刷新完成，部分账号上游信息同步失败，请查看账号同步提示。" : "控制台数据已刷新。", failures.length || warnings.length ? "error" : "success");
    }
  } catch (error) {
    showNotice(error.message || "无法读取控制台数据。");
  } finally {
    state.loading = false;
    elements.refresh.disabled = false;
    load.finish();
  }
}

async function loadUsageLog({ notify = false } = {}) {
  if (webSessionExpired || !pageActive) return;
  if (state.usageLogLoading) {
    await state.usageLogLoading;
    if (notify) showNotice(state.usageLogError || "使用明细已刷新。", state.usageLogError ? "error" : "success");
    return;
  }
  const load = trackReadLoad();
  elements.usageLogRefresh.disabled = true;
  state.usageLogLoading = (async () => {
    if (!state.usageLogLoadedAt) renderUsageLog();
    try {
      const result = await request("/api/usage-log");
      if (!load.current()) return;
      if (!Array.isArray(result?.entries)) throw new Error("使用明细数据格式异常。");
      state.usageLog = result.entries;
      state.usageLogLoadedAt = new Date().toISOString();
      state.usageLogError = "";
    } catch (error) {
      if (load.current()) state.usageLogError = error.message || "暂时无法读取使用明细。";
    } finally {
      state.usageLogLoading = null;
      elements.usageLogRefresh.disabled = false;
      renderUsageLog();
      load.finish();
    }
  })();
  await state.usageLogLoading;
  if (notify && load.current()) showNotice(state.usageLogError || "使用明细已刷新。", state.usageLogError ? "error" : "success");
}

function renderUsageLog() {
  renderUsageLogApiKeyOptions();
  const entries = filteredUsageLog();
  const updated = state.usageLogLoadedAt ? `更新于 ${formatTime(state.usageLogLoadedAt)}` : "尚未读取到使用明细";
  elements.usageLogUpdated.textContent = state.usageLogError ? `${state.usageLogError} ${state.usageLogLoadedAt ? "保留上次结果 · " + updated : "请点击立即刷新重试。"}` : `${updated} · ${state.usageLogPaused ? "已暂停自动刷新" : "自动刷新中"}`;
  elements.usageLogUpdated.className = `updated-at${state.usageLogError ? " usage-log-error" : ""}`;
  elements.usageLogPause.textContent = state.usageLogPaused ? "继续刷新" : "暂停刷新";
  elements.usageLogPause.setAttribute("aria-pressed", String(state.usageLogPaused));
  if (!state.usageLogLoadedAt && !state.usageLogError) {
    elements.usageLogUpdated.textContent = "正在读取使用明细…";
    elements.usageLogFilterSummary.textContent = "正在读取请求记录";
    elements.usageLogSummary.innerHTML = skeletonCards("usage-summary-card");
    elements.usageLogPageSummary.textContent = "";
    elements.usageLogPagePrev.disabled = true;
    elements.usageLogPageNext.disabled = true;
    elements.usageLogBody.innerHTML = skeletonRows(USAGE_LOG_COLUMNS);
    return;
  }
  elements.usageLogFilterSummary.textContent = `当前筛选 ${entries.length} / 已保留 ${state.usageLog.length} 条`;
  renderUsageLogSummary(entries);
  renderUsageLogDetail();
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
    const message = state.usageLog.length ? "没有符合当前筛选条件的请求，请调整搜索或重置筛选。" : state.usageLogError ? "使用明细暂时无法加载，请重试。" : "还没有中转请求记录。发起一次模型调用后，记录会显示在这里。";
    elements.usageLogBody.innerHTML = `<tr><td colspan="${USAGE_LOG_COLUMNS}" class="empty-table">${message}</td></tr>`;
    return;
  }
  elements.usageLogBody.innerHTML = pageEntries.map((entry) => {
    const stages = { waiting_headers: "等待上游响应", waiting_content: "已连接，等待内容", reasoning: "上游推理中", tool_call: "工具参数生成中", text: "正在输出", completed: "已完成", incomplete: "未完整结束", failed: "上游流异常", cancelled: "流已取消", client_disconnected: "客户端断开" };
    const outcome = usageLogOutcome(entry);
    const labels = { pending: "进行中", success: "成功", failed: "失败", incomplete: "未完整结束", cancelled: "已取消" };
    const tone = outcome === "success" ? "good" : outcome === "pending" ? "neutral" : outcome === "failed" ? "bad" : "warning";
    const label = labels[outcome] + (!entry.pending && entry.status ? ` · HTTP ${entry.status}` : "");
    const status = `<span class="table-status ${tone}">${label}</span>${entry.stage ? `<span class="account-sub">${escapeHtml(stages[entry.stage] || entry.stage)}</span>` : ""}${entry.streamError ? `<span class="account-sub usage-log-error">${escapeHtml(entry.streamError)}</span>` : ""}${entry.pending && entry.lastEvent ? `<span class="account-sub usage-event" title="${escapeHtml(entry.lastEvent)}">最近事件：${escapeHtml(entry.lastEvent)}</span>` : ""}`;
    const selected = String(state.usageLogSelected) === String(entry.id) && entry.at === state.usageLogSelectedAt;
    return `<tr class="usage-row${entry.pending ? " is-pending" : ""}${selected ? " is-selected" : ""}">
      <td data-label="请求时间"><time title="${escapeHtml(formatTime(entry.at))}">${escapeHtml(formatCompactTime(entry.at))}</time><span class="account-sub">#${escapeHtml(entry.id)} · ${entry.pending ? "正在处理" : "已结束"}</span></td>
      <td class="usage-model" data-label="模型 / 思考参数"><code title="${escapeHtml(entry.model)}">${escapeHtml(entry.model || "-")}</code><div class="usage-thinking" title="实际发往上游的思考参数，不代表上游已确认采用该档位">${thinkingLevelCell(entry)}</div></td>
      <td class="usage-account" data-label="账号">${usageAccountCell(entry)}</td>
      <td class="usage-api-key" data-label="API 密钥">${usageApiKeyCell(entry)}</td>
      <td data-label="客户端协议"><span class="usage-protocol">${escapeHtml(usageLogProtocol(entry))}</span><span class="account-sub">${entry.stream ? "流式 SSE" : "非流式 JSON"}</span>${entry.stream === false && entry.upstreamStream === true ? '<span class="account-sub">上游 SSE · 客户端 JSON</span>' : ""}</td>
      <td class="token-cell" data-label="Token 用量">${usageMetricPair(inputTokenLabel(entry), tokenCell(entry.inputTokens))}${usageMetricPair("非缓存", tokenCell(uncachedInputTokens(entry)))}${usageMetricPair("输出", tokenCell(entry.outputTokens))}${!(entry.outputTokens > 0) && (entry.textCharacters > 0 || entry.reasoningCharacters > 0) ? `<span class="account-sub usage-content-note">有内容 · 文本 ${escapeHtml(entry.textCharacters || 0)} 字 · 思考 ${escapeHtml(entry.reasoningCharacters || 0)} 字</span>` : ""}</td>
      <td class="token-cell" data-label="缓存 Token">${usageMetricPair("读取", tokenCell(entry.cacheReadTokens))}${usageMetricPair("写入", tokenCell(entry.cacheWriteTokens))}</td>
      <td data-label="响应耗时">${usageMetricPair("首字节", latencyCell(entry.ttfbMs))}${usageMetricPair("首正文", latencyCell(entry.firstTextMs))}${usageMetricPair(entry.pending ? "已等待" : "总耗时", latencyCell(entry.pending ? entry.elapsedMs : entry.durationMs))}</td>
      <td class="usage-status" data-label="状态 / 详情">${status}<button class="usage-detail-button" type="button" data-usage-detail="${escapeHtml(entry.id)}" aria-expanded="${selected}" aria-controls="usage-log-detail" aria-label="查看请求 ${escapeHtml(entry.id)} 的详情">查看详情</button></td>
    </tr>`;
  }).join("");
}

function changeUsageLogPage(direction) {
  const pageCount = Math.max(1, Math.ceil(filteredUsageLog().length / USAGE_LOG_PAGE_SIZE));
  state.usageLogPage = Math.min(pageCount, Math.max(1, state.usageLogPage + direction));
  renderUsageLog();
}

function usageLogProtocol(entry) {
  if (entry.clientPath) {
    return usageProtocolForPath(entry.clientPath) || entry.protocol || "未知协议";
  }
  if (entry.protocol && entry.protocol !== "未知协议") return entry.protocol;
  return usageProtocolForPath(entry.path) || "未知协议";
}

function usageProtocolForPath(value) {
  const path = typeof value === "string" ? value.split("?", 1)[0] : "";
  if (path === "/v1/messages") return "Anthropic";
  if (path === "/v1/chat/completions") return "OpenAI Chat";
  if (["/v1/responses", "/backend-api/codex/responses"].includes(path)) return "OpenAI Responses";
  if (/^\/(?:v1|backend-api\/codex)\/images\/(?:generations|edits)$/.test(path)) return "OpenAI Images";
  if (["/v1/alpha/search", "/backend-api/codex/alpha/search"].includes(path)) return "OpenAI Search";
  if (["/v1/responses/compact", "/backend-api/codex/responses/compact"].includes(path)) return "OpenAI Compact";
  return null;
}

function usageLogOutcome(entry) {
  if (entry.pending) return "pending";
  if (entry.streamError || entry.stage === "failed") return "failed";
  if (entry.status === 499 || ["cancelled", "client_disconnected"].includes(entry.stage)) return "cancelled";
  if (entry.stage === "incomplete") return "incomplete";
  return entry.status >= 200 && entry.status < 300 ? "success" : "failed";
}

function filteredUsageLog() {
  const query = state.usageLogQuery.toLocaleLowerCase();
  const entries = state.usageLog.filter((entry) => {
    const searchable = [entry.id, entry.requestId, entry.model, entry.account, entry.apiKey?.name, entry.apiKey?.prefix, usageAccountLabel(entry.account), entry.clientPath || entry.path, entry.upstreamPath, entry.upstreamRequestId, entry.streamError, entry.status, ...(entry.attempts || []).map((attempt) => usageAccountLabel(attempt.account))].join(" ").toLocaleLowerCase();
    return (!query || searchable.includes(query)) && (state.usageLogStatus === "all" || usageLogOutcome(entry) === state.usageLogStatus)
      && (state.usageLogProtocol === "all" || usageLogProtocol(entry) === state.usageLogProtocol)
      && (state.usageLogApiKey === "all" || (state.usageLogApiKey === "none" ? !entry.apiKey : entry.apiKey?.id === state.usageLogApiKey));
  });
  if (state.usageLogSort === "duration") entries.sort((left, right) => numeric(right.pending ? right.elapsedMs : right.durationMs) - numeric(left.pending ? left.elapsedMs : left.durationMs));
  if (state.usageLogSort === "tokens") entries.sort((left, right) => numeric(right.outputTokens) - numeric(left.outputTokens));
  return entries;
}

function updateUsageLogFilters() {
  state.usageLogQuery = elements.usageLogSearch.value.trim();
  state.usageLogStatus = elements.usageLogStatus.value || "all";
  state.usageLogProtocol = elements.usageLogProtocol.value || "all";
  state.usageLogApiKey = elements.usageLogApiKey.value || "all";
  state.usageLogSort = elements.usageLogSort.value || "newest";
  state.usageLogPage = 1;
  renderUsageLog();
}

function resetUsageLogFilters() {
  elements.usageLogSearch.value = "";
  elements.usageLogStatus.value = "all";
  elements.usageLogProtocol.value = "all";
  elements.usageLogApiKey.value = "all";
  elements.usageLogSort.value = "newest";
  updateUsageLogFilters();
}

function toggleUsageLogPause() {
  state.usageLogPaused = !state.usageLogPaused;
  renderUsageLog();
  if (!state.usageLogPaused) void loadUsageLog();
}

function usageMetricPair(label, value) {
  return `<span class="usage-metric-pair"><span>${label}</span><strong>${value}</strong></span>`;
}

function renderUsageLogSummary(entries) {
  const completed = entries.filter((entry) => !entry.pending);
  const successful = completed.filter((entry) => usageLogOutcome(entry) === "success").length;
  const failed = completed.filter((entry) => usageLogOutcome(entry) === "failed").length;
  const durations = completed.map((entry) => entry.durationMs).filter((value) => Number.isFinite(value) && value >= 0);
  const input = entries.reduce((sum, entry) => sum + numeric(entry.inputTokens), 0);
  const output = entries.reduce((sum, entry) => sum + numeric(entry.outputTokens), 0);
  const inputSummary = entries.some((entry) => Number.isFinite(entry.inputTokens)) ? formatCompactNumber(input) : "—";
  const outputSummary = entries.some((entry) => Number.isFinite(entry.outputTokens)) ? formatCompactNumber(output) : "—";
  const cards = [
    ["当前筛选请求", formatNumber(entries.length), `${entries.length - completed.length} 条进行中 · ${failed} 条失败`],
    ["已结束成功率", completed.length ? `${(successful / completed.length * 100).toFixed(1)}%` : "—", `${successful} / ${completed.length} 条已结束请求成功`],
    ["上游输入 / 输出 Token", `${inputSummary} / ${outputSummary}`, "OpenAI / DeepSeek 的上游输入含缓存；非缓存输入已单列，缓存不重复相加"],
    ["平均总耗时", durations.length ? latencyCell(Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)) : "—", `基于 ${durations.length} 条已结束请求`]
  ];
  elements.usageLogSummary.innerHTML = cards.map(([label, value, note]) => `<article class="usage-summary-card"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("");
}


function selectUsageLogEntry(id) {
  const previous = state.usageLogSelected;
  state.usageLogSelected = id;
  state.usageLogSelectedAt = state.usageLog.find((entry) => String(entry.id) === String(id))?.at ?? null;
  renderUsageLog();
  if (id !== null) elements.usageLogDetailTitle.focus();
  else elements.usageLogBody.querySelector(`[data-usage-detail="${escapeHtml(previous)}"]`)?.focus();
}

function renderUsageLogDetail() {
  const entry = state.usageLog.find((item) => state.usageLogSelected !== null && String(item.id) === String(state.usageLogSelected) && item.at === state.usageLogSelectedAt);
  elements.usageLogDetail.hidden = state.usageLogSelected === null;
  if (state.usageLogSelected === null) return;
  elements.usageLogDetailTitle.textContent = `请求 #${state.usageLogSelected}`;
  if (!entry) {
    elements.usageLogDetailBody.innerHTML = '<p class="section-hint">该记录已不在最近保留的明细中，可能已超出保留数量或服务已重启。</p>';
    return;
  }
  const fields = [
    ["参数转发诊断", Array.isArray(entry.parameterDiagnostics) && entry.parameterDiagnostics.length ? entry.parameterDiagnostics.map((item) => `${item.parameter}：${({ added: "网关新增", changed: "值已调整", related_fields: "未直传，存在关联输出字段（不保证等价）", omitted: "未直传上游（可能已由网关处理）" })[item.status] || "未知"}${Array.isArray(item.targets) ? ` → ${item.targets.join("、")}` : ""}`).join("；") : "无已记录的参数变化"],
    ["客户端接口", entry.clientPath || entry.path], ["客户端协议", usageLogProtocol(entry)], ["API 密钥", usageApiKeyLabel(entry)], ["最终账号", usageAccountLabel(entry.account)],
    ["本机请求 ID", entry.requestId], ["上游接口", entry.upstreamPath], ["上游协议", entry.upstreamProtocol],
    ["上游首字节", latencyCell(entry.ttfbMs)], ["上游首输出（含思考/工具）", latencyCell(entry.firstOutputMs)], ["上游首正文", latencyCell(entry.firstTextMs)],
    ["开始时间", formatTime(entry.at)], ["结束时间", entry.pending ? "进行中" : entry.completedAt ? formatTime(entry.completedAt) : "未记录"],
    ["上游响应头状态", entry.upstreamStatus ? `HTTP ${entry.upstreamStatus}` : "未记录"],
    ["上游请求 ID", entry.upstreamRequestId], ["最近事件", entry.lastEvent], ["最近事件时间", entry.lastEventAt ? formatTime(entry.lastEventAt) : "未记录"],
    ["上游错误类型", entry.upstreamError?.type], ["上游错误码", entry.upstreamError?.code], ["上游错误详情", entry.upstreamError?.message],
    ["结束原因", entry.finishReason], ["流错误码", entry.streamError], ["输出上限", Number.isFinite(entry.maxTokens) ? `${formatNumber(entry.maxTokens)} tokens` : "未指定"],
    ["客户端思考参数", reasoningLabel(entry.reasoningEffort)], ["上游思考参数", reasoningLabel(entry.thinkingLevel)],
    ["Token 口径", inputTokenSemanticsLabel(entry)],
    ["上游输入（含缓存）", entry.inputTokenSemantics === "inclusive_cache" ? tokenDetail(entry.inputTokens) : "不适用（上游已排除缓存）"],
    ["缓存读取", tokenDetail(entry.cacheReadTokens)], ["非缓存输入", tokenDetail(uncachedInputTokens(entry))],
    ["声明工具", Array.isArray(entry.toolNames) ? entry.toolNames.join("、") || "无" : "未记录"],
    ["实际调用工具", Array.isArray(entry.calledTools) ? entry.calledTools.join("、") || "无" : "未记录"],
    ["响应字节数", Number.isFinite(entry.responseBytes) ? formatNumber(entry.responseBytes) : "未记录"],
    ["已接收字符", `正文 ${formatNumber(entry.textCharacters)} · 思考 ${formatNumber(entry.reasoningCharacters)}`]
  ];
  const attempts = (entry.attempts || []).map((attempt, index) => `<li><span class="usage-attempt-index">${index + 1}</span><div><strong>${escapeHtml(usageAccountLabel(attempt.account))}</strong><span class="account-sub">${escapeHtml(formatTime(attempt.at))} · 优先级 ${escapeHtml(attempt.priority ?? "未记录")}</span></div><span>${escapeHtml(attempt.status ? `HTTP ${attempt.status}` : "未收到响应")}</span></li>`).join("");
  elements.usageLogDetailBody.innerHTML = `<dl class="usage-detail-grid">${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value || "—")}</dd></div>`).join("")}</dl><div class="usage-detail-attempts"><h3>账号调用顺序</h3>${attempts ? `<ol>${attempts}</ol>` : '<p class="section-hint">暂无账号尝试记录。</p>'}</div>`;
}

// The log only keeps the account id the relay authenticated with; the mailbox is what the
// operator actually recognises, so it is resolved from the pool that is already loaded.
function usageAccountLabel(account) {
  if (!account) return "-";
  const match = (state.data?.accounts || []).find((item) => item.id === account || item.key === account || item.home === account);
  return match?.identity?.email || match?.identity?.name || match?.key || account;
}

function usageAccountCell(entry) {
  const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];
  const finalLabel = escapeHtml(usageAccountLabel(entry.account));
  if (attempts.length <= 1) {
    const priority = attempts[0]?.priority;
    return `${finalLabel}${Number.isFinite(priority) ? `<span class="account-sub">优先级 ${priority}</span>` : ""}`;
  }
  return `<div>${finalLabel}<span class="account-sub">最终账号 · ${attempts.length} 次尝试</span></div>`;
}

// The log copies the key's name as it was when the request came in. The current list supplies
// a newer name, and tells a key that has since been revoked from one that still works.
function usageApiKeyLabel(entry) {
  if (!entry.apiKey) return "未识别密钥";
  const current = state.apiKeys.find((key) => key.id === entry.apiKey.id);
  return current?.name || entry.apiKey.name || "未命名密钥";
}

function usageApiKeyCell(entry) {
  if (!entry.apiKey) return `<span class="account-sub">${entry.status === 401 ? "密钥无效或缺失" : "未识别密钥"}</span>`;
  const revoked = state.apiKeysLoaded && !state.apiKeys.some((key) => key.id === entry.apiKey.id);
  return `<strong class="console-key-name">${escapeHtml(usageApiKeyLabel(entry))}</strong><span class="account-sub"><code>${escapeHtml(entry.apiKey.prefix || "—")}</code>${revoked ? " · 已吊销" : ""}</span>`;
}

// Offers every key that is still valid and every key that appears in the log, so a revoked
// key's requests can still be singled out. Rebuilt only when that set changes, so an open
// dropdown is not reset by the five-second refresh.
function renderUsageLogApiKeyOptions() {
  const keys = new Map(state.apiKeys.map((key) => [key.id, { name: key.name || "未命名密钥", prefix: key.prefix, revoked: false }]));
  for (const entry of state.usageLog) {
    if (entry.apiKey && !keys.has(entry.apiKey.id)) keys.set(entry.apiKey.id, { name: entry.apiKey.name || "未命名密钥", prefix: entry.apiKey.prefix, revoked: state.apiKeysLoaded });
  }
  if (keys.has(state.usageLogApiKey) === false && !["all", "none"].includes(state.usageLogApiKey)) state.usageLogApiKey = "all";
  const options = [["all", "全部密钥"], ...[...keys].map(([id, key]) => [id, `${key.name}${key.prefix ? ` · ${key.prefix}` : ""}${key.revoked ? "（已吊销）" : ""}`]), ["none", "未识别密钥"]];
  const signature = JSON.stringify(options);
  if (elements.usageLogApiKey.dataset.options !== signature) {
    elements.usageLogApiKey.innerHTML = options.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("");
    elements.usageLogApiKey.dataset.options = signature;
  }
  elements.usageLogApiKey.value = state.usageLogApiKey;
}

function tokenCell(value) {
  return value === null || value === undefined ? "-" : escapeHtml(formatNumber(value));
}

function tokenDetail(value) {
  return Number.isFinite(value) ? `${formatNumber(value)} tokens` : "未上报";
}

function uncachedInputTokens(entry) {
  if (Number.isFinite(entry.uncachedInputTokens)) return entry.uncachedInputTokens;
  if (!Number.isFinite(entry.inputTokens)) return null;
  if (entry.inputTokenSemantics === "exclusive_cache") return entry.inputTokens;
  if (entry.inputTokenSemantics === "inclusive_cache") return Math.max(0, entry.inputTokens - numeric(entry.cacheReadTokens));
  return null;
}

function inputTokenLabel(entry) {
  return entry.inputTokenSemantics === "inclusive_cache" ? "上游输入" : "输入";
}

function inputTokenSemanticsLabel(entry) {
  if (entry.inputTokenSemantics === "inclusive_cache") return "上游输入包含缓存读取（OpenAI / DeepSeek 口径）";
  if (entry.inputTokenSemantics === "exclusive_cache") return "上游输入已排除缓存读取（Anthropic 口径）";
  return "上游未提供足够的 usage 字段判断";
}

function latencyCell(value) {
  if (value === null || value === undefined) return "-";
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} 秒` : `${value} 毫秒`;
}

// The rungs a current model is steered by, weakest first. A budget model is steered by tokens
// instead, so it is shown as a budget rather than being forced onto this ladder.
const THINKING_RUNGS = [
  { name: "low", className: "" },
  { name: "medium", className: "" },
  { name: "high", className: "good" },
  { name: "xhigh", className: "warning" },
  { name: "max", className: "bad" }
];

function thinkingLevelCell(entry) {
  const level = entry.thinkingLevel || null;
  const asked = entry.reasoningEffort && entry.reasoningEffort !== "none" ? entry.reasoningEffort : null;
  const rung = THINKING_RUNGS.find((rung) => rung.name === level);
  const main = rung
    ? `<span class="badge ${rung.className}">${rung.name}</span>`
    : `<span class="badge">${escapeHtml(reasoningLabel(level))}</span>`;
  // Only when the two differ: a caller that named a rung and got it needs no second line, but a
  // caller whose ask was defaulted, converted from a budget, or overruled by an unrestorable
  // history is looking at exactly that difference when it asks why the answer changed.
  const note = asked && asked !== level ? `<span class="account-sub">请求 ${escapeHtml(reasoningLabel(asked))}</span>` : "";
  return `${main}${note}`;
}

function reasoningLabel(value) {
  if (!value) return "未指定（上游默认）";
  if (value === "none" || value === "off") return "关闭";
  if (value === "adaptive" || value === "on") return "自适应";
  if (value === "enabled") return "开启";
  if (value.startsWith("budget:")) return `${value.slice(7)} tokens`;
  return value;
}

async function loadModelHealth() {
  if (state.modelHealthLoading || state.modelHealthAction || webSessionExpired || !pageActive) return;
  const load = trackReadLoad();
  state.modelHealthLoading = true;
  try {
    const health = await request("/api/model-health");
    if (!load.current()) return;
    state.modelHealth = health;
    state.modelHealthError = "";
    delete state.moduleErrors.modelHealth;
  } catch (error) {
    if (load.current()) state.modelHealthError = `${error.message || "同步失败。"} 当前保留上次结果，请稍后刷新。`;
  } finally {
    state.modelHealthLoading = false;
    renderModelHealth();
    renderSyncStatus();
    if (state.data) renderOverview(state.data);
    load.finish();
  }
}

function render() {
  renderMoeMailConfig();
  renderApiKeys();
  renderModelHealth();
  renderSyncStatus();
  const data = state.data;
  if (!data) {
    const failed = Boolean(state.moduleErrors.dashboard);
    const message = failed ? "账号数据加载失败，不代表账号已删除。" : "正在读取账号数据…";
    elements.updatedAt.textContent = message;
    elements.overviewPulseTitle.textContent = failed ? "账号数据尚未加载" : "正在读取运行状态";
    elements.overviewPulseCopy.textContent = "账号与密钥分别加载，不会因上游暂时故障而删除本地记录。";
    for (const counter of [elements.overviewAccountCount, elements.overviewSignedInCount, elements.overviewAvailableCount, elements.overviewRequestCount, elements.overviewInputTokens, elements.overviewOutputTokens, elements.overviewCacheReadTokens, elements.overviewCacheWriteTokens]) {
      if (failed) counter.textContent = "—";
      else counter.innerHTML = SKELETON_VALUE;
    }
    if (failed) {
      elements.overviewTokenMix.innerHTML = `<div class="console-empty"><strong>账号数据尚未加载</strong><span>${message}</span></div>`;
      elements.overviewWorkspace.innerHTML = `<div class="console-empty"><strong>账号数据尚未加载</strong><span>可点击「刷新数据」重试。</span></div>`;
      elements.poolCapacity.innerHTML = `<p class="pool-capacity-empty">${message}</p>`;
      elements.poolBody.innerHTML = `<tr><td colspan="9" class="empty-table">${message}</td></tr>`;
    } else {
      elements.overviewTokenMix.innerHTML = skeletonLines(4);
      elements.overviewWorkspace.innerHTML = skeletonLines(3);
      elements.poolCapacity.innerHTML = skeletonCards("capacity-card", 3);
      elements.poolBody.innerHTML = skeletonRows(9);
    }
    return;
  }
  const signedIn = data.accounts.filter((account) => account.loggedIn);
  elements.relayHost.textContent = data.relay;
  elements.updatedAt.textContent = `更新于 ${formatTime(data.generatedAt)}`;
  elements.console.hidden = signedIn.length === 0;
  state.loginKey = "new";
  renderRedeemStatus();
  renderOverview(data);
  renderPool(data.accounts);
  if (signedIn.length === 0) return;

  elements.select.innerHTML = signedIn.map((account) => `<option value="${escapeHtml(account.key)}">${escapeHtml(accountLabel(account))}</option>`).join("");
  elements.select.value = state.selectedKey;
  const account = signedIn.find((item) => item.key === state.selectedKey) || signedIn[0];
  renderAccount(account);
}

function renderSyncStatus() {
  const errors = Object.values(state.moduleErrors);
  const affected = state.data?.accounts.filter((account) => account.syncWarnings?.length).length || 0;
  if (affected) errors.push(`${affected} 个账号的上游数据未完整同步；账号及本地记录仍在，额度暂未知不等于已用尽。`);
  elements.dashboardSyncStatus.textContent = errors.join(" ");
  elements.dashboardSyncStatus.hidden = errors.length === 0;
}

function renderMoeMailConfig() {
  const config = state.moemailConfig;
  if (!config) return;
  elements.moemailUrl.value = config.url || "";
  elements.moemailDomain.value = config.domain || "";
  elements.moemailConfigStatus.textContent = config.configured ? "已配置" : "未配置";
  elements.moemailConfigStatus.dataset.state = config.configured ? "ready" : "empty";
}

function restoreActiveView() {
  let view = "overview";
  try {
    view = window.sessionStorage?.getItem(ACTIVE_VIEW_STORAGE_KEY) || view;
  } catch {}
  if (!setView(view)) setView("overview");
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
  if (!Object.hasOwn(views, view)) return false;
  if (state.activeView === "apiKeys" && view !== "apiKeys") dismissApiKey();
  state.activeView = view;
  try {
    window.sessionStorage?.setItem(ACTIVE_VIEW_STORAGE_KEY, view);
  } catch {}
  document.querySelector("#workspace-location").textContent = { overview: "运行概览", activity: "邀请活动", apiKeys: "API 密钥", accountPool: "账号池", modelHealth: "模型健康", usageLog: "使用明细" }[view];
  if (view === "usageLog") void loadUsageLog();
  if (view === "modelHealth") void loadModelHealth();
  for (const [name, item] of Object.entries(views)) {
    const active = name === view;
    item.nav.className = `nav-item${active ? " active" : ""}`;
    item.nav.setAttribute?.("aria-current", active ? "page" : "false");
    item.panel.hidden = !active;
  }
  return true;
}

function updateConsoleFilters(prefix) {
  state[`${prefix}Query`] = elements[`${prefix}Search`].value.trim().toLowerCase();
  state[`${prefix}Status`] = elements[`${prefix}Status`].value || "all";
  state[`${prefix}Sort`] = elements[`${prefix}Sort`].value || (prefix === "apiKey" ? "newest" : "attention");
  state[`${prefix}Page`] = 1;
  if (prefix === "apiKey") renderApiKeys();
  else renderModelHealth();
}

function resetConsoleFilters(prefix) {
  elements[`${prefix}Search`].value = "";
  elements[`${prefix}Status`].value = "all";
  elements[`${prefix}Sort`].value = prefix === "apiKey" ? "newest" : "attention";
  updateConsoleFilters(prefix);
}

function changeConsolePage(prefix, delta) {
  state[`${prefix}Page`] += delta;
  if (prefix === "apiKey") renderApiKeys();
  else renderModelHealth();
}

function consolePage(prefix, entries, total) {
  const pages = Math.max(1, Math.ceil(entries.length / CONSOLE_PAGE_SIZE));
  const page = Math.max(1, Math.min(state[`${prefix}Page`], pages));
  state[`${prefix}Page`] = page;
  elements[`${prefix}PageSummary`].textContent = `匹配 ${entries.length} / ${total} 项 · 第 ${page} / ${pages} 页`;
  elements[`${prefix}PagePrev`].disabled = page === 1;
  elements[`${prefix}PageNext`].disabled = page === pages;
  return entries.slice((page - 1) * CONSOLE_PAGE_SIZE, page * CONSOLE_PAGE_SIZE);
}

function consoleMetric(label, value, note, tone = "neutral") {
  return `<article class="console-metric ${tone}"><span>${escapeHtml(label)}</span><strong>${formatNumber(value)}</strong><small>${escapeHtml(note)}</small></article>`;
}

function modelDisplayStatus(model) {
  if (state.modelHealthAction === model.id || (state.modelHealth?.running && state.modelHealth.activeModelId === model.id)) return "checking";
  return model.status || "pending";
}

function renderModelHealth() {
  const health = state.modelHealth;
  elements.modelHealthError.textContent = state.modelHealthError || health?.lastError || "";
  elements.modelHealthError.hidden = !elements.modelHealthError.textContent;
  if (!health) {
    if (state.modelHealthError) {
      elements.modelHealthSummary.innerHTML = "";
      elements.modelHealthBody.innerHTML = `<tr><td colspan="7" class="empty-table"><strong>模型目录暂时无法读取</strong><span>可点击「刷新模型」重试。</span></td></tr>`;
    } else {
      elements.modelHealthSummary.innerHTML = skeletonCards("console-metric");
      elements.modelHealthBody.innerHTML = skeletonRows(7);
    }
    return;
  }
  const models = Array.isArray(health.models) ? health.models : [];
  const totals = models.reduce((result, model) => {
    const status = modelDisplayStatus(model);
    result[status] = (result[status] || 0) + 1;
    return result;
  }, {});
  const scanCopy = health.scanIntervalMs ? `每 ${formatDuration(health.scanIntervalMs)} 检测一个模型` : "定时检测未启用";
  elements.modelHealthUpdated.textContent = health.discovering
    ? "正在读取模型目录..."
    : health.running ? `正在检测 ${health.activeModelId || "模型"}...` : health.lastFinishedAt ? `上次检测 ${formatTime(health.lastFinishedAt)}，${scanCopy}` : health.lastDiscoveredAt ? `目录更新于 ${formatTime(health.lastDiscoveredAt)}，${scanCopy}` : scanCopy;
  const busy = Boolean(health.discovering || health.running || state.modelHealthAction);
  elements.modelHealthDiscover.disabled = busy;
  elements.modelHealthDiscover.textContent = health.discovering || state.modelHealthAction === "discover" ? "读取中" : "刷新模型";
  elements.modelHealthSummary.innerHTML = consoleMetric("模型总数", models.length, "当前目录中的模型")
    + consoleMetric("可用", numeric(totals.healthy), "最近一次检查通过", "good")
    + consoleMetric("需关注", numeric(totals.limited) + numeric(totals.unavailable) + numeric(totals.unauthorized), `限流 ${numeric(totals.limited)} · 不可用 ${numeric(totals.unavailable)} · 授权异常 ${numeric(totals.unauthorized)}`, "warning")
    + consoleMetric("待检测", numeric(totals.pending) + numeric(totals.checking), `其中 ${numeric(totals.checking)} 个正在检测`);
  const order = { unauthorized: 0, unavailable: 1, limited: 2, checking: 3, pending: 4, healthy: 5 };
  const filtered = models.filter((model) => {
    const status = modelDisplayStatus(model);
    const matches = state.modelHealthStatus === "all" || status === state.modelHealthStatus || (state.modelHealthStatus === "issues" && ["unavailable", "unauthorized"].includes(status));
    return matches && `${model.id} ${model.message || ""}`.toLowerCase().includes(state.modelHealthQuery);
  }).sort((first, second) => {
    if (state.modelHealthSort === "latency") return (Number.isFinite(first.latencyMs) ? first.latencyMs : Infinity) - (Number.isFinite(second.latencyMs) ? second.latencyMs : Infinity) || first.id.localeCompare(second.id);
    if (state.modelHealthSort === "checked") return (Date.parse(second.checkedAt) || 0) - (Date.parse(first.checkedAt) || 0) || first.id.localeCompare(second.id);
    if (state.modelHealthSort === "name") return first.id.localeCompare(second.id);
    return (order[modelDisplayStatus(first)] ?? 4) - (order[modelDisplayStatus(second)] ?? 4) || first.id.localeCompare(second.id);
  });
  const page = consolePage("modelHealth", filtered, models.length);
  if (page.length === 0) {
    elements.modelHealthBody.innerHTML = `<tr><td colspan="7" class="empty-table"><strong>${models.length ? "没有匹配的模型" : busy ? "正在获取上游模型列表…" : "尚未发现模型"}</strong><span>${models.length ? "试试其他关键词，或重置筛选。" : "可点击「刷新模型」重新读取目录。"}</span></td></tr>`;
    return;
  }
  elements.modelHealthBody.innerHTML = page.map((model) => {
    const status = modelDisplayStatus(model);
    const meta = modelHealthMeta(status);
    const testing = status === "checking";
    return `<tr class="${testing ? "console-row-pending" : ""}"><td data-label="模型"><code class="console-model-id">${escapeHtml(model.id)}</code></td><td data-label="状态"><span class="table-status ${meta.className}">${meta.label}</span></td><td data-label="检查耗时" class="console-number">${Number.isFinite(model.latencyMs) ? `${formatNumber(model.latencyMs)} ms` : "—"}</td><td data-label="HTTP"><code>${escapeHtml(model.httpStatus || "—")}</code></td><td data-label="检测时间">${escapeHtml(model.checkedAt ? formatTime(model.checkedAt) : "尚未检测")}</td><td data-label="结果" class="model-health-message">${escapeHtml(model.message || "等待检查结果")}</td><td data-label="操作"><button class="button button-secondary model-check" type="button" aria-label="检测 ${escapeHtml(model.id)}" data-model-id="${escapeHtml(model.id)}" ${busy ? "disabled" : ""}>${testing ? "检测中" : "重新检测"}</button></td></tr>`;
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
    if (poolStatus(account) === "available") result.available += 1;
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
  elements.overviewPulseTitle.textContent = totals.available ? `${totals.available} 个账号当前可用` : "暂无可用账号";
  elements.overviewPulseCopy.textContent = data.accounts.length
    ? `已登录 ${totals.signedIn} / ${data.accounts.length} 个账号 · ${data.accounts.length - totals.available} 个暂不可用 · 每 60 秒更新`
    : "先登录或导入账号，再创建 API 密钥开始使用。";
  const mix = [["输入", totals.inputTokens, "blue"], ["输出", totals.outputTokens, "green"], ["缓存读取", totals.cacheReadTokens, "purple"], ["缓存写入", totals.cacheWriteTokens, "cyan"]];
  const totalTokens = mix.reduce((total, entry) => total + entry[1], 0);
  elements.overviewTokenMix.innerHTML = totalTokens
    ? mix.map(([label, value, tone]) => `<div class="token-mix-row"><span><i class="token-dot ${tone}" aria-hidden="true"></i>${label}</span><strong title="${formatNumber(value)}">${formatCompactNumber(value)}</strong><meter class="token-mix-track ${tone}" min="0" max="${totalTokens}" value="${value}" aria-label="${label}占字段汇总的 ${(value / totalTokens * 100).toFixed(1)}%"></meter><small>${(value / totalTokens * 100).toFixed(1)}%</small></div>`).join("")
    : '<div class="console-empty"><strong>还没有 Token 用量</strong><span>产生请求后，这里将展示用量构成。</span></div>';
  const models = state.modelHealth?.models || [];
  const healthy = models.filter((model) => modelDisplayStatus(model) === "healthy").length;
  const issues = models.filter((model) => ["limited", "unauthorized", "unavailable"].includes(modelDisplayStatus(model))).length;
  elements.overviewWorkspace.innerHTML = `<div><span>API 密钥</span><strong>${state.apiKeys.length ? `${state.apiKeys.length} 个有效密钥` : "尚未创建"}</strong></div><div><span>模型检查</span><strong>${models.length ? `${healthy} / ${models.length} 个可用` : "暂无检测数据"}</strong></div><div><span>需要关注</span><strong class="${issues || state.modelHealthError || state.modelHealth?.lastError ? "console-warning" : ""}">${state.modelHealthError ? "模型状态同步失败" : state.modelHealth?.lastError ? "模型目录读取异常" : issues ? `${issues} 个模型限流或异常` : models.length ? "暂无已知模型异常" : "等待模型目录"}</strong></div>`;
}

// Placeholders shaped like the content they stand in for. They are shown only until a section's
// first response arrives; a later refresh keeps the previous data on screen instead.

function skeletonRows(columns, rows = 5) {
  return Array.from({ length: rows }, (_, row) => `<tr class="skeleton-row" aria-hidden="true">${Array.from({ length: columns }, (_, column) => `<td><span class="skeleton${SKELETON_WIDTHS[(row + column) % SKELETON_WIDTHS.length]}"></span></td>`).join("")}</tr>`).join("");
}

function skeletonCards(className, count = 4) {
  return Array.from({ length: count }, () => `<article class="${className} skeleton-card" aria-hidden="true"><span class="skeleton skeleton-short"></span><span class="skeleton skeleton-value"></span><span class="skeleton skeleton-medium"></span></article>`).join("");
}

function skeletonLines(count) {
  return `<div class="skeleton-block" aria-hidden="true">${Array.from({ length: count }, (_, index) => `<span class="skeleton${SKELETON_WIDTHS[index % SKELETON_WIDTHS.length]}"></span>`).join("")}</div>`;
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
  if (!state.apiKeysLoaded) {
    const failed = Boolean(state.moduleErrors.apiKeys);
    const message = failed ? "密钥加载失败，请重试；这不代表密钥已删除。" : "正在读取密钥…";
    elements.apiKeySummary.innerHTML = failed ? "" : skeletonCards("console-metric");
    elements.apiKeyList.innerHTML = failed ? `<tr><td colspan="5" class="empty-table">${message}</td></tr>` : skeletonRows(5);
    elements.apiKeyPageSummary.textContent = message;
    elements.apiKeyPagePrev.disabled = true;
    elements.apiKeyPageNext.disabled = true;
    return;
  }
  const used = state.apiKeys.filter((key) => key.lastUsedAt).length;
  elements.apiKeySummary.innerHTML = consoleMetric("有效密钥", state.apiKeys.length, "当前可访问接口的凭据", "good")
    + consoleMetric("已使用", used, "有历史调用记录")
    + consoleMetric("尚未使用", state.apiKeys.length - used, "可检查是否仍需保留", "warning")
    + consoleMetric("可再次复制", state.apiKeys.filter((key) => key.copyable).length, "其余密钥请自行妥善保存");
  const filtered = state.apiKeys.filter((key) => {
    const matches = state.apiKeyStatus === "all" || (state.apiKeyStatus === "used" ? Boolean(key.lastUsedAt) : !key.lastUsedAt);
    return matches && `${key.name} ${key.prefix}`.toLowerCase().includes(state.apiKeyQuery);
  }).sort((first, second) => {
    if (state.apiKeySort === "name") return (first.name || "").localeCompare(second.name || "");
    const field = state.apiKeySort === "used" ? "lastUsedAt" : "createdAt";
    return (Date.parse(second[field]) || 0) - (Date.parse(first[field]) || 0);
  });
  const page = consolePage("apiKey", filtered, state.apiKeys.length);
  if (state.data) renderOverview(state.data);
  if (page.length === 0) {
    elements.apiKeyList.innerHTML = `<tr><td colspan="5" class="empty-table"><strong>${state.apiKeys.length ? "没有匹配的密钥" : "尚未生成 API Key"}</strong><span>${state.apiKeys.length ? "试试其他关键词，或重置筛选。" : "在上方填写用途名称，创建第一个密钥。"}</span></td></tr>`;
    return;
  }
  elements.apiKeyList.innerHTML = page.map((key) => `<tr>
    <td data-label="名称 / 状态"><strong class="console-key-name">${escapeHtml(key.name || "未命名密钥")}</strong><span class="table-status ${key.lastUsedAt ? "good" : "neutral"}">${key.lastUsedAt ? "已使用" : "尚未使用"}</span></td>
    <td data-label="密钥前缀"><code>${escapeHtml(key.prefix)}</code><span class="account-sub">${key.copyable ? "可复制" : "仅保留摘要 · 不可恢复"}</span></td>
    <td data-label="创建时间">${escapeHtml(formatTime(key.createdAt))}</td>
    <td data-label="最近使用">${escapeHtml(key.lastUsedAt ? formatTime(key.lastUsedAt) : "未使用")}</td>
    <td data-label="操作"><div class="account-actions">${key.copyable ? `<button class="button button-secondary key-copy" type="button" aria-label="复制 ${escapeHtml(key.name)}" data-copy-key-id="${escapeHtml(key.id)}">复制</button>` : ""}<button class="button button-secondary key-revoke" type="button" aria-label="吊销 ${escapeHtml(key.name)}" data-key-id="${escapeHtml(key.id)}">吊销</button></div></td>
  </tr>`).join("");
}

function dismissApiKey() {
  state.issuedApiKey = null;
  state.issuedApiKeyId = null;
  renderApiKeys();
}

function renderRedeemStatus() {
  elements.redeemStatus.textContent = state.redeemStatus.text;
  elements.redeemStatus.dataset.state = state.redeemStatus.type;
}

function renderAccount(account) {
  const campaign = account.campaign;
  elements.accountStatus.textContent = account.healthy ? "中转可用" : "中转冷却中";
  elements.accountStatus.className = `status-dot ${account.healthy ? "good" : "warning"}`;
  const plan = accountTypeLabel(account.identity?.accountType || account.referral?.currentPlan) || "普通用户";
  elements.membership.innerHTML = '<div><span class="plan-label">账户类型</span><strong class="plan-name">' + escapeHtml(plan) + '</strong></div><div class="plan-next"><span class="plan-label">活动目标</span><strong class="plan-name">Go 套餐邀请</strong></div>';
  const sold = campaign?.sold || 0;
  const cap = campaign?.cap || 0;
  elements.redeemed.textContent = campaign ? sold + " / " + cap : "—";
  elements.remaining.textContent = campaign ? "距活动目标还差 " + Math.max(0, cap - sold) + " 位" : "暂无活动信息";
  elements.progress.style.width = (cap > 0 ? Math.min(100, Math.round(sold / cap * 100)) : 0) + "%";
  elements.progressCopy.textContent = !campaign ? "官方暂未提供新版邀请活动信息。" : campaign.rewarded ? "官方已确认活动奖励发放。" : "他人通过你的链接购买 Go 套餐才计入邀请，奖励状态以官方返回为准。";
  setBadge(elements.activityState, campaign?.rewarded ? "已获奖励" : campaign ? "进行中" : "暂无数据", campaign?.rewarded ? "good" : campaign ? "warning" : "bad");
  const link = campaign?.url || "";
  elements.inviteCode.textContent = link || "暂无邀请链接";
  elements.inviteCopy.textContent = link ? "分享此链接，其他人通过链接购买 Go 套餐后计入邀请。" : "官方暂未提供邀请链接，可稍后刷新。";
  elements.copyCode.disabled = !link;
  elements.createCode.disabled = !account.loggedIn;
  elements.previewCode.disabled = !account.loggedIn;
  elements.redeemForm.querySelector("button[type=submit]").disabled = !account.loggedIn;
  if (resetCardState.account !== account.key || resetCardState.selectionId !== account.selectionId) {
    Object.assign(resetCardState, { account: account.key, selectionId: account.selectionId, snapshot: null, loading: false, error: "", notice: "", generation: resetCardState.generation + 1 });
  }
  renderResetCards();
}

function renderResetCards() {
  if (state.data) renderPool(state.data.accounts);
}

async function loadResetCards(account = selectedAccount()) {
  if (!account?.loggedIn || resetCardRefreshes.has(account.key) || resetCardState.busy || webSessionExpired || !pageActive) return;
  const load = trackReadLoad();
  const identity = { key: account.key, id: account.id, selectionId: account.selectionId };
  resetCardRefreshes.set(account.key, identity);
  const currentAccount = () => state.data?.accounts.find((item) => item.key === identity.key && item.id === identity.id && item.selectionId === identity.selectionId);
  const updateCards = (current, cards) => {
    current.resetCards = cards;
    resetCardUpdates.set(identity.key, { ...identity, cards, revision: ++resetCardRevision });
    if (resetCardState.account === identity.key && resetCardState.selectionId === identity.selectionId) resetCardState.snapshot = cards;
  };
  renderResetCards();
  try {
    const result = await request("/api/reset-cards?account=" + encodeURIComponent(account.key));
    if (!load.current()) return;
    if (!Array.isArray(result?.cards?.cards)) throw new Error("重置卡返回数据格式异常，请重试。");
    const current = currentAccount();
    if (!current) { showNotice("账号列表已变化，未应用重置卡刷新结果，请重新刷新。", "error"); return; }
    updateCards(current, result.cards);
    showNotice(`${current.identity?.email || current.id}：重置卡已刷新，可用 ${availableResetCards(current).length} 张。`, "success");
  } catch (error) {
    if (!load.current()) return;
    const current = currentAccount();
    if (current) updateCards(current, null);
    showNotice(`${account.identity?.email || identity.id}：${error.message || "重置卡读取失败。"}`, "error");
  } finally {
    resetCardRefreshes.delete(identity.key);
    renderResetCards();
    load.finish();
  }
}

async function redeemResetCard(cardId) {
  const account = selectedAccount();
  if (!account?.loggedIn || resetCardState.busy || resetCardState.loading || resetCardRefreshes.has(account.key)) return;
  const card = resetCardState.snapshot?.cards.find((item) => item.id === cardId && item.status === "active" && item.expiresAt > Date.now());
  if (!card) return;
  const windows = account.quota?.windows || [];
  const usage = windows.map((item) => item.name + " 剩余 " + (Number.isFinite(item.remainingPercent) ? item.remainingPercent + "%" : "未知")).join("；") || "暂时无法读取当前用量";
  if (!window.confirm("为账号 " + account.id + " 使用 1 张重置卡？\n" + usage + "\n平台额度窗口将立即清零，卡片使用后不可撤销。")) return;
  resetCardState.busy = true;
  resetCardState.error = "";
  const generation = ++resetCardState.generation;
  renderResetCards();
  const outcomes = { reset: "额度窗口已重置。", nothingToReset: "当前没有需要清除的用量，重置卡未扣除。", alreadyRedeemed: "此卡已使用，请查看刷新后的列表。", expired: "此卡已过期。", revoked: "此卡已被收回。", noCard: "找不到此卡，请查看刷新后的列表。" };
  try {
    const result = await request("/api/reset-cards/redeem", { method: "POST", body: { account: account.key, selectionId: account.selectionId, cardId } });
    if (generation === resetCardState.generation) {
      resetCardState.snapshot = result.cards || null;
      account.resetCards = result.cards || null;
      resetCardState.notice = outcomes[result.outcome] || "使用结果未确认，请刷新列表核对。";
    }
    showNotice(account.id + "：" + (outcomes[result.outcome] || "请刷新列表核对结果。"), ["reset", "nothingToReset"].includes(result.outcome) ? "success" : "error");
    await loadDashboard();
  } catch (error) {
    if (generation === resetCardState.generation) {
      resetCardState.snapshot = null;
      resetCardState.error = (error.message || "使用结果未确认。") + " 请刷新列表核对后再操作，不要重复提交。";
      account.resetCards = null;
      showNotice(resetCardState.error, "error");
    }
  } finally {
    resetCardState.busy = false;
    renderResetCards();
    renderPool(state.data.accounts);
  }
}

function availableResetCards(account) {
  return (account?.resetCards?.cards || []).filter((card) => card.status === "active" && card.expiresAt > Date.now()).sort((left, right) => left.expiresAt - right.expiresAt);
}

async function resetAccountQuota(event) {
  const button = event.target.closest("[data-reset-account]");
  if (!button || button.disabled || resetCardState.busy || resetCardState.loading) return;
  const account = state.data?.accounts.find((item) => item.key === button.dataset.resetAccount);
  if (!account?.loggedIn || resetCardRefreshes.has(account.key)) return;
  state.selectedKey = account.key;
  render();
  resetCardState.snapshot = account.resetCards;
  resetCardState.error = "";
  renderResetCards();
  const card = availableResetCards(account)[0];
  if (!card) {
    showNotice("该账号暂无可用重置卡，请点击刷新查询数量。", "error");
    return;
  }
  await redeemResetCard(card.id);
}

async function refreshAccountResetCards(event) {
  const button = event.target.closest("[data-refresh-reset-cards]");
  if (!button || button.disabled || resetCardState.busy || resetCardState.loading) return;
  const account = state.data?.accounts.find((item) => item.key === button.dataset.refreshResetCards);
  if (!account?.loggedIn) return;
  await loadResetCards(account);
}

function renderPool(accounts) {
  renderPoolCapacity(accounts);
  renderPoolStatuses(accounts);
  const filtered = sortPool(accounts.filter(matchesPoolFilter));
  const pageCount = Math.max(1, Math.ceil(filtered.length / POOL_PAGE_SIZE));
  state.poolPage = Math.min(Math.max(state.poolPage, 1), pageCount);
  const offset = (state.poolPage - 1) * POOL_PAGE_SIZE;
  const pageAccounts = filtered.slice(offset, offset + POOL_PAGE_SIZE);
  renderPoolSelection(accounts, filtered, pageAccounts);
  const start = filtered.length ? offset + 1 : 0;
  const end = Math.min(offset + POOL_PAGE_SIZE, filtered.length);
  elements.poolSearch.value = state.poolQuery;
  elements.poolCategory.value = state.poolCategory;
  elements.poolSort.value = state.poolSort;
  elements.poolPageSummary.textContent = `${start}-${end} / ${filtered.length} 个账户`;
  elements.poolFilterSummary.textContent = `当前筛选 ${filtered.length} / 全部 ${accounts.length} 个账号 · 汇总卡片按全池统计`;
  elements.poolPagePrev.disabled = state.poolPage <= 1;
  elements.poolPageNext.disabled = state.poolPage >= pageCount;
  if (pageAccounts.length === 0) {
    elements.poolBody.innerHTML = `<tr><td colspan="9" class="empty-table">${accounts.length ? "没有符合当前筛选条件的账户，请调整条件或重置筛选。" : "账号池为空。请登录账号、导入账号或恢复已有本地账户。"}</td></tr>`;
    return;
  }
  elements.poolBody.innerHTML = pageAccounts.map((account) => {
    const status = poolStatusMeta(account);
    const identity = account.identity?.name || account.identity?.email || account.id;
    const plan = accountTypeLabel(account.referral?.currentPlan || account.identity?.accountType) || "普通用户";
    const activity = account.campaign ? `${account.campaign.sold} / ${account.campaign.cap} 位已购买${account.campaign.rewarded ? " · 已获奖励" : ""}` : "暂无官方数据";
    const renderAccountWindow = (window) => {
      const resetTime = resetMs(window.resetAt);
      const stale = Number.isFinite(resetTime) && resetTime <= Date.now();
      const reset = Number.isFinite(resetTime) ? `${stale ? "重置时间已过 · 待更新" : "重置 " + formatCompactTime(resetTime)}` : "暂无重置时间";
      const percent = Number.isFinite(window.remainingPercent) && !stale ? `剩余 ${Math.max(0, Math.min(100, window.remainingPercent))}%` : stale ? "待更新" : "暂无百分比";
      const scoped = window.modelScoped ? `<sup title="仅覆盖部分型号，用满不代表账号没额度">*</sup>` : "";
      // A bar alongside the number: ten rows of percentages read as a wall of digits, and which
      // account is emptier is the one thing this column exists to show at a glance.
      const bar = Number.isFinite(window.remainingPercent) && !stale
        ? `<span class="quota-bar"><i class="${quotaWindowClass(window.status)}" style="width: ${Math.max(0, Math.min(100, window.remainingPercent)).toFixed(1)}%"></i></span>`
        : "";
      return `<li><strong>${escapeHtml(window.name)}${scoped}</strong><span class="badge ${stale ? "" : quotaWindowClass(window.status)}">${escapeHtml(percent)}</span>${bar}<small class="quota-reset">${escapeHtml(reset)}</small></li>`;
    };
    const accountWindows = account.quota?.windows || [];
    const windows = accountWindows.map(renderAccountWindow).join("");
    const busy = state.poolActions.get(account.key) || (state.poolBulkBusy ? "批量操作中" : resetCardRefreshes.has(account.key) ? "刷新重置卡中" : "");
    const expiry = resetMs(account.identity?.subscriptionExpiresAt);
    const expiryNote = Number.isFinite(expiry) && expiry > Date.now() && expiry - Date.now() <= 7 * 86400000 ? " · 7 天内到期" : Number.isFinite(expiry) && expiry <= Date.now() ? " · 已过期" : "";
    return `<tr class="pool-account-row${state.poolSelection.has(account.selectionId) ? " is-selected" : ""}">
      <td data-label="账号"><label class="pool-account-choice"><input class="pool-account-select" type="checkbox" data-select-account="${escapeHtml(account.selectionId || "")}" aria-label="选择 ${escapeHtml(identity)}" ${state.poolSelection.has(account.selectionId) ? "checked" : ""} ${busy || !account.selectionId ? "disabled" : ""}><span class="account-name">${escapeHtml(identity)}</span></label><span class="account-sub">${escapeHtml(account.identity?.email || account.id)}</span>${account.identity?.subscriptionExpiresAt ? `<span class="account-sub${expiryNote ? " pool-expiry-warning" : ""}" title="${escapeHtml(formatTime(account.identity.subscriptionExpiresAt))}">订阅至 ${escapeHtml(formatExpiryDate(account.identity.subscriptionExpiresAt))}${expiryNote}</span>` : ""}${account.syncWarnings?.length ? `<span class="account-sub pool-status-note console-warning">${escapeHtml([...new Set(account.syncWarnings.map((warning) => warning.message))].join(" "))}</span>` : ""}</td>
      <td data-label="账户类型"><span class="badge">${escapeHtml(plan)}</span></td>
      <td data-label="邀请活动">${escapeHtml(activity)}</td>
      <td data-label="重置卡"><strong>${account.resetCards ? `${availableResetCards(account).length} 张` : account.loggedIn ? "未读取" : "未登录"}</strong><div class="reset-card-actions"><button class="button button-secondary" type="button" data-refresh-reset-cards="${escapeHtml(account.key)}" aria-label="刷新重置卡数量" title="刷新重置卡数量" ${!account.loggedIn || busy || resetCardState.busy || resetCardState.loading ? "disabled" : ""}>刷新</button><button class="button button-secondary" type="button" data-reset-account="${escapeHtml(account.key)}" ${!account.loggedIn || busy || resetCardState.busy || resetCardState.loading || availableResetCards(account).length === 0 ? "disabled" : ""}>重置额度</button></div></td>
      <td data-label="额度窗口">${quotaCell(account, windows)}</td>
      <td data-label="轮询优先级">${priorityCell(account)}</td>
      <td data-label="中转状态"><span class="table-status ${status.className}">${status.label}</span><span class="account-sub pool-status-note">${escapeHtml(status.note)}</span>${poolStatus(account) === "cooling" && account.cooldownUntil ? `<span class="account-sub">冷却至 ${escapeHtml(formatCompactTime(account.cooldownUntil))}</span>` : ""}</td>
      <td data-label="最近响应">${lastResponseCell(account.quota || {})}<span class="account-sub">累计 ${formatNumber(account.quota?.requests)} 次请求</span></td>
      <td data-label="管理操作"><fieldset class="account-actions pool-action-group" ${busy ? "disabled" : ""} aria-label="管理 ${escapeHtml(identity)}">${cooldownActionButton(account)}<button class="button button-secondary account-renew" type="button" data-renew-account="${escapeHtml(account.key)}" title="刷新登录态，不延长订阅">续期</button><button class="button button-secondary account-delete" type="button" data-account-key="${escapeHtml(account.key)}">删除</button></fieldset>${busy ? `<span class="account-sub" role="status">${escapeHtml(busy)}</span>` : ""}</td>
    </tr>`;
  }).join("");
}

// Sixty-seven accounts do not fit on a page, so the questions the table cannot answer are
// answered above it: how much the pool has left, how that is spread across accounts, and when
// it comes back. The last one is the whole point — the rotation mode decides whether the
// accounts empty together or one at a time, and its selector sits in this same row, so the
// cost of the choice is read off the cards beside it rather than from a sentence about it.
function renderPoolCapacity(accounts) {
  const live = accounts.filter((account) => account.loggedIn && poolStatus(account) !== "disabled");
  const metered = live.filter((account) => Number.isFinite(poolRemaining(account)));
  if (live.length === 0) {
    elements.poolCapacity.innerHTML = `<p class="pool-capacity-empty">${accounts.some((account) => account.loggedIn) ? "已登录账号均被手动停用，请按需恢复参与轮询。" : "还没有已登录的账号。"}</p>`;
    return;
  }
  const remaining = metered.map(poolRemaining);
  const average = remaining.length ? remaining.reduce((sum, value) => sum + value, 0) / remaining.length : null;
  const spent = metered.filter((account) => poolRemaining(account) <= 0).length;
  const low = metered.filter((account) => poolRemaining(account) > 0 && poolRemaining(account) < 20).length;
  const ready = live.filter((account) => poolStatus(account) === "available").length;
  const resets = upcomingResets(live);

  elements.poolCapacity.innerHTML = `
    <article class="capacity-card capacity-total">
      <span class="capacity-label">已知额度平均余量</span>
      <strong class="capacity-value">${average === null ? "暂无数据" : `${average.toFixed(1)}%`}</strong>
      ${average === null ? "" : `<div class="capacity-bar" role="img" aria-label="池子平均余量 ${average.toFixed(1)}%"><i class="${capacityBarClass(average)}" style="width: ${Math.max(0, Math.min(100, average)).toFixed(1)}%"></i></div>`}
      <small>${metered.length} 个已知 · ${live.length - metered.length} 个未知；等权均值，非总可用 Token</small>
    </article>
    <article class="capacity-card">
      <span class="capacity-label">可用账号</span>
      <strong class="capacity-value">${ready} <em>/ ${live.length}</em></strong>
      <small>${spent} 个已用尽 · ${low} 个不足 20% · 未知额度不计为满额</small>
    </article>
    <article class="capacity-card">
      <span class="capacity-label">下一次重置</span>
      <strong class="capacity-value">${resets.next ? escapeHtml(formatCompactTime(resets.next)) : "暂无数据"}</strong>
      <small>${escapeHtml(resetSpreadHint(resets))}</small>
    </article>`;
}


function renderPoolSelection(accounts, filtered, pageAccounts) {
  const unsupported = accounts.filter((account) => !account.selectionId).length;
  elements.poolSelectionWarning.hidden = unsupported === 0;
  elements.poolSelectionWarning.textContent = unsupported ? `${unsupported} 个账号缺少安全选择标识：后端版本尚未更新。请重启网关服务后刷新页面，多选才能启用。` : "";
  const identities = new Set(accounts.map((account) => account.selectionId).filter(Boolean));
  for (const identity of state.poolSelection) if (!identities.has(identity)) state.poolSelection.delete(identity);
  const selectable = pageAccounts.filter((account) => account.selectionId && !state.poolActions.has(account.key));
  const selected = selectable.filter((account) => state.poolSelection.has(account.selectionId)).length;
  elements.poolSelectPage.checked = selectable.length > 0 && selected === selectable.length;
  elements.poolSelectPage.indeterminate = selected > 0 && selected < selectable.length;
  elements.poolSelectPage.disabled = state.poolBulkBusy || !selectable.length;
  const visibleSelected = filtered.filter((account) => state.poolSelection.has(account.selectionId)).length;
  elements.poolSelectionCount.textContent = `${state.poolBulkBusy ? "正在处理 · " : ""}已选 ${state.poolSelection.size} 个账号${state.poolSelection.size > visibleSelected ? `（${state.poolSelection.size - visibleSelected} 个不在当前筛选）` : ""}`;
  elements.poolSelectFiltered.disabled = state.poolBulkBusy || !filtered.some((account) => account.selectionId && !state.poolActions.has(account.key));
  elements.poolClearSelection.disabled = state.poolBulkBusy || !state.poolSelection.size;
  for (const button of [elements.poolBulkDisable, elements.poolBulkRecover, elements.poolBulkDelete]) {
    button.disabled = state.poolBulkBusy || state.poolActions.size > 0 || !state.poolSelection.size;
  }
}

function selectPoolAccount(event) {
  const checkbox = event.target?.closest?.("[data-select-account]");
  if (!checkbox || checkbox.disabled || state.poolBulkBusy) return;
  const identity = checkbox.dataset.selectAccount;
  if (!state.data?.accounts.some((account) => account.selectionId === identity)) return;
  if (checkbox.checked) state.poolSelection.add(identity);
  else state.poolSelection.delete(identity);
  renderPool(state.data.accounts);
  Array.from(document.querySelectorAll?.(".pool-account-select") || []).find((input) => input.dataset.selectAccount === identity)?.focus({ preventScroll: true });
}

function selectPoolAccounts(scope, checked) {
  if (state.poolBulkBusy) return;
  const accounts = state.data?.accounts || [];
  if (scope === "clear") state.poolSelection.clear();
  else {
    const filtered = sortPool(accounts.filter(matchesPoolFilter));
    const targets = scope === "page" ? filtered.slice((state.poolPage - 1) * POOL_PAGE_SIZE, state.poolPage * POOL_PAGE_SIZE) : filtered;
    for (const account of targets) {
      if (!account.selectionId || state.poolActions.has(account.key)) continue;
      if (checked) state.poolSelection.add(account.selectionId);
      else state.poolSelection.delete(account.selectionId);
    }
  }
  renderPool(accounts);
}

async function bulkPoolAccounts(action) {
  const labels = { disable: "停用", recover: "恢复", delete: "删除" };
  if (!labels[action] || state.poolBulkBusy || state.poolActions.size) return;
  const selected = (state.data?.accounts || []).filter((account) => state.poolSelection.has(account.selectionId));
  if (!selected.length) return;
  const extra = action === "delete" ? "账号将移出账号池，本地登录文件保留。" : action === "disable" ? "这些账号将停止参与轮询。" : "将解除手动停用和冷却，不会恢复已消耗额度。";
  if (!window.confirm(`确认${labels[action]}所选 ${selected.length} 个账号（包括其他页及筛选外的选择）？${extra}`)) return;
  state.poolBulkBusy = true;
  renderPool(state.data.accounts);
  try {
    const result = await request("/api/accounts/bulk", { method: "POST", body: { action, accounts: selected.map(({ key, selectionId }) => ({ key, selectionId })) } });
    if (!Array.isArray(result?.results)) throw new Error("批量操作返回格式异常，请刷新核实结果。");
    for (const item of result.results) if (item.ok) state.poolSelection.delete(item.selectionId);
    if (action === "delete") { state.selectedKey = null; state.loginKey = null; }
    await loadDashboard();
    const failures = result.results.filter((item) => !item.ok);
    showNotice(`批量${labels[action]}：成功 ${result.results.length - failures.length} 个，失败 ${failures.length} 个。${failures.length ? `失败账号保留选择：${failures[0].error || "请重试"}` : ""}`, failures.length ? "error" : "success");
  } catch (error) {
    showNotice(error.message || "批量操作失败，请刷新后重试。", "error");
  } finally {
    state.poolBulkBusy = false;
    renderPool(state.data?.accounts || []);
  }
}

function capacityBarClass(percent) {
  return percent <= 0 ? "bad" : percent < 20 ? "warning" : "good";
}

// The account-wide windows only — a `7d_fable` that is full stops fable, not the account, and
// counting it here would report a pool that is fine as a pool that is out.
function upcomingResets(accounts) {
  const times = accounts
    .flatMap((account) => (account.quota?.windows || []).filter((window) => !window.modelScoped))
    .map((window) => resetMs(window.resetAt))
    .filter((value) => Number.isFinite(value) && value > Date.now())
    .sort((left, right) => left - right);
  return { next: times[0] ?? null, last: times[times.length - 1] ?? null, count: times.length };
}

function resetMs(value) {
  if (typeof value === "number") return value > 0 ? value < 1e12 ? value * 1000 : value : NaN;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : NaN;
}

// The cost of draining evenly, stated as a number rather than a warning: windows that all reset
// inside the same hour mean the pool goes quiet together, and a wide spread means there is
// usually something fresh.
function resetSpreadHint(resets) {
  if (!resets.next || !resets.last) return "暂无未来的账号级重置时间";
  const hours = (resets.last - resets.next) / 3_600_000;
  if (hours < 1) return `${resets.count} 个窗口将在 1 小时范围内重置`;
  return `${resets.count} 个窗口分散在 ${hours < 24 ? `${hours.toFixed(1)} 小时` : `${(hours / 24).toFixed(1)} 天`}内重置`;
}

const POOL_SORTS = {
  "remaining-asc": (left, right) => comparePoolRemaining(left, right, 1),
  "remaining-desc": (left, right) => comparePoolRemaining(left, right, -1),
  reset: (left, right) => sortableReset(left) - sortableReset(right),
  requests: (left, right) => (right.quota?.requests || 0) - (left.quota?.requests || 0),
  priority: (left, right) => (right.priority ?? -1) - (left.priority ?? -1),
  expiry: (left, right) => (resetMs(left.identity?.subscriptionExpiresAt) || Infinity) - (resetMs(right.identity?.subscriptionExpiresAt) || Infinity)
};

function sortPool(accounts) {
  const compare = POOL_SORTS[state.poolSort];
  // A copy: the sort must not reorder the array the rest of the console reads.
  return compare ? [...accounts].sort(compare) : accounts;
}

function comparePoolRemaining(left, right, direction) {
  const leftValue = poolRemaining(left);
  const rightValue = poolRemaining(right);
  if (!Number.isFinite(leftValue)) return Number.isFinite(rightValue) ? 1 : 0;
  if (!Number.isFinite(rightValue)) return -1;
  return (leftValue - rightValue) * direction;
}

function sortableReset(account) {
  const times = (account.quota?.windows || [])
    .filter((window) => !window.modelScoped)
    .map((window) => resetMs(window.resetAt))
    .filter((value) => Number.isFinite(value) && value > Date.now());
  return times.length > 0 ? Math.min(...times) : Number.POSITIVE_INFINITY;
}

// A congestion 503 is the relay refusing out of its own capacity, and it says so in the refusal:
// nothing is charged and the account's quota is untouched. Reporting it as this account's last
// response paints a healthy pool red — during one spell 65 of 67 accounts showed a red 503 while
// every one of them was available and serving the next request.
function lastResponseCell(quota) {
  if (quota.lastCongested) {
    return `<span class="table-status warning" title="中转的共享容量当次已满，与该账号无关：不计费，也不影响账号额度">中转拥塞</span>`;
  }
  const status = quota.lastStatus;
  if (!status) return escapeHtml(formatStatus(status));
  const tone = status >= 200 && status < 300 ? "good" : status === 429 ? "warning" : "bad";
  return `<span class="table-status ${tone}">${escapeHtml(formatStatus(status))}</span>`;
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
  return `<div class="priority-cell"><select class="account-priority" data-priority-account="${escapeHtml(account.key)}" aria-label="轮询优先级" title="轮询优先级" ${state.poolBulkBusy || state.poolActions.has(account.key) ? "disabled" : ""}>${options}</select><span class="account-sub">当前 ${escapeHtml(String(effective))}</span></div>`;
}

function cooldownActionButton(account) {
  if (!account.loggedIn && !account.disabled) return "";
  if (poolStatus(account) === "disabled" || poolStatus(account) === "cooling") {
    return `<button class="button button-secondary account-recover" type="button" data-recover-account="${escapeHtml(account.key)}">恢复轮询</button>`;
  }
  return `<button class="button button-secondary account-cooldown" type="button" data-cooldown-account="${escapeHtml(account.key)}" title="手动停用后不会自动恢复">暂停轮询</button>`;
}

function poolRemaining(account) {
  const windows = (account.quota?.windows || []).filter((window) => !window.modelScoped);
  if (windows.length) {
    const current = windows.filter((window) => !Number.isFinite(resetMs(window.resetAt)) || resetMs(window.resetAt) > Date.now());
    if (!current.length || current.some((window) => !Number.isFinite(window.remainingPercent))) return null;
    return Math.max(0, Math.min(100, ...current.map((window) => window.remainingPercent)));
  }
  if ((account.quota?.windows || []).length) return null;
  return Number.isFinite(account.quota?.remainingPercent) ? Math.max(0, Math.min(100, account.quota.remainingPercent)) : null;
}

const POOL_STATUS_LABELS = { all: "全部", available: "可用", cooling: "自动冷却", disabled: "手动停用", exhausted: "额度用尽", no_quota: "无额度备用", signed_out: "未登录", unknown: "状态待确认" };

function poolStatus(account) {
  if (account.disabled || account.quota?.availability === "disabled") return "disabled";
  if (!account.loggedIn) return "signed_out";
  if (account.quota?.availability === "cooling") return "cooling";
  if (account.quota?.availability === "no_quota") return "no_quota";
  if (poolRemaining(account) === 0) return "exhausted";
  return account.quota?.availability === "available" ? "available" : "unknown";
}

function poolStatusMeta(account) {
  const status = poolStatus(account);
  const notes = {
    available: "符合常规轮询条件", cooling: "请求失败后的暂时冷却，非手动停用", disabled: "已停止轮询，需手动恢复",
    exhausted: "账号级窗口已用尽；等待重置", no_quota: "仅在没有付费候选时作为备用", signed_out: "需要有效登录态", unknown: "尚无可靠状态，请刷新确认"
  };
  return { label: POOL_STATUS_LABELS[status], className: status === "available" ? "good" : status === "signed_out" ? "bad" : status === "unknown" ? "neutral" : "warning", note: notes[status] };
}

function renderPoolStatuses(accounts) {
  elements.poolStatusSummary.innerHTML = Object.entries(POOL_STATUS_LABELS).map(([status, label]) => {
    const count = status === "all" ? accounts.length : accounts.filter((account) => poolStatus(account) === status).length;
    return `<button type="button" class="pool-status-chip${state.poolStatus === status ? " is-active" : ""}" data-pool-status="${status}" aria-pressed="${state.poolStatus === status}">${label}<strong>${count}</strong></button>`;
  }).join("");
}

function setPoolStatus(status) {
  if (!Object.hasOwn(POOL_STATUS_LABELS, status)) return;
  state.poolStatus = status;
  state.poolPage = 1;
  renderPool(state.data?.accounts || []);
}

function resetPoolFilters() {
  state.poolQuery = "";
  state.poolCategory = "all";
  state.poolSort = "default";
  state.poolStatus = "all";
  state.poolPage = 1;
  renderPool(state.data?.accounts || []);
}

function beginPoolAction(key, label) {
  if (state.poolBulkBusy || state.poolActions.has(key)) return false;
  state.poolActions.set(key, label);
  renderPool(state.data?.accounts || []);
  return true;
}

function finishPoolAction(key) {
  state.poolActions.delete(key);
  renderPool(state.data?.accounts || []);
}

function changePoolPage(direction) {
  const accounts = state.data?.accounts || [];
  const filtered = accounts.filter(matchesPoolFilter);
  const pageCount = Math.max(1, Math.ceil(filtered.length / POOL_PAGE_SIZE));
  state.poolPage = Math.min(pageCount, Math.max(1, state.poolPage + direction));
  renderPool(accounts);
}

function matchesPoolFilter(account) {
  if (state.poolStatus !== "all" && poolStatus(account) !== state.poolStatus) return false;
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
    showNotice(`邮箱域名已刷新，共 ${result.domains.length} 个。`, "success");
  } catch (error) {
    showNotice(error.message || "无法获取 MoeMail 域名。", "error");
  } finally {
    setBusy(elements.moemailDomains, false, "自动获取域名");
  }
}

async function createReferral() {
  const account = selectedAccount();
  if (!account) return;
  setBusy(elements.createCode, true, "读取中");
  try {
    const result = await request("/api/campaign-link?account=" + encodeURIComponent(account.key));
    account.campaign = result.campaign;
    if (selectedAccount()?.key === account.key) renderAccount(account);
    showNotice(result.campaign ? "新版邀请链接已刷新。" : "官方暂未提供邀请链接。", result.campaign ? "success" : "error");
  } catch (error) {
    showNotice(error.message || "无法读取邀请链接。", "error");
  } finally {
    setBusy(elements.createCode, false, "刷新链接");
  }
}

async function copyInviteCode() {
  const link = selectedAccount()?.campaign?.url;
  if (!link) return;
  try {
    await copyText(link);
    showNotice("邀请链接已复制。", "success");
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
    state.issuedApiKeyId = result.record.id;
    elements.apiKeyName.value = "";
    state.apiKeys = [result.record, ...state.apiKeys];
    state.apiKeysLoaded = true;
    resetConsoleFilters("apiKey");
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
  if (!button || button.disabled) return;
  const key = state.apiKeys.find((entry) => entry.id === button.dataset.keyId);
  if (!window.confirm(`确认吊销「${key?.name || "此密钥"}」？使用该密钥的应用将立即无法访问接口，此操作不可撤销。`)) return;
  setBusy(button, true, "吊销中");
  try {
    await request(`/api/keys/${encodeURIComponent(button.dataset.keyId)}`, { method: "DELETE" });
    state.apiKeys = state.apiKeys.filter((key) => key.id !== button.dataset.keyId);
    if (state.issuedApiKeyId === button.dataset.keyId) dismissApiKey();
    renderApiKeys();
    showNotice("OpenAI API Key 已吊销。", "success");
  } catch (error) {
    showNotice(error.message || "无法吊销 OpenAI API Key。", "error");
    setBusy(button, false, "吊销");
  }
}

async function deleteAccount(event) {
  const button = event.target.closest("[data-account-key]");
  if (!button || button.disabled || state.poolActions.has(button.dataset.accountKey) || !window.confirm("从账号池删除该账户？本地登录文件会保留。")) return;
  if (!beginPoolAction(button.dataset.accountKey, "删除中")) return;
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
  } finally {
    finishPoolAction(button.dataset.accountKey);
  }
}

async function renewAccount(event) {
  const button = event.target.closest("[data-renew-account]");
  if (!button || button.disabled || !beginPoolAction(button.dataset.renewAccount, "刷新登录态中")) return;
  setBusy(button, true, "续期中");
  try {
    await request(`/api/accounts/${encodeURIComponent(button.dataset.renewAccount)}/refresh`, { method: "POST" });
    await loadDashboard();
    showNotice("账号登录态已续期。", "success");
  } catch (error) {
    showNotice(error.message || "账号续期失败，请重新登录。", "error");
  } finally {
    finishPoolAction(button.dataset.renewAccount);
    setBusy(button, false, "续期");
  }
}

async function cooldownAccount(event) {
  const button = event.target.closest("[data-cooldown-account]");
  if (!button || button.disabled || state.poolActions.has(button.dataset.cooldownAccount) || !window.confirm("将该账号移出中转轮询？在你点击恢复之前它不会再被使用。")) return;
  if (!beginPoolAction(button.dataset.cooldownAccount, "暂停轮询中")) return;
  setBusy(button, true, "冷却中");
  try {
    await request(`/api/accounts/${encodeURIComponent(button.dataset.cooldownAccount)}/cooldown`, { method: "POST" });
    await loadDashboard();
    showNotice("该账号已冷却，已停止参与中转轮询。", "success");
  } catch (error) {
    showNotice(error.message || "无法冷却该账号。", "error");
    setBusy(button, false, "冷却");
  } finally {
    finishPoolAction(button.dataset.cooldownAccount);
  }
}

async function changeAccountPriority(event) {
  const select = event.target?.closest?.("select[data-priority-account]");
  if (!select || select.disabled || !beginPoolAction(select.dataset.priorityAccount, "调整优先级中")) return;
  const priority = select.value === "auto" ? null : Number(select.value);
  select.disabled = true;
  try {
    const result = await request(`/api/accounts/${encodeURIComponent(select.dataset.priorityAccount)}/priority`, { method: "PUT", body: { priority } });
    await loadDashboard();
    showNotice(priority === null ? `该账号恢复按档位排序（当前 ${result.priority}）。` : `该账号的轮询优先级已设为 ${result.priority}。`, "success");
  } catch (error) {
    showNotice(error.message || "无法调整轮询优先级。", "error");
  } finally {
    finishPoolAction(select.dataset.priorityAccount);
    select.disabled = false;
  }
}

async function recoverAccount(event) {
  const button = event.target.closest("[data-recover-account]");
  if (!button || button.disabled || !beginPoolAction(button.dataset.recoverAccount, "恢复轮询中")) return;
  setBusy(button, true, "恢复中");
  try {
    await request(`/api/accounts/${encodeURIComponent(button.dataset.recoverAccount)}/recover`, { method: "POST" });
    await loadDashboard();
    showNotice("该账号已解除停用/冷却，实际可用性仍取决于登录态和额度。", "success");
  } catch (error) {
    showNotice(error.message || "无法恢复该账号。", "error");
    setBusy(button, false, "恢复");
  } finally {
    finishPoolAction(button.dataset.recoverAccount);
  }
}

async function loadRotationMode() {
  if (webSessionExpired || !pageActive) return;
  const load = trackReadLoad();
  try {
    const result = await request("/api/rotation-mode");
    if (load.current()) applyRotationMode(result.mode);
  } catch {
    // The pool page still works without it; the selector simply shows nothing chosen.
  } finally {
    load.finish();
  }
}

function applyRotationMode(mode) {
  if (!mode) return;
  elements.rotationMode.value = mode;
  const notes = { spread: "同优先级内优先选择已用额度较少的账号，分档轮转。", waterfall: "同优先级内优先选择已用额度较多但未用尽的账号。", roundRobin: "同优先级内按最近使用顺序轮流分配。" };
  elements.rotationModeHint.textContent = `${notes[mode] || ""}已有会话优先复用仍符合条件的账号。`;
}

async function saveRotationMode() {
  const mode = elements.rotationMode.value;
  elements.rotationMode.disabled = true;
  try {
    const result = await request("/api/rotation-mode", { method: "PUT", body: { mode } });
    applyRotationMode(result.mode);
    showNotice("轮询模式已切换，下一个请求开始生效。", "success");
  } catch (error) {
    showNotice(error.message || "无法切换轮询模式。", "error");
    await loadRotationMode();
  } finally {
    elements.rotationMode.disabled = false;
  }
}

async function recoverAccounts() {
  if (elements.recoverAccounts.disabled || !window.confirm("解除全部账号的自动冷却和手动停用？这会重新启用你主动暂停的账号，但不会恢复已用尽的额度。")) return;
  setBusy(elements.recoverAccounts, true, "解除中");
  try {
    const result = await request("/api/accounts/recover", { method: "POST" });
    await loadDashboard();
    showNotice(result.recovered ? `已解除 ${result.recovered} 个账号的冷却/停用，实际可用性仍取决于登录态和额度。` : "没有账号处于冷却状态。", "success");
  } catch (error) {
    showNotice(error.message || "无法解除冷却。", "error");
  } finally {
    setBusy(elements.recoverAccounts, false, "解除全部冷却");
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
    const { response, blob } = await request("/api/accounts/export", { responseType: "blob" });
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
  if (state.modelHealthAction || state.modelHealth?.running || state.modelHealth?.discovering) return;
  state.modelHealthAction = "discover";
  renderModelHealth();
  setBusy(elements.modelHealthDiscover, true, "读取中");
  try {
    const result = await request("/api/model-health/discover", { method: "POST" });
    state.modelHealth = result.health;
    state.modelHealthError = "";
    showNotice(result.health?.lastError || "模型目录已刷新。", result.health?.lastError ? "error" : "success");
  } catch (error) {
    state.modelHealthError = error.message || "无法读取上游模型目录。";
    showNotice(error.message || "无法读取上游模型目录。", "error");
  } finally {
    state.modelHealthAction = null;
    setBusy(elements.modelHealthDiscover, false, "刷新模型");
    renderModelHealth();
    if (state.data) renderOverview(state.data);
  }
}

async function checkModel(event) {
  const button = event.target.closest("[data-model-id]");
  if (!button || button.disabled || state.modelHealthAction || state.modelHealth?.running || state.modelHealth?.discovering) return;
  state.modelHealthAction = button.dataset.modelId;
  setBusy(button, true, "检测中");
  renderModelHealth();
  try {
    const modelId = encodeURIComponent(button.dataset.modelId);
    const result = await request(`/api/model-health/${modelId}/check`, { method: "POST" });
    state.modelHealth = result.health;
    state.modelHealthError = "";
  } catch (error) {
    state.modelHealthError = error.message || "模型检测失败。";
    showNotice(error.message || "模型检测失败。", "error");
  } finally {
    state.modelHealthAction = null;
    renderModelHealth();
    if (state.data) renderOverview(state.data);
  }
}

async function logout() {
  elements.logout.disabled = true;
  try {
    await request("/api/auth/logout", { method: "POST" });
    try {
      window.sessionStorage?.removeItem(ACTIVE_VIEW_STORAGE_KEY);
    } catch {}
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
  const method = (options.method || "GET").toUpperCase();
  const readOnly = method === "GET" || method === "HEAD";
  if (webSessionExpired || (readOnly && !pageActive)) throw readCancelledError();
  const controller = new AbortController();
  const generation = readGeneration;
  const timeoutMs = options.timeoutMs ?? (readOnly ? 60_000 : 0);
  let timer;
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason || readCancelledError());
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const checkCurrent = () => {
    if (controller.signal.aborted) throw controller.signal.reason || readCancelledError();
    if (readOnly && generation !== readGeneration) throw readCancelledError();
  };
  if (readOnly) activeReads.add(controller);
  if (timeoutMs > 0) timer = setTimeout(() => {
    const error = new Error(`请求超时（${Math.ceil(timeoutMs / 1000)} 秒），请稍后重试。`);
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  try {
    // Racing the entire operation also settles mocks/transports that ignore AbortSignal,
    // including a response whose headers arrive but whose body never finishes.
    const operation = (async () => {
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: options.body ? { "Content-Type": "application/json" } : undefined,
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal
        });
      } catch (error) {
        checkCurrent();
        if (error?.name === "AbortError") throw error;
        throw new Error(error?.message === "Failed to fetch" ? "无法连接本地网关，请确认服务仍在运行。" : "网络请求失败。");
      }
      checkCurrent();
      if (response.ok && options.responseType === "blob") {
        const blob = await response.blob();
        checkCurrent();
        return { response, blob };
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        checkCurrent();
        if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
        // Preserve the existing fallback for API responses that aren't valid JSON.
      }
      checkCurrent();
      if (!response.ok) {
        const error = new Error(apiErrorMessage(payload, response.status, url));
        if (response.status === 401 && payload?.error?.code === "web_session_required") expireWebSession(error);
        throw error;
      }
      return payload;
    })();
    const result = await Promise.race([operation, cancelled]);
    checkCurrent();
    return result;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    activeReads.delete(controller);
  }
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

function quotaWindowClass(status) {
  return status === "limit_reached" ? "bad" : status === "warning" ? "warning" : "good";
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
