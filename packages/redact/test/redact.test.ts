import { describe, expect, it } from "vitest";
import { createLogger, installConsoleRedaction, redact, redactDeep, redactError } from "../src/index.js";

// Built at runtime so no literal secret-shaped string is committed (push protection).
const fake = (prefix: string, n = 24) => `${prefix}${"Zq7".repeat(Math.ceil(n / 3)).slice(0, n)}`;

describe("redact (R-M9)", () => {
  it.each([
    fake("sk_" + "live_"),
    fake("rk_" + "live_"),
    fake("github_" + "pat_11"),
    fake("xox" + "b-1234-5678-"),
    fake("gl" + "pat-"),
    fake("np" + "m_", 36),
    fake("sb_" + "secret_"),
    fake("ya" + "29."),
    fake("1" + "//0g", 40),
    fake("EA" + "AB", 40),
    fake("chalito_" + "at_", 43),
    fake("chalito_" + "rt_", 43),
    `{"apiKey":"${fake("v", 28)}"}`,
    `PASSWORD=${fake("h", 14)}`,
    `twilio_auth_token: ${"a1b2c3d4".repeat(4)}`,
    `client_secret="${fake("c", 20)}"`,
    `https://x.example/cb?code=${fake("q", 30)}&state=ok`,
    `Authorization: Basic ${Buffer.from("user:" + fake("p", 16)).toString("base64")}`,
  ])("%s", (s) => {
    expect(redact(s)).not.toContain(s.slice(-10));
  });

  it("keeps ordinary text, and the parameter names", () => {
    expect(redact("the token expired; retry later")).toBe("the token expired; retry later");
    expect(redact("https://x.example/cb?state=ok&code=abcdef123456")).toBe("https://x.example/cb?state=ok&code=…");
    expect(redact("call +52 55 1234 5678")).toBe("call …78");
  });

  it("errors become redacted data, never the raw object", () => {
    const e = new Error(`hub said: Bearer ${fake("t", 30)} invalid for a@b.mx`);
    const r = redactError(e);
    expect(r.message).toBe("hub said: Bearer … invalid for <email>");
    expect(r.stack).not.toContain(fake("t", 30));
  });

  it("createLogger and the console sanitizer redact everything they write", () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l)).error("failed", { err: new Error(`key ${fake("sk-proj-", 30)}`) });
    expect(lines.join()).not.toContain(fake("sk-proj-", 30).slice(-10));
    const out: unknown[][] = [];
    const fakeConsole = {
      log: (...a: unknown[]) => out.push(a),
      info: () => {},
      warn: () => {},
      error: (...a: unknown[]) => out.push(a),
      debug: () => {},
    } as unknown as Console;
    installConsoleRedaction(fakeConsole);
    installConsoleRedaction(fakeConsole);
    fakeConsole.error(new Error(`boom ${fake("gh" + "p_", 30)}`), { url: `https://h/x?token=${fake("z", 20)}` });
    expect(JSON.stringify(out)).not.toMatch(/Zq7Zq7Zq7/);
    expect(out).toHaveLength(1);
  });

  it("drops a bare secret held under a secret-named key (no prefix to match)", () => {
    const twilio = "a1b2c3d4".repeat(4);
    const out = redactDeep({ authToken: twilio, api_token: fake("h", 43), password: "hunter22", note: "ok" });
    expect(JSON.stringify(out)).not.toContain(twilio);
    expect(JSON.stringify(out)).not.toContain(fake("h", 43));
    expect(out).toMatchObject({ authToken: "…", api_token: "…", password: "…", note: "ok" });
    // Counts and other non-strings stay (a "maxTokens" number is not a secret).
    expect(redactDeep({ maxTokens: 5, tokens: { input: 3 } })).toEqual({ maxTokens: 5, tokens: { input: 3 } });
  });

  it("a cyclic object is logged, not a stack overflow", () => {
    const a: Record<string, unknown> = { name: "x" };
    a.self = a;
    const shared = { v: 1 };
    expect(redactDeep({ a, b: [shared, shared] })).toEqual({
      a: { name: "x", self: "[Circular]" },
      b: [{ v: 1 }, { v: 1 }],
    });
  });
});
