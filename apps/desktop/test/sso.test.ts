import { describe, expect, it, vi } from "vitest";
import type { BrowserAuth } from "@chalito/client";
import { SSO_TTL_MS, SsoFlow, exchange, newState } from "../src/lib/sso.js";

const START = "https://chalyb.com/engines/chalito/launch";
const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};
const link = (q: Record<string, string>, base = "chalito://auth/sso") => `${base}?${new URLSearchParams(q)}`;

describe("SSO launch state", () => {
  it("begin(): a fresh 32-byte state per launch, in the start URL with the redirect", () => {
    const f = new SsoFlow(START);
    const a = f.begin();
    const b = f.begin("http://127.0.0.1:5555/auth/sso");
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.state).not.toBe(b.state);
    const u = new URL(b.url);
    expect(u.origin + u.pathname).toBe(START);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client: "desktop",
      state: b.state,
      redirect_uri: "http://127.0.0.1:5555/auth/sso",
    });
    expect(newState(() => new Uint8Array(32))).toBe("A".repeat(43));
  });

  it("refuses a non-https start URL", () => {
    expect(() => new SsoFlow("http://chalyb.com/launch")).toThrow(/https/);
  });

  it("accepts the matching callback once, with a safe next", () => {
    const f = new SsoFlow(START);
    const { state } = f.begin();
    expect(f.accept(link({ token: "tok.sig", state, next: "/ajustes" }))).toEqual({
      ok: true,
      token: "tok.sig",
      next: "/ajustes",
    });
    // Single use: the same link again finds nothing pending.
    expect(f.accept(link({ token: "tok.sig", state }))).toEqual({ ok: false, reason: "no_pending" });
  });

  it("open redirects in next are neutralised (safeNextPath)", () => {
    const f = new SsoFlow(START);
    const { state } = f.begin();
    const r = f.accept(link({ token: "t", state, next: "https://evil.example/" }));
    expect(r.ok && r.next.startsWith("/")).toBe(true);
    expect(r.ok && r.next.includes("evil")).toBe(false);
  });

  describe("rejection paths", () => {
    const pendingFlow = () => {
      const c = clock();
      const f = new SsoFlow(START, { now: c.now });
      return { f, c, state: f.begin().state };
    };

    it("malformed URL", () => {
      const { f } = pendingFlow();
      expect(f.accept("not a url")).toEqual({ ok: false, reason: "malformed" });
    });

    it.each([
      ["another scheme", "https://auth/sso"],
      ["another host", "chalito://evil/sso"],
      ["another path", "chalito://auth/other"],
      ["credentials", "chalito://user:pw@auth/sso"],
      ["a fragment", "chalito://auth/sso?x=1#frag"],
    ])("wrong target: %s", (_name, base) => {
      const { f, state } = pendingFlow();
      expect(f.accept(link({ token: "t", state }, base.split("?")[0]) + (base.includes("#") ? "#frag" : ""))).toEqual({
        ok: false,
        reason: "wrong_target",
      });
      expect(f.pending).toBe(true);
    });

    it("no sign-in in progress (a link nobody asked for)", () => {
      const f = new SsoFlow(START);
      expect(f.accept(link({ token: "t", state: "x".repeat(43) }))).toEqual({ ok: false, reason: "no_pending" });
    });

    it("state mismatch does not cancel the real pending sign-in", () => {
      const { f, state } = pendingFlow();
      expect(f.accept(link({ token: "forged", state: "y".repeat(43) }))).toEqual({
        ok: false,
        reason: "state_mismatch",
      });
      expect(f.accept(link({ token: "forged" }))).toEqual({ ok: false, reason: "state_mismatch" });
      expect(f.accept(link({ token: "real", state })).ok).toBe(true);
    });

    it("a newer launch invalidates the older state", () => {
      const { f, state } = pendingFlow();
      f.begin();
      expect(f.accept(link({ token: "t", state }))).toEqual({ ok: false, reason: "state_mismatch" });
    });

    it("expired (consumed, so it can't be retried)", () => {
      const { f, c, state } = pendingFlow();
      c.advance(SSO_TTL_MS + 1);
      expect(f.accept(link({ token: "t", state }))).toEqual({ ok: false, reason: "expired" });
      expect(f.pending).toBe(false);
    });

    it("duplicate parameters", () => {
      const { f, state } = pendingFlow();
      expect(f.accept(`chalito://auth/sso?token=a&token=b&state=${state}`)).toEqual({
        ok: false,
        reason: "duplicate_param",
      });
      expect(f.accept(`chalito://auth/sso?token=a&state=${state}&state=${state}`)).toEqual({
        ok: false,
        reason: "duplicate_param",
      });
    });

    it("missing token (state consumed)", () => {
      const { f, state } = pendingFlow();
      expect(f.accept(link({ state }))).toEqual({ ok: false, reason: "missing_token" });
      expect(f.pending).toBe(false);
    });

    it("cancel() drops the pending state", () => {
      const { f, state } = pendingFlow();
      f.cancel();
      expect(f.accept(link({ token: "t", state }))).toEqual({ ok: false, reason: "no_pending" });
    });
  });
});

const fakeAuth = (verifyOk = true) => {
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    verifyOtp: vi.fn(async () =>
      verifyOk
        ? { data: { session: { access_token: "jwt" } }, error: null }
        : { data: { session: null }, error: { message: "bad" } },
    ),
    setSession: vi.fn(),
    onAuthStateChange: vi.fn(),
  };
  return auth as unknown as BrowserAuth & { verifyOtp: typeof auth.verifyOtp };
};

const OWNER = "8a7a0d3c-5b5e-4a39-9d2b-2f8b1e0c4a11";
const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("SSO exchange", () => {
  it("posts the token once and opens the session with the magic-link hash", async () => {
    const f = respond(200, { customToken: "hash123", owner: OWNER });
    const auth = fakeAuth();
    expect(await exchange("tok.sig", { apiBase: "https://api.example", fetch: f, auth })).toEqual({
      ok: true,
      owner: OWNER,
    });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("https://api.example/sso/exchange");
    expect(JSON.parse(init.body as string)).toEqual({ token: "tok.sig" });
    expect(init.credentials).toBe("omit");
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: "hash123", type: "magiclink" });
  });

  it.each([
    ["replayed token", respond(409, { error: "token_replayed" }), "token_replayed"],
    ["rejected token", respond(401, { error: "bad_signature" }), "exchange_failed"],
    [
      "network error",
      vi.fn(async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
      "exchange_failed",
    ],
    ["bad response", respond(200, { token_hash: "old-shape" }), "bad_response"],
  ] as const)("%s → %s, and the token never appears in the result", async (_n, f, reason) => {
    const r = await exchange("SECRET-TOKEN", { apiBase: "https://api.example", fetch: f, auth: fakeAuth() });
    expect(r).toEqual({ ok: false, reason });
    expect(JSON.stringify(r)).not.toContain("SECRET-TOKEN");
  });

  it("a failed magic-link verification", async () => {
    const r = await exchange("t", {
      apiBase: "https://api.example",
      fetch: respond(200, { customToken: "h", owner: OWNER }),
      auth: fakeAuth(false),
    });
    expect(r).toEqual({ ok: false, reason: "verify_failed" });
  });
});
