import assert from "node:assert/strict";
import test from "node:test";
import { prepareSearchRequest, applySearchTools } from "../src/search-protocol.js";

test("search options translate approximate Chat location without mutating the caller", () => {
  const value = { model: "gpt-6-astra", web_search_options: { search_context_size: "high", user_location: { type: "approximate", approximate: { country: "US" } } } };
  const search = prepareSearchRequest(value, "chat");
  assert.equal(search.error, undefined);
  assert.equal(search.request.web_search_options, undefined);
  assert.deepEqual(search.tools, [{ type: "web_search", search_context_size: "high", user_location: { type: "approximate", country: "US" } }]);
  assert.ok(value.web_search_options);
});

test("Anthropic hosted search maps domains and forced search while retaining client tools", () => {
  const client = { name: "calculate", input_schema: { type: "object" } };
  const search = prepareSearchRequest({ model: "gpt-6-astra", tools: [client, { type: "web_search_20250305", name: "web_search", allowed_domains: ["example.com"] }], tool_choice: { type: "tool", name: "web_search" } }, "anthropic");
  assert.deepEqual(search.request.tools, [client]);
  const request = { tools: [{ type: "function", name: "calculate" }] };
  applySearchTools(request, search);
  assert.deepEqual(request.tool_choice, { type: "web_search" });
  assert.deepEqual(request.tools[1], { type: "web_search", filters: { allowed_domains: ["example.com"] } });
});

test("native Responses search retains options and leaves function tools intact", () => {
  const searchTool = { type: "web_search", external_web_access: false, filters: { allowed_domains: ["example.com"] } };
  const client = { type: "function", name: "calculate", parameters: {} };
  const result = prepareSearchRequest({ model: "gpt-6-astra", tools: [client, searchTool], tool_choice: "none" }, "responses");
  assert.deepEqual(result.request.tools, [client, searchTool]);
  assert.equal(result.request.tool_choice, "none");
});

test("search requests reject unsupported models, conflicting tools and lossy Anthropic options", () => {
  for (const model of ["claude-opus-5", "deepseek-flash", "gpt-image-1"]) assert.match(prepareSearchRequest({ model, web_search_options: {} }, "chat").error, /Responses-backed text model/);
  for (const options of [true, [], null]) assert.match(prepareSearchRequest({ model: "gpt-6-astra", web_search_options: options }, "chat").error, /expected an object/);
  assert.match(prepareSearchRequest({ model: "gpt-6-astra", web_search_options: {}, tools: [{ type: "web_search" }] }, "chat").error, /not both/);
  assert.match(prepareSearchRequest({ model: "gpt-6-astra", tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }] }, "anthropic").error, /max_uses/);
});

test("existing Anthropic provider search and ordinary function tools are not reinterpreted", () => {
  for (const value of [{ model: "claude-opus-5", tools: [{ type: "web_search_20250305", name: "web_search" }] }, { model: "gpt-6-astra", tools: [{ type: "function", function: { name: "web_search", parameters: {} } }] }]) {
    assert.equal(prepareSearchRequest(value, "anthropic").request, value);
  }
});
