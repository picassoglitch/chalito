import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ipcHandlers } from "../src/ipc-handlers.js";
import { NativeConnectors } from "../src/native/connectors.js";
import { tempDir } from "./rc-harness.js";
import { seedOldHooks } from "./native-seed.js";

/** The panel's connector toggle through the real handler and a real connector on a temp home. */
const rig = (opts: { command?: string[]; verify?: () => Promise<boolean> } = {}) => {
  const home = tempDir("chalito-ipc-native-");
  const dir = join(home, ".chalito");
  mkdirSync(dir);
  const manager = new NativeConnectors({
    home,
    dir,
    command: opts.command ?? ["/opt/Chalito/chalito-agent"],
    platform: "linux",
    available: async () => true,
    verify: opts.verify ?? (async () => true),
    onDisconnect: () => undefined,
  });
  const warnings: { event: string; meta: Record<string, unknown> }[] = [];
  const h = ipcHandlers({
    nativeConnectors: manager,
    warn: (event: string, meta: Record<string, unknown>) => void warnings.push({ event, meta }),
  } as never);
  const set = async (hash = "", enabled = true) => {
    try {
      await h.setNativeConnection!({ provider: "claude", enabled, hash });
      return "ok";
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };
  return { home, dir, manager, set, warnings };
};

describe("setNativeConnection error codes", () => {
  // Owner 2026-11-03 — Chalito is a bridge, not a gate: the panel can no longer connect an app.
  it("names a connect request as retired and changes nothing", async () => {
    const r = rig();
    expect(await r.set((await r.manager.view("claude")).hash)).toBe("retired");
    expect(existsSync(r.manager.path("claude"))).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it("still disconnects old hooks, even with a corrupt Chalito record", async () => {
    const r = rig();
    const { path } = seedOldHooks({ home: r.home, dir: r.dir, provider: "claude" });
    writeFileSync(join(r.dir, "native-connectors.json"), "{not json");
    expect(await r.set((await r.manager.view("claude")).hash, false)).toBe("ok");
    expect(readFileSync(path, "utf8")).not.toContain("native-hook");
  });

  it("reads broken app settings JSON as invalid_config", async () => {
    const r = rig();
    const file = r.manager.path("claude");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{broken");
    expect(await r.set("", false)).toBe("invalid_config");
  });

  it("logs the real cause of anything it can only call internal", async () => {
    const r = rig({
      verify: async () => {
        throw new Error("keychain exploded");
      },
    });
    seedOldHooks({ home: r.home, dir: r.dir, provider: "claude" });
    expect(await r.set((await r.manager.view("claude")).hash, false)).toBe("internal");
    expect(r.warnings).toEqual([
      { event: "native.set_failed", meta: { provider: "claude", error: "keychain exploded" } },
    ]);
  });
});
