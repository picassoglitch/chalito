// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@chalito/client";
import { BoardLink, SESSIONS_REFRESH_MS } from "../src/lib/board/link.js";
import { memoryPairStore } from "../src/lib/board/pairing.js";
import {
  MAX_SESSION_ITEMS,
  SESSION_LIMITS,
  StateSince,
  boardSessions,
  clip,
  sendBoardSessions,
} from "../src/lib/board/sessions.js";
import type { OwnSessionView } from "../src/lib/ipc.js";
import { FakeBoard, prePair } from "./fake-board.js";

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
};

type Live = Pick<Snapshot, "sessions" | "devices">;
const session = (sid: string, state: string, extra: Record<string, unknown> = {}) =>
  ({
    sid,
    agentDeviceId: "dev-1",
    state,
    updatedAt: 1_000,
    card: null,
    coord: null,
    rev: 1,
    ...extra,
  }) as Live["sessions"][number];
const device = { deviceId: "dev-1", name: "Laptop de Aldo" } as Live["devices"][number];
const own = (key: string, state: OwnSessionView["state"], extra: Partial<OwnSessionView> = {}): OwnSessionView => ({
  key,
  source: "claude",
  id: `id-${key}`,
  cwd: "/home/aldo/secret-client/chalito",
  title: null,
  state,
  since: 2_000,
  detail: null,
  detailKey: null,
  level: null,
  reviewing: false,
  guessed: false,
  seen: false,
  ...extra,
});

describe("sessions overview for the board", () => {
  it("lists active sessions from Chalito and from the computer, waiting first, without paths", () => {
    const live: Live = {
      devices: [device],
      sessions: [
        session("a", "running", { appId: "cursor", label: "Arreglar el login con SSO", updatedAt: 5_000 }),
        session("b", "waiting_input", { adapter: "codex", label: "Revisar PR", updatedAt: 4_000 }),
        session("c", "completed", { label: "ya terminó" }),
        session("d", "idle", { adapter: "gemini", agentDeviceId: "unknown", updatedAt: 3_000 }),
      ],
    };
    const out = boardSessions(live, [
      own("x", "working"),
      own("y", "finished"),
      own("z", "approval", { source: "codex", title: "Docs" }),
    ]);
    expect(out.more).toBe(0);
    expect(out.items).toEqual([
      { agent: "codex", computer: "Laptop de Aldo", title: "Revisar PR", state: "waiting", since: 4_000 },
      { agent: "codex", computer: "Esta compu", title: "Docs", state: "waiting", since: 2_000 },
      {
        agent: "cursor",
        computer: "Laptop de Aldo",
        title: "Arreglar el login con S…",
        state: "working",
        since: 5_000,
      },
      { agent: "claude-code", computer: "Esta compu", title: "chalito", state: "working", since: 2_000 },
      { agent: "gemini", computer: "", title: "", state: "idle", since: 3_000 },
    ]);
    expect(JSON.stringify(out)).not.toContain("/home");
  });

  it("says how long a session has been in its state, not since its row last changed", () => {
    const since = new StateSince();
    expect(since.at("a", "running", 1_000, 5_000)).toBe(1_000);
    expect(since.at("a", "running", 9_000, 9_500)).toBe(1_000);
    expect(since.at("a", "waiting_input", 9_600, 10_000)).toBe(10_000);
    const live: Live = { devices: [device], sessions: [session("a", "waiting_input", { updatedAt: 99_000 })] };
    expect(boardSessions(live, [], undefined, since).items[0]?.since).toBe(10_000);
  });

  it("drops agent-written fields that aren't strings instead of throwing", () => {
    const bad = session("a", "running", { label: 42, adapter: { x: 1 } });
    expect(boardSessions({ devices: [device], sessions: [bad] }, []).items[0]).toMatchObject({
      agent: "agente",
      title: "",
    });
    expect(clip("ab\uD800cd", 24)).toBe("abcd");
  });

  it("clips by UTF-16 units and never splits an emoji", () => {
    expect(clip("corto", 24)).toBe("corto");
    expect(clip("a\n  b", 24)).toBe("a b");
    const c = clip("x".repeat(22) + "😀😀", 24);
    expect(c.length).toBeLessThanOrEqual(24);
    expect(c.endsWith("…")).toBe(true);
    expect(c).not.toMatch(/[\uD800-\uDBFF]…$/);
  });

  it("fits any number of sessions in one protocol line and counts the rest", () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      session(`s${i}`, "running", {
        adapter: "claude-code-con-un-nombre-largo",
        label: "ñandú ".repeat(20),
        updatedAt: i,
      }),
    );
    const out = boardSessions(
      { devices: [{ ...device, name: "Computadora de la oficina central" }], sessions: many },
      [],
    );
    const line = JSON.stringify({ v: 1, type: "sessions", items: out.items, more: out.more });
    expect(new TextEncoder().encode(line).length).toBeLessThan(4096);
    expect(out.items.length).toBeLessThanOrEqual(MAX_SESSION_ITEMS);
    expect(out.items.length + out.more).toBe(100);
    for (const it of out.items) {
      expect(it.agent.length).toBeLessThanOrEqual(SESSION_LIMITS.agent);
      expect(it.computer.length).toBeLessThanOrEqual(SESSION_LIMITS.computer);
      expect(it.title.length).toBeLessThanOrEqual(SESSION_LIMITS.title);
    }
    // Worst case for bytes: three-byte characters everywhere still fits, with fewer items.
    const wide = Array.from({ length: 40 }, (_, i) =>
      session(`w${i}`, "running", { adapter: "€".repeat(30), label: "€".repeat(40) }),
    );
    const w = boardSessions({ devices: [{ ...device, name: "€".repeat(30) }], sessions: wide }, []);
    const wl = JSON.stringify({ v: 1, type: "sessions", items: w.items, more: w.more });
    expect(new TextEncoder().encode(wl).length).toBeLessThan(4096);
    expect(w.items.length + w.more).toBe(40);
  });
});

describe("BoardLink sessions", () => {
  const setup = async (paired = true) => {
    const board = new FakeBoard();
    const store = memoryPairStore();
    if (paired) await prePair(board, store);
    const link = new BoardLink(board, store, { replyMs: 300 });
    link.start();
    return { board, link };
  };
  const overview = (title: string) => ({
    items: [{ agent: "codex", computer: "Mac", title, state: "working" as const, since: 1 }],
    more: 0,
  });

  it("sends on change only, again after each hello, and refreshes an unchanged one now and then", async () => {
    const { board, link } = await setup();
    link.sessions(overview("uno"));
    expect(board.got).toEqual([]);
    board.plug();
    await until(() => link.ready && board.sent("sessions").length > 0);
    expect(board.sent("sessions")[0]).toEqual({ v: 1, type: "sessions", ...overview("uno") });
    await new Promise((r) => setTimeout(r, 20));
    const settled = board.sent("sessions").length;
    const t = Date.now();
    link.sessions(overview("uno"), t);
    expect(board.sent("sessions")).toHaveLength(settled);
    link.sessions(overview("dos"), t);
    await until(() => board.sent("sessions").length === settled + 1);
    expect(board.sent("sessions").at(-1)).toMatchObject({ items: [{ title: "dos" }] });
    link.sessions(overview("dos"), t + SESSIONS_REFRESH_MS);
    await until(() => board.sent("sessions").length === settled + 2);
    board.unplug();
    link.sessions(overview("tres"));
    board.plug();
    await until(() => board.sent("sessions").some((m) => (m.items as { title: string }[])[0]?.title === "tres"));
  });

  it("an unpaired board never gets the overview", async () => {
    const { board, link } = await setup(false);
    board.plug();
    await until(() => link.found);
    link.sessions(overview("uno"));
    await new Promise((r) => setTimeout(r, 20));
    expect(board.sent("sessions")).toEqual([]);
  });
});

describe("the panel tick's overview", () => {
  it("logs an overview that couldn't be built and doesn't throw into the tick", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sent: unknown[] = [];
    expect(() =>
      sendBoardSessions({ sessions: (o) => sent.push(o) }, () => {
        throw new Error("bad row");
      }),
    ).not.toThrow();
    expect(sent).toEqual([]);
    expect(error.mock.calls.some((c) => String(c.join(" ")).includes("bad row"))).toBe(true);
    sendBoardSessions({ sessions: (o) => sent.push(o) }, () => ({ items: [], more: 0 }));
    expect(sent).toEqual([{ items: [], more: 0 }]);
    error.mockRestore();
  });
});
