import { randomUUID } from "node:crypto";

export const IMAGE_RESPONSE_BYTES = 64 * 1024 * 1024;
export const IMAGE_FRAME_BYTES = 32 * 1024 * 1024;
export const isImageModel = (model) => typeof model === "string" && /^(?:gpt-image(?:-|$)|dall-e-[23]$)/i.test(model.trim());
export const hasImageTool = (value) => Array.isArray(value?.tools) && value.tools.some((tool) => tool?.type === "image_generation");
export const imageStreamLimits = (value) => hasImageTool(value) ? { maxBytes: IMAGE_RESPONSE_BYTES, maxFrameBytes: IMAGE_FRAME_BYTES } : {};

export function imageConversationRequest(value, protocol) {
  const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected a JSON object.");
  if (value.stream !== undefined && typeof value.stream !== "boolean") fail("stream must be a boolean.");
  if (value.tools?.length || value.tool_choice != null) fail("Image models do not accept conversation tools; use a text model with the Responses image_generation tool instead.");
  if (value.previous_response_id || value.conversation) fail("Image-model conversations require explicit source images, not stored history references.");
  const messages = protocol === "responses" ? (typeof value.input === "string" ? [{ role: "user", content: value.input }] : value.input) : value.messages;
  if (!Array.isArray(messages) || !messages.length) fail("Provide a user prompt.");
  const message = messages.findLast((item) => item?.role === "user");
  if (!message) fail("Provide a user message for image generation or editing.");
  const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  if (!Array.isArray(parts)) fail("User content must be text or an array.");
  const text = [];
  const images = [];
  for (const part of parts) {
    if (["text", "input_text"].includes(part?.type) && typeof part.text === "string") text.push(part.text);
    else if (part?.type === "image_url" && typeof part.image_url?.url === "string") images.push({ image_url: part.image_url.url });
    else if (part?.type === "input_image" && typeof part.image_url === "string") images.push({ image_url: part.image_url });
    else if (part?.type === "input_image" && typeof part.file_id === "string") images.push({ file_id: part.file_id });
    else if (part?.type === "image" && part.source?.type === "url" && typeof part.source.url === "string") images.push({ image_url: part.source.url });
    else if (part?.type === "image" && part.source?.type === "base64" && /^image\/(?:png|jpeg|webp|gif)$/.test(part.source.media_type) && typeof part.source.data === "string") images.push({ image_url: `data:${part.source.media_type};base64,${part.source.data}` });
    else fail("Unsupported image prompt content; provide text and explicit source images.");
  }
  const prompt = text.join("\n").trim();
  if (!prompt) fail("An image prompt is required.");
  if (images.length > 16) fail("At most 16 source images are supported.");
  if (value.image_options != null && (typeof value.image_options !== "object" || Array.isArray(value.image_options))) fail("image_options must be an object.");
  const body = { model: value.model, prompt };
  for (const field of ["size", "quality", "background", "output_format", "output_compression", "input_fidelity", "n", "response_format", "moderation", "mask", "user"]) {
    const option = value.image_options?.[field] ?? value[field];
    if (option !== undefined) body[field] = option;
  }
  if (images.length) body.images = images;
  return { path: images.length ? "/v1/images/edits" : "/v1/images/generations", body };
}

export async function forwardImageConversation(response, upstream, request, protocol) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of upstream.body) {
    bytes += chunk.byteLength;
    if (bytes > IMAGE_RESPONSE_BYTES) throw new Error("Image response exceeds the size limit.");
    chunks.push(chunk);
  }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("The image relay returned invalid JSON."); }
  if (!Array.isArray(payload.data) || !payload.data.length) throw new Error("The image relay returned no images.");
  const format = request.image_options?.output_format || request.output_format || payload.output_format || "png";
  const mime = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
  const urls = payload.data.map((image) => typeof image.b64_json === "string" && image.b64_json
    ? `data:${mime};base64,${image.b64_json}`
    : typeof image.url === "string" && /^https?:\/\//i.test(image.url) ? image.url : null);
  if (urls.some((url) => !url)) throw new Error("The image relay returned an invalid image.");
  const text = urls.map((url, index) => `![Generated image ${index + 1}](${url})`).join("\n\n");
  const id = `img_${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const input = payload.usage?.input_tokens ?? 0;
  const output = payload.usage?.output_tokens ?? 0;
  const usage = { prompt_tokens: input, completion_tokens: output, total_tokens: payload.usage?.total_tokens ?? input + output };
  let body;
  if (protocol === "anthropic") body = { id, type: "message", role: "assistant", model: request.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: input, output_tokens: output } };
  else if (protocol === "responses") body = { id: `resp_${id}`, object: "response", created_at: created, status: "completed", model: request.model, store: false, output: payload.data.map((image, index) => image.b64_json ? { type: "image_generation_call", id: `${id}_${index}`, status: "completed", result: image.b64_json, output_format: format, ...(image.revised_prompt ? { revised_prompt: image.revised_prompt } : {}) } : { type: "message", id: `${id}_${index}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `![Generated image](${urls[index]})`, annotations: [] }] }), usage: { input_tokens: input, output_tokens: output, total_tokens: usage.total_tokens } };
  else body = { id: `chatcmpl-${id}`, object: "chat.completion", created, model: request.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage };
  if (!request.stream) {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(body));
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  const event = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  if (protocol === "anthropic") {
    event("message_start", { message: { ...body, content: [], stop_reason: null, usage: { input_tokens: input, output_tokens: 0 } } });
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: output } });
    event("message_stop", {});
  } else if (protocol === "responses") {
    let sequence = 0;
    event("response.created", { sequence_number: sequence++, response: { ...body, output: [], status: "in_progress" } });
    for (const [index, item] of body.output.entries()) {
      event("response.output_item.added", { sequence_number: sequence++, output_index: index, item: { ...item, result: undefined, status: "in_progress" } });
      event("response.output_item.done", { sequence_number: sequence++, output_index: index, item });
    }
    event("response.completed", { sequence_number: sequence++, response: body });
  } else {
    const envelope = { id: body.id, object: "chat.completion.chunk", created, model: request.model };
    response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(request.stream_options?.include_usage ? { usage } : {}) })}\n\n`);
    response.write("data: [DONE]\n\n");
  }
  response.end();
}
