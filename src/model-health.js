import { randomUUID } from "node:crypto";

const DEFAULT_INTERVAL_MS = 30 * 60_000;
const DEFAULT_TIMEOUT_MS = 12_000;

export class MirasimModelHealth {
  #running = null;
  #discovering = null;
  #timer = null;
  #state;

  constructor(config, pool, { fetchImpl = fetch, sessionRefresher = null, database = null, now = () => Date.now() } = {}) {
    this.config = config;
    this.pool = pool;
    this.fetchImpl = fetchImpl;
    this.sessionRefresher = sessionRefresher;
    this.database = database;
    this.now = now;
    this.intervalMs = positiveNumber(config.modelHealthIntervalMs, DEFAULT_INTERVAL_MS);
    this.timeoutMs = positiveNumber(config.modelHealthTimeoutMs, DEFAULT_TIMEOUT_MS);
    const saved = database?.getModelHealth?.();
    this.#state = {
      discovering: false,
      running: false,
      intervalMs: this.intervalMs,
      activeModelId: null,
      lastDiscoveredAt: saved?.lastDiscoveredAt || null,
      lastStartedAt: saved?.lastStartedAt || null,
      lastFinishedAt: saved?.lastFinishedAt || null,
      lastError: saved?.lastError || null,
      models: savedModels(saved?.models)
    };
  }

  start() {
    if (this.#timer) return;
    // Discovery is cheap and makes the model directory visible before any probe is sent.
    void this.discover();
    this.#timer = setInterval(() => void this.run(), this.intervalMs);
    this.#timer.unref?.();
  }

  stop() {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  snapshot() {
    return { ...this.#state, models: this.#state.models.map((model) => ({ ...model })) };
  }

  async discover() {
    if (this.#discovering) return this.#discovering;
    const task = this.#discover().finally(() => { this.#discovering = null; });
    this.#discovering = task;
    return task;
  }

  async run() {
    if (this.#running) return this.#running;
    const task = this.#run().finally(() => { this.#running = null; });
    this.#running = task;
    return task;
  }

  async #discover() {
    this.#state = { ...this.#state, discovering: true, lastError: null };
    try {
      await this.sessionRefresher?.refreshAll(this.config.homes);
      const ids = await this.#discoverModels();
      const previous = new Map(this.#state.models.map((model) => [model.id, model]));
      this.#state = {
        ...this.#state,
        discovering: false,
        lastDiscoveredAt: new Date(this.now()).toISOString(),
        models: ids.map((id) => previous.get(id) || pendingResult(id))
      };
      this.#persist();
      return ids;
    } catch (error) {
      this.#state = { ...this.#state, discovering: false, lastError: error?.message || "无法获取模型目录。" };
      this.#persist();
      throw error;
    }
  }

  async #run() {
    this.#state = { ...this.#state, running: true, lastStartedAt: new Date(this.now()).toISOString(), lastError: null };
    try {
      const modelIds = await this.discover();
      // One request at a time prevents a health pass from creating a rate-limit burst.
      for (const id of modelIds) {
        this.#state = { ...this.#state, activeModelId: id };
        const checked = await this.#probe(id);
        this.#state = { ...this.#state, models: this.#state.models.map((model) => model.id === id ? checked : model) };
        this.#persist();
      }
      this.#state = { ...this.#state, running: false, activeModelId: null, lastFinishedAt: new Date(this.now()).toISOString() };
    } catch (error) {
      this.#state = {
        ...this.#state,
        running: false,
        activeModelId: null,
        lastFinishedAt: new Date(this.now()).toISOString(),
        lastError: error?.message || "模型健康检测未完成。"
      };
    }
    this.#persist();
    return this.snapshot();
  }

  #persist() {
    this.database?.saveModelHealth?.({
      ...this.#state,
      discovering: false,
      running: false,
      activeModelId: null,
      models: this.#state.models.map((model) => ({ ...model }))
    });
  }

  async #discoverModels() {
    const profile = this.pool.pick();
    if (!profile) throw new Error("没有可用的已登录账号，无法获取模型列表。");
    const response = await this.#request("/v1/models", { method: "GET", headers: healthHeaders(profile.token) });
    if (!response.ok) throw new Error(`上游模型列表请求失败（HTTP ${response.status}）。`);
    const body = await response.json().catch(() => null);
    const discovered = Array.isArray(body?.data)
      ? body.data.map((item) => typeof item?.id === "string" ? item.id.trim() : "").filter(callableModelId)
      : [];
    const configured = Array.isArray(this.config.models) ? this.config.models.filter(callableModelId) : [];
    return [...new Set([...discovered, ...configured])].sort((left, right) => left.localeCompare(right));
  }

  async #probe(id) {
    const checkedAt = new Date(this.now()).toISOString();
    const startedAt = this.now();
    const profile = this.pool.pick();
    if (!profile) return result(id, "unavailable", checkedAt, this.now() - startedAt, 0, "没有可用的已登录账号。");
    try {
      const response = await this.#request("/v1/chat/completions", {
        method: "POST",
        headers: healthHeaders(profile.token),
        body: JSON.stringify({ model: id, messages: [{ role: "user", content: "Reply exactly OK." }], max_tokens: 1, temperature: 0, stream: false })
      });
      const latencyMs = this.now() - startedAt;
      if (response.ok) return result(id, "healthy", checkedAt, latencyMs, response.status, "可正常响应。");
      const data = await response.json().catch(() => null);
      return result(id, stateForStatus(response.status), checkedAt, latencyMs, response.status, errorMessage(data, response.status));
    } catch (error) {
      return result(id, "unavailable", checkedAt, this.now() - startedAt, 0, error?.name === "AbortError" ? "检测超时。" : "网络请求失败。");
    }
  }

  async #request(path, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(new URL(path, `${this.config.relayUrl}/`), { ...options, signal: controller.signal, redirect: "error" });
    } finally {
      clearTimeout(timer);
    }
  }
}

function healthHeaders(token) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-mirasim-client": "0.0.147",
    "x-mirasim-call": randomUUID(),
    Authorization: `Bearer ${token}`
  };
}

function pendingResult(id) {
  return result(id, "pending", null, null, null, "尚未检测。");
}

function result(id, status, checkedAt, latencyMs, httpStatus, message) {
  return { id, status, checkedAt, latencyMs: Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null, httpStatus, message };
}

function stateForStatus(status) {
  if (status === 429) return "limited";
  if (status === 401 || status === 403) return "unauthorized";
  return "unavailable";
}

function errorMessage(data, status) {
  const message = data?.error?.message || data?.message || data?.detail;
  return typeof message === "string" && message.trim() ? message.trim().slice(0, 240) : `上游返回 HTTP ${status}。`;
}

function positiveNumber(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function callableModelId(value) {
  return typeof value === "string" && value.trim() !== "" && value.trim() !== "*";
}

function savedModels(models) {
  if (!Array.isArray(models)) return [];
  return models.flatMap((model) => {
    if (!model || typeof model.id !== "string" || !callableModelId(model.id)) return [];
    const status = typeof model.status === "string" ? model.status : "pending";
    return [result(model.id.trim(), status, typeof model.checkedAt === "string" ? model.checkedAt : null,
      Number.isFinite(model.latencyMs) ? model.latencyMs : null,
      Number.isInteger(model.httpStatus) ? model.httpStatus : null,
      typeof model.message === "string" ? model.message : "尚未检测。")];
  });
}
