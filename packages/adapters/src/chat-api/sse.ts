/**
 * Server-sent events (the WHATWG event-stream format) → each event's `data`, joined across its
 * `data:` lines. Comments (`:` keep-alives), `event:`, `id:` and `retry:` fields are skipped: the
 * OpenAI-compatible stream carries everything in `data`. A single event is capped at 1 MiB.
 */
const MAX_EVENT = 1 << 20;

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let data: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
        // A "\r" at the very end may be the first half of "\r\n": wait for the next chunk.
        if (buf[nl] === "\r" && nl === buf.length - 1) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + (buf.startsWith("\r\n", nl) ? 2 : 1));
        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
          size = 0;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        if (field !== "data") continue;
        let v = colon < 0 ? "" : line.slice(colon + 1);
        if (v.startsWith(" ")) v = v.slice(1);
        size += v.length;
        if (size > MAX_EVENT) throw new Error("server-sent event too large");
        data.push(v);
      }
      if (buf.length > MAX_EVENT) throw new Error("server-sent event too large");
    }
    if (data.length) yield data.join("\n");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
