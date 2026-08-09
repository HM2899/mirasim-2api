import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateDatabase } from "../src/database.js";

test("SQLite persists account pool membership and does not restore deleted seeds", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-db-"));
  const file = join(root, "state.sqlite");
  try {
    const first = new StateDatabase(file, { seedHomes: ["/profiles/a", "/profiles/b"] });
    assert.deepEqual(first.homes(), ["/profiles/a", "/profiles/b"]);
    first.removeHome("/profiles/a");
    first.addHome("/profiles/c");

    const reopened = new StateDatabase(file, { seedHomes: ["/profiles/a", "/profiles/b"] });
    assert.deepEqual(reopened.homes(), ["/profiles/b", "/profiles/c"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stores MoeMail configuration encrypted with the console password", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-database-"));
  try {
    const database = new StateDatabase(join(root, "state.sqlite"));
    database.saveMoeMailConfig({ url: "https://mail.example.test", apiKey: "private-mail-key", domain: "mail.example.test" }, "console-password");
    assert.deepEqual(database.getMoeMailConfig("console-password"), {
      url: "https://mail.example.test", apiKey: "private-mail-key", domain: "mail.example.test"
    });
    assert.equal(database.getMoeMailConfig("wrong-password"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stores the last model health snapshot across SQLite reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-model-health-db-"));
  try {
    const file = join(root, "state.sqlite");
    const health = { lastFinishedAt: "2026-08-09T00:00:00.000Z", models: [{ id: "gpt-5.6", status: "healthy" }] };
    new StateDatabase(file).saveModelHealth(health);
    assert.deepEqual(new StateDatabase(file).getModelHealth(), health);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
