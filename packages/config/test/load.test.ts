import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_DIR, loadLiabilityText, readConfigFile } from "../src/load.js";

describe("readConfigFile (a compiled agent carries its config inside)", () => {
  const embedded = { "sessions.yaml": "embedded: true\n" };

  it("reads the embedded copy for the default dir", () => {
    expect(readConfigFile("sessions.yaml", CONFIG_DIR, embedded)).toBe("embedded: true\n");
  });

  it("falls back to the disk for a file that isn't embedded, or when nothing is", () => {
    expect(readConfigFile("providers.yaml", CONFIG_DIR, embedded)).toContain("providers");
    expect(readConfigFile("sessions.yaml", CONFIG_DIR, undefined)).not.toBe("embedded: true\n");
  });

  it("never uses the embedded copy for another dir (tests, tools)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-config-"));
    writeFileSync(join(dir, "sessions.yaml"), "on-disk: true\n");
    expect(readConfigFile("sessions.yaml", dir, embedded)).toBe("on-disk: true\n");
  });

  it("the liability text still loads from the repo", () => {
    expect(loadLiabilityText("en").phrase.length).toBeGreaterThan(0);
  });
});
