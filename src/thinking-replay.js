// Anthropic requires the signed thinking blocks of a tool_use turn to come back alongside the
// matching tool_result, and neither OpenAI protocol has a field that can carry a signature.
// So the blocks this gateway streamed out are kept here, keyed by the tool_use ids of the same
// turn, and restored when that turn is replayed. Without this, an agent loop like Codex loses
// thinking on every request after its first tool call.

const DEFAULT_MAX_TURNS = 500;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export function isReplayableThinking(block) {
  if (!block || typeof block !== "object") return false;
  if (block.type === "thinking") return typeof block.thinking === "string" && typeof block.signature === "string" && block.signature !== "";
  return block.type === "redacted_thinking" && typeof block.data === "string" && block.data !== "";
}

export function toolUseIdsOf(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((block) => block?.type === "tool_use" && typeof block.id === "string" && block.id).map((block) => block.id);
}

export class ThinkingReplayStore {
  #turns = new Map();

  constructor({ maxTurns = DEFAULT_MAX_TURNS, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.maxTurns = maxTurns;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  remember(toolUseIds, blocks) {
    const signed = Array.isArray(blocks) ? blocks.filter(isReplayableThinking) : [];
    if (!signed.length) return;
    const expiresAt = this.now() + this.ttlMs;
    for (const id of toolUseIds) {
      if (typeof id !== "string" || !id) continue;
      this.#turns.delete(id);
      this.#turns.set(id, { blocks: signed, expiresAt });
    }
    this.#evict();
  }

  // A turn is found by any one of its tool_use ids, because a client is free to drop or
  // reorder the tool calls it echoes back.
  recall(toolUseIds) {
    const now = this.now();
    for (const id of toolUseIds) {
      const turn = typeof id === "string" ? this.#turns.get(id) : undefined;
      if (!turn) continue;
      if (turn.expiresAt <= now) {
        this.#turns.delete(id);
        continue;
      }
      turn.expiresAt = now + this.ttlMs;
      // Insertion order is the eviction order, so a turn its conversation is still replaying
      // has to move to the back — otherwise the cap drops it while newer but idle turns
      // survive, and losing it costs that conversation thinking for the rest of its life.
      this.#turns.delete(id);
      this.#turns.set(id, turn);
      return turn.blocks;
    }
    return null;
  }

  get size() {
    return this.#turns.size;
  }

  #evict() {
    const now = this.now();
    for (const [id, turn] of this.#turns) {
      if (turn.expiresAt > now) break; // Insertion order runs oldest first.
      this.#turns.delete(id);
    }
    while (this.#turns.size > this.maxTurns) {
      const oldest = this.#turns.keys().next().value;
      this.#turns.delete(oldest);
    }
  }
}
