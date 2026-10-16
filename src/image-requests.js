import { relayWireFor } from "./relay-agents.js";
import { isImageModel } from "./image-protocol.js";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function prepareImageTools(value, protocol) {
  const tools = Array.isArray(value?.tools) ? value.tools.filter((tool) => tool?.type === "image_generation") : [];
  if (!tools.length) return { request: value, tools: [] };
  if (relayWireFor(value.model) !== "responses" || isImageModel(value.model)) fail("The image_generation tool requires a Responses-backed text model; no model substitution is performed.");
  if (tools.length !== 1) fail("Specify only one image_generation tool.");
  const tool = tools[0];
  if (tool.action !== undefined && !["auto", "generate", "edit"].includes(tool.action)) fail("image_generation.action must be auto, generate or edit.");
  if (tool.partial_images !== undefined && (!Number.isInteger(tool.partial_images) || tool.partial_images < 0 || tool.partial_images > 3)) fail("image_generation.partial_images must be an integer from 0 to 3.");
  const request = { ...value, tools: value.tools.filter((entry) => entry !== tool) };
  let choice;
  if (value.tool_choice?.type === "image_generation" || (protocol === "anthropic" && value.tool_choice?.type === "tool" && value.tool_choice.name === "image_generation")) choice = { type: "image_generation" };
  else if (["auto", "none", "required"].includes(value.tool_choice)) choice = value.tool_choice;
  else if (protocol === "anthropic" && value.tool_choice?.type === "any") choice = "required";
  else if (protocol === "anthropic" && ["auto", "none"].includes(value.tool_choice?.type)) choice = value.tool_choice.type;
  if (choice !== undefined) delete request.tool_choice;
  return { request, tools: [tool], choice, parallel: protocol === "anthropic" && typeof value.tool_choice?.disable_parallel_tool_use === "boolean" ? !value.tool_choice.disable_parallel_tool_use : undefined };
}

export function applyImageTools(request, prepared) {
  if (!prepared.tools.length) return;
  request.tools = [...(request.tools || []), ...prepared.tools];
  if (prepared.choice !== undefined) request.tool_choice = prepared.choice;
  if (prepared.parallel !== undefined) request.parallel_tool_calls = prepared.parallel;
}

export async function multipartImageEdit(body, contentType, maxFileBytes = 16 * 1024 * 1024) {
  let form;
  try { form = await new Response(body, { headers: { "content-type": contentType } }).formData(); }
  catch { fail("Invalid multipart image edit body."); }
  const value = {};
  const images = [];
  let mask;
  const fields = new Set(["model", "prompt", "size", "quality", "background", "output_format", "output_compression", "input_fidelity", "n", "response_format", "moderation", "user", "stream", "partial_images"]);
  for (const [name, part] of form) {
    if (typeof part === "string") {
      if (!fields.has(name)) fail(`Unsupported multipart field: ${name}.`);
      if (Object.hasOwn(value, name)) fail(`Duplicate multipart field: ${name}.`);
      if (Buffer.byteLength(part) > 1024 * 1024) fail(`Multipart field ${name} exceeds the size limit.`);
      if (["n", "output_compression", "partial_images"].includes(name)) {
        if (!/^\d+$/.test(part) || !Number.isSafeInteger(Number(part))) fail(`Multipart ${name} must be an integer.`);
        value[name] = Number(part);
      } else if (name === "stream") {
        if (!["true", "false"].includes(part)) fail("Multipart stream must be true or false.");
        value[name] = part === "true";
      } else value[name] = part;
      continue;
    }
    if (!["image", "image[]", "mask"].includes(name)) fail(`Unsupported multipart file field: ${name}.`);
    if (!MIME_TYPES.has(part.type)) fail("Uploaded images must be PNG, JPEG or WebP.");
    if (!part.size || part.size > maxFileBytes) fail("Uploaded image is empty or exceeds the file size limit.");
    if (name === "mask" && mask) fail("Only one mask is supported.");
    if (name !== "mask" && images.length >= 16) fail("At most 16 source images are supported.");
    const bytes = Buffer.from(await part.arrayBuffer());
    const valid = part.type === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : part.type === "image/jpeg" ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (!valid) fail("Image bytes do not match the declared MIME type.");
    const reference = { image_url: `data:${part.type};base64,${bytes.toString("base64")}` };
    if (name === "mask") mask = reference;
    else images.push(reference);
  }
  if (!images.length) fail("Multipart edits require at least one image file.");
  if (typeof value.model !== "string" || !value.model.trim() || typeof value.prompt !== "string" || !value.prompt.trim()) fail("Multipart edits require model and prompt.");
  return { ...value, images, ...(mask ? { mask } : {}) };
}

export function imagesToResponses(value, action) {
  if (!object(value) || relayWireFor(value.model) !== "responses" || isImageModel(value.model)) fail("Streaming image conversion requires a Responses-backed text model.");
  const allowed = new Set(["model", "prompt", "images", "mask", "size", "quality", "background", "output_format", "output_compression", "moderation", "partial_images", "n", "response_format", "stream"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`The streaming image bridge cannot preserve ${key}; use non-streaming or native Responses.`);
  if (value.n !== undefined && value.n !== 1) fail("The streaming image bridge supports n=1 only.");
  if (value.response_format !== undefined && value.response_format !== "b64_json") fail("The streaming image bridge returns base64 images, not hosted URLs.");
  if (typeof value.prompt !== "string" || !value.prompt.trim()) fail("An image prompt is required.");
  if (value.images !== undefined && !Array.isArray(value.images)) fail("images must be an array.");
  if (action === "edit" && !value.images?.length) fail("Image editing requires source images.");
  if (action === "generate" && (value.images?.length || value.mask)) fail("Source images and masks require the edits endpoint.");
  if ((value.images?.length || 0) > 16) fail("At most 16 source images are supported.");
  const content = [{ type: "input_text", text: value.prompt }];
  for (const image of value.images || []) {
    if (!object(image) || Object.keys(image).some((key) => !["image_url", "file_id"].includes(key)) || Boolean(image.image_url) === Boolean(image.file_id)) fail("Source images require exactly one image_url or file_id.");
    const reference = image.image_url ?? image.file_id;
    if (typeof reference !== "string" || !reference.trim()) fail("Invalid source image reference.");
    content.push({ type: "input_image", ...image });
  }
  const tool = { type: "image_generation", action };
  for (const key of ["size", "quality", "background", "output_format", "output_compression", "moderation", "partial_images"]) if (value[key] !== undefined) tool[key] = value[key];
  if (value.mask !== undefined) {
    if (!object(value.mask) || Object.keys(value.mask).some((key) => !["image_url", "file_id"].includes(key)) || Boolean(value.mask.image_url) === Boolean(value.mask.file_id)) fail("mask requires exactly one image_url or file_id.");
    tool.input_image_mask = value.mask;
  }
  const request = { model: value.model, input: [{ role: "user", content }], tools: [tool], tool_choice: { type: "image_generation" }, stream: true, store: false };
  prepareImageTools(request, "chat");
  return request;
}
