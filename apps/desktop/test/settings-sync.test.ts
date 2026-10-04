import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsError } from "@chalito/client/settings";
import { DEFAULT_SETTINGS, type SettingsValues } from "@chalito/ui";
import { DesktopSettings } from "../src/lib/settings-sync.js";

/** A server that refuses opting into calls without a verified phone, like update_my_settings. */
const fakeServer = (initial: SettingsValues = DEFAULT_SETTINGS) => {
  let row = { ...initial };
  const calls: unknown[][] = [];
  return {
    calls,
    load: vi.fn(async () => ({ values: row, onboarded: true })),
    save: vi.fn(async <K extends keyof SettingsValues>(k: K, v: SettingsValues[K]) => {
      calls.push(["save", k, v]);
      if (k === "calls" && v && !row.phone.verified) throw new SettingsError("rejected", "needs a verified phone");
      row = { ...row, [k]: v };
    }),
    saveCompanion: vi.fn(async (v: Pick<SettingsValues, "avatar" | "companionName">) => {
      calls.push(["saveCompanion", v.companionName.name]);
      row = { ...row, avatar: v.avatar, companionName: v.companionName };
    }),
  };
};

const local = () => {
  let stored: SettingsValues = DEFAULT_SETTINGS;
  return { load: () => stored, save: vi.fn((v: SettingsValues) => void (stored = v)) };
};

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("desktop settings (server-backed, PWA semantics)", () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true }));
  afterEach(() => void vi.useRealTimers());

  it("without a session: this device only", async () => {
    const l = local();
    const s = new DesktopSettings(null, l);
    await s.start();
    expect(s.getSnapshot()).toMatchObject({ values: DEFAULT_SETTINGS, persisted: "device" });
    s.set("whatsapp", true);
    expect(l.save).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, whatsapp: true });
  });

  it("signed in: saves per setting and re-reads the server's view", async () => {
    const server = fakeServer();
    const s = new DesktopSettings(server, local());
    await s.start();
    expect(s.getSnapshot().persisted).toBe("server");
    s.set("renderQuality", "alto");
    expect(s.getSnapshot().values!.renderQuality).toBe("alto"); // optimistic
    await settle();
    expect(server.calls).toEqual([["save", "renderQuality", "alto"]]);
    expect(server.load).toHaveBeenCalledTimes(2);
  });

  it("a refused change snaps back and reports `rejected`", async () => {
    const s = new DesktopSettings(fakeServer(), local());
    await s.start();
    s.set("calls", true);
    expect(s.getSnapshot().values!.calls).toBe(true);
    await settle();
    await settle();
    expect(s.getSnapshot()).toMatchObject({ error: "rejected" });
    expect(s.getSnapshot().values!.calls).toBe(false);
  });

  it("companion name edits are debounced into one save", async () => {
    const server = fakeServer();
    const s = new DesktopSettings(server, local(), 500);
    await s.start();
    for (const name of ["P", "Pa", "Pac", "Paco"]) s.set("companionName", { name, isRenamed: true });
    vi.advanceTimersByTime(499);
    expect(server.saveCompanion).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await settle();
    expect(server.calls).toEqual([["saveCompanion", "Paco"]]);
  });

  it("an unreachable server falls back to this device", async () => {
    const server = fakeServer();
    server.load.mockRejectedValueOnce(new Error("offline"));
    const l = local();
    const s = new DesktopSettings(server, l);
    await s.start();
    expect(s.getSnapshot()).toMatchObject({ persisted: "device", error: "failed" });
    s.set("whatsapp", true);
    expect(server.save).not.toHaveBeenCalled();
    expect(l.save).toHaveBeenCalled();
  });
});
