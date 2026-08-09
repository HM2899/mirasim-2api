import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 45_000;
const DEFAULT_MODEL_LIST_TIMEOUT_MS = 10_000;
const DEFAULT_MODEL_HEALTH_INTERVAL_MS = 60_000;
const DEFAULT_MODEL_HEALTH_TIMEOUT_MS = 12_000;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_MOEMAIL_EXPIRY_MS = 3_600_000;
const DEFAULT_MOEMAIL_CODE_TIMEOUT_MS = 120_000;
const DEFAULT_MOEMAIL_POLL_MS = 2_500;
// Matches the login service compiled into the official Mirasim 0.0.147 desktop app.
const DEFAULT_LOGIN_URL = "https://admin.test.mirofish.ai";

export function loadConfig(env = process.env) {
  const relayUrl = requiredUrl(env.MIRASIM_RELAY_URL || "https://mirasim-relay.mirofish.ai", "MIRASIM_RELAY_URL");
  const loginUrl = requiredUrl(env.MIRASIM_LOGIN_URL || DEFAULT_LOGIN_URL, "MIRASIM_LOGIN_URL");
  const homes = splitList(env.MIRASIM_HOMES);
  const defaultHome = env.MIRASIM_HOME?.trim() || join(homedir(), ".mirasim");
  const databaseFile = resolveFile(env.MIRASIM_DATABASE_FILE || env.MIRASIM_API_KEYS_FILE, join(defaultHome, "mirasim.sqlite"));
  const configuredWebPassword = env.WEB_AUTH_PASSWORD?.trim();
  const generatedWebPassword = !configuredWebPassword;
  const timeoutMs = parsePositiveInt(env.MIRASIM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "MIRASIM_TIMEOUT_MS");
  const firstByteTimeoutMs = Math.min(
    timeoutMs,
    parsePositiveInt(env.MIRASIM_FIRST_BYTE_TIMEOUT_MS, DEFAULT_FIRST_BYTE_TIMEOUT_MS, "MIRASIM_FIRST_BYTE_TIMEOUT_MS")
  );
  const modelListTimeoutMs = Math.min(
    firstByteTimeoutMs,
    parsePositiveInt(env.MIRASIM_MODEL_LIST_TIMEOUT_MS, DEFAULT_MODEL_LIST_TIMEOUT_MS, "MIRASIM_MODEL_LIST_TIMEOUT_MS")
  );

  return {
    host: env.HOST || "127.0.0.1",
    port: parsePositiveInt(env.PORT, 8787, "PORT"),
    homes: homes.length > 0 ? homes : [defaultHome],
    databaseFile,
    accountRoot: resolveFile(env.MIRASIM_ACCOUNT_ROOT, join(defaultHome, "profiles")),
    moemail: {
      url: optionalUrl(env.MOEMAIL_URL, "MOEMAIL_URL"),
      apiKey: env.MOEMAIL_API_KEY?.trim() || "",
      domain: env.MOEMAIL_DOMAIN?.trim().toLowerCase() || "",
      expiryTimeMs: parsePositiveInt(env.MOEMAIL_EXPIRY_MS, DEFAULT_MOEMAIL_EXPIRY_MS, "MOEMAIL_EXPIRY_MS"),
      codeTimeoutMs: parsePositiveInt(env.MOEMAIL_CODE_TIMEOUT_MS, DEFAULT_MOEMAIL_CODE_TIMEOUT_MS, "MOEMAIL_CODE_TIMEOUT_MS"),
      pollMs: parsePositiveInt(env.MOEMAIL_POLL_MS, DEFAULT_MOEMAIL_POLL_MS, "MOEMAIL_POLL_MS")
    },
    relayUrl,
    loginUrl,
    webAuth: {
      username: env.WEB_AUTH_USERNAME?.trim() || "admin",
      password: configuredWebPassword || randomBytes(18).toString("base64url"),
      generatedPassword: generatedWebPassword,
      secureCookie: env.WEB_AUTH_SECURE_COOKIE === "true"
    },
    models: splitList(env.MIRASIM_MODELS),
    timeoutMs,
    firstByteTimeoutMs,
    modelListTimeoutMs,
    modelHealthIntervalMs: parsePositiveInt(env.MIRASIM_MODEL_HEALTH_INTERVAL_MS, DEFAULT_MODEL_HEALTH_INTERVAL_MS, "MIRASIM_MODEL_HEALTH_INTERVAL_MS"),
    modelHealthTimeoutMs: parsePositiveInt(env.MIRASIM_MODEL_HEALTH_TIMEOUT_MS, DEFAULT_MODEL_HEALTH_TIMEOUT_MS, "MIRASIM_MODEL_HEALTH_TIMEOUT_MS"),
    cooldownMs: parsePositiveInt(env.MIRASIM_COOLDOWN_MS, DEFAULT_COOLDOWN_MS, "MIRASIM_COOLDOWN_MS")
  };
}

function resolveFile(value, fallback) {
  const file = value?.trim() || fallback;
  return isAbsolute(file) ? file : resolve(file);
}

function requiredUrl(value, name) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return url.toString().replace(/\/+$/, "");
}

function optionalUrl(value, name) {
  if (!value?.trim()) return "";
  return requiredUrl(value, name);
}

function splitList(value) {
  return (value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parsePositiveInt(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
