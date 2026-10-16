const CARD_STATUSES = new Set(["active", "used", "revoked", "expired"]);
const HISTORY_KINDS = new Set(["granted", "used", "revoked", "expired"]);
export const RESET_OUTCOMES = new Set(["reset", "nothingToReset", "alreadyRedeemed", "expired", "revoked", "noCard"]);

export function normalizeCampaignLink(value) {
  const slug = typeof value?.slug === "string" ? value.slug.trim().toLowerCase() : "";
  if (!/^go-[a-z0-9-]{1,29}$/.test(slug)) return null;
  const sold = Number.isFinite(value.sold) && value.sold >= 0 ? Math.floor(value.sold) : 0;
  const cap = Number.isFinite(value.cap) && value.cap >= 1 ? Math.floor(value.cap) : 3;
  return { slug, url: `https://mirasim.ai/r/${slug}`, sold, cap, rewarded: value.rewarded === true };
}

function timestamp(value) {
  const parsed = typeof value === "string" && value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function resetWindows(value) {
  return Array.isArray(value) ? value.filter((window) => typeof window === "string") : [];
}

export function normalizeResetCards(value) {
  if (!Array.isArray(value?.cards) || !Array.isArray(value?.history)) return null;
  const cards = value.cards.flatMap((card) => {
    const grantedAt = timestamp(card?.granted_at);
    const expiresAt = timestamp(card?.expires_at);
    if (typeof card?.id !== "string" || !card.id || !CARD_STATUSES.has(card.status) || grantedAt === null || expiresAt === null) return [];
    return [{ id: card.id, status: card.status, grantedAt, expiresAt, usedAt: timestamp(card.used_at), revokedAt: timestamp(card.revoked_at) }];
  });
  const history = value.history.flatMap((entry) => {
    const at = timestamp(entry?.at);
    const expiresAt = timestamp(entry?.expires_at);
    if (typeof entry?.card_id !== "string" || !HISTORY_KINDS.has(entry.kind) || at === null || expiresAt === null) return [];
    return [{ at, kind: entry.kind, cardId: entry.card_id, expiresAt, ...(entry.kind === "used" ? { windows: resetWindows(entry.windows) } : {}) }];
  });
  return { available: cards.filter((card) => card.status === "active").length, cards, history };
}
