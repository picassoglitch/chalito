// D-070: the panel's link flow against the real agent IPC handlers and link manager, with
// `invokeIpc` going through `ipcHandlers` as the native side would carry it.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { generateBoxKeyPair, generateSigningKeyPair, toB64url } from "@chalito/crypto";
import type { Locale } from "@chalito/protocol";
import { ipcHandlers } from "../../agent/src/ipc-handlers.js";
import { LINK_COPY, LinkManager, MemoryLinkCloud, MemoryLinkStorage } from "../../agent/src/links/index.js";
import { DEFAULT_POLICY, type Policy } from "../../agent/src/policy/index.js";
import { createLogger } from "../../agent/src/redact.js";
import { TextProviders } from "../src/lib/i18n.js";
import { invokeIpc, unavailableIpc, type AgentIpc } from "../src/lib/ipc.js";
import { deviceCode, linkCode, parseLinkCode } from "../src/lib/link-codes.js";
import { Links } from "../src/panel/Links.js";

afterEach(cleanup);

const OWNER = "hub-user-1";

/** One computer: its keys, a real LinkManager, and the real IPC handlers behind the panel's client. */
const computer = async (id: string, o: { workspaces?: string[]; osAuth?: boolean } = {}) => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  const pubSign = await toB64url(sign.publicKey);
  const pubBox = await toB64url(box.publicKey);
  const policy: Policy = {
    ...DEFAULT_POLICY,
    workspaces: (o.workspaces ?? ["chalito"]).map((label) => ({ label, path: `/home/aldo/${label}` })),
  };
  const cloud = new MemoryLinkCloud();
  const links = new LinkManager({
    deviceId: id,
    owner: OWNER,
    sign,
    box,
    pubBox,
    storage: new MemoryLinkStorage(),
    cloud,
    policy: () => policy,
    audit: () => undefined,
    publishDeviceEvent: async () => undefined,
    now: Date.now,
    log: createLogger(() => undefined),
    setTimer: () => ({ clear: () => undefined }),
  });
  const osAsked: string[] = [];
  const auth = { ok: o.osAuth ?? true };
  const handlers = ipcHandlers({
    links,
    identity: { deviceId: id, pubSign, pubBox },
    osAuth: () => ({ verify: async (why: string) => (osAsked.push(why), auth.ok) }),
    locale: () => "es",
    policy: { get: () => policy },
  } as never) as Record<string, (params: unknown) => Promise<unknown>>;
  // As src-tauri's agent_ipc relays it: a refusal comes back as its code string.
  const invoke = async <T,>(_cmd: string, args: Record<string, unknown>): Promise<T> => {
    try {
      return (await handlers[args.method as string]!(args.params ?? undefined)) as T;
    } catch (e) {
      throw e instanceof Error ? e.message : String(e);
    }
  };
  return { id, pubSign, pubBox, links, cloud, osAsked, auth, ipc: invokeIpc(invoke) };
};

const renderLinks = (ipc: AgentIpc, locale: Locale = "es") =>
  render(
    <TextProviders locale={locale}>
      <Links ipc={ipc} />
    </TextProviders>,
  );

const section = () => screen.getByRole("heading", { name: "Enlaces entre agentes" }).closest("section")!;

const fillNew = async (o: {
  goal?: string;
  workspace?: string;
  otherCode?: string;
  direction?: "send" | "receive";
}) => {
  // After a refusal the form stays open with the draft, so the owner can try again.
  await waitFor(() =>
    expect(screen.queryByText("Nuevo enlace…") ?? screen.queryByText("Para qué es el enlace")).not.toBeNull(),
  );
  const open = screen.queryByRole("button", { name: "Nuevo enlace…" });
  if (open) fireEvent.click(open);
  if (o.otherCode !== undefined) {
    fireEvent.click(screen.getByLabelText("Un agente en otra de mis computadoras"));
    fireEvent.change(screen.getByLabelText(/Código de la otra computadora/), { target: { value: o.otherCode } });
    if (o.direction === "receive") fireEvent.click(screen.getByLabelText("La otra computadora le pasa trabajo a esta"));
  }
  const ws = screen.getByLabelText("Carpeta donde se trabaja");
  if (o.workspace !== undefined) {
    await waitFor(() =>
      expect(ws.tagName === "INPUT" || !o.workspace || within(ws).queryByText(o.workspace) !== null).toBe(true),
    );
    fireEvent.change(ws, { target: { value: o.workspace } });
  }
  if (o.goal !== undefined)
    fireEvent.change(screen.getByLabelText("Para qué es el enlace"), { target: { value: o.goal } });
  fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
};

/** The agent's challenge: its summary, then the typed phrase. */
const passChallenge = async (phrase = LINK_COPY.es.phrase) => {
  await screen.findByText(LINK_COPY.es.handoff[0]!);
  fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
  const input = await screen.findByLabelText(LINK_COPY.es.phrase);
  const confirm = screen.getByRole("button", { name: "Crear el enlace" });
  fireEvent.change(input, { target: { value: "enlazar" } });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: phrase } });
  fireEvent.click(confirm);
};

describe("panel → agent: making hand-off links (D-070)", () => {
  it("a same-computer hand-off link: challenge, OS check, then it's listed as local", async () => {
    const a = await computer("dev_a1");
    renderLinks(a.ipc);
    await fillNew({ workspace: "chalito", goal: "Revisar mis PR" });
    await passChallenge();
    await screen.findByText("Enlace creado.");
    expect(a.osAsked).toEqual(["Chalito: enlazar agentes"]);
    const [link] = a.links.list();
    expect(link).toMatchObject({
      mode: "handoff",
      createdBy: "local",
      sender: { deviceId: "dev_a1" },
      receiver: { deviceId: "dev_a1" },
      workspaceLabel: "chalito",
      goal: "Revisar mis PR",
      confirm: true,
      permissionCeiling: "default",
    });
    // Same computer: no code to carry anywhere.
    expect(screen.queryByLabelText("Código del enlace")).toBeNull();
    const row = await waitFor(() => section().querySelector(`[data-link="${link!.id}"]`)!);
    expect(within(row as HTMLElement).getByText(/Encargo: Esta computadora → Esta computadora/)).toBeTruthy();
  });

  it("across computers: A makes it with B's code, B makes the same link from A's code", async () => {
    const a = await computer("dev_a1", { workspaces: ["chalito"] });
    const b = await computer("dev_b1", { workspaces: ["repo"] });
    const bCode = deviceCode({ deviceId: b.id, pubSign: b.pubSign, pubBox: b.pubBox });

    const viewA = renderLinks(a.ipc);
    await fillNew({ otherCode: bCode, workspace: "repo", goal: "Tareas del plan" });
    await passChallenge();
    const code = ((await screen.findByLabelText("Código del enlace")) as HTMLTextAreaElement).value;
    viewA.unmount();

    renderLinks(b.ipc);
    fireEvent.click(await screen.findByRole("button", { name: "Pegar un enlace de otra computadora…" }));
    fireEvent.change(screen.getByLabelText("Código del enlace"), { target: { value: code } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar" }));
    await screen.findByText(/Encargo: dev_a1 → Esta computadora/);
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    await passChallenge();
    await screen.findByText("Enlace creado.");

    const onA = a.links.list()[0]!;
    const onB = b.links.list()[0]!;
    const strip = ({ createdAt: _c, ...l }: typeof onA) => l;
    expect(strip(onB)).toEqual(strip(onA));
    expect(onA.sender).toEqual({ deviceId: a.id, pubSign: a.pubSign, pubBox: a.pubBox });
    expect(onA.receiver).toEqual({ deviceId: b.id, pubSign: b.pubSign, pubBox: b.pubBox });
    // The agent's coordinator (G4) finds exactly this shape: A → B, new sessions, hand-off.
    expect(onA.sender.sessionId ?? onA.receiver.sessionId).toBeUndefined();
  });

  it("a link code for another computer, or a tampered one, is refused before the challenge", async () => {
    const a = await computer("dev_a1");
    const b = await computer("dev_b1");
    const c = await computer("dev_c1");
    const spec = parseLinkCode(
      linkCode({
        id: "lnk_abcdefgh12345678",
        mode: "handoff",
        sender: { deviceId: b.id, pubSign: b.pubSign, pubBox: b.pubBox },
        receiver: { deviceId: c.id, pubSign: c.pubSign, pubBox: c.pubBox },
        workspaceLabel: "chalito",
        goal: "x",
        expiresAt: Date.now() + 86_400_000,
        dailyTokenBudget: 1000,
        ratePerHour: 1,
        confirm: true,
        permissionCeiling: "default",
      }),
      Date.now(),
    )!;
    renderLinks(a.ipc);
    fireEvent.click(await screen.findByRole("button", { name: "Pegar un enlace de otra computadora…" }));
    const box = screen.getByLabelText("Código del enlace");
    fireEvent.change(box, { target: { value: linkCode(spec) } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar" }));
    await screen.findByText(/Ese enlace no es para esta computadora/);
    // A's id with someone else's keys: A's relays wouldn't verify on the other end.
    const forged = { ...spec, receiver: { deviceId: a.id, pubSign: c.pubSign, pubBox: c.pubBox } };
    fireEvent.change(box, { target: { value: linkCode(forged) } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar" }));
    await screen.findByText(/Ese enlace no es para esta computadora/);
    fireEvent.change(box, { target: { value: "chalito-link:not-json" } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar" }));
    await screen.findByText(/no es válido o ya venció/);
    expect(a.links.list()).toHaveLength(0);
  });

  it("errors from the agent show and make nothing: OS check failed, folder outside policy", async () => {
    const a = await computer("dev_a1", { osAuth: false });
    renderLinks(a.ipc);
    await fillNew({ workspace: "chalito", goal: "x" });
    await passChallenge();
    await screen.findByText("No se creó el enlace (os_auth_failed).");
    expect(a.links.list()).toHaveLength(0);

    a.auth.ok = true;
    const b = await computer("dev_b1");
    // The receiver is here, so only this computer's folders are offered; a stale label is still refused.
    await fillNew({
      otherCode: deviceCode({ deviceId: b.id, pubSign: b.pubSign, pubBox: b.pubBox }),
      direction: "receive",
      workspace: "",
      goal: "x",
    });
    await screen.findByText(/Elige la carpeta/);
    const ok = await a.ipc.addLink(
      {
        id: "lnk_outofscope1234",
        mode: "handoff",
        sender: { deviceId: b.id, pubSign: b.pubSign, pubBox: b.pubBox },
        receiver: { deviceId: a.id, pubSign: a.pubSign, pubBox: a.pubBox },
        workspaceLabel: "elsewhere",
        goal: "x",
        expiresAt: Date.now() + 86_400_000,
        dailyTokenBudget: 1000,
        ratePerHour: 1,
        confirm: true,
        permissionCeiling: "default",
      },
      { confirm: true, typed: LINK_COPY.es.phrase },
    );
    expect(ok).toEqual({ ok: false, reason: "link_out_of_scope" });
    // The agent re-checks the phrase itself: a panel can't skip it.
    const here = { deviceId: a.id };
    const sameComputer = {
      id: "lnk_phrase12345678",
      mode: "handoff" as const,
      sender: here,
      receiver: here,
      workspaceLabel: "chalito",
      goal: "x",
      expiresAt: Date.now() + 86_400_000,
      dailyTokenBudget: 1000,
      ratePerHour: 1,
      confirm: true,
      permissionCeiling: "default" as const,
    };
    expect(await a.ipc.addLink(sameComputer, { confirm: true, typed: "no" })).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(await a.ipc.addLink(sameComputer, { confirm: false, typed: LINK_COPY.es.phrase })).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(a.links.list()).toHaveLength(0);
  });

  it("revoke one, revoke all; a revoked link's id can't be made again", async () => {
    const a = await computer("dev_a1");
    const make = async (goal: string) => {
      await fillNew({ workspace: "chalito", goal });
      await passChallenge();
      await screen.findByText("Enlace creado.");
      fireEvent.click(screen.getByRole("button", { name: "Listo" }));
    };
    renderLinks(a.ipc);
    await make("uno");
    await make("dos");
    await waitFor(() => expect(section().querySelectorAll("[data-link]")).toHaveLength(2));
    const first = a.links.list()[0]!;
    fireEvent.click(within(section().querySelector(`[data-link="${first.id}"]`)! as HTMLElement).getByText("Revocar"));
    await waitFor(() => expect(section().querySelectorAll("[data-link]")).toHaveLength(1));
    expect(a.links.get(first.id)).toBeUndefined();

    const { v: _v, createdAt: _c, createdBy: _b, ...again } = first;
    expect(await a.ipc.addLink(again, { confirm: true, typed: LINK_COPY.es.phrase })).toEqual({
      ok: false,
      reason: "invalid",
    });

    fireEvent.click(screen.getByRole("button", { name: "Revocar todos" }));
    await screen.findByText("No hay enlaces.");
    expect(a.links.list()).toHaveLength(0);
  });

  it("a link the cloud mirror doesn't hold yet shows as pending publish", async () => {
    const a = await computer("dev_a1");
    a.cloud.failPublishes = 1;
    renderLinks(a.ipc);
    await fillNew({ workspace: "chalito", goal: "x" });
    await passChallenge();
    await screen.findByText("Pendiente de publicar: aún no lleva nada");
  });

  it("form problems are caught in the panel: bad computer code, its own code, no goal", async () => {
    const a = await computer("dev_a1");
    renderLinks(a.ipc);
    await fillNew({ otherCode: "chalito-pc:garbage", goal: "x", workspace: "repo" });
    await screen.findByText(/El código de la otra computadora no es válido/);
    fireEvent.change(screen.getByLabelText(/Código de la otra computadora/), {
      target: { value: deviceCode({ deviceId: a.id, pubSign: a.pubSign, pubBox: a.pubBox }) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    await screen.findByText(/Ese código es de esta misma computadora/);
    fireEvent.click(screen.getByLabelText("Otro agente en esta computadora"));
    fireEvent.change(screen.getByLabelText("Para qué es el enlace"), { target: { value: " " } });
    fireEvent.change(screen.getByLabelText("Carpeta donde se trabaja"), { target: { value: "chalito" } });
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    await screen.findByText(/Escribe para qué es el enlace/);
    expect(a.links.list()).toHaveLength(0);
  });

  it("without the agent's IPC it says so (en)", async () => {
    renderLinks(unavailableIpc, "en");
    await screen.findByText(/local agent isn't answering/);
    expect(screen.queryByRole("button", { name: "New link…" })).toBeNull();
  });
});
