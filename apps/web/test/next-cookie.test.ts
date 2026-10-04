import { afterEach, describe, expect, it } from "vitest";
import { NEXT_COOKIE, allowedNext, rememberNext, takeNext } from "@/lib/next-cookie";

afterEach(() => {
  document.cookie = `${NEXT_COOKIE}=; Max-Age=0; Path=/`;
});

describe("chalito_next (the hub drops `next`)", () => {
  it("allows only same-origin app paths", () => {
    expect(allowedNext("/n/n1")).toBe("/n/n1");
    expect(allowedNext("/en/a/apr_1?x=1")).toBe("/en/a/apr_1?x=1");
    for (const bad of [
      "https://evil.example/",
      "//evil.example",
      "/\\evil",
      "/api/sso/exchange",
      "/_next/static/x",
      "/auth/sso?token=t",
      "/en/auth/sso",
      null,
    ])
      expect(allowedNext(bad), String(bad)).toBe("/inicio");
  });

  it("remembers once and clears on read", () => {
    rememberNext("/n/n1");
    expect(document.cookie).toContain(`${NEXT_COOKIE}=%2Fn%2Fn1`);
    expect(takeNext()).toBe("/n/n1");
    expect(takeNext()).toBeNull();
  });

  it("a tampered cookie lands home", () => {
    for (const v of ["https%3A%2F%2Fevil.example%2F", "%2F%2Fevil.example", "%2Fapi%2Fx", "%E0%A4%A"]) {
      document.cookie = `${NEXT_COOKIE}=${v}; Path=/`;
      const got = takeNext();
      expect(got === "/inicio" || got === null, v).toBe(true);
    }
  });
});

describe("SSO state nonce (login CSRF, review R-M1)", () => {
  it("a stored nonce is read once; only a launch we started (and a matching echo) passes", async () => {
    const { SSO_STATE_COOKIE, ssoStateMatches, takeSsoState } = await import("@/lib/next-cookie");
    const nonce = "A".repeat(43);
    document.cookie = `${SSO_STATE_COOKIE}=${nonce}; Path=/`;
    const got = takeSsoState();
    expect(got).toBe(nonce);
    expect(takeSsoState()).toBeNull();
    expect(ssoStateMatches(got, null)).toBe(true);
    expect(ssoStateMatches(got, nonce)).toBe(true);
    expect(ssoStateMatches(got, "B".repeat(43))).toBe(false);
    expect(ssoStateMatches(null, null)).toBe(false);
    expect(ssoStateMatches(null, nonce)).toBe(false);
    // A malformed cookie value is no state at all.
    document.cookie = `${SSO_STATE_COOKIE}=short; Path=/`;
    expect(takeSsoState()).toBeNull();
  });
  it("dot-segment and encoded-slash nexts never survive as a return path", () => {
    for (const bad of ["/.//evil.example", "/%2e//evil.example", "/a/..//evil.example", "/%2F%2Fevil.example"])
      expect(allowedNext(bad)).toBe("/inicio");
  });
});
