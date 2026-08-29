import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { StateDatabase } from "./database.js";

const KEY_PREFIX = "msk_";
const MAX_NAME_LENGTH = 64;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export class OpenAIKeyStore {
  constructor(database, { now = () => new Date(), random = randomBytes, secret = "" } = {}) {
    this.database = typeof database === "string" ? new StateDatabase(database) : database;
    this.now = now;
    this.random = random;
    this.secret = secret;
  }

  create(name) {
    const normalizedName = normalizeName(name);
    const key = `${KEY_PREFIX}${this.random(32).toString("base64url")}`;
    const createdAt = this.now().toISOString();
    const record = {
      id: `key_${this.random(9).toString("base64url")}`,
      name: normalizedName,
      prefix: `${key.slice(0, 12)}...`,
      hash: keyHash(key),
      createdAt,
      lastUsedAt: null
    };
    this.database.db.prepare("INSERT INTO api_keys(id, name, prefix, hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)")
      .run(record.id, record.name, record.prefix, record.hash, record.createdAt);
    if (this.secret) this.database.saveApiKeySecret(record.id, key, this.secret);
    return { key, record: publicRecord({ ...record, copyable: Boolean(this.secret) }) };
  }

  list() {
    return this.database.db.prepare("SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt, secret IS NOT NULL AS copyable FROM api_keys ORDER BY created_at DESC").all()
      .map(publicRecord);
  }

  reveal(id) {
    const value = this.secret ? this.database.getApiKeySecret(id, this.secret) : null;
    return typeof value === "string" && value.startsWith(KEY_PREFIX) ? value : null;
  }

  authenticate(key) {
    if (typeof key !== "string" || !key.startsWith(KEY_PREFIX)) return null;
    const hash = keyHash(key);
    const record = this.database.db.prepare("SELECT id, name, prefix, hash, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_keys WHERE hash = ?").get(hash);
    if (!record) return null;

    const now = this.now();
    const lastUsed = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
    if (!lastUsed || now.getTime() - lastUsed >= LAST_USED_WRITE_INTERVAL_MS) {
      record.lastUsedAt = now.toISOString();
      this.database.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(record.lastUsedAt, record.id);
    }
    return publicRecord(record);
  }

  revoke(id) {
    return this.database.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id).changes > 0;
  }
}

export function normalizeApiKeyName(name) {
  return normalizeName(name);
}

function normalizeName(name) {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value) return "OpenAI API Key";
  if (value.length > MAX_NAME_LENGTH) throw new RangeError(`API Key 名称不能超过 ${MAX_NAME_LENGTH} 个字符。`);
  return value;
}

function keyHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashesEqual(left, right) {
  if (typeof left !== "string" || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function publicRecord(record) {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt || null,
    copyable: Boolean(record.copyable)
  };
}
