// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EngineFailedError,
  EngineNotLocalError,
  EngineNotWhisperError,
  EngineTimeoutError,
  EngineUnreachableError,
  confidence,
  loopbackUrl,
  mostConfident,
  whisperServerEngine,
} from "../src/lib/offline-voice/engine.js";

/** What the fake whisper-server got: the multipart fields and the uploaded WAV. */
interface Got {
  fields: Record<string, string>;
  wav: Buffer;
}

const body = (req: IncomingMessage) =>
  new Promise<Buffer>((ok) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => ok(Buffer.concat(parts)));
  });

/** A tiny multipart reader: enough for the four fields whisper-server reads. */
const multipart = (raw: Buffer, type: string): Got => {
  const boundary = `--${/boundary=(.+)$/.exec(type)![1]}`;
  const fields: Record<string, string> = {};
  let wav = Buffer.alloc(0);
  for (const part of raw.toString("latin1").split(boundary).slice(1, -1)) {
    const [head, ...rest] = part.split("\r\n\r\n");
    const content = rest.join("\r\n\r\n").replace(/\r\n$/, "");
    const name = /name="([^"]+)"/.exec(head!)![1]!;
    if (name === "file") wav = Buffer.from(content, "latin1");
    else fields[name] = content;
  }
  return { fields, wav };
};

/** A fake whisper.cpp server: Spanish decodes are confident, English ones mistranslate with low confidence. */
let server: Server;
let base: string;
const got: Got[] = [];
let status = 200;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/") return res.end("<html>whisper.cpp server</html>");
    if (req.method !== "POST" || req.url !== "/inference") return res.writeHead(404).end();
    const g = multipart(await body(req), req.headers["content-type"]!);
    got.push(g);
    if (status !== 200) return res.writeHead(status).end("boom");
    const lang = g.fields.language;
    const reply =
      lang === "es"
        ? { text: " Apruébalo.", language: "es", segments: [{ avg_logprob: -0.2 }, { avg_logprob: -0.3 }] }
        : lang === "en"
          ? { text: " Approve it.", language: "en", segments: [{ avg_logprob: -1.4 }] }
          : { text: " Approve it.", language: "en", segments: [{ avg_logprob: -0.9 }] };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

const speech = Float32Array.from({ length: 16_000 }, (_, i) => 0.3 * Math.sin(i / 10));

describe("best of languages", () => {
  it("scores by mean segment log-probability; no segments is the worst", () => {
    expect(confidence({ segments: [{ avg_logprob: -0.2 }, { avg_logprob: -0.4 }] })).toBeCloseTo(-0.3);
    expect(confidence({ segments: [] })).toBe(-Infinity);
    expect(confidence({ segments: [{}] })).toBe(-9);
  });

  it("keeps the most confident decode, whatever the order", () => {
    const es = { text: "Apruébalo", segments: [{ avg_logprob: -0.25 }] };
    const en = { text: "Approve it", segments: [{ avg_logprob: -1.4 }] };
    expect(mostConfident([es, en])).toBe(es);
    expect(mostConfident([en, es])).toBe(es);
    expect(mostConfident([{ text: "x", segments: [] }, en])).toBe(en);
    expect(() => mostConfident([])).toThrow();
  });
});

describe("whisper.cpp server engine (a fake server on 127.0.0.1)", () => {
  it("decodes once per language and keeps the confident Spanish, so it isn't translated to English", async () => {
    got.length = 0;
    const e = whisperServerEngine({ url: base, languages: ["es", "en"] });
    expect(await e.transcribe(speech, 16_000)).toEqual({ text: "Apruébalo.", language: "es" });
    expect(got.map((g) => g.fields.language)).toEqual(["es", "en"]);
    for (const g of got) {
      expect(g.fields.response_format).toBe("verbose_json");
      expect(g.fields.temperature).toBe("0.0");
      expect(g.wav.subarray(0, 4).toString("latin1")).toBe("RIFF");
      expect(g.wav.length).toBe(44 + speech.length * 2);
    }
  });

  it("one language: one decode, forced to it; none: the server detects", async () => {
    got.length = 0;
    await whisperServerEngine({ url: base, languages: ["en"] }).transcribe(speech);
    await whisperServerEngine({ url: base, languages: [] }).transcribe(speech);
    expect(got.map((g) => g.fields.language)).toEqual(["en", undefined]);
  });

  it("probes the server", async () => {
    expect(await whisperServerEngine({ url: base, languages: [] }).probe()).toBe(true);
    expect(await whisperServerEngine({ url: "http://127.0.0.1:1", languages: [] }).probe()).toBe(false);
  });

  it("names the failure: server error, nobody listening", async () => {
    status = 500;
    await expect(whisperServerEngine({ url: base, languages: ["es"] }).transcribe(speech)).rejects.toBeInstanceOf(
      EngineFailedError,
    );
    status = 200;
    await expect(
      whisperServerEngine({ url: "http://127.0.0.1:1", languages: ["es"] }).transcribe(speech),
    ).rejects.toBeInstanceOf(EngineUnreachableError);
  });

  it("never sends audio off this computer: a non-local URL is refused before any request", async () => {
    const f = vi.fn<typeof fetch>();
    for (const url of ["https://api.example.com", "http://192.168.1.5:8178", "http://user:pw@127.0.0.1:8178", "nope"]) {
      const e = whisperServerEngine({ url, languages: ["es"], fetch: f });
      await expect(e.transcribe(speech)).rejects.toBeInstanceOf(EngineNotLocalError);
      expect(await e.probe()).toBe(false);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("'Probar' needs a whisper.cpp answer, not just any server on the port", async () => {
    let redirect = false;
    const other = createServer((req, res) => {
      if (req.url === "/elsewhere") return res.end(JSON.stringify({ text: "leaked" }));
      if (redirect) return res.writeHead(307, { location: "/elsewhere" }).end();
      res.end("<html>some other app</html>");
    });
    await new Promise<void>((ok) => other.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    try {
      expect(await whisperServerEngine({ url, languages: ["es"] }).probe()).toBe(false);
      await expect(whisperServerEngine({ url, languages: ["es"] }).transcribe(speech)).rejects.toBeInstanceOf(
        EngineNotWhisperError,
      );
      redirect = true;
      // A redirect is refused, so the audio never follows it anywhere.
      await expect(whisperServerEngine({ url, languages: ["es"] }).transcribe(speech)).rejects.toBeInstanceOf(
        EngineUnreachableError,
      );
    } finally {
      await new Promise<void>((ok) => other.close(() => ok()));
    }
  });

  it("a server that's up but too slow says so, instead of 'not running'", async () => {
    const slow = createServer(() => undefined);
    await new Promise<void>((ok) => slow.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    try {
      await expect(
        whisperServerEngine({ url, languages: ["es"], timeoutMs: 50 }).transcribe(speech),
      ).rejects.toBeInstanceOf(EngineTimeoutError);
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((ok) => slow.close(() => ok()));
    }
  });

  it("loopback addresses only", () => {
    expect(loopbackUrl("http://127.0.0.1:8178")?.port).toBe("8178");
    expect(loopbackUrl(" http://localhost:9000/ ")).not.toBeNull();
    expect(loopbackUrl("https://127.0.0.1:8178")).toBeNull();
    expect(loopbackUrl("http://127.0.0.2:8178")).toBeNull();
    expect(loopbackUrl("http://localhost.evil.com")).toBeNull();
  });
});
