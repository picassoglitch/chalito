import { describe, expect, it } from "vitest";
import { signStandardWebhook, verifyStandardWebhook } from "../src/voice/index.js";

const secret = `whsec_${Buffer.from("k".repeat(32)).toString("base64")}`;
const now = 1_790_000_000_000;
const ts = now / 1000;
const body = '{"type":"realtime.call.incoming"}';

describe("Standard Webhooks verification (OpenAI webhooks)", () => {
  const ok = (over: Partial<Parameters<typeof verifyStandardWebhook>[0]>) =>
    verifyStandardWebhook({
      secret,
      id: "msg_1",
      timestamp: String(ts),
      signature: signStandardWebhook(secret, "msg_1", ts, body),
      body,
      nowMs: now,
      ...over,
    });

  it("accepts a valid signature, also among several (key rotation)", () => {
    expect(ok({})).toBe(true);
    expect(ok({ signature: `v1,AAAA ${signStandardWebhook(secret, "msg_1", ts, body)}` })).toBe(true);
  });

  it("rejects a changed body, id or timestamp, a stale timestamp, other versions and missing headers", () => {
    expect(ok({ body: `${body} ` })).toBe(false);
    expect(ok({ id: "msg_2" })).toBe(false);
    expect(ok({ timestamp: String(ts + 1) })).toBe(false);
    expect(ok({ nowMs: now + 301_000 })).toBe(false);
    expect(ok({ signature: signStandardWebhook(secret, "msg_1", ts, body).replace("v1,", "v2,") })).toBe(false);
    expect(ok({ signature: undefined })).toBe(false);
    expect(ok({ timestamp: "abc" })).toBe(false);
  });
});
