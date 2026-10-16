import { responseEvents, normalizeResponsesContentType } from "./responses-bridge.js";
import { ResponseState } from "./response-state.js";
import { IMAGE_FRAME_BYTES, IMAGE_RESPONSE_BYTES } from "./image-protocol.js";

const limits = { maxBytes: IMAGE_RESPONSE_BYTES, maxFrameBytes: IMAGE_FRAME_BYTES };
const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const metadata = (item) => Object.fromEntries(["background", "output_format", "quality", "size", "revised_prompt"].filter((key) => item?.[key] !== undefined).map((key) => [key, item[key]]));

export function responsesAsImageStream(upstream, action) {
  if (!upstream.ok || !upstream.body) return upstream;
  const reader = upstream.body.getReader();
  const source = new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); }
  });
  const events = imageEvents(new Response(source, { status: upstream.status, headers: upstream.headers }), action);
  let cancelled = false;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const result = await events.next();
        if (cancelled) return;
        if (result.done) { controller.close(); reader.releaseLock(); }
        else controller.enqueue(Buffer.from(result.value));
      } catch (error) { if (!cancelled) controller.error(error); }
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason).catch(() => {});
      await events.return();
      reader.releaseLock();
    }
  });
  return new Response(body, {
    status: upstream.status,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" }
  });
}

async function* imageEvents(upstream, action) {
  const prefix = action === "edit" ? "image_edit" : "image_generation";
  const state = new ResponseState(limits);
  try {
    upstream = await normalizeResponsesContentType(upstream);
    const events = upstream.headers.get("content-type")?.includes("text/event-stream") ? responseEvents(upstream.body, { ...limits, includeHeartbeats: true }) : [{ type: "response.completed", response: await upstream.json() }];
    for await (const incoming of events) {
      const event = state.accept(incoming);
      if (!event) continue;
      if (["error", "response.failed", "response.incomplete"].includes(event.type)) throw new Error(event.error?.message || event.response?.error?.message || "Image generation did not complete.");
      if (event.type === "response.image_generation_call.partial_image") {
        if (typeof event.partial_image_b64 !== "string" || !event.partial_image_b64) throw new Error("Invalid partial image returned by upstream.");
        yield frame({ type: `${prefix}.partial_image`, b64_json: event.partial_image_b64, partial_image_index: event.partial_image_index, ...metadata(event) });
      } else if (event.type === "response.completed") {
        if (event.response?.status !== "completed") throw new Error("Image response did not complete.");
        const images = (event.response?.output || []).filter((item) => item.type === "image_generation_call");
        if (images.length !== 1 || images.some((item) => item.status !== "completed" || typeof item.result !== "string" || !item.result)) throw new Error("Expected one completed image result from upstream.");
        const image = images[0];
        yield frame({ type: `${prefix}.completed`, b64_json: image.result, created_at: event.response.created_at || Math.floor(Date.now() / 1000), ...metadata(image), ...(image.usage || event.response.usage ? { usage: image.usage || event.response.usage } : {}) });
        return;
      } else yield ": ping\n\n";
    }
    throw new Error("The image stream ended without a completed response.");
  } catch (error) {
    yield frame({ type: "error", error: { type: "server_error", code: "image_stream_error", message: error.message } });
  }
}
