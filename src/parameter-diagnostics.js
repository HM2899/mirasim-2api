import { isDeepStrictEqual } from "node:util";

const FIELDS = ["model", "stream", "store", "temperature", "top_p", "max_tokens", "max_completion_tokens", "max_output_tokens", "stop", "stop_sequences", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "reasoning_effort", "thinking", "output_config", "response_format", "text", "web_search_options", "image_options", "n", "metadata", "logprobs", "top_logprobs", "seed", "service_tier", "truncation", "user", "previous_response_id", "conversation"];
const ALIASES = {
  max_tokens: ["max_output_tokens", "max_completion_tokens"], max_completion_tokens: ["max_output_tokens", "max_tokens"], max_output_tokens: ["max_tokens"],
  stop_sequences: ["stop"], stop: ["stop_sequences"],
  reasoning_effort: ["reasoning", "thinking"], reasoning: ["reasoning_effort", "thinking"], thinking: ["reasoning", "reasoning_effort"], output_config: ["reasoning", "reasoning_effort"],
  response_format: ["text"], text: ["response_format"], web_search_options: ["tools"], image_options: ["tools"]
};

export function parameterDiagnostics(client, upstream) {
  if (!client || !upstream) return [];
  const report = [];
  for (const parameter of FIELDS) {
    const sent = Object.hasOwn(client, parameter);
    const forwarded = Object.hasOwn(upstream, parameter);
    if (!sent && !forwarded) continue;
    if (sent && forwarded && isDeepStrictEqual(client[parameter], upstream[parameter])) continue;
    const targets = !forwarded ? (ALIASES[parameter] || []).filter((field) => Object.hasOwn(upstream, field)) : [];
    const status = !sent ? "added" : forwarded ? "changed" : targets.length ? "related_fields" : "omitted";
    report.push({ parameter, status, ...(targets.length ? { targets } : {}) });
  }
  return report;
}
