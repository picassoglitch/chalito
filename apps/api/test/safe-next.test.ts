/** safeNextPath after normalisation (review R-M1): no protocol-relative or off-origin redirect. */
import { describe, expect, it } from "vitest";
import { safeNextPath } from "../src/hub/sso.js";

const lands = (next: string) => new URL(safeNextPath(next), "https://chalito.chalyb.com");

describe("safeNextPath", () => {
  it.each([
    "/.//evil.com",
    "/%2e//evil.com",
    "/%2E/%2E//evil.com",
    "/a/..//evil.com",
    "/./\\evil.com",
    "/\\evil.com",
    "/%2F%2Fevil.com",
    "/%2f/evil.com",
    "/%5C%5Cevil.com",
    "//evil.com",
    "///evil.com",
    "https://evil.com",
    "/\t/evil.com",
    "/x\r\nLocation: https://evil.com",
    "",
    "evil.com",
  ])("%j stays on our origin, at /", (next) => {
    expect(lands(next).origin).toBe("https://chalito.chalyb.com");
    expect(safeNextPath(next)).toBe("/");
  });

  it.each([
    ["/en/a/abc?x=1", "/en/a/abc?x=1"],
    ["/r/room_1#top", "/r/room_1#top"],
    ["/a/./b/../c", "/a/c"],
    ["/creditos", "/creditos"],
  ])("%j → %j (same-origin paths survive, normalised)", (next, want) => {
    expect(safeNextPath(next)).toBe(want);
  });

  it("never returns anything starting with // or containing a backslash", () => {
    for (const n of ["/.//a", "/..//a", "/a/../..//b", "/%2e%2e//c"]) {
      const out = safeNextPath(n);
      expect(out.startsWith("//")).toBe(false);
      expect(out.includes("\\")).toBe(false);
    }
  });
});
