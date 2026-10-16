import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PRIORITY_RANGE, ROTATION_MODES, hasRelayQuota, normalizePriority, readProfile, tokenClaims, usedPercentOf } from "./pool.js";
import { MoeMailClient } from "./moemail.js";
import { saveRefreshedAuth } from "./session-refresh.js";
import { MIRASIM_CLIENT_VERSION } from "./mirasim-release.js";
import { normalizeCampaignLink, normalizeResetCards, RESET_OUTCOMES, resetWindows } from "./account-features.js";

const AUTH_TIMEOUT_MS = 12_000;
const LOGIN_TIMEOUT_MS = 45_000;
const MAX_USAGE_CALL_IDS = 100;
const MAX_MOEMAIL_BATCH_SIZE = 5;
const MAX_ACCOUNT_IMPORT_SIZE = 100;
const LICENSE_CODE_PREFIX = "MLIC";
const LICENSE_VERDICTS = new Set(["redeemable", "already_redeemed", "blocked_lower_tier"]);
const PLAN_LABELS = { none: "FREE", free: "FREE", go: "Go", basic: "MAX 2X", plus: "MAX 10X", max: "MAX 40X", enterprise: "企业版", internal: "内部账号" };
// Mirasim answers a suspended activity with a plain English detail; the console speaks Chinese.
const UPSTREAM_DETAILS = new Map([
  ["invite code creation is paused", "官方已暂停生成新的邀请码，请稍后再试。"],
  ["invite code creation is disabled", "官方已关闭邀请码生成功能。"]
]);

export class RelayUsageLedger {
  #entries = new Map();

  constructor(database = null) {
    this.database = database;
  }

  // `congested` marks a 503 the relay refused out of its own capacity rather than anything this
  // account did. Without it the console reads a relay-wide spell as sixty-seven broken accounts:
  // every one of them shows a red 503 as its last response while all of them are in fact healthy,
  // available, and serving the very next request.
  record(profile, upstream, { congested = false } = {}) {
    const entry = this.#entry(profile.home);
    entry.requests += 1;
    entry.lastAt = new Date().toISOString();
    entry.lastStatus = upstream.status;
    entry.lastCongested = congested;
    const callId = upstream.headers?.get?.("x-litellm-call-id");
    if (callId && !entry.calls.some((call) => call.id === callId)) {
      entry.calls.push({ id: callId, at: entry.lastAt });
      entry.calls.splice(0, Math.max(0, entry.calls.length - MAX_USAGE_CALL_IDS));
    }
    this.#persist(profile.home, entry);
  }

  failure(profile) {
    const entry = this.#entry(profile.home);
    entry.failures += 1;
    entry.lastAt = new Date().toISOString();
    entry.lastStatus = 0;
    entry.lastCongested = false;
    this.#persist(profile.home, entry);
  }

  snapshot(home) {
    const entry = this.#entry(home);
    return {
      requests: entry.requests,
      failures: entry.failures,
      lastAt: entry.lastAt,
      lastStatus: entry.lastStatus,
      lastCongested: Boolean(entry.lastCongested),
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheWriteTokens: entry.cacheWriteTokens,
      calls: [...entry.calls]
    };
  }

  recordCallUsage(home, calls) {
    const entry = this.#entry(home);
    for (const call of calls) {
      const id = stringValue(call?.id) || stringValue(call?.callId) || stringValue(call?.call_id);
      if (!id || entry.accountedCalls.has(id)) continue;
      const totals = {
        inputTokens: count(call?.input),
        outputTokens: count(call?.output),
        cacheReadTokens: count(call?.cacheRead),
        cacheWriteTokens: count(call?.cacheWrite)
      };
      entry.accountedCalls.add(id);
      if (this.database) {
        const saved = this.database.recordUsageCall(home, id, totals);
        if (saved) Object.assign(entry, saved);
      } else {
        entry.inputTokens += totals.inputTokens;
        entry.outputTokens += totals.outputTokens;
        entry.cacheReadTokens += totals.cacheReadTokens;
        entry.cacheWriteTokens += totals.cacheWriteTokens;
      }
    }
    return this.snapshot(home);
  }

  #entry(home) {
    let entry = this.#entries.get(home);
    if (!entry) {
      const saved = this.database?.getUsageLedger(home);
      entry = {
        requests: count(saved?.requests),
        failures: count(saved?.failures),
        inputTokens: count(saved?.inputTokens),
        outputTokens: count(saved?.outputTokens),
        cacheReadTokens: count(saved?.cacheReadTokens),
        cacheWriteTokens: count(saved?.cacheWriteTokens),
        lastAt: saved?.lastAt || null,
        lastStatus: Number.isInteger(saved?.lastStatus) ? saved.lastStatus : null,
        calls: [],
        accountedCalls: new Set()
      };
      this.#entries.set(home, entry);
    }
    return entry;
  }

  #persist(home, entry) {
    this.database?.saveUsageLedger(home, entry);
  }
}

export class MirasimDashboard {
  #quotaRefreshes = new Map();

  constructor(config, pool, usage, { fetchImpl = fetch, database = null, moemail = null, sessionRefresher = null, relaySessions = null } = {}) {
    this.config = config;
    this.pool = pool;
    this.usage = usage;
    this.fetchImpl = fetchImpl;
    this.database = database;
    this.sessionRefresher = sessionRefresher;
    this.relaySessions = relaySessions;
    const savedMoeMail = database?.getMoeMailConfig(config.webAuth?.password);
    const configuredByEnvironment = Boolean(config.moemail?.url || config.moemail?.apiKey || config.moemail?.domain);
    if (!configuredByEnvironment && savedMoeMail) this.config.moemail = { ...config.moemail, ...savedMoeMail };
    this.moemail = moemail || new MoeMailClient(this.config.moemail, { fetchImpl });
  }

  async snapshot() {
    this.sessionRefresher?.refreshInBackground(this.config.homes);
    const statuses = new Map(this.pool.status().map((status) => [status.home, status]));
    const accounts = await Promise.all(this.config.homes.map(async (home, index) => {
      const status = statuses.get(home);
      const profile = readProfile(home);
      const usage = this.usage.snapshot(home);
      const account = {
        key: accountKey(index),
        selectionId: createHash("sha256").update(home).digest("hex"),
        id: profile?.id || status?.id || `account-${index + 1}`,
        loggedIn: Boolean(profile),
        healthy: Boolean(status?.healthy),
        disabled: Boolean(status?.disabled),
        cooldownUntil: status?.cooldownUntil || null,
        priority: status?.priority ?? null,
        priorityOverride: status?.priorityOverride ?? null,
        identity: null,
        referral: null,
        campaign: null,
        resetCards: null,
        quota: usageSummary(usage, status)
      };
      if (!profile) return account;

      // /auth/me is awaited on its own because it is the only source of the plan for a sealed
      // token, and the calls below have to know whether this account is funded.
      const identity = await this.#identity(profile);
      const planned = this.pool.profile(home) || profile;
      const planStatus = this.pool.status().find((item) => item.home === home) || status;
      const [quotaResult, limitsResult, campaignResult, resetCardsResult] = await Promise.allSettled([
        this.#usage(planned, usage),
        // A free account's limit windows advertise a budget the relay refuses to honour, so the
        // console is not given numbers that look like usable quota.
        hasRelayQuota(planned) ? this.#limits(readProfile(home) || profile) : null,
        this.campaignLink(account.key),
        this.resetCards(account.key)
      ]);
      const quota = quotaResult.status === "fulfilled" ? quotaResult.value : usageSummary(usage, planStatus);
      const limits = limitsResult.status === "fulfilled" ? limitsResult.value : null;
      const syncWarnings = [["campaign", campaignResult], ["usage", quotaResult], ["limits", limitsResult]]
        .filter(([, result]) => result.status === "rejected")
        .map(([field, result]) => snapshotWarning(field, result.reason));
      // The rotation otherwise learns an account's quota only from traffic it has already sent
      // that account, so an account nothing has touched since startup reads as untouched. This
      // reading costs nothing extra — the console is already fetching it — and it reaches the
      // rotation before a request has to be spent discovering the same thing.
      const windows = normalizeLimitWindows(limits);
      if (limitsResult.status === "fulfilled") this.pool.observeLimits(home, windows);
      return {
        ...account,
        healthy: Boolean(planStatus?.healthy),
        priority: planStatus?.priority ?? null,
        priorityOverride: planStatus?.priorityOverride ?? null,
        identity,
        campaign: campaignResult.status === "fulfilled" ? campaignResult.value : null,
        resetCards: resetCardsResult.status === "fulfilled" ? resetCardsResult.value : null,
        syncWarnings,
        quota: { ...quota, ...limitSummary(windows) }
      };
    }));

    return {
      generatedAt: new Date().toISOString(),
      relay: new URL(this.config.relayUrl).host,
      accounts
    };
  }

  async campaignLink(key) {
    const profile = this.#profileForKey(key);
    const response = await this.#request("/v1/pay/campaign/my-link", profile.token);
    return response.ok ? normalizeCampaignLink(response.data) : null;
  }

  async resetCards(key) {
    const response = await this.#accountBearerRequest(key, "/v1/reset-cards", "GET", 8000);
    if (!response.ok) throw upstreamError(response.status, "暂时无法读取重置卡", response.data);
    const snapshot = normalizeResetCards(response.data);
    if (!snapshot) throw httpError(502, "重置卡接口返回的数据不完整。");
    return snapshot;
  }

  async redeemResetCard(key, cardId, selectionId = null) {
    if (typeof cardId !== "string" || !cardId.trim() || cardId.length > 256) throw httpError(400, "请选择有效的重置卡。");
    const home = this.#homeForKey(key);
    if (selectionId !== null && selectionId !== createHash("sha256").update(home).digest("hex")) throw httpError(409, "账号列表已变化，请刷新后重新选择重置卡。");
    const response = await this.#accountBearerRequest(key, `/v1/reset-cards/${encodeURIComponent(cardId)}/redeem`, "POST", 20000);
    if (!response.ok) throw upstreamError(response.status, "重置卡使用结果未确认，请刷新列表核对后再操作", response.data);
    if (!RESET_OUTCOMES.has(response.data?.outcome)) throw httpError(502, "重置卡使用结果未确认，请刷新列表核对后再操作。");
    if (response.data.outcome === "reset") {
      this.pool.recover(home);
      this.pool.observeLimits(home, resetWindows(response.data.windows).map((name) => ({ name, usedPercent: 0, resetAt: null })));
    }
    return { outcome: response.data.outcome, windows: resetWindows(response.data.windows), cards: normalizeResetCards(response.data) };
  }

  async #accountBearerRequest(key, path, method, timeoutMs, baseUrl = this.config.relayUrl, body = undefined) {
    const profile = this.#profileForKey(key);
    const send = (token) => this.#authenticatedRequest(baseUrl, `${baseUrl.replace(/\/+$/, "")}${path}`, token, {
      method, timeoutMs, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      authenticatedHeaders: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }
    });
    let response = await send(profile.token);
    if (response.status === 401 && method === "GET" && (readProfile(profile.home)?.token !== profile.token || await this.#refreshQuotaCredentials(profile))) {
      const refreshed = readProfile(profile.home);
      if (refreshed?.token && refreshed.token !== profile.token) response = await send(refreshed.token);
    }
    return response;
  }

  async #refreshQuotaCredentials(profile) {
    if (typeof this.sessionRefresher?.refreshNow !== "function") return false;
    const previous = this.#quotaRefreshes.get(profile.home);
    if (previous?.pending) return previous.pending;
    if (previous && Date.now() - previous.at < 300_000) return false;
    const record = { at: Date.now(), pending: null };
    this.#quotaRefreshes.set(profile.home, record);
    record.pending = Promise.resolve().then(() => this.sessionRefresher.refreshNow(profile.home)).then(Boolean, () => false);
    try { return await record.pending; }
    finally { record.pending = null; }
  }


  async requestLoginCode(key, email) {
    const normalizedEmail = normalizeEmail(email);
    const added = key === "new";
    if (added) key = this.#addAccount();
    try {
      const result = await this.#requestLoginCode(normalizedEmail);
      return { sent: true, ...(added ? { account: key } : {}), ...result };
    } catch (error) {
      if (added) this.#removeHome(this.#homeForKey(key));
      throw error;
    }
  }

  async deleteAccount(key) {
    const home = this.#homeForKey(key);
    if (!this.database) throw httpError(501, "当前账户池未启用持久化存储。");
    this.#removeHome(home);
  }

  bulkAccounts(action, accounts) {
    if (!["disable", "recover", "delete"].includes(action) || !Array.isArray(accounts) || !accounts.length || accounts.length > 1000) {
      throw httpError(400, "请选择 1–1000 个账号及有效的批量操作。");
    }
    if (action === "delete" && !this.database) throw httpError(501, "当前账户池未启用持久化存储。");
    const seen = new Set();
    const targets = accounts.map((account) => {
      if (typeof account?.key !== "string" || typeof account?.selectionId !== "string") throw httpError(400, "账号选择参数无效。");
      const home = this.#homeForKey(account?.key);
      const selectionId = createHash("sha256").update(home).digest("hex");
      if (account?.selectionId !== selectionId || seen.has(home)) throw httpError(409, "账号列表已变化或存在重复选择，请刷新后重新选择。");
      seen.add(home);
      return { key: account.key, home, selectionId };
    });
    const results = targets.map(({ key, home, selectionId }) => {
      try {
        if (action === "delete") this.#removeHome(home);
        else if (action === "disable") {
          this.pool.disable(home);
          this.database?.setHomeDisabled(home, true);
        } else {
          this.pool.enable(home);
          this.database?.setHomeDisabled(home, false);
        }
        return { key, selectionId, ok: true };
      } catch (error) {
        return { key, selectionId, ok: false, error: error.message || "操作失败" };
      }
    });
    return { action, results, succeeded: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length };
  }

  async renewAccount(key) {
    const home = this.#homeForKey(key);
    if (!this.sessionRefresher) throw httpError(501, "当前服务未启用登录续期。");
    const renewed = await this.sessionRefresher.refreshNow(home);
    if (!renewed) throw httpError(409, this.sessionRefresher.failureReason(home) || "官方登录态无法续期，请重新登录该账号。");
    return { renewed: true };
  }

  disableAccount(key) {
    const home = this.#homeForKey(key);
    this.pool.disable(home);
    this.database?.setHomeDisabled(home, true);
    return { disabled: true };
  }

  // The rotation order is a manual priority when one is set, and the plan order otherwise.
  setAccountPriority(key, priority) {
    const home = this.#homeForKey(key);
    const value = normalizePriority(priority);
    const requested = priority === null || priority === undefined || priority === "" || priority === "auto";
    if (!requested && value === null) throw httpError(400, `优先级需为 ${PRIORITY_RANGE.min}-${PRIORITY_RANGE.max} 的整数，留空则按账号档位自动排序。`);
    this.pool.setPriority(home, value);
    this.database?.setHomePriority(home, value);
    const status = this.pool.status().find((entry) => entry.home === home);
    return { updated: true, priority: status?.priority ?? null, priorityOverride: value };
  }

  recoverAccount(key) {
    const home = this.#homeForKey(key);
    this.pool.enable(home);
    this.database?.setHomeDisabled(home, false);
    return { recovered: true };
  }

  // What the rotation is doing now, and what else it could be doing — the console renders the
  // choice from this rather than holding its own copy of the list.
  rotationMode() {
    return { mode: this.pool.mode(), modes: [...ROTATION_MODES] };
  }

  setRotationMode(mode) {
    if (!this.pool.setMode(mode)) {
      throw httpError(400, `轮询模式必须是 ${[...ROTATION_MODES].join("、")} 之一。`);
    }
    // Stored so a restart keeps it. A pool without persistence still takes the change for as long
    // as it runs, which is what an operator flipping the mode to watch its effect expects.
    this.database?.saveRotationMode(this.pool.mode());
    return this.rotationMode();
  }

  // Lifts the cooldown from every account that is carrying one. Accounts an operator disabled by
  // hand are left alone: this undoes what an upstream outage did to the pool, not what a person did.
  recoverAllAccounts() {
    return { recovered: this.pool.recoverAll() };
  }

  async restoreAccounts() {
    if (!this.database) throw httpError(501, "当前账户池未启用持久化存储。");
    let entries;
    try {
      entries = readdirSync(this.config.accountRoot, { withFileTypes: true });
    } catch {
      return { restored: 0, accounts: [] };
    }
    const known = new Set(this.config.homes);
    const identities = new Set(this.config.homes.map((home) => accountIdentity(home)).filter(Boolean));
    const homes = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("account-"))
      .map((entry) => join(this.config.accountRoot, entry.name))
      .filter((home) => !known.has(home) && existsSync(join(home, "setting.json")))
      .filter((home) => {
        const identity = accountIdentity(home);
        if (!identity || identities.has(identity)) return false;
        identities.add(identity);
        return true;
      });
    for (const home of homes) {
      this.database.addHome(home);
      this.pool.add(home);
    }
    this.config.homes = this.pool.homes();
    await this.sessionRefresher?.refreshAll(homes);
    return { restored: homes.length, accounts: homes.map((home) => accountKey(this.config.homes.indexOf(home))) };
  }

  exportAccounts() {
    const statuses = new Map(this.pool.status().map((status) => [status.home, status]));
    const accounts = this.config.homes.flatMap((home) => {
      try {
        const setting = JSON.parse(readFileSync(join(home, "setting.json"), "utf8"));
        if (!validImportedSetting(setting)) return [];
        const status = statuses.get(home);
        return [{
          setting,
          disabled: Boolean(status?.disabled),
          priority: status?.priorityOverride ?? null
        }];
      } catch {
        return [];
      }
    });
    return { format: "mirasim-2api-accounts", version: 1, exportedAt: new Date().toISOString(), accounts };
  }

  importAccounts(payload) {
    if (!this.database) throw httpError(501, "当前账户池未启用持久化存储。");
    if (payload?.format !== "mirasim-2api-accounts" || payload?.version !== 1 || !Array.isArray(payload.accounts)) {
      throw httpError(400, "账号导入文件格式不正确。");
    }
    if (payload.accounts.length < 1 || payload.accounts.length > MAX_ACCOUNT_IMPORT_SIZE) {
      throw httpError(400, `一次只能导入 1-${MAX_ACCOUNT_IMPORT_SIZE} 个账号。`);
    }
    const existingIds = new Set(this.config.homes.map((home) => readProfile(home)?.id).filter(Boolean));
    let imported = 0;
    let skipped = 0;
    for (const account of payload.accounts) {
      if (!validImportedSetting(account?.setting)) { skipped += 1; continue; }
      const userId = account.setting.auth.userId;
      if (userId && existingIds.has(userId)) { skipped += 1; continue; }
      const home = join(this.config.accountRoot, `account-${randomUUID()}`);
      try {
        mkdirSync(home, { recursive: true, mode: 0o700 });
        writeFileSync(join(home, "setting.json"), `${JSON.stringify(account.setting, null, 2)}\n`, { mode: 0o600 });
        this.database.addHome(home);
        this.pool.add(home);
        const priority = normalizePriority(account.priority);
        if (priority !== null) {
          this.database.setHomePriority(home, priority);
          this.pool.setPriority(home, priority);
        }
        if (account.disabled === true) {
          this.database.setHomeDisabled(home, true);
          this.pool.disable(home);
        }
        if (userId) existingIds.add(userId);
        imported += 1;
      } catch {
        this.database.removeHome(home);
        this.pool.remove(home);
        rmSync(home, { recursive: true, force: true });
        skipped += 1;
      }
    }
    this.config.homes = this.pool.homes();
    return { imported, skipped };
  }

  async registerWithMoeMail(inviteCode, inviteResolved = false) {
    if (!this.database) throw httpError(501, "当前账户池未启用持久化存储。");
    if (!this.moemail.isConfigured()) {
      throw httpError(501, "尚未配置 MoeMail：请设置 MOEMAIL_URL、MOEMAIL_API_KEY 和 MOEMAIL_DOMAIN。");
    }
    const normalizedCode = inviteResolved ? String(inviteCode || "").trim() : await this.#registrationInviteCode(inviteCode);
    if (normalizedCode.length > 128) throw httpError(400, "请输入有效的邀请码或授权码。");

    let mailbox;
    const home = join(this.config.accountRoot, `account-${randomUUID()}`);
    try {
      mailbox = await this.moemail.createMailbox();
      const codeResult = await this.#requestLoginCode(mailbox.email);
      const verificationCode = codeResult.devCode || await this.moemail.waitForVerificationCode(mailbox);
      await this.#verifyLoginAt(home, mailbox.email, verificationCode);
      if (normalizedCode) await this.#redeemInviteAt(home, normalizedCode);
      this.database.addHome(home);
      this.pool.add(home);
      this.config.homes = this.pool.homes();
      return { account: accountKey(this.config.homes.length - 1), email: mailbox.email, redeemed: Boolean(normalizedCode) };
    } catch (error) {
      rmSync(home, { recursive: true, force: true });
      throw httpError(error.statusCode || 502, error.message || "MoeMail 注册失败。");
    } finally {
      await this.moemail.deleteMailbox(mailbox);
    }
  }

  async registerMoeMailBatch(inviteCode, count) {
    const requested = normalizeMoeMailBatchSize(count);
    const accounts = [];
    const resolvedInviteCode = await this.#registrationInviteCode(inviteCode);
    for (let index = 0; index < requested; index += 1) {
      try {
        accounts.push(await this.registerWithMoeMail(resolvedInviteCode, true));
      } catch (error) {
        return {
          requested,
          completed: accounts.length,
          accounts,
          stopped: true,
          error: error.message || "MoeMail 注册失败。"
        };
      }
    }
    return { requested, completed: accounts.length, accounts, stopped: false, error: null };
  }

  moeMailSettings() {
    return {
      configured: this.moemail.isConfigured(),
      url: this.moemail.url || "",
      domain: this.moemail.domains.join(", "),
      domains: [...this.moemail.domains]
    };
  }

  async discoverMoeMailDomains(input) {
    const url = normalizeUrl(input?.url || this.moemail.url, "MoeMail 服务地址");
    const apiKey = stringValue(input?.apiKey) || this.moemail.apiKey;
    if (!apiKey) throw httpError(400, "请填写 MoeMail API Key。" );
    return { domains: await new MoeMailClient({ url, apiKey }, { fetchImpl: this.fetchImpl }).listDomains() };
  }

  configureMoeMail(input) {
    if (!this.database) throw httpError(501, "当前账户池未启用持久化存储。");
    const url = normalizeUrl(input?.url, "MoeMail 服务地址");
    const domains = normalizeMoeMailDomains(input?.domain);
    const submittedApiKey = stringValue(input?.apiKey);
    const apiKey = submittedApiKey || this.moemail.apiKey;
    if (!apiKey) throw httpError(400, "请填写 MoeMail API Key。");
    const config = {
      url,
      domain: domains[0],
      domains,
      apiKey,
      expiryTimeMs: this.config.moemail?.expiryTimeMs || 3_600_000,
      codeTimeoutMs: this.config.moemail?.codeTimeoutMs || 120_000,
      pollMs: this.config.moemail?.pollMs || 2_500
    };
    this.database.saveMoeMailConfig(config, this.config.webAuth?.password);
    this.config.moemail = config;
    this.moemail = new MoeMailClient(config, { fetchImpl: this.fetchImpl });
    return this.moeMailSettings();
  }

  async #registrationInviteCode(inviteCode) {
    const supplied = typeof inviteCode === "string" ? inviteCode.trim() : "";
    if (supplied.length > 128) throw httpError(400, "请输入有效的邀请码或授权码。");
    return supplied;
  }

  #addAccount() {
    if (!this.database) throw httpError(501, "当前账户池未启用动态账户。");
    const home = join(this.config.accountRoot, `account-${randomUUID()}`);
    this.database.addHome(home);
    this.pool.add(home);
    this.config.homes = this.pool.homes();
    return accountKey(this.config.homes.length - 1);
  }

  #removeHome(home) {
    this.database.removeHome(home);
    this.pool.remove(home);
    this.config.homes = this.pool.homes();
  }

  async verifyLoginCode(key, email, code) {
    const home = this.#homeForKey(key);
    return this.#verifyLoginAt(home, email, code);
  }

  async redeemInvite(key, code) {
    const profile = this.#profileForKey(key);
    return this.#redeemInviteForProfile(profile, code);
  }

  async previewRedeemCode(key, code) {
    const profile = this.#profileForKey(key);
    const normalizedCode = normalizeRedeemCode(code);
    if (!isLicenseCode(normalizedCode)) return { kind: "invite", supported: false };
    return { kind: "license", supported: true, ...await this.#previewLicense(profile, normalizedCode) };
  }

  async #redeemInviteAt(home, code) {
    const profile = readProfile(home);
    if (!profile) throw httpError(502, "Mirasim 登录态未能保存。");
    return this.#redeemInviteForProfile(profile, code);
  }

  async #redeemInviteForProfile(profile, code) {
    const normalizedCode = normalizeRedeemCode(code);
    // Mirasim routes redemptions by prefix: MLIC codes are licences, everything else is a referral.
    if (isLicenseCode(normalizedCode)) return this.#redeemLicenseForProfile(profile, normalizedCode);

    const referral = await this.#referral(profile);
    if (referral?.code && referral.code === normalizedCode) {
      throw httpError(400, "不能兑换当前账号的邀请码。");
    }

    const response = await this.#request("/auth/invite/redeem", profile.token, {
      method: "POST",
      body: JSON.stringify({ code: normalizedCode })
    });
    if (!response.ok || typeof response.data?.access_token !== "string" || !response.data.access_token) {
      throw upstreamError(response.status, "邀请码未能兑换", response.data);
    }

    saveRefreshedAuth(profile.home, response.data.access_token, response.data.refresh_token);
    return { updated: true, kind: "invite" };
  }

  // Previewing first mirrors the desktop client: a licence below the current tier is rejected
  // without being consumed, so the code stays usable on another account.
  async #redeemLicenseForProfile(profile, code) {
    const preview = await this.#previewLicense(profile, code);
    if (preview.verdict === "blocked_lower_tier") {
      throw httpError(409, `该授权码为${planLabel(preview.plan)}，低于当前账号档位，官方已拦截且未消耗该授权码。`);
    }

    const response = await this.#request("/auth/license/redeem", profile.token, {
      method: "POST",
      body: JSON.stringify({ code })
    });
    if (!response.ok || typeof response.data?.access_token !== "string" || !response.data.access_token) {
      throw upstreamError(response.status, "授权码未能兑换", response.data);
    }

    saveRefreshedAuth(profile.home, response.data.access_token, response.data.refresh_token);
    return { updated: true, kind: "license", ...preview };
  }

  async #previewLicense(profile, code) {
    const response = await this.#request("/auth/license/preview", profile.token, {
      method: "POST",
      body: JSON.stringify({ code })
    });
    if (!response.ok) throw upstreamError(response.status, "授权码无法校验", response.data);
    const data = response.data || {};
    if (!LICENSE_VERDICTS.has(data.verdict)) throw httpError(502, "授权码校验：Mirasim 未返回可用结果。");
    return {
      verdict: data.verdict,
      action: data.action === "upgrade" || data.action === "extend" ? data.action : null,
      plan: typeof data.plan === "string" ? data.plan : "",
      durationDays: count(data.duration_days) || null,
      planExpiresAt: stringValue(data.plan_expires_at),
      retryAfter: retryAfterSeconds(data)
    };
  }

  async #requestLoginCode(email) {
    const normalizedEmail = normalizeEmail(email);
    const response = await this.#publicRequest("/auth/code", {
      method: "POST",
      body: JSON.stringify({ email: normalizedEmail })
    });
    if (!response.ok) {
      if (response.timedOut) throw httpError(504, "发送验证码超时，请稍后重试。");
      throw upstreamError(response.status, "无法发送验证码", response.data);
    }
    return { devCode: stringValue(response.data?.dev_code) };
  }

  async #verifyLoginAt(home, email, code) {
    const normalizedEmail = normalizeEmail(email);
    const normalizedCode = typeof code === "string" ? code.trim() : "";
    if (!normalizedCode || normalizedCode.length > 128) throw httpError(400, "请输入有效的验证码。");
    const response = await this.#publicRequest("/auth/verify", {
      method: "POST",
      body: JSON.stringify({ email: normalizedEmail, code: normalizedCode })
    });
    if (!response.ok || typeof response.data?.access_token !== "string" || !response.data.access_token) {
      throw upstreamError(response.status, "Mirasim 登录失败", response.data);
    }
    saveRefreshedAuth(home, response.data.access_token, response.data.refresh_token);
    const refreshed = await this.sessionRefresher?.refreshNow(home);
    return { updated: true, refreshed: refreshed === true };
  }

  #profileForKey(key) {
    const profile = readProfile(this.#homeForKey(key));
    if (!profile) throw httpError(409, "所选账号尚未登录或登录已过期。");
    return profile;
  }

  #homeForKey(key) {
    const index = keyIndex(key);
    if (index === null || index < 0 || index >= this.config.homes.length) throw httpError(404, "未找到所选账号。");
    return this.config.homes[index];
  }

  async #identity(profile) {
    const response = await this.#request("/auth/me", profile.token);
    const tokenPlan = jwtPlan(profile.token);
    // Current Mirasim tokens are opaque, so a failed /auth/me leaves no subscription date to
    // report; the field stays present so the console renders one shape either way.
    if (!response.ok) return tokenPlan ? { name: null, email: null, accountType: tokenPlan, tenant: null, subscriptionExpiresAt: null } : null;
    const data = response.data || {};
    // The rotation needs the plan too, and a sealed token cannot supply it.
    this.pool.observePlan(profile.home, stringValue(data.plan));
    return {
      name: stringValue(data.name),
      email: stringValue(data.email),
      accountType: accountTypeValue(data) || tokenPlan || roleValue(data.roles),
      tenant: stringValue(data.tenant),
      subscriptionExpiresAt: subscriptionExpiry(data) || subscriptionExpiry(tokenClaims(profile.token))
    };
  }

  async #referral(profile) {
    const response = await this.#request("/auth/referral", profile.token);
    return response.ok ? normalizeReferral(response.data) : null;
  }

  async #usage(profile, localUsage) {
    const summary = usageSummary(localUsage, this.pool.status().find((status) => status.home === profile.home));
    if (localUsage.calls.length === 0) return summary;

    const earliest = localUsage.calls[0].at;
    const ids = localUsage.calls.map((call) => encodeURIComponent(call.id)).join(",");
    const query = `?ids=${ids}&from=${encodeURIComponent(earliest)}&to=${encodeURIComponent(new Date().toISOString())}`;
    const response = await this.#relayRequest(`/usage/calls${query}`, profile);
    if (!response.ok || !Array.isArray(response.data?.calls)) return summary;

    const accumulated = this.usage.recordCallUsage(profile.home, response.data.calls);
    return { ...usageSummary(accumulated, this.pool.status().find((status) => status.home === profile.home)), source: "relay" };
  }

  async #limits(profile) {
    // x-mirasim-probe marks the read as a metering query rather than traffic, the way the
    // official client reads its own quota. A 404/405 means this relay has no limits endpoint at
    // all, which is an absence rather than a failure: nothing to retry and nothing to report.
    const read = (current) => this.#relayRequest("/v1/limits", current, { headers: { "x-mirasim-probe": "usage" } });
    let response = await read(profile);
    if (response.status === 404 || response.status === 405) return null;
    // A background renewal may have replaced the token after this snapshot read the profile, so a
    // 401 on the old one is answered with the stored token before any new renewal is spent.
    if (response.status === 401) {
      const stored = readProfile(profile.home);
      if (stored?.token && stored.token !== profile.token) {
        profile = stored;
        response = await read(profile);
        if (response.status === 404 || response.status === 405) return null;
      }
    }
    const valid = (result) => result.ok && Array.isArray(result.data?.windows ?? result.data?.data?.windows);
    if (!valid(response) && ![403, 429].includes(response.status) && await this.#refreshQuotaCredentials(profile)) {
      response = await read(readProfile(profile.home) || profile);
    }
    if (response.status === 404 || response.status === 405) return null;
    if (!response.ok) throw upstreamError(response.status, "读取账户额度失败；已按限频策略尝试刷新登录态", response.data);
    if (!valid(response)) throw httpError(502, "额度数据不完整；刷新登录态不能补充余额或恢复空间权限。");
    return response.data;
  }

  async #request(path, token, options = {}) {
    return this.#authenticatedRequest(this.config.loginUrl, path, token, options);
  }

  async #relayRequest(path, profile, options = {}) {
    const { agent = null, accept = "application/json", headers: meta = {}, ...requestOptions } = options;
    if (!this.relaySessions) {
      return this.#authenticatedRequest(this.config.relayUrl, path, profile.token, {
        ...requestOptions,
        headers: { Accept: accept, ...(agent ? { "x-mirasim-agent": agent } : {}), ...meta }
      });
    }
    const body = requestOptions.body || "";
    const headers = await this.relaySessions.headersFor(profile, {
      method: requestOptions.method || "GET",
      path,
      body,
      accept,
      contentType: requestOptions.body ? "application/json" : "",
      agent,
      meta
    });
    return this.#authenticatedRequest(this.config.relayUrl, path, profile.token, { ...requestOptions, authenticatedHeaders: headers });
  }

  async #authenticatedRequest(baseUrl, path, token, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? AUTH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(new URL(path, `${baseUrl}/`), {
        ...options,
        headers: options.authenticatedHeaders || {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "x-mirasim-token": token,
          "x-mirasim-client": this.config.clientVersion || MIRASIM_CLIENT_VERSION,
          "x-mirasim-call": `dashboard-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          // Last, so a caller can add headers of its own — until now they were built and then
          // silently dropped, because this block replaced options.headers outright.
          ...options.headers
        },
        signal: controller.signal,
        redirect: "error"
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        // The dashboard does not expose upstream response text.
      }
      return { ok: response.ok, status: response.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  async #publicRequest(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(new URL(path, `${this.config.loginUrl}/`), {
        ...options,
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {})
        },
        signal: controller.signal,
        redirect: "error"
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        // The dashboard does not expose upstream response text.
      }
      return { ok: response.ok, status: response.status, data };
    } catch {
      return { ok: false, status: 0, data: null, timedOut: controller.signal.aborted };
    } finally {
      clearTimeout(timer);
    }
  }
}

function validImportedSetting(setting) {
  return Boolean(setting && typeof setting === "object" && !Array.isArray(setting)
    && setting.auth && typeof setting.auth === "object"
    && typeof setting.auth.token === "string" && setting.auth.token.trim());
}

function accountIdentity(home) {
  try {
    const setting = JSON.parse(readFileSync(join(home, "setting.json"), "utf8"));
    const auth = setting?.auth;
    if (!auth || typeof auth !== "object") return null;
    return typeof auth.userId === "string" && auth.userId.trim()
      ? `id:${auth.userId.trim()}`
      : typeof auth.token === "string" && auth.token.trim() ? `token:${auth.token.trim()}` : null;
  } catch {
    return null;
  }
}

// /auth/referral answers with a flat snake_case payload; every counter defaults to 0 when absent.
function normalizeReferral(data) {
  const value = data && typeof data === "object" ? data : {};
  const referral = {
    code: stringValue(value.code),
    redeemed: count(value.redeemed),
    threshold: count(value.threshold),
    remaining: count(value.remaining),
    reached: value.reached === true,
    maxRedemptions: count(value.max_redemptions),
    currentPlan: stringValue(value.current_plan),
    nextPlan: stringValue(value.next_plan)
  };
  return { ...referral, rewardPlan: rewardPlan(referral), needed: invitesNeeded(referral) };
}

// A reward only exists once a threshold does: the next tier while it is unmet, the current
// tier once it has been reached.
function rewardPlan(referral) {
  if (referral.threshold <= 0) return null;
  return referral.nextPlan || (referral.reached ? referral.currentPlan : null);
}

function invitesNeeded(referral) {
  return referral.reached ? 0 : Math.max(0, referral.threshold - referral.redeemed);
}

// The relay reports each window as a pair of absolute numbers — `{ name, used, budget }` — and
// leaves the percentage to the client. There is no `limit`, `total` or `utilization` field to
// read, which is why the console had no numbers to show. A window whose budget is not a positive
// number carries no usable figure and is dropped rather than rendered as 0%, which would read as
// plenty of quota left.
function normalizeLimitWindows(data) {
  const source = data?.windows ?? data?.data?.windows;
  if (!Array.isArray(source)) return [];
  return source.flatMap((value) => {
    const item = value && typeof value === "object" ? value : {};
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const budget = Number(item.budget);
    const used = Number(item.used);
    if (!name || item.budget === null || item.budget === undefined || item.budget === "" || item.used === null || item.used === undefined || item.used === "" || !Number.isFinite(budget) || budget <= 0 || !Number.isFinite(used) || used < 0) return [];
    const usedPercent = usedPercentOf(used, budget);
    return [{
      name,
      limit: budget,
      used,
      remaining: Math.max(0, budget - used),
      usedPercent,
      remainingPercent: Math.max(0, Math.round((100 - usedPercent) * 10) / 10),
      status: windowStatus(usedPercent),
      modelScoped: item.model_scoped === true,
      resetAt: resetAtIso(item.reset_at)
    }];
  });
}

// The 80% warning line. The rest of the arithmetic — a tenth of a percent, and 99% up counting as
// spent — lives with the rotation in pool.js, which decides on the same numbers the console shows.
function windowStatus(usedPercent) {
  return usedPercent >= 100 ? "limit_reached" : usedPercent >= 80 ? "warning" : "allowed";
}

// reset_at is a whole-second epoch; 0 means the window has no scheduled reset.
function resetAtIso(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

// The account's headline figure is its most binding window, and a model-scoped window is not
// binding on the account: filling up `7d_fable` only stops fable, while everything else keeps
// running. So the scoped windows are set aside unless they are all there is — otherwise one
// exhausted per-model budget would report a perfectly usable account as spent.
function limitSummary(windows) {
  if (windows.length === 0) return { windows, limitStatus: null, remainingPercent: null };
  const unscoped = windows.filter((window) => !window.modelScoped);
  const binding = unscoped.length > 0 ? unscoped : windows;
  const limitStatus = binding.some((window) => window.status === "limit_reached") ? "limit_reached"
    : binding.some((window) => window.status === "warning") ? "warning" : "allowed";
  return { windows, limitStatus, remainingPercent: Math.min(...binding.map((window) => window.remainingPercent)) };
}

function subscriptionExpiry(data) {
  // /auth/me reports the subscription end as plan_exp, in whole seconds, and uses null for an
  // account that never expires. The rest are shapes other Mirasim endpoints have used.
  const value = firstValue(data?.subscription_expires_at, data?.subscriptionExpiresAt, data?.plan_exp, data?.planExp, data?.plan_expires_at, data?.planExpiresAt, data?.expires_at, data?.expiresAt, data?.renewal_date, data?.renewalDate, data?.membership?.expiresAt, data?.subscription?.expiresAt);
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

const FIELD_LABELS = { campaign: "邀请链接", usage: "用量", limits: "额度窗口" };

function snapshotWarning(field, error) {
  const upstreamStatus = Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus : 0;
  const retryAfterMs = Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0;
  const deviceSession = error?.name === "MirasimRelaySessionError";
  const message = deviceSession
    ? `上游设备会话暂不可用${upstreamStatus ? `（HTTP ${upstreamStatus}）` : ""}，${upstreamStatus === 401 || upstreamStatus === 403 ? "请检查登录状态" : retryAfterMs ? `约 ${Math.ceil(retryAfterMs / 60_000)} 分钟后可重试` : "请稍后重试"}。`
    : `部分上游数据同步失败（${FIELD_LABELS[field] || field}${upstreamStatus ? `，HTTP ${upstreamStatus}` : error?.name === "TimeoutError" || error?.name === "AbortError" ? "，超时" : ""}），账号及本地用量仍保留。`;
  if (!deviceSession) console.warn(`dashboard sync failed: ${field} status=${upstreamStatus || "none"} ${error?.name || ""} ${String(error?.message || "").slice(0, 200)}`);
  return { field, upstreamStatus, retryAfterMs, message };
}

function usageSummary(usage, status) {
  return {
    source: "local",
    availability: !status?.loggedIn
      ? "signed_out"
      : status.disabled ? "disabled" : status.funded === false ? "no_quota" : status.healthy ? "available" : "cooling",
    requests: usage.requests,
    failures: usage.failures,
    lastAt: usage.lastAt,
    lastStatus: usage.lastStatus,
    lastCongested: Boolean(usage.lastCongested),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens
  };
}

function jwtPlan(token) {
  const data = tokenClaims(token);
  return firstPlanValue(data.plan, data.plan_name, data.planName, data.account_type, data.accountType, data.subscription, data.membership) || null;
}

function normalizePlanId(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function planLabel(value) {
  return PLAN_LABELS[normalizePlanId(value)] || stringValue(value) || "未知档位";
}

function isLicenseCode(value) {
  return String(value || "").toUpperCase().replace(/[\s\-_]/g, "").startsWith(LICENSE_CODE_PREFIX);
}

function normalizeRedeemCode(value) {
  const code = typeof value === "string" ? value.trim() : "";
  if (!code || code.length > 128) throw httpError(400, "请输入有效的邀请码或授权码。");
  return code;
}

function retryAfterSeconds(data) {
  const seconds = Number(data?.retry_after);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

function normalizeEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw httpError(400, "请输入有效的邮箱地址。");
  }
  return email;
}

function normalizeUrl(value, label) {
  try {
    const url = new URL(stringValue(value) || "");
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid");
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw httpError(400, `请输入有效的${label}。`);
  }
}

function normalizeMoeMailDomains(value) {
  const domains = [...new Set(String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (domains.length === 0 || domains.some((domain) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain))) {
    throw httpError(400, "请输入有效的 MoeMail 邮箱域名，可用逗号分隔多个域名。");
  }
  return domains;
}

function normalizeMoeMailBatchSize(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_MOEMAIL_BATCH_SIZE) {
    throw httpError(400, `注册数量必须是 1 到 ${MAX_MOEMAIL_BATCH_SIZE} 之间的整数。`);
  }
  return count;
}

function accountKey(index) {
  return `account-${index + 1}`;
}

function keyIndex(key) {
  const match = /^account-(\d+)$/.exec(key || "");
  return match ? Number(match[1]) - 1 : null;
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function planValue(value) {
  if (typeof value === "string") return stringValue(value);
  if (!value || typeof value !== "object") return null;
  return stringValue(firstValue(
    value.name, value.label, value.type, value.tier, value.level,
    value.plan_name, value.planName, value.plan_type, value.planType,
    value.account_type, value.accountType, value.subscription_type, value.subscriptionType
  ));
}

function accountTypeValue(data) {
  const membership = objectValue(data.membership) || objectValue(data.member) || {};
  const subscription = objectValue(data.subscription) || objectValue(data.subscription_info) || {};
  const account = objectValue(data.account) || objectValue(data.profile) || {};
  return firstPlanValue(
    data.plan, data.plan_name, data.planName, data.account_type, data.accountType,
    data.subscription, data.subscription_type, data.subscriptionType,
    membership.plan, membership, subscription.plan, subscription, account.plan, account
  );
}

function firstPlanValue(...values) {
  for (const value of values) {
    const plan = planValue(value);
    if (plan) return plan;
  }
  return null;
}

function roleValue(value) {
  if (!Array.isArray(value)) return null;
  const roles = value.filter((role) => typeof role === "string").map((role) => role.trim().toLowerCase());
  if (roles.includes("admin")) return "管理员";
  if (roles.includes("member")) return "会员用户";
  if (roles.includes("user")) return "普通用户";
  return stringValue(value.find((role) => typeof role === "string"));
}


function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function upstreamError(status, action, data) {
  const detail = upstreamDetail(data);
  if (status === 401) return httpError(401, detail || "Mirasim 登录已失效，请重新登录。");
  if (status === 409) return httpError(409, detail || `${action}：当前活动状态不允许此操作。`);
  if (status === 429) {
    const retryAfter = retryAfterSeconds(data);
    return httpError(429, detail || `${action}：请求过于频繁${retryAfter ? `，请 ${retryAfter} 秒后重试` : ""}。`);
  }
  if (status >= 400 && status < 500) return httpError(status, detail || `${action}：Mirasim 拒绝了该请求。`);
  if (status === 503) return httpError(503, detail || `${action}：Mirasim 暂时关闭了该功能。`);
  if (detail) return httpError(502, detail);
  return httpError(502, `${action}：Mirasim 暂时未返回可用结果。`);
}

function upstreamDetail(data) {
  const error = data?.error;
  const detail = data?.detail;
  const candidates = [
    detail,
    data?.message,
    data?.msg,
    typeof error === "object" && error ? error.detail : error,
    typeof error === "object" && error ? error.message : null,
    Array.isArray(detail) ? detail.find((item) => typeof item?.msg === "string")?.msg : null
  ];
  const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  const detailText = value?.trim().slice(0, 300) || null;
  return detailText ? UPSTREAM_DETAILS.get(detailText.toLowerCase()) || detailText : null;
}
