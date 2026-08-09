import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readProfile } from "./pool.js";
import { MoeMailClient } from "./moemail.js";
import { saveRefreshedAuth } from "./session-refresh.js";

const AUTH_TIMEOUT_MS = 12_000;
const LOGIN_TIMEOUT_MS = 45_000;
const MAX_USAGE_CALL_IDS = 100;
const MAX_MOEMAIL_BATCH_SIZE = 5;

export class RelayUsageLedger {
  #entries = new Map();

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
  }

  failure(profile) {
    const entry = this.#entry(profile.home);
    entry.failures += 1;
    entry.lastAt = new Date().toISOString();
    entry.lastStatus = 0;
  }

  snapshot(home) {
    const entry = this.#entry(home);
    return {
      requests: entry.requests,
      failures: entry.failures,
      lastAt: entry.lastAt,
      lastStatus: entry.lastStatus,
      calls: [...entry.calls]
    };
  }

  #entry(home) {
    let entry = this.#entries.get(home);
    if (!entry) {
      entry = { requests: 0, failures: 0, lastAt: null, lastStatus: null, calls: [] };
      this.#entries.set(home, entry);
    }
    return entry;
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
        cooldownUntil: status?.cooldownUntil || null,
        identity: null,
        referral: null,
        quota: usageSummary(usage, status)
      };
      if (!profile) return account;

      const [identity, referral, quota] = await Promise.all([
        this.#identity(profile),
        this.#referral(profile),
        this.#usage(profile, usage)
      ]);
      return { ...account, identity, referral, quota };
    }));

    return {
      generatedAt: new Date().toISOString(),
      relay: new URL(this.config.relayUrl).host,
      accounts
    };
  }

  async createReferral(key) {
    const profile = this.#profileForKey(key);
    const response = await this.#request("/auth/referral", profile.token, { method: "POST" });
    if (!response.ok) throw upstreamError(response.status, "无法创建邀请码", response.data);
    return normalizeReferral(response.data);
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

  async restoreAccounts() {
    if (!this.database) throw httpError(501, "当前账户池未启用持久化存储。");
    let entries;
    try {
      entries = readdirSync(this.config.accountRoot, { withFileTypes: true });
    } catch {
      return { restored: 0, accounts: [] };
    }
    const known = new Set(this.config.homes);
    const homes = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("account-"))
      .map((entry) => join(this.config.accountRoot, entry.name))
      .filter((home) => !known.has(home) && existsSync(join(home, "setting.json")));
    for (const home of homes) {
      this.database.addHome(home);
      this.pool.add(home);
    }
    this.config.homes = this.pool.homes();
    await this.sessionRefresher?.refreshAll(homes);
    return { restored: homes.length, accounts: homes.map((home) => accountKey(this.config.homes.indexOf(home))) };
  }

  async registerWithMoeMail(inviteCode) {
    if (!this.database) throw httpError(501, "当前账户池未启用持久化存储。");
    if (!this.moemail.isConfigured()) {
      throw httpError(501, "尚未配置 MoeMail：请设置 MOEMAIL_URL、MOEMAIL_API_KEY 和 MOEMAIL_DOMAIN。");
    }
    const normalizedCode = typeof inviteCode === "string" ? inviteCode.trim() : "";
    if (normalizedCode.length > 128) throw httpError(400, "请输入有效的邀请码。");

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
    for (let index = 0; index < requested; index += 1) {
      try {
        accounts.push(await this.registerWithMoeMail(inviteCode));
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
      domain: this.moemail.domain || ""
    };
  }

  configureMoeMail(input) {
    if (!this.database) throw httpError(501, "当前账户池未启用持久化存储。");
    const url = normalizeUrl(input?.url, "MoeMail 服务地址");
    const domain = normalizeMoeMailDomain(input?.domain);
    const submittedApiKey = stringValue(input?.apiKey);
    const apiKey = submittedApiKey || this.moemail.apiKey;
    if (!apiKey) throw httpError(400, "请填写 MoeMail API Key。");
    const config = {
      url,
      domain,
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

  async #redeemInviteAt(home, code) {
    const profile = readProfile(home);
    if (!profile) throw httpError(502, "Mirasim 登录态未能保存。");
    return this.#redeemInviteForProfile(profile, code);
  }

  async #redeemInviteForProfile(profile, code) {
    const normalizedCode = typeof code === "string" ? code.trim() : "";
    if (!normalizedCode || normalizedCode.length > 128) throw httpError(400, "请输入有效的邀请码。");
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
    return { updated: true };
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
    return { updated: true };
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
    if (!response.ok) return tokenPlan ? { name: null, email: null, accountType: tokenPlan, tenant: null } : null;
    const data = response.data || {};
    return {
      name: stringValue(data.name),
      email: stringValue(data.email),
      accountType: accountTypeValue(data) || tokenPlan || roleValue(data.roles),
      tenant: stringValue(data.tenant)
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

    const totals = response.data.calls.reduce((result, call) => ({
      inputTokens: result.inputTokens + count(call.input),
      outputTokens: result.outputTokens + count(call.output),
      cacheReadTokens: result.cacheReadTokens + count(call.cacheRead),
      cacheWriteTokens: result.cacheWriteTokens + count(call.cacheWrite)
    }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    return { ...summary, source: "relay", ...totals };
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

function normalizeReferral(data) {
  const value = referralValue(data);
  const activity = objectValue(value.activity) || objectValue(value.campaign) || objectValue(value.invitation) || {};
  const membership = objectValue(value.membership) || objectValue(value.member) || objectValue(value.subscription) || {};
  const redeemed = count(firstValue(value.redeemed, value.redeem_count, value.redemption_count, value.used, activity.redeemed, activity.used, activity.redeemed_count));
  const threshold = count(firstValue(value.threshold, value.target, value.invite_threshold, value.required_invites, activity.threshold, activity.target, activity.required));
  const maxRedemptions = count(firstValue(value.max_redemptions, value.maxRedemptions, value.max_redemption, value.max_invites, value.limit, activity.max_redemptions, activity.maxRedemptions, activity.limit, activity.total));
  const remainingValue = firstValue(value.remaining, value.remaining_redemptions, value.remaining_invites, value.left, activity.remaining, activity.remaining_redemptions, activity.left);
  return {
    code: stringValue(firstValue(value.code, value.referral_code, value.referralCode, value.invite_code, value.inviteCode)),
    redeemed,
    threshold,
    remaining: remainingValue === undefined ? Math.max(0, maxRedemptions - redeemed) : count(remainingValue),
    reached: firstValue(value.reached, value.is_reached, value.isReached) === true,
    maxRedemptions,
    currentPlan: firstPlanValue(
      value.current_plan, value.currentPlan, value.plan_name, value.planName, value.plan,
      value.account_type, value.accountType, membership.current_plan, membership.currentPlan,
      membership.plan_name, membership.planName, membership.plan, membership.tier, membership.level
    ),
    nextPlan: firstPlanValue(
      value.next_plan, value.nextPlan, value.next_plan_name, value.nextPlanName, value.next,
      membership.next_plan, membership.nextPlan, membership.next_plan_name, membership.nextPlanName,
      membership.next, activity.next_plan, activity.nextPlan
    )
  };
}

function referralValue(data) {
  const value = data && typeof data === "object" ? data : {};
  const envelope = objectValue(value.data) || objectValue(value.result) || value;
  return objectValue(envelope.referral) || objectValue(envelope.invite) || objectValue(envelope.referral_activity) || envelope;
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
    availability: status?.loggedIn ? (status.healthy ? "available" : "cooling") : "signed_out",
    requests: usage.requests,
    failures: usage.failures,
    lastAt: usage.lastAt,
    lastStatus: usage.lastStatus,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null
  };
}

function jwtPlan(token) {
  try {
    const payload = token.split(".")[1];
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return firstPlanValue(data.plan, data.plan_name, data.planName, data.account_type, data.accountType, data.subscription, data.membership);
  } catch {
    return null;
  }
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

function normalizeMoeMailDomain(value) {
  const domain = stringValue(value)?.toLowerCase() || "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    throw httpError(400, "请输入有效的 MoeMail 邮箱域名。");
  }
  return domain;
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
  if (status === 429) return httpError(429, detail || `${action}：请求过于频繁。`);
  if (status >= 400 && status < 500) return httpError(status, detail || `${action}：Mirasim 拒绝了该请求。`);
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
  return value?.trim().slice(0, 300) || null;
}
