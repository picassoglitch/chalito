import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
// Contract: the api's real /sso/exchange route (apps/api) feeds the web's parser.
import { hubRoutes } from "../../api/src/routes/hub";
import { parseSsoExchange } from "@/lib/sso";

const SECRET = "sso-secret-for-contract";
const token = (payload: object) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
};

describe("contract: api /sso/exchange → web parseSsoExchange", () => {
  it("the web accepts exactly what the api's hub route returns, and uses customToken as the magic-link hash", async () => {
    const now = Date.now();
    const deps = {
      config: { ssoSecret: SECRET, adminToken: "admin" },
      now: () => now,
      repo: { claimSsoToken: async () => true, upsertUserFromSso: async () => undefined },
      identity: { mintUser: async () => "magic-link-hash-from-identity" },
      audit: { record: async () => undefined },
    };
    const app = hubRoutes(deps as never);
    const res = await app.request("/sso/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: token({
          user_id: "hub-user-1",
          email: "a@example.com",
          tenant_id: "hub-user-1",
          tier: "pro",
          exp: Math.floor(now / 1000) + 300,
        }),
      }),
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(parseSsoExchange(body)).toBe("magic-link-hash-from-identity");
  });
});
