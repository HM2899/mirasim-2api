import assert from "node:assert/strict";
import test from "node:test";
import { prepareImageTools, applyImageTools, multipartImageEdit, imagesToResponses } from "../src/image-requests.js";
import { responsesAsImageStream } from "../src/image-stream.js";

test("image tools preserve prompt fields and existing client tools without mutation", () => {
  const tool = { type: "image_generation", action: "edit", quality: "low" };
  const client = { type: "function", function: { name: "check", parameters: {} } };
  const source = { model: "gpt-6-astra", system: "UNCHANGED", instructions: "EXACT", messages: [{ role: "user", content: "edit" }], tools: [tool, client], tool_choice: { type: "image_generation" } };
  const before = structuredClone(source);
  const prepared = prepareImageTools(source, "chat");
  assert.deepEqual(prepared.request.tools, [client]);
  assert.equal(prepared.request.system, source.system);
  assert.equal(prepared.request.instructions, source.instructions);
  const request = { tools: [{ type: "function", name: "check" }] };
  applyImageTools(request, prepared);
  assert.deepEqual(request.tools[1], tool);
  assert.deepEqual(request.tool_choice, { type: "image_generation" });
  assert.deepEqual(source, before);
  assert.throws(() => prepareImageTools({ ...source, model: "claude-opus-5" }, "chat"), /Responses-backed/);
});

test("image streaming input preserves model, prompt, image references and mask without adding instructions", () => {
  const request = imagesToResponses({ model: "gpt-6-astra", prompt: "EXACT", images: [{ file_id: "file_source" }], mask: { image_url: "https://example.test/mask.png" }, quality: "low", partial_images: 1 }, "edit");
  assert.equal(request.model, "gpt-6-astra");
  assert.equal(request.instructions, undefined);
  assert.equal(request.input[0].content[0].text, "EXACT");
  assert.deepEqual(request.input[0].content[1], { type: "input_image", file_id: "file_source" });
  assert.deepEqual(request.tools[0].input_image_mask, { image_url: "https://example.test/mask.png" });
  for (const extra of [{ n: 2 }, { response_format: "url" }, { user: "unmapped" }, { partial_images: 9 }]) assert.throws(() => imagesToResponses({ model: "gpt-6-astra", prompt: "draw", ...extra }, "generate"));
});

async function parseForm(form, max) {
  const encoded = new Response(form);
  return multipartImageEdit(Buffer.from(await encoded.arrayBuffer()), encoded.headers.get("content-type"), max);
}

test("multipart files are encoded losslessly and typed fields retained", async () => {
  const bytes = Buffer.from([137,80,78,71,13,10,26,10,0,255,128]);
  const form = new FormData();
  for (const [name, value] of Object.entries({ model: "gpt-6-astra", prompt: "Edit", stream: "true", n: "1" })) form.append(name, value);
  form.append("image[]", new Blob([bytes], { type: "image/png" }), "source.png");
  form.append("mask", new Blob([bytes], { type: "image/png" }), "mask.png");
  const result = await parseForm(form);
  assert.equal(result.stream, true);
  assert.equal(result.n, 1);
  assert.deepEqual(Buffer.from(result.images[0].image_url.split(",")[1], "base64"), bytes);
  assert.deepEqual(result.mask, result.images[0]);
  await assert.rejects(parseForm(form, 5), /size limit/);
});

test("malformed multipart, duplicate fields and disguised files are rejected", async () => {
  await assert.rejects(multipartImageEdit(Buffer.from("invalid"), "multipart/form-data; boundary=x"), /Invalid multipart/);
  const form = new FormData();
  form.append("prompt", "first");form.append("prompt", "second");
  await assert.rejects(parseForm(form), /Duplicate/);
  const invalid = new FormData();
  invalid.append("image", new Blob(["not png"], { type: "image/png" }), "bad.png");
  await assert.rejects(parseForm(invalid), /MIME type/);
});

test("native image partials are relayed before the final result without inventing previews", async () => {
  let controller;
  const upstream = new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "content-type": "text/event-stream" } });
  const reader = responsesAsImageStream(upstream, "edit").body.getReader();
  controller.enqueue(Buffer.from('data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"preview","partial_image_index":0}\n\n'));
  const partial = new TextDecoder().decode((await reader.read()).value);
  assert.match(partial, /image_edit.partial_image/);
  const image = { type: "image_generation_call", id: "img", status: "completed", result: "final", output_format: "png" };
  controller.enqueue(Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [image] } })}\n\n`));
  controller.close();
  assert.match(new TextDecoder().decode((await reader.read()).value), /image_edit.completed/);
  assert.equal((await reader.read()).done, true);
});

test("empty and incomplete image streams fail instead of fabricating completion", async () => {
  for (const event of [{ type: "response.completed", response: { status: "completed", output: [] } }, { type: "response.incomplete", response: { status: "incomplete", output: [] } }]) {
    const wire = await responsesAsImageStream(new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } }), "generate").text();
    assert.match(wire, /image_stream_error/);
    assert.doesNotMatch(wire, /event: image_generation.completed/);
  }
});

test("cancelling a native image adapter releases the upstream stream", async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"preview","partial_image_index":0}\n\n')); },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } });
  const reader = responsesAsImageStream(upstream, "generate").body.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cancelled, true);
});
