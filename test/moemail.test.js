import assert from "node:assert/strict";
import test from "node:test";
import { MoeMailClient } from "../src/moemail.js";

test("creates a MoeMail inbox and extracts a labeled verification code", async () => {
  const calls = [];
  const client = new MoeMailClient({
    url: "https://mail.example.test",
    apiKey: "mail-key",
    domain: "mail.example.test",
    expiryTimeMs: 3_600_000,
    codeTimeoutMs: 1_000,
    pollMs: 1
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.pathname === "/api/emails/generate") return json({ id: "mail-1", email: "new@mail.example.test" });
      if (url.pathname === "/api/emails/mail-1") return json({
        messages: [{ subject: "Mirasim verification code: 482913", content: "Use this code to sign in." }]
      });
      throw new Error(`Unexpected path ${url.pathname}`);
    },
    sleep: async () => {}
  });

  const mailbox = await client.createMailbox();
  assert.deepEqual(mailbox, { id: "mail-1", email: "new@mail.example.test" });
  assert.equal(await client.waitForVerificationCode(mailbox), "482913");
  assert.equal(calls[0].options.headers["X-API-Key"], "mail-key");
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.domain, "mail.example.test");
  assert.equal(payload.expiryTime, 3_600_000);
  assert.match(payload.name, /^mirasim-[0-9a-f]{12}$/);
});

test("rotates configured domains and discovers provider domains", async () => {
  const generated = [];
  const client = new MoeMailClient({ url: "https://mail.example.test", apiKey: "mail-key", domains: ["one.example.test", "two.example.test"] }, {
    fetchImpl: async (url, options) => {
      if (url.pathname === "/api/domains") return json({ domains: [{ domain: "one.example.test" }, { name: "two.example.test" }] });
      if (url.pathname === "/api/emails/generate") {
        generated.push(JSON.parse(options.body).domain);
        return json({ id: `mail-${generated.length}`, email: `new${generated.length}@example.test` });
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    }
  });
  await client.createMailbox();
  await client.createMailbox();
  await client.createMailbox();
  assert.deepEqual(generated, ["one.example.test", "two.example.test", "one.example.test"]);
  assert.deepEqual(await client.listDomains(), ["one.example.test", "two.example.test"]);
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
