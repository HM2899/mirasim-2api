import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { bundledCliEnvironment, MIRASIM_CLIENT_VERSION } from "../src/mirasim-release.js";

test("the vendored runtime is the exact verified official 0.0.516 macOS bundle", () => {
  const bundle = readFileSync(new URL("../vendor/mirasim-server.cjs", import.meta.url));
  assert.equal(bundle.length, 25364146);
  assert.equal(createHash("sha256").update(bundle).digest("hex"), "671caeca8bae790743a1ee2fde417da8db406c79967f7ef92c89bffd172e77dc");
});

test("version defaults consistently target the upgraded runtime and retain explicit overrides", () => {
  const actual = execFileSync(process.execPath, [fileURLToPath(new URL("../vendor/mirasim-server.cjs", import.meta.url)), "--version"], {
    encoding: "utf8", timeout: 10000, env: bundledCliEnvironment({ ...process.env })
  }).trim();
  assert.equal(actual, "0.0.516");
  assert.equal(MIRASIM_CLIENT_VERSION, actual);
  assert.equal(loadConfig({}).clientVersion, MIRASIM_CLIENT_VERSION);
  assert.equal(loadConfig({ MIRASIM_CLIENT_VERSION: "test-version" }).clientVersion, "test-version");
});

test("bundled CLI defaults disable optional analytics, diagnostics and capture", () => {
  const env = { MIRASIM_HOME: "/profile" };
  assert.deepEqual(bundledCliEnvironment(env), {
    MIRASIM_HOME: "/profile", MIRASIM_ANALYTICS: "0", MIRASIM_DIAG: "0", MIRASIM_RECORD: "0"
  });
  assert.deepEqual(env, { MIRASIM_HOME: "/profile" });
  assert.equal(bundledCliEnvironment({ MIRASIM_ANALYTICS: "1" }).MIRASIM_ANALYTICS, "1");
});
