import { randomBytes } from "node:crypto";

export class MoeMailClient {
  constructor(config = {}, { fetchImpl = fetch, sleep = delay } = {}) {
    this.url = config.url || "";
    this.apiKey = config.apiKey || "";
    this.domains = normalizedDomains(config.domains || config.domain);
    this.domain = this.domains[0] || "";
    this.domainIndex = 0;
    this.expiryTimeMs = config.expiryTimeMs || 3_600_000;
    this.codeTimeoutMs = config.codeTimeoutMs || 120_000;
    this.pollMs = config.pollMs || 2_500;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  isConfigured() {
    return Boolean(this.url && this.apiKey && this.domains.length > 0);
  }

  async createMailbox() {
    this.#requireConfiguration();
    const data = await this.#request("/api/emails/generate", {
      method: "POST",
      body: JSON.stringify({
        name: `mirasim-${randomBytes(6).toString("hex")}`,
        expiryTime: this.expiryTimeMs,
        domain: this.#nextDomain()
      })
    });
    const id = stringValue(data?.id);
    const email = stringValue(data?.email);
    if (!id || !validEmail(email)) throw new MoeMailError(502, "MoeMail 返回的邮箱信息无效。");
    return { id, email };
  }

  async waitForVerificationCode(mailbox) {
    this.#requireConfiguration();
    const deadline = Date.now() + this.codeTimeoutMs;
    while (Date.now() < deadline) {
      const data = await this.#request(`/api/emails/${encodeURIComponent(mailbox.id)}`);
      for (const message of Array.isArray(data?.messages) ? data.messages : []) {
        const code = verificationCode(message);
        if (code) return code;
      }
      await this.sleep(this.pollMs);
    }
    throw new MoeMailError(504, "等待 MoeMail 验证码超时。");
  }

  async deleteMailbox(mailbox) {
    if (!this.isConfigured() || !mailbox?.id) return;
    try {
      await this.#request(`/api/emails/${encodeURIComponent(mailbox.id)}`, { method: "DELETE" });
    } catch {
      // A temporary inbox can expire independently; cleanup must not hide a completed signup.
    }
  }

  async listDomains() {
    if (!this.url || !this.apiKey) throw new MoeMailError(501, "请先填写 MoeMail 服务地址和 API Key。");
    const data = await this.#request("/api/domains");
    const values = Array.isArray(data) ? data : Array.isArray(data?.domains) ? data.domains : Array.isArray(data?.data) ? data.data : Array.isArray(data?.items) ? data.items : [];
    const domains = normalizedDomains(values.map((value) => typeof value === "string" ? value : value?.domain || value?.name));
    if (domains.length === 0) throw new MoeMailError(502, "MoeMail 未返回可用邮箱域名。");
    return domains;
  }

  #nextDomain() {
    const domain = this.domains[this.domainIndex % this.domains.length];
    this.domainIndex = (this.domainIndex + 1) % this.domains.length;
    return domain;
  }

  async #request(path, options = {}) {
    let response;
    try {
      response = await this.fetchImpl(new URL(path, `${this.url}/`), {
        ...options,
        headers: {
          "X-API-Key": this.apiKey,
          ...(options.body ? { "Content-Type": "application/json" } : {})
        },
        redirect: "error"
      });
    } catch {
      throw new MoeMailError(502, "无法连接 MoeMail 服务。");
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new MoeMailError(response.status, providerMessage(data) || "MoeMail 请求失败。");
    return data;
  }

  #requireConfiguration() {
    if (!this.isConfigured()) throw new MoeMailError(501, "尚未配置 MoeMail：请设置 MOEMAIL_URL、MOEMAIL_API_KEY 和 MOEMAIL_DOMAIN。");
  }
}

export class MoeMailError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function verificationCode(message) {
  const text = [message?.subject, message?.content, message?.html]
    .filter((value) => typeof value === "string")
    .join("\n");
  const labeled = /(?:verification\s*code|verify\s*code|验证码|校验码|code)\D{0,32}(\d{4,8})/i.exec(text);
  return labeled?.[1] || null;
}

function providerMessage(data) {
  if (!data || typeof data !== "object") return null;
  return stringValue(data.error) || stringValue(data.message) || stringValue(data.detail);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validEmail(value) {
  return Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
}

function normalizedDomains(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(values.map((item) => String(item || "").trim().toLowerCase()).filter((item) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(item)))];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
