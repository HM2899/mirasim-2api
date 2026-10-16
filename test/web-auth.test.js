import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../src/database.js";
import { WebAuth } from "../src/web-auth.js";

for (const persistent of [false, true]) {
  test(`active sessions renew with throttling (${persistent ? "SQLite" : "memory"})`, () => {
    const root = mkdtempSync(join(tmpdir(), "mirasim-session-renew-"));
    const database = persistent ? new StateDatabase(join(root, "state.sqlite")) : null;
    const day = 24 * 60 * 60 * 1000;
    let now = 1_000;
    const config = { username: "console", password: "password", secureCookie: true };
    const headers = new Map();
    const response = { setHeader: (name, value) => headers.set(name, value) };
    const request = { headers: { cookie: "mirasim_console_session=rolling-session" } };
    let auth = new WebAuth(config, { database, now: () => now, random: () => "rolling-session" });
    try {
      const session = auth.login("console", "password");
      now += day - 1;
      assert.equal(auth.isAuthenticated(request, response), true);
      assert.equal(headers.size, 0);
      now += 1;
      assert.equal(auth.isAuthenticated(request, response), true);
      assert.match(headers.get("Set-Cookie"), /Max-Age=604800; Secure$/);
      const renewedAt = now;
      headers.clear();
      assert.equal(auth.isAuthenticated(request, response), true);
      assert.equal(headers.size, 0);
      if (persistent) {
        assert.equal(database.webSessionExpiresAt("rolling-session", now), now + 7 * day);
        auth = new WebAuth(config, { database, now: () => now });
      }
      now = session.expiresAt;
      assert.equal(auth.isAuthenticated(request), true);
      now = renewedAt + 7 * day;
      assert.equal(auth.isAuthenticated(request, response), false);
      assert.equal(headers.size, 0);
      assert.equal(auth.isAuthenticated({ headers: { cookie: "mirasim_console_session=unknown" } }, response), false);
      assert.equal(headers.size, 0);
    } finally {
      database?.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("legacy sessions upgrade on use but logout prevents renewal", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-session-legacy-"));
  const database = new StateDatabase(join(root, "state.sqlite"));
  try {
    const now = 1_000;
    database.saveWebSession("legacy-session", now + 12 * 60 * 60 * 1000);
    const auth = new WebAuth({ username: "console", password: "password" }, { database, now: () => now });
    const request = { headers: { cookie: "mirasim_console_session=legacy-session" } };
    const headers = new Map();
    const response = { setHeader: (name, value) => headers.set(name, value) };
    assert.equal(auth.isAuthenticated(request, response), true);
    assert.match(headers.get("Set-Cookie"), /Max-Age=604800$/);
    assert.equal(database.webSessionExpiresAt("legacy-session", now), now + 7 * 24 * 60 * 60 * 1000);
    auth.logout(request);
    headers.clear();
    assert.equal(auth.isAuthenticated(request, response), false);
    assert.equal(headers.size, 0);
  } finally {
    database.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("web auth rejects invalid credentials and accepts a signed-in session cookie", () => {
  let now = 1_000;
  const auth = new WebAuth(
    { username: "console", password: "correct-password", secureCookie: false },
    { now: () => now, random: () => "session-id" }
  );
  assert.equal(auth.login("console", "wrong-password"), null);

  const session = auth.login("console", "correct-password");
  assert.match(session.cookie, /^mirasim_console_session=session-id; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800$/);
  assert.equal(auth.isAuthenticated({ headers: { cookie: "other=value; mirasim_console_session=session-id" } }), true);

  now = session.expiresAt;
  assert.equal(auth.isAuthenticated({ headers: { cookie: "mirasim_console_session=session-id" } }), false);
});

test("web auth logout invalidates the session and expires the cookie", () => {
  const auth = new WebAuth(
    { username: "console", password: "correct-password", secureCookie: true },
    { random: () => "session-id" }
  );
  auth.login("console", "correct-password");
  const request = { headers: { cookie: "mirasim_console_session=session-id" } };
  assert.equal(auth.isAuthenticated(request), true);
  assert.match(auth.logout(request), /Max-Age=0; Secure$/);
  assert.equal(auth.isAuthenticated(request), false);
});

test("web auth sessions persist through a local gateway restart", () => {
  const root = mkdtempSync(join(tmpdir(), "mirasim-web-session-"));
  try {
    const database = new StateDatabase(join(root, "state.sqlite"));
    const config = { username: "console", password: "correct-password", secureCookie: false };
    const first = new WebAuth(config, { database, now: () => 1_000, random: () => "persisted-session" });
    first.login("console", "correct-password");
    const request = { headers: { cookie: "mirasim_console_session=persisted-session" } };
    const restarted = new WebAuth(config, { database, now: () => 2_000 });
    assert.equal(restarted.isAuthenticated(request), true);
    restarted.logout(request);
    assert.equal(restarted.isAuthenticated(request), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
