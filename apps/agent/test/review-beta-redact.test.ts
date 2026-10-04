/** Beta security review proof for R-M9 (docs/reviews/beta-security-review.md), kept as a regression test. */
import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";

describe("R-M9: redact() covers common provider secrets (cards are plaintext to MCP when shared)", () => {
  // Built at runtime so no literal secret-shaped string is committed (push protection).
  const fake = (prefix: string, n = 24) => `${prefix}${"Zq7".repeat(Math.ceil(n / 3)).slice(0, n)}`;
  it.each([
    fake("sk_" + "live_"),
    fake("github_" + "pat_11"),
    fake("xox" + "b-1234-5678-"),
    fake("gl" + "pat-"),
    fake("sb_" + "secret_"),
    fake("ya" + "29."),
    `{"apiKey":"${fake("v", 28)}"}`,
    `PASSWORD=${fake("h", 14)}`,
  ])("%s", (s) => {
    expect(redact(s)).not.toContain(s.slice(-10));
  });
});
