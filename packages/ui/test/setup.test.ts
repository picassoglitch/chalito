import { describe, expect, it } from "vitest";
import { setupChecklist, type SetupInput } from "../src/setup.js";

const base: SetupInput = { signedIn: true, deviceReady: true, computers: [], sessions: 0 };
const done = (i: SetupInput) =>
  setupChecklist(i)
    .steps.filter((s) => s.done)
    .map((s) => s.id);

describe("First Run D: the setup checklist reads only real state", () => {
  it("a brand-new account: only the account is done, and the next step is this browser", () => {
    const s = setupChecklist({ ...base, deviceReady: false });
    expect(done({ ...base, deviceReady: false })).toEqual(["account"]);
    expect(s.current).toBe("browser");
    expect(s.complete).toBe(false);
  });

  it("signed out: nothing is done, not even what a stale device would say", () => {
    const s = setupChecklist({
      signedIn: false,
      deviceReady: true,
      computers: [{ adapters: ["codex"], workspaces: 1 }],
      sessions: 3,
    });
    expect(s.doneCount).toBe(0);
    expect(s.current).toBe("account");
  });

  it("a paired computer with nothing set up yet", () => {
    const s = setupChecklist({ ...base, computers: [{ adapters: [], workspaces: 0 }] });
    expect(s.current).toBe("ai");
    expect(done({ ...base, computers: [{ adapters: [], workspaces: 0 }] })).toEqual(["account", "browser", "computer"]);
  });

  it("the directory hint counts as a computer before this device can list it", () => {
    expect(setupChecklist({ ...base, deviceReady: false, computerHint: true }).steps[2]).toEqual({
      id: "computer",
      done: true,
    });
  });

  it("an app and a folder on any computer, then the first task", () => {
    const computers = [
      { adapters: ["claude-code"], workspaces: 0 },
      { adapters: [], workspaces: 2 },
    ];
    const s = setupChecklist({ ...base, computers });
    expect(s.current).toBe("firstTask");
    expect(setupChecklist({ ...base, computers, sessions: 1 })).toMatchObject({
      complete: true,
      current: null,
      doneCount: 6,
    });
  });

  it("a session already run proves an app and a folder (an agent too old to report its setup)", () => {
    expect(setupChecklist({ ...base, computers: [{ adapters: [], workspaces: 0 }], sessions: 1 }).complete).toBe(true);
  });
});
