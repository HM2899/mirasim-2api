import { createHash } from "node:crypto";

function requestError(message, param, code = "invalid_request_error", statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, code, param });
}

function missingHistory() {
  return requestError("previous_response_id was not found for this owner and model; provide the full history or start a new session.", "previous_response_id", "previous_response_not_found");
}

function normalizeInput(input) {
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw requestError("input must be a string or an array.", "input");
  return input;
}

function ownerKey(owner) {
  if (typeof owner !== "string") throw requestError("owner must be a string.", "owner");
  return createHash("sha256").update(owner).digest("hex");
}

function itemBytes(items) {
  return Buffer.byteLength(JSON.stringify(items), "utf8");
}

/** Bounded owner-scoped LRU of complete, independently reusable history snapshots. */
export class ResponsesHistoryStore {
  #now;
  #limits;
  #entries = new Map();
  #owners = new Map();
  #bytes = 0;

  constructor(now = Date.now, ttlMs = 30 * 60 * 1000, maxEntries = 500, maxBytes = 64 * 1024 * 1024, maxOwnerEntries = 100, maxOwnerBytes = 32 * 1024 * 1024, maxEntryBytes = 16 * 1024 * 1024, maxItems = 16384) {
    if (now && typeof now === "object") ({ now = Date.now, ttlMs = 30 * 60 * 1000, maxEntries = 500, maxBytes = 64 * 1024 * 1024, maxOwnerEntries = 100, maxOwnerBytes = 32 * 1024 * 1024, maxEntryBytes = 16 * 1024 * 1024, maxItems = 16384 } = now);
    if (typeof now !== "function") throw new TypeError("now must be a function.");
    this.#now = now;
    this.#limits = { ttlMs, maxEntries, maxBytes, maxOwnerEntries, maxOwnerBytes, maxEntryBytes, maxItems };
    for (const [name, value] of Object.entries(this.#limits)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer.`);
    }
  }

  get size() {
    this.#purgeExpired();
    return this.#entries.size;
  }

  get bytes() {
    this.#purgeExpired();
    return this.#bytes;
  }

  #remove(key) {
    const entry = this.#entries.get(key);
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
    const stats = this.#owners.get(entry.owner);
    stats.count -= 1;
    stats.bytes -= entry.bytes;
    if (!stats.count) this.#owners.delete(entry.owner);
  }

  #purgeExpired() {
    const now = this.#now();
    // LRU order is not expiry order: reads never extend the fixed TTL.
    for (const [key, entry] of this.#entries) {
      if (now >= entry.expiresAt) this.#remove(key);
    }
  }

  #checkItems(items) {
    if (items.length > this.#limits.maxItems) {
      throw requestError("input history exceeds the item limit; start a new session with a shorter history.", "input", "response_history_limit", 413);
    }
    let bytes;
    try {
      bytes = itemBytes(items);
    } catch {
      throw requestError("input must contain JSON-serializable items.", "input");
    }
    if (bytes > this.#limits.maxEntryBytes) {
      throw requestError("input history exceeds the byte limit; start a new session with a shorter history.", "input", "response_history_limit", 413);
    }
    return bytes;
  }

  #recordBytes(owner, model, id, items, sessionId, promptCacheKey) {
    try {
      return Buffer.byteLength(JSON.stringify({ owner, model, id, items, sessionId, promptCacheKey }), "utf8");
    } catch {
      throw requestError("input and response metadata must be JSON-serializable.", "input");
    }
  }

  // The local history snapshot is also the only safe place to retain the opaque relay session
  // that wrote this GPT turn's prompt cache. It never leaves this process or reaches a caller.
  // Invalid owners/models/ids deliberately look like an absent entry: the public request path
  // performs its own protocol validation and must not disclose whether another owner has state.
  sessionFor(owner, model, id) {
    this.#purgeExpired();
    if (typeof owner !== "string" || typeof model !== "string" || typeof id !== "string" || !id.trim()) return null;
    const key = JSON.stringify([ownerKey(owner), id]);
    const entry = this.#entries.get(key);
    if (!entry || entry.model !== model || !entry.sessionId) return null;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.sessionId;
  }

  promptCacheKeyFor(owner, model, id) {
    if (!this.sessionFor(owner, model, id)) return null;
    return this.#entries.get(JSON.stringify([ownerKey(owner), id]))?.promptCacheKey || null;
  }

  expand(owner, model, request) {
    this.#purgeExpired();
    if (!request || typeof request !== "object" || Array.isArray(request)) throw requestError("request must be an object.", "input");
    const previous = request.previous_response_id;
    if (previous !== undefined && previous !== null && (typeof previous !== "string" || !previous.trim())) {
      throw requestError("previous_response_id must be a non-empty string when provided.", "previous_response_id");
    }
    const current = normalizeInput(request.input);
    const key = JSON.stringify([ownerKey(owner), previous]);
    const entry = previous !== undefined && previous !== null ? this.#entries.get(key) : null;
    if (previous !== undefined && previous !== null && (!entry || entry.model !== model)) throw missingHistory();
    const items = entry ? [...entry.items, ...current] : current;
    this.#checkItems(items);
    let expanded;
    try {
      expanded = structuredClone(request);
      expanded.input = structuredClone(items);
    } catch {
      throw requestError("input and request fields must be cloneable JSON data.", "input");
    }
    delete expanded.previous_response_id;
    if (entry) {
      this.#entries.delete(key);
      this.#entries.set(key, entry);
    }
    return expanded;
  }

  // The caller decides whether store:false permits this call. Upstream response.store
  // is intentionally ignored, since upstream persistence may always be disabled.
  remember(owner, model, input, response, { sessionId = null, promptCacheKey = null } = {}) {
    this.#purgeExpired();
    if (!response || response.status !== "completed" || typeof response.id !== "string" || !response.id.trim() || !Array.isArray(response.output)) return false;
    let items;
    try {
      items = structuredClone([...normalizeInput(input), ...response.output]);
    } catch {
      throw requestError("input and response.output must be cloneable JSON data.", "input");
    }
    this.#checkItems(items);
    const hashedOwner = ownerKey(owner);
    const storedSessionId = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
    const storedPromptCacheKey = typeof promptCacheKey === "string" && promptCacheKey.trim() ? promptCacheKey.trim() : null;
    const bytes = this.#recordBytes(hashedOwner, model, response.id, items, storedSessionId, storedPromptCacheKey);
    const limits = this.#limits;
    // Include retained metadata, not only items: long ids/models consume budget too.
    // A single uncacheable snapshot must not evict otherwise useful history.
    if (!limits.ttlMs || !limits.maxEntries || !limits.maxOwnerEntries || bytes > limits.maxEntryBytes || bytes > limits.maxOwnerBytes || bytes > limits.maxBytes) {
      throw requestError("input history exceeds the cache budget; start a new session with a shorter history.", "input", "response_history_limit", 413);
    }
    const key = JSON.stringify([hashedOwner, response.id]);
    if (this.#entries.has(key)) this.#remove(key);

    for (const [oldKey, entry] of this.#entries) {
      const stats = this.#owners.get(hashedOwner);
      if (!stats || (stats.count + 1 <= limits.maxOwnerEntries && stats.bytes + bytes <= limits.maxOwnerBytes)) break;
      if (entry.owner === hashedOwner) this.#remove(oldKey);
    }
    while (this.#entries.size + 1 > limits.maxEntries || this.#bytes + bytes > limits.maxBytes) {
      this.#remove(this.#entries.keys().next().value);
    }

    this.#entries.set(key, { owner: hashedOwner, model, items, sessionId: storedSessionId, promptCacheKey: storedPromptCacheKey, bytes, expiresAt: this.#now() + limits.ttlMs });
    this.#bytes += bytes;
    const stats = this.#owners.get(hashedOwner) || { count: 0, bytes: 0 };
    stats.count += 1;
    stats.bytes += bytes;
    this.#owners.set(hashedOwner, stats);
    return true;
  }
}
