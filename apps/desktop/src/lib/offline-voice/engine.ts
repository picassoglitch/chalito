import { SPEECH_RATE, wav } from "./audio.js";

/** Speech to text on this computer. The bundled whisper.cpp sidecar will be one more of these. */
export interface SpeechEngine {
  transcribe(pcm: Float32Array, rate?: number): Promise<Transcript>;
  /** Whether the engine answers at all (the Settings "Probar" button). */
  probe(): Promise<boolean>;
}

export interface Transcript {
  text: string;
  /** The language whose decode won, when more than one was tried. */
  language: string | null;
}

/** A whisper.cpp `verbose_json` reply, the parts we read. */
export interface WhisperReply {
  text?: string;
  language?: string;
  segments?: { avg_logprob?: number }[];
}

export class EngineNotLocalError extends Error {
  constructor(readonly url: string) {
    super("engine_not_local");
    this.name = "EngineNotLocalError";
  }
}

export class EngineUnreachableError extends Error {
  constructor(readonly reason: unknown) {
    super("engine_unreachable");
    this.name = "EngineUnreachableError";
  }
}

export class EngineFailedError extends Error {
  constructor(readonly status: number) {
    super(`engine_failed:${status}`);
    this.name = "EngineFailedError";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

/** The server URL if it's on this computer, else null: in this mode audio never leaves it. */
export const loopbackUrl = (raw: string): URL | null => {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" && LOOPBACK.has(u.hostname) && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
};

/** Mean segment log-probability: whisper's own confidence in what it heard. */
export const confidence = (r: WhisperReply): number => {
  const segs = r.segments ?? [];
  return segs.length ? segs.reduce((a, s) => a + (s.avg_logprob ?? -9), 0) / segs.length : -Infinity;
};

// From Alux by Omar (homiomar), pet/whisper.js: auto-detect hears accented English as Spanish and
// translates it; decoding once per language and keeping the most confident keeps what was said.
export const mostConfident = <R extends WhisperReply>(results: readonly R[]): R => {
  if (!results.length) throw new Error("no results");
  return results.reduce((best, r) => (confidence(r) > confidence(best) ? r : best));
};

export interface WhisperServerOptions {
  url: string;
  /** One decode per language; one or none means the server's own detection. */
  languages: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** A whisper.cpp `whisper-server` already running on this computer. */
export const whisperServerEngine = (o: WhisperServerOptions): SpeechEngine => {
  const base = loopbackUrl(o.url);
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeout = o.timeoutMs ?? 30_000;
  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    if (!base) throw new EngineNotLocalError(o.url);
    try {
      return await f(new URL(path, base), { ...init, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw new EngineUnreachableError(e);
    }
  };
  return {
    async probe() {
      try {
        return (await call("/")).ok;
      } catch {
        return false;
      }
    },
    async transcribe(pcm, rate = SPEECH_RATE) {
      const audio = wav(pcm, rate);
      const once = async (language: string | null): Promise<WhisperReply & { tried: string | null }> => {
        const form = new FormData();
        form.append("file", new Blob([audio], { type: "audio/wav" }), "voice.wav");
        form.append("response_format", "verbose_json");
        form.append("temperature", "0.0");
        if (language) form.append("language", language);
        const r = await call("/inference", { method: "POST", body: form });
        if (!r.ok) throw new EngineFailedError(r.status);
        return { ...((await r.json()) as WhisperReply), tried: language };
      };
      const langs = o.languages.length > 1 ? o.languages : [o.languages[0] ?? null];
      const results = [];
      // The server decodes one request at a time; parallel calls would only queue.
      for (const l of langs) results.push(await once(l));
      const best = mostConfident(results);
      return { text: String(best.text ?? "").trim(), language: best.tried ?? best.language ?? null };
    },
  };
};
