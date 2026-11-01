import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ipcHandlers } from "../src/ipc-handlers.js";
import { NativeConnectors } from "../src/native/connectors.js";
import { tempDir } from "./rc-harness.js";

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
  const set = async (hash = "") => {
    try {
      await h.setNativeConnection!({ provider: "claude", enabled: true, hash });
      return "ok";
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };
  return { dir, manager, set, warnings };
};

describe("setNativeConnection error codes", () => {
  it("names a corrupt Chalito record instead of a generic failure", async () => {
    const r = rig();
    writeFileSync(join(r.dir, "native-connectors.json"), "{not json");
    expect(await r.set((await r.manager.view("claude")).hash)).toBe("state_corrupt");
    expect(r.warnings).toEqual([]);
  });

  it("names a missing Chalito command line", async () => {
    expect(await rig({ command: [] }).set()).toBe("cli_unavailable");
  });

  it("reads broken app settings JSON as invalid_config", async () => {
    const r = rig();
    const file = r.manager.path("claude");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{broken");
    expect(await r.set()).toBe("invalid_config");
  });

  it("logs the real cause of anything it can only call internal", async () => {
    const r = rig({
      verify: async () => {
        throw new Error("keychain exploded");
      },
    });
    expect(await r.set()).toBe("internal");
    expect(r.warnings).toEqual([
      { event: "native.set_failed", meta: { provider: "claude", error: "keychain exploded" } },
    ]);
  });
});
