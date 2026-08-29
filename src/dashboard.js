import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PRIORITY_RANGE, hasRelayQuota, normalizePriority, readProfile, tokenClaims } from "./pool.js";
import { MoeMailClient } from "./moemail.js";
import { saveRefreshedAuth } from "./session-refresh.js";

const AUTH_TIMEOUT_MS = 12_000;
const LOGIN_TIMEOUT_MS = 45_000;
const MAX_USAGE_CALL_IDS = 100;
const MAX_MOEMAIL_BATCH_SIZE = 5;
const MAX_ACCOUNT_IMPORT_SIZE = 100;
const LICENSE_CODE_PREFIX = "MLIC";
const LICENSE_VERDICTS = new Set(["redeemable", "already_redeemed", "blocked_lower_tier"]);
// Mirasim's own plan ladder: none < basic < plus < max, with enterprise sharing the top tier.
const PLAN_RANKS = { none: 0, free: 0, basic: 1, plus: 2, max: 3, enterprise: 3, internal: 3 };
const PLAN_LABELS = { none: "FREE", free: "FREE", basic: "MAX 2X", plus: "MAX 10X", max: "MAX 40X", enterprise: "企业版", internal: "内部账号" };
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

  record(profile, upstream) {
    const entry = this.#entry(profile.home);
    entry.requests += 1;
    entry.lastAt = new Date().toISOString();
    entry.lastStatus = upstream.status;
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
    this.#persist(profile.home, entry);
  }

  snapshot(home) {
    const entry = this.#entry(home);
    return {
      requests: entry.requests,
      failures: entry.failures,
      lastAt: entry.lastAt,
      lastStatus: entry.lastStatus,
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
  constructor(config, pool, usage, { fetchImpl = fetch, database = null, moemail = null, sessionRefresher = null } = {}) {
    this.config = config;
    this.pool = pool;
    this.usage = usage;
    this.fetchImpl = fetchImpl;
    this.database = database;
    this.sessionRefresher = sessionRefresher;
    const savedMoeMail = database?.getMoeMailConfig(config.webAuth?.password);
    const configuredByEnvironment = Boolean(config.moemail?.url || config.moemail?.apiKey || config.moemail?.domain);
    if (!configuredByEnvironment && savedMoeMail) this.config.moemail = { ...config.moemail, ...savedMoeMail };
    this.moemail = moemail || new MoeMailClient(this.config.moemail, { fetchImpl });
  }

  async snapshot() {
    await this.sessionRefresher?.refreshAll(this.config.homes);
    const statuses = new Map(this.pool.status().map((status) => [status.home, status]));
    const accounts = await Promise.all(this.config.homes.map(async (home, index) => {
      const status = statuses.get(home);
      const profile = readProfile(home);
      const usage = this.usage.snapshot(home);
      const account = {
        key: accountKey(index),
        id: profile?.id || status?.id || `account-${index + 1}`,
        loggedIn: Boolean(profile),
        healthy: Boolean(status?.healthy),
        disabled: Boolean(status?.disabled),
        cooldownUntil: status?.cooldownUntil || null,
        priority: status?.priority ?? null,
        priorityOverride: status?.priorityOverride ?? null,
        identity: null,
        referral: null,
        quota: usageSummary(usage, status)
      };
      if (!profile) return account;

      // /auth/me is awaited on its own because it is the only source of the plan for a sealed
      // token, and the calls below have to know whether this account is funded.
      const identity = await this.#identity(profile);
      const planned = this.pool.profile(home) || profile;
      const planStatus = this.pool.status().find((item) => item.home === home) || status;
      const [referral, quota, limits] = await Promise.all([
        this.#referral(profile),
        this.#usage(planned, usage),
        // A free account's limit windows advertise a budget the relay refuses to honour, so the
        // console is not given numbers that look like usable quota.
        hasRelayQuota(planned) ? this.#limits(profile) : null
      ]);
      return {
        ...account,
        healthy: Boolean(planStatus?.healthy),
        priority: planStatus?.priority ?? null,
        priorityOverride: planStatus?.priorityOverride ?? null,
        identity,
        referral,
        quota: { ...quota, windows: normalizeLimitWindows(limits) }
      };
    }));

    return {
      generatedAt: new Date().toISOString(),
      relay: new URL(this.config.relayUrl).host,
      accounts
    };
  }

  // The desktop client always POSTs and shows the returned referral. Mirasim can pause creation
  // while still serving an already issued code, so a refused create falls back to reading it.
  async createReferral(key) {
    const profile = this.#profileForKey(key);
    const response = await this.#request("/auth/referral", profile.token, { method: "POST" });
    const created = response.ok ? normalizeReferral(response.data) : null;
    if (created?.code) return created;

    const existing = await this.#referral(profile);
    if (existing?.code) return existing;
    if (!response.ok) throw upstreamError(response.status, "无法创建邀请码", response.data);
    return existing || created;
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

  // Only a paid account can invite, and its code stops working once its redemptions run out,
  // so candidates are filtered on both and the highest tier gets to invite first.
  async #registrationInviteCode(inviteCode) {
    const supplied = typeof inviteCode === "string" ? inviteCode.trim() : "";
    if (supplied.length > 128) throw httpError(400, "请输入有效的邀请码或授权码。");
    if (supplied) return supplied;

    const candidates = [];
    for (const [index, home] of this.config.homes.entries()) {
      const profile = readProfile(home);
      if (!profile) continue;
      let referral;
      try {
        referral = await this.#referral(profile);
      } catch {
        // A stale account must not prevent trying another eligible account.
        continue;
      }
      const rank = planRank(referral?.currentPlan || jwtPlan(profile.token));
      if (rank <= 0) continue;
      if (referral && !hasInviteCapacity(referral)) continue;
      candidates.push({ index, rank, referral });
    }
    candidates.sort((left, right) => right.rank - left.rank || left.index - right.index);

    const issued = candidates.find((candidate) => candidate.referral?.code);
    if (issued) return issued.referral.code;

    for (const candidate of candidates) {
      try {
        const created = await this.createReferral(accountKey(candidate.index));
        if (created?.code) return created.code;
      } catch (error) {
        // Mirasim pauses creation service-wide, so the remaining accounts cannot help either.
        if (error?.statusCode === 503) break;
      }
    }
    return "";
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
    if (index === null || index >= this.config.homes.length) throw httpError(404, "未找到所选账号。");
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
    const response = await this.#relayRequest(`/usage/calls${query}`, profile.token);
    if (!response.ok || !Array.isArray(response.data?.calls)) return summary;

    const accumulated = this.usage.recordCallUsage(profile.home, response.data.calls);
    return { ...usageSummary(accumulated, this.pool.status().find((status) => status.home === profile.home)), source: "relay" };
  }

  async #limits(profile) {
    const response = await this.#relayRequest("/v1/limits", profile.token);
    return response.ok ? response.data : null;
  }

  async #request(path, token, options = {}) {
    return this.#authenticatedRequest(this.config.loginUrl, path, token, options);
  }

  async #relayRequest(path, token, options = {}) {
    return this.#authenticatedRequest(this.config.relayUrl, path, token, options);
  }

  async #authenticatedRequest(baseUrl, path, token, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(new URL(path, `${baseUrl}/`), {
        ...options,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "x-mirasim-token": token,
          "x-mirasim-client": this.config.clientVersion || "0.0.239",
          "x-mirasim-call": `dashboard-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// max_redemptions is how often the code itself may still be redeemed, which is unrelated to
// the invite threshold; 0 means the upstream did not report a cap.
function hasInviteCapacity(referral) {
  return referral.maxRedemptions <= 0 || referral.remaining > 0;
}

function normalizeLimitWindows(data) {
  const source = data?.windows || data?.limits || data?.data?.windows || data?.data?.limits;
  if (!source || typeof source !== "object") return [];
  const entries = Array.isArray(source) ? source.map((value, index) => [value?.name || value?.window || value?.period || `${value?.hours || index}h`, value]) : Object.entries(source);
  return entries.map(([name, value]) => {
    const item = value && typeof value === "object" ? value : {};
    const limit = Number(item.limit ?? item.total ?? item.max ?? item.quota ?? item.input_limit);
    const remaining = Number(item.remaining ?? item.left ?? item.available ?? item.remaining_tokens);
    const used = Number(item.used ?? item.used_tokens ?? item.consumed ?? item.usage);
    const remainingPercent = Number(item.remainingPercent ?? item.remaining_percentage ?? item.remaining_percent);
    const utilization = Number(item.utilization ?? item.utilizationPercent ?? item.percentage ?? item.usedPercent);
    return { name: String(name), limit: Number.isFinite(limit) ? limit : null, remaining: Number.isFinite(remaining) ? remaining : null, used: Number.isFinite(used) ? used : null, remainingPercent: Number.isFinite(remainingPercent) ? remainingPercent : (Number.isFinite(utilization) ? Math.max(0, 100 - utilization) : null), resetAt: item.resetAt || item.reset_at || item.resetsAt || null };
  });
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

function planRank(value) {
  const plan = normalizePlanId(value);
  if (!plan) return 0;
  return PLAN_RANKS[plan] ?? 1;
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
