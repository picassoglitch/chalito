// @vitest-environment node

// ADR 0031 §1: "Nueva sesión" against a real AgentCore via the real IPC handlers; the live store is
// the agent's own rows, opened with client keys as LiveStore does.
import "./node-dom.js";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { openJson } from "@chalito/crypto";
import type { ApprovalView, EventView, Snapshot } from "@chalito/client";
import type { DeviceSetup } from "@chalito/protocol";
import { codeService } from "../../agent/src/code/service.js";
import { ipcHandlers } from "../../agent/src/ipc-handlers.js";
import { WS, agentFor, waitFor as until } from "../../agent/test/rc-harness.js";
import { TextProviders } from "../src/lib/i18n.js";
import { invokeIpc, unavailableIpc, type AgentIpc } from "../src/lib/ipc.js";
import { NewSession } from "../src/panel/NewSession.js";

afterEach(cleanup);

const SETUP: DeviceSetup = { adapters: ["claude-code"], workspaces: 1, labels: ["chalito"] };

const computer = async () => {
  const a = await agentFor();
  const handlers = ipcHandlers({
    code: codeService(
      a.core,
      () => a.policy.get(),
      () => SETUP,
      "local",
    ),
  } as never) as Record<string, (p: unknown) => Promise<unknown>>;
  const ipc = invokeIpc(async <T,>(_cmd: string, args: Record<string, unknown>): Promise<T> => {
    try {
      return (await handlers[args.method as string]!(args.params ?? undefined)) as T;
    } catch (e) {
      throw e instanceof Error ? e.message : String(e);
    }
  });

  // The desktop's live view of the agent's rows, opened with the client's keys.
  let snap: Snapshot = {
    status: "live",
    approvals: [],
    sessions: [],
    events: {},
    drafts: {},
    notifications: [],
    devices: [],
    devModeActive: false,
  };
  const subs = new Set<() => void>();
  const refresh = async () => {
    const events: Record<string, EventView[]> = {};
    for (const e of a.store.events) {
      const ct = (e as { ct?: never }).ct;
      const { ct: _c, ...meta } = e as unknown as Record<string, unknown>;
      (events[e.sid] ??= []).push({
        sid: e.sid,
        eid: e.eid,
        seq: e.seq,
        t: e.t,
        type: e.type,
        urgency: e.urgency,
        meta,
        content: ct ? await openJson(ct, a.phone.id, a.phone.box, `event:${e.sid}`) : null,
        rev: 1,
      });
    }
    const approvals: ApprovalView[] = [];
    for (const r of a.store.pendingApprovals()) {
      const opened = await openJson<{ details: Record<string, unknown>; request: { body: { detailsHash: string } } }>(
        r.detailsCt,
        a.phone.id,
        a.phone.box,
        `approval:${r.aid}`,
      );
      approvals.push({
        aid: r.aid,
        sid: r.sid,
        agentDeviceId: a.self.id,
        requestId: r.requestId,
        kind: "tool",
        risk: r.risk,
        origin: r.origin,
        stepUpRequired: r.stepUpRequired,
        verified: true,
        detailsHash: opened.request.body.detailsHash,
        status: "pending",
        reason: null,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        details: opened.details,
      } as ApprovalView);
    }
    const state = (sid: string) =>
      [...a.store.events].reverse().find((e) => e.sid === sid && e.type === "session.state") as
        { state: string } | undefined;
    snap = {
      ...snap,
      events,
      approvals,
      sessions: Object.keys(events).map((sid) => ({
        sid,
        agentDeviceId: a.self.id,
        state: state(sid)?.state ?? "starting",
        updatedAt: Date.now(),
        card: null,
        coord: null,
        rev: 1,
      })),
    };
    for (const fn of subs) fn();
  };
  const client = {
    live: {
      subscribe: (fn: () => void) => (subs.add(fn), () => void subs.delete(fn)),
      getSnapshot: () => snap,
    },
    actions: { decide: async (aid: string, allow: boolean) => a.answer(allow, false, aid) },
  } as never;
  return { ...a, ipc, client, refresh };
};

/** The panel keeps the followed session, as Panel.tsx does across tabs. */
const Harness = ({ ipc, client }: { ipc: AgentIpc; client: unknown }) => {
  const [sid, setSid] = useState<string | null>(null);
  const [shown, setShown] = useState(true);
  return (
    <>
      <button onClick={() => setShown((v) => !v)}>otra pestaña</button>
      {shown && <NewSession ipc={ipc} client={client as never} sid={sid} onSid={setSid} />}
    </>
  );
};
const renderIt = (ipc: AgentIpc, client: unknown) =>
  render(
    <TextProviders locale="es">
      <Harness ipc={ipc} client={client} />
    </TextProviders>,
  );

const startOne = async (prompt = "arregla el login") => {
  fireEvent.change(await screen.findByLabelText("Qué quieres que haga"), { target: { value: prompt } });
  fireEvent.click(screen.getByRole("button", { name: "Empezar" }));
};

describe("panel → agent: Nueva sesión (ADR 0031 §1)", () => {
  it("offers this computer's AIs and folders, and starts a local-origin session it then follows", async () => {
    const c = await computer();
    renderIt(c.ipc, c.client);
    expect(((await screen.findByLabelText("IA")) as HTMLSelectElement).value).toBe("claude-code");
    expect((screen.getByLabelText("Carpeta") as HTMLSelectElement).value).toBe("chalito");
    await startOne();
    await until(() => c.adapter.runs.length === 1);
    const run = c.adapter.runs[0]!;
    expect(run.opts).toMatchObject({ origin: "local", cwd: WS, permissionMode: "default" });
    run.emit({ type: "state", state: "running" });
    run.emit({ type: "assistant_text", text: "Ya encontré el error." });
    run.emit({ type: "state", state: "idle" });
    await until(() => c.store.events.some((e) => e.type === "message.assistant"));
    await c.refresh();
    expect(await screen.findByText("Ya encontré el error.")).toBeTruthy();
    expect(screen.getByText("Lista")).toBeTruthy();
    // The first prompt is in the transcript too (sealed for clients like every turn).
    expect(screen.getByText("arregla el login")).toBeTruthy();

    fireEvent.change(screen.getAllByRole("textbox").at(-1)!, { target: { value: "y corre las pruebas" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await until(() => run.prompts.length === 2);
    expect(run.prompts[1]).toEqual({ text: "y corre las pruebas", origin: "local" });
    await c.refresh();
    expect(await screen.findByText("y corre las pruebas")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Detener" }));
    await until(() => run.interrupts === 1);
    // Leaving the tab and coming back still follows the same session.
    fireEvent.click(screen.getByRole("button", { name: "otra pestaña" }));
    fireEvent.click(screen.getByRole("button", { name: "otra pestaña" }));
    expect(await screen.findByText("Ya encontré el error.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Empezar" })).toBeNull();
  });

  it("shows the session's approval inline and the click answers it", async () => {
    const c = await computer();
    renderIt(c.ipc, c.client);
    await startOne("instala dependencias");
    await until(() => c.adapter.runs.length === 1);
    const sid = c.adapter.runs[0]!.opts.sid;
    const tool = c.adapter.tool(sid, "Bash", { command: "npm install left-pad" });
    await until(() => c.store.pendingApprovals().length === 1);
    await c.refresh();
    fireEvent.click(await screen.findByRole("button", { name: "Aprobar" }));
    expect(await tool).toMatchObject({ allow: true });
  });

  it("says why the agent refused, and when the agent isn't there", async () => {
    const c = await computer();
    c.setPolicy({ ...c.policy.get(), origins: { ...c.policy.get().origins, local: false } });
    renderIt(c.ipc, c.client);
    await startOne();
    expect(await screen.findByText("Chalito no la aceptó: origin_disabled")).toBeTruthy();
    expect(c.adapter.runs).toHaveLength(0);
    cleanup();
    renderIt(unavailableIpc, null);
    expect(await screen.findByText("Chalito no está corriendo en esta computadora.")).toBeTruthy();
  });

  it("signed out: it still starts, and points to the phone for the conversation", async () => {
    const c = await computer();
    renderIt(c.ipc, null);
    await startOne();
    await until(() => c.adapter.runs.length === 1);
    await waitFor(() => expect(screen.getByText(/síguela en tu teléfono/)).toBeTruthy());
  });
});
