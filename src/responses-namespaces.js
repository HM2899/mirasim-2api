import { createHash } from "node:crypto";

const callTypes = new Set(["function_call", "custom_tool_call"]);
const declarationTypes = new Set(["function", "custom"]);
const validName = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);

export function adaptResponsesNamespaces(request) {
  const byAlias = new Map();
  const byQualifiedName = new Map();
  const topNames = new Set((request.tools || []).filter((tool) => declarationTypes.has(tool.type)).map((tool) => tool.name));
  function remember(namespace, name) {
    if (!validName(namespace) || !validName(name)) throw new Error("Namespaced tools require non-empty alphanumeric, underscore or hyphen names.");
    const qualified = `${namespace}\0${name}`;
    if (byQualifiedName.has(qualified)) return byQualifiedName.get(qualified);
    const base = `${namespace}__${name}`;
    const alias = base.length <= 64 ? base : `${base.slice(0, 39)}_${createHash("sha256").update(qualified).digest("hex").slice(0, 24)}`;
    const previous = byAlias.get(alias);
    if (topNames.has(alias) || previous && (previous.namespace !== namespace || previous.name !== name)) throw new Error("Namespaced tool names conflict after translation; rename the conflicting tool.");
    byAlias.set(alias, { namespace, name });
    byQualifiedName.set(qualified, alias);
    return alias;
  }
  function flatten(tools) {
    if (!Array.isArray(tools)) throw new Error("tools must be an array.");
    const flattened = [];
    const seen = new Set();
    for (const tool of tools) {
      if (tool?.type !== "namespace") {
        flattened.push(tool);
        continue;
      }
      const children = tool.tools?.length ? tool.tools : tool.children;
      if (!Array.isArray(children) || !children.length) throw new Error("A namespace must declare its tools or children.");
      for (const child of children) {
        if (!child || !declarationTypes.has(child.type)) throw new Error("Only function and custom tools can be translated inside a namespace.");
        const alias = remember(tool.name, child.name);
        if (seen.has(alias)) throw new Error("Duplicate namespaced tool declaration.");
        seen.add(alias);
        flattened.push({ ...child, name: alias });
      }
    }
    return flattened;
  }
  const normalized = { ...request };
  if (request.tools) normalized.tools = flatten(request.tools);
  if (Array.isArray(request.input)) {
    normalized.input = request.input.map((item) => {
      if (!callTypes.has(item.type) || item.namespace === undefined) return item;
      const { namespace, ...rest } = item;
      return { ...rest, name: remember(namespace, item.name) };
    });
  }
  function choice(value) {
    if (!value || typeof value !== "object") return value;
    if (value.type === "namespace") throw new Error("Namespace-only tool_choice is not supported; choose a named function or custom tool.");
    if (declarationTypes.has(value.type) && value.namespace !== undefined) {
      const alias = byQualifiedName.get(`${value.namespace}\0${value.name}`);
      if (!alias || !normalized.tools?.some((tool) => tool.name === alias)) throw new Error("tool_choice references an undeclared namespaced tool.");
      const { namespace, ...rest } = value;
      return { ...rest, name: alias };
    }
    if (value.type === "allowed_tools" && Array.isArray(value.tools)) return { ...value, tools: value.tools.map(choice) };
    return value;
  }
  if (request.tool_choice !== undefined) normalized.tool_choice = choice(request.tool_choice);
  function restoreItem(item) {
    if (!item || !callTypes.has(item.type)) return item;
    const identity = byAlias.get(item.name);
    return identity ? { ...item, ...identity } : item;
  }
  function restoreResponse(response) {
    if (!Array.isArray(response?.output) || !byAlias.size) return response;
    return { ...response, output: response.output.map(restoreItem) };
  }
  function restoreEvent(event) {
    if (!event || !byAlias.size) return event;
    const restored = { ...event };
    if (event.item) restored.item = restoreItem(event.item);
    if (event.response) restored.response = restoreResponse(event.response);
    if (/^response\.(?:function_call_arguments|custom_tool_call_input)\.(?:delta|done)$/.test(event.type)) {
      const identity = byAlias.get(event.name);
      if (identity) Object.assign(restored, identity);
    }
    return restored;
  }
  return { request: normalized, restoreEvent, restoreResponse };
}
