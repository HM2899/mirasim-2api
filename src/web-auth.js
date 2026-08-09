import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "mirasim_console_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export class WebAuth {
  #usernameHash;
  #passwordHash;
  #sessions = new Map();

  constructor(config, { now = () => Date.now(), random = () => randomBytes(32).toString("base64url"), database = null } = {}) {
    this.username = config.username;
    this.secureCookie = config.secureCookie;
    this.now = now;
    this.random = random;
    this.database = database;
    this.#usernameHash = digest(config.username);
    this.#passwordHash = digest(config.password);
  }

  isAuthenticated(request) {
    this.#pruneExpired();
    const sessionId = parseCookies(request.headers.cookie || "")[COOKIE_NAME];
    if (!sessionId) return false;
    if (this.database) return this.database.hasWebSession(sessionId, this.now());
    const session = this.#sessions.get(sessionId);
    return Boolean(session && session.expiresAt > this.now());
  }

  login(username, password) {
    if (!matches(this.#usernameHash, username) || !matches(this.#passwordHash, password)) return null;
    const id = this.random();
    const expiresAt = this.now() + SESSION_TTL_MS;
    if (this.database) this.database.saveWebSession(id, expiresAt);
    else this.#sessions.set(id, { expiresAt });
    return { cookie: sessionCookie(id, this.secureCookie), expiresAt };
  }

  logout(request) {
    const sessionId = parseCookies(request.headers.cookie || "")[COOKIE_NAME];
    if (sessionId) {
      if (this.database) this.database.removeWebSession(sessionId);
      else this.#sessions.delete(sessionId);
    }
    return expiredCookie(this.secureCookie);
  }

  #pruneExpired() {
    const now = this.now();
    if (this.database) return this.database.pruneWebSessions(now);
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(id);
    }
  }
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : "").digest();
}

function matches(expected, value) {
  const received = digest(value);
  return timingSafeEqual(expected, received);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && value) cookies[name] = value;
  }
  return cookies;
}

function sessionCookie(id, secure) {
  return `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`;
}

function expiredCookie(secure) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}
