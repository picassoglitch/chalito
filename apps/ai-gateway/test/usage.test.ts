import { describe, expect, it } from "vitest";
import { geminiReader, responsesReader } from "../src/wires/usage.js";
import { geminiSse, responsesSse } from "./fake-providers.js";

const enc = new TextEncoder();
/** Feeds a stream split at awkward places, as TCP does. */
const feed = (r: { push(c: Uint8Array): void }, text: string, size = 7) => {
  for (let i = 0; i < text.length; i += size) r.push(enc.encode(text.slice(i, i + size)));
};

describe("Responses usage (Codex, Grok)", () => {
  it("reads response.completed, split across chunks; cached and cache-written tokens come out of input", () => {
    const r = responsesReader(true);
    const usage = {
      input_tokens: 10_000,
      input_tokens_details: { cached_tokens: 3_000, cache_write_tokens: 500 },
      output_tokens: 900,
      output_tokens_details: { reasoning_tokens: 400 },
      total_tokens: 10_900,
    };
    feed(r, responsesSse("x", usage).join(""));
    expect(r.end()).toEqual({ input: 6_500, output: 900, cacheRead: 3_000, cacheWrite: 500 });
  });

  it("a stream cut before response.completed has no usage (the meter bills its estimate)", () => {
    const r = responsesReader(true);
    feed(r, responsesSse("x", { input_tokens: 5, output_tokens: 5 }).slice(0, 3).join(""));
    expect(r.end()).toBeNull();
    expect(r.bytes).toBeGreaterThan(0);
  });

  it("a JSON answer's usage, pretty-printed as the providers send it", () => {
    const r = responsesReader(false);
    feed(
      r,
      JSON.stringify({ id: "r", output: [{ text: "a\nb" }], usage: { input_tokens: 10, output_tokens: 2 } }, null, 2),
    );
    expect(r.end()).toEqual({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("Gemini usage", () => {
  const final = {
    promptTokenCount: 1_000,
    cachedContentTokenCount: 200,
    candidatesTokenCount: 50,
    thoughtsTokenCount: 30,
  };
  it("only the chunk with a finishReason is final; thoughts are output, cached comes out of the prompt", () => {
    const r = geminiReader(true);
    feed(r, geminiSse("x", final).join(""), 5);
    expect(r.end()).toEqual({ input: 800, output: 80, cacheRead: 200 });
  });

  it("a JSON answer (generateContent), pretty-printed", () => {
    const r = geminiReader(false);
    feed(
      r,
      JSON.stringify(
        { candidates: [{ content: { parts: [{ text: "hola" }] }, finishReason: "STOP" }], usageMetadata: final },
        null,
        2,
      ),
    );
    expect(r.end()).toEqual({ input: 800, output: 80, cacheRead: 200 });
  });

  it("a stream cut before the final chunk has no usage, even with partial counts on earlier chunks", () => {
    const r = geminiReader(true);
    feed(r, geminiSse("x", final).slice(0, 2).join(""));
    expect(r.end()).toBeNull();
  });
});
