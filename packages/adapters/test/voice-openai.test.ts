import { describe, expect, it } from "vitest";
import { openaiRealtime } from "../src/voice/openai.js";

const SESSION = { model: "gpt-realtime", instructions: "hola", voice: "marin", tools: [] };

const capture = (respond: (req: Request) => Response) => {
  const calls: Request[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const req = new Request(url, init);
    calls.push(req.clone());
    return respond(req);
  }) as unknown as typeof globalThis.fetch;
  return { calls, provider: openaiRealtime({ apiKey: "sk-test", fetch }) };
};

describe("OpenAI Realtime: the api-proxied WebRTC call", () => {
  it("posts the offer + session (multipart) with the server key; returns the answer and the call id", async () => {
    const c = capture(
      () => new Response("v=0\r\nanswer", { status: 201, headers: { location: "/v1/realtime/calls/rtc_abc123" } }),
    );
    const r = await c.provider.connectCall({ sdp: "v=0\r\noffer", session: SESSION, safetyIdentifier: "h1" });
    expect(r).toEqual({ answerSdp: "v=0\r\nanswer", callId: "rtc_abc123" });
    const req = c.calls[0]!;
    expect(req.url).toBe("https://api.openai.com/v1/realtime/calls");
    expect(req.headers.get("authorization")).toBe("Bearer sk-test");
    expect(req.headers.get("openai-safety-identifier")).toBe("h1");
    const form = await req.formData();
    expect(form.get("sdp")).toBe("v=0\r\noffer");
    expect(JSON.parse(String(form.get("session")))).toMatchObject({ type: "realtime", model: "gpt-realtime" });
  });

  it("refuses an answer without a call id (the api must be able to hang up), and an error status", async () => {
    await expect(
      capture(() => new Response("v=0", { status: 201 })).provider.connectCall({
        sdp: "x",
        session: SESSION,
        safetyIdentifier: "h",
      }),
    ).rejects.toThrow(/no call id/);
    await expect(
      capture(() => new Response("", { status: 400 })).provider.connectCall({
        sdp: "x",
        session: SESSION,
        safetyIdentifier: "h",
      }),
    ).rejects.toThrow(/400/);
  });

  it("hang-up: POST /v1/realtime/calls/{id}/hangup; an already-ended call (404) is fine", async () => {
    const ok = capture(() => new Response("{}", { status: 200 }));
    await ok.provider.hangupCall("rtc_abc123");
    expect(ok.calls[0]!.url).toBe("https://api.openai.com/v1/realtime/calls/rtc_abc123/hangup");
    expect(ok.calls[0]!.method).toBe("POST");
    await capture(() => new Response("", { status: 404 })).provider.hangupCall("rtc_gone");
    await expect(capture(() => new Response("", { status: 500 })).provider.hangupCall("rtc_x")).rejects.toThrow(/500/);
  });
});
