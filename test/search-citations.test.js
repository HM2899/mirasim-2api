import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Transform } from "node:stream";
import { randomUUID } from "node:crypto";
import { responsesUpstreamAsChat, normalizeResponsesStream } from "../src/responses-bridge.js";
import { readChatCompletion, ensureChatCompletionStream, normalizeChatUpstream } from "../src/chat-completion.js";
import { readAnthropicCompletion } from "../src/anthropic-completion.js";
import { ThinkTagFilter, splitThinkTags } from "../src/think-tags.js";

const citation = { type: "url_citation", url: "https://example.com/source", title: "Source", start_index: 0, end_index: 2 };
const item = (id, text, annotations = [citation]) => ({ id, type: "message", content: [{ type: "output_text", text, annotations }] });
const response = (output) => new Response(JSON.stringify({ id: "resp_test", status: "completed", output }), { headers: { "content-type": "application/json" } });
const stream = (events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

test("citations survive Chat JSON/SSE roundtrip with rebased repeated URLs and emoji", async () => {
  const completion = await readChatCompletion(responsesUpstreamAsChat(response([item("one", "😀前文"), item("two", "正文")]), "test"));
  const message = completion.choices[0].message;
  assert.equal(message.annotations.length, 2);
  for (const [index, text] of ["😀", "正文"].entries()) {
    const range = message.annotations[index].url_citation;
    assert.equal(message.content.slice(range.start_index, range.end_index), text);
  }
  const replay = await readChatCompletion(await ensureChatCompletionStream(new Response(JSON.stringify(completion), { headers: { "content-type": "application/json" } })));
  assert.deepEqual(replay.choices[0].message.annotations, message.annotations);
  const normalized = await readChatCompletion(await normalizeChatUpstream(await ensureChatCompletionStream(new Response(JSON.stringify(completion), { headers: { "content-type": "application/json" } }))));
  assert.deepEqual(normalized.choices[0].message.annotations, message.annotations);
});

test("annotation-only events survive partial terminal envelopes and repeated snapshots", async () => {
  const events = [
    { type: "response.output_item.added", output_index: 0, item: item("one", "", []) },
    { type: "response.output_text.delta", item_id: "one", output_index: 0, content_index: 0, delta: "正文" },
    { type: "response.output_text.annotation.added", item_id: "one", output_index: 0, content_index: 0, annotation_index: 0, annotation: citation },
    { type: "response.output_item.done", output_index: 0, item: { id: "one", type: "message" } },
    { type: "response.completed", response: { status: "completed", output: [] } }
  ];
  const completion = await readChatCompletion(responsesUpstreamAsChat(stream(events), "test"));
  assert.equal(completion.choices[0].message.annotations.length, 1);
});

test("invalid URLs, invalid ranges and commentary cannot become answer citations", async () => {
  const output = [
    { ...item("thought", "思考"), phase: "commentary" },
    item("answer", "正文", [{ ...citation, url: "javascript:alert(1)" }, { ...citation, start_index: -1 }, { ...citation, end_index: 99 }])
  ];
  const completion = await readChatCompletion(responsesUpstreamAsChat(response(output), "test", { commentaryAsReasoning: true }));
  assert.equal(completion.choices[0].message.annotations, undefined);
});

test("multiple content parts rebase citations without collapsing repeated URLs", async () => {
  const output = [item("one", "前文")];
  output[0].content.push({ type: "output_text", text: "正文", annotations: [citation] });
  const completion = await readChatCompletion(responsesUpstreamAsChat(response(output), "test"));
  assert.deepEqual(completion.choices[0].message.annotations.map((annotation) => annotation.url_citation.start_index), [0, 2]);
});

test("native Responses retains structured citations", async () => {
  const output = [item("one", "正文")];
  const upstream = normalizeResponsesStream(stream([{ type: "response.completed", response: { status: "completed", output } }]));
  const wire = await upstream.text();
  assert.match(wire, /"annotations":\[\{"type":"url_citation"/);
});

for (const streaming of [false, true]) {
  test(`think-tag normalization does not retain stale citation offsets (stream=${streaming})`, async () => {
    const annotations = [{ type: "url_citation", url_citation: { ...citation, start_index: 20, end_index: 22 } }];
    const completion = { choices: [{ index: 0, message: { role: "assistant", content: "<think>secret</think>正文", annotations }, finish_reason: "stop" }] };
    let upstream = new Response(JSON.stringify(completion), { headers: { "content-type": "application/json" } });
    if (streaming) upstream = await ensureChatCompletionStream(upstream);
    const normalized = await readChatCompletion(await normalizeChatUpstream(upstream));
    assert.equal(normalized.choices[0].message.content, "正文");
    assert.equal(normalized.choices[0].message.annotations, undefined);
  });
}

test("Anthropic JSON and SSE expose honest gateway citations, not forged native search IDs", async () => {
  const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const begin = source.indexOf("function chatCompletionToAnthropicMessage(");
  const end = source.indexOf("const CHAT_UPSTREAM_FIELDS", begin);
  const context = vm.createContext({ Transform, randomUUID, ThinkTagFilter, splitThinkTags, TextDecoder, Buffer, MAX_RESPONSE_BYTES: 16 * 1024 * 1024, MAX_SSE_FRAME_BYTES: 2 * 1024 * 1024 });
  vm.runInContext(source.slice(begin, end), context);
  const idStart = source.indexOf("function messageId(");
  vm.runInContext(source.slice(idStart, source.indexOf("\n}", idStart) + 2), context);
  const completion = await readChatCompletion(responsesUpstreamAsChat(response([item("one", "正文")]), "test"));
  const json = context.chatCompletionToAnthropicMessage(completion, "test");
  assert.equal(JSON.stringify(json.mirasim_annotations), JSON.stringify(completion.choices[0].message.annotations));
  const chat = await ensureChatCompletionStream(new Response(JSON.stringify(completion), { headers: { "content-type": "application/json" } }));
  const transform = context.createChatAnthropicStreamTransform("test");
  const chunks = [];
  transform.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => { transform.on("end", resolve); transform.on("error", reject); });
  transform.end(Buffer.from(await chat.text()));
  await finished;
  const message = await readAnthropicCompletion(new Response(Buffer.concat(chunks), { headers: { "content-type": "text/event-stream" } }));
  assert.deepEqual(message.mirasim_annotations, completion.choices[0].message.annotations);
  assert.doesNotMatch(JSON.stringify(message), /encrypted_index|web_search_result_location/);
});

test("Chat citations convert back into Responses JSON and SSE annotations", async () => {
  const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const begin = source.indexOf("function chatAnnotationsToResponses(");
  const end = source.indexOf("function thinkingRungOf(", begin);
  const context = vm.createContext({ Transform, randomUUID, ThinkTagFilter, splitThinkTags, TextDecoder, Buffer, URL });
  vm.runInContext(source.slice(begin, end), context);
  const completion = await readChatCompletion(responsesUpstreamAsChat(response([item("one", "正文")]), "test"));
  const json = context.chatCompletionToResponse(completion, { model: "test" });
  assert.equal(JSON.stringify(json.output[0].content[0].annotations), JSON.stringify([citation]));
  const state = { request: { model: "test" }, created: false, completed: false, createdAt: 0, id: "resp_test", messageId: "msg_test", model: "test", sequence: 0, finishReason: null, usage: null, nextOutputIndex: 0, reasoning: null, message: null, toolCalls: new Map(), thinkFilter: new ThinkTagFilter() };
  const chat = await ensureChatCompletionStream(new Response(JSON.stringify(completion), { headers: { "content-type": "application/json" } }));
  let wire = "";
  for (const frame of (await chat.text()).split("\n\n")) wire += context.responsesEventsForChatFrame(frame, state);
  const events = wire.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5)));
  assert.deepEqual(events.find((event) => event.type === "response.output_text.annotation.added").annotation, citation);
  assert.deepEqual(events.find((event) => event.type === "response.completed").response.output[0].content[0].annotations, [citation]);
});
