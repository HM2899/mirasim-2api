import assert from "node:assert/strict";
import test from "node:test";
import { imageConversationRequest, imagesResponseFromChat, imagesToChatRequest, isGeminiImageModel, isImageModel } from "../src/image-protocol.js";

test("image model detection is namespace scoped and does not invent model aliases", () => {
  for (const model of ["gpt-image-1", "gpt-image-2.5-sunburst", "dall-e-3"]) assert.equal(isImageModel(model), true);
  for (const model of ["gpt-6-astra", "claude-sonnet-5", "my-gpt-image", null]) assert.equal(isImageModel(model), false);
});

test("chat image editing preserves explicit image references and image options", () => {
  const result = imageConversationRequest({ model: "gpt-image-1", messages: [
    { role: "assistant", content: "An old result" },
    { role: "user", content: [{ type: "text", text: "Make it blue" }, { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }] }
  ], image_options: { size: "1024x1024", quality: "high", mask: { image_url: "https://example.test/mask.png" } } }, "chat");
  assert.equal(result.path, "/v1/images/edits");
  assert.deepEqual(result.body.images, [{ image_url: "data:image/png;base64,YQ==" }]);
  assert.equal(result.body.prompt, "Make it blue");
  assert.equal(result.body.quality, "high");
  assert.equal(result.body.stream, undefined);
});

test("Anthropic base64 image blocks and Responses file references map to image edits", () => {
  const message = { model: "gpt-image-1", messages: [{ role: "user", content: [{ type: "text", text: "Edit" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } }] }] };
  assert.deepEqual(imageConversationRequest(message, "anthropic").body.images, [{ image_url: "data:image/png;base64,YQ==" }]);
  assert.deepEqual(imageConversationRequest({ model: "gpt-image-1", input: [{ role: "user", content: [{ type: "input_text", text: "Edit" }, { type: "input_image", file_id: "file-existing" }] }] }, "responses").body.images, [{ file_id: "file-existing" }]);
});

test("unsupported image conversations fail rather than silently discarding tools or history", () => {
  const base = { model: "gpt-image-1", messages: [{ role: "user", content: "Draw a tree" }] };
  for (const extra of [{ tools: [{ type: "function" }] }, { stream: "true" }, { previous_response_id: "resp-old" }, { image_options: [] }, { messages: [{ role: "user", content: [{ type: "audio" }] }] }]) assert.throws(() => imageConversationRequest({ ...base, ...extra }, "chat"), (error) => error.statusCode === 400);
});

test("only the gemini image namespace is bridged, every other image name keeps its raw route", () => {
  for (const model of ["gemini-3-pro-image", "gemini-3.1-flash-image", "gemini-3.1-flash-image-preview", " Gemini-4-flash-image "]) assert.equal(isGeminiImageModel(model), true);
  for (const model of ["gpt-image-1", "dall-e-3", "gemini-3.1-pro-preview", "gemini-2.5-flash", "my-gemini-image", null]) assert.equal(isGeminiImageModel(model), false);
});

test("a gemini image request carries the prompt, source images and only the options chat can hold", () => {
  assert.deepEqual(
    imagesToChatRequest({ model: "gemini-3-pro-image", prompt: "A cat", size: "1024x1024", quality: "high" }, "generate"),
    { model: "gemini-3-pro-image", messages: [{ role: "user", content: "A cat" }], stream: false, size: "1024x1024", quality: "high" }
  );
  const edit = imagesToChatRequest({ model: "gemini-3.1-flash-image", prompt: "Replace the sky", images: [{ image_url: "data:image/png;base64,YQ==" }] }, "edit");
  assert.deepEqual(edit.messages, [{
    role: "user",
    content: [
      { type: "text", text: "Replace the sky" },
      { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }
    ]
  }]);
  assert.equal(edit.images, undefined);
  assert.equal(edit.stream, false);
});

test("options the gemini bridge cannot translate fail instead of being dropped", () => {
  const base = { model: "gemini-3-pro-image", prompt: "A cat" };
  const source = [{ image_url: "data:image/png;base64,YQ==" }];
  for (const extra of [
    { n: 2 },
    { response_format: "url" },
    { stream: true },
    { mask: { image_url: "data:image/png;base64,YQ==" } },
    { output_format: "webp" },
    { output_compression: 50 },
    { user: "someone", partial_images: 2 },
    { tools: [] }
  ]) assert.throws(() => imagesToChatRequest({ ...base, ...extra }, "generate"), (error) => error.statusCode === 400, JSON.stringify(extra));
  // A promptless request and a file_id reference cannot be translated either.
  assert.throws(() => imagesToChatRequest({ model: "gemini-3-pro-image" }, "generate"), (error) => error.statusCode === 400);
  assert.throws(() => imagesToChatRequest({ ...base, images: [{ file_id: "file-1" }] }, "edit"), (error) => error.statusCode === 400);
  // Source images belong to the edits endpoint, and edits need one.
  assert.throws(() => imagesToChatRequest({ ...base, images: source }, "generate"), (error) => error.statusCode === 400);
  assert.throws(() => imagesToChatRequest(base, "edit"), (error) => error.statusCode === 400);
});

test("the chat answer becomes the image payload the images API promises", () => {
  const payload = imagesResponseFromChat({ choices: [{ message: { content: "Here you go.\n\n![Generated image 1](data:image/jpeg;base64,YWJj)" } }] }, "gemini-3-pro-image");
  assert.equal(payload.model, "gemini-3-pro-image");
  assert.deepEqual(payload.data, [{ b64_json: "YWJj" }]);
  assert.ok(Number.isInteger(payload.created) && payload.created > 0);
  const parts = imagesResponseFromChat({ choices: [{ message: { content: [{ type: "text", text: "![Generated image 1](data:image/png;base64,YQ==)" }] } }] }, "gemini-3-pro-image");
  assert.deepEqual(parts.data, [{ b64_json: "YQ==" }]);
  // A text-only answer is an error, never an invented image.
  assert.throws(() => imagesResponseFromChat({ choices: [{ message: { content: "I cannot draw that." } }] }, "gemini-3-pro-image"), /no image/i);
});
