const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 12_000;

export class MirasimModelHealth {
  #running = null;
  #discovering = null;
  #timer = null;
  #state;

  constructor(config, pool, { fetchImpl = fetch, sessionRefresher = null, relaySessions = null, database = null, now = () => Date.now() } = {}) {
    this.config = config;
    this.pool = pool;
    this.fetchImpl = fetchImpl;
    this.sessionRefresher = sessionRefresher;
    this.relaySessions = relaySessions;
    this.database = database;
    this.now = now;
    this.scanIntervalMs = positiveNumber(config.modelHealthIntervalMs, DEFAULT_SCAN_INTERVAL_MS);
    this.timeoutMs = positiveNumber(config.modelHealthTimeoutMs, DEFAULT_TIMEOUT_MS);
    const saved = database?.getModelHealth?.();
    this.#state = {
      discovering: false,
      running: false,
      scanIntervalMs: this.scanIntervalMs,
      activeModelId: null,
      nextScanIndex: Number.isInteger(saved?.nextScanIndex) && saved.nextScanIndex >= 0 ? saved.nextScanIndex : 0,
      lastDiscoveredAt: saved?.lastDiscoveredAt || null,
      lastStartedAt: saved?.lastStartedAt || null,
      lastFinishedAt: saved?.lastFinishedAt || null,
      lastError: saved?.lastError || null,
      models: savedModels(saved?.models)
    };
  }

  start() {
    if (this.#timer) return;
    void this.discover().catch(() => {});
    this.#timer = setInterval(() => void this.scanNext().catch(() => {}), this.scanIntervalMs);
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

  async current() {
    if (this.#state.models.length === 0 && !this.#state.discovering) {
      await this.discover().catch(() => {});
    }
    return this.snapshot();
  }

  async discover() {
    if (this.#discovering) return this.#discovering;
    const task = this.#discover().finally(() => { this.#discovering = null; });
    this.#discovering = task;
    return task;
  }

  async runOne(id) {
    const modelId = typeof id === "string" ? id.trim() : "";
    if (!modelId) throw requestError(400, "缺少模型标识。");
    if (this.#running) throw requestError(409, `正在检测 ${this.#state.activeModelId || "其他模型"}。`);
    if (!this.#state.models.some((model) => model.id === modelId)) await this.discover();
    if (!this.#state.models.some((model) => model.id === modelId)) throw requestError(404, "未找到该模型。");
    const task = this.#runOne(modelId).finally(() => { this.#running = null; });
    this.#running = task;
    return task;
  }

  async scanNext() {
    if (this.#running) return this.snapshot();
    if (this.#state.models.length === 0) await this.discover();
    const models = this.#state.models;
    if (models.length === 0) return this.snapshot();
    const index = this.#state.nextScanIndex % models.length;
    const modelId = models[index].id;
    this.#state = { ...this.#state, nextScanIndex: (index + 1) % models.length };
    this.#persist();
    return this.runOne(modelId);
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
        nextScanIndex: ids.length ? this.#state.nextScanIndex % ids.length : 0,
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

  async #runOne(id) {
    this.#state = { ...this.#state, running: true, activeModelId: id, lastStartedAt: new Date(this.now()).toISOString(), lastError: null };
    try {
      const checked = await this.#probe(id);
      this.#state = {
        ...this.#state,
        running: false,
        activeModelId: null,
        lastFinishedAt: new Date(this.now()).toISOString(),
        models: this.#state.models.map((model) => model.id === id ? checked : model)
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        running: false,
        activeModelId: null,
        lastFinishedAt: new Date(this.now()).toISOString(),
        lastError: error?.message || "模型检测未完成。"
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
    if (!profile) throw requestError(503, "没有可用的已登录账号，无法获取模型列表。");
    const response = await this.#request("/v1/models", {
      method: "GET",
      headers: await this.#headers(profile, "GET", "/v1/models")
    });
    if (!response.ok) throw requestError(502, `上游模型列表请求失败（HTTP ${response.status}）。`);
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
      const body = JSON.stringify(probePayload(id));
      const response = await this.#request("/v1/chat/completions", {
        method: "POST",
        headers: await this.#headers(profile, "POST", "/v1/chat/completions", body),
        body
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

  async #headers(profile, method, path, body = "") {
    if (this.relaySessions) return this.relaySessions.headersFor(profile, { method, path, body });
    return { Accept: "application/json", "Content-Type": "application/json", "x-mirasim-client": "0.0.147", Authorization: `Bearer ${profile.token}` };
  }
}

function pendingResult(id) { return result(id, "pending", null, null, null, "尚未检测。"); }
function result(id, status, checkedAt, latencyMs, httpStatus, message) { return { id, status, checkedAt, latencyMs: Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null, httpStatus, message }; }
function stateForStatus(status) { return status === 429 ? "limited" : status === 401 || status === 403 ? "unauthorized" : "unavailable"; }
function errorMessage(data, status) { const message = data?.error?.message || data?.message || data?.detail; return typeof message === "string" && message.trim() ? message.trim().slice(0, 240) : `上游返回 HTTP ${status}。`; }
function positiveNumber(value, fallback) { return Number.isInteger(value) && value > 0 ? value : fallback; }
function callableModelId(value) { return typeof value === "string" && value.trim() !== "" && value.trim() !== "*"; }
function requestError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
function probePayload(id) {
  const payload = { model: id, messages: [{ role: "user", content: "Reply exactly OK." }], max_tokens: 1, stream: false };
  // Kimi-K3 rejects temperature: 0 while accepting the same OpenAI chat shape without it.
  if (id !== "kimi-k3") payload.temperature = 0;
  return payload;
}
function savedModels(models) {
  if (!Array.isArray(models)) return [];
  return models.flatMap((model) => {
    if (!model || typeof model.id !== "string" || !callableModelId(model.id)) return [];
    return [result(model.id.trim(), typeof model.status === "string" ? model.status : "pending", typeof model.checkedAt === "string" ? model.checkedAt : null, Number.isFinite(model.latencyMs) ? model.latencyMs : null, Number.isInteger(model.httpStatus) ? model.httpStatus : null, typeof model.message === "string" ? model.message : "尚未检测。")];
  });
}
