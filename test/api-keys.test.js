import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIKeyStore } from "../src/api-keys.js";

test("stores only API Key hashes and supports authentication and revocation", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-api-keys-"));
  let now = new Date("2026-08-09T00:00:00.000Z");
  try {
    const file = join(root, "keys.json");
    const store = new OpenAIKeyStore(file, { now: () => now });
    const created = store.create("Local client");
    assert.match(created.key, /^msk_[A-Za-z0-9_-]{40,}$/);
    assert.equal(created.record.name, "Local client");
    assert.equal(store.list()[0].prefix, created.record.prefix);
    assert.equal(JSON.stringify(store.list()).includes(created.key), false);
    assert.equal(readFileSync(file, "utf8").includes(created.key), false);
    assert.equal(store.authenticate("msk_wrong"), null);

    now = new Date("2026-08-09T00:01:01.000Z");
    assert.equal(store.authenticate(created.key).id, created.record.id);
    assert.equal(store.list()[0].lastUsedAt, now.toISOString());
    assert.equal(new OpenAIKeyStore(file).revoke(created.record.id), true);
    assert.equal(store.authenticate(created.key), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stores a recoverable API Key only as console-password encrypted ciphertext", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-api-key-history-"));
  try {
    const file = join(root, "keys.sqlite");
    const store = new OpenAIKeyStore(file, { secret: "console-password" });
    const created = store.create("Historical client");
    assert.equal(store.list()[0].copyable, true);
    assert.equal(store.reveal(created.record.id), created.key);
    assert.equal(new OpenAIKeyStore(file, { secret: "wrong-password" }).reveal(created.record.id), null);
    assert.equal(readFileSync(file, "utf8").includes(created.key), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
