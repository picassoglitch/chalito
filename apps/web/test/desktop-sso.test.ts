import { describe, expect, it } from "vitest";
import { handoffUrl, parseHandoff, validDesktopRedirect, validDesktopState } from "@/lib/desktop-sso";

const STATE = "a".repeat(43);

describe("desktop SSO bridge", () => {
  it("accepts exactly chalito://auth/sso or a loopback port ≥ 1024", () => {
    expect(validDesktopRedirect("chalito://auth/sso")).toBe("chalito://auth/sso");
    expect(validDesktopRedirect("http://127.0.0.1:53682/auth/sso")).toBe("http://127.0.0.1:53682/auth/sso");
    for (const bad of [
      "chalito://auth/sso/x",
      "chalito://evil",
      "http://127.0.0.1:80/auth/sso",
      "http://127.0.0.1:70000/auth/sso",
      "http://localhost:53682/auth/sso",
      "https://127.0.0.1:53682/auth/sso",
      "http://127.0.0.1:53682/auth/sso?x=1",
      "https://evil.example/auth/sso",
      null,
    ])
      expect(validDesktopRedirect(bad), String(bad)).toBeNull();
  });
  it("state is 43 base64url characters", () => {
    expect(validDesktopState(STATE)).toBe(STATE);
    for (const bad of ["a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}/`, null])
      expect(validDesktopState(bad)).toBeNull();
  });
  it("re-validates the cookie and builds the app link", () => {
    expect(parseHandoff(JSON.stringify({ state: STATE, redirect: "https://evil.example" }))).toBeNull();
    expect(parseHandoff("not json")).toBeNull();
    const h = parseHandoff(JSON.stringify({ state: STATE, redirect: "chalito://auth/sso" }))!;
    expect(handoffUrl(h, "tok", "/a/x")).toBe(`chalito://auth/sso?token=tok&state=${STATE}&next=%2Fa%2Fx`);
  });
});
