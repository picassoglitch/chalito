/**
 * Beta security review proofs (docs/reviews/beta-security-review.md). Every test here FAILS on
 * origin/all b026abf; each one passes once the matching finding is fixed.
 */
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { safeNextPath, verifySsoToken } from "../src/hub/sso.js";
import { rateLimit } from "../src/lib/rate-limit.js";
import { providerOf } from "../src/oauth/clients.js";

const secret = "test-sso-secret";
const now = 1_790_000_000_000;
const mint = (payload: object) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
};
const payload = { user_id: "u-123", email: "a@b.mx", tenant_id: "u-123", tier: "pro", exp: now / 1000 + 300 };

describe("R-H2: a used hub SSO token can't be replayed by re-encoding its signature", () => {
  it("equivalent encodings either fail or keep the same single-use id", () => {
    const t = mint(payload);
    const a = verifySsoToken(t, secret, now);
    expect(a.ok).toBe(true);
    for (const v of [`${t}=`, `${t}!`, `${t}==`]) {
      const b = verifySsoToken(v, secret, now);
      // Today: b.ok is true with a NEW sigHash, so claimSsoToken lets it through again.
      expect(b.ok && a.ok && b.sigHash !== a.sigHash).toBe(false);
    }
  });
});

describe("R-M1: safeNextPath can't be steered off-origin with dot segments", () => {
  it("normalised paths never become protocol-relative", () => {
    for (const n of ["/.//evil.com", "/%2e//evil.com", "/a/..//evil.com"])
      expect(new URL(safeNextPath(n), "https://chalito.chalyb.com").origin).toBe("https://chalito.chalyb.com");
  });
});

describe("R-M2: rate limits key on the real client, not a spoofed leftmost X-Forwarded-For", () => {
  it("rotating the spoofed hop doesn't reset the bucket", async () => {
    const app = new Hono().use(rateLimit({ capacity: 1, refillPerSec: 0, now: () => 0 })).get("/", (c) => c.text("ok"));
    const hit = (spoof: string) => app.request("/", { headers: { "x-forwarded-for": `${spoof}, 203.0.113.9` } });
    expect((await hit("1.1.1.1")).status).toBe(200);
    expect((await hit("2.2.2.2")).status).toBe(429);
  });
});

describe("R-M3: an OAuth client isn't 'claude' just because one redirect is on claude.ai", () => {
  it("DCR/loopback or foreign CIMD clients stay 'other'", () => {
    expect(providerOf({ clientId: "dcr_x", redirectUris: ["https://claude.ai/x", "http://127.0.0.1/cb"] })).toBe(
      "other",
    );
    expect(providerOf({ clientId: "https://evil.example/cimd.json", redirectUris: ["https://claude.ai/cb"] })).toBe(
      "other",
    );
  });
});
