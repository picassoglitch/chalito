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
});
