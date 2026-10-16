import { describe, expect, it, vi } from "vitest";
import { DevicePresence, DeviceSetup } from "@chalito/protocol";
import { deviceSetup, setupReporter } from "../src/setup-report.js";
import { SupabaseStore } from "../src/supabase-store.js";
import { FakeSupabase } from "./fake-supabase.js";

const HASH = "a".repeat(64);
const HOME = "/Users/aldo";
const pin = (p: string) => ({ path: `${HOME}/${p}`, sha256: HASH });

describe("First Run D: the setup a computer reports (never paths)", () => {
  it("lists pinned app ids, the folder count and labels", () => {
    const s = deviceSetup(
      {
        claude: pin(".claude/local/claude"),
        codex: pin(".local/bin/codex"),
        appPins: { aider: pin(".local/bin/aider") },
      },
      {
        workspaces: [
          { label: "chalito", path: `${HOME}/code/chalito` },
          { label: "web-2", path: `${HOME}/code/web` },
        ],
      },
    );
    expect(s).toEqual({ adapters: ["aider", "claude-code", "codex"], workspaces: 2, labels: ["chalito", "web-2"] });
    expect(JSON.stringify(s)).not.toContain(HOME);
    expect(JSON.stringify(s)).not.toContain(HASH);
  });

  it("drops a label that looks like a path, but still counts the folder", () => {
    const s = deviceSetup(
      {},
      {
        workspaces: [
          { label: "/Users/aldo/secret", path: `${HOME}/secret` },
          { label: "~/notes", path: `${HOME}/notes` },
          { label: "C:proj", path: "C:\\proj" },
          { label: "a\\b", path: `${HOME}/ab` },
          { label: "ok", path: `${HOME}/ok` },
        ],
      },
    );
    expect(s).toEqual({ adapters: [], workspaces: 5, labels: ["ok"] });
  });

  it("is empty for a fresh computer", () => {
    expect(deviceSetup({}, { workspaces: [] })).toEqual({ adapters: [], workspaces: 0, labels: [] });
  });

  it("the wire schema is strict: no extra field can ride along", () => {
    expect(DeviceSetup.safeParse({ adapters: [], workspaces: 0, labels: [], paths: ["/x"] }).success).toBe(false);
    expect(DevicePresence.safeParse({ desktopActive: true, home: "/Users/aldo" }).success).toBe(false);
    expect(DeviceSetup.safeParse({ adapters: ["../x"], workspaces: 0, labels: [] }).success).toBe(false);
  });

  it("reports only when something changed, and retries after a failed write", async () => {
    let cur = deviceSetup({}, { workspaces: [] });
    const write = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const report = setupReporter(() => cur, write);
    await expect(report()).rejects.toThrow("offline");
    await report();
    await report();
    expect(write).toHaveBeenCalledTimes(2);
    cur = { ...cur, workspaces: 1, labels: ["w"] };
    await report();
    expect(write).toHaveBeenCalledTimes(3);
  });
});

describe("SupabaseStore: presence is merged, never partially overwritten", () => {
  const OWNER = "hub-user-1";
  const DEV = `dev_${"a".repeat(22)}`;

  it("keeps desktopActive when the setup is reported, and the other way round", async () => {
    const db = new FakeSupabase();
    const store = new SupabaseStore(db, OWNER, DEV);
    db.seed("devices", { owner: OWNER, device_id: DEV });
    await store.updateDevice({ presence: { desktopActive: true } });
    const setup = { adapters: ["claude-code"], workspaces: 1, labels: ["w"] };
    await store.updateDevice({ presence: { setup } });
    expect(db.ops.at(-1)!.body).toEqual({ presence: { desktopActive: true, setup } });
    await store.updateDevice({ presence: { desktopActive: false } });
    expect(db.rows("devices")[0]!.presence).toEqual({ desktopActive: false, setup });
  });

  it("refuses a presence with a path in it before writing anything", async () => {
    const db = new FakeSupabase();
    const store = new SupabaseStore(db, OWNER, DEV);
    db.seed("devices", { owner: OWNER, device_id: DEV });
    const n = db.ops.length;
    await expect(
      store.updateDevice({ presence: { setup: { adapters: [], workspaces: 1, labels: ["/Users/aldo/x"] } } }),
    ).rejects.toThrow();
    expect(db.ops.length).toBe(n);
  });
});
