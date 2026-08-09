import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../src/database.js";
import { WebAuth } from "../src/web-auth.js";

test("web auth rejects invalid credentials and accepts a signed-in session cookie", () => {
  let now = 1_000;
  const auth = new WebAuth(
    { username: "console", password: "correct-password", secureCookie: false },
    { now: () => now, random: () => "session-id" }
  );
  assert.equal(auth.login("console", "wrong-password"), null);

  const session = auth.login("console", "correct-password");
  assert.match(session.cookie, /^mirasim_console_session=session-id; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
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
