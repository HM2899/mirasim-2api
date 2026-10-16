import { randomUUID } from "node:crypto";

const TITLE_INSTRUCTION = /^Generate a concise, single-line task title of at most (\d{1,3}) characters and under five words where possible\. Start with an imperative verb\. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise\. Preserve ticket references exactly\. Write in the user's language\. Do not use quotes, markdown, or trailing punctuation\. Do not answer the request\./;

export function codexTitleDiagnostics(request) {
  if (!/^gpt-/i.test(request?.model || "")) return null;
  const input = request.messages ?? request.input;
  const messages = typeof input === "string" ? [{ role: "user", content: input }] : Array.isArray(input) ? input : [];
  const describeText = (text) => {
    const markerOffset = text.indexOf("Generate a concise, single-line task title of at most ");
    const match = markerOffset >= 0 ? TITLE_INSTRUCTION.exec(text.slice(markerOffset)) : null;
    const remainder = match ? text.slice(markerOffset + match[0].length) : "";
    return {
      characters: text.length,
      titleMarkerOffset: markerOffset,
      exactInstruction: Boolean(match),
      sourceKind: remainder.startsWith("\n\nUser prompt:\n") ? "user_prompt"
        : remainder.startsWith("\nPrioritize the current task and latest substantive user request.\n\nRecent conversation messages:\n") ? "recent_conversation" : "other",
      environmentContext: text.trimStart().startsWith("<environment_context>"),
      agentsContext: text.trimStart().startsWith("# AGENTS.md instructions"),
      titleWord: /\btitle\b/i.test(text),
      summaryWord: /\bsummary\b/i.test(text)
    };
  };
  const describeContent = (content) => {
    if (typeof content === "string") return { blocks: 1, text: [describeText(content)] };
    if (!Array.isArray(content)) return { blocks: 0, text: [] };
    const textBlocks = content.filter((block) => ["text", "input_text"].includes(block?.type) && typeof block.text === "string");
    return {
      blocks: content.length,
      nonTextBlocks: content.length - textBlocks.length,
      text: textBlocks.slice(0, 32).map((block) => describeText(block.text)),
      textTruncated: textBlocks.length > 32
    };
  };
  return {
    messageCount: messages.length,
    messagesTruncated: messages.length > 32,
    messages: messages.slice(-32).map((message) => ({
      role: ["user", "assistant", "developer", "system", "tool"].includes(message?.role) ? message.role : "other",
      ...describeContent(message?.content)
    })),
    system: describeContent(request.system ?? request.instructions),
    hasPreviousResponse: Boolean(request.previous_response_id),
    hasConversation: Boolean(request.conversation),
    storeEnabled: request.store === true,
    forcedTool: Boolean(request.tool_choice && !["auto", "none"].includes(request.tool_choice?.type || request.tool_choice)),
    structuredOutput: Boolean((request.text?.format && request.text.format.type !== "text") || (request.response_format && request.response_format.type !== "text"))
  };
}

export function localCodexTitleCompletion(request) {
  if (!/^gpt-/i.test(request?.model || "") || request.previous_response_id || request.conversation || request.store === true) return null;
  if (request.tool_choice && !["auto", "none"].includes(request.tool_choice?.type || request.tool_choice)) return null;
  if (request.text?.format && request.text.format.type !== "text") return null;
  if (request.response_format && request.response_format.type !== "text") return null;
  const input = request.messages ?? request.input;
  const messages = typeof input === "string" ? [{ role: "user", content: input }] : input;
  if (!Array.isArray(messages)) return null;
  const conversation = messages.filter((message) => !["system", "developer"].includes(message?.role));
  if (conversation.length !== 1 || conversation[0]?.role !== "user") return null;
  const content = conversation[0].content;
  let prompt;
  if (typeof content === "string") prompt = content;
  else if (Array.isArray(content) && content.every((block) => ["text", "input_text"].includes(block?.type) && typeof block.text === "string")) {
    const texts = content.map((block) => block.text);
    const last = texts.at(-1);
    const contextOnly = texts.length > 1 && texts.slice(0, -1).every((text) => {
      const trimmed = text.trim();
      return /^# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n/.test(trimmed)
        || /^<environment_context>[\s\S]*<\/environment_context>$/.test(trimmed);
    });
    prompt = contextOnly && TITLE_INSTRUCTION.test(last) ? last : texts.join("\n");
  } else return null;
  const match = TITLE_INSTRUCTION.exec(prompt);
  if (!match) return null;
  const limit = Number(match[1]);
  if (limit < 1 || limit > 120) return null;
  const remainder = prompt.slice(match[0].length);
  let source;
  if (remainder.startsWith("\n\nUser prompt:\n")) source = remainder.slice("\n\nUser prompt:\n".length);
  else {
    const historyPrefix = "\nPrioritize the current task and latest substantive user request.\n\nRecent conversation messages:\n";
    if (!remainder.startsWith(historyPrefix)) return null;
    source = remainder.slice(historyPrefix.length).trim().split(/\r?\n/).filter(Boolean).at(-1);
  }
  if (!source?.trim()) return null;
  const normalized = source.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/^[\s#>*`"']+/, "").replace(/\s+/g, " ").trim();
  const title = Array.from(normalized).slice(0, limit).join("").replace(/[\s.,!?;:，。！？；：`"']+$/u, "");
  if (!title) return null;
  return {
    id: `chatcmpl-local-title-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [{ index: 0, message: { role: "assistant", content: title }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}
