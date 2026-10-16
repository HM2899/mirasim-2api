import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { MIRASIM_SEAL_PUBLIC_KEY } from "./mirasim-release.js";

const CRYPTO_CORE_FILE = fileURLToPath(new URL("../vendor/mirasim-server.cjs", import.meta.url));
let core;

// Mirasim keeps its signing implementation in a compact WebAssembly core embedded in the
// official server bundle. Loading that exact core avoids guessing at a protocol which now
// authenticates request metadata as well as its body. Bundle variable names change on every
// release, so locate the base64 payload by the WebAssembly construction that consumes it.
function cryptoCore() {
  if (core !== undefined) return core;
  try {
    const source = readFileSync(CRYPTO_CORE_FILE, "utf8");
    const consumer = /function [A-Za-z_$][\w$]*\(\)\{if\([A-Za-z_$][\w$]*!==void\([^)]*\)\)return [A-Za-z_$][\w$]*;try\{let [A-Za-z_$][\w$]*=Buffer\['from'\]\(([A-Za-z_$][\w$]*),'base64'\),/.exec(source);
    const payloadName = consumer?.[1];
    const escapedName = payloadName?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const payload = escapedName ? new RegExp(`${escapedName}='([^']+)'`).exec(source) : null;
    if (!payload) throw new Error("embedded crypto core was not found");
    core = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(payload[1], "base64")), {}).exports;
  } catch {
    core = null;
  }
  return core;
}

export function signMirasimRelayRequest(seed, {
  method,
  path,
  ts,
  nonce,
  deviceId,
  clientVersion,
  credential,
  metadata = {},
  body = ""
} = {}) {
  const wasm = cryptoCore();
  if (!wasm) throw new Error("Mirasim relay crypto core is unavailable.");

  const values = [
    Buffer.from(seed),
    canonicalFields({ method, path, ts, nonce, deviceId, clientVersion, credential }),
    canonicalMetadata(metadata),
    Buffer.isBuffer(body) ? body : Buffer.from(body)
  ];
  const inputs = [];

  try {
    for (const value of values) inputs.push(allocate(wasm, value));
    return readPacked(wasm, wasm.cc_sign(...inputs.flat()));
  } finally {
    for (const allocation of inputs) free(wasm, allocation);
  }
}

export function sealMirasimRelayHeaders(headers, {
  method,
  path,
  publicKey = MIRASIM_SEAL_PUBLIC_KEY,
  randomBytesImpl = randomBytes
} = {}) {
  const metadata = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (normalized.startsWith("x-mirasim-") && normalized !== "x-mirasim-client" && normalized !== "x-mirasim-enc") {
      metadata[name] = value;
    }
  }
  if (Object.keys(metadata).length === 0) return { ...headers };
  const key = Buffer.from(publicKey, "base64");
  if (key.length !== 32) throw new Error("Mirasim relay seal public key must be 32 bytes.");
  const wasm = cryptoCore();
  if (!wasm) throw new Error("Mirasim relay crypto core is unavailable.");
  const values = [
    key,
    randomBytesImpl(32),
    randomBytesImpl(12),
    Buffer.from(JSON.stringify(metadata)),
    Buffer.from(`mrs-seal-v1\n${method.toUpperCase()}\n${path}`)
  ];
  const inputs = [];
  try {
    for (const value of values) inputs.push(allocate(wasm, value));
    const sealed = readPacked(wasm, wasm.cc_seal(...inputs.flat()));
    const result = { ...headers, "x-mirasim-enc": sealed.toString("base64url") };
    for (const name of Object.keys(metadata)) delete result[name];
    return result;
  } finally {
    for (const allocation of inputs) free(wasm, allocation);
  }
}

function canonicalFields({ method, path, ts, nonce, deviceId, clientVersion, credential }) {
  return [
    method,
    path,
    ts,
    nonce,
    deviceId,
    clientVersion,
    credential
  ].map(noNul).join("\0");
}

function canonicalMetadata(metadata) {
  const fields = [];
  for (const [key, value] of Object.entries(metadata || {})) {
    if (value === null || value === undefined || value === "") continue;
    fields.push(noNul(key), noNul(String(value)));
  }
  return fields.join("\0");
}

function noNul(value) {
  const text = String(value ?? "");
  if (text.includes("\0")) throw new Error("Mirasim signature fields cannot contain NUL.");
  return text;
}

function allocate(wasm, value) {
  const bytes = Buffer.from(value);
  const pointer = wasm.cc_alloc(bytes.length);
  new Uint8Array(wasm.memory.buffer).set(bytes, pointer);
  return [pointer, bytes.length];
}

function free(wasm, [pointer, length]) {
  wasm.cc_free(pointer, length);
}

function readPacked(wasm, packed) {
  const pointer = Number(packed >> 32n);
  const length = Number(packed & 0xffffffffn);
  if (pointer === 0) throw new Error("Mirasim crypto core refused the request signature.");
  const signature = Buffer.from(new Uint8Array(wasm.memory.buffer, pointer, length));
  wasm.cc_free(pointer, length);
  return signature;
}
