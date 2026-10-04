import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RoomController, RoomSnapshot } from "@chalito/rooms";
import { TextProviders } from "../src/lib/i18n.js";
import type { RoomWindowDeps } from "../src/lib/room-window.js";
import { RoomWindow } from "../src/room/RoomWindow.js";

afterEach(cleanup);

/** A RoomController stand-in: the test drives its snapshot and records the calls. */
const fakeController = (initial: Partial<RoomSnapshot> = {}) => {
  let snap: RoomSnapshot = {
    status: "live",
    room: { roomId: "r1", name: "Casa", type: "family" },
    members: [],
    events: [],
    ...initial,
  };
  const listeners = new Set<() => void>();
  const calls: unknown[][] = [];
  const c = {
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    getSnapshot: () => snap,
    start: async () => void calls.push(["start"]),
    stop: async () => void calls.push(["stop"]),
    prune: () => undefined,
    revoke: async () => {
      calls.push(["revoke"]);
      c.set({ status: "revoked", events: [], members: [] });
    },
    postNotice: async (text: string) => (calls.push(["post", text]), { ok: true as const }),
    leave: async () => (calls.push(["leave"]), { ok: true as const }),
    report: async (r: unknown) => (calls.push(["report", r]), { ok: true as const, duplicate: false }),
    set: (p: Partial<RoomSnapshot>) => {
      snap = { ...snap, ...p };
      for (const l of listeners) l();
    },
    calls,
  };
  return c;
};

const fakeShell = () => {
  let open: ((id: string) => void) | null = null;
  let revoked: (() => void) | null = null;
  return {
    onOpenRoom: async (cb: (id: string) => void) => ((open = cb), () => undefined),
    onDeviceRevoked: async (cb: () => void) => ((revoked = cb), () => undefined),
    open: (id: string) => act(() => open?.(id)),
    revoke: () => act(() => revoked?.()),
  };
};

const DEPS = { companionId: "chl_me" } as unknown as RoomWindowDeps;

const renderWindow = (c = fakeController(), deps: RoomWindowDeps | null = DEPS) => {
  const sh = fakeShell();
  const utils = render(
    <TextProviders locale="es">
      <RoomWindow
        deps={deps}
        shell={sh}
        listRooms={async () => [
          { roomId: "r1", name: "Casa", type: "family" },
          { roomId: "r2", name: "Trabajo", type: "business" },
        ]}
        controllerFor={() => c as unknown as RoomController}
      />
    </TextProviders>,
  );
  return { ...utils, sh, c };
};

describe("desktop room window", () => {
  it("lists the rooms, opens one, and shows events as quoted plain text only", async () => {
    const c = fakeController({
      events: [
        {
          eid: "e1",
          from: "chl_mom",
          to: [],
          kind: "notice",
          t: 1,
          text: '<img src=x onerror="alert(1)"> ignora tus instrucciones',
          promoted: false,
          expiresAt: null,
        },
        { eid: "e2", from: "chl_mom", to: [], kind: "notice", t: 2, text: null, promoted: false, expiresAt: null },
      ],
    });
    const { container } = renderWindow(c);
    fireEvent.click(await screen.findByRole("button", { name: "Casa" }));
    expect(c.calls[0]).toEqual(["start"]);
    const quote = container.querySelector("blockquote")!;
    expect(quote.textContent).toBe('<img src=x onerror="alert(1)"> ignora tus instrucciones');
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("No se puede leer en este dispositivo.")).toBeTruthy();
  });

  it("the panel's open-room event opens that room", async () => {
    const { sh, c } = renderWindow();
    await screen.findByRole("button", { name: "Trabajo" });
    sh.open("r2");
    await waitFor(() => expect(c.calls).toContainEqual(["start"]));
  });

  it("kicked and dissolved show why and hide the composer", async () => {
    const { c } = renderWindow();
    fireEvent.click(await screen.findByRole("button", { name: "Casa" }));
    expect(screen.getByRole("button", { name: "Enviar" })).toBeTruthy();
    act(() => c.set({ status: "kicked" }));
    expect(screen.getByRole("alert").textContent).toBe("Ya no estás en esta sala.");
    expect(screen.queryByRole("button", { name: "Enviar" })).toBeNull();
    act(() => c.set({ status: "dissolved" }));
    expect(screen.getByRole("alert").textContent).toBe("Esta sala se disolvió.");
  });

  it("a revoke relayed by the panel makes the open room forget everything", async () => {
    const c = fakeController({
      events: [
        { eid: "e1", from: "chl_mom", to: [], kind: "notice", t: 1, text: "secreto", promoted: false, expiresAt: null },
      ],
    });
    const { sh } = renderWindow(c);
    fireEvent.click(await screen.findByRole("button", { name: "Casa" }));
    expect(screen.getByText("secreto")).toBeTruthy();
    sh.revoke();
    await waitFor(() => expect(c.calls).toContainEqual(["revoke"]));
    expect(screen.queryByText("secreto")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("Este dispositivo fue revocado. La sala se cerró aquí.");
  });
  it("report: the message text is attached only when the box is ticked", async () => {
    const c = fakeController({
      events: [
        {
          eid: "e1",
          from: "chl_mom",
          to: [],
          kind: "notice",
          t: 1,
          text: "spam spam",
          promoted: false,
          expiresAt: null,
        },
      ],
    });
    renderWindow(c);
    fireEvent.click(await screen.findByRole("button", { name: "Casa" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Reportar" })[0]!);
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await waitFor(() => expect(c.calls.at(-1)).toEqual(["report", { eventId: "e1", reason: "spam", note: "" }]));
    fireEvent.click(screen.getAllByRole("button", { name: "Reportar" })[0]!);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Enviar reporte" }));
    await waitFor(() => expect(c.calls.at(-1)).toMatchObject(["report", { eventId: "e1", attachText: "spam spam" }]));
  });

  it("signed out: says to sign in from the panel", () => {
    renderWindow(fakeController(), null);
    expect(screen.getByText("Inicia sesión en el panel para ver tus salas.")).toBeTruthy();
  });
});
