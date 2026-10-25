import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityTracker, behaviourFor, activityActions } from "@chalito/avatar";
import { TextProviders } from "../src/lib/i18n.js";
import { unavailableIpc, type AgentIpc, type OwnSessionView } from "../src/lib/ipc.js";
import {
  OwnSessionsFeed,
  alertId,
  codexHookSnippet,
  maxLevel,
  mergeActivity,
  ownLevel,
  ownNotices,
  ownSessionLikes,
} from "../src/lib/own-sessions.js";
import { OwnSessions, OwnSessionsSettings } from "../src/panel/OwnSessions.js";

afterEach(cleanup);

const view = (over: Partial<OwnSessionView> = {}): OwnSessionView => ({
  key: "claude:s1",
  source: "claude",
  id: "s1",
  cwd: "/home/ana/code/tienda",
  title: null,
  state: "working",
  since: 1000,
  detail: null,
  detailKey: null,
  level: null,
  reviewing: false,
  guessed: false,
  seen: false,
  ...over,
});

const ipcWith = (sessions: OwnSessionView[], enabled = true, over: Partial<AgentIpc> = {}): AgentIpc => {
  let on = enabled;
  return {
    ...unavailableIpc,
    ownSessions: vi.fn(async () => ({ enabled: on, sessions: on ? sessions : [] })),
    setOwnSessions: vi.fn(async (e: boolean) => {
      on = e;
      return { enabled: e };
    }),
    openOwnSession: vi.fn(async () => ({ opened: false as const, id: "s1", cwd: "/home/ana/code/tienda" })),
    ...over,
  };
};

describe("observed sessions → the pet", () => {
  it("map to the protocol's states; Codex's own review counts as busy", () => {
    const likes = ownSessionLikes([
      view({ key: "a", state: "question" }),
      view({ key: "b", state: "approval", reviewing: true }),
      view({ key: "c", state: "approval" }),
      view({ key: "d", state: "error" }),
      view({ key: "e", state: "finished" }),
    ]);
    expect(likes.map((l) => l.state)).toEqual(["waiting_input", "running", "waiting_approval", "failed", "completed"]);
  });

  it("the level is the highest unseen alert, never above L3, and merges with the account's", () => {
    const vs = [view({ key: "a", state: "question", level: "L2" }), view({ key: "b", state: "error", level: "L1" })];
    expect(ownLevel(vs, new Set())).toBe("L2");
    expect(ownLevel(vs, new Set([alertId(vs[0]!)]))).toBe("L1");
    expect(ownLevel([], new Set())).toBeNull();
    expect(maxLevel("L1", "L3")).toBe("L3");
    expect(maxLevel("L4", "L2")).toBe("L4");
    expect(maxLevel(null, "L2")).toBe("L2");
    expect(
      behaviourFor({
        level: ownLevel(vs, new Set()),
        fullscreen: false,
        dnd: false,
        quietHours: false,
        lowEnergy: false,
      }).requestFocus,
    ).toBe(false);
  });

  it("DND and quiet hours still silence observed alerts (the existing damping)", () => {
    const level = ownLevel([view({ state: "approval", level: "L3" })], new Set());
    expect(
      behaviourFor({ level, fullscreen: false, dnd: true, quietHours: false, lowEnergy: false }).effectiveLevel,
    ).toBe("L0");
    expect(
      behaviourFor({ level, fullscreen: false, dnd: false, quietHours: true, lowEnergy: false }).effectiveLevel,
    ).toBe("L0");
  });

  it("a session that finishes or fails makes the pet hop or slump; one that asks puts it in needs_you", () => {
    const tracker = new ActivityTracker();
    const tick = (vs: OwnSessionView[], now: number) =>
      tracker.update(ownSessionLikes(vs), 0, { notifications: ownNotices(vs, new Set()), now });
    const first = tick([view({ state: "working" })], 10);
    const asks = tick([view({ state: "question", since: 20, level: "L1" })], 20);
    expect(asks.mode).toBe("needs_you");
    expect(asks.alerts).toBe(1);
    const done = tick([view({ state: "finished", since: 30 })], 30);
    expect(activityActions(asks, done)).toContain("hop");
    const failed = tick([view({ state: "error", since: 40, level: "L1" })], 40);
    expect(activityActions(done, failed)).toContain("slump");
    expect(first.mode).toBe("working");
    const merged = mergeActivity({ ...first, mode: "rest", done: 2 }, failed);
    expect([merged.mode, merged.done, merged.failed]).toEqual(["rest", 3, 1]);
    expect(mergeActivity({ ...first, mode: "working" }, asks).mode).toBe("needs_you");
  });
});

describe("the feed", () => {
  it("reads the agent, forgets seen marks once the state changes, and survives a missing agent", async () => {
    const vs = [view({ state: "question", level: "L1" })];
    const ipc = ipcWith(vs);
    const feed = new OwnSessionsFeed(ipc);
    expect((await feed.refresh()).sessions).toHaveLength(1);
    feed.markSeen(vs[0]!);
    expect(feed.seen.has(alertId(vs[0]!))).toBe(true);
    (ipc.ownSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      enabled: true,
      sessions: [{ ...vs[0]!, since: 2000 }],
    });
    await feed.refresh(true);
    expect(feed.seen.size).toBe(0);
    const down = new OwnSessionsFeed(unavailableIpc);
    expect(await down.refresh()).toEqual({ enabled: null, sessions: [], error: null });
  });

  it("a failed read that isn't a missing agent keeps the toggle, the cards and the Visto marks", async () => {
    const vs = [view({ state: "question", level: "L1" })];
    const ipc = ipcWith(vs);
    const feed = new OwnSessionsFeed(ipc);
    await feed.refresh();
    feed.markSeen(vs[0]!);
    (ipc.ownSessions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("internal"));
    const snap = await feed.refresh(true);
    expect([snap.enabled, snap.sessions.length, snap.error]).toEqual([true, 1, "internal"]);
    expect(feed.seen.has(alertId(vs[0]!))).toBe(true);
  });

  it("live-store bursts reuse a fresh read; a forced one asks again", async () => {
    let now = 0;
    const ipc = ipcWith([]);
    const feed = new OwnSessionsFeed(ipc, () => now);
    await feed.refresh();
    now = 1000;
    await feed.refresh();
    expect(ipc.ownSessions).toHaveBeenCalledTimes(1);
    await feed.refresh(true);
    now = 5000;
    await feed.refresh();
    expect(ipc.ownSessions).toHaveBeenCalledTimes(3);
  });
});

const show = (ui: React.ReactNode, locale: "es" | "en" = "es") =>
  render(<TextProviders locale={locale}>{ui}</TextProviders>);

describe("panel cards", () => {
  it("nothing while the watch is off", async () => {
    const feed = new OwnSessionsFeed(ipcWith([view()], false));
    await feed.refresh();
    const { container } = show(<OwnSessions feed={feed} ipc={unavailableIpc} />);
    expect(container.querySelector("[data-section=own-sessions]")).toBeNull();
  });

  it("an approval is observed only: no approve button, says so, offers Abrir and falls back to the folder", async () => {
    const vs = [
      view({
        key: "codex:c1",
        source: "codex",
        id: "c1",
        title: "Subir Node",
        state: "approval",
        level: "L1",
        detail: "Codex necesita tu permiso (shell)",
      }),
      view({ key: "claude:s2", id: "s2", state: "finished", since: 5 }),
    ];
    const ipc = ipcWith(vs);
    const feed = new OwnSessionsFeed(ipc);
    await feed.refresh();
    show(<OwnSessions feed={feed} ipc={ipc} />);
    expect(screen.getByText("Sesiones que abriste tú")).toBeTruthy();
    expect(screen.getByText("Subir Node")).toBeTruthy();
    expect(screen.getByText("tienda")).toBeTruthy();
    expect(screen.getByText(/Chalito no puede aprobar ni responder/)).toBeTruthy();
    expect(screen.queryByText("Aprobar")).toBeNull();
    fireEvent.click(screen.getAllByText("Abrir")[0]!);
    await waitFor(() => expect(screen.getByText(/No pude traerla al frente/)).toBeTruthy());
    expect(ipc.openOwnSession).toHaveBeenCalledWith("codex:c1");
    expect(screen.getByText("/home/ana/code/tienda")).toBeTruthy();
    fireEvent.click(screen.getByText("Visto"));
    expect(ownLevel(vs, feed.seen)).toBeNull();
    await waitFor(() => expect(screen.queryByText("Visto")).toBeNull());
  });

  it("a guessed Claude approval and a Codex review say what they are", async () => {
    const feed = new OwnSessionsFeed(
      ipcWith([
        view({ key: "a", state: "approval", guessed: true, level: "L1" }),
        view({ key: "b", source: "codex", state: "approval", reviewing: true }),
      ]),
    );
    await feed.refresh();
    show(<OwnSessions feed={feed} ipc={unavailableIpc} />, "en");
    expect(screen.getByText("Looks like it's waiting for your approval")).toBeTruthy();
    expect(screen.getByText("Codex is reviewing it")).toBeTruthy();
  });
});

describe("review round: cards and settings", () => {
  it("generic lines are worded in the panel's language", async () => {
    const feed = new OwnSessionsFeed(
      ipcWith([
        view({ key: "a", source: "codex", state: "approval", level: "L1", detailKey: "approval", detail: "shell" }),
        view({ key: "b", state: "question", level: "L1", detailKey: "question" }),
      ]),
    );
    await feed.refresh();
    show(<OwnSessions feed={feed} ipc={unavailableIpc} />, "en");
    expect(screen.getByText("It asks for your permission to use shell.")).toBeTruthy();
    expect(screen.getByText("It has a question for you.")).toBeTruthy();
  });

  it("Abrir on a session that just closed says so and still shows where it was", async () => {
    const ipc = ipcWith([view({ state: "finished" })], true, {
      openOwnSession: vi.fn(async () => Promise.reject(new Error("not_found"))),
    });
    const feed = new OwnSessionsFeed(ipc);
    await feed.refresh();
    show(<OwnSessions feed={feed} ipc={ipc} />);
    fireEvent.click(screen.getByText("Abrir"));
    await waitFor(() => expect(screen.getByText(/Esa sesión ya se cerró/)).toBeTruthy());
    expect(screen.getByText("/home/ana/code/tienda")).toBeTruthy();
  });

  it("a toggle the agent confirmed stays on even if the next read fails", async () => {
    const ipc = ipcWith([], false);
    const feed = new OwnSessionsFeed(ipc);
    show(<OwnSessionsSettings feed={feed} ipc={ipc} cliCommand={async () => null} />);
    const box = (await screen.findByLabelText("Ver sesiones que abrí yo")) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    (ipc.ownSessions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("internal"));
    await act(async () => void fireEvent.click(box));
    await waitFor(() => expect(box.checked).toBe(true));
    expect(box.disabled).toBe(false);
    expect(screen.getByText(/No encontré el comando chalito/)).toBeTruthy();
  });

  it("a rejected toggle says so", async () => {
    const ipc = ipcWith([], false, { setOwnSessions: vi.fn(async () => Promise.reject(new Error("internal"))) });
    const feed = new OwnSessionsFeed(ipc);
    show(<OwnSessionsSettings feed={feed} ipc={ipc} />);
    const box = (await screen.findByLabelText("Ver sesiones que abrí yo")) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    await act(async () => void fireEvent.click(box));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("No se pudo cambiar"));
    expect(box.checked).toBe(false);
  });
});

describe("settings: the opt-in and the Codex hook", () => {
  it("off by default; turning it on goes through the agent and shows the hook to paste", async () => {
    const ipc = ipcWith([], false);
    const feed = new OwnSessionsFeed(ipc);
    show(<OwnSessionsSettings feed={feed} ipc={ipc} cliCommand={async () => "/usr/local/bin/chalito"} />);
    const box = await screen.findByLabelText("Ver sesiones que abrí yo");
    await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false));
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/nada de esto sale de tu computadora/)).toBeTruthy();
    expect(document.querySelector("[data-codex-hook]")).toBeNull();
    await act(async () => void fireEvent.click(box));
    expect(ipc.setOwnSessions).toHaveBeenCalledWith(true);
    await waitFor(() => expect((box as HTMLInputElement).checked).toBe(true));
    await waitFor(() =>
      expect(document.querySelector("[data-snippet]")?.textContent).toContain(
        "/usr/local/bin/chalito watch-hook codex",
      ),
    );
    expect(screen.getByText(/Chalito nunca edita tu carpeta ~\/.codex/)).toBeTruthy();
  });

  it("disabled with a note when the agent doesn't answer", async () => {
    const feed = new OwnSessionsFeed(unavailableIpc);
    show(<OwnSessionsSettings feed={feed} ipc={unavailableIpc} />);
    await waitFor(() => expect(screen.getByText(/El agente local no responde/)).toBeTruthy());
    expect((screen.getByLabelText("Ver sesiones que abrí yo") as HTMLInputElement).disabled).toBe(true);
  });

  it("the snippet is valid hooks.json for PermissionRequest and PostToolUse, quoting paths with spaces", () => {
    const s = JSON.parse(codexHookSnippet("C:\\Program Files\\Chalito\\chalito.exe"));
    const cmd = s.hooks.PermissionRequest[0].hooks[0];
    expect(cmd).toEqual({
      type: "command",
      command: '"C:\\Program Files\\Chalito\\chalito.exe" watch-hook codex',
      timeout: 5,
    });
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe(cmd.command);
    expect(JSON.parse(codexHookSnippet(null)).hooks.PostToolUse[0].hooks[0].command).toBe("chalito watch-hook codex");
  });
});
