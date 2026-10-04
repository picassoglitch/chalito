import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RoomListItem } from "@chalito/rooms";
import { TextProviders } from "../src/lib/i18n.js";
import { relayRevoked } from "../src/lib/revoked-relay.js";
import { roomSeen } from "../src/lib/room-seen.js";
import { roomsSource, type RoomsSource } from "../src/lib/rooms-source.js";
import { roomOf } from "../src/panel/Inbox.js";
import { Rooms } from "../src/panel/Rooms.js";

afterEach(cleanup);

describe("revoked relay (panel → room window)", () => {
  const store = (status: string) => {
    let s = status;
    const ls = new Set<() => void>();
    return {
      getSnapshot: () => ({ status: s }),
      subscribe: (l: () => void) => (ls.add(l), () => ls.delete(l)),
      set: (v: string) => ((s = v), ls.forEach((l) => l())),
      listeners: ls,
    };
  };

  it("sends once when the store goes revoked, never before", () => {
    const live = store("live");
    let sent = 0;
    const stop = relayRevoked(live, async () => void sent++);
    live.set("offline");
    expect(sent).toBe(0);
    live.set("revoked");
    live.set("revoked");
    expect(sent).toBe(1);
    stop();
    expect(live.listeners.size).toBe(0);
  });

  it("an already-revoked store is relayed at once; a failing send doesn't throw", () => {
    let sent = 0;
    relayRevoked(store("revoked"), async () => {
      sent++;
      throw new Error("no room window");
    });
    expect(sent).toBe(1);
  });
});

describe("room seen markers", () => {
  it("only moves forward, and missing storage reads as 0", () => {
    const m = new Map<string, string>();
    const s = roomSeen({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) });
    expect(s.get("r1")).toBe(0);
    s.mark("r1", 5);
    s.mark("r1", 3);
    expect(s.get("r1")).toBe(5);
    expect(roomSeen(null).get("r1")).toBe(0);
  });
});

describe("rooms source", () => {
  it("looks the companion up lazily, once; without one, join says so", async () => {
    let lookups = 0;
    const none = roomsSource({
      db: {} as never,
      api: { post: async () => undefined as never },
      companionId: async () => (lookups++, null),
      seen: roomSeen(null),
      open: async () => undefined,
    });
    expect(await none.list()).toEqual([]);
    expect(await none.join("ABCD-EFGH")).toEqual({ ok: false, reason: "no_companion" });
    // A null lookup isn't cached: the account may finish setting up.
    expect(lookups).toBe(2);
  });
});

describe("inbox room links", () => {
  it("only room_event notifications with a room deep link open a room", () => {
    expect(roomOf({ source: "room_event", deepLink: "/r/room_1" })).toBe("room_1");
    expect(roomOf({ source: "room_event", deepLink: "/en/r/room_1" })).toBe("room_1");
    expect(roomOf({ source: "approval", deepLink: "/r/room_1" })).toBeNull();
    expect(roomOf({ source: "room_event", deepLink: "/a/x" })).toBeNull();
    expect(roomOf({ source: "room_event", deepLink: "/r/../x" })).toBeNull();
  });
});

describe("Salas tab", () => {
  const source = (rooms: RoomListItem[], join: RoomsSource["join"] = async () => ({ ok: true, roomId: "r9" })) => {
    const opened: string[] = [];
    const joined: string[] = [];
    const s: RoomsSource = {
      list: async () => rooms,
      join: async (c) => (joined.push(c), join(c)),
      open: async (id) => void opened.push(id),
    };
    return { s, opened, joined };
  };
  const show = (s: RoomsSource) =>
    render(
      <TextProviders locale="es">
        <Rooms source={s} />
      </TextProviders>,
    );

  it("lists rooms with member count and the unread dot; Abrir opens the room window", async () => {
    const f = source([
      { roomId: "r1", name: "Casa", type: "family", memberCount: 3, unread: true },
      { roomId: "r2", name: "Obra", type: "project", memberCount: 1, unread: false },
    ]);
    const { container } = show(f.s);
    await screen.findByText("Casa");
    expect(screen.getByText("3 integrantes")).toBeTruthy();
    expect(container.querySelectorAll("[data-unread]")).toHaveLength(1);
    expect(container.querySelector('[data-room="r1"] [data-unread]')).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Abrir" })[1]!);
    expect(f.opened).toEqual(["r2"]);
  });

  it("joins with a code, then opens the new room; refusals are explained", async () => {
    const f = source([]);
    show(f.s);
    await screen.findByText("Aún no estás en ninguna sala.");
    const input = screen.getByPlaceholderText("Código de invitación");
    const button = screen.getByRole("button", { name: "Unirme" }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: "ABC" } });
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "ABCD-EFGH" } });
    await act(async () => void fireEvent.click(button));
    await waitFor(() => expect(f.opened).toEqual(["r9"]));
    expect(f.joined).toEqual(["ABCD-EFGH"]);

    cleanup();
    const bad = source([], async () => ({ ok: false, reason: "bad_code" }));
    show(bad.s);
    fireEvent.change(await screen.findByPlaceholderText("Código de invitación"), { target: { value: "ZZZZ-ZZZZ" } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Unirme" })));
    expect((await screen.findByRole("status")).textContent).toBe("Ese código no es válido o ya expiró.");
    expect(bad.opened).toEqual([]);
  });
});
