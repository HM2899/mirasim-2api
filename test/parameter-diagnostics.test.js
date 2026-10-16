import assert from "node:assert/strict";
import test from "node:test";
import { parameterDiagnostics } from "../src/parameter-diagnostics.js";
import { RelayRequestLog } from "../src/request-log.js";

test("parameter diagnostics record changes without values or prompt contents", () => {
  const client = { model: "model", temperature: 0.2, stream: false, max_tokens: 40, reasoning_effort: "high", metadata: { secret: "private-value" }, messages: [{ content: "private-prompt" }], instructions: "private-system" };
  const upstream = { model: "model", stream: true, store: false, reasoning: { effort: "high" }, input: "private-prompt", instructions: "private-system" };
  const entry = new RelayRequestLog().open("/v1/chat/completions", JSON.stringify(client), JSON.stringify(upstream));
  assert.deepEqual(entry.parameterDiagnostics, parameterDiagnostics(client, upstream));
  const report = entry.parameterDiagnostics;
  assert.ok(report.some((item) => item.parameter === "max_tokens" && item.status === "omitted"));
  assert.ok(report.some((item) => item.parameter === "reasoning_effort" && item.targets.includes("reasoning")));
  assert.ok(report.some((item) => item.parameter === "stream" && item.status === "changed"));
  assert.doesNotMatch(JSON.stringify(report), /private-|instructions|messages|0\.2/);
  assert.ok(report.length <= 40);
});

test("diagnostics do not invent changes for unchanged, absent or unknown upstream bodies", () => {
  assert.deepEqual(parameterDiagnostics({ temperature: 0, tools: [] }, { tools: [], temperature: 0 }), []);
  assert.deepEqual(parameterDiagnostics(null, {}), []);
  assert.deepEqual(new RelayRequestLog().open("/v1/responses", '{"temperature":1}').parameterDiagnostics, []);
});
