export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_SSE_FRAME_BYTES = 2 * 1024 * 1024;
const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"]);

function mergeItem(previous, incoming) {
  const merged = { ...previous, ...incoming };
  // Empty/partial envelopes are common on the relay. Keep collected parts, but let a newer
  // snapshot replace each field it actually supplies (especially phase and encrypted_content).
  for (const field of ["content", "summary"]) {
    if (!Array.isArray(previous[field]) || !Array.isArray(incoming[field])) continue;
    merged[field] = previous[field].slice();
    for (const [index, part] of incoming[field].entries()) merged[field][index] = { ...merged[field][index], ...part };
  }
  return merged;
}

function mergeEnvelope(previous, incoming) {
  const merged = { ...previous, ...incoming };
  if (previous.usage && incoming.usage) {
    merged.usage = { ...previous.usage, ...incoming.usage };
    for (const field of ["input_tokens_details", "output_tokens_details"]) {
      if (previous.usage[field] && incoming.usage[field]) merged.usage[field] = { ...previous.usage[field], ...incoming.usage[field] };
    }
  }
  return merged;
}

export class ResponseState {
  constructor({ maxBytes = MAX_RESPONSE_BYTES, maxItems = 4096 } = {}) {
    this.maxBytes = maxBytes;
    this.maxItems = maxItems;
    this.records = [];
    this.byId = new Map();
    this.byIndex = new Map();
    this.bytes = 0;
    this.envelope = {};
    this.envelopeBytes = 0;
    this.terminal = null;
  }

  remember(item, index, done = false) {
    if (!item || typeof item !== "object") throw new Error("The upstream response item is invalid.");
    let record = item.id ? this.byId.get(item.id) : this.byIndex.get(index);
    if (!record && Number.isInteger(index)) {
      const candidate = this.byIndex.get(index);
      if (candidate && (!item.id || !candidate.item.id || candidate.item.id === item.id)) record = candidate;
    }
    if (!record) {
      if (this.records.length >= this.maxItems) throw new Error("The upstream response contains too many output items.");
      const position = Number.isInteger(index) && !this.byIndex.has(index) ? index : this.records.length;
      record = { index: position, order: this.records.length, item: {}, bytes: 0, done: false, observed: false };
      this.records.push(record);
      this.byIndex.set(position, record);
    }
    const merged = mergeItem(record.item, item);
    const size = Buffer.byteLength(JSON.stringify(merged));
    if (this.bytes - record.bytes + size + this.envelopeBytes > this.maxBytes) throw new Error("The upstream response exceeds the aggregate size limit.");
    this.bytes += size - record.bytes;
    record.bytes = size;
    record.item = merged;
    record.done ||= done;
    if (item.id) this.byId.set(item.id, record);
    return record;
  }

  rememberEnvelope(response) {
    const { output, ...metadata } = response;
    const envelope = mergeEnvelope(this.envelope, metadata);
    const size = Buffer.byteLength(JSON.stringify(envelope));
    if (this.bytes + size > this.maxBytes) throw new Error("The upstream response exceeds the aggregate size limit.");
    this.envelope = envelope;
    this.envelopeBytes = size;
  }

  acceptContent(event) {
    const scalar = {
      "response.function_call_arguments.delta": ["function_call", "arguments", "delta"],
      "response.function_call_arguments.done": ["function_call", "arguments", "arguments"],
      "response.custom_tool_call_input.delta": ["custom_tool_call", "input", "delta"],
      "response.custom_tool_call_input.done": ["custom_tool_call", "input", "input"]
    }[event.type];
    const partText = {
      "response.output_text.delta": ["content", "content_index", "output_text", "text", "delta"],
      "response.output_text.done": ["content", "content_index", "output_text", "text", "text"],
      "response.refusal.delta": ["content", "content_index", "refusal", "refusal", "delta"],
      "response.refusal.done": ["content", "content_index", "refusal", "refusal", "refusal"],
      "response.reasoning_summary_text.delta": ["summary", "summary_index", "summary_text", "text", "delta"],
      "response.reasoning_summary_text.done": ["summary", "summary_index", "summary_text", "text", "text"],
      "response.reasoning_text.delta": ["content", "content_index", "reasoning_text", "text", "delta"],
      "response.reasoning_text.done": ["content", "content_index", "reasoning_text", "text", "text"]
    }[event.type];
    const partEvent = ["response.content_part.added", "response.content_part.done", "response.reasoning_summary_part.added", "response.reasoning_summary_part.done"].includes(event.type);
    const annotationEvent = event.type === "response.output_text.annotation.added";
    if (!scalar && !partText && !partEvent && !annotationEvent) return;
    if (!event.item_id && !Number.isInteger(event.output_index)) return;
    const existing = event.item_id ? this.byId.get(event.item_id) : this.byIndex.get(event.output_index);
    if (existing?.done) return;
    const item = { ...(existing?.item || {}), ...(event.item_id ? { id: event.item_id } : {}) };
    if (scalar) {
      const [type, field, source] = scalar;
      if (typeof event[source] !== "string") throw new Error("The upstream response delta is invalid.");
      item.type ||= type;
      item[field] = source === "delta" ? (item[field] || "") + event[source] : event[source];
    } else {
      const field = partText?.[0] || (event.type.includes("reasoning_summary") ? "summary" : "content");
      const index = event[partText?.[1] || (field === "summary" ? "summary_index" : "content_index")] ?? 0;
      if (!Number.isInteger(index) || index < 0 || index >= this.maxItems) throw new Error("The upstream response contains too many content parts.");
      const parts = (item[field] || []).slice();
      if (annotationEvent) {
        if (!Number.isInteger(event.annotation_index) || event.annotation_index < 0 || event.annotation_index >= this.maxItems || !event.annotation || typeof event.annotation !== "object") throw new Error("The upstream response annotation is invalid.");
        const annotations = (parts[index]?.annotations || []).slice();
        annotations[event.annotation_index] = event.annotation;
        parts[index] = { type: "output_text", text: "", ...parts[index], annotations };
      } else if (partText) {
        const [, , type, textField, source] = partText;
        if (typeof event[source] !== "string") throw new Error("The upstream response delta is invalid.");
        parts[index] = { ...parts[index], type, [textField]: source === "delta" ? (parts[index]?.[textField] || "") + event[source] : event[source] };
      } else {
        if (!event.part || typeof event.part !== "object") throw new Error("The upstream response content part is invalid.");
        parts[index] = { ...parts[index], ...event.part };
      }
      item.type ||= field === "summary" || event.type.startsWith("response.reasoning_") ? "reasoning" : "message";
      item[field] = parts;
    }
    const record = this.remember(item, event.output_index);
    record.observed = true;
  }

  accept(event) {
    if (this.terminal) return null;
    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      const record = this.remember(event.item, event.output_index, event.type.endsWith(".done"));
      return { ...event, item: record.item };
    } else if (TERMINAL_EVENTS.has(event.type)) {
      if (!event.response || typeof event.response !== "object") throw new Error("The upstream terminal event has no response object.");
      this.rememberEnvelope(event.response);
      const output = event.response.output ?? [];
      if (!Array.isArray(output)) throw new Error("The upstream response output is not an array.");
      for (const [index, item] of output.entries()) this.remember(item, index, true);
      const repaired = this.records.filter((record) => record.done || record.observed).sort((left, right) => left.index - right.index || left.order - right.order).map((record) => record.item);
      const status = event.response.status ?? event.type.slice("response.".length);
      const terminal = { ...event, response: { ...this.envelope, status, ...(repaired.length || event.response.output ? { output: repaired } : {}) } };
      if (Buffer.byteLength(JSON.stringify(terminal)) > this.maxBytes) throw new Error("The upstream response exceeds the aggregate size limit.");
      this.terminal = terminal;
      return terminal;
    } else if (event.type === "error") {
      this.terminal = event;
    } else if (["response.created", "response.in_progress", "response.queued"].includes(event.type) && event.response) {
      this.rememberEnvelope(event.response);
    } else {
      this.acceptContent(event);
    }
    return event;
  }
}
