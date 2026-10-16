import { responseEvents } from "./responses-bridge.js";
import { MAX_RESPONSE_BYTES } from "./response-state.js";

export async function readAnthropicCompletion(upstream) {
  let message;
  const blocks = new Map();
  const inputs = new Map();
  const active = new Set();
  let bytes = 0;
  for await (const event of responseEvents(upstream.body)) {
    bytes += Buffer.byteLength(JSON.stringify(event));
    if (bytes > MAX_RESPONSE_BYTES) throw new Error("The upstream message exceeds the non-streaming response limit.");
    if (event.type === "error") throw new Error(event.error?.message || "The upstream message stream reported an error.");
    if (event.type === "ping") continue;
    if (event.type === "message_start") {
      if (message || !event.message) throw new Error("Invalid upstream message start.");
      message = { ...event.message, content: [] };
      continue;
    }
    if (!message) throw new Error("The upstream stream is missing its message start.");
    if (event.type === "content_block_start") {
      if (!Number.isInteger(event.index) || event.index < 0 || blocks.has(event.index) || !event.content_block) throw new Error("Invalid upstream content block.");
      blocks.set(event.index, structuredClone(event.content_block));
      active.add(event.index);
    } else if (event.type === "content_block_delta") {
      const block = blocks.get(event.index);
      if (!active.has(event.index)) throw new Error("The upstream delta has no active content block.");
      const delta = event.delta;
      const field = { text_delta: "text", thinking_delta: "thinking", signature_delta: "signature" }[delta?.type];
      if (field && typeof delta[field] === "string") block[field] = (block[field] || "") + delta[field];
      else if (delta?.type === "input_json_delta") inputs.set(event.index, (inputs.get(event.index) || "") + delta.partial_json);
      else if (delta?.type === "citations_delta") (block.citations ||= []).push(delta.citation);
      else throw new Error("Unsupported upstream content block delta.");
    } else if (event.type === "content_block_stop") {
      if (!active.delete(event.index)) throw new Error("The upstream stopped an inactive content block.");
      if (inputs.has(event.index)) {
        const input = JSON.parse(inputs.get(event.index));
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("The upstream tool input must be an object.");
        blocks.get(event.index).input = input;
      }
    } else if (event.type === "message_delta") {
      Object.assign(message, event.delta);
      if (event.usage) message.usage = { ...message.usage, ...event.usage };
    } else if (event.type === "message_stop") {
      if (active.size || !message.stop_reason) throw new Error("The upstream message stopped before it completed.");
      message.content = [...blocks].sort(([left], [right]) => left - right).map(([, block]) => block);
      return message;
    }
  }
  throw new Error("The upstream message stream ended before it completed.");
}
