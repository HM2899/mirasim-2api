import { relayWireFor } from "./relay-agents.js";
import { isImageModel } from "./image-protocol.js";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const searchType = (type) => ["web_search", "web_search_preview", "web_search_preview_2025_03_11"].includes(type);
const anthropicSearch = (tool) => /^web_search_\d{8}$/.test(tool?.type || "");

export function prepareSearchRequest(value, protocol) {
  if (!object(value)) return { request: value, tools: [] };
  const native = relayWireFor(value.model) === "responses";
  const supplied = Array.isArray(value.tools) ? value.tools : [];
  const selected = supplied.filter((tool) => searchType(tool?.type) || (protocol === "anthropic" && native && anthropicSearch(tool)));
  if (value.web_search_options === undefined && !selected.length) return { request: value, tools: [] };
  if (!native || isImageModel(value.model)) return { error: "Native web search requires a Responses-backed text model; the gateway does not substitute another model." };
  if (value.web_search_options !== undefined && !object(value.web_search_options)) return { error: "web_search_options: expected an object." };
  if (value.tools !== undefined && !Array.isArray(value.tools)) return { error: "tools: expected an array." };
  if (selected.length + (value.web_search_options !== undefined ? 1 : 0) > 1) return { error: "Specify exactly one web search tool or web_search_options, not both." };
  const original = selected[0];
  let tool;
  if (original && anthropicSearch(original)) {
    const allowed = new Set(["type", "name", "allowed_domains", "user_location"]);
    const unsupported = Object.keys(original).find((key) => !allowed.has(key));
    if (unsupported) return { error: `Web search field ${unsupported} cannot be faithfully translated to Responses.` };
    if (original.name !== "web_search") return { error: "The Anthropic web search tool must be named web_search." };
    tool = { type: "web_search", ...(original.allowed_domains ? { filters: { allowed_domains: original.allowed_domains } } : {}), ...(original.user_location ? { user_location: original.user_location } : {}) };
  } else tool = original ? { ...original } : { ...value.web_search_options, type: "web_search" };
  if (tool.search_context_size !== undefined && !["low", "medium", "high"].includes(tool.search_context_size)) return { error: "search_context_size: expected low, medium or high." };
  if (tool.user_location?.approximate) tool.user_location = { type: "approximate", ...tool.user_location.approximate };
  const request = { ...value };
  delete request.web_search_options;
  if (Array.isArray(value.tools)) request.tools = supplied.filter((entry) => !selected.includes(entry));
  let choice;
  if (protocol === "anthropic" && value.tool_choice?.type === "tool" && value.tool_choice.name === "web_search") choice = { type: tool.type };
  else if (searchType(value.tool_choice?.type)) choice = { type: tool.type };
  else if (protocol === "anthropic" && value.tool_choice?.type === "any") choice = "required";
  else if (protocol === "anthropic" && ["auto", "none"].includes(value.tool_choice?.type)) choice = value.tool_choice.type;
  else if (["auto", "none", "required"].includes(value.tool_choice)) choice = value.tool_choice;
  if (choice !== undefined) delete request.tool_choice;
  if (protocol === "responses") {
    request.tools = [...(request.tools || []), tool];
    if (choice !== undefined) request.tool_choice = choice;
  }
  return { request, tools: [tool], choice, parallel: protocol === "anthropic" && typeof value.tool_choice?.disable_parallel_tool_use === "boolean" ? !value.tool_choice.disable_parallel_tool_use : undefined };
}

export function applySearchTools(request, search) {
  if (!search.tools.length) return;
  request.tools = [...(request.tools || []), ...search.tools];
  if (search.choice !== undefined) request.tool_choice = search.choice;
  if (search.parallel !== undefined) request.parallel_tool_calls = search.parallel;
}
