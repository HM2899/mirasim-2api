const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const invalid = (path, message) => `${path}: ${message}`;

function validateControls(value, tokenFields) {
  for (const field of ["stream", "parallel_tool_calls"]) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") return invalid(field, "expected a boolean.");
  }
  for (const field of tokenFields) {
    if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || value[field] <= 0)) return invalid(field, "expected a positive integer.");
  }
  return null;
}

function validateFormat(format, path, chat = false) {
  if (!object(format) || !["text", "json_object", "json_schema"].includes(format.type)) return invalid(path, "expected text, json_object or json_schema.");
  if (format.type !== "json_schema") return null;
  const schema = chat ? format.json_schema : format;
  if (!object(schema) || !text(schema.name) || !object(schema.schema)) return invalid(path, "json_schema requires a name and a schema object.");
  if (schema.strict !== undefined && schema.strict !== null && typeof schema.strict !== "boolean") return invalid(`${path}.strict`, "expected a boolean.");
  return null;
}

export function validateChatRequest(value, { bridge = true } = {}) {
  if (!object(value)) return "body: expected a JSON object.";
  if (!text(value.model)) return "model: expected a non-empty string.";
  const controlsError = validateControls(value, ["max_tokens", "max_completion_tokens"]);
  if (controlsError) return controlsError;
  if (value.n !== undefined && (!Number.isSafeInteger(value.n) || value.n < 1 || (bridge && value.n !== 1))) return "n: expected a positive integer; this bridge supports only n=1.";
  if (value.stream_options != null) {
    if (!object(value.stream_options)) return "stream_options: expected an object.";
    if (value.stream_options.include_usage !== undefined && typeof value.stream_options.include_usage !== "boolean") return "stream_options.include_usage: expected a boolean.";
  }
  if (value.response_format != null) {
    const formatError = validateFormat(value.response_format, "response_format", true);
    if (formatError) return formatError;
  }
  if (!Array.isArray(value.messages) || !value.messages.length) return "messages: expected a non-empty array.";
  for (const [index, message] of value.messages.entries()) {
    const path = `messages[${index}]`;
    if (!object(message)) return invalid(path, "expected an object.");
    if (!["system", "developer", "user", "assistant", "tool"].includes(message.role)) return invalid(`${path}.role`, "unsupported role.");
    if (message.content != null && typeof message.content !== "string" && !Array.isArray(message.content)) return invalid(`${path}.content`, "expected text or an array.");
    if (Array.isArray(message.content)) {
      for (const [partIndex, part] of message.content.entries()) {
        const partPath = `${path}.content[${partIndex}]`;
        if (!object(part)) return invalid(partPath, "expected a content object.");
        if (part.type === "text") {
          if (typeof part.text !== "string") return invalid(`${partPath}.text`, "expected a string.");
        } else if (part.type === "image_url") {
          if (!object(part.image_url) || !text(part.image_url.url)) return invalid(`${partPath}.image_url.url`, "expected an image URL.");
          if (bridge && message.role !== "user") return invalid(partPath, "images are supported only in user messages on this bridge.");
        } else if (bridge) return invalid(`${partPath}.type`, `unsupported content type ${JSON.stringify(part.type)} on this bridge.`);
      }
    }
    if (message.role === "tool" && !text(message.tool_call_id)) return invalid(`${path}.tool_call_id`, "required for a tool result.");
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) return invalid(`${path}.tool_calls`, "expected an array.");
      for (const [callIndex, call] of message.tool_calls.entries()) {
        const callPath = `${path}.tool_calls[${callIndex}]`;
        if (!object(call) || !text(call.id)) return invalid(`${callPath}.id`, "required for a tool call.");
        if (call.type !== "function") {
          if (bridge) return invalid(`${callPath}.type`, "only function calls are supported on this bridge.");
          continue;
        }
        if (!object(call.function) || !text(call.function.name)) return invalid(`${callPath}.function.name`, "expected a function name.");
        if (typeof call.function.arguments !== "string") return invalid(`${callPath}.function.arguments`, "expected a JSON string.");
        try { JSON.parse(call.function.arguments); } catch { return invalid(`${callPath}.function.arguments`, "invalid JSON."); }
      }
    }
  }
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools)) return "tools: expected an array.";
    for (const [index, tool] of value.tools.entries()) {
      if (!object(tool)) return invalid(`tools[${index}]`, "expected an object.");
      if (tool.type !== "function") {
        if (bridge) return invalid(`tools[${index}].type`, "only function tools are supported on this bridge.");
        continue;
      }
      if (!object(tool.function) || !text(tool.function.name)) return invalid(`tools[${index}].function.name`, "expected a function name.");
      if (tool.function.parameters !== undefined && !object(tool.function.parameters)) return invalid(`tools[${index}].function.parameters`, "expected a schema object.");
    }
  }
  if (value.tool_choice !== undefined && !["auto", "none", "required"].includes(value.tool_choice)) {
    if (!object(value.tool_choice) || value.tool_choice.type !== "function" || !text(value.tool_choice.function?.name)) return "tool_choice: expected auto, none, required or a named function.";
  }
  return null;
}

function responseParts(value, path, bridge) {
  if (typeof value === "string") return null;
  if (!Array.isArray(value)) return invalid(path, "expected text or a content array.");
  for (const [index, part] of value.entries()) {
    const partPath = `${path}[${index}]`;
    if (!object(part)) return invalid(partPath, "expected a content object.");
    if (["input_text", "output_text", "text"].includes(part.type)) {
      if (typeof part.text !== "string") return invalid(`${partPath}.text`, "expected a string.");
    } else if (part.type === "input_image") {
      if (bridge && !text(part.image_url)) return invalid(partPath, "image_url is required; file_id images cannot be resolved by this bridge.");
    } else if (bridge) return invalid(`${partPath}.type`, `unsupported content type ${JSON.stringify(part.type)} on this bridge.`);
  }
  return null;
}

export function validateResponsesRequest(value, { bridge = false } = {}) {
  if (!object(value)) return "body: expected a JSON object.";
  if (!text(value.model)) return "model: expected a non-empty string.";
  const controlsError = validateControls(value, ["max_output_tokens"]);
  if (controlsError) return controlsError;
  for (const field of ["store", "background"]) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") return invalid(field, "expected a boolean.");
  }
  if (value.background === true) return "background: asynchronous retrieval is not supported by this gateway; use streaming instead.";
  if (value.text !== undefined) {
    if (!object(value.text)) return "text: expected an object.";
    if (value.text.format !== undefined) {
      const formatError = validateFormat(value.text.format, "text.format");
      if (formatError) return formatError;
    }
  }
  if (value.previous_response_id != null) return "previous_response_id: this stateless relay cannot restore stored history; send the complete input history instead.";
  if (value.conversation != null) return "conversation: stored conversations are not supported; send the complete input history instead.";
  if (typeof value.input !== "string" && !Array.isArray(value.input)) return "input: expected text or an array.";
  if (!value.input.length) return "input: must not be empty.";
  if (Array.isArray(value.input)) {
    for (const [index, item] of value.input.entries()) {
      const path = `input[${index}]`;
      if (!object(item)) return invalid(path, "expected an input object.");
      if (item.type === "item_reference") return invalid(`${path}.type`, "stored item references cannot be restored; send the full item.");
      if (item.type === "message" || (!item.type && item.role)) {
        if (!["system", "developer", "user", "assistant"].includes(item.role)) return invalid(`${path}.role`, "unsupported role.");
        const error = responseParts(item.content, `${path}.content`, bridge);
        if (error) return error;
        if (bridge && item.role !== "user" && Array.isArray(item.content) && item.content.some((part) => part.type === "input_image")) return invalid(`${path}.content`, "images are supported only in user messages on this bridge.");
      } else if (item.type === "function_call") {
        if (!text(item.call_id)) return invalid(`${path}.call_id`, "required for a function call.");
        if (!text(item.name)) return invalid(`${path}.name`, "required for a function call.");
        if (typeof item.arguments !== "string") return invalid(`${path}.arguments`, "expected a JSON string.");
        try { JSON.parse(item.arguments); } catch { return invalid(`${path}.arguments`, "invalid JSON."); }
      } else if (item.type === "function_call_output") {
        if (!text(item.call_id)) return invalid(`${path}.call_id`, "required for a tool result.");
        const error = responseParts(item.output, `${path}.output`, bridge);
        if (error) return error;
      } else if (item.type === "reasoning") {
        if (bridge && item.encrypted_content) return invalid(path, "encrypted reasoning cannot be replayed across model providers.");
      } else if (["input_text", "text"].includes(item.type)) {
        if (typeof item.text !== "string") return invalid(`${path}.text`, "expected a string.");
      } else if (bridge) return invalid(`${path}.type`, `unsupported input type ${JSON.stringify(item.type)} on this bridge.`);
    }
  }
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools)) return "tools: expected an array.";
    for (const [index, tool] of value.tools.entries()) {
      if (!object(tool)) return invalid(`tools[${index}]`, "expected an object.");
      if (bridge && tool.type !== "function") return invalid(`tools[${index}].type`, "only function tools can be translated; custom and built-in tools require the native Responses route.");
      if (tool.type === "function" && !text(tool.name)) return invalid(`tools[${index}].name`, "expected a function name.");
      if (tool.type === "function" && tool.parameters != null && !object(tool.parameters)) return invalid(`tools[${index}].parameters`, "expected a schema object.");
    }
  }
  if (value.tool_choice !== undefined && !["auto", "none", "required"].includes(value.tool_choice)) {
    if (!object(value.tool_choice) || !text(value.tool_choice.type)) return "tool_choice: expected auto, none, required or a tool selector.";
    if ((bridge || value.tool_choice.type === "function") && (value.tool_choice.type !== "function" || !text(value.tool_choice.name))) return "tool_choice: this bridge supports only a named function, auto, none or required.";
  }
  return null;
}

export function validateAnthropicRequest(value, { bridge = false } = {}) {
  if (!object(value)) return "body: expected a JSON object.";
  if (!text(value.model)) return "model: expected a non-empty string.";
  if (!Array.isArray(value.messages) || !value.messages.length) return "messages: expected a non-empty array.";
  for (const [index, message] of value.messages.entries()) {
    const path = `messages[${index}]`;
    if (!object(message) || !["user", "assistant", "system"].includes(message.role)) return invalid(path, "expected a user, assistant or system message.");
    if (message.clear_at !== undefined && (message.role !== "system" || !["never", "next_user_message"].includes(message.clear_at))) return invalid(`${path}.clear_at`, "expected never or next_user_message on a system message.");
    if (message.clear_at === "next_user_message" && message.output_config !== undefined) return invalid(`${path}.output_config`, "not supported on a turn-scoped system message.");
    if (typeof message.content === "string") continue;
    if (!Array.isArray(message.content)) return invalid(`${path}.content`, "expected text or a content array.");
    for (const [blockIndex, block] of message.content.entries()) {
      const blockPath = `${path}.content[${blockIndex}]`;
      if (!object(block) || !text(block.type)) return invalid(blockPath, "expected a typed content block.");
      if (message.role === "system") {
        if (message.clear_at === "next_user_message" && (block.type !== "text" || block.cache_control !== undefined)) return invalid(blockPath, "turn-scoped system messages require text blocks without cache_control.");
        if (!["text", "tool_addition", "tool_removal"].includes(block.type)) return invalid(blockPath, "unsupported system content block.");
        if (["tool_addition", "tool_removal"].includes(block.type)) {
          if (bridge && (block.tool?.type !== "tool_reference" || !text(block.tool.name))) return invalid(`${blockPath}.tool`, "this bridge requires a named client tool_reference.");
          if (bridge && !value.tools?.some((tool) => tool.name === block.tool.name)) return invalid(`${blockPath}.tool.name`, "referenced tool is not declared in tools.");
          continue;
        }
      }
      if (block.type === "text" && typeof block.text !== "string") return invalid(`${blockPath}.text`, "expected a string.");
      if (block.type === "tool_use" && (!text(block.id) || !text(block.name) || !object(block.input))) return invalid(blockPath, "tool_use requires id, name and an input object.");
      if (block.type === "tool_result" && !text(block.tool_use_id)) return invalid(`${blockPath}.tool_use_id`, "required for a tool result.");
      if (bridge) {
        if (!["text", "image", "thinking", "tool_use", "tool_result"].includes(block.type)) return invalid(`${blockPath}.type`, `unsupported content type ${JSON.stringify(block.type)} on this bridge.`);
        const parts = block.type === "tool_result" && Array.isArray(block.content) ? block.content : block.type === "image" ? [block] : [];
        for (const [partIndex, part] of parts.entries()) {
          if (!object(part) || !["text", "image"].includes(part.type)) return invalid(`${blockPath}.content[${partIndex}]`, "only text and images can be translated.");
          if (part.type === "image" && !(part.source?.type === "base64" && text(part.source.data)) && !(part.source?.type === "url" && text(part.source.url))) return invalid(blockPath, "image source must contain base64 data or a URL.");
        }
      }
    }
  }
  if (bridge && value.tools !== undefined) {
    if (!Array.isArray(value.tools)) return "tools: expected an array.";
    for (const [index, tool] of value.tools.entries()) {
      if (!object(tool) || !text(tool.name) || !object(tool.input_schema)) return invalid(`tools[${index}]`, "this bridge requires a client tool with name and input_schema; provider-hosted tools cannot be executed here.");
    }
  }
  return null;
}
