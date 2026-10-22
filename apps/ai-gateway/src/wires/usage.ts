import type { TokenUsage } from "@chalito/billing";

/** Reads a provider's usage out of the bytes as they stream by (SSE or one JSON body). */
export interface UsageReader {
  push(chunk: Uint8Array): void;
  /** The provider's final numbers, or null when it never reported them (stream cut, error). */
  end(): TokenUsage | null;
  /** Response bytes seen: the fallback's output bound. */
  readonly bytes: number;
}

const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** OpenAI/xAI Responses `usage`: input includes cached and cache-written tokens; output includes reasoning. */
export const responsesUsage = (u: unknown): TokenUsage | null => {
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, unknown>;
  const details = (o.input_tokens_details ?? {}) as Record<string, unknown>;
  const input = int(o.input_tokens);
  const cacheRead = Math.min(input, int(details.cached_tokens));
  const cacheWrite = Math.min(input - cacheRead, int(details.cache_write_tokens));
  return { input: input - cacheRead - cacheWrite, output: int(o.output_tokens), cacheRead, cacheWrite };
};

/** Gemini `usageMetadata`: the prompt includes cached tokens; thoughts are billed as output. */
export const geminiUsage = (u: unknown): TokenUsage | null => {
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, unknown>;
  const prompt = int(o.promptTokenCount) + int(o.toolUsePromptTokenCount);
  const cacheRead = Math.min(prompt, int(o.cachedContentTokenCount));
  return { input: prompt - cacheRead, output: int(o.candidatesTokenCount) + int(o.thoughtsTokenCount), cacheRead };
};

/** Splits SSE `data:` payloads (any line ending); a JSON answer (`json`) is kept whole, newlines and all. */
class Lines {
  #buf = "";
  #dec = new TextDecoder();
  bytes = 0;
  constructor(
    private readonly onData: (json: unknown) => void,
    private readonly json = false,
  ) {}
  push(chunk: Uint8Array) {
    this.bytes += chunk.byteLength;
    this.#buf += this.#dec.decode(chunk, { stream: true });
    // Over 32 MB isn't an answer we can read: stop buffering (the meter bills its estimate).
    if (this.#buf.length > 32 * 1024 * 1024) this.#buf = "";
    if (this.json) return;
    let i: number;
    while ((i = this.#buf.search(/\r?\n/)) >= 0) {
      const line = this.#buf.slice(0, i);
      this.#buf = this.#buf.slice(this.#buf[i] === "\r" ? i + 2 : i + 1);
      this.#line(line);
    }
  }
  #line(line: string) {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      this.onData(JSON.parse(data));
    } catch {
      /* not JSON: not usage */
    }
  }
  /** At the end: the last SSE line, or the whole JSON answer. */
  end() {
    const r = this.#buf + this.#dec.decode();
    this.#buf = "";
    if (!this.json) {
      if (r.startsWith("data:")) this.#line(r);
      return;
    }
    try {
      this.onData(JSON.parse(r));
    } catch {
      /* not JSON: not usage */
    }
  }
}

const FINAL_RESPONSES = new Set(["response.completed", "response.incomplete", "response.failed"]);

/** Responses streams end with response.completed (or incomplete/failed) carrying the usage; a JSON answer has it on top. */
export const responsesReader = (stream: boolean): UsageReader => {
  let usage: TokenUsage | null = null;
  const lines = new Lines((j) => {
    const e = j as { type?: string; response?: { usage?: unknown }; usage?: unknown };
    if (!stream) usage = responsesUsage(e.usage);
    else if (e.type && FINAL_RESPONSES.has(e.type)) usage = responsesUsage(e.response?.usage) ?? usage;
  }, !stream);
  return {
    push: (c) => lines.push(c),
    end() {
      lines.end();
      return usage;
    },
    get bytes() {
      return lines.bytes;
    },
  };
};

/** Gemini: every chunk may carry usageMetadata; it's final on the chunk with a finishReason. */
export const geminiReader = (stream: boolean): UsageReader => {
  let usage: TokenUsage | null = null;
  const lines = new Lines((j) => {
    const c = j as { usageMetadata?: unknown; candidates?: { finishReason?: string }[] };
    if (c.candidates?.some((x) => x.finishReason)) usage = geminiUsage(c.usageMetadata) ?? usage;
  }, !stream);
  return {
    push: (c) => lines.push(c),
    end() {
      lines.end();
      return usage;
    },
    get bytes() {
      return lines.bytes;
    },
  };
};
