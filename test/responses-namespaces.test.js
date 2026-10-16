import assert from "node:assert/strict";
import test from "node:test";
import { adaptResponsesNamespaces } from "../src/responses-namespaces.js";

test("namespace conversion keeps function and custom schemas and restores client identities", () => {
  const tools = [{ type: "namespace", name: "functions", tools: [
    { type: "function", name: "wait", parameters: { type: "object", properties: {} } },
    { type: "custom", name: "exec_command", description: "Execute", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }
  ] }];
  const input = [
    { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", namespace: "functions", name: "exec_command", input: "pwd" },
    { type: "custom_tool_call_output", call_id: "call_1", output: "/workspace" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "functions__exec_command" }] }
  ];
  const request = { tools, input, tool_choice: { type: "custom", name: "exec_command", namespace: "functions" } };
  const original = structuredClone(request);
  const adapted = adaptResponsesNamespaces(request);
  assert.deepEqual(request, original);
  assert.deepEqual(adapted.request.tools.map((tool) => [tool.type, tool.name]), [["function", "functions__wait"], ["custom", "functions__exec_command"]]);
  assert.deepEqual(adapted.request.tools[1].format, tools[0].tools[1].format);
  assert.deepEqual(adapted.request.input[0], { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "functions__exec_command", input: "pwd" });
  assert.equal(Object.hasOwn(adapted.request.input[0], "namespace"), false);
  assert.deepEqual(adapted.request.input.slice(1), input.slice(1));
  assert.deepEqual(adapted.request.tool_choice, { type: "custom", name: "functions__exec_command" });
  for (const type of ["response.output_item.added", "response.output_item.done"]) {
    const event = { type, sequence_number: 3, item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "functions__exec_command", input: "pwd" } };
    assert.deepEqual(adapted.restoreEvent(event).item, input[0]);
    assert.equal(adapted.restoreEvent(event).sequence_number, 3);
    assert.equal(event.item.name, "functions__exec_command");
  }
  const delta = { type: "response.custom_tool_call_input.delta", item_id: "ctc_1", delta: "pw" };
  assert.deepEqual(adapted.restoreEvent(delta), delta);
  const done = adapted.restoreEvent({ type: "response.custom_tool_call_input.done", name: "functions__exec_command", input: "pwd" });
  assert.equal(done.name, "exec_command");
  assert.equal(done.namespace, "functions");
  assert.equal(adapted.restoreResponse({ output: [{ type: "function_call", name: "functions__wait", arguments: "{}" }] }).output[0].namespace, "functions");
});

test("custom-only namespaces and historical calls without current declarations remain reversible", () => {
  const adapted = adaptResponsesNamespaces({ tools: [{ type: "namespace", name: "tools", children: [{ type: "custom", name: "patch" }] }], input: [{ type: "custom_tool_call", namespace: "old", name: "exec", call_id: "old_call", input: "pwd" }] });
  assert.deepEqual(adapted.request.tools, [{ type: "custom", name: "tools__patch" }]);
  assert.equal(adapted.request.input[0].name, "old__exec");
  assert.equal(adapted.restoreResponse({ output: [{ type: "custom_tool_call", name: "tools__patch", input: "patch" }] }).output[0].namespace, "tools");
});

test("namespace conversion rejects collisions and unsupported children instead of dropping tools", () => {
  const group = { type: "namespace", name: "tools", tools: [{ type: "custom", name: "exec" }] };
  assert.throws(() => adaptResponsesNamespaces({ tools: [group, { type: "function", name: "tools__exec" }] }), /conflict/);
  assert.throws(() => adaptResponsesNamespaces({ tools: [group, group] }), /Duplicate/);
  assert.throws(() => adaptResponsesNamespaces({ tools: [{ ...group, tools: [{ type: "shell", name: "exec" }] }] }), /Only function and custom/);
  assert.throws(() => adaptResponsesNamespaces({ tools: [group], tool_choice: { type: "custom", namespace: "tools", name: "missing" } }), /undeclared/);
  assert.throws(() => adaptResponsesNamespaces({ tools: [{ type: "namespace", name: "empty", tools: [] }] }), /must declare/);
});

test("long aliases are stable, bounded and restored while ordinary tools remain untouched", () => {
  const namespace = "namespace".repeat(8);
  const request = { tools: [{ type: "namespace", name: namespace, tools: [{ type: "custom", name: "exec" }] }, { type: "custom", name: "patch", format: { type: "text" } }], input: "Hello" };
  const adapted = adaptResponsesNamespaces(request);
  const alias = adapted.request.tools[0].name;
  assert.ok(alias.length <= 64);
  assert.equal(alias, adaptResponsesNamespaces(request).request.tools[0].name);
  assert.deepEqual(adapted.request.tools[1], request.tools[1]);
  assert.equal(adapted.restoreResponse({ output: [{ type: "custom_tool_call", name: alias }] }).output[0].namespace, namespace);
});
