import { describe, expect, it, vi } from "vitest";
import { completeSso } from "@/lib/sso";

const okFetch = (body: unknown, ok = true) =>
  vi.fn(async () => ({ ok, json: async () => body }) as Response) as unknown as typeof fetch;
const auth = (error: unknown = null) => ({ auth: { verifyOtp: vi.fn(async () => ({ data: {}, error })) } });

describe("completeSso", () => {
  it("exchanges the hub token, verifies the magic-link hash and returns a safe next", async () => {
    const f = okFetch({ customToken: "hash123", owner: "u1" });
    const sb = auth();
    const r = await completeSso(
      { token: "tok", next: "/en/a/abc" },
      { apiBase: "https://api.example", fetch: f, supabase: sb as never },
    );
    expect(r).toEqual({ ok: true, next: "/en/a/abc" });
    expect(f).toHaveBeenCalledWith(
      "https://api.example/sso/exchange",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "tok" }), credentials: "omit" }),
    );
    expect(sb.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: "hash123", type: "email" });
  });

  it("never redirects off-origin", async () => {
    for (const next of ["https://evil.com", "//evil.com", "/\\evil.com", "/\t/evil.com", null]) {
      const r = await completeSso(
        { token: "t", next },
        { apiBase: "", fetch: okFetch({ customToken: "h" }), supabase: auth() as never },
      );
      expect(r).toEqual({ ok: true, next: "/" });
    }
  });

  it("fails closed", async () => {
    const deps = (f: typeof fetch, error: unknown = null) => ({
      apiBase: "",
      fetch: f,
      supabase: auth(error) as never,
    });
    expect(await completeSso({ token: null, next: null }, deps(okFetch({})))).toEqual({
      ok: false,
      reason: "missing_token",
    });
    expect(await completeSso({ token: "t", next: null }, deps(okFetch({}, false)))).toEqual({
      ok: false,
      reason: "exchange_failed",
    });
    expect(await completeSso({ token: "t", next: null }, deps(okFetch({ customToken: 3 })))).toEqual({
      ok: false,
      reason: "exchange_failed",
    });
    const boom = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await completeSso({ token: "t", next: null }, deps(boom))).toEqual({ ok: false, reason: "exchange_failed" });
    expect(
      await completeSso({ token: "t", next: null }, deps(okFetch({ customToken: "h" }), { message: "expired" })),
    ).toEqual({
      ok: false,
      reason: "verify_failed",
    });
  });
});
