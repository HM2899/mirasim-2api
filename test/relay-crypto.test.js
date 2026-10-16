import assert from "node:assert/strict";
import test from "node:test";
import { sealMirasimRelayHeaders, signMirasimRelayRequest } from "../src/relay-crypto.js";

const fields = {
  method: "POST", path: "/v1/responses", ts: "1700000000000", nonce: "test-nonce",
  deviceId: "device-test", clientVersion: "0.0.303", credential: "ticket-test",
  metadata: {
    "x-mirasim-session": "session-test", "x-mirasim-agent": "codex",
    "x-mirasim-account": "account-test", "x-mirasim-locale": "en-US"
  },
  body: Buffer.from('{"model":"gpt-5.6-luna"}')
};
const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => index));

test("signature matches the official 0.0.303 wrapper's fixed vector", () => {
  assert.equal(signMirasimRelayRequest(seed, fields).toString("base64url"), "MqI7cbdtTZiaT5eUN2jl1FaAj9uNPp4o5nCBhiXySp0K2udR8SyHlntWOn8_CB7buiWso66BhTzhuzvXkPpUDg");
  for (const changed of [{ body: "{}" }, { credential: "other" }, { path: "/v1/messages" }, { metadata: {} }]) {
    assert.notDeepEqual(signMirasimRelayRequest(seed, { ...fields, ...changed }), signMirasimRelayRequest(seed, fields));
  }
  assert.throws(() => signMirasimRelayRequest(seed, { ...fields, credential: "ticket\0injected" }), /NUL/);
});

const headers = {
  "Content-Type": "application/json",
  Authorization: "Bearer ticket-test",
  "x-mirasim-client": "0.0.303",
  "x-mirasim-session": "session-test",
  "x-mirasim-agent": "claude",
  "x-mirasim-collect": "off",
  "x-mirasim-device": "device-test",
  "x-mirasim-ts": "1700000000000",
  "x-mirasim-nonce": "test-nonce",
  "x-mirasim-sig": "test-signature"
};

test("metadata seal matches the official 0.0.303 wrapper's fixed vector", () => {
  const result = sealMirasimRelayHeaders(headers, { method: "POST", path: "/v1/messages", randomBytesImpl: (size) => Buffer.alloc(size, 7) });
  assert.deepEqual(result, {
    "Content-Type": "application/json", Authorization: "Bearer ticket-test", "x-mirasim-client": "0.0.303",
    "x-mirasim-enc": "E75P6uryBMf9M1j8nAByGIHRdCeBKCJ-xnTzf3_pe20HBwcHBwcHBwcHBwebTw9iO-ezbKYb0sm9NSex8rSWikeyKNI9vcuPwNrdGW0RnRqU4vMSjEfz59XxQASA8mqiIYHsAc5y1MJ7ZopTHowENDTGaQEdtPxVLpYQxLcMWhhB2Hs8sLehqfC8yI2kZxCBssqQosapYh04O27S0mUgLcvq4TytA4nSrD2V_V5_tN6h487jVrRyg4M3HILBfCxV2EYMRQ3PRSM03qCNGCJUTNtdQGf-DELbs-p6fHu6zLU1kQbXkYvbEtQbunIMMnEyJKPlacsrFHcqFxYsfhz9qd1jO4KnPSCadfw7e4DkVX1Yj1u4hA"
  });
  assert.equal(headers["x-mirasim-session"], "session-test");
});

test("seals use fresh randomness and bind method and path", () => {
  const options = { method: "POST", path: "/v1/messages" };
  assert.notEqual(sealMirasimRelayHeaders(headers, options)["x-mirasim-enc"], sealMirasimRelayHeaders(headers, options)["x-mirasim-enc"]);
  const fixed = { ...options, randomBytesImpl: (size) => Buffer.alloc(size, 7) };
  const sealed = sealMirasimRelayHeaders(headers, fixed)["x-mirasim-enc"];
  assert.notEqual(sealed, sealMirasimRelayHeaders(headers, { ...fixed, path: "/v1/models" })["x-mirasim-enc"]);
  assert.notEqual(sealed, sealMirasimRelayHeaders(headers, { ...fixed, method: "GET" })["x-mirasim-enc"]);
  assert.equal(sealed, sealMirasimRelayHeaders(headers, { ...fixed, method: "post" })["x-mirasim-enc"]);
});

test("sealing rejects a bad key rather than returning plaintext metadata", () => {
  assert.throws(() => sealMirasimRelayHeaders(headers, { method: "POST", path: "/v1/messages", publicKey: "invalid" }), /32 bytes/);
  assert.deepEqual(sealMirasimRelayHeaders({ "x-mirasim-client": "0.0.303" }), { "x-mirasim-client": "0.0.303" });
});
