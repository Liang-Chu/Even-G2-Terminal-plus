/** Bounded SSE reader. Partial text is preview-only until the provider sends done. */
export async function transcriptStream(response: Response, signal: AbortSignal, partial?: (text: string) => void): Promise<string> {
  if (!response.body) throw new Error("Missing speech stream");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", text = "", total = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new Error("Cancelled");
    while (true) {
      const chunk = await reader.read();
      if (signal.aborted) throw new Error("Cancelled");
      total += chunk.value?.length || 0;
      if (total > 512_000) throw new Error("Speech stream too large");
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data);
        if (event.type === "error") throw new Error("Speech stream failed");
        if (event.type === "transcript.text.delta") {
          if (typeof event.delta !== "string" || text.length + event.delta.length > 32_000) throw new Error("Invalid transcript");
          text += event.delta; partial?.(text);
        } else if (event.type === "transcript.text.done") {
          if (typeof event.text !== "string" || event.text.length > 32_000) throw new Error("Invalid transcript");
          return event.text;
        }
      }
      if (buffer.length > 128_000) throw new Error("Speech event too large");
      if (chunk.done) throw new Error("Incomplete speech stream");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
