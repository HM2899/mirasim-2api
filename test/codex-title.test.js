import assert from "node:assert/strict";
import test from "node:test";
import { codexTitleDiagnostics, localCodexTitleCompletion } from "../src/codex-title.js";

const instruction = "Generate a concise, single-line task title of at most 36 characters and under five words where possible. Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.";
const prompt = `${instruction}\n\nUser prompt:\n修复重复请求`;

test("title diagnostics identify merged context without retaining prompts or arbitrary fields", () => {
  const diagnostics = codexTitleDiagnostics({
    model: "gpt-6-astra", system: "private-system",
    messages: [{ role: "user", content: [
      { type: "text", text: "<environment_context>private-environment</environment_context>" },
      { type: "text", text: `${instruction}\n\nUser prompt:\nprivate-user` },
      { type: "image", source: "private-image" }
    ] }, { role: "private-role", content: "private-message" }]
  });
  assert.equal(diagnostics.messageCount, 2);
  assert.equal(diagnostics.messages[0].nonTextBlocks, 1);
  assert.equal(diagnostics.messages[0].text[0].environmentContext, true);
  assert.equal(diagnostics.messages[0].text[1].exactInstruction, true);
  assert.equal(diagnostics.messages[0].text[1].sourceKind, "user_prompt");
  assert.equal(diagnostics.messages[1].role, "other");
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-|Generate a concise/);
  assert.equal(codexTitleDiagnostics({ model: "claude-opus-5-5" }), null);
});

test("title diagnostics detect a prefixed instruction and bound stored metadata", () => {
  const diagnostics = codexTitleDiagnostics({ model: "gpt-6-astra", input: `prefix\n${prompt}` });
  assert.equal(diagnostics.messages[0].text[0].titleMarkerOffset, 7);
  assert.equal(diagnostics.messages[0].text[0].exactInstruction, true);
  const large = codexTitleDiagnostics({ model: "gpt-6-astra", input: Array.from({ length: 100 }, () => ({ role: "user", content: Array.from({ length: 100 }, () => ({ type: "text", text: "private" })) })) });
  assert.equal(large.messageCount, 100);
  assert.equal(large.messages.length, 32);
  assert.equal(large.messagesTruncated, true);
  assert.equal(large.messages[0].text.length, 32);
  assert.equal(large.messages[0].textTruncated, true);
});

test("exact automatic titles are local and report no model tokens", () => {
  for (const input of [prompt, [{ role: "user", content: [{ type: "input_text", text: prompt }] }]]) {
    const completion = localCodexTitleCompletion({ model: "gpt-6-astra", input });
    assert.equal(completion.choices[0].message.content, "修复重复请求");
    assert.deepEqual(completion.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  }
  assert.equal(localCodexTitleCompletion({ model: "gpt-6-astra", messages: [{ role: "user", content: prompt }] }).choices[0].message.content, "修复重复请求");
});

test("normal requests, quoted instructions, history, non-GPT and forced tools are not intercepted", () => {
  const base = { model: "gpt-6-astra", input: prompt };
  for (const request of [
    { ...base, input: "Reply only OK" },
    { ...base, input: `Explain this prompt: ${prompt}` },
    { ...base, input: prompt.replace("Do not answer the request.", "Answer the request.") },
    { ...base, model: "claude-opus-5-5" },
    { ...base, previous_response_id: "resp_previous" },
    { ...base, store: true },
    { ...base, tool_choice: { type: "any" } },
    { ...base, text: { format: { type: "json_schema" } } },
    { ...base, input: [{ role: "assistant", content: "history" }, { role: "user", content: prompt }] },
    { ...base, input: [{ role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_image", image_url: "data:image/png;base64,test" }] }] },
    { ...base, input: `${instruction}\n\nUser prompt:\n` },
    { ...base, input: prompt.replace("36 characters", "999 characters") }
  ]) assert.equal(localCodexTitleCompletion(request), null);
});

test("merged Codex AGENTS and environment blocks do not hide the final title instruction", () => {
  for (const type of ["text", "input_text"]) {
    const content = [
      { type, text: "# AGENTS.md instructions for /home/test\n\nFollow project rules." },
      { type, text: "<environment_context>\n<cwd>/home/test</cwd>\n</environment_context>" },
      { type, text: prompt }
    ];
    const request = { model: "gpt-6-astra", messages: [{ role: "user", content }] };
    assert.equal(localCodexTitleCompletion(request).choices[0].message.content, "修复重复请求");
    assert.equal(localCodexTitleCompletion({ ...request, input: content, messages: [{ role: "assistant", content: "Earlier answer" }, ...request.messages] }), null);
    assert.equal(localCodexTitleCompletion({ ...request, messages: [{ role: "user", content: [...content.slice(0, -1), { type, text: "只回复 OK" }] }] }), null);
  }
});

test("context support does not intercept quoted titles, arbitrary prefixes, images or trailing tasks", () => {
  for (const content of [
    [{ type: "text", text: "Explain this template" }, { type: "text", text: prompt }],
    [{ type: "text", text: `<environment_context>cwd</environment_context>\nExplain this` }, { type: "text", text: prompt }],
    [{ type: "text", text: "# AGENTS.md instructions are the subject of my question" }, { type: "text", text: prompt }],
    [{ type: "text", text: "# AGENTS.md instructions for /home/test\nRules" }, { type: "text", text: prompt }, { type: "text", text: "Explain that template" }],
    [{ type: "text", text: "<environment_context>cwd</environment_context>" }, { type: "image", source: {} }, { type: "text", text: prompt }]
  ]) assert.equal(localCodexTitleCompletion({ model: "gpt-6-astra", messages: [{ role: "user", content }] }), null);
});

test("local titles cap Unicode characters and remove terminal controls", () => {
  const completion = localCodexTitleCompletion({ model: "gpt-6-astra", input: `${instruction}\n\nUser prompt:\n${"😀".repeat(40)}` });
  assert.equal(Array.from(completion.choices[0].message.content).length, 36);
  const control = localCodexTitleCompletion({ model: "gpt-6-astra", input: `${instruction}\n\nUser prompt:\nFix\u001b\nrequest\u202e.` });
  assert.equal(control.choices[0].message.content, "Fix request");
});

test("the exact recent-conversation title template is also handled locally", () => {
  const completion = localCodexTitleCompletion({
    model: "gpt-6-astra",
    input: `${instruction}\nPrioritize the current task and latest substantive user request.\n\nRecent conversation messages:\nOld task\nFix duplicate calls`
  });
  assert.equal(completion.choices[0].message.content, "Fix duplicate calls");
});
