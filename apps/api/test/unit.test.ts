import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { safeNextPath, tenantApiToken, verifySsoToken } from "../src/hub/sso.js";
import { rateLimit } from "../src/lib/rate-limit.js";
import { hashRecoveryCode, verifyRecoveryCode } from "../src/lib/recovery.js";

const secret = "test-sso-secret";
const now = 1_790_000_000_000;
const mint = (payload: object, key = secret) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
};
const payload = { user_id: "u-123", email: "a@b.mx", tenant_id: "u-123", tier: "pro", exp: now / 1000 + 300 };

describe("hub SSO token", () => {
  it("accepts a token signed like the hub's factory", () => {
    const res = verifySsoToken(mint(payload), secret, now);
    expect(res.ok && res.payload.user_id).toBe("u-123");
  });
  it("rejects a wrong secret, tampering, expiry and garbage", () => {
    expect(verifySsoToken(mint(payload, "other"), secret, now)).toEqual({ ok: false, reason: "bad_signature" });
    const [body, sig] = mint(payload).split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, user_id: "victim" })).toString("base64url");
    expect(verifySsoToken(`${forged}.${sig}`, secret, now).ok).toBe(false);
    expect(verifySsoToken(`${body}.${sig}`, secret, now + 301_000)).toEqual({ ok: false, reason: "expired" });
    expect(verifySsoToken("nope", secret, now)).toEqual({ ok: false, reason: "malformed" });
  });
  it("gives each token a stable single-use id", () => {
    const t = mint(payload);
    const a = verifySsoToken(t, secret, now);
    const b = verifySsoToken(t, secret, now);
    expect(a.ok && b.ok && a.sigHash === b.sigHash).toBe(true);
  });
});

describe("hub SSO token: one token, one session (review R-H2)", () => {
  it("re-encodings of a used token are malformed, not a fresh single-use id", () => {
    const t = mint(payload);
    const a = verifySsoToken(t, secret, now);
    expect(a.ok).toBe(true);
    const sig = t.split(".")[1]!;
    const last = sig.at(-1)!;
    // Same 32 bytes, different spelling: padding, stray characters, the last character's spare bits.
    // The last of 43 characters carries 4 data bits and 2 spare bits; setting a spare bit keeps the bytes.
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const spareBits = sig.slice(0, -1) + B64.charAt(B64.indexOf(last) + 1);
    expect(Buffer.from(spareBits, "base64url").equals(Buffer.from(sig, "base64url"))).toBe(true);
    for (const v of [`${t}=`, `${t}==`, `${t}!`, `${t} `, `${t.split(".")[0]}.${spareBits}`]) {
      const b = verifySsoToken(v, secret, now);
      expect(b.ok && a.ok && b.sigHash !== a.sigHash).toBe(false);
      expect(b).toEqual({ ok: false, reason: "malformed" });
    }
  });
  it("the single-use id doesn't depend on the spelling at all", () => {
    const t = mint(payload);
    const a = verifySsoToken(t, secret, now);
    const b = verifySsoToken(t, secret, now);
    expect(a.ok && b.ok && a.sigHash === b.sigHash).toBe(true);
  });
  it("a padded base64 body is refused too", () => {
    const [body, sig] = mint(payload).split(".");
    expect(verifySsoToken(`${body}=.${sig}`, secret, now)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("safeNextPath (no open redirect)", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeNextPath("/en/a/abc?x=1")).toBe("/en/a/abc?x=1");
  });
  it("rejects absolute, protocol-relative and odd paths", () => {
    for (const bad of [
      "https://evil.com",
      "//evil.com",
      "/\\evil.com",
      "javascript:alert(1)",
      "",
      null,
      "/x\r\nLocation: y",
    ]) {
      expect(safeNextPath(bad)).toBe("/");
    }
  });
});

describe("tenant api token", () => {
  it("is stable per tenant and differs between tenants", () => {
    expect(tenantApiToken("adm", "a")).toBe(tenantApiToken("adm", "a"));
    expect(tenantApiToken("adm", "a")).not.toBe(tenantApiToken("adm", "b"));
  });
});

describe("recovery codes", () => {
  it("verifies the right code (dashes optional) and rejects others", async () => {
    const code = "ABCDE-FGHJK-MNPQR-STVWX-YZ0123";
    const h = await hashRecoveryCode(code);
    expect(h.hash).not.toContain("ABCDE");
    expect(await verifyRecoveryCode(code, h)).toBe(true);
    expect(await verifyRecoveryCode(code.replace(/-/g, ""), h)).toBe(true);
    expect(await verifyRecoveryCode("ABCDE-FGHJK-MNPQR-STVWX-YZ0124", h)).toBe(false);
  });
});

describe("rate limit", () => {
  it("allows a burst up to capacity, then 429 until refill", async () => {
    let t = now;
    const app = new Hono().use(rateLimit({ capacity: 2, refillPerSec: 1, now: () => t })).get("/", (c) => c.text("ok"));
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/")).status).toBe(429);
    t += 1000;
    expect((await app.request("/")).status).toBe(200);
  });
});
