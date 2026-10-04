import { describe, expect, it } from "vitest";
import { createOrchestrator } from "../src/app.js";
import { harness } from "./harness.js";

const WEB = "https://chalito.chalyb.com";

const app = async (webOrigin?: string) => {
  const h = await harness();
  return createOrchestrator({
    ...h.deps,
    wrapper: h.wrapper,
    audit: () => undefined,
    authn: { verify: async () => ({ owner: "hub-user-1", deviceId: "dev_phone", role: "client" }) },
    ...(webOrigin ? { webOrigin } : {}),
  });
};
const preflight = (a: Awaited<ReturnType<typeof app>>, origin: string, method = "GET") =>
  a.request("/v1/usage/daily", {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": method, "access-control-request-headers": "authorization" },
  });

describe("CORS: the web origin only", () => {
  it("the web origin's preflight is allowed: exact origin, bearer headers, GET/POST, no credentials, short cache", async () => {
    const a = await app(WEB);
    const res = await preflight(a, WEB);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(res.headers.get("access-control-allow-methods")).toBe("GET,POST,OPTIONS");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toBe("authorization,content-type");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(Number(res.headers.get("access-control-max-age"))).toBeLessThanOrEqual(600);
    expect(res.headers.get("vary")).toMatch(/origin/i);
  });

  it("the actual request from the web origin carries the header", async () => {
    const a = await app(WEB);
    const res = await a.request("/v1/usage/daily", { headers: { origin: WEB, authorization: "Bearer t" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(WEB);
  });

  it.each([
    "https://evil.example",
    "https://chalito.chalyb.com.evil.example",
    "http://chalito.chalyb.com",
    "https://www.chalito.chalyb.com",
    "null",
  ])("another origin (%s) gets no Access-Control-Allow-Origin", async (origin) => {
    const a = await app(WEB);
    expect((await preflight(a, origin)).headers.get("access-control-allow-origin")).toBeNull();
    const res = await a.request("/v1/usage/daily", { headers: { origin, authorization: "Bearer t" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("no web origin configured: no CORS at all", async () => {
    const a = await app();
    expect((await preflight(a, WEB)).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("a trailing slash or path in CHALITO_WEB_ORIGIN is normalised to the origin", async () => {
    const a = await app(`${WEB}/`);
    expect((await preflight(a, WEB)).headers.get("access-control-allow-origin")).toBe(WEB);
  });
});
