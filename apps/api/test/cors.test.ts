import { describe, expect, it } from "vitest";
import { apiCors, CORS_PATHS } from "../src/app.js";
import { Hono } from "hono";

const WEB = "https://chalito.chalyb.com";
const origins = [WEB, "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

const app = () => {
  const a = new Hono();
  for (const p of CORS_PATHS) a.use(p, apiCors(origins));
  a.get("/v1/billing/balance", (c) => c.json({ ok: true }));
  a.post("/sso/exchange", (c) => c.json({ ok: true }));
  a.post("/tenants", (c) => c.json({ ok: true }));
  return a;
};

const preflight = (path: string, origin: string, method = "GET") =>
  app().request(path, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": method, "access-control-request-headers": "authorization" },
  });

describe("api CORS", () => {
  it("the web origin's preflight gets the exact origin, the methods and headers, no credentials", async () => {
    const r = await preflight("/v1/billing/balance", WEB);
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(r.headers.get("access-control-allow-methods")).toContain("DELETE");
    expect((r.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain("authorization");
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    expect(Number(r.headers.get("access-control-max-age"))).toBeLessThanOrEqual(600);
  });

  it.each(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"])(
    "the desktop webview origin %s is allowed",
    async (o) => {
      const r = await app().request("/v1/billing/balance", { headers: { origin: o } });
      expect(r.headers.get("access-control-allow-origin")).toBe(o);
    },
  );

  it("the sign-in exchange is browser-callable", async () => {
    const r = await preflight("/sso/exchange", WEB, "POST");
    expect(r.headers.get("access-control-allow-origin")).toBe(WEB);
  });

  it.each([
    "https://evil.example",
    "https://chalito.chalyb.com.evil.example",
    "http://chalito.chalyb.com",
    "https://www.chalito.chalyb.com",
    "null",
    "tauri://evil",
  ])("%s gets no allow-origin", async (o) => {
    const pre = await preflight("/v1/billing/balance", o);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    const get = await app().request("/v1/billing/balance", { headers: { origin: o } });
    expect(get.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("server-to-server routes (hub /tenants) get no CORS even from the web origin", async () => {
    const r = await app().request("/tenants", { method: "POST", headers: { origin: WEB } });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});
