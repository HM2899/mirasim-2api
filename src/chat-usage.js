export function chatCacheReadTokens(usage) {
  return [usage?.prompt_tokens_details?.cached_tokens, usage?.prompt_cache_hit_tokens]
    .find((value) => Number.isFinite(value) && value >= 0);
}

export function normalizeChatUsage(usage) {
  const cachedTokens = chatCacheReadTokens(usage);
  if (cachedTokens === undefined || usage.prompt_tokens_details?.cached_tokens === cachedTokens) return usage;
  return {
    ...usage,
    prompt_tokens_details: { ...usage.prompt_tokens_details, cached_tokens: cachedTokens }
  };
}
