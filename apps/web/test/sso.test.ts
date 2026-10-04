import { describe, expect, it, vi } from "vitest";
import type { BrowserAuth } from "@chalito/client";
import { completeSso } from "@/lib/sso";

const okFetch = (body: unknown, ok = true) =>
  vi.fn(async () => ({ ok, json: async () => body }) as Response) as unknown as typeof fetch;

/** A fake supabase-js auth: optionally an existing session, verifyOtp success or failure. */
const fakeAuth = (opts: { existing?: boolean; verifyError?: string } = {}) => {
  let session: { access_token: string } | null = opts.existing ? { access_token: "old-user" } : null;
  const auth = {
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    verifyOtp: vi.fn(async () => {
      if (opts.verifyError) return { data: { session: null }, error: { message: opts.verifyError } };
      session = { access_token: "new-user" };
      return { data: { session }, error: null };
    }),
    setSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signOut: vi.fn(async () => {
      session = null;
    }),
  };
  return auth as typeof auth & BrowserAuth;
};

describe("completeSso", () => {
  it("exchanges the hub token (customToken = the magic-link hash), verifies it and returns a safe next", async () => {
    const f = okFetch({ customToken: "hash123", owner: "hub-user-1" });
    const auth = fakeAuth();
    const r = await completeSso(
      { token: "tok", next: "/en/a/abc" },
      { apiBase: "https://api.example", fetch: f, auth },
    );
    expect(r).toEqual({ ok: true, next: "/en/a/abc" });
    expect(f).toHaveBeenCalledWith(
      "https://api.example/sso/exchange",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "tok" }), credentials: "omit" }),
    );
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: "hash123", type: "magiclink" });
  });

  it("replaces a session already in the browser: the launch is for whoever the hub authenticated", async () => {
    const auth = fakeAuth({ existing: true });
    const r = await completeSso(
      { token: "t", next: null },
      { apiBase: "", fetch: okFetch({ customToken: "h", owner: "hub-user-1" }), auth },
    );
    expect(r.ok).toBe(true);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(auth.verifyOtp).toHaveBeenCalled();
  });

  it("never redirects off-origin", async () => {
    for (const next of ["https://evil.com", "//evil.com", "/\\evil.com", "/\t/evil.com", null]) {
      const r = await completeSso(
        { token: "t", next },
        { apiBase: "", fetch: okFetch({ customToken: "h", owner: "hub-user-1" }), auth: fakeAuth() },
      );
      expect(r).toEqual({ ok: true, next: "/inicio" });
    }
  });

  it("fails closed", async () => {
    const run = (f: typeof fetch, auth = fakeAuth()) =>
      completeSso({ token: "t", next: null }, { apiBase: "", fetch: f, auth });
    expect(
      await completeSso({ token: null, next: null }, { apiBase: "", fetch: okFetch({}), auth: fakeAuth() }),
    ).toEqual({
      ok: false,
      reason: "missing_token",
    });
    expect(await run(okFetch({}, false))).toEqual({ ok: false, reason: "exchange_failed" });
    expect(await run(okFetch({ customToken: 3, owner: "hub-user-1" }))).toEqual({
      ok: false,
      reason: "exchange_failed",
    });
    // The old, wrong shape is refused, not half-accepted.
    expect(await run(okFetch({ token_hash: "h" }))).toEqual({ ok: false, reason: "exchange_failed" });
    const boom = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await run(boom)).toEqual({ ok: false, reason: "exchange_failed" });
    expect(await run(okFetch({ customToken: "h", owner: "hub-user-1" }), fakeAuth({ verifyError: "expired" }))).toEqual(
      {
        ok: false,
        reason: "verify_failed",
      },
    );
  });
});
