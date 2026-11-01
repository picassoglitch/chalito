import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeConnectors } from "../src/native/connectors.js";

// Only renameSync is wrapped, to fail the exact writes this test names; every other call is the real one.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  return { ...real, renameSync: vi.fn(real.renameSync) };
});

const roots: string[] = [];
afterEach(() => {
  vi.mocked(fs.renameSync).mockRestore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native connector rollback", () => {
  it("reports the failed record write, not a failed rollback, and logs the rollback failure", async () => {
    const home = mkdtempSync(join(tmpdir(), "chalito-native-rollback-"));
    roots.push(home);
    mkdirSync(join(home, ".chalito"));
    mkdirSync(join(home, ".codex"));
    const logs: { event: string; meta: Record<string, unknown> }[] = [];
    const manager = new NativeConnectors({
      home,
      dir: join(home, ".chalito"),
      command: ["/opt/Chalito/chalito-agent"],
      platform: "linux",
      available: async () => true,
      verify: async () => true,
      onDisconnect: () => undefined,
      log: (event, meta) => void logs.push({ event, meta }),
    });
    const settings = manager.path("codex");
    writeFileSync(settings, '{"keep":true}');
    const real = vi.mocked(fs.renameSync).getMockImplementation()!;
    let settingsWrites = 0;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(to).endsWith("native-connectors.json")) throw new Error("state_write_failed_here");
      if (String(to) === settings && ++settingsWrites === 2) throw new Error("rollback_failed_here");
      real(from, to);
    });
    const view = await manager.view("codex");
    await expect(manager.set("codex", true, view.hash)).rejects.toThrow("state_write_failed_here");
    expect(logs).toContainEqual({ event: "native.rollback_failed", meta: { provider: "codex", error: "other" } });
    expect(readFileSync(settings, "utf8")).toContain("native-hook");
  });
});
