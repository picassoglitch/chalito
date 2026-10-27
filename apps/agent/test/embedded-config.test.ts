import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EMBEDDED_CONFIG, EMBEDDED_CONFIG_MAX_BYTES, embeddedConfigDefine } from "../scripts/embedded-config.js";

const configDir = resolve(import.meta.dirname, "../../../packages/config");

describe("config files inside the compiled agent", () => {
  it("carries every file the daemon reads, as one JSON define under the Windows command-line cap", () => {
    const json = embeddedConfigDefine((f) => readFileSync(join(configDir, f), "utf8"));
    const files = JSON.parse(json) as Record<string, string>;
    expect(Object.keys(files).sort()).toEqual([...EMBEDDED_CONFIG].sort());
    expect(files["legal/devmode-liability.en.md"]).toMatch(/^---/);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(EMBEDDED_CONFIG_MAX_BYTES);
  });

  it("refuses to build when the files outgrow the cap", () => {
    expect(() => embeddedConfigDefine(() => "x".repeat(EMBEDDED_CONFIG_MAX_BYTES))).toThrow(/over/);
  });
});
