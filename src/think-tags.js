// DeepSeek thinking models served over plain chat completions — the only wire the relay
// serves DeepSeek and Kimi on — do not always come back with a reasoning_content field: some
// upstreams inline the reasoning at the head of the content, wrapped in <think>…</think>.
// Left alone that markup lands in the visible answer, which is the "thinking dumped into the
// body" a Claude Code session shows. This filter splits the two channels incrementally, with
// tags allowed to straddle chunk boundaries. Only a tag at the very start of the content
// opens a reasoning span — one that shows up after visible text is literal text.
const OPEN = "<think>";
const CLOSE = "</think>";

export class ThinkTagFilter {
  constructor() {
    // start: nothing seen yet, a leading <think> would still open reasoning;
    // thinking: inside the span; text: visible answer, tags are literal from here on.
    this.stage = "start";
    this.pending = "";
  }

  push(text) {
    const pieces = [];
    if (typeof text === "string" && text) {
      this.pending += text;
      this.consume(pieces, false);
    }
    return pieces;
  }

  end() {
    const pieces = [];
    this.consume(pieces, true);
    return pieces;
  }

  consume(pieces, final) {
    for (;;) {
      if (this.stage === "start") {
        const rest = this.pending.replace(/^\s+/, "");
        if (startsWithIgnoreCase(rest, OPEN)) {
          this.stage = "thinking";
          this.pending = rest.slice(OPEN.length);
          continue;
        }
        // A pending prefix of the opening tag — or nothing but whitespace so far — cannot
        // be decided until more content arrives, and at the end of the stream it was never
        // a tag at all.
        if (!final && (startsWithIgnoreCase(OPEN, rest) || !rest)) return;
        this.stage = "text";
      }
      if (this.stage === "thinking") {
        const close = indexOfIgnoreCase(this.pending, CLOSE);
        if (close === -1) {
          // Hold back a tail that the next chunk could grow into the closing tag. A stream
          // that ends inside the span was reasoning to the last byte.
          const hold = final ? 0 : suffixPrefixOverlap(this.pending, CLOSE);
          if (this.pending.length > hold) pieces.push({ type: "thinking", text: this.pending.slice(0, this.pending.length - hold) });
          this.pending = this.pending.slice(this.pending.length - hold);
          return;
        }
        if (close) pieces.push({ type: "thinking", text: this.pending.slice(0, close) });
        this.stage = "text";
        this.pending = this.pending.slice(close + CLOSE.length);
        continue;
      }
      if (this.pending) pieces.push({ type: "text", text: this.pending });
      this.pending = "";
      return;
    }
  }
}

// The longest tail of value that the next chunk could still complete into the whole tag.
function suffixPrefixOverlap(value, tag) {
  const max = Math.min(value.length, tag.length - 1);
  for (let length = max; length > 0; length--) if (value.toLowerCase().endsWith(tag.slice(0, length).toLowerCase())) return length;
  return 0;
}

function startsWithIgnoreCase(value, prefix) {
  return value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

function indexOfIgnoreCase(value, search) {
  return value.toLowerCase().indexOf(search.toLowerCase());
}

// The one-shot form, for a whole message body rather than a stream.
export function splitThinkTags(content) {
  if (typeof content !== "string" || !content) return { thinking: "", text: typeof content === "string" ? content : "" };
  const filter = new ThinkTagFilter();
  const pieces = filter.push(content).concat(filter.end());
  return {
    thinking: pieces.filter((piece) => piece.type === "thinking").map((piece) => piece.text).join(""),
    text: pieces.filter((piece) => piece.type === "text").map((piece) => piece.text).join("")
  };
}
