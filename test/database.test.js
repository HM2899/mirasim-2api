import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateDatabase } from "../src/database.js";

test("opening an existing database removes monetary history but preserves usage and accounts", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-cost-removal-"));
  const file = join(root, "state.sqlite");
  try {
    const original = new StateDatabase(file, { seedHomes: ["/profiles/a"] });
    original.db.exec(`
      CREATE TABLE usage_costs (id INTEGER PRIMARY KEY, completed_at INTEGER NOT NULL, amount_usd REAL);
      CREATE INDEX usage_costs_completed_at ON usage_costs(completed_at);
      INSERT INTO usage_costs VALUES (1, 1000, 1.25);
      INSERT INTO meta VALUES ('usage_cost_started_at', 'legacy');
      INSERT INTO usage_ledger(home, requests, input_tokens) VALUES ('/profiles/a', 3, 120);
    `);
    original.db.close();
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const reopened = new StateDatabase(file);
      assert.equal(reopened.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('usage_costs', 'usage_costs_completed_at')").all().length, 0);
      assert.equal(reopened.db.prepare("SELECT value FROM meta WHERE key = 'usage_cost_started_at'").get(), undefined);
      assert.deepEqual(reopened.homes(), ["/profiles/a"]);
      assert.equal(reopened.db.prepare("SELECT input_tokens FROM usage_ledger WHERE home = '/profiles/a'").get().input_tokens, 120);
      assert.equal(reopened.db.prepare("SELECT requests FROM usage_ledger WHERE home = '/profiles/a'").get().requests, 3);
      reopened.db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
