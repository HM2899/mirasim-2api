import { randomBytes } from "node:crypto";

export class MoeMailClient {
  constructor(config = {}, { fetchImpl = fetch, sleep = delay } = {}) {
    this.url = config.url || "";
    this.apiKey = config.apiKey || "";
    this.domain = config.domain || "";
    this.expiryTimeMs = config.expiryTimeMs || 3_600_000;
    this.codeTimeoutMs = config.codeTimeoutMs || 120_000;
    this.pollMs = config.pollMs || 2_500;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  isConfigured() {
    return Boolean(this.url && this.apiKey && this.domain);
  }

  async createMailbox() {
    this.#requireConfiguration();
    const data = await this.#request("/api/emails/generate", {
      method: "POST",
      body: JSON.stringify({
        name: `mirasim-${randomBytes(6).toString("hex")}`,
        expiryTime: this.expiryTimeMs,
        domain: this.domain
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
