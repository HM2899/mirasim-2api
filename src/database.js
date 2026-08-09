import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

export class StateDatabase {
  constructor(file, { seedHomes = [] } = {}) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (
        home TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS web_sessions (
        id_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `);
    const seeded = this.db.prepare("SELECT value FROM meta WHERE key = 'accounts_seeded'").get();
    if (!seeded) {
      const insert = this.db.prepare("INSERT OR IGNORE INTO accounts(home, created_at) VALUES (?, ?)");
      const now = new Date().toISOString();
      for (const home of seedHomes) insert.run(home, now);
      this.db.prepare("INSERT INTO meta(key, value) VALUES ('accounts_seeded', '1')").run();
    }
  }

  homes() {
    return this.db.prepare("SELECT home FROM accounts ORDER BY created_at, rowid").all().map((row) => row.home);
  }

  addHome(home) {
    this.db.prepare("INSERT INTO accounts(home, created_at) VALUES (?, ?)").run(home, new Date().toISOString());
  }

  removeHome(home) {
    return this.db.prepare("DELETE FROM accounts WHERE home = ?").run(home).changes > 0;
  }

  getMoeMailConfig(secret) {
    const value = this.getEncryptedSetting("moemail_config", secret);
    if (!value) return null;
    try {
      const config = JSON.parse(value);
      return config && typeof config === "object" && !Array.isArray(config) ? config : null;
    } catch {
      return null;
    }
  }

  saveMoeMailConfig(config, secret) {
    this.setEncryptedSetting("moemail_config", JSON.stringify(config), secret);
  }

  getModelHealth() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'model_health'").get();
    if (!row) return null;
    try {
      const value = JSON.parse(row.value);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  saveModelHealth(health) {
    this.db.prepare("INSERT INTO settings(key, value) VALUES ('model_health', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(health));
  }

  saveWebSession(id, expiresAt) {
    this.db.prepare("INSERT INTO web_sessions(id_hash, expires_at) VALUES (?, ?) ON CONFLICT(id_hash) DO UPDATE SET expires_at = excluded.expires_at")
      .run(sessionHash(id), expiresAt);
  }

  hasWebSession(id, now = Date.now()) {
    this.pruneWebSessions(now);
    const row = this.db.prepare("SELECT 1 FROM web_sessions WHERE id_hash = ? AND expires_at > ?").get(sessionHash(id), now);
    return Boolean(row);
  }

  removeWebSession(id) {
    return this.db.prepare("DELETE FROM web_sessions WHERE id_hash = ?").run(sessionHash(id)).changes > 0;
  }

  pruneWebSessions(now = Date.now()) {
    this.db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(now);
  }

  getEncryptedSetting(key, secret) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    if (!row) return null;
    try {
      return decrypt(row.value, secret);
    } catch {
      return null;
    }
  }

  setEncryptedSetting(key, value, secret) {
    this.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, encrypt(value, secret));
  }

}

function encrypt(value, secret) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = encryptionKey(secret, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return JSON.stringify({
    v: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64")
  });
}

function decrypt(value, secret) {
  const payload = JSON.parse(value);
  if (payload?.v !== 1) throw new Error("Unsupported encrypted setting.");
  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const key = encryptionKey(secret, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8");
}

function encryptionKey(secret, salt) {
  if (typeof secret !== "string" || !secret) throw new Error("Missing encryption secret.");
  return scryptSync(secret, salt, 32);
}

function sessionHash(id) {
  return createHash("sha256").update(typeof id === "string" ? id : "").digest("hex");
}
