import { describe, expect, it } from "vitest";
import { safeNextPath } from "../src/safe-next.js";

describe("safeNextPath (no open redirect)", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeNextPath("/en/a/abc?x=1")).toBe("/en/a/abc?x=1");
    expect(safeNextPath("/creditos#top")).toBe("/creditos#top");
  });
  it("rejects absolute, protocol-relative and odd paths", () => {
    for (const bad of [
      "https://evil.com",
      "//evil.com",
      "/\\evil.com",
      "/\t/evil.com",
      "javascript:alert(1)",
      "",
      null,
      undefined,
      "/x\r\nLocation: y",
    ]) {
      expect(safeNextPath(bad)).toBe("/");
    }
  });
  it("rejects what only becomes `//host` after normalisation (review R-M1)", () => {
    for (const bad of [
      "/.//evil.com",
      "/%2e//evil.com",
      "/%2E//evil.com",
      "/a/..//evil.com",
      "/././/evil.com",
      "/%2fevil.com",
      "/%2F%2Fevil.com",
      "/%5cevil.com",
      "/a\\b",
      "/\u202e/x",
      "/ /x",
    ])
      expect(safeNextPath(bad), bad).toBe("/");
  });
  it("never returns a protocol-relative or off-site path, whatever the input", () => {
    const parts = [
      "/",
      ".",
      "..",
      "%2e",
      "%2E",
      "//",
      "\\",
      "%2f",
      "%5C",
      "\t",
      "\r\n",
      "evil.com",
      "a",
      "?x=//y",
      "#//z",
    ];
    for (let i = 0; i < 4000; i++) {
      let s = "/";
      for (let j = 0; j < 1 + (i % 6); j++) s += parts[(i * 7 + j * 13) % parts.length];
      const r = safeNextPath(s);
      expect(r.startsWith("/") && !r.startsWith("//") && !r.startsWith("/\\"), s).toBe(true);
    }
    expect(safeNextPath("/" + "a".repeat(2048))).toBe("/");
  });
  it("normalises harmless dot segments", () => {
    expect(safeNextPath("/a/../creditos")).toBe("/creditos");
    expect(safeNextPath("/./ajustes?x=%20y")).toBe("/ajustes?x=%20y");
  });
});
